import type { LLMProvider } from '@/types';
import { LLMError } from './errors';
import { parseOpenAISSE } from './stream';

export class OpenAIProvider implements LLMProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private timeoutMs: number;

  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY || '';
    this.model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    this.baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    this.timeoutMs = parseInt(process.env.OPENAI_TIMEOUT_MS || '30000', 10);
  }

  private buildMessages(prompt: string, systemPrompt?: string) {
    const messages: { role: string; content: string }[] = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });
    return messages;
  }

  /**
   * Issues the chat-completions request and normalises every failure mode into
   * an LLMError, so callers (and `isTransientError`) see one error shape
   * whether they asked for a streamed or a buffered response.
   */
  private async request(
    prompt: string,
    systemPrompt: string | undefined,
    stream: boolean,
    signal: AbortSignal,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: this.buildMessages(prompt, systemPrompt),
          temperature: 0.7,
          stream,
        }),
        signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new LLMError(
          `OpenAI request timed out after ${this.timeoutMs}ms`,
          'openai',
          'timeout',
        );
      }
      throw new LLMError(`OpenAI network error: ${String(err)}`, 'openai', 'network');
    }

    if (!response.ok) {
      const category = response.status === 429 ? 'quota' : 'http';
      throw new LLMError(
        `OpenAI error: ${response.status} ${response.statusText}`,
        'openai',
        category,
        response.status,
      );
    }

    return response;
  }

  async generate(prompt: string, systemPrompt?: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.request(prompt, systemPrompt, false, controller.signal);
      const data = await response.json();
      return data.choices?.[0]?.message?.content || '';
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Streams content deltas.
   *
   * The timeout guards time-to-first-byte only, then is cleared: a long answer
   * legitimately takes longer than OPENAI_TIMEOUT_MS to finish, and aborting a
   * healthy stream mid-answer would look to the caller exactly like a provider
   * failure.
   */
  async *generateStream(prompt: string, systemPrompt?: string): AsyncGenerator<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.request(prompt, systemPrompt, true, controller.signal);
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
    clearTimeout(timer);

    if (!response.body) {
      throw new LLMError('OpenAI returned an empty stream body', 'openai', 'network');
    }

    yield* parseOpenAISSE(response.body);
  }
}
