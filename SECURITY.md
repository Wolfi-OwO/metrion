# Security Policy

`metrion` collects resource and uptime metrics and shows them back as charts.
Three parts run:

- The **collector** (`applications/agent`) on a VPS reads local metrics once a
  minute and POSTs them over HTTPS to the ingest service, authenticated with a
  per-project API key.
- **Ingest** (`applications/ingest`) validates and stores metrics in
  Postgres/TimescaleDB. It runs in Docker on a Contabo VPS, next to the
  database, behind Caddy.
- The **viewer** (`applications/viewer`) is the dashboard and its API. It runs
  on Azure Container Apps, signs users in with OAuth and reads the same
  database through an SSH tunnel.

Everything below is checked against the code and configuration in this
repository. Where something lives only on the servers or could not be
confirmed, it says so ("not verified") rather than claiming a control.

## Reporting a vulnerability

Report privately rather than opening a public issue:

- Contact: koflerphillip@outlook.com

Do not put a real API key, session cookie, database credential or the VPS's
own address in the report; describe the flaw and share reproduction details
over a private channel.

### Scope

- Source code and CI/CD configuration in this repository.
- Not in scope: Azure, Contabo, Docker, Caddy, Postgres/TimescaleDB or the
  VPS's OS - report those upstream.

## What this system deliberately does not collect

The full statement is in [`PRIVACY.md`](PRIVACY.md); this is how the code
enforces it.

- **Ingest** logs one line per request with `method`, `path`, `status` and
  `durationMs` (`applications/ingest/src/main.ts`). No client IP, no headers, no
  query string, no body.
- **Viewer** replaces `pino-http`'s default serializer outright
  (`applications/viewer/src/main.ts`), because the default emits
  `remoteAddress`, `remotePort` and the full header set and keeps the query
  string in `url`. A viewer log line holds `method`, `path` (query string cut
  off) and `statusCode`. Replacing rather than trimming means a field added
  upstream later cannot reintroduce the capture.
- **Caddy** on the VPS logs to stdout as JSON with `request>remote_ip`,
  `request>client_ip`, `request>headers`, `request>uri` and `resp_headers`
  deleted. This is set on every site block through the `access_log` snippet and
  also on the global logger, which catches the automatic port-80 redirect for a
  hostname without a site block. Caddy additionally logs `Authorization` and
  `Cookie` request headers as `REDACTED`, per `PRIVACY.md` section 3 (observed
  2026-09-20 in retained lines, not enforced by our config). Log retention is
  Docker's, not a fixed number of days - see `PRIVACY.md`.
- The collector's Caddy reader (`applications/agent/src/collectors/caddy-requests.ts`)
  is typed so it cannot name `remote_ip`, `request.headers` or `request.uri`;
  it aggregates hostname, status code and latency per minute.

`path` is the one deliberate exception: it is the service's own route, carries
nothing about the caller, and without it a 500 cannot be traced to an endpoint.

## Ingest: API keys

`POST /api/v1/ingest` is the only write path. Authentication is a per-project
API key, presented as `Authorization: Bearer mtr_<prefix>_<secret>`.

- **Issued by the viewer** (`applications/viewer/src/handlers/projects.handlers.ts`):
  an 8-byte random prefix and a 24-byte random secret. Only the **SHA-256 of the
  secret** is stored (`api_keys.key_hash`); the full key is shown once in the
  creation response and never again.
- **Lookup** is by the non-secret `key_prefix` (unique, indexed). The secret is
  compared with `crypto.timingSafeEqual` over two SHA-256 digests
  (`applications/ingest/src/middlewares/api-key.ts`). Digests are compared
  instead of raw values so the comparison is constant-time and a length
  pre-check cannot leak the secret's length.
- An unknown prefix, a revoked key and a wrong secret all answer the same 401,
  so a caller cannot tell which one it hit.
- **The key decides tenancy** (ADR 0005). The project comes from the key row,
  never from the request body. A key can be bound to one application, in which
  case every point is written under that application regardless of the
  `resource` the body names. `resource` is a label, not an access boundary.
- **Rate limit** of 120 requests per minute (`INGEST_RATE_LIMIT_MAX`), keyed on
  the SHA-256 of the key's secret, so the limiter never holds the secret and no
  client IP is read. It is mounted after the auth check, so a flood of guessed
  keys cannot create buckets.
- **Body limits**: 256 KB JSON, at most 200 envelopes per request and 1000
  points per envelope; identifiers and units have length caps
  (`src/schemas/ingest.schemas.ts`).
- Keys are never logged, never echoed in an error and never part of
  `/openapi.json`.
- `last_used_at` is updated best-effort after a successful authentication.
- **No CORS headers** are sent by ingest, so browsers keep blocking
  cross-origin reads. Clients are servers and scripts.
- **Headers**: `helmet()` in the app, and Caddy overrides the same headers
  (`Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `Permissions-Policy`) so they appear once. No CSP: the
  service returns JSON only.
- In production, error bodies for 5xx and unexpected errors are generic
  (`middlewares/error.ts`).

**What holding a key gets an attacker.** Write access to one project's metrics
(or one application's, if the key is bound): they can add fabricated points and
so poison that project's charts. No read access, no access to other projects, no
database access. Treat a leaked key as corrupted history, not disclosure.

### Public uptime endpoint

`GET /api/v1/public/projects/:id/uptime` needs no key or session. It answers
only when the project has `public_status_enabled = true`; the column defaults to
`false` (`packages/db/migrations/0011_project_public_status.sql`), and a project
that has not opted in returns 404. It returns aggregated uptime percentages,
latest latency and last-sample time per application, cached for 60 seconds.
There is no viewer UI or API to flip the flag (none found in
`applications/viewer/src`), so it is set directly in the database.

It has one shared rate-limit bucket (120/minute,
`PUBLIC_STATUS_RATE_LIMIT_MAX`) rather than one per caller, because there is no
identity to key on and reading the client IP is excluded by the privacy rules.
The trade-off: one noisy caller can exhaust the bucket for everyone.

### Rotating an API key

Keys are per project (or per application) and revocable individually, so
rotation does not need a shared window.

1. Create a new key for the project in the viewer (`POST /api/v1/projects/:id/keys`).
   Copy it then; it is not shown again.
2. Put it on the sender and confirm the next POST returns 202.
3. Revoke the old key (`DELETE /api/v1/keys/:id`). Revocation sets `revoked_at`
   (the app role has no `DELETE` on `api_keys`), and ingest rejects the key from
   the next request.

Rotate when a key appears in a shell history, log, screenshot or chat, when a
sender is decommissioned, or at least every 12 months. Rotate first, then clean
up - a key pasted somewhere public is burned the moment it lands.

## Viewer: sign-in, sessions and authorisation

- **OAuth** with Google, Microsoft and GitHub (`applications/viewer/src/auth`).
  Google and Microsoft use OpenID Connect discovery with **PKCE (S256)** and a
  random `state`; GitHub uses the authorisation-code flow with `state` (no
  PKCE). The pending state is held in memory for 10 minutes, is single-use, and
  is bound to the provider; a callback with an unknown, expired or
  wrong-provider `state` is a 401. Because it is in memory, this relies on the
  viewer running a single replica (`maxReplicas: 1`).
- **Identity** is keyed on `(provider, provider_subject)` - the provider's
  immutable subject - never on email, which a provider can let a user change.
  Accounts with the same email on two providers stay separate accounts. GitHub
  sign-in uses only a primary **and verified** email. A provider account without
  an accessible email is refused.
- **Sessions** are an opaque `gen_random_uuid()` id in a row of the `sessions`
  table, not a JWT. The cookie is `mtr_session`, `HttpOnly; Secure;
SameSite=Lax; Path=/`, 30-day expiry, and carries an HMAC-SHA256 signature
  (`SESSION_SECRET`) that is verified in constant time as an early reject for a
  tampered cookie. The signature is not what makes the session unguessable; the
  random id is. `POST /auth/logout` deletes the row, so a replayed cookie is a 401. Expired rows are ignored on lookup; whether they are purged is not
  verified.
- **CSRF**: there is no separate CSRF token. The controls are `SameSite=Lax`
  (no cross-site POST/DELETE carries the cookie), state-changing routes being
  `POST`/`PATCH`/`PUT`/`DELETE` only, and a CORS allowlist
  (`CORS_ALLOWED_ORIGINS`, required at boot) limited to `GET, POST, DELETE,
OPTIONS` with `Authorization` and `Content-Type` as allowed headers. Note the
  CORS method list omits `PATCH` and `PUT` although routes for them exist; those
  are same-origin only.
- **Authorisation** is per account. Every project, key, application and
  threshold route requires a session and resolves the caller's projects from
  `projects.owner_user_id`; a project id outside that set answers 404, not 403,
  so existence is not revealed. Key creation and revocation re-check ownership
  in SQL. The metrics read API is scoped the same way: without a session the
  caller owns no projects and sees nothing.
- **Public surface**: liveness, `/openapi.json` and the API docs page, and the
  legal pages. The viewer holds no key that writes metrics.
- **Startup**: the viewer refuses to boot without `DATABASE_URL`,
  `CORS_ALLOWED_ORIGINS`, `PUBLIC_BASE_URL`, `SESSION_SECRET` and all six OAuth
  client variables. This only checks non-empty. As of the last runbook entry
  the Google and Microsoft client registrations were still placeholders
  (`organizational/viewer-deployment-runbook.md`); whether they are real now is
  not verified.
- **Rate limit**: a global bucket of 300 requests per minute
  (`GLOBAL_RATE_LIMIT_MAX`) for every route except liveness and the legal
  pages, global because keying on IP is excluded by the privacy rules. The
  viewer runs at `minReplicas: 0, maxReplicas: 1`; the limit is partly a cost
  guard.
- **Headers**: `helmet()` defaults. `trust proxy` is 1.
- The container runs as the non-root `node` user, as does ingest.

## Database

- **Migrations** (`packages/db/migrations`) are forward-only SQL, recorded in
  `schema_migrations`, and are run as one explicit step from CI, never at
  application start-up.
- **Roles.** `metrion` is the superuser and owns migrations.
  `metrion_app` (migration `0005` onward) is the least-privilege role: no
  password in the migration (set out of band), `SELECT`/`INSERT` on `metrics`
  (no `UPDATE`/`DELETE`), no `DELETE` on `api_keys` or `projects`, and table
  grants added per table in later migrations. **The viewer's database URL uses
  `metrion_app` per the runbook. The ingest container on the VPS still connects
  as the `metrion` superuser** (`docker-compose.prod.yml`, confirmed in the
  running container's environment on 2026-09-20), so a flaw in ingest has the
  blast radius of a database administrator. This is a known gap; the fix is
  switching ingest's `DATABASE_URL` to `metrion_app`.
- **Statement timeout** of 10 seconds on ingest's pool
  (`applications/ingest/src/lib/db.ts`), because unauthenticated public reads
  share it with the write path. Not set for the viewer or the migration runner.
- **All queries are parameterised**; there is no string-built SQL with user
  input in the ingest paths reviewed here.
- **Sensitive columns**: `api_keys.key_hash` (hash only), `sessions`,
  `identities` and `users.email`. See `PRIVACY.md` for what personal data
  exists and its retention.

## Deployment and network

**VPS (`metrion-db-1`, `metrion-ingest-1`, Docker Compose).**

- TimescaleDB publishes `127.0.0.1:5432` only. Ingest publishes no host port; it
  joins the shared `edge-net` network, and Caddy is the only container that
  publishes public ports.
- **TLS to Postgres**: `ssl=on`, TLS 1.2 minimum, and `pg_hba.conf` is rewritten
  on first init to `hostssl ... scram-sha-256` only, with no TCP `trust` rule
  (the unix-socket `trust` line stays for the image's own tooling and is
  unreachable from outside the container), so plaintext connections are
  rejected before authentication (`db/init/10-tls-hba.sh`; it runs only on an
  empty data directory, so the live `pg_hba.conf` was corrected by hand on
  2026-09-20, see the runbook). The
  server certificate is the image's self-signed snakeoil certificate and clients
  connect with `sslmode=require`, which encrypts but does **not** authenticate
  the server. Server identity is instead established by the network path: the
  local Docker bridge for ingest, and a host-key-pinned SSH tunnel for the
  viewer.
- **Firewall** (`organizational/metrion-db-firewall/apply-fw.sh`, a systemd
  oneshot): Docker's published-port DNAT bypasses `ufw`, so port 5432 is
  controlled in the `DOCKER-USER` chain with an optional source-IP `ACCEPT`, a
  subnet-scoped `ACCEPT` for the ingest-to-db bridge, and a catch-all `DROP`.
  **Caveat**: `br_netfilter` is not loaded on the VPS (measured 2026-09-20),
  so bridged container-to-container traffic never reaches that chain and the
  `DROP` has not been what protects ingest-to-db. Loading `br_netfilter`
  would route it through the `DROP`; the subnet `ACCEPT` exists so that it
  would still work, but ingest's liveness check touches no database, so a
  regression would be silent while writes fail. The 127.0.0.1 binding is the
  primary control.
- **Caddy** terminates TLS with Let's Encrypt certificates (automatic HTTPS
  per hostname) and reverse-proxies to ingest by container name. Its logging is
  described above.
- The `deploy` account has passwordless `sudo` (stated in
  `organizational/metrion-deploy/deploy.sh`; `sudo -n` succeeded on 2026-09-20).
  CI's key is therefore restricted rather than the account (next section).

**Viewer (Azure Container Apps, West Europe).**

- A `db-tunnel` sidecar holds an SSH port-forward to the VPS Postgres, because
  Container Apps Consumption has no stable outbound IP to allowlist. The
  sidecar pins the VPS's ed25519 host key with `StrictHostKeyChecking=yes`. On
  the VPS the tunnel user is a dedicated no-login account whose single key is
  restricted to forwarding `127.0.0.1:5432` (`agent-deployment-runbook.md`; the
  live `authorized_keys` was not re-verified).
- Secrets (`database-url`, the tunnel key, `session-secret`, the OAuth client
  secrets) are Container Apps secrets referenced with `secretref:`, not
  plaintext environment values. The app's Azure system-assigned identity is used
  only to pull images from the container registry; it is not used for the
  database connection.
- The old Azure ingest app is retired separately and is no longer updated by
  the deploy workflow; its decommissioning is not covered here.

## CI/CD

- **CI** (`.github/workflows/ci.yml`) runs lint, format check, typecheck, build
  and tests against a throwaway Postgres service. Markdown is format-checked, so
  this file must be prettier-clean.
- **Deploy** (`.github/workflows/deploy.yml`) runs only after CI succeeded on
  `main`, or by manual dispatch, and never cancels a deploy in progress.
- **Azure**: OIDC federation. There is no long-lived Azure client secret in the
  repository or in GitHub; the `metrion-deploy` identity trusts this repository
  on `main` only, through two federated credentials.
- **VPS**: a dedicated SSH key stored as the GitHub secret
  `METRION_SSH_DEPLOY_KEY` (this one is long-lived) that is a **forced-command
  key**: the server ignores what the client asks for and always runs
  `/opt/metrion/deploy.sh`, which accepts exactly two requests - an empty command
  (run migrations from a tarball on stdin) or `ingest <tag>` with a
  `[A-Za-z0-9._-]+` tag - and refuses anything else. The host key is pinned in
  the workflow, not fetched with `ssh-keyscan`. The migration step runs on the
  VPS, reading the database password from the VPS's own `.env` (mode 600), so the
  password never travels over SSH.
- **Ingest deploys** pull an immutable per-run image tag, restart only the
  ingest container (`--no-deps`, the database is never recreated), wait for
  healthy, run a real database round trip with the container's own
  `DATABASE_URL`, and **roll back to the previous tag** if that fails. The
  workflow then checks the public endpoint through Caddy.
- **Secret scanning**: `gitleaks detect --no-git` over the working tree is run
  by hand before anything is pushed to a public remote. There is no gitleaks
  step in CI or a repository hook (none found), so this is a practice, not an
  enforced control.

## Backups

- **Nightly**, an account-tables-only dump (`users`, `identities`, `projects`,
  `api_keys`, `sessions`) is **GPG-encrypted on the VPS** to a public key whose
  private half is not on the box. A compromise of the VPS can stop new backups
  but cannot decrypt old ones. The plaintext dump is shredded on every exit path
  and 14 days are kept on the host.
- **Offsite copy** (Backblaze B2, EU) is optional and non-fatal: it is skipped
  with a log line when `offsite.env` is absent, and it is **not provisioned
  today**, so backups are on the host only (`PRIVACY.md`, open points).
  The script copy in this repository
  (`organizational/metrion-backups/nightly-account-dump.sh`) is older than the
  one deployed on the VPS: it still exits non-zero on a missing `offsite.env`
  and does not have the cleanup trap. The behaviour described here is the
  deployed one.
- **Weekly**, a metrics-only dump (the four account/secret tables excluded) is
  kept on the host for four weeks and is **not encrypted**, since it holds no
  account data and does not leave the host.
- Restores are not rehearsed on a schedule; not verified.

## Known gaps

- Ingest connects to Postgres as the `metrion` superuser (see Database).
- Postgres TLS uses the image's self-signed snakeoil certificate with
  `sslmode=require`: encryption without server authentication. Accepted
  deliberately - the certificate's private key ships inside the public
  `timescale/timescaledb-ha:pg17` image (modulus verified identical across a
  fresh pull, 2026-09-20), so pinning it via `verify-ca` would authenticate
  nothing. Server identity rests on the network path instead: a single-host
  Docker bridge for ingest, and a host-key-pinned SSH tunnel for the viewer.
  Revisit only if a hop ever crosses a network not controlled end-to-end.
- Backups have no offsite copy yet.
- No CSRF token; the protection is `SameSite=Lax` plus the CORS allowlist.
- The public-status rate limit is one shared bucket.
- Secret scanning is manual.
- Session-row purging, live `pg_hba.conf` and current OAuth client registration
  state were not verified while writing this.
