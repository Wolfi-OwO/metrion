import assert from 'node:assert/strict';
import test from 'node:test';

// Dry run - the only `config/index.ts` escape hatch that avoids requiring
// real SMTP credentials to import the module at all. `EVALUATOR_DAILY_EMAIL_CAP`
// deliberately left unset: this test is about the DEFAULT, not an explicit cap -
// `mailer.test.ts`/`correlate.test.ts`/`uptime-alerting.test.ts` already cover
// that an explicit `dailyEmailCap: 50` is enforced.
process.env.EVALUATOR_DRY_RUN = 'true';

const { config } = await import('../dist/config/index.js');

test('dailyEmailCap default (no EVALUATOR_DAILY_EMAIL_CAP set) does not meaningfully cap daily notifications', () => {
  // Not 50 - the old default that silently dropped notifications on
  // 2026-10-01 during an unrelated flapping-metric incident.
  assert.notEqual(config.quota.dailyEmailCap, 50);
  // Large enough that `Math.max(0, dailyEmailCap - dailyCount)` in
  // `mailer.ts` never bottoms out for any realistic daily count.
  assert.ok(config.quota.dailyEmailCap > 1_000_000);
});
