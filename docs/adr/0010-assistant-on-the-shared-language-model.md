# 0010 The assistant uses the language model the burrow stack already runs

Status: accepted, 2026-11-09

## Context

The viewer should answer "how are my projects doing?" and set or remove alert thresholds from a chat. A hosted model
would send the names of a person's projects, applications and metrics to a third party, and a second model container
would cost another 2.3 GiB of a 7.9 GiB server.

## Decision

The viewer talks to the llama.cpp server (`burrow-llm`, Qwen2.5 3B) that the burrow stack runs, over burrow's internal
`llm-net` (external to this compose file, `burrow_llm-net`). The network has no route to the internet. Requests are
queued one at a time inside the viewer and rate limited per account.

The model never touches the database. It receives a plain-text digest of the caller's own projects (names, applications,
metric names with the latest value, existing thresholds, all read through the session-resolved project ids) and answers
with JSON constrained by a schema: a short reply and at most six actions, `create_threshold` and `delete_threshold`.
The service resolves every name against that same digest and skips anything it cannot find; a threshold is made through
the same bounds rule as the REST route, and removing one waits for the person's yes on a card.

## Consequences

- Nothing leaves the server, and there is no extra memory cost.
- Metron's answers wait behind burrow's when both are used at the same moment (one model slot).
- A small model can misread a request, which is why every action is checked against real names and only a removal
  needs a confirmation: a wrong threshold is visible on the Status page and can be removed.
