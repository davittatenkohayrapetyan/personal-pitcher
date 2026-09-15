import crypto from 'crypto';
import { logger } from '../logger';

/**
 * Authentication for the hidden `/login` → `/admin` review UI.
 *
 * ## What this is guarding
 *
 * Write access to `data/` — the content every answer on the public site is
 * generated from. Someone who gets through here does not deface a page; they
 * change what DAVO tells recruiters about Davit, quietly, with no visual tell.
 * That is the reason this file does more than compare two strings.
 *
 * ## What it does
 *
 * - The password lives in `ADMIN_PASSWORD`, never in source. Changing it is an
 *   env edit and a restart, not a commit and a rebuild — which matters, because
 *   a password in git history cannot be un-published.
 * - Comparison is constant-time over SHA-256 digests. Hashing first is what
 *   makes `timingSafeEqual` usable at all: it requires equal-length buffers, and
 *   the naive length check leaks the password's length.
 * - The session is a signed, httpOnly, SameSite=Strict cookie carrying only an
 *   expiry. There is no server-side session table, so nothing to leak — but it
 *   also means a cookie cannot be revoked before it expires. Restarting the
 *   process with no `ADMIN_SESSION_SECRET` set rotates the key and invalidates
 *   every session, which is the available blunt instrument.
 * - Failed attempts are rate-limited per IP, separately and far more tightly
 *   than `/api/ask`. A single shared limiter would let ordinary question traffic
 *   consume the budget that is supposed to stop password guessing.
 *
 * ## What it is not
 *
 * One password, no second factor, no account. It is proportionate to a personal
 * site with one administrator, and it is the weakest link in this feature by
 * some distance — the password's strength is the whole of its security.
 */

const COOKIE_NAME = 'pp_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Deliberately tight: this is a password field, not a page anyone browses. */
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

const attempts = new Map<string, { count: number; resetAt: number }>();

/**
 * Signing key. Falls back to a per-process random value so a misconfigured
 * deployment fails *closed on restart* (every session invalidated) rather than
 * open (every deployment sharing a guessable default key).
 */
let cachedSecret: string | null = null;

function sessionSecret(): string {
  const configured = process.env.ADMIN_SESSION_SECRET?.trim();
  if (configured) return configured;

  if (!cachedSecret) {
    cachedSecret = crypto.randomBytes(32).toString('hex');
    logger.warn('admin_session_secret_ephemeral', {
      detail: 'ADMIN_SESSION_SECRET is not set; sessions will not survive a restart',
    });
  }
  return cachedSecret;
}

export function isAdminConfigured(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD?.trim());
}

function digest(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time password check. See the header for why it hashes first. */
export function verifyPassword(candidate: string): boolean {
  const expected = process.env.ADMIN_PASSWORD?.trim();
  if (!expected) return false;
  return crypto.timingSafeEqual(digest(candidate), digest(expected));
}

// ─── Attempt throttling ──────────────────────────────────────────────────────

export function checkLoginAttempts(ip: string): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const record = attempts.get(ip);

  if (!record || now >= record.resetAt) {
    attempts.set(ip, { count: 0, resetAt: now + ATTEMPT_WINDOW_MS });
    return { allowed: true, retryAfterMs: 0 };
  }

  if (record.count >= MAX_ATTEMPTS) {
    return { allowed: false, retryAfterMs: record.resetAt - now };
  }

  return { allowed: true, retryAfterMs: 0 };
}

export function noteFailedLogin(ip: string): void {
  const now = Date.now();
  const record = attempts.get(ip) ?? { count: 0, resetAt: now + ATTEMPT_WINDOW_MS };
  record.count += 1;
  attempts.set(ip, record);
}

/** A correct password clears the budget, so one typo doesn't linger for 15 minutes. */
export function clearLoginAttempts(ip: string): void {
  attempts.delete(ip);
}

// ─── Session cookie ──────────────────────────────────────────────────────────

function sign(payload: string): string {
  return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('hex');
}

export function createSessionValue(): string {
  const expiresAt = String(Date.now() + SESSION_TTL_MS);
  return `${expiresAt}.${sign(expiresAt)}`;
}

export function isValidSessionValue(value: string | undefined): boolean {
  if (!value) return false;

  const [expiresAt, signature] = value.split('.');
  if (!expiresAt || !signature) return false;

  const expected = sign(expiresAt);
  // Compared in constant time like the password: a forgery oracle here is worth
  // exactly as much to an attacker as the password itself.
  if (
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expected, 'utf8'))
  ) {
    return false;
  }

  const expiry = Number(expiresAt);
  return Number.isFinite(expiry) && Date.now() < expiry;
}

export const ADMIN_COOKIE = COOKIE_NAME;

export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    // Not forced on in development, where the site is served over plain HTTP and
    // a Secure cookie would simply never be stored.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

export const SESSION_MAX_AGE_SECONDS = SESSION_TTL_MS / 1000;
