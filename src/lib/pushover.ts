import { logger } from './logger';

/**
 * Pushover client.
 *
 * Sends notifications via https://pushover.net/api. Requires:
 *   PUSHOVER_USER_KEY  – the recipient user/group key
 *   PUSHOVER_API_TOKEN – the application API token (the "API key")
 *
 * If either env var is missing, sendPushover() becomes a no-op and logs a
 * single warning. Network failures never throw — they are logged and
 * swallowed so they cannot break the request flow.
 */

const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json';
const DEFAULT_TIMEOUT_MS = parseInt(process.env.PUSHOVER_TIMEOUT_MS || '5000', 10);

export interface PushoverPayload {
  title: string;
  message: string;
  priority?: -2 | -1 | 0 | 1 | 2;
}

function getCredentials(): { user: string; token: string } | null {
  const user = process.env.PUSHOVER_USER_KEY;
  const token = process.env.PUSHOVER_API_TOKEN;
  if (!user || !token) {
    return null;
  }
  return { user, token };
}

export function isPushoverConfigured(): boolean {
  return getCredentials() !== null;
}

export async function sendPushover(payload: PushoverPayload): Promise<boolean> {
  const creds = getCredentials();
  if (!creds) {
    logger.debug('pushover_skipped_not_configured');
    return false;
  }

  const body = new URLSearchParams({
    token: creds.token,
    user: creds.user,
    title: payload.title,
    message: payload.message,
  });
  if (typeof payload.priority === 'number') {
    body.set('priority', String(payload.priority));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(PUSHOVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      logger.warn('pushover_send_failed', {
        status: response.status,
        statusText: response.statusText,
        body: text.slice(0, 500),
      });
      return false;
    }

    logger.debug('pushover_sent', { title: payload.title });
    return true;
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    logger.warn('pushover_send_error', {
      timeout: isTimeout,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Format a friendly per-iteration notification body.
 */
export function formatIterationMessage(args: {
  timestamp: Date;
  question: string;
  success: boolean;
  durationMs: number;
  modelsUsed: string[];
  errorMessage?: string;
}): { title: string; message: string } {
  const status = args.success ? '✅ Success' : '❌ Failed';
  const seconds = (args.durationMs / 1000).toFixed(2);
  const models = args.modelsUsed.length > 0 ? args.modelsUsed.join(', ') : 'none';
  const truncatedQuestion =
    args.question.length > 200 ? `${args.question.slice(0, 200)}…` : args.question;

  const lines = [
    `Time: ${args.timestamp.toISOString()}`,
    `Question: ${truncatedQuestion}`,
    `Status: ${status}`,
    `Took: ${seconds}s`,
    `LLMs: ${models}`,
  ];
  if (!args.success && args.errorMessage) {
    const truncatedError =
      args.errorMessage.length > 200 ? `${args.errorMessage.slice(0, 200)}…` : args.errorMessage;
    lines.push(`Error: ${truncatedError}`);
  }

  return {
    title: `Ask Davit • ${args.success ? 'OK' : 'ERROR'}`,
    message: lines.join('\n'),
  };
}
