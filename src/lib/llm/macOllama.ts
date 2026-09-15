import { OllamaProvider, type OllamaOptions } from './ollama';
import { macBreaker } from './circuitBreaker';

/**
 * Tier 0 of the fallback chain: a local model (gemma4:26b by default)
 * running on Davit's Mac on the home LAN.
 *
 * The point of this tier is that when the Mac *is* home, answers come from a
 * 26B model on hardware that costs nothing per token, and OpenAI is never
 * billed. The catch is that a laptop is not a server: it sleeps, it leaves the
 * house, it joins other networks. So this tier is built around the assumption
 * that it is *routinely absent*, and absence must be cheap:
 *
 *   1. It is opt-in. No MAC_OLLAMA_BASE_URL, no tier — the chain is exactly
 *      what it was before.
 *   2. Every attempt is gated behind a short reachability probe, because an
 *      absent host stalls a plain fetch for ~20s (see `OllamaProvider.isReachable`).
 *   3. Its own circuit breaker (`macBreaker`) stops even the probe once the Mac
 *      has proven absent, for MAC_CB_COOLDOWN_MS.
 *
 * A failure here is never surfaced to the visitor: it just means OpenAI answers,
 * which is what would have happened anyway before this tier existed.
 */

const DEFAULT_MODEL = 'gemma4:26b';
const DEFAULT_PROBE_TIMEOUT_MS = 1_500;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
/**
 * Sent to Ollama as `keep_alive` on every tier-0 request. `-1` holds the model
 * in memory indefinitely, which is the point: a cold load of an 18GB model is
 * tens of seconds, and on a low-traffic personal site nearly every visitor
 * would otherwise pay it. Accepts Ollama's forms — `-1`, `0`, `"30m"`, `"2h"`,
 * or a bare number of seconds.
 *
 * The cost is unified memory held permanently, not power: a resident-but-idle
 * model uses no GPU. Set `MAC_OLLAMA_KEEP_ALIVE=2h` if that RAM is needed back.
 */
const DEFAULT_KEEP_ALIVE = '-1';

/**
 * Ceiling on how long a single success may imply warmth.
 *
 * With `keep_alive=-1` the model is *asked* to stay forever, but a reboot, a
 * manual `ollama stop`, or memory pressure unloads it anyway — and none of
 * those tell us. Without a cap, one success would make `isMacLikelyWarm()`
 * answer true for the life of the process and the chat would promise "already
 * loaded" through a genuine cold start.
 */
const WARM_INFERENCE_CAP_MS = 12 * 60 * 60 * 1000;

/**
 * When the Mac last answered successfully — the basis for guessing whether its
 * model is still resident.
 *
 * Ollama evicts an idle model after roughly KEEP_ALIVE, so a success inside
 * that window means the next request almost certainly skips the load. This is
 * inferred rather than measured on purpose: asking the Mac `/api/ps` on every
 * page poll would add LAN chatter, and on a sleeping laptop it is exactly the
 * kind of traffic that wakes it up just to answer "are you awake".
 *
 * It is a heuristic. The model can be evicted early under memory pressure, so
 * treat `true` as "probably warm", never as a promise.
 */
let lastMacSuccessAt: number | null = null;

/**
 * The value handed to Ollama as `keep_alive`.
 *
 * Numbers must be sent as JSON numbers, not strings: Ollama parses a *string*
 * `keep_alive` as a Go duration, so `"-1"` fails with
 * `time: missing unit in duration "-1"` and the whole request 400s — which
 * silently knocks out tier 0 on every call. Bare digits become numbers (seconds,
 * or -1 for never); anything carrying a unit (`"30m"`, `"2h"`) stays a string.
 */
export function getKeepAlive(): string | number {
  const raw = (process.env.MAC_OLLAMA_KEEP_ALIVE || DEFAULT_KEEP_ALIVE).trim();
  return /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
}

/**
 * Interprets `keep_alive` as milliseconds, for the warm heuristic only.
 *
 * Parsed from the same value we send Ollama so the two can never disagree —
 * previously these were two separate env vars and nothing stopped them drifting
 * apart. Unrecognised input falls back to the cap rather than to zero: guessing
 * "warm" and being wrong costs a slightly off phrase, guessing "cold" and being
 * wrong tells every visitor the model is loading when it is not.
 */
function keepAliveMs(): number {
  const raw = String(getKeepAlive());

  // -1 (or any negative) means "never evict" — bounded by the cap, see above.
  if (raw.startsWith('-')) return WARM_INFERENCE_CAP_MS;

  const match = raw.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!match) return WARM_INFERENCE_CAP_MS;

  const value = parseFloat(match[1]);
  // A bare number is seconds in Ollama's API, not milliseconds.
  const unit = (match[2] || 's').toLowerCase();
  const factor = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;

  return Math.min(value * factor, WARM_INFERENCE_CAP_MS);
}

/** True when the tier-0 model is likely still loaded, so no cold start ahead. */
export function isMacLikelyWarm(): boolean {
  if (lastMacSuccessAt === null) return false;
  return Date.now() - lastMacSuccessAt < keepAliveMs();
}

/**
 * Record a successful tier-0 call: resets the breaker and marks the model warm.
 *
 * Call this instead of `macBreaker.onSuccess()` directly, so the two can never
 * drift apart.
 */
export function noteMacSuccess(): void {
  lastMacSuccessAt = Date.now();
  macBreaker.onSuccess();
}

function baseUrl(): string {
  return process.env.MAC_OLLAMA_BASE_URL || '';
}

export function isMacTierConfigured(): boolean {
  return Boolean(baseUrl());
}

export function getMacModelName(): string {
  return process.env.MAC_OLLAMA_MODEL || DEFAULT_MODEL;
}

function probeTimeoutMs(): number {
  const parsed = parseInt(process.env.MAC_OLLAMA_PROBE_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_PROBE_TIMEOUT_MS;
}

function requestTimeoutMs(): number {
  const parsed = parseInt(process.env.MAC_OLLAMA_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_REQUEST_TIMEOUT_MS;
}

/**
 * Built per call so env changes are picked up the same way other tiers do.
 *
 * `overrides` exists for non-answer callers — currently the profile refresh job
 * (`src/lib/refresh/`), which wants the same host, probe and breaker but a
 * different model, a JSON-schema `format`, and a longer timeout. Overriding is
 * preferable to that job opening its own connection to the Mac, which would
 * duplicate the reachability logic this module exists to centralise.
 *
 * Note that overriding `model` has a side effect on the *answer* path: Ollama
 * evicts the resident model to load a different one, so the next visitor pays a
 * cold start. See `REFRESH_*_MODEL` in `.env.example`.
 */
export function createMacProvider(overrides: Partial<OllamaOptions> = {}): OllamaProvider {
  return new OllamaProvider({
    baseUrl: baseUrl(),
    model: getMacModelName(),
    timeoutMs: requestTimeoutMs(),
    label: 'mac_ollama',
    keepAlive: getKeepAlive(),
    ...overrides,
  });
}

/** Why tier 0 was skipped, as a workflow-step identifier. */
export type MacSkipReason =
  | 'mac_not_configured'
  | 'mac_circuit_open_skip'
  | 'mac_unreachable';

export type MacGate =
  | { ok: true; provider: OllamaProvider }
  | { ok: false; reason: MacSkipReason };

/**
 * Decides whether tier 0 may be attempted right now, and returns a ready
 * provider if so.
 *
 * An unreachable Mac is reported to the breaker as a failure here, so that
 * after MAC_CB_FAILURE_THRESHOLD consecutive misses even the ~1.5s probe is
 * skipped for the duration of the cooldown.
 */
export async function openMacTier(
  overrides: Partial<OllamaOptions> = {},
): Promise<MacGate> {
  if (!isMacTierConfigured()) {
    return { ok: false, reason: 'mac_not_configured' };
  }

  if (!macBreaker.allowRequest()) {
    return { ok: false, reason: 'mac_circuit_open_skip' };
  }

  const provider = createMacProvider(overrides);
  if (!(await provider.isReachable(probeTimeoutMs()))) {
    macBreaker.onFailure();
    console.info(
      JSON.stringify({
        event: 'mac_ollama_unreachable',
        probeTimeoutMs: probeTimeoutMs(),
        ts: new Date().toISOString(),
      }),
    );
    return { ok: false, reason: 'mac_unreachable' };
  }

  return { ok: true, provider };
}

/** Logs a tier-0 generation failure (as opposed to an unreachable host). */
export function logMacFailure(error: unknown): void {
  console.warn(
    JSON.stringify({
      event: 'mac_ollama_failure',
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
      ts: new Date().toISOString(),
    }),
  );
}

export { macBreaker };
