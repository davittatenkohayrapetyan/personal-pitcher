import type { LLMProvider } from '@/types';
import { LLMError } from './errors';

export class OllamaProvider implements LLMProvider {
  private baseUrl: string;
  private model: string;

  constructor() {
    this.baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    this.model = process.env.OLLAMA_MODEL || 'llama3';
  }

  async generate(prompt: string, systemPrompt?: string): Promise<string> {
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
        }),
      });
    } catch (err) {
      throw new LLMError(`Ollama network error: ${String(err)}`, 'ollama', 'network');
    }

    if (!response.ok) {
      throw new LLMError(
        `Ollama error: ${response.status} ${response.statusText}`,
        'ollama',
        'http',
        response.status,
      );
    }

    const data = await response.json();
    return data.message?.content || '';
  }
}
