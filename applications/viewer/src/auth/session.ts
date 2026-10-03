import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../config/index.js';
import { getPool } from '../lib/db.js';

/**
 * Sessions: an opaque random id in an `HttpOnly; Secure; SameSite=Lax`
 * cookie, with the row of record in the `sessions` table - no JWT. The id
 * itself is a `gen_random_uuid()` (122 bits of randomness), which is already
 * unguessable; the HMAC below is a cheap early reject for a tampered or
 * truncated cookie value, not what makes the session secure.
 */

/** `__Host-`: browsers refuse a Set-Cookie for this name that carries a Domain
 * or a non-`/` path, which blocks cookie-tossing from a sibling Container App
 * (azurecontainerapps.io is not in the public suffix list). Renaming from
 * `mtr_session` signed everyone out once. */
export const SESSION_COOKIE_NAME = '__Host-mtr_session';

/** 3 days, absolute (no sliding refresh). Shortened from 30 days: a login
 * cookie that outlives a weekend is hard to call strictly necessary under
 * § 165 Abs 3 TKG 2021. This one value sets both the `sessions.expires_at` row
 * and the cookie's `expires`, so the server never honours a cookie the browser
 * would have dropped, or the reverse. `POST /auth/logout` revokes earlier. */
export const SESSION_TTL_MS = 3 * 24 * 60 * 60 * 1000;

function sign(sessionId: string): string {
  return createHmac('sha256', config.sessionSecret).update(sessionId).digest('base64url');
}

function encodeCookie(sessionId: string): string {
  return `${sessionId}.${sign(sessionId)}`;
}

/** Returns the session id if the signature matches, `null` otherwise -
 * never throws on a malformed cookie, since a malformed cookie is exactly as
 * unauthenticated as no cookie at all. */
function decodeCookie(raw: string): string | null {
  const separator = raw.lastIndexOf('.');
  if (separator < 0) return null;
  const sessionId = raw.slice(0, separator);
  const signature = Buffer.from(raw.slice(separator + 1));
  const expected = Buffer.from(sign(sessionId));
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
    return null;
  }
  return sessionId;
}

/**
 * One header, flat `name=value; name2=value2` pairs - the same "stdlib
 * already covers it" reasoning that kept `qs` off the query parser in
 * `main.ts`. No `cookie-parser` dependency: reading is this five-line loop,
 * and writing already goes through Express's own built-in `res.cookie`.
 */
function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0) continue;
    const name = pair.slice(0, separator).trim();
    if (!name) continue;
    cookies[name] = decodeURIComponent(pair.slice(separator + 1).trim());
  }
  return cookies;
}

export function readCookie(req: Request, name: string): string | undefined {
  return parseCookieHeader(req.headers.cookie)[name];
}

/** `null` covers both "no cookie" and "cookie present but invalid" -
 * `middlewares/require-session.ts` treats them identically. */
export function readSessionCookie(req: Request): string | null {
  const raw = parseCookieHeader(req.headers.cookie)[SESSION_COOKIE_NAME];
  return raw ? decodeCookie(raw) : null;
}

export function setSessionCookie(res: Response, sessionId: string, expiresAt: Date): void {
  res.cookie(SESSION_COOKIE_NAME, encodeCookie(sessionId), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    expires: expiresAt,
    path: '/',
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
  });
}

export async function createSession(userId: string): Promise<{ id: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const { rows } = await getPool().query<{ id: string }>(
    'INSERT INTO sessions (user_id, expires_at) VALUES ($1, $2) RETURNING id',
    [userId, expiresAt],
  );
  return { id: rows[0]!.id, expiresAt };
}

/** `null` for an unknown, expired, or already-logged-out session id - a
 * replayed cookie after `destroySession` resolves here to `null`, same as
 * one that never existed, which is what makes `POST /auth/logout` followed
 * by a replay of the old cookie answer 401 rather than 200. */
export async function resolveSessionUserId(sessionId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ user_id: string; expires_at: Date }>(
    'SELECT user_id, expires_at FROM sessions WHERE id = $1',
    [sessionId],
  );
  const row = rows[0];
  if (!row || row.expires_at.getTime() <= Date.now()) return null;
  return row.user_id;
}

export async function destroySession(sessionId: string): Promise<void> {
  await getPool().query('DELETE FROM sessions WHERE id = $1', [sessionId]);
}
