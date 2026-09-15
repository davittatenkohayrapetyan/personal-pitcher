import { OpenAIProvider } from '../llm/openai';
import {
  openMacTier,
  createMacProvider,
  noteMacSuccess,
  logMacFailure,
  getMacModelName,
} from '../llm/macOllama';
import { macBreaker } from '../llm/circuitBreaker';
import { allowPaidFallback, refreshTimeoutMs } from './config';
import { logger } from '../logger';

/**
 * The refresh job's access to a model.
 *
 * Reuses `openMacTier()` rather than opening its own connection, so this job
 * inherits the reachability probe, the warm/cold accounting and the breaker
 * policy that the answer path depends on, and cannot drift from them.
 *
 * It does not share the website's breaker *state*, and an earlier version of
 * this comment claimed it did. `macBreaker` is module-level and therefore
 * per-process: this job is a `tsx` process on the Windows host, the site is a
 * Next.js server in a container. Same code, two sets of counters. Nothing is
 * lost by that — the website probes for itself — but `breakerAlerts` is wired to
 * the breaker instance, so a batch run that opens its own copy sends a push
 * worded as though the site's tier 0 were down.
 *
 * Two policies differ from the answer path, both deliberate:
 *
 *  - **No paid fallback by default.** The chain exists so a visitor never waits
 *    on a sleeping laptop. A batch job has no visitor, and billing OpenAI for a
 *    background crawl is a cost nobody asked for. `REFRESH_ALLOW_PAID_FALLBACK`
 *    opts in.
 *  - **No local-Ollama tier.** Tier 2 is `llama3` on this machine — fine as a
 *    last resort for a sentence a visitor is watching stream in, not something
 *    to hand an editing decision about someone's professional profile.
 *
 * When no model is available the run does not fail; it reports `mac_unreachable`
 * and every source degrades to fetch-and-snapshot only.
 */

export interface RefreshModel {
  label: string;
  model: string;
  /** Returns raw text; callers parse and sanitise. */
  generate(system: string, prompt: string, schema?: unknown): Promise<string>;
}

export type ModelGate =
  | { ok: true; model: RefreshModel }
  | { ok: false; reason: string };

/**
 * Opens a model for one stage.
 *
 * `modelName` is undefined by default, meaning "whatever the site is already
 * running" — see `config.ts` for why naming a different model here has a cost
 * that lands on the website rather than in this job.
 */
export async function openRefreshModel(
  stage: 'extract' | 'edit',
  modelName?: string,
): Promise<ModelGate> {
  const resolved = modelName ?? getMacModelName();
  const shared = {
    model: resolved,
    timeoutMs: refreshTimeoutMs(),
    // Deterministic-ish: this is an extraction and editing job, not a creative
    // one, and a run that proposes different changes from identical inputs is a
    // run nobody can review with confidence.
    options: { temperature: 0.1 } as Record<string, unknown>,
  };

  const gate = await openMacTier(shared);

  if (gate.ok) {
    return {
      ok: true,
      model: {
        label: 'mac_ollama',
        model: resolved,
        async generate(system, prompt, schema) {
          // `format` is per-instance, so a call that wants constrained decoding
          // needs its own provider. Built directly rather than by re-opening the
          // tier: the probe has already succeeded, and re-probing would add
          // ~1.5s of LAN round trip to every single record.
          const provider = schema
            ? createMacProvider({ ...shared, format: schema })
            : gate.provider;

          try {
            const text = await provider.generate(prompt, system);
            noteMacSuccess();
            return text;
          } catch (err) {
            logMacFailure(err);
            macBreaker.onFailure();
            throw err;
          }
        },
      },
    };
  }

  logger.info('refresh_mac_tier_skipped', { stage, reason: gate.reason });

  if (!allowPaidFallback() || !process.env.OPENAI_API_KEY) {
    return { ok: false, reason: gate.reason };
  }

  const openai = new OpenAIProvider();
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  logger.info('refresh_paid_fallback_used', { stage, model });

  return {
    ok: true,
    model: {
      label: 'openai',
      model,
      // No `format` equivalent is passed here: the OpenAI adapter in this repo
      // has no structured-output surface, so the prompt asks for JSON and
      // `parseJsonBlock` does the rest. Constrained decoding was never the
      // security boundary — `sanitize.ts` is.
      generate: (system, prompt) => openai.generate(prompt, system),
    },
  };
}

/**
 * Pulls the first JSON object out of a model response.
 *
 * Needed even with constrained decoding, because the paid fallback has none and
 * because a model can still wrap valid JSON in a sentence. Returns `null`
 * rather than throwing — an unparseable response is an expected outcome that
 * the caller records as a violation, not an exception.
 */
export function parseJsonBlock(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to extraction.
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}
