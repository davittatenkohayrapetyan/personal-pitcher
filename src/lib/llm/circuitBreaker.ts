/**
 * Process-local circuit breaker for the OpenAI provider.
 *
 * States:
 *   closed    – Normal operation. Failures are counted.
 *   open      – OpenAI calls are skipped; requests go straight to Ollama.
 *               After CB_COOLDOWN_MS the breaker transitions to half_open.
 *   half_open – A limited number of probe requests (CB_PROBE_COUNT) are
 *               allowed through to OpenAI. On success the breaker closes;
 *               on failure it re-opens.
 *
 * Configuration via environment variables (all optional):
 *   CB_FAILURE_THRESHOLD  – consecutive transient failures before opening  (default: 5)
 *   CB_COOLDOWN_MS        – milliseconds to wait before probing             (default: 60000)
 *   CB_PROBE_COUNT        – probes allowed while half_open before closing   (default: 1)
 *
 * Note: state is per-process. In a multi-instance deployment each instance
 * maintains its own breaker independently.
 */

export type BreakerState = 'closed' | 'open' | 'half_open';

interface BreakerData {
  current: BreakerState;
  failures: number;
  openedAt: number | null;
  halfOpenProbes: number;
}

const breaker: BreakerData = {
  current: 'closed',
  failures: 0,
  openedAt: null,
  halfOpenProbes: 0,
};

function config() {
  return {
    threshold: parseInt(process.env.CB_FAILURE_THRESHOLD ?? '5', 10),
    cooldownMs: parseInt(process.env.CB_COOLDOWN_MS ?? '60000', 10),
    probeCount: parseInt(process.env.CB_PROBE_COUNT ?? '1', 10),
  };
}

function transition(to: BreakerState): void {
  if (breaker.current !== to) {
    console.log(
      JSON.stringify({
        event: 'circuit_breaker_transition',
        from: breaker.current,
        to,
        failures: breaker.failures,
        ts: new Date().toISOString(),
      }),
    );
    breaker.current = to;
  }
}

/**
 * Returns true if the caller is allowed to attempt an OpenAI request right now.
 * When transitioning from open → half_open this function also increments the
 * probe counter so concurrent callers do not each get a free probe.
 */
export function allowRequest(): boolean {
  const cfg = config();

  if (breaker.current === 'closed') return true;

  if (breaker.current === 'open') {
    if (breaker.openedAt !== null && Date.now() - breaker.openedAt >= cfg.cooldownMs) {
      // Set to 1 directly (not reset-then-increment) so that concurrent callers
      // that also reach this branch don't each get a free probe slot.
      breaker.halfOpenProbes = 1;
      transition('half_open');
      return true;
    }
    return false;
  }

  // half_open: allow up to probeCount probes
  if (breaker.halfOpenProbes < cfg.probeCount) {
    breaker.halfOpenProbes += 1;
    return true;
  }
  return false;
}

/** Call when an OpenAI request succeeds. Resets failure count and closes the breaker. */
export function onSuccess(): void {
  breaker.failures = 0;
  breaker.halfOpenProbes = 0;
  breaker.openedAt = null;
  transition('closed');
}

/** Call when a transient OpenAI failure occurs. May open or re-open the breaker. */
export function onFailure(): void {
  const cfg = config();

  if (breaker.current === 'half_open') {
    breaker.openedAt = Date.now();
    breaker.halfOpenProbes = 0;
    transition('open');
    return;
  }

  if (breaker.current === 'closed') {
    breaker.failures += 1;
    if (breaker.failures >= cfg.threshold) {
      breaker.openedAt = Date.now();
      transition('open');
    }
  }
}

/** Returns the current breaker state (useful for health checks / observability). */
export function getState(): BreakerState {
  return breaker.current;
}
