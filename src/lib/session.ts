/**
 * In-memory conversation memory for `/api/ask`.
 *
 * This exists purely so a follow-up question ("what about his PhD?") can
 * resolve against what was just asked — it is LLM context, not chat history
 * storage. The browser already keeps the full visible transcript in React
 * state; this only needs to remember enough to disambiguate the next prompt,
 * so it keeps the last few turns and nothing more.
 *
 * `sessionId` is a client-generated UUID (see `AssistantPanel.tsx`), sent
 * back on every request and stored in `sessionStorage` so it clears on tab
 * close. It is a UX convenience only, never a trust boundary: each entry is
 * bound to the IP that created it, and a `sessionId` replayed from a
 * different IP is treated as unknown rather than trusted. The actual security
 * boundary — the question quota in `questionQuota.ts` — is keyed by IP, same
 * as the rate limiter, so guessing or rotating a `sessionId` cannot extend a
 * visitor's question budget.
 *
 * Same shape and same limitation as `rateLimit.ts` and `circuitBreaker.ts`:
 * process-local, resets on restart, not shared across instances.
 */

export interface Turn {
  question: string;
  /** Raw model answer, without any appended CTA — see `questionQuota.ts`. */
  answer: string;
  intent?: string;
}

interface SessionEntry {
  ip: string;
  turns: Turn[];
  expiresAt: number;
}

const store = new Map<string, SessionEntry>();

const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || String(30 * 60 * 1000), 10); // 30 min
const MAX_TURNS_KEPT = 3;

/**
 * Returns the recent turns for this session, oldest first — or an empty array
 * if there is no session, it expired, or it was created from a different IP.
 */
export function getSessionTurns(sessionId: string | undefined, ip: string): Turn[] {
  if (!sessionId) return [];

  const entry = store.get(sessionId);
  if (!entry) return [];

  if (Date.now() > entry.expiresAt) {
    store.delete(sessionId);
    return [];
  }

  if (entry.ip !== ip) {
    // Not necessarily malicious — could just be a proxy/IP change — but this
    // module makes no attempt to merge histories across an IP change. Treat
    // it as a fresh conversation rather than trusting an unverified pairing.
    return [];
  }

  return entry.turns;
}

/** Records a completed turn, creating the session if it doesn't exist yet. */
export function appendTurn(sessionId: string | undefined, ip: string, turn: Turn): void {
  if (!sessionId) return;

  const existing = store.get(sessionId);
  const turns = existing && existing.ip === ip ? existing.turns : [];

  turns.push(turn);
  while (turns.length > MAX_TURNS_KEPT) {
    turns.shift();
  }

  store.set(sessionId, { ip, turns, expiresAt: Date.now() + SESSION_TTL_MS });
}

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function startCleanup(): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of store.entries()) {
      if (now > value.expiresAt) {
        store.delete(key);
      }
    }
  }, SESSION_TTL_MS);
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
