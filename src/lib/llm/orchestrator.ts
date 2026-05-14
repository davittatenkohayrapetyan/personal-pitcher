import type { LLMProvider } from '@/types';
import { OpenAIProvider } from './openai';
import { OllamaProvider } from './ollama';
import { LLMError, isTransientError } from './errors';
import { allowRequest, onSuccess, onFailure } from './circuitBreaker';

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

/**
 * FallbackOrchestrator tries OpenAI first and transparently falls back to
 * Ollama (Llama) whenever OpenAI is unavailable, returns an error, or its
 * circuit breaker is open.
 *
 * OpenAI is skipped entirely when:
 *   - OPENAI_API_KEY is not configured, or
 *   - the circuit breaker is in the open state.
 *
 * The circuit breaker trips (opens) only on *transient* failures: network
 * errors, timeouts, quota exhaustion (429), and server errors (5xx).
 * Non-transient errors (e.g. 400 bad request) still trigger the Ollama
 * fallback but do not count toward opening the breaker.
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
}
