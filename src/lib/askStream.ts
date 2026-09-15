/**
 * Browser-side client for the streaming /api/ask endpoint.
 *
 * Uses fetch + ReadableStream rather than EventSource because the request is a
 * POST with a JSON body, which EventSource cannot express.
 */

export type AskEvent =
  | { type: 'step'; step: string }
  | { type: 'token'; token: string }
  | {
      type: 'meta';
      intent?: string;
      sources?: string[];
      modelsUsed?: string[];
      durationMs?: number;
      /** Free on-topic questions left for this visitor after this answer. */
      questionsRemaining?: number;
      questionsMax?: number;
    }
  | { type: 'error'; message: string };

export async function* askStream(
  question: string,
  sessionId?: string,
  signal?: AbortSignal,
): AsyncGenerator<AskEvent> {
  const response = await fetch('/api/ask', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ question, sessionId }),
    signal,
  });

  // Validation and rate-limit rejections come back as plain JSON, before any
  // stream is opened.
  if (!response.ok) {
    let message = 'Failed to get an answer';
    try {
      const data = await response.json();
      if (typeof data?.error === 'string') message = data.error;
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    yield { type: 'error', message };
    return;
  }

  if (!response.body) {
    yield { type: 'error', message: 'The server returned an empty response.' };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '' || payload === '[DONE]') continue;
          try {
            yield JSON.parse(payload) as AskEvent;
          } catch {
            // Ignore a malformed frame rather than aborting a good answer.
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
