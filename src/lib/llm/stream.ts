/**
 * Shared types for streamed generation.
 *
 * A provider yields `LLMChunk`s; the orchestrator wraps them into
 * `OrchestratorEvent`s that also carry the workflow trail, so the browser can
 * render the same `steps` sequence that lands in the request log.
 */

export interface LLMChunk {
  /** Incremental text delta. Never the full accumulated answer. */
  token: string;
}

export type OrchestratorEvent =
  /** A pipeline step was reached, e.g. `openai_attempt`. Mirrors `workflowSteps`. */
  | { type: 'step'; step: string }
  /** An incremental text delta of the answer. */
  | { type: 'token'; token: string }
  /** Terminal success event: the models that produced the answer. */
  | { type: 'meta'; modelsUsed: string[] }
  /** Terminal failure event. Message is safe for display — never a raw provider error. */
  | { type: 'error'; message: string };

/**
 * Parses an OpenAI-style SSE body into content deltas.
 *
 * Handles the two things that actually bite here: a `data:` payload split
 * across TCP chunks (buffer until `\n\n`), and the literal `[DONE]` sentinel,
 * which is not JSON.
 */
export async function* parseOpenAISSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by a blank line.
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        for (const line of rawEvent.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '' || payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta.length > 0) {
              yield delta;
            }
          } catch {
            // A malformed frame is not worth killing a good stream over.
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Parses Ollama's newline-delimited JSON stream into content deltas. */
export async function* parseNDJSON(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');

        if (line === '') continue;
        try {
          const parsed = JSON.parse(line);
          const delta = parsed.message?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            yield delta;
          }
        } catch {
          // Same reasoning as above.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
