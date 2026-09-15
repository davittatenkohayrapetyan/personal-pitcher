/**
 * Per-IP cap on total on-topic questions — the actual cost guardrail.
 *
 * `rateLimit.ts` stops a burst (10/min); this stops sustained use across a
 * whole day. Both are IP-keyed for the same reason: it's the only trust
 * boundary this app has without login, and it's the boundary the rate limiter
 * already relies on, so this doesn't introduce a new one.
 *
 * Off-topic questions never reach `consumeQuota` — they're short-circuited in
 * the route before any LLM generation call, so they stay free. Only questions
 * that actually cost a generation call count against the budget.
 *
 * Same in-memory, process-local, TTL-swept shape as `rateLimit.ts` — resets on
 * restart, not shared across instances. Acceptable for a single-instance
 * deployment; documented here so it isn't mistaken for a durable ledger.
 */

interface QuotaEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, QuotaEntry>();

const MAX_QUESTIONS = parseInt(process.env.QUESTION_QUOTA_MAX || '3', 10);
const WINDOW_MS = parseInt(process.env.QUESTION_QUOTA_WINDOW_MS || String(24 * 60 * 60 * 1000), 10); // 24h

export interface QuotaResult {
  /** False once the visitor is over budget — caller must not generate. */
  allowed: boolean;
  /** True on the last question the budget allows — caller should append the
   *  LinkedIn CTA to this (and only this) answer. */
  isFinal: boolean;
  count: number;
  max: number;
  resetAt: number;
}

/**
 * Consumes one unit of quota for `ip` and reports the resulting state.
 *
 * Only mutates on the allowed path. A blocked visitor hammering the endpoint
 * does not slide `resetAt` further out — that would make the window reset
 * *later* the more someone abuses it, which rewards exactly the wrong
 * behaviour. The window only ever starts on first use.
 */
export function consumeQuota(ip: string): QuotaResult {
  const now = Date.now();
  const entry = store.get(ip);

  if (!entry || now > entry.resetAt) {
    const resetAt = now + WINDOW_MS;
    store.set(ip, { count: 1, resetAt });
    return { allowed: true, isFinal: MAX_QUESTIONS === 1, count: 1, max: MAX_QUESTIONS, resetAt };
  }

  if (entry.count >= MAX_QUESTIONS) {
    return { allowed: false, isFinal: false, count: entry.count, max: MAX_QUESTIONS, resetAt: entry.resetAt };
  }

  entry.count += 1;
  return {
    allowed: true,
    isFinal: entry.count === MAX_QUESTIONS,
    count: entry.count,
    max: MAX_QUESTIONS,
    resetAt: entry.resetAt,
  };
}

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function startCleanup(): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of store.entries()) {
      if (now > value.resetAt) {
        store.delete(key);
      }
    }
  }, WINDOW_MS);
}

export function stopCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

if (typeof setInterval !== 'undefined') {
  startCleanup();
}
