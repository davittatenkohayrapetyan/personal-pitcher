/**
 * Process-local circuit breakers for the LLM providers.
 *
 * States:
 *   closed    – Normal operation. Failures are counted.
 *   open      – Calls to the guarded provider are skipped; requests go straight
 *               to the next tier. After the cooldown the breaker transitions to
 *               half_open.
 *   half_open – A limited number of probe requests are allowed through. On
 *               success the breaker closes; on failure it re-opens.
 *
 * There is one breaker *per tier*, created by `createCircuitBreaker` below, so
 * that a failing tier only disables itself:
 *
 *   macBreaker    – guards the tier-0 Mac Ollama box (see `macOllama.ts`).
 *   openaiBreaker – guards OpenAI. The bare `allowRequest`/`onSuccess`/
 *                   `onFailure`/`getState` exports are bound to this one, which
 *                   is why existing OpenAI call sites need no changes.
 *
 * Keeping them separate is the whole point of the tier-0 addition: the Mac is
 * expected to be unreachable a lot of the time (laptop closed, off the home
 * network), and that must not count toward disabling OpenAI.
 *
 * Note: state is per-process. In a multi-instance deployment each instance
 * maintains its own breakers independently.
 */

import { sendAlert } from '../pushover';

export type BreakerState = 'closed' | 'open' | 'half_open';

interface BreakerData {
  current: BreakerState;
  failures: number;
  openedAt: number | null;
  halfOpenProbes: number;
}

export interface BreakerDefaults {
  /** Consecutive transient failures before opening. */
  threshold: number;
  /** Milliseconds to wait in `open` before probing again. */
  cooldownMs: number;
  /** Probes allowed while `half_open`. */
  probeCount: number;
}

export interface CircuitBreaker {
  /** True if the caller may attempt a request against the guarded provider. */
  allowRequest(): boolean;
  /** Request succeeded — reset the failure count and close the breaker. */
  onSuccess(): void;
  /** Transient failure — may open or re-open the breaker. */
  onFailure(): void;
  /** Current state, for health checks and observability. */
  getState(): BreakerState;
}

function readInt(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Builds an independent breaker.
 *
 * `name` appears in the transition log line. `envPrefix` selects the env vars
 * that tune it: `<PREFIX>FAILURE_THRESHOLD`, `<PREFIX>COOLDOWN_MS` and
 * `<PREFIX>PROBE_COUNT`. Config is read per call, not captured at construction,
 * so the values stay overridable at runtime exactly as they were before.
 */
export function createCircuitBreaker(
  name: string,
  envPrefix: string,
  defaults: BreakerDefaults,
  onTransition?: (from: BreakerState, to: BreakerState) => void,
): CircuitBreaker {
  const breaker: BreakerData = {
    current: 'closed',
    failures: 0,
    openedAt: null,
    halfOpenProbes: 0,
  };

  const config = () => ({
    threshold: readInt(`${envPrefix}FAILURE_THRESHOLD`, defaults.threshold),
    cooldownMs: readInt(`${envPrefix}COOLDOWN_MS`, defaults.cooldownMs),
    probeCount: readInt(`${envPrefix}PROBE_COUNT`, defaults.probeCount),
  });

  const transition = (to: BreakerState): void => {
    if (breaker.current !== to) {
      const from = breaker.current;
      console.log(
        JSON.stringify({
          event: 'circuit_breaker_transition',
          breaker: name,
          from,
          to,
          failures: breaker.failures,
          ts: new Date().toISOString(),
        }),
      );
      breaker.current = to;
      // Listener failures must never propagate into the request path — a
      // broken notifier is not a reason to fail the call it was reporting on.
      try {
        onTransition?.(from, to);
      } catch {
        /* ignore */
      }
    }
  };

  return {
    allowRequest(): boolean {
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
    },

    onSuccess(): void {
      breaker.failures = 0;
      breaker.halfOpenProbes = 0;
      breaker.openedAt = null;
      transition('closed');
    },

    onFailure(): void {
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
    },

    getState(): BreakerState {
      return breaker.current;
    },
  };
}

/**
 * Turns a breaker transition into a push notification — but only for the two
 * transitions that carry news.
 *
 * `closed → open` is a tier going down for the first time. `* → closed` is it
 * coming back. Everything else is noise: in particular `half_open → open` fires
 * on *every* probe cycle for as long as a tier stays down, which for the Mac
 * breaker means once every MAC_CB_COOLDOWN_MS for the whole time that machine
 * is away. Alerting on it would push a notification every five minutes until
 * Davit came home.
 */
function breakerAlerts(label: string, priority: 0 | 1) {
  return (from: BreakerState, to: BreakerState): void => {
    if (to === 'open' && from === 'closed') {
      sendAlert({
        kind: `breaker_open_${label}`,
        title: `Ask Davit • ${label} tier down`,
        message: `The ${label} circuit breaker just opened. Requests are falling through to the next tier.`,
        priority,
      });
      return;
    }

    if (to === 'closed' && from !== 'closed') {
      sendAlert({
        kind: `breaker_closed_${label}`,
        title: `Ask Davit • ${label} tier recovered`,
        message: `The ${label} circuit breaker closed again. That tier is serving requests.`,
        priority: 0,
      });
    }
  };
}

/** Guards OpenAI (tier 1). Tuned by `CB_*`. */
export const openaiBreaker = createCircuitBreaker(
  'openai',
  'CB_',
  {
    threshold: 5,
    cooldownMs: 60_000,
    probeCount: 1,
  },
  // OpenAI going down is the one that costs money and quality — it means the
  // site is running on whatever local model is left.
  breakerAlerts('openai', 1),
);

/**
 * Guards the Mac Ollama box (tier 0). Tuned by `MAC_CB_*`.
 *
 * Deliberately twitchier than the OpenAI breaker: a laptop that is asleep or on
 * another network will never recover within one request, so there is no value in
 * retrying it five times before giving up. It also cools down for much longer,
 * because "Davit took his Mac to the office" is measured in hours, not the 60s
 * an OpenAI blip lasts.
 */
export const macBreaker = createCircuitBreaker(
  'mac_ollama',
  'MAC_CB_',
  {
    threshold: 2,
    cooldownMs: 300_000,
    probeCount: 1,
  },
  // Low priority: a laptop leaving the house is expected, and the site is fine
  // without it. Worth knowing, not worth a siren.
  breakerAlerts('mac', 0),
);

// Bare exports remain bound to the OpenAI breaker so existing call sites
// (orchestrator.ts, classify.ts) keep their current meaning.
export const allowRequest = (): boolean => openaiBreaker.allowRequest();
export const onSuccess = (): void => openaiBreaker.onSuccess();
export const onFailure = (): void => openaiBreaker.onFailure();
export const getState = (): BreakerState => openaiBreaker.getState();
