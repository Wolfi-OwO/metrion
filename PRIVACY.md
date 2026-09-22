# Privacy Policy (Datenschutzerklärung)

**metrion — server supervision platform**
**Effective:** 2026-09-22
**Last updated:** 2026-09-22

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
- **ingest** (`metrion-ingest`) — a container on the operator's Contabo VPS
  (the same host as the database), reachable at
  `https://metrion-ingest.woofi-developments.at` behind a Caddy reverse proxy
  that terminates TLS with a Let's Encrypt certificate. It exposes the one
  authenticated write path, `POST /api/v1/ingest`, authenticated per project
  by an API key, never by request content
  (`applications/ingest/src/middlewares/api-key.ts:1-60`;
  `docs/adr/0005-api-key-determines-tenancy.md`), and the opt-in public uptime
  endpoint described in section 6
  (`applications/ingest/src/routes/index.ts:57-85`).
- **viewer** (`metrion-viewer`) — an Azure Container App (West Europe)
  serving the account-scoped read API, the API documentation site at `/docs`,
  OAuth sign-in and session management
  (`applications/viewer/src/routes/auth.routes.ts:13-16`), and per-account
  project/API-key management
  (`applications/viewer/src/routes/projects.routes.ts:221-248`). It reaches
  the database over an SSH tunnel sidecar.
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

**Dual-write for `uptime.*` names.** A point whose `name` starts with
`uptime.` (`uptime.ok`, `uptime.latency`, `uptime.idle`) is written to
`metrics` as above AND, in the same database transaction, to the permanent
`uptime_samples` table described in "Uptime history" below
(`applications/ingest/src/handlers/ingest.handlers.ts:105-164`;
`docs/adr/0009-permanent-uptime-history-and-range-api.md`). Every other
metric name lands in `metrics` only.

### Uptime history (new with this release)

`uptime_samples` keeps every `uptime.*` point — the same shape as an
ordinary metric row: `project_id`, `resource` (the application key),
`name`, numeric `value`, `unit`, `interval_seconds`, `time` — with no
retention policy at all, unlike `metrics`' own 90 days
(`packages/db/migrations/0014_uptime_permanent_store.sql:1-13`). Two
further plain tables, `uptime_daily` and `uptime_incidents`, are rebuilt
from those raw rows every 10 minutes by a database job and hold the same
kind of data at a coarser grain (a day's up/down counts and latency
percentiles; a down run's start/end) — never anything not already derivable
from `uptime_samples` itself (`packages/db/migrations/0015_uptime_rollup_job.sql`).
Nothing about who is watching a status page is stored here, only what a
monitor measured about the operator's own infrastructure — the same
against-personal-data reasoning section 7 gives for `metrics` applies to
`uptime_samples`/`uptime_daily`/`uptime_incidents` unchanged.

**Public visibility is a separate, per-application opt-in.**
`applications.public_status_visible` defaults `false`
(`packages/db/migrations/0016_application_public_status_visible.sql`): an
application that ingest auto-registers the first time a key sends a new
`resource` name is never public by that fact alone — only one its owner has
explicitly turned on appears on either public endpoint in section 6.

**Erasure.** Unlike the previous edition of this document, this is no
longer an open point: the operator can delete an account's or project's
uptime history using `scripts/purge-uptime.mjs`, run against the
database-owner role. It deletes the matching `uptime_samples` and `metrics`
(`uptime.*` only) rows for a given project/application/time window and
rebuilds `uptime_daily`/`uptime_incidents` for that window afterward. See
section 7's deletion cascade for how this fits the rest of an erasure
request.

### Account data (new with this release)

| Table        | Columns                                                                                  | Holds                                                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`      | `id`, `email`, `created_at`                                                              | One row per signed-in person.                                                                                                                   |
| `identities` | `user_id`, `provider`, `provider_subject`, `email`                                       | One row per OAuth sign-in method, keyed on `(provider, provider_subject)`, never on `email` (`packages/db/migrations/0002_accounts.sql:12-20`). |
| `projects`   | `id`, `owner_user_id`, `name`, `slug`, `default_resource`, `created_at`                  | One row per metrics project a user owns.                                                                                                        |
| `api_keys`   | `id`, `project_id`, `key_prefix`, `key_hash`, `created_at`, `last_used_at`, `revoked_at` | One row per issued ingest credential; only a hash is stored, never the raw key (`packages/db/migrations/0002_accounts.sql:31-41`).              |
| `sessions`   | `id`, `user_id`, `expires_at`                                                            | One row per active browser sign-in (`packages/db/migrations/0002_accounts.sql:43-47`).                                                          |

`users.email` and the `identities` rows identify a natural person directly.
This table is why section 7's earlier position — that this application
processed nobody's personal data but the operator's own — no longer holds
without qualification.

## 3. What is deliberately never stored

**No client IP addresses. No user agents. No request paths. No query strings.**
The applications never store them: not in the database, not in an application
log line, not in an API response, not in an error body. The reverse proxy in
front of ingest has a transitional caveat for log lines written before
2026-09-20, described under "Reverse-proxy layer" below. The application-side guarantee is enforced in four separate places rather than asserted once:

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
- The rate limiters do not key on an IP. The ingest write limiter keys on a
  SHA-256 hash of the API key, so the limiter's store never holds the secret
  either (`applications/ingest/src/routes/index.ts:29-40`); the public uptime
  limiter uses one shared bucket, `'public-status'`
  (`applications/ingest/src/routes/index.ts:57-69`); the viewer's global
  limiter keys on the constant `'global'`
  (`applications/viewer/src/main.ts:82`).

`trust proxy` is set to `1` on both services so that `req.protocol` is honest
behind the reverse proxy (Caddy for ingest, the Azure ingress for the viewer);
it is not used to read a forwarded client address
(`applications/ingest/src/main.ts:19`; `applications/viewer/src/main.ts:21-25`).

**Ingest application log.** The ingest service's own request log records
`method`, `path` (this service's own route, query string not included),
`status` and `durationMs`, plus pino's `pid` and container `hostname`, and
nothing else (`applications/ingest/src/main.ts:23-38`). The error handler
writes no log line and echoes no request data
(`applications/ingest/src/middlewares/error.ts`). One debug-level line names
the `resource` label of an application-bound key whose body disagreed
(`applications/ingest/src/handlers/ingest.handlers.ts:50`); production runs
at the default `info` level, so it is not emitted. Both were read from the
code and the live container log was sampled on 2026-09-20 (`method`, `path`,
`status`, `durationMs` only). The verification run described below was
performed against the viewer.

**Reverse-proxy layer (Caddy, on the VPS).** Measured on the VPS on
2026-09-20, not assumed. Caddy writes an access log for the ingest host to its
standard output, which Docker keeps in a `json-file` log. The logger the
ingest host uses deletes `remote_ip`, `client_ip`, all request headers
(including `Authorization`), the request `uri` and all response headers, so a
line for an HTTPS request records only the time, method, host, TLS parameters,
the client's source port, byte counts, duration and status. Until 2026-09-20
the proxy's global (catch-all) logger was unfiltered: the automatic redirect
from plain HTTP (port 80) for a hostname without a site block, such as the
bare server IP or a spoofed `Host` header, was written with the client IP
address, the requested URI and the request headers. That logger now applies
the same deletions as the ingest host's logger, so no proxy log line written
after the change records a client IP, URI or header set, for any host. Caddy
also logs the `Authorization` and `Cookie` request headers as `REDACTED`
regardless of any filter (seen in retained lines of 2026-09-18 16:31:59Z and
23:29:15Z). HTTPS API calls to the ingest host and the plain-HTTP `400` answer for
that host (since 2026-09-20 the ingest host no longer redirects plain HTTP) log
no client IP, URI or headers. **Transitional note:** lines
written before this change may still contain client IPs for unmatched-host
traffic until they rotate out of the Docker log (see Retention below); the
date the last such line disappears is not known and depends on traffic.
The purpose of the log is operating the service and investigating abuse (Art
6(1)(f) DSGVO); it is not used for anything else. **Retention** is set by
Docker only: for the Caddy container and the `metrion-ingest` container alike,
`json-file` with `max-size` 10 MB and `max-file` 3 (host default in
`/etc/docker/daemon.json`, confirmed on both containers). That is a size
limit, not a time limit: when the newest file fills, the oldest is discarded.
On 2026-09-20 the Caddy log held about 26 MB reaching back to 2026-09-16
(all sites on that proxy together), so the effective period depends on traffic
and no fixed number of days is guaranteed. See the open points.

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

- **Two cookies, both strictly necessary.** `__Host-mtr_session` — an opaque,
  HMAC-signed session id, `HttpOnly`, `Secure`, `SameSite=Lax`, 30-day expiry
  (`applications/viewer/src/auth/session.ts`). It exists solely to keep a
  signed-in user signed in between requests to `GET /api/v1/me` and the
  project/key endpoints; nothing else reads or writes it. `__Host-mtr_oauth` —
  the random one-time OAuth `state` value, `HttpOnly`, `Secure`,
  `SameSite=Lax`, deleted when the sign-in completes and otherwise expiring
  after 10 minutes; it exists only to tie a sign-in to the browser that
  started it.
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
after choosing to sign in. Both cookies fit that exemption on its face: they
carry no tracking identifier usable across sessions or sites, is not read
by any third party, and does nothing if the user never signs in. On that
basis no consent is sought and no banner is shown for this cookie. This is a
narrower, reasoned claim than the file's previous "nothing is stored, so
nothing to ask about" — replace this whole analysis, not just its
conclusion, if the cookie's purpose or scope ever changes.

**Hard gate for anything added later.** Any future analytics snippet,
CDN-hosted font, embedded video, or tracking pixel is _not_ covered by the
strictly-necessary exemption above and requires a prior, freely-given,
specific opt-in banner — with reject exactly as easy as accept — before that
code ships. Shipping such a feature without that banner first is a direct
§ 165 Abs 3 TKG 2021 violation, not a documentation gap to fix later.

## 5. Storage location and retention

### Compute — Azure (viewer) and Contabo (ingest)

Microsoft Azure Container Apps hosts `metrion-viewer` only, region West
Europe (`organizational/viewer-deployment-runbook.md`). Microsoft's Data
Protection Addendum is the Art 28 DSGVO processor agreement for the viewer.
Azure no longer runs `metrion-ingest` (moved to the Contabo VPS on
2026-09-20) and is not the processor for the account or metrics database. The
ingest container image is pulled from Azure Container Registry; that image
contains no personal data.

### Database and ingest (Contabo)

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
- **Ingest and reverse proxy.** Since 2026-09-20 `metrion-ingest` also runs
  on this VPS, behind Caddy, so Contabo processes the ingest traffic
  (API keys in the `Authorization` header and metric payloads, in transit and
  in memory) in addition to hosting the database. The same Art 28 open point
  applies. Let's Encrypt (the certificate authority) receives only the
  domain name `metrion-ingest.woofi-developments.at` and is not a processor
  of personal data. No new third-country transfer arises: ingest traffic no
  longer passes through Azure, and both remaining locations are in the EEA
  (Azure West Europe: Netherlands/Ireland; Contabo Lauterbourg: France).

### Backups

A nightly encrypted dump of the account tables (`users`, `identities`,
`projects`, `api_keys`, `sessions` — never `metrics`) runs on the VPS,
GPG-encrypted on-host with the _public_ half of a keypair whose private half
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

| Data                                                                  | Period                              | Enforced by                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Metrics (`metrics` hypertable)                                        | 90 days                             | TimescaleDB retention policy; chunks older than 90 days are dropped by the platform (`packages/db/migrations/0004_rollups_and_retention.sql:40-43`).                                                                                                                                                                                   |
| Uptime history (`uptime_samples`, `uptime_daily`, `uptime_incidents`) | Indefinite while the project exists | Deliberately no TimescaleDB retention policy (`packages/db/migrations/0014_uptime_permanent_store.sql`) — a status page needs real history, not a rolling 90-day window. Deleted on an erasure request via `scripts/purge-uptime.mjs`, run by the operator against the database-owner role (see "Uptime history" above and section 7). |
| Sessions (`sessions`)                                                 | 30-day TTL from creation            | Checked at read time — an expired `expires_at` is treated as no session (`applications/viewer/src/auth/session.ts:16-18`, `:107`). **No scheduled job deletes the row itself once it expires** — it becomes unusable but is not purged; this is an open point below, not a claimed 30-day deletion guarantee.                          |
| Accounts (`users`/`identities`/`projects`/`api_keys`)                 | Life of the account                 | Deleted on request via section 8's process, or by the operator closing an account by hand. No automatic expiry exists in the schema.                                                                                                                                                                                                   |
| `status_events` (**planned, not yet built** — GitHub issues #20-#24)  | 180 days                            | Once shipped, enforced by a TimescaleDB retention policy on `status_events`, deleted 180 days after the event's own timestamp — the same mechanism already used for `metrics`' 90-day policy above (`packages/db/migrations/0004_rollups_and_retention.sql:40-43`).                                                                    |

- **On the VPS:** undelivered samples wait in a local queue capped at 1440
  lines — one day — plus small state files
  (`applications/agent/src/config/index.ts:48-59`). They are deleted once
  delivered.

## 6. Processors and recipients

- **Microsoft Azure** — compute for `metrion-viewer` only (Container App and
  its SSH-tunnel sidecar), plus the container registry holding the ingest
  image (no personal data). Microsoft's Data Protection Addendum is the
  Art 28 DSGVO processor agreement. Azure does not process the account or
  metrics database and no longer runs ingest (section 5).
- **Contabo GmbH** — the VPS running the self-hosted database and
  `metrion-ingest` with its Caddy reverse proxy, therefore processing all
  ingest traffic and the public uptime endpoint, and (via the nightly backup)
  the encrypted account-table dump before its offsite copy. Named as an
  Art 28 DSGVO processor; its own DPA/AVV reference is not yet confirmed and
  recorded — see section 5's open point.
- **Let's Encrypt (ISRG)** — certificate authority for the ingest hostname;
  receives the domain name only, no personal data, not a processor.
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

Nothing is shared with anyone else, sold, or used for advertising.

**The general read API is not public.** `GET /api/v1/metrics` and
`GET /api/v1/resources` carry no auth middleware, but every route resolves
the caller's accessible projects from the session cookie before it queries
anything; an anonymous caller — no cookie, or an invalid one — resolves to
zero accessible projects and the routes return empty data to anyone without
a session (`applications/viewer/src/routes/metrics.routes.ts:18-30`;
`applications/viewer/src/middlewares/project-scope.ts:48-59`). These two
routes serve a project owner's own ingested data, scoped by session, the
same Art 6(1)(b) basis as the rest of the account's project data — not a
public inventory of anything.

**The one genuinely public surface is `GET /api/v1/public/projects/:id/uptime`**,
served by the ingest service on the Contabo VPS at
`https://metrion-ingest.woofi-developments.at`
(`applications/ingest/src/routes/index.ts:57-85`;
`applications/ingest/src/handlers/public-status.handlers.ts`). It has no
session or API-key middleware because it has no caller identity to scope by;
it is rate limited with one shared bucket. Visibility is the project's own
opt-in, `projects.public_status_enabled`, default `false` — opt-in, not
opt-out, because this flag exposes a project's data to callers with no
account at all (`packages/db/migrations/0011_project_public_status.sql:1-8`).
For an opted-in project it returns, per application that has both ever
written an `uptime.ok` sample AND been individually opted in via
`applications.public_status_visible` (see "Uptime history" above): the
application key and display name, uptime percentages (24 hours, 7 days, 30
days), the latest latency, the time of the last sample and a 90-day daily
uptime history — corrected here from an earlier edition of this document,
which understated it as 30 days; the code has always returned 90
(`applications/ingest/src/services/public-status-service.ts`). It never
returns the resource/metric inventory (no CPU, memory or container/host
names); for every other project it returns the same 404 an unknown id would.

**A second endpoint, `GET /api/v1/public/projects/:id/uptime/range`
(added since the previous edition of this document; ADR 0009), reads
further back than 90 days.** Same opt-in gate (project- and
application-level), same field set (no resource/metric inventory), but a
caller supplies its own `from`/`to` and can request the WHOLE stored
history for an opted-in application in one call, not a fixed recent window
— `uptime_samples` has no retention policy (see the retention table above),
so "the whole history" can be the application's entire monitored lifetime.
This is a deliberate consequence of choosing to keep permanent history at
all, not an oversight: the data returned is the same operator-infrastructure
measurements either endpoint already exposes for an opted-in application,
just over a caller-chosen range instead of a fixed one.

Both routes are consumed server-to-server by the portfolio status page
(`organizational/uptime-sources.md`), so a status-page visitor's own IP
address reaches the portfolio host only, never this application; the caller
seen by ingest is the portfolio's server. The viewer no longer serves either
route.

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

| Purpose                                                                                                                  | Basis                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Account creation, OAuth sign-in, session maintenance                                                                     | Art 6(1)(b) — necessary to perform the contract the user enters by signing up                             |
| Project and API-key management                                                                                           | Art 6(1)(b)                                                                                               |
| Storing/serving a project's own ingested metrics                                                                         | Art 6(1)(b) — performance of the contract with that project's owner                                       |
| Storing the permanent uptime history (`uptime_samples`/`uptime_daily`/`uptime_incidents`), kept with no retention policy | Art 6(1)(b) — performance of the contract with that project's owner, same basis as the metrics row above  |
| Public uptime status endpoints (`GET .../uptime`, `GET .../uptime/range`), opt-in per project AND per application        | Art 6(1)(f) — legitimate interest, as reasoned above                                                      |
| Account-table backups                                                                                                    | Art 6(1)(f) — legitimate interest in business continuity                                                  |
| Threshold-alert email (**planned**, see below)                                                                           | Art 6(1)(b) — performance of the contract formed by configuring the threshold rule that triggers the send |

**DSAR / deletion cascade.** A request under Art 15/17/20 for a given user
is answered by walking, in order: `identities` (by `user_id`) → `sessions`
(by `user_id`) → `api_keys` (by `project_id`, for every project the user
owns) → `projects` (by `owner_user_id`) → `metrics`, `uptime_samples`,
`uptime_daily` and `uptime_incidents` rows (by `project_id`, for every
project just identified) → `users` itself. These four tables carry no
foreign key to `projects` at all — they are TimescaleDB hypertables and the
plain tables rebuilt from one (`packages/db/migrations/0003_metrics_hypertable.sql`,
`0014_uptime_permanent_store.sql`) — and grant `DELETE` to neither
application role (`metrion_app`, `metrion_ingest`); erasing them is
therefore always carried out by the operator connected as the
database-owner role, never by an application code path. For the three
uptime tables specifically, `scripts/purge-uptime.mjs` is that erasure
mechanism as of 2026-09-22 — it deletes a project's (or one application's)
uptime history for a given window and rebuilds `uptime_daily`/
`uptime_incidents` for that window afterward, run by the operator with the
database-owner DSN. `metrics` itself still has no equivalent scripted tool;
deleting it remains a hand-run `DELETE` by the operator. Once the
threshold-alerting feature ships (GitHub issues #20-#24), the same cascade
extends to `thresholds`, `threshold_status` and `status_events` — all three
scoped by `project_id`/`user_id` the same way `api_keys` and `metrics` are
today — and `users.email` must be treated as playing two roles at that
point: a login identifier (as today) _and_ a notification-delivery target
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

The measures relevant to this policy are documented in `SECURITY.md`: TLS
terminated by Caddy on the VPS for ingest and by the Azure ingress for the
viewer, one bearer token per project on the write path compared in constant
time, and rate limits on every route.

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
  erasure is currently a manual, operator-run process (section 7). As of
  2026-09-22 the uptime-history part of that process has a real tool
  (`scripts/purge-uptime.mjs`, section 7's cascade); `metrics` itself still
  has none and is deleted with a hand-run SQL statement.
- `scripts/purge-uptime.mjs` deletes by project/application/window; it has
  no bulk "every project this user owns" mode, so an account-wide erasure
  still runs it once per project rather than once per request.
- Whether Azure Container Apps ingress/diagnostic logging is enabled for
  `metrion-viewer`, and whether it records client IP addresses, is not
  determinable from this repository.
- Caddy's request logs on the VPS are filtered (no client IP, URI or headers,
  section 3), including the global catch-all logger since 2026-09-20, and plain
  HTTP to the ingest host now gets a `400` instead of a redirect. Docker keeps
  those logs for at most three 10 MB files with no time limit, so no retention
  period in days can be stated, and lines written before the filter may still
  hold client IPs until they rotate out. Decision pending: a time-based
  retention.
- The Azure `metrion-ingest` container was deleted on 2026-09-20; this
  policy describes the post-deletion state.
- The threshold-alerting feature's email provider (Brevo, tentatively) is
  not yet chosen; section 6's Chapter V position for it is provisional until
  it is.

Effective: 2026-09-22
