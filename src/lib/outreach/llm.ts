import { OpenAIProvider } from '../llm/openai';
import { isTransientError } from '../llm/errors';
import {
  openMacTier,
  createMacProvider,
  noteMacSuccess,
  logMacFailure,
  getMacModelName,
} from '../llm/macOllama';
import { macBreaker } from '../llm/circuitBreaker';
import { allowPaidFallback, draftNumCtx, draftTimeoutMs, outreachTimeoutMs, stageModel } from './config';
import { logger } from '../logger';

/**
 * The outreach job's access to a model.
 *
 * Deliberately the same shape as `src/lib/refresh/llm.ts`, down to the
 * `parseJsonBlock` fallback, because it is the same decision made twice for the
 * same reasons: `openMacTier()` rather than a private connection, so this job
 * inherits the reachability probe, the warm/cold accounting and the breaker
 * policy the website uses, and cannot drift from them.
 *
 * ## It does not share the website's breaker state, and nothing here should
 * claim it does
 *
 * `macBreaker` is module-level state and therefore **per process**. This job is
 * a `tsx` process on the Windows host; the site is a Next.js server, in Docker,
 * elsewhere. They run the same breaker *code* over two separate sets of
 * counters. A 08:00 run that finds the Mac asleep opens its own breaker and the
 * website learns nothing from it — which costs nothing, because the website
 * probes for itself.
 *
 * It is worth being exact about this because `breakerAlerts('mac', 0)` is wired
 * to the breaker instance, so an outreach run that opens its own copy sends a
 * Pushover alert phrased as though the *site's* tier 0 were down, and the
 * throttle in `pushover.ts` is per-process too, so it cannot dedupe against one
 * the website just sent. See §23 of `docs/job-outreach-plan.md`.
 *
 * Two policies differ from the answer path, both deliberate and both inherited
 * from the refresh job's reasoning:
 *
 *  - **No paid fallback by default** (`OUTREACH_ALLOW_PAID_FALLBACK`). The
 *    chain exists so a visitor never waits on a sleeping laptop; a batch job has
 *    no visitor. §16's open question is whether stage C should be the exception
 *    once it exists — a cover letter is the one artifact here where model
 *    quality converts directly into an outcome — but that is a phase 6
 *    decision and this gate already allows it to be made per stage.
 *  - **No local-Ollama tier.** Tier 2 is `llama3` on this machine: a fine last
 *    resort for a sentence a visitor is watching stream in, not something to
 *    hand a decision about whether an application gets sent in Davit's name.
 *
 * ## What "no model" means here
 *
 * It does not mean a failed run. Adapters and the geo filter need no model at
 * all, so postings still reach the queue — flagged `unscored`, with no verdict
 * and no draft (§11). That is why every caller takes a `ModelGate` rather than
 * a model: "the Mac is away" is an ordinary morning, not an error path.
 */

export type OutreachStage = 'extract' | 'score' | 'draft';

export interface OutreachModel {
  label: string;
  model: string;
  /** Returns raw text; callers parse and sanitise. */
  generate(system: string, prompt: string, schema?: unknown): Promise<string>;
}

export type ModelGate = { ok: true; model: OutreachModel } | { ok: false; reason: string };

/**
 * Opens a model for one stage.
 *
 * The model name defaults to whatever the site is already running, for the
 * reason `config.ts` gives: naming a different one makes Ollama evict the
 * resident model, and the next visitor pays a cold start that lands on the
 * website rather than in this job's logs.
 */
export async function openOutreachModel(stage: OutreachStage): Promise<ModelGate> {
  const resolved = stageModel(stage) ?? getMacModelName();
  const shared = {
    model: resolved,
    // Drafting is the stage that runs in the website's own process, so it gets
    // the capped budget — see `draftTimeoutMs`.
    timeoutMs: stage === 'draft' ? draftTimeoutMs() : outreachTimeoutMs(),
    // Extraction and scoring are not creative work, and a run that reaches
    // different verdicts from identical inputs is a run nobody can review with
    // confidence. Drafting is the opposite on both counts: a letter is prose,
    // and at 0.1 the same four sentences come back for every posting with the
    // company name swapped -- which a recruiter who has seen two of them will
    // notice. It is still well below 1: the constraint that matters is that
    // every claim traces to the profile, and temperature is exactly the knob
    // that loosens it.
    options: {
      temperature: stage === 'draft' ? 0.6 : 0.1,
      // Unset by default, and `draftNumCtx` says why: naming a context window
      // makes Ollama reload the model, which evicts the instance the website is
      // answering visitors from. The drafting prompt is the biggest one this
      // job sends -- a whole profile, a posting, voice examples and, in the
      // loop, a letter being revised -- so it is the one worth being able to
      // raise deliberately. Every candidate logs `promptChars` so the size is
      // visible rather than guessed at.
      ...(stage === 'draft' && draftNumCtx() !== undefined ? { num_ctx: draftNumCtx() } : {}),
    } as Record<string, unknown>,
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
          // tier: the probe has already succeeded, and re-probing would add a
          // LAN round trip to every single posting.
          const provider = schema ? createMacProvider({ ...shared, format: schema }) : gate.provider;

          try {
            const text = await provider.generate(prompt, system);
            noteMacSuccess();
            return text;
          } catch (err) {
            logMacFailure(err);

            // Gated, where `orchestrator.ts` and `classify.ts` record
            // unconditionally, and the difference is `generate_draft`: that
            // button runs *in the website's process*, so a failure here spends
            // the breaker budget that keeps tier 0 available to visitors. The
            // failure it is most likely to spend it on is deterministic — a
            // schema Ollama will not compile answers 400 every time, so two
            // clicks of a button whose error message says "the log has the
            // reason" would open the breaker, push an alert claiming the Mac is
            // down, and route five minutes of visitors to OpenAI. A machine
            // that answers 400 instantly is not an absent machine, which is the
            // only thing this breaker exists to detect. `errors.ts` already
            // draws exactly this line for OpenAI; it is the same line.
            if (isTransientError(err)) macBreaker.onFailure();

            throw err;
          }
        },
      },
    };
  }

  logger.info('outreach_mac_tier_skipped', { job: 'outreach', stage, reason: gate.reason });

  if (!allowPaidFallback() || !process.env.OPENAI_API_KEY) {
    return { ok: false, reason: gate.reason };
  }

  const openai = new OpenAIProvider();
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  logger.info('outreach_paid_fallback_used', { job: 'outreach', stage, model });

  return {
    ok: true,
    model: {
      label: 'openai',
      model,
      // No `format` equivalent: the OpenAI adapter in this repo has no
      // structured-output surface, so the prompt asks for JSON and
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
 * rather than throwing — an unparseable response is an expected outcome the
 * caller records as a violation, not an exception.
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
