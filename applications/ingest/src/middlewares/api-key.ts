import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { getPool } from '../lib/db.js';
import { UnauthorizedError } from './error.js';

const BEARER_PREFIX = 'Bearer ';
/** `mtr_<prefix>_<secret>`. The secret half may itself contain `_`, so only the first two segments are fixed. */
const KEY_PATTERN = /^mtr_([^_]+)_(.+)$/;

/** What a request carries once `requireApiKey` has resolved it. */
export interface ApiKeyContext {
  /** The ONLY source of tenancy for a write - never anything from the body. See ADR 0005. */
  readonly projectId: string;
  readonly defaultResource: string | null;
  /**
   * Set when this key is bound to one application (`api_keys.application_id`,
   * `packages/db/migrations/0006_applications.sql`) - that application's own
   * `key` column, which every point in the request must be written under,
   * ignoring whatever `resource` the body names. Null for a project-wide key,
   * today's behaviour, unchanged.
   */
  readonly applicationResource: string | null;
  /** Non-secret, stable per key - the rate limiter's bucket key, never the secret itself. */
  readonly rateLimitKey: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiKeyContext?: ApiKeyContext;
    }
  }
}

function parsePresentedKey(req: Request): { prefix: string; secret: string } | null {
  const header = req.header('authorization');
  if (!header || !header.startsWith(BEARER_PREFIX)) return null;
  const token = header.slice(BEARER_PREFIX.length).trim();
  const match = KEY_PATTERN.exec(token);
  if (!match) return null;
  const [, prefix, secret] = match;
  return prefix && secret ? { prefix, secret } : null;
}

/**
 * Constant-time secret check against a stored hash.
 *
 * Same reasoning as the viewer's old `tokenMatches`: comparing fixed-length
 * SHA-256 digests, rather than the raw values, sidesteps both the `===`
 * short-circuit (which leaks a shared-prefix length through response timing)
 * and `timingSafeEqual`'s throw on unequal-length buffers. The length check
 * below only guards against a corrupt `key_hash` row, not an adversarial
 * input - the digest is always exactly 32 bytes by construction.
 */
function secretMatchesHash(secret: string, storedHash: Buffer): boolean {
  const digest = createHash('sha256').update(secret, 'utf8').digest();
  if (digest.length !== storedHash.length) return false;
  return timingSafeEqual(digest, storedHash);
}

interface ApiKeyRow {
  project_id: string;
  key_hash: Buffer;
  revoked_at: Date | null;
  default_resource: string | null;
  application_resource: string | null;
}

/**
 * Guards the ingest write path. `key_prefix` is an indexed, non-secret
 * lookup column (`packages/db/migrations/0002_accounts.sql`); the secret
 * half never touches an index or a log, only a constant-time compare against
 * `key_hash`. An unknown prefix, a revoked key and a wrong secret all answer
 * the same 401 - no branch tells a caller which of the three it hit.
 */
export async function requireApiKey(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const presented = parsePresentedKey(req);
  if (!presented) {
    next(new UnauthorizedError('A valid API key is required.'));
    return;
  }

  const { rows } = await getPool().query<ApiKeyRow>(
    `SELECT ak.project_id, ak.key_hash, ak.revoked_at, p.default_resource, a.key AS application_resource
       FROM api_keys ak
       JOIN projects p ON p.id = ak.project_id
       LEFT JOIN applications a ON a.id = ak.application_id
      WHERE ak.key_prefix = $1`,
    [presented.prefix],
  );
  const row = rows[0];

  if (!row || row.revoked_at !== null || !secretMatchesHash(presented.secret, row.key_hash)) {
    next(new UnauthorizedError('A valid API key is required.'));
    return;
  }

  req.apiKeyContext = {
    projectId: row.project_id,
    defaultResource: row.default_resource,
    applicationResource: row.application_resource,
    rateLimitKey: createHash('sha256').update(presented.secret, 'utf8').digest('hex'),
  };

  // Best-effort bookkeeping - a failed update must not fail a request that
  // already authenticated successfully.
  getPool()
    .query('UPDATE api_keys SET last_used_at = now() WHERE key_prefix = $1', [presented.prefix])
    .catch(() => {});

  next();
}
