import type { LLMProvider } from '@/types';
import { OpenAIProvider } from './openai';
import { OllamaProvider } from './ollama';
import { LLMError, isTransientError } from './errors';
import { allowRequest, onSuccess, onFailure } from './circuitBreaker';
import { openMacTier, getMacModelName, logMacFailure, macBreaker, noteMacSuccess } from './macOllama';
import type { OrchestratorEvent } from './stream';

/**
 * Result returned by FallbackOrchestrator.generateWithMeta — carries the
 * generated content plus structured metadata about which models were used and
 * which workflow steps were taken. This metadata is consumed by the request
 * logger and Pushover notifier.
 */
export interface OrchestratorResult {
  content: string;
  modelsUsed: string[];
  steps: string[];
}

function getOpenAIModelName(): string {
  return process.env.OPENAI_MODEL || 'gpt-4o-mini';
}

function getOllamaModelName(): string {
  return process.env.OLLAMA_MODEL || 'llama3';
}

function logOpenAIFailure(error: unknown, transient: boolean): void {
  console.warn(
    JSON.stringify({
      event: 'openai_failure',
      transient,
      countedByBreaker: transient,
      error:
        error instanceof LLMError
          ? { name: error.name, category: error.category, statusCode: error.statusCode, message: error.message }
          : String(error),
      ts: new Date().toISOString(),
    }),
  );
}

/**
 * FallbackOrchestrator walks a three-tier chain, transparently dropping to the
 * next tier whenever the current one is unavailable, errors, or has its circuit
 * breaker open:
 *
 *   tier 0  Mac Ollama (gemma4:26b on the home LAN) — free, local,
 *           frequently absent. Skipped entirely unless MAC_OLLAMA_BASE_URL is
 *           set. See `macOllama.ts` for why absence has to be cheap.
 *   tier 1  OpenAI — the dependable paid path. Skipped when OPENAI_API_KEY is
 *           unset or its breaker is open.
 *   tier 2  Local Ollama — the last-resort generator.
 *
 * Tiers 0 and 1 have *separate* breakers. A Mac that is off the network all
 * week must not consume the OpenAI failure budget, and a flaky OpenAI must not
 * stop us from using the Mac when it comes home.
 *
 * A breaker trips (opens) only on *transient* failures: network errors,
 * timeouts, quota exhaustion (429), and server errors (5xx). Non-transient
 * errors (e.g. 400 bad request) still trigger a fallback but do not count
 * toward opening the breaker.
 */
export class FallbackOrchestrator implements LLMProvider {
  private readonly openai: OpenAIProvider;
  private readonly ollama: OllamaProvider;

  constructor() {
    this.openai = new OpenAIProvider();
    this.ollama = new OllamaProvider();
  }

  async generate(prompt: string, systemPrompt?: string): Promise<string> {
    const result = await this.generateWithMeta(prompt, systemPrompt);
    return result.content;
  }

  async generateWithMeta(prompt: string, systemPrompt?: string): Promise<OrchestratorResult> {
    const openaiConfigured = Boolean(process.env.OPENAI_API_KEY);
    const modelsUsed: string[] = [];
    const steps: string[] = [];

    // ─── Tier 0: Mac Ollama ───────────────────────────────────────────────
    const mac = await openMacTier();
    if (mac.ok) {
      steps.push('mac_attempt');
      try {
        const content = await mac.provider.generate(prompt, systemPrompt);
        noteMacSuccess();
        modelsUsed.push(`mac-ollama:${getMacModelName()}`);
        steps.push('mac_success');
        return { content, modelsUsed, steps };
      } catch (error) {
        macBreaker.onFailure();
        logMacFailure(error);
        steps.push('mac_failure');
      }
    } else {
      steps.push(mac.reason);
    }

    // ─── Tier 1: OpenAI ───────────────────────────────────────────────────
    if (openaiConfigured && allowRequest()) {
      steps.push('openai_attempt');
      try {
        const result = await this.openai.generate(prompt, systemPrompt);
        onSuccess();
        modelsUsed.push(`openai:${getOpenAIModelName()}`);
        steps.push('openai_success');
        return { content: result, modelsUsed, steps };
      } catch (error) {
        const transient = isTransientError(error);
        logOpenAIFailure(error, transient);
        steps.push(transient ? 'openai_failure_transient' : 'openai_failure_non_transient');
        if (transient) {
          onFailure();
        }
        // Fall through to Ollama regardless of error type.
        console.info(JSON.stringify({ event: 'fallback_to_ollama', ts: new Date().toISOString() }));
        steps.push('fallback_to_ollama');
      }
    } else if (openaiConfigured) {
      // Breaker is open — skip OpenAI and go straight to Ollama.
      console.info(
        JSON.stringify({ event: 'circuit_open_skip_openai', ts: new Date().toISOString() }),
      );
      steps.push('circuit_open_skip_openai');
    } else {
      steps.push('openai_not_configured');
    }

    // ─── Tier 2: Local Ollama ─────────────────────────────────────────────
    steps.push('ollama_attempt');
    try {
      const content = await this.ollama.generate(prompt, systemPrompt);
      modelsUsed.push(`ollama:${getOllamaModelName()}`);
      steps.push('ollama_success');
      return { content, modelsUsed, steps };
    } catch (err) {
      steps.push('ollama_failure');
      throw err;
    }
  }

  /**
   * Streaming counterpart to `generateWithMeta`. Emits the same workflow steps
   * as `step` events, interleaved with `token` deltas, so the browser sees the
   * fallback decision as it happens rather than after the fact.
   *
   * The fallback rule differs from the buffered path in one important way: it
   * applies only *before the first token*. Once a tier has emitted text, a
   * later failure cannot be recovered by restarting on the next tier — the
   * visitor would see the answer restart mid-sentence, and the two halves would
   * come from different models. In that case the stream ends with an `error`
   * event and the partial answer is kept.
   */
  async *generateStream(
    prompt: string,
    systemPrompt?: string,
  ): AsyncGenerator<OrchestratorEvent> {
    const openaiConfigured = Boolean(process.env.OPENAI_API_KEY);

    // ─── Tier 0: Mac Ollama ───────────────────────────────────────────────
    const mac = await openMacTier();
    if (mac.ok) {
      yield { type: 'step', step: 'mac_attempt' };
      let emitted = 0;
      try {
        for await (const token of mac.provider.generateStream(prompt, systemPrompt)) {
          emitted += 1;
          yield { type: 'token', token };
        }
        noteMacSuccess();
        yield { type: 'step', step: 'mac_success' };
        yield { type: 'meta', modelsUsed: [`mac-ollama:${getMacModelName()}`] };
        return;
      } catch (error) {
        macBreaker.onFailure();
        logMacFailure(error);

        if (emitted > 0) {
          yield { type: 'step', step: 'mac_stream_interrupted' };
          yield {
            type: 'error',
            message: 'The answer was cut off mid-stream. Please ask again.',
          };
          return;
        }

        yield { type: 'step', step: 'mac_failure' };
      }
    } else {
      yield { type: 'step', step: mac.reason };
    }

    // ─── Tier 1: OpenAI ───────────────────────────────────────────────────
    if (openaiConfigured && allowRequest()) {
      yield { type: 'step', step: 'openai_attempt' };
      let emitted = 0;
      try {
        for await (const token of this.openai.generateStream(prompt, systemPrompt)) {
          emitted += 1;
          yield { type: 'token', token };
        }
        onSuccess();
        yield { type: 'step', step: 'openai_success' };
        yield { type: 'meta', modelsUsed: [`openai:${getOpenAIModelName()}`] };
        return;
      } catch (error) {
        const transient = isTransientError(error);
        logOpenAIFailure(error, transient);
        if (transient) {
          onFailure();
        }

        if (emitted > 0) {
          // Mid-stream failure: no safe recovery, so surface it honestly.
          yield { type: 'step', step: 'openai_stream_interrupted' };
          yield {
            type: 'error',
            message: 'The answer was cut off mid-stream. Please ask again.',
          };
          return;
        }

        yield {
          type: 'step',
          step: transient ? 'openai_failure_transient' : 'openai_failure_non_transient',
        };
        console.info(JSON.stringify({ event: 'fallback_to_ollama', ts: new Date().toISOString() }));
        yield { type: 'step', step: 'fallback_to_ollama' };
      }
    } else if (openaiConfigured) {
      console.info(
        JSON.stringify({ event: 'circuit_open_skip_openai', ts: new Date().toISOString() }),
      );
      yield { type: 'step', step: 'circuit_open_skip_openai' };
    } else {
      yield { type: 'step', step: 'openai_not_configured' };
    }

    // ─── Tier 2: Local Ollama ─────────────────────────────────────────────
    yield { type: 'step', step: 'ollama_attempt' };
    try {
      for await (const token of this.ollama.generateStream(prompt, systemPrompt)) {
        yield { type: 'token', token };
      }
      yield { type: 'step', step: 'ollama_success' };
      yield { type: 'meta', modelsUsed: [`ollama:${getOllamaModelName()}`] };
    } catch {
      yield { type: 'step', step: 'ollama_failure' };
      yield {
        type: 'error',
        message: 'Failed to generate an answer. Please try again.',
      };
    }
  }
}
