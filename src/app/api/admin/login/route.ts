import { NextResponse } from 'next/server';
import {
  ADMIN_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  checkLoginAttempts,
  clearLoginAttempts,
  createSessionValue,
  isAdminConfigured,
  noteFailedLogin,
  sessionCookieOptions,
  verifyPassword,
} from '@/lib/admin/auth';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown';
}

export async function POST(request: Request) {
  const ip = clientIp(request);

  // Checked before parsing the body, so a flood of attempts costs nothing.
  const throttle = checkLoginAttempts(ip);
  if (!throttle.allowed) {
    logger.warn('admin_login_throttled', { ip, retryAfterMs: throttle.retryAfterMs });
    return NextResponse.json(
      { error: 'Too many attempts. Try again later.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(throttle.retryAfterMs / 1000)) } },
    );
  }

  if (!isAdminConfigured()) {
    // Deliberately not reported to the client as "not configured": whether an
    // admin exists is not something an unauthenticated caller needs to learn.
    logger.error('admin_login_unconfigured', { ip });
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
  }

  let password: unknown;
  try {
    password = (await request.json())?.password;
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  if (typeof password !== 'string' || !password) {
    noteFailedLogin(ip);
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
  }

  if (!verifyPassword(password)) {
    noteFailedLogin(ip);
    logger.warn('admin_login_failed', { ip });
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
  }

  clearLoginAttempts(ip);
  logger.info('admin_login_success', { ip });

  const response = NextResponse.json({ ok: true });
  response.cookies.set(ADMIN_COOKIE, createSessionValue(), sessionCookieOptions(SESSION_MAX_AGE_SECONDS));
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(ADMIN_COOKIE, '', sessionCookieOptions(0));
  return response;
}
