import type { LLMProvider } from '@/types';
import { LLMError } from './errors';

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

  async generate(prompt: string, systemPrompt?: string): Promise<string> {
    const messages: { role: string; content: string }[] = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

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
          messages,
          temperature: 0.7,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new LLMError(
          `OpenAI request timed out after ${this.timeoutMs}ms`,
          'openai',
          'timeout',
        );
      }
      throw new LLMError(`OpenAI network error: ${String(err)}`, 'openai', 'network');
    }
    clearTimeout(timer);

    if (!response.ok) {
      const category = response.status === 429 ? 'quota' : 'http';
      throw new LLMError(
        `OpenAI error: ${response.status} ${response.statusText}`,
        'openai',
        category,
        response.status,
      );
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }
}
