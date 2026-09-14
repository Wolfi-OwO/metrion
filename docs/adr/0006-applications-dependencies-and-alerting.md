# ADR 0006: Applications, dependency correlation, and where alerting runs

## Status

Accepted, 2026-09-14. Retrospective - the feature it describes (GitHub issues
#19-#22) is already shipped: migrations `0006_applications.sql`,
`0007_thresholds_and_status.sql`, `0008_project_alerts_enabled.sql`, and
`applications/evaluator`. Builds on ADR 0003 (the metric envelope, unchanged
by this feature) and ADR 0005 (the tenancy boundary, also unchanged).

## Context

Four features shipped together - an applications registry, a dependency
graph between applications, threshold-based alert correlation, and where the
evaluator that computes both actually runs - and each one made a call that
is not obvious from the code alone. This ADR exists so a future maintainer
does not "fix" the correlation rule to propagate alarm colour, or move the
evaluator into the ingest hot path, without first reading why it is built
the way it is.

## Decision

### 1. An application is the existing `resource` string, given a registry row

`applications.key` **is** `metrics.resource` - this is a registry for a
string the schema already had, not a new axis on the metric
(`packages/db/migrations/0006_applications.sql:1-10`). The envelope format
from ADR 0003 (`resource`/`subResource`/`metrics[]`) is untouched; no agent
or sender needs to change to be represented as an application.

`sub_resource` was deliberately **not** reused as a topology node.
`sub_resource` is a metric-identity dimension - a container name under
`resource = docker` - and overloading it to also mean "a dependency-graph
node" would break the existing discovery query, `SELECT DISTINCT resource,
sub_resource, name`, which assumes `sub_resource` enumerates identity
values, not topology (`packages/db/migrations/0006_applications.sql:7-10`).
An application is scoped to `resource` alone.

`projects` remains the only tenancy boundary (ADR 0005). An application is a
grouping _inside_ a tenant - `applications.project_id` is `NOT NULL
REFERENCES projects(id)` - never a tenant itself
(`packages/db/migrations/0006_applications.sql:12-20`).

### 2. A DAG edge table, not a parent pointer

`application_dependencies` is an edge table (`dependent_id`,
`depends_on_id`), not a `parent_id` column on `applications`, because a real
topology has multiple parents at once: "checkout-api depends on
payments-service AND postgres-primary" is not expressible with one parent
column (`packages/db/migrations/0006_applications.sql:22-24`).

Cross-tenant edges are prevented by a **composite foreign key**, not by
handler code:

```sql
FOREIGN KEY (dependent_id,  project_id) REFERENCES applications (id, project_id) ON DELETE CASCADE,
FOREIGN KEY (depends_on_id, project_id) REFERENCES applications (id, project_id) ON DELETE CASCADE
```

(`packages/db/migrations/0006_applications.sql:32-41`, made possible by
`applications`' own `UNIQUE (id, project_id)` target at line 19.) A plain
single-column `FOREIGN KEY (dependent_id) REFERENCES applications(id)` would
let one tenant's application depend on another tenant's - the composite form
makes that combination structurally impossible: a row simply cannot exist
with `project_id` mismatched between the two ends. A database constraint
cannot be forgotten at a new call site the way an `if (a.project_id !==
b.project_id) throw` guard can - and a forgotten guard at one new call site
is the exact failure mode this project's security review keeps having to
check for by hand. Cycle prevention, by contrast, is _not_ a database
constraint - it is one recursive-CTE check in the write handler, so there is
one owner for that rule (`packages/db/migrations/0006_applications.sql:25-26`).
The two guarantees are enforced at different layers on purpose: cross-tenant
isolation is cheap and total as a DB constraint, cycle-freedom is not
expressible as one.

### 3. Alert correlation suppresses email; it does not propagate alarm

`applications/evaluator/src/correlate.ts`'s `attributeRootCause` walks the
transitive dependency closure (a recursive CTE over
`application_dependencies`, `correlate.ts:19-44`) and, when a dependent
application's event has any transitive dependency currently non-`ok`, marks
that event `rootCause: false` with a `causedByApplicationId`/`causedByLabel`
attribution (`correlate.ts:104-134`). Crucially, **only that flag changes** -
the dependent's own `threshold_status`/`status_events` row is untouched, so
its colour in the viewer still reflects its own threshold's own evaluation.
`sendDigests` then filters to `event.rootCause` before building any digest
(`applications/evaluator/src/mailer.ts:172`), so `rootCause: false` means
"this event does not get its own email", not "this event did not happen."

The rejected alternative was to propagate the dependency's severity to every
dependent (mark the dependent itself `critical` because something it depends
on is `critical`). That was rejected because it multiplies alerts rather
than reducing them - one root-cause outage would fan out into a critical
event, and a critical email, for every application downstream of it. That is
exactly the problem a dependency graph exists to solve, not a way to solve
it: the point of correlation is fewer emails pointing at the actual cause,
not more events pointing at everything downstream of it.

An empty graph degrades to identical behaviour: `attributeRootCause` returns
an event unchanged whenever `closure.get(event.applicationId)` is `undefined`
or empty (`correlate.ts:113-114`), so a project that has never recorded a
dependency edge gets the same one-event-per-breach behaviour as before this
feature existed - correlation is additive, not something that has to be
configured to avoid breaking existing projects.

### 4. Evaluation runs in one systemd timer on the VPS, wrapped in `flock -n`

The evaluator (`applications/evaluator`) runs as `metrion-evaluator.service`
(`Type=oneshot`, wrapped in `flock -n` for the one-owner guard) on
`metrion-evaluator.timer` (`OnCalendar=*-*-* *:*:00`, every minute) on the
same Contabo VPS the database runs on
(`organizational/agent-deployment-runbook.md:452-460`). This is the same
`flock -n` one-owner pattern `vps-metrics-collector.service` already uses
(`organizational/agent-deployment-runbook.md:88-94`) - one lock, one process
per tick, no double-run if a cycle overruns a minute. Per this project's
one-owner rule (two schedulers driving the same job is a recurring bug
class here, not a hypothetical one), there is exactly one thing that decides
"has a threshold breached", running in exactly one place.

Four alternative places were considered and rejected, each for a specific
reason, not a general "was worse":

- **Inside the metrics write path (`metrion-ingest`).** The write path only
  sees data that arrives. It structurally cannot detect _absence_ of data -
  the `no_data` state (`applications/evaluator/src/evaluate.ts:66-77`, fired
  when a threshold's window has zero matching rows) requires evaluating on a
  clock regardless of whether a write just happened, which a handler
  triggered by writes cannot do. It would also put an SMTP call in the hot
  path of every metric ingest request, coupling request latency for every
  tenant to the mail provider's response time.
- **Off the `metrics_hourly` continuous aggregate (ADR 0004).** That rollup
  refreshes hourly by design; evaluating against it would delay a critical
  breach's detection by up to an hour, which defeats the purpose of
  alerting on a metric that is already breaching now.
- **A third Azure Container App.** It would cost money (a new compute
  resource, however small) and add a cross-internet round trip to the
  self-hosted database every cycle - the same westeurope-to-Contabo hop ADR
  0004 already measured as 10-25 ms one-way
  (`docs/adr/0004-postgres-timescaledb-over-append-blob.md:141-147`), except
  paid for and re-incurred every single minute instead of amortized over a
  metrics-push cadence.
- **A `setInterval` inside `metrion-ingest` itself.** `metrion-ingest`
  already runs as an Azure Container App and can scale to multiple
  replicas; a `setInterval` has no cross-replica mutex, so as soon as that
  app has two replicas both would independently evaluate and both would
  send email for the same breach - the exact "two schedulers on one job"
  failure this project's one-owner rule exists to rule out. A single VPS
  process under `flock -n` has no such second copy to race against.

### 5. Email goes through a managed provider over SMTP; self-hosting was rejected here even though self-hosting won for the database

ADR 0004 chose to self-host Postgres/TimescaleDB. This ADR chooses the
opposite for email, and the two decisions differ for a specific reason, not
inconsistency: a self-hosted database's quality depends only on this
project's own machine - if the VPS is up and the disk has room, a write
succeeds, and if it does not, that failure is loud and immediate. A
self-hosted mail transfer agent's quality depends on machines and policies
this project does not control - recipient providers' spam filters, an IP or
domain's reputation with no sending history - and its failure mode is
**silent**: the SMTP send can succeed from this project's point of view (the
receiving MTA accepted the message) while the alert is quietly binned by the
recipient's spam filter, never delivered, and never visibly failed. An
undelivered alert is worse than no alert at all if the alert's existence is
being relied on.

The managed option is **already free at this volume** - the evaluator's own
`EVALUATOR_DAILY_EMAIL_CAP` defaults to 50 emails/project/day
(`applications/evaluator/.env.example:26`), well inside a free transactional
tier - so there was nothing to trade off in the first place; this was not a
cost-vs-quality call.

The chosen provider is **Brevo** (`smtp-relay.brevo.com`,
`applications/evaluator/.env.example:12-23`), stated preference in
`PRIVACY.md:270-290` with Mailjet as the named EEA alternative and Azure
Communication Services / Amazon SES as fallbacks - the EEA preference is
recorded there as being about keeping that document's GDPR Chapter V
transfer analysis simple, not about price or features
(`PRIVACY.md:276-279`). Every price and free-tier limit below is **not independently verified -
confirm before committing spend**: Brevo's free tier (~300 emails/day,
`applications/evaluator/.env.example:14`), and any Mailjet, Azure
Communication Services, or Amazon SES pricing or free-tier figure, all of
which `PRIVACY.md:278-279` also flags as unverified. This matches ADR 0004's
own convention, which marks its own Azure pricing figures **not
independently verified - confirm current Azure pricing before committing
spend** rather than quoting them as fact
(`docs/adr/0004-postgres-timescaledb-over-append-blob.md:72-83`).

### 6. The notification address is the OAuth-verified `users.email`, by design

The evaluator selects the recipient with `u.email AS owner_email ... JOIN
users u ON u.id = p.owner_user_id`
(`applications/evaluator/src/evaluate.ts:119-126`) - the project owner's
account email, the same `users.email` populated from the OAuth identity
provider at sign-in (`packages/db/migrations/0002_accounts.sql:6-9`,
`PRIVACY.md:260-269`). There is no user-supplied recipient field and no
`notification_contacts` table in v1.

This is a deliberate security decision, not an oversight left for later. The
digest email body includes metric names and application display names,
which are user-controlled strings (`applications/evaluator/src/mailer.ts:6-12`
notes they are escaped before entering HTML for exactly this reason). If the
_destination_ address were also user-supplied, this project's own SMTP
relay would become a spam relay: anyone with write access to a project could
set an arbitrary recipient and an arbitrary metric name, and the evaluator
would dutifully mail attacker-chosen text to an attacker-chosen inbox on
this project's sending reputation. Binding the recipient to the
OAuth-verified account email removes that path entirely - the only address
that can ever receive an alert is one the identity provider already
attested to at sign-in.

The upgrade path, if anyone asks for it, is a verified-address flow: a
`notification_contacts` table with its own email-verification step (send a
token, confirm the link) before an address is usable as a recipient - the
same shape as the account email already goes through, not a plain free-text
field.

## Consequences

- An application needs no new column on `metrics` and no agent change - it
  is a registry row over data already being written, and can be backfilled
  or ignored per project independently.
- Cross-tenant dependency edges are impossible by construction (composite
  FK), not by convention, but cycle-freedom is still an application-level
  check that a future write path must remember to call - it is not free the
  way the tenancy guarantee is.
- Alert volume degrades gracefully whether or not a project has ever
  recorded a dependency edge: no edges recorded means every event is its
  own root cause, identical to pre-feature behaviour.
- Threshold evaluation has a single point of failure - if the VPS or its
  `metrion-evaluator.timer` is down, no alerts fire, colour still updates
  only when the evaluator itself runs. There is exactly one owner of that
  job by design; adding a second scheduler anywhere would reintroduce the
  double-send failure mode this ADR rejected in point 4.
- The project depends on one more external processor (the email provider),
  which is a new Art 28 DSGVO relationship to record once the account
  exists (`PRIVACY.md:270-290`) - not yet created as of this ADR
  (`organizational/agent-deployment-runbook.md:395-402`).
- A user cannot redirect alerts to an arbitrary address in v1; every alert
  goes to the account email or nowhere (`alerts_enabled = false`).
