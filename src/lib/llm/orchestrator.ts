import type { LLMProvider } from '@/types';
import { OpenAIProvider } from './openai';
import { OllamaProvider } from './ollama';
import { LLMError, isTransientError } from './errors';
import { allowRequest, onSuccess, onFailure } from './circuitBreaker';

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
    const openaiConfigured = Boolean(process.env.OPENAI_API_KEY);

    if (openaiConfigured && allowRequest()) {
      try {
        const result = await this.openai.generate(prompt, systemPrompt);
        onSuccess();
        return result;
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
        if (transient) {
          onFailure();
        }
        // Fall through to Ollama regardless of error type.
      }
      console.info(JSON.stringify({ event: 'fallback_to_ollama', ts: new Date().toISOString() }));
    } else if (openaiConfigured) {
      // Breaker is open — skip OpenAI and go straight to Ollama.
      console.info(
        JSON.stringify({ event: 'circuit_open_skip_openai', ts: new Date().toISOString() }),
      );
    }

    return await this.ollama.generate(prompt, systemPrompt);
  }
}
