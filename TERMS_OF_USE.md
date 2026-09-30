# Terms of Use (Nutzungsbedingungen)

**metrion — server supervision platform**
Effective: 2026-09-22

Operator: Phillip Kofler, Fürnitz, Kärnten, Österreich — see `IMPRESSUM.md`.

---

## 1. What this covers

Four surfaces are reachable over the internet:

- the **public read API** (`GET /api/v1/resources`, `GET /api/v1/metrics`),
- the **API documentation site** at `/docs` and `/openapi.json`,
- the **authenticated ingest endpoint**, `POST /api/v1/ingest`, and
- **account sign-in and project/API-key management**
  (`/auth/<provider>`, `GET /api/v1/me`, `/api/v1/projects`,
  `/api/v1/keys/:id`).

Using any of these means accepting these terms. Using the read API,
documentation or ingest endpoint needs no account. Creating a project and
issuing API keys needs signing in via Google, Microsoft or GitHub OAuth —
see `PRIVACY.md` section 6 for that provider's own role.

## 2. The read API and documentation

Public and unauthenticated on purpose: it serves aggregate resource usage of
the operator's own machines. It is provided for reading, not as a data feed to
resell or redistribute as your own. Automated polling is fine within the rate
limits; working around them is not.

A **global** rate limit applies to every route, every caller together — it is
not per client, so a burst from one caller can exhaust it for everyone. Over
the limit the answer is `429`. Liveness checks are exempt. Query ranges are
capped at 31 days per request.

## 3. The ingest endpoint

`POST /api/v1/ingest` accepts metrics under a per-project API key
(`mtr_<prefix>_<secret>`), issued by a signed-in project owner and resolved
to exactly one project at authentication time — never from anything in the
request body (`applications/ingest/src/middlewares/api-key.ts:1-60`;
`docs/adr/0005-api-key-determines-tenancy.md`). There is no shared token and
no unauthenticated write path.

**Who may send.** Only the holder of a valid, unrevoked API key for a given
project. A project owner can issue multiple keys and revoke any of them at
any time via `DELETE /api/v1/keys/:id`, without notice and without giving
reasons.

**What a key holder is responsible for.** Everything sent under that key,
whatever machine actually sent it:

- **Accuracy.** A key holder may append points under any `resource` name
  within their own project. Sending fabricated, mislabelled or duplicated
  points corrupts that project's own metrics history and is a breach of
  these terms.
- **Custody of the key.** Keep it out of shell history, logs, screenshots,
  chats and public repositories. Report a suspected leak to
  <koflerphillip@outlook.com> immediately; revoke and reissue via
  `DELETE /api/v1/keys/:id` and the project dashboard.
- **Acceptable use.** Only numeric measurements about your own systems. Do
  not put personal data, credentials, secrets, or anything you do not have
  the right to publish, into `resource`, `subResource` or metric names —
  the schema admits no free-text field, but those fields are still strings.
  Do not use the endpoint to attack, flood or probe the service, or to send
  data you are not entitled to collect or disclose.
- **Operator as processor.** If, despite the prohibition above, a key
  holder's payload nonetheless contains personal data, the operator
  processes it as an Art 28 DSGVO processor acting on the key holder's own
  instructions (this document and the ingest schema's own restrictions) —
  the key holder remains the controller of their own application's data,
  not the operator.

Limits: 200 envelopes per request, 1000 points per envelope, a 256 kB body,
a per-key rate limit, and timestamps within the last 24 hours and not in the
future. A request breaching any of these is rejected with `400`, `413` or
`429`. A rejected request is not stored.

**Deletion.** A project owner may request deletion of a project and its
data at any time by writing to <koflerphillip@outlook.com> — its metric
rows (`metrics`) and its permanent uptime history (`uptime_samples`,
`uptime_daily`, `uptime_incidents`) alike. No self-service project-deletion
endpoint exists yet — only `DELETE /api/v1/keys/:id`, which revokes a key
without deleting data — so deletion is currently carried out by the
operator by hand: `metrics` rows by a direct SQL statement, the three
uptime tables by `scripts/purge-uptime.mjs` (the operator's own erasure
tool, database-owner role only) — within the same one-month timeframe used
for any DSGVO Art 12(3) request (see `PRIVACY.md` section 7).

## 4. No warranty, no availability promise

metrion is provided **as is**. It runs with `minReplicas: 0`, so the first request
after an idle period wakes a container and is slow. There is no uptime
commitment, no support obligation, and maintenance may happen without notice.

Metrics may be missing, delayed, duplicated at a minute boundary, or wrong.
Do not use them as the sole basis for any decision that matters — an alarm, a
capacity purchase, a billing claim. Liability is excluded to the extent
permitted by Austrian law; liability for intent and gross negligence, and under
mandatory statutory provisions, remains unaffected.

**Threshold-alert delivery is best-effort only (planned feature, GitHub
issues #20-#24).** Once shipped, the evaluator's minute-by-minute threshold
poll and the resulting email are not covered by any monitoring or
availability guarantee. An alert not firing, or firing late, is not a
breach of any commitment under these terms — consistent with the rest of
this section's no-uptime-promise position.

## 5. Intellectual property

The source code is **proprietary** — see `LICENSE`. Public visibility of the
repository grants no licence to use, copy, modify or distribute it. Metric data
served by the public API describes the operator's own infrastructure and remains
the operator's.

## 6. Privacy

One strictly-necessary session cookie for signed-in users; no analytics, no
tracking, no third-party request from the browser. Account data (email,
OAuth identity, sessions, projects, API keys) and metrics are processed as
described, with lawful basis per purpose, retention periods and the DSAR
process, in `PRIVACY.md`.

## 7. Account termination

The operator may suspend or terminate an account, or any project or API key
under it, at any time and without notice, for a breach of these terms,
suspected abuse, or a legal or security reason. A user may close their own
account at any time by writing to <koflerphillip@outlook.com>; closing an
account triggers the deletion cascade described in `PRIVACY.md` section 7.

## 8. Changes

These terms may change. The effective date at the top marks the current version;
continued use after a change is acceptance of it.

## 9. Governing law

Austrian law, excluding its conflict-of-law rules and the UN Convention on
Contracts for the International Sale of Goods. Place of jurisdiction: Austria.
Mandatory consumer protection provisions of a consumer's country of residence
remain unaffected.

## 10. Contact

<koflerphillip@outlook.com>

---

Effective: 2026-09-22
