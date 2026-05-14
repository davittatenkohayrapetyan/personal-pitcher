export type LLMErrorCategory = 'network' | 'timeout' | 'quota' | 'http' | 'unknown';

export class LLMError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly category: LLMErrorCategory,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

/**
 * Returns true for errors that are transient (e.g. network outages, server errors,
 * quota exhaustion). The circuit breaker counts only transient errors toward opening.
 * Non-transient errors (e.g. 400 bad request) still trigger an Ollama fallback but
 * do not increment the failure counter.
 *
 * Errors that are not LLMError instances are treated as transient because they
 * represent unexpected failures (e.g. uncaught fetch exceptions before a response
 * was received) where the conservative choice is to count them and fall back.
 */
export function isTransientError(error: unknown): boolean {
  if (!(error instanceof LLMError)) return true;
  switch (error.category) {
    case 'network':
    case 'timeout':
    case 'quota':
      return true;
    case 'http':
      return error.statusCode !== undefined && error.statusCode >= 500;
    default:
      return false;
  }
}
