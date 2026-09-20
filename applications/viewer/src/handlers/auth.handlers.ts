import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../config/index.js';
import { getProvider, type PendingAuth } from '../auth/providers.js';
import {
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  readCookie,
} from '../auth/session.js';
import { getPool } from '../lib/db.js';
import { NotFoundError, UnauthorizedError } from '../middlewares/error.js';

/**
 * The in-flight-authentication store: `state` (and, for Google/Microsoft,
 * the PKCE `code_verifier`) between `GET /auth/:provider` handing the user
 * to the provider and `GET /auth/:provider/callback` getting them back.
 * Kept server-side, in memory, never in a cookie or the redirect URL, which
 * is what makes the state check below more than the provider just echoing a
 * value back to itself.
 *
 * ponytail: one process's memory, not a table. That is fine at this app's
 * `maxReplicas: 1` (see `main.ts`'s rate-limiter comment for the same
 * ceiling) - a login started on one replica must complete on the same one
 * regardless, and there is no second replica for it to miss. Upgrade path if
 * that ever changes: a `oauth_state` table with the same TTL, deleted on
 * first read exactly like this Map is below.
 */
const PENDING_TTL_MS = 10 * 60 * 1000;

interface PendingEntry extends PendingAuth {
  readonly provider: string;
  readonly redirectUri: string;
  readonly expiresAt: number;
}

const pendingAuths = new Map<string, PendingEntry>();

function rememberPending(entry: PendingEntry): void {
  for (const [key, value] of pendingAuths) {
    if (value.expiresAt <= Date.now()) pendingAuths.delete(key);
  }
  pendingAuths.set(entry.state, entry);
}

/** Single-use: read once, by the callback, then gone - a replayed callback
 * with the same `state` finds nothing, the same way a replayed session
 * cookie finds nothing once `destroySession` has run. */
function takePending(state: string): PendingEntry | undefined {
  const entry = pendingAuths.get(state);
  if (!entry) return undefined;
  pendingAuths.delete(state);
  if (entry.expiresAt <= Date.now()) return undefined;
  return entry;
}

/**
 * Binds a login to the browser that started it. `pendingAuths` is keyed by
 * `state` alone, so without this an attacker could start a login, capture the
 * callback URL and get a victim to load it, planting the attacker's session
 * in the victim's browser. `lax`, not `strict`: the callback arrives as a
 * cross-site top-level navigation from the provider.
 */
const OAUTH_COOKIE_NAME = '__Host-mtr_oauth';
const oauthCookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' } as const;

function stateMatchesCookie(cookie: string | undefined, state: string | undefined): boolean {
  if (!cookie || !state) return false;
  const a = Buffer.from(cookie);
  const b = Buffer.from(state);
  return a.length === b.length && timingSafeEqual(a, b);
}

function redirectUriFor(provider: string): string {
  return `${config.publicBaseUrl}/auth/${provider}/callback`;
}

export async function startAuth(req: Request, res: Response): Promise<void> {
  const provider = getProvider(req.params.provider ?? '');
  if (!provider) {
    throw new NotFoundError('Unknown authentication provider.');
  }

  const redirectUri = redirectUriFor(provider.name);
  const { url, pending } = await provider.start(redirectUri);
  rememberPending({
    ...pending,
    provider: provider.name,
    redirectUri,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });
  res.cookie(OAUTH_COOKIE_NAME, pending.state, { ...oauthCookieOptions, maxAge: PENDING_TTL_MS });
  res.redirect(url.href);
}

/**
 * Accounts keyed on `(provider, provider_subject)`, never on email (see
 * `packages/db/migrations/0002_accounts.sql`). A second sign-in with the
 * same provider subject but a changed email reuses the existing user and
 * just refreshes the identity's own cached `email` column; a first sign-in
 * for that `(provider, provider_subject)` pair creates both rows.
 */
async function findOrCreateUser(profile: {
  provider: string;
  providerSubject: string;
  email: string;
}): Promise<string> {
  const pool = getPool();

  const existing = await pool.query<{ user_id: string }>(
    'SELECT user_id FROM identities WHERE provider = $1 AND provider_subject = $2',
    [profile.provider, profile.providerSubject],
  );
  const existingRow = existing.rows[0];
  if (existingRow) {
    // Both the identity's own cached email AND the user's profile email track
    // the provider's current value - a user who changed their email at the
    // provider sees that reflected the next time they sign in, without this
    // provider being able to move them to a different `users` row (that is
    // what keying on `provider_subject` rather than email already prevents).
    await pool.query(
      'UPDATE identities SET email = $1 WHERE provider = $2 AND provider_subject = $3',
      [profile.email, profile.provider, profile.providerSubject],
    );
    await pool.query('UPDATE users SET email = $1 WHERE id = $2', [
      profile.email,
      existingRow.user_id,
    ]);
    return existingRow.user_id;
  }

  const userRow = await pool.query<{ id: string }>(
    'INSERT INTO users (email) VALUES ($1) RETURNING id',
    [profile.email],
  );
  const userId = userRow.rows[0]!.id;
  await pool.query(
    'INSERT INTO identities (user_id, provider, provider_subject, email) VALUES ($1, $2, $3, $4)',
    [userId, profile.provider, profile.providerSubject, profile.email],
  );
  return userId;
}

export async function authCallback(req: Request, res: Response): Promise<void> {
  const providerName = req.params.provider ?? '';
  const provider = getProvider(providerName);
  if (!provider) {
    throw new NotFoundError('Unknown authentication provider.');
  }

  // Cleared on every path, success or failure: the cookie is single-use.
  const oauthCookie = readCookie(req, OAUTH_COOKIE_NAME);
  res.clearCookie(OAUTH_COOKIE_NAME, oauthCookieOptions);

  const state = typeof req.query.state === 'string' ? req.query.state : undefined;
  // Checked before takePending so a foreign callback cannot burn the victim's
  // own pending entry either.
  const pending = state && stateMatchesCookie(oauthCookie, state) ? takePending(state) : undefined;
  if (!pending || pending.provider !== providerName) {
    throw new UnauthorizedError('OAuth state mismatch.');
  }

  const callbackUrl = new URL(req.originalUrl, config.publicBaseUrl);
  const profile = await provider.complete(callbackUrl, pending, pending.redirectUri);
  const userId = await findOrCreateUser(profile);

  const session = await createSession(userId);
  setSessionCookie(res, session.id, session.expiresAt);
  res.redirect(`${config.publicBaseUrl}/`);
}

export async function logout(req: Request, res: Response): Promise<void> {
  if (req.sessionId) {
    await destroySession(req.sessionId);
  }
  clearSessionCookie(res);
  res.status(204).end();
}

export async function me(req: Request, res: Response): Promise<void> {
  const { rows } = await getPool().query<{ id: string; email: string }>(
    'SELECT id, email FROM users WHERE id = $1',
    [req.userId],
  );
  const row = rows[0];
  if (!row) {
    throw new UnauthorizedError('A valid session is required.');
  }
  res.status(200).json({ id: row.id, email: row.email });
}
