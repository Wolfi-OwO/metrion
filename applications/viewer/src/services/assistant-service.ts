import { getPool } from '../lib/db.js';
import { complete, llmHealthy, type LlmMessage } from '../lib/llm.js';
import { BadRequestError, NotFoundError, ServiceUnavailableError } from '../middlewares/error.js';
import { thresholdBoundsIssue } from '../schemas/thresholds.schemas.js';

export type ActionType = 'create_threshold' | 'delete_threshold';

/** What the model asks for. Every field is always present (the schema forces it); empty text and null mean "not given". */
export interface RawAction {
  type: ActionType;
  project: string;
  application: string;
  metric: string;
  direction: 'above' | 'below';
  warning: number | null;
  critical: number | null;
}

/**
 * One thing the assistant did, or proposes and waits for a yes on, shown as a card under its message.
 * pending: it removes something, so it waits for the person's yes. declined: the person said no.
 */
export interface ChatAction {
  type: ActionType;
  status: 'done' | 'exists' | 'skipped' | 'pending' | 'declined';
  label: string;
  detail?: string;
  thresholdId?: string;
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  actions: ChatAction[];
  createdAt: string;
}

const HISTORY = 8;
const SHOWN = 60;
const MAX_MESSAGE = 1000;
const DIGEST_LIMIT = 6000;

export const TURN_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', maxLength: 400 },
    actions: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['create_threshold', 'delete_threshold'] },
          project: { type: 'string' },
          application: { type: 'string' },
          metric: { type: 'string' },
          direction: { type: 'string', enum: ['above', 'below'] },
          warning: { type: ['number', 'null'] },
          critical: { type: ['number', 'null'] },
        },
        required: ['type', 'project', 'application', 'metric', 'direction', 'warning', 'critical'],
        additionalProperties: false,
      },
    },
  },
  required: ['reply', 'actions'],
  additionalProperties: false,
} as const;

interface ProjectRow {
  id: string;
  name: string;
}
interface AppRow {
  id: string;
  project_id: string;
  key: string;
  display_name: string | null;
}
interface MetricRow {
  project_id: string;
  resource: string;
  name: string;
  latest: number;
}
interface ThresholdRow {
  id: string;
  project_id: string;
  application_id: string | null;
  metric_name: string;
  direction: 'above' | 'below';
  warning_value: number | null;
  critical_value: number | null;
}

/** Everything the model may talk about, read for the caller's own projects only. */
export interface Scope {
  projects: ProjectRow[];
  apps: AppRow[];
  metrics: MetricRow[];
  thresholds: ThresholdRow[];
}

export async function loadScope(projectIds: readonly string[]): Promise<Scope> {
  if (projectIds.length === 0) return { projects: [], apps: [], metrics: [], thresholds: [] };
  const pool = getPool();
  const ids = [...projectIds];
  const [projects, apps, metrics, thresholds] = await Promise.all([
    pool.query<ProjectRow>('SELECT id, name FROM projects WHERE id = ANY($1) ORDER BY name', [ids]),
    pool.query<AppRow>(
      'SELECT id, project_id, key, display_name FROM applications WHERE project_id = ANY($1) ORDER BY key',
      [ids],
    ),
    pool.query<MetricRow>(
      `SELECT project_id, resource, name, last(value, time) AS latest
         FROM metrics
        WHERE project_id = ANY($1) AND time > now() - interval '7 days'
        GROUP BY project_id, resource, name`,
      [ids],
    ),
    pool.query<ThresholdRow>(
      `SELECT id, project_id, application_id, metric_name, direction, warning_value, critical_value
         FROM thresholds WHERE project_id = ANY($1) ORDER BY created_at`,
      [ids],
    ),
  ]);
  return {
    projects: projects.rows,
    apps: apps.rows,
    metrics: metrics.rows,
    thresholds: thresholds.rows,
  };
}

const num = (value: number): string => String(Math.round(value * 100) / 100);

/** The scope as plain lines for the model: projects, their applications with metric names and latest values, thresholds. */
export function describeScope(scope: Scope): string {
  if (scope.projects.length === 0) return '(this account has no projects yet)';
  const lines: string[] = [];
  for (const project of scope.projects) {
    lines.push(`Project "${project.name}":`);
    const apps = scope.apps.filter((a) => a.project_id === project.id);
    if (apps.length === 0) lines.push('  (no applications yet)');
    for (const app of apps.slice(0, 15)) {
      const metrics = scope.metrics
        .filter((m) => m.project_id === project.id && m.resource === app.key)
        .slice(0, 30)
        .map((m) => `${m.name} (now ${num(m.latest)})`);
      lines.push(
        `  - application "${app.key}": metrics ${metrics.join(', ') || 'none seen in the last 7 days'}`,
      );
    }
    for (const t of scope.thresholds.filter((x) => x.project_id === project.id)) {
      const app = scope.apps.find((a) => a.id === t.application_id);
      const bounds = [
        t.warning_value === null ? '' : `warning ${num(t.warning_value)}`,
        t.critical_value === null ? '' : `critical ${num(t.critical_value)}`,
      ]
        .filter(Boolean)
        .join(', ');
      lines.push(
        `  * threshold on ${app ? `"${app.key}"` : 'every application'}: ${t.metric_name} ${t.direction} (${bounds})`,
      );
    }
  }
  const text = lines.join('\n');
  return text.length > DIGEST_LIMIT ? `${text.slice(0, DIGEST_LIMIT)}\n...` : text;
}

export function systemPrompt(scope: Scope): string {
  return [
    'You are the assistant of Metrion, a small metrics platform. You help the person understand their projects and manage the alert thresholds on them.',
    'You act by listing actions:',
    '- create_threshold: alert when a metric goes above or below a value. "project" is the project name, "application" the application name or "" for every application of the project, "metric" the exact metric name, "direction" above or below, "warning" and "critical" the limits (null for one you were not given; at least one is needed; for "above" critical must not be lower than warning).',
    '- delete_threshold: remove the threshold on that metric (same fields; limits and direction may be anything). The person is asked to confirm before it is removed.',
    'Only use project, application and metric names from the list below, written exactly as there. You cannot change anything else. List an action only when the person asked for it; otherwise "actions" is empty.',
    'The "reply" is only for talking to the person, in their own language, one to three short sentences. When asked about the state of things, use the numbers below.',
    'Example answers:',
    '{"reply":"Done, you will be warned above 80 and alerted above 95.","actions":[{"type":"create_threshold","project":"Servers","application":"vps","metric":"cpu_percent","direction":"above","warning":80,"critical":95}]}',
    '{"reply":"Confirm below and I remove it.","actions":[{"type":"delete_threshold","project":"Servers","application":"vps","metric":"cpu_percent","direction":"above","warning":null,"critical":null}]}',
    'What exists for this person:',
    describeScope(scope),
  ].join('\n');
}

const norm = (text: string): string => text.trim().toLowerCase();

interface Resolved {
  project: ProjectRow;
  app: AppRow | null;
}

function resolve(scope: Scope, raw: RawAction): Resolved | string {
  const project =
    scope.projects.find((p) => norm(p.name) === norm(raw.project)) ??
    (scope.projects.length === 1 ? scope.projects[0] : undefined);
  if (!project) return `There is no project called ${raw.project || '(none given)'}.`;
  if (norm(raw.application) === '') return { project, app: null };
  const app = scope.apps.find(
    (a) =>
      a.project_id === project.id &&
      (norm(a.key) === norm(raw.application) ||
        norm(a.display_name ?? '') === norm(raw.application)),
  );
  if (!app) return `There is no application called ${raw.application} in ${project.name}.`;
  return { project, app };
}

const labelOf = (raw: RawAction, found?: Resolved): string =>
  `${found?.app?.key ?? (found ? `all of ${found.project.name}` : raw.application || raw.project)}: ${raw.metric} ${raw.direction}`;

/** Does the named metric exist where the threshold would apply (the application, or anywhere in the project)? */
function knowsMetric(scope: Scope, found: Resolved, metric: string): boolean {
  return scope.metrics.some(
    (m) =>
      m.project_id === found.project.id &&
      (found.app === null || m.resource === found.app.key) &&
      m.name === metric,
  );
}

function matching(scope: Scope, found: Resolved, raw: RawAction): ThresholdRow[] {
  return scope.thresholds.filter(
    (t) =>
      t.project_id === found.project.id &&
      t.application_id === (found.app?.id ?? null) &&
      t.metric_name === raw.metric,
  );
}

/** Carries out one action the model asked for. Creating is done at once; removing waits for a yes. */
export async function perform(scope: Scope, raw: RawAction): Promise<ChatAction> {
  const skip = (label: string, detail: string): ChatAction => ({
    type: raw.type,
    status: 'skipped',
    label,
    detail,
  });
  const found = resolve(scope, raw);
  if (typeof found === 'string') return skip(labelOf(raw), found);
  const label = labelOf(raw, found);
  if (!knowsMetric(scope, found, raw.metric))
    return skip(label, `There is no metric called ${raw.metric} there.`);

  if (raw.type === 'delete_threshold') {
    const [threshold] = matching(scope, found, raw);
    if (!threshold) return skip(label, 'There is no such threshold.');
    return {
      type: 'delete_threshold',
      status: 'pending',
      label,
      detail: 'The threshold is removed. Past data stays.',
      thresholdId: threshold.id,
    };
  }

  const issue = thresholdBoundsIssue({
    direction: raw.direction,
    warningValue: raw.warning,
    criticalValue: raw.critical,
  });
  if (issue) return skip(label, issue.replaceAll('`', ''));
  if (matching(scope, found, raw).length > 0)
    return { type: raw.type, status: 'exists', label, detail: 'A threshold on it already exists.' };
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO thresholds (project_id, application_id, metric_name, direction, warning_value, critical_value)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [found.project.id, found.app?.id ?? null, raw.metric, raw.direction, raw.warning, raw.critical],
  );
  const created = rows[0];
  if (!created)
    return { type: raw.type, status: 'exists', label, detail: 'A threshold on it already exists.' };
  const limits = [
    raw.warning === null ? '' : `warning ${num(raw.warning)}`,
    raw.critical === null ? '' : `critical ${num(raw.critical)}`,
  ]
    .filter(Boolean)
    .join(', ');
  return { type: raw.type, status: 'done', label, detail: limits, thresholdId: created.id };
}

function toMessage(row: {
  id: string | number;
  role: 'user' | 'assistant';
  content: string;
  actions: ChatAction[];
  created_at: Date;
}): ChatMessage {
  return {
    id: Number(row.id),
    role: row.role,
    content: row.content,
    actions: row.actions,
    createdAt: row.created_at.toISOString(),
  };
}

async function add(
  userId: string,
  role: 'user' | 'assistant',
  content: string,
  actions: ChatAction[] = [],
): Promise<ChatMessage> {
  const { rows } = await getPool().query(
    `INSERT INTO assistant_messages (user_id, role, content, actions) VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id, role, content, actions, created_at`,
    [userId, role, content, JSON.stringify(actions)],
  );
  return toMessage(rows[0]);
}

export const assistantService = {
  async status(): Promise<{ enabled: boolean; ready: boolean }> {
    return { enabled: Boolean(process.env.LLM_SERVICE_URL), ready: await llmHealthy() };
  },

  async history(userId: string): Promise<ChatMessage[]> {
    const { rows } = await getPool().query(
      `SELECT id, role, content, actions, created_at FROM (
         SELECT * FROM assistant_messages WHERE user_id = $1 ORDER BY id DESC LIMIT ${String(SHOWN)}
       ) m ORDER BY id`,
      [userId],
    );
    return rows.map(toMessage);
  },

  async clear(userId: string): Promise<void> {
    await getPool().query('DELETE FROM assistant_messages WHERE user_id = $1', [userId]);
  },

  /** One turn: the message goes in, the assistant's answer (and what it did) comes back. */
  async turn(userId: string, projectIds: readonly string[], text: string): Promise<ChatMessage> {
    const message = text.trim();
    if (message === '' || message.length > MAX_MESSAGE)
      throw new BadRequestError(`Write between 1 and ${String(MAX_MESSAGE)} characters.`);
    if (!(await llmHealthy()))
      throw new ServiceUnavailableError('The assistant is not running right now.');
    await add(userId, 'user', message);

    const scope = await loadScope(projectIds);
    const { rows } = await getPool().query<{ role: 'user' | 'assistant'; content: string }>(
      `SELECT role, content FROM (
         SELECT id, role, content FROM assistant_messages WHERE user_id = $1 ORDER BY id DESC LIMIT ${String(HISTORY)}
       ) m ORDER BY id`,
      [userId],
    );
    const messages: LlmMessage[] = [{ role: 'system', content: systemPrompt(scope) }, ...rows];

    let turn: { reply: string; actions: RawAction[] };
    try {
      turn = JSON.parse(await complete(messages, TURN_SCHEMA)) as typeof turn;
    } catch {
      // Cut off or unreadable: say so, do nothing.
      return add(userId, 'assistant', 'I could not finish that answer. Please try again.');
    }
    const results: ChatAction[] = [];
    let current = scope;
    for (const raw of turn.actions.slice(0, 6)) {
      const done = await perform(current, raw);
      results.push(done);
      // A threshold made earlier in the same answer counts for the ones after it.
      if (done.status === 'done') current = await loadScope(projectIds);
    }
    return add(userId, 'assistant', turn.reply.trim() || 'Done.', results);
  },

  /** The person's answer to a pending card. A decision can be given once. */
  async answer(
    userId: string,
    projectIds: readonly string[],
    messageId: number,
    index: number,
    decision: 'confirm' | 'decline',
  ): Promise<ChatAction> {
    const { rows } = await getPool().query(
      `SELECT id, role, content, actions, created_at FROM assistant_messages WHERE id = $1 AND user_id = $2`,
      [messageId, userId],
    );
    const row = rows[0];
    const action = row ? (toMessage(row).actions[index] as ChatAction | undefined) : undefined;
    if (!row || !action) throw new NotFoundError('That action does not exist.');
    if (action.status !== 'pending') throw new BadRequestError('That action was already answered.');

    let result: ChatAction;
    if (decision === 'decline') {
      result = { ...action, status: 'declined' };
    } else if (action.type === 'delete_threshold' && action.thresholdId) {
      const { rowCount } = await getPool().query(
        'DELETE FROM thresholds WHERE id = $1 AND project_id = ANY($2)',
        [action.thresholdId, [...projectIds]],
      );
      result =
        (rowCount ?? 0) > 0
          ? { ...action, status: 'done', detail: 'The threshold was removed.' }
          : { ...action, status: 'skipped', detail: 'It was already gone.' };
    } else {
      result = { ...action, status: 'skipped', detail: 'Nothing to do.' };
    }
    const actions = (row.actions as ChatAction[]).map((a, i) => (i === index ? result : a));
    await getPool().query(
      'UPDATE assistant_messages SET actions = $3::jsonb WHERE id = $1 AND user_id = $2',
      [messageId, userId, JSON.stringify(actions)],
    );
    return result;
  },
};
