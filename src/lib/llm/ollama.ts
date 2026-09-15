import type { LLMProvider } from '@/types';
import { LLMError } from './errors';
import { parseNDJSON } from './stream';

export interface OllamaOptions {
  baseUrl?: string;
  model?: string;
  /**
   * Aborts the request after this many ms. For streaming this guards
   * time-to-first-byte only (see `generateStream`). `0`/omitted means no
   * timeout, which is the historical behaviour of the local fallback tier.
   */
  timeoutMs?: number;
  /** Label used in `LLMError.provider`, so logs can tell the tiers apart. */
  label?: string;
  /**
   * Passed through to Ollama as `keep_alive`: how long to hold the model in
   * memory after this request. Accepts Ollama's own forms — a duration string
   * (`"30m"`, `"2h"`), seconds as a number, `-1` for indefinitely, `0` to
   * unload immediately. Omitted entirely when undefined, so Ollama applies its
   * own default rather than us silently overriding it.
   */
  keepAlive?: string | number;
  /**
   * Passed through to Ollama as `format`: either the string `"json"` or a JSON
   * Schema object, which constrains decoding so the response *cannot* come back
   * as prose.
   *
   * Added for the profile refresh job (`src/lib/refresh/`), where a model reads
   * third-party API text and must return a fixed-shape record. Constrained
   * decoding is the first of that job's layers, not its security boundary —
   * `refresh/sanitize.ts` re-validates every field afterwards, because a schema
   * says nothing about what the *strings* inside it contain. Omitted when
   * undefined, so the answer tiers are unaffected.
   */
  format?: unknown;
  /**
   * Passed through to Ollama as `options` (temperature, seed, num_ctx, ...).
   * Omitted when undefined so Ollama's own defaults apply, which is what the
   * answer tiers have always relied on.
   */
  options?: Record<string, unknown>;
}

export class OllamaProvider implements LLMProvider {
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;
  private label: string;
  private keepAlive?: string | number;
  private format?: unknown;
  private options?: Record<string, unknown>;

  constructor(options: OllamaOptions = {}) {
    this.baseUrl = options.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    this.model = options.model || process.env.OLLAMA_MODEL || 'llama3';
    this.timeoutMs = options.timeoutMs ?? parseInt(process.env.OLLAMA_TIMEOUT_MS || '0', 10);
    this.label = options.label || 'ollama';
    this.keepAlive = options.keepAlive;
    this.format = options.format;
    this.options = options.options;
  }

  get modelName(): string {
    return this.model;
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
   * Cheap liveness check against Ollama's root endpoint.
   *
   * This exists for the Mac tier. A host that is powered off or on another
   * network does not refuse the connection — it silently drops the SYN, and
   * `fetch` then sits through the OS-level TCP retry schedule (~20s+) before
   * failing. Probing with a short, explicit timeout turns "the Mac isn't home"
   * from a 20-second stall on every request into a sub-second skip, which is
   * what makes a tier that is *expected* to be absent viable at the front of
   * the chain.
   *
   * Never throws — unreachable is a normal, expected answer here.
   */
  async isReachable(timeoutMs: number): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(this.baseUrl, { signal: controller.signal });
      // Drain so the socket can be reused rather than left half-open.
      await response.text().catch(() => undefined);
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async request(
    prompt: string,
    systemPrompt: string | undefined,
    stream: boolean,
    signal?: AbortSignal,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: this.buildMessages(prompt, systemPrompt),
          stream,
          // Spread rather than always setting it: an explicit `keep_alive: undefined`
          // would serialise away, but being deliberate here keeps tier 2 on Ollama's
          // own default instead of us silently dictating eviction policy for a
          // provider that never asked for one.
          ...(this.keepAlive !== undefined ? { keep_alive: this.keepAlive } : {}),
          // Same reasoning as keep_alive: only sent when a caller asked for it,
          // so tiers 0 and 2 keep Ollama's unconstrained defaults.
          ...(this.format !== undefined ? { format: this.format } : {}),
          ...(this.options !== undefined ? { options: this.options } : {}),
        }),
        signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new LLMError(
          `Ollama request timed out after ${this.timeoutMs}ms`,
          this.label,
          'timeout',
        );
      }
      throw new LLMError(`Ollama network error: ${String(err)}`, this.label, 'network');
    }

    if (!response.ok) {
      throw new LLMError(
        `Ollama error: ${response.status} ${response.statusText}`,
        this.label,
        'http',
        response.status,
      );
    }

    return response;
  }

  async generate(prompt: string, systemPrompt?: string): Promise<string> {
    const controller = new AbortController();
    const timer = this.timeoutMs > 0
      ? setTimeout(() => controller.abort(), this.timeoutMs)
      : undefined;
    try {
      const response = await this.request(prompt, systemPrompt, false, controller.signal);
      const data = await response.json();
      return data.message?.content || '';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Streams content deltas from Ollama's newline-delimited JSON response.
   *
   * As in the OpenAI adapter, the timeout guards time-to-first-byte and is then
   * cleared: a long answer from a large local model legitimately outlives
   * `timeoutMs`, and aborting a healthy stream mid-answer would be
   * indistinguishable to the caller from a provider failure.
   */
  async *generateStream(prompt: string, systemPrompt?: string): AsyncGenerator<string> {
    const controller = new AbortController();
    const timer = this.timeoutMs > 0
      ? setTimeout(() => controller.abort(), this.timeoutMs)
      : undefined;

    let response: Response;
    try {
      response = await this.request(prompt, systemPrompt, true, controller.signal);
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!response.body) {
      throw new LLMError('Ollama returned an empty stream body', this.label, 'network');
    }

    yield* parseNDJSON(response.body);
  }
}
