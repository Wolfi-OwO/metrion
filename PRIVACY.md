# Privacy Policy (Datenschutzerklärung)

**metrion — server supervision platform**
**Effective:** 2026-09-07
**Last updated:** 2026-09-07

Controller: Phillip Kofler, Villach, Kärnten, Österreich
Contact: <koflerphillip@outlook.com>

This is a description of what the software in this repository does, written
against the code rather than against intent — every claim below names the file
and line that implements it. It is not legal advice.

**Language.** This document is English because the application, its API
documentation and the whole repository are English. If a German-language
version is ever needed — Art 12(1) DSGVO wants the information intelligible to
the people it addresses — it has to be added, not translated on request. See
`IMPRESSUM.md` for why the Impressum itself is German.

---

## 1. Scope

metrion is a multi-tenant metrics platform: three server processes and one
browser client.

- **agent** — runs on the operator's own VPS (Contabo) once a minute,
  collecting the operator's own infrastructure metrics and sending them to
  the ingest service (`applications/agent`; role unchanged by
  `docs/adr/0004-postgres-timescaledb-over-append-blob.md`).
- **ingest** (`metrion-ingest`) — an Azure Container App exposing the one
  authenticated write path, `POST /api/v1/ingest`, authenticated per project
  by an API key, never by request content
  (`applications/ingest/src/middlewares/api-key.ts:1-60`;
  `docs/adr/0005-api-key-determines-tenancy.md`).
- **viewer** (`metrion-viewer`) — an Azure Container App serving the public
  read API, the API documentation site at `/docs`, OAuth sign-in and session
  management (`applications/viewer/src/routes/auth.routes.ts:13-16`), and
  per-account project/API-key management
  (`applications/viewer/src/routes/projects.routes.ts:221-248`).
- **viewer client** — a React charts page that reads the public API and, for
  a signed-in user, the account-scoped project/key endpoints.

Storage: Postgres with the TimescaleDB extension, self-hosted on the
operator's Contabo VPS (`organizational/agent-deployment-runbook.md:159-183`),
replacing the Azure Blob Storage design of the now-superseded
`docs/adr/0001-append-blob-over-table-storage.md` — see
`docs/adr/0004-postgres-timescaledb-over-append-blob.md`. The old
single-tenant blob-based deployment (`mona-viewer`/`mona-rg`) has since been
fully decommissioned (`organizational/viewer-deployment-runbook.md`).

Applicable law: DSGVO (Regulation (EU) 2016/679), the Austrian
Datenschutzgesetz (DSG), § 165 TKG 2021 for anything stored on a visitor's
device, § 174 TKG 2021 for unsolicited electronic messages, and § 5 ECG /
§ 25 MedienG for the Impressum.

---

## 2. What is stored

### Metrics

The wire format is unchanged (`packages/shared/src/metric-envelope.ts:16-33`):
`resource`, `subResource`, `metrics[]` with `name`, numeric `value`, `unit`,
`intervalSeconds`, an ISO-8601 `timestamp`. Points now land as rows in the
`metrics` hypertable rather than lines in a day-blob, scoped by `project_id`
(`packages/db/migrations/0003_metrics_hypertable.sql:5-14`). `project_id` is
resolved once, at authentication, from the presented API key — never from
anything in the request body (`docs/adr/0005-api-key-determines-tenancy.md`).
`value` is always a finite number, enforced on ingest by a zod schema, so no
free-text field can smuggle anything but a numeric measurement into a row.

### Account data (new with this release)

| Table        | Columns                                                                        | Holds                                                                    |
| ------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `users`      | `id`, `email`, `created_at`                                                     | One row per signed-in person.                                             |
| `identities` | `user_id`, `provider`, `provider_subject`, `email`                              | One row per OAuth sign-in method, keyed on `(provider, provider_subject)`, never on `email` (`packages/db/migrations/0002_accounts.sql:12-20`). |
| `projects`   | `id`, `owner_user_id`, `name`, `slug`, `default_resource`, `created_at`         | One row per metrics project a user owns.                                  |
| `api_keys`   | `id`, `project_id`, `key_prefix`, `key_hash`, `created_at`, `last_used_at`, `revoked_at` | One row per issued ingest credential; only a hash is stored, never the raw key (`packages/db/migrations/0002_accounts.sql:31-41`). |
| `sessions`   | `id`, `user_id`, `expires_at`                                                   | One row per active browser sign-in (`packages/db/migrations/0002_accounts.sql:43-47`). |

`users.email` and the `identities` rows identify a natural person directly.
This table is why section 7's earlier position — that this application
processed nobody's personal data but the operator's own — no longer holds
without qualification.

## 3. What is deliberately never stored

**No client IP addresses. No user agents. No request paths. No query strings.**
Not in a blob, not in a log line, not in an API response, not in an error body.
This is enforced in four separate places rather than asserted once:

- The Caddy access-log reader types the log line as `status`, `duration` and
  `request.host` only. `request.remote_ip`, `request.headers` and `request.uri`
  exist in the real line and are never named, so there is no filter to bypass
  (`applications/agent/src/collectors/caddy-requests.ts:14-19`).
- The viewer replaces `pino-http`'s request serializer outright. The default
  emits `remoteAddress`, `remotePort`, the full header set, and the query
  string inside `url`; the replacement emits `method` and `path` only, with the
  query string cut at the `?` (`applications/viewer/src/main.ts:106-112`).
- The 404 handler does not echo `req.originalUrl`, so an unmatched request's
  path and query string never reach a response body
  (`applications/viewer/src/middlewares/error.ts:71-73`).
- Neither rate limiter keys on an IP. The global one keys on the constant
  `'global'` (`applications/viewer/src/main.ts:82`); the ingest one keys on a
  SHA-256 hash of the bearer token
  (`applications/viewer/src/routes/ingest.routes.ts:36-39`), so the limiter's
  store never holds the secret either.

`trust proxy` is set to `1` so that `req.protocol` is honest behind the Azure
ingress; it is not used to read a forwarded client address
(`applications/viewer/src/main.ts:21-25`).

A verification run against the deployed logger sent a request carrying a query
string, a distinctive User-Agent, an `X-Forwarded-For`, a `Cookie`, a `Referer`
and a bearer token. The resulting log line contained `method`, `path`,
`statusCode` and `responseTime`, and none of those values.

### The one thing the log does keep

Request logs retain `path` — this application's own route, e.g.
`/api/v1/metrics` — with the query string removed. It identifies an endpoint of
this service, not a person: no address, no agent, no session and no other
identifier is recorded alongside it. Keeping it is what makes a 500 traceable
to an endpoint at all. Section 7 explains why this does not make the log line
personal data.

The session cookie introduced in section 4 does not change any of this: it
carries an opaque session id, never an address, agent or request detail, and
is covered on its own terms there.

## 4. Cookies, tracking and third-party requests

- **One cookie, strictly necessary.** `mtr_session` — an opaque, HMAC-signed
  session id, `HttpOnly`, `Secure`, `SameSite=Lax`, 30-day expiry
  (`applications/viewer/src/auth/session.ts:14`, `:69-77`). It exists solely
  to keep a signed-in user signed in between requests to `GET /api/v1/me`
  and the project/key endpoints; nothing else reads or writes it.
- **No other device storage.** Nothing in the agent, ingest, viewer or client
  writes to `localStorage`, `sessionStorage` or any other device storage.
- **No analytics, telemetry, tag manager, error-tracking SDK or advertising
  pixel** anywhere in the pipeline.
- **No third-party request from the browser.** Fonts remain self-hosted npm
  packages bundled with the application; the client's network calls are all
  same-origin `/api/...` and `/auth/...` paths.

**Why no consent banner.** § 165 Abs 3 TKG 2021 exempts storage on a user's
device from the prior-consent requirement where it is technically necessary
to provide a service the user explicitly requested — here, staying signed in
after choosing to sign in. `mtr_session` fits that exemption on its face: it
carries no tracking identifier usable across sessions or sites, is not read
by any third party, and does nothing if the user never signs in. On that
basis no consent is sought and no banner is shown for this cookie. This is a
narrower, reasoned claim than the file's previous "nothing is stored, so
nothing to ask about" — replace this whole analysis, not just its
conclusion, if the cookie's purpose or scope ever changes.

**Hard gate for anything added later.** Any future analytics snippet,
CDN-hosted font, embedded video, or tracking pixel is *not* covered by the
strictly-necessary exemption above and requires a prior, freely-given,
specific opt-in banner — with reject exactly as easy as accept — before that
code ships. Shipping such a feature without that banner first is a direct
§ 165 Abs 3 TKG 2021 violation, not a documentation gap to fix later.

## 5. Storage location and retention

### Compute (Azure) — unchanged processor, changed scope

Microsoft Azure Container Apps hosts `metrion-ingest` and `metrion-viewer`,
region West Europe (`organizational/viewer-deployment-runbook.md`).
Microsoft's Data Protection Addendum is the Art 28 DSGVO processor agreement
for this compute layer. **Azure is no longer the processor for the account
or metrics database** — see the next section — only for running the two
stateless application containers and their SSH-tunnel sidecar to the
database.

### Database (Contabo) — new since this release

The account and metrics database — Postgres with the TimescaleDB extension —
is self-hosted in Docker on the operator's own, already-existing Contabo VPS,
not on managed Azure Postgres
(`organizational/agent-deployment-runbook.md:159-183`). This was a
budget-driven decision: managed Postgres could not meet the project's cost
ceiling.

- **Processor.** Contabo GmbH is a new Art 28 DSGVO processor for this
  database, and for anything else placed on the same VPS. **Open point:**
  no confirmed, executed Art 28 Auftragsverarbeitervertrag reference for
  Contabo is recorded anywhere in this repository as of this writing.
  Contabo publishes a standard DPA as part of its customer terms; the
  operator must confirm it is accepted for this account and record the
  reference (version/date/URL) here before this section is final. Until
  then, treat this as a named-but-unconfirmed processor relationship, not a
  documented one.
- **Country.** Measured directly against the production VPS IP
  `<VPS-IP>`: RIPE whois shows the registrant (Contabo GmbH)
  headquartered in Munich, Germany, but reverse DNS
  (`vmi3556446.contaboserver.net`) and IP geolocation (ipinfo.io) place the
  physical host in **Lauterbourg, Grand Est, France** — a known Contabo EU
  datacentre near the German border. **France, not Germany, is the VPS's
  datacentre country.** This has not previously been recorded in any
  runbook; it is recorded here for the first time. France is an EU/EEA
  member state, so the "no third-country transfer" position below holds
  exactly as it would for Germany — only the country name changes, not the
  conclusion.
- **Chapter V position.** Because the database physically sits in an EEA
  member state and Contabo GmbH is itself EEA-based, no Chapter V transfer
  mechanism (SCCs, adequacy decision, derogation) is required for this
  storage location. This conclusion depends on the France measurement above;
  if the VPS is ever migrated to a non-EEA Contabo location (Contabo also
  sells UK, US, Singapore, Australian and Japanese locations), this
  paragraph must be redone before that migration, not after.

### Backups

A nightly encrypted dump of the account tables (`users`, `identities`,
`projects`, `api_keys`, `sessions` — never `metrics`) runs on the VPS,
GPG-encrypted on-host with the *public* half of a keypair whose private half
is not on the box (`organizational/metrion-backups/nightly-account-dump.sh:1-30`).

**Offsite target: Backblaze B2, EU-Central region.** This is the operator's
stated backup target, chosen specifically because it is EEA-located and
therefore requires no Chapter V transfer mechanism, consistent with the
Contabo reasoning above. **As of this writing the offsite credential has not
been provisioned** — `/opt/metrion/backup/offsite.env` does not exist, so
the script fails loudly rather than silently succeeding
(`organizational/metrion-backups/nightly-account-dump.sh:32-45`), and
backups are currently retained **on-host only**, not yet copied offsite.
This is a real, if incomplete, fact, not a guess: do not describe Backblaze
as a contracted or currently-operating offsite relationship. A weekly full
dump of the metrics-only data (account/secret tables explicitly excluded)
stays on-box only, 4-week rotation, unencrypted — it never leaves the host.

### Retention periods

| Data                                | Period                                                                 | Enforced by                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Metrics (`metrics` hypertable)      | 90 days                                                                | TimescaleDB retention policy; chunks older than 90 days are dropped by the platform (`packages/db/migrations/0004_rollups_and_retention.sql:40-43`). |
| Sessions (`sessions`)               | 30-day TTL from creation                                               | Checked at read time — an expired `expires_at` is treated as no session (`applications/viewer/src/auth/session.ts:16-18`, `:107`). **No scheduled job deletes the row itself once it expires** — it becomes unusable but is not purged; this is an open point below, not a claimed 30-day deletion guarantee. |
| Accounts (`users`/`identities`/`projects`/`api_keys`) | Life of the account                              | Deleted on request via section 8's process, or by the operator closing an account by hand. No automatic expiry exists in the schema. |
| `status_events` (**planned, not yet built** — GitHub issues #20-#24) | 180 days                              | Once shipped, enforced by a TimescaleDB retention policy on `status_events`, deleted 180 days after the event's own timestamp — the same mechanism already used for `metrics`' 90-day policy above (`packages/db/migrations/0004_rollups_and_retention.sql:40-43`). |

- **On the VPS:** undelivered samples wait in a local queue capped at 1440
  lines — one day — plus small state files
  (`applications/agent/src/config/index.ts:48-59`). They are deleted once
  delivered.

## 6. Processors and recipients

- **Microsoft Azure** — compute only (`metrion-ingest`, `metrion-viewer`
  Container Apps). Microsoft's Data Protection Addendum is the Art 28 DSGVO
  processor agreement. Azure no longer processes the account or metrics
  database (section 5).
- **Contabo GmbH** — the VPS running the self-hosted database (and, via
  the nightly backup, the encrypted account-table dump before its offsite
  copy). Named as a new Art 28 DSGVO processor as of this release; its own
  DPA/AVV reference is not yet confirmed and recorded — see section 5's open
  point.
- **Identity providers — Google, Microsoft and GitHub — are separate
  controllers, not Art 28 processors.** Signing in redirects to each
  provider's own OAuth flow (`applications/viewer/src/auth/providers.ts`);
  each provider processes the sign-in under its own privacy policy and its
  own legal basis, independent of this application. metrion receives back
  only the provider's stable subject id and, where offered, an email address
  (`packages/db/migrations/0002_accounts.sql:12-20`). No Art 28 agreement
  applies to this relationship because none of the three acts on metrion's
  instructions — each determines its own purposes and means for its own
  sign-in service.
- **Planned: an outbound alert-email provider (not yet built — GitHub
  issues #20-#24).** Once the threshold-alerting feature ships, a
  standalone evaluator process will email the project owner on a threshold
  breach via a managed transactional-email provider. The stated preference
  is **Brevo** (France, EEA-based), with Mailjet as the named EEA
  alternative and Azure Communication Services / Amazon SES as fallbacks.
  **The preference for an EEA-based provider is stated for one reason: it
  keeps this section's Chapter V position simple**, mirroring the Contabo
  reasoning above — not price or feature set, since every commercial figure
  for all four candidates is unverified and must not be quoted here as fact.
  Whichever provider is finally chosen becomes a new Art 28 DSGVO processor,
  named here with its own DPA/AVV reference, separate from and in addition
  to Microsoft's and Contabo's. **The final choice decides whether this
  section's Chapter V paragraph stays simple or reopens**: an EEA-based
  provider (Brevo, or Mailjet) needs no transfer mechanism, the same as
  Contabo; a US-based provider (Amazon SES, Resend, or Azure Communication
  Services if provisioned outside the EU) reopens the Chapter V analysis and
  needs its own transfer-mechanism statement — Standard Contractual Clauses
  plus a transfer impact assessment, or confirmed EU-US Data Privacy
  Framework certification for that specific provider — checked and recorded
  once the choice is final, not assumed in advance.

Nothing is shared with anyone else, sold, or used for advertising. The read
API remains public by decision: it serves aggregate resource usage of the
operator's own machines.

## 7. Is personal data processed at all?

### Metrics

Within the metrics pipeline itself the section 3 analysis is unchanged: a
row contains a machine hostname, a metric name, a number, a unit and a
timestamp, scoped to a `project_id` but naming no visitor. The same "against
personal data" / "for personal data" reasoning previously written here still
applies to that data on its own terms.

### Account data — yes, and it is why this section exists in its current
### form

`users.email`, `identities.provider_subject`/`identities.email` and the
`sessions` table identify a signed-in natural person directly — this
squarely meets Art 4(1) DSGVO's "identified natural person" test. **The
Art 13 information duty is triggered by creating an account**, and a
meaningful Art 15/17/20 request can now be answered about a signed-in user,
because there is something stored under which they can be found.

**Lawful basis, per purpose:**

| Purpose                                             | Basis                                             |
| ---------------------------------------------------- | -------------------------------------------------- |
| Account creation, OAuth sign-in, session maintenance | Art 6(1)(b) — necessary to perform the contract the user enters by signing up |
| Project and API-key management                      | Art 6(1)(b)                                        |
| Storing/serving a project's own ingested metrics     | Art 6(1)(b) — performance of the contract with that project's owner |
| Public read API of the operator's own infrastructure | Art 6(1)(f) — legitimate interest, as reasoned above |
| Account-table backups                                | Art 6(1)(f) — legitimate interest in business continuity |
| Threshold-alert email (**planned**, see below)        | Art 6(1)(b) — performance of the contract formed by configuring the threshold rule that triggers the send |

**DSAR / deletion cascade.** A request under Art 15/17/20 for a given user
is answered by walking, in order: `identities` (by `user_id`) → `sessions`
(by `user_id`) → `api_keys` (by `project_id`, for every project the user
owns) → `projects` (by `owner_user_id`) → `metrics` rows (by `project_id`,
for every project just identified) → `users` itself. Once the
threshold-alerting feature ships (GitHub issues #20-#24), the same cascade
extends to `thresholds`, `threshold_status` and `status_events` — all three
scoped by `project_id`/`user_id` the same way `api_keys` and `metrics` are
today — and `users.email` must be treated as playing two roles at that
point: a login identifier (as today) *and* a notification-delivery target
for alert email, both erased together.

**How this is actually exercised today.** There is no self-service
account-deletion or project-deletion API endpoint yet — the only deletion
route in the API is `DELETE /api/v1/keys/:id`, which revokes an API key
without deleting any data
(`applications/viewer/src/routes/projects.routes.ts:221-248`). A DSAR is
therefore fulfilled manually today: write to the contact address (section
8), and the operator runs the cascade above directly against the database.
DSGVO Art 12 requires a working path within the statutory deadline, not a
self-service UI — this qualifies, but a self-service deletion endpoint would
close a real gap and is recommended as follow-up work, not claimed here as
already built.

### Transactional alert email is off-platform, not off-purpose (planned)

A threshold-breach alert email necessarily carries metric values and
application names — the alerting user's own infrastructure data — to
whichever provider is finally chosen (section 6). This is a distinct
processing purpose from account data and metrics storage, with its own basis
(Art 6(1)(b), table above).

**These are transactional, not marketing, messages.** They are operational
alerts the user configured — a threshold they set, breached — not
unsolicited commercial communication, so they fall outside the Austrian rule
on unsolicited electronic messages, § 174 TKG 2021 (the current TKG 2021
recast of the former § 107 TKG 2003 "Unerbetene Nachrichten" provision).
§ 174 TKG 2021 targets messages sent for direct-marketing purposes without
the recipient's consent; a transactional alert triggered by the recipient's
own configured rule, about the recipient's own infrastructure, is not that,
so no separate consent gate under § 174 TKG 2021 applies to it. This
statement is written now, before the feature ships, precisely so the
reasoning is checkable rather than assumed silently once it does.

## 8. Your rights

Art 15-22 DSGVO apply to your account data: access, rectification, erasure,
restriction, portability and objection. Write to
<koflerphillip@outlook.com>; see section 7 for the deletion cascade actually
run against a request. Answer within one month (Art 12(3)), extendable by
two months with reasons.

Right to complain (Art 77 DSGVO):
**Österreichische Datenschutzbehörde**, Barichgasse 40-42, 1030 Wien,
<dsb@dsb.gv.at>, <https://www.dsb.gv.at>.

## 9. Security

The measures relevant to this policy are documented in `SECURITY.md`: TLS at
the Azure ingress, a container-scoped add-and-create-only SAS on the VPS, a
managed identity holding no storage secret in the viewer, one bearer token on
the write path compared in constant time, and rate limits on every route.

## 10. Changes

Material changes will be reflected here with a new effective date. Because
every claim in sections 3 and 4 is tied to a file and a line, a code change
that falsifies one of them is a change to this document too.

---

## Open points

- Contabo's Art 28 DPA/AVV reference is not yet confirmed and recorded
  (section 5/6).
- The Backblaze B2 EU-Central offsite backup credential is not yet
  provisioned; backups are on-host only until it is.
- No scheduled job deletes an expired `sessions` row — it becomes unusable
  at 30 days but is not purged from the table (section 5).
- No self-service account/project-deletion API endpoint exists; DSAR
  erasure is currently a manual, operator-run process (section 7).
- Whether Azure Container Apps ingress/diagnostic logging is enabled for
  `metrion-viewer`/`metrion-ingest`, and whether it records client IP
  addresses, is not determinable from this repository.
- The threshold-alerting feature's email provider (Brevo, tentatively) is
  not yet chosen; section 6's Chapter V position for it is provisional until
  it is.

Effective: 2026-09-07
