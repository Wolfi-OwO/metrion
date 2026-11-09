import assert from 'node:assert/strict';
import test from 'node:test';

process.env['DATABASE_URL'] = 'postgres://bogus:bogus@127.0.0.1:1/bogus';
process.env['CORS_ALLOWED_ORIGINS'] = 'https://example.test';
process.env['PUBLIC_BASE_URL'] = 'https://viewer.example.test';
process.env['SESSION_SECRET'] = 'assistant-test-session-secret';
process.env['OAUTH_GOOGLE_CLIENT_ID'] = 'x';
process.env['OAUTH_GOOGLE_CLIENT_SECRET'] = 'x';
process.env['OAUTH_MICROSOFT_CLIENT_ID'] = 'x';
process.env['OAUTH_MICROSOFT_CLIENT_SECRET'] = 'x';
process.env['OAUTH_GITHUB_CLIENT_ID'] = 'x';
process.env['OAUTH_GITHUB_CLIENT_SECRET'] = 'x';

const { describeScope, perform, systemPrompt } =
  await import('../dist/services/assistant-service.js');

const scope = {
  projects: [{ id: 'p1', name: 'Servers' }],
  apps: [{ id: 'a1', project_id: 'p1', key: 'vps', display_name: null }],
  metrics: [
    { project_id: 'p1', resource: 'vps', name: 'cpu_percent', latest: 12.345 },
    { project_id: 'p1', resource: 'vps', name: 'ram_percent', latest: 40 },
  ],
  thresholds: [
    {
      id: 't1',
      project_id: 'p1',
      application_id: 'a1',
      metric_name: 'cpu_percent',
      direction: 'above' as const,
      warning_value: 80,
      critical_value: 95,
    },
  ],
};

const raw = (over: Record<string, unknown>) => ({
  type: 'create_threshold' as const,
  project: 'Servers',
  application: 'vps',
  metric: 'ram_percent',
  direction: 'above' as const,
  warning: 80,
  critical: 95,
  ...over,
});

test('the model is told the projects, metrics with their latest value, and the thresholds that exist', () => {
  const text = describeScope(scope);
  assert.match(text, /Project "Servers"/);
  assert.match(
    text,
    /application "vps": metrics cpu_percent \(now 12\.35\), ram_percent \(now 40\)/,
  );
  assert.match(text, /threshold on "vps": cpu_percent above \(warning 80, critical 95\)/);
  assert.match(systemPrompt(scope), /create_threshold/);
  assert.equal(
    describeScope({ projects: [], apps: [], metrics: [], thresholds: [] }),
    '(this account has no projects yet)',
  );
});

test('an action naming something that does not exist is skipped with the reason, never guessed at', async () => {
  const unknownProject = await perform(
    { ...scope, projects: [...scope.projects, { id: 'p2', name: 'Other' }] },
    raw({ project: 'Nope' }),
  );
  assert.equal(unknownProject.status, 'skipped');
  assert.match(unknownProject.detail ?? '', /no project called Nope/);

  const unknownApp = await perform(scope, raw({ application: 'ghost' }));
  assert.equal(unknownApp.status, 'skipped');
  assert.match(unknownApp.detail ?? '', /no application called ghost/);

  const unknownMetric = await perform(scope, raw({ metric: 'disk_percent' }));
  assert.equal(unknownMetric.status, 'skipped');
  assert.match(unknownMetric.detail ?? '', /no metric called disk_percent/);
});

test('limits that contradict the direction, or none at all, are refused before anything is written', async () => {
  const backwards = await perform(scope, raw({ warning: 90, critical: 50 }));
  assert.equal(backwards.status, 'skipped');
  const none = await perform(scope, raw({ warning: null, critical: null }));
  assert.equal(none.status, 'skipped');
});

test('a threshold that already exists is reported, not made twice', async () => {
  const again = await perform(scope, raw({ metric: 'cpu_percent' }));
  assert.equal(again.status, 'exists');
});

test('removing a threshold waits for a yes and keeps the id it would remove', async () => {
  const pending = await perform(scope, raw({ type: 'delete_threshold', metric: 'cpu_percent' }));
  assert.equal(pending.status, 'pending');
  assert.equal(pending.thresholdId, 't1');
  const none = await perform(scope, raw({ type: 'delete_threshold', metric: 'ram_percent' }));
  assert.equal(none.status, 'skipped');
});

test('with exactly one project, an unnamed project means that one', async () => {
  const pending = await perform(
    scope,
    raw({ type: 'delete_threshold', project: '', metric: 'cpu_percent' }),
  );
  assert.equal(pending.status, 'pending');
});
