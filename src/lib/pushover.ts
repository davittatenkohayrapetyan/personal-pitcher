import { logger } from './logger';
import { formatDisplayTime } from './time';

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
 *
 * Two kinds of notification are sent:
 *   - one per Q&A (`formatIterationMessage`), carrying the question *and the
 *     answer the model actually produced*;
 *   - alerts for exceptional pipeline events (`sendAlert`) — a tier going down
 *     or recovering, a stream dying mid-answer, every tier failing at once.
 */

const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json';
const DEFAULT_TIMEOUT_MS = parseInt(process.env.PUSHOVER_TIMEOUT_MS || '5000', 10);

/**
 * Pushover truncates messages server-side at 1024 characters. Budget the parts
 * so the answer is what gets trimmed, not the metadata that says which tier
 * served it — that metadata is the reason the notification is useful at all.
 */
const PUSHOVER_MESSAGE_LIMIT = 1024;
const QUESTION_MAX = 180;
const ANSWER_MAX = 500;
const ERROR_MAX = 200;

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

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
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
    title: truncate(payload.title, 250),
    message: truncate(payload.message, PUSHOVER_MESSAGE_LIMIT),
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

    // messageChars is here to make "did the answer actually get included?"
    // answerable from the logs — the body itself is not logged, since the
    // answer text is already carried by the request_completed event.
    logger.debug('pushover_sent', {
      title: payload.title,
      messageChars: payload.message.length,
      priority: payload.priority,
    });
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
 *
 * The answer is included so the notification is a record of what a visitor was
 * actually told, not just that they asked something. `modelsUsed` matters
 * alongside it: the same question answered by the LAN model and by OpenAI
 * produces noticeably different prose, and without the tier label there is no
 * way to tell which one a given answer came from.
 */
export function formatIterationMessage(args: {
  timestamp: Date;
  question: string;
  success: boolean;
  durationMs: number;
  modelsUsed: string[];
  answer?: string;
  errorMessage?: string;
}): { title: string; message: string; priority: PushoverPayload['priority'] } {
  const status = args.success ? '✅ Success' : '❌ Failed';
  const seconds = (args.durationMs / 1000).toFixed(2);
  const models = args.modelsUsed.length > 0 ? args.modelsUsed.join(', ') : 'none';

  const lines = [
    `Time: ${formatDisplayTime(args.timestamp)}`,
    `Question: ${truncate(args.question, QUESTION_MAX)}`,
    `Status: ${status}`,
    `Took: ${seconds}s`,
    `LLMs: ${models}`,
  ];

  if (args.answer) {
    lines.push('', `Answer: ${truncate(args.answer, ANSWER_MAX)}`);
  }

  if (!args.success && args.errorMessage) {
    lines.push(`Error: ${truncate(args.errorMessage, ERROR_MAX)}`);
  }

  return {
    title: `Ask Davit • ${args.success ? 'OK' : 'ERROR'}`,
    message: lines.join('\n'),
    // A failed answer is something to look at now; a successful one is a log
    // entry that happens to buzz.
    priority: args.success ? -1 : 1,
  };
}

/* ─── Exceptional-event alerts ──────────────────────────────────────────────
 *
 * Alerts are deliberately throttled per `kind`. The Mac tier's breaker re-opens
 * on every probe cycle for as long as that machine is away — without a throttle,
 * a laptop left at the office would push a notification every MAC_CB_COOLDOWN_MS
 * indefinitely. One alert an hour per kind is enough to tell you something is
 * wrong; the rest is noise that trains you to ignore the channel.
 *
 * Throttle state is per-process, the same caveat the circuit breakers carry.
 */

const DEFAULT_ALERT_MIN_INTERVAL_MS = 3_600_000; // 1 hour

const lastAlertAt = new Map<string, number>();

function alertMinIntervalMs(): number {
  const parsed = parseInt(process.env.PUSHOVER_ALERT_MIN_INTERVAL_MS ?? '', 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_ALERT_MIN_INTERVAL_MS;
}

export interface AlertArgs {
  /** Throttle key. Same kind within the interval is dropped. */
  kind: string;
  title: string;
  message: string;
  priority?: PushoverPayload['priority'];
  /** Skip the throttle for one-off events that cannot repeat in a loop. */
  bypassThrottle?: boolean;
}

/**
 * Fire-and-forget alert for an exceptional pipeline event.
 *
 * Never awaited by callers and never throws: an alert that fails must not turn
 * a degraded request into a broken one.
 */
export function sendAlert(args: AlertArgs): void {
  if (!isPushoverConfigured()) return;

  const now = Date.now();
  if (!args.bypassThrottle) {
    const previous = lastAlertAt.get(args.kind);
    const interval = alertMinIntervalMs();
    if (previous !== undefined && now - previous < interval) {
      logger.debug('pushover_alert_throttled', {
        kind: args.kind,
        sinceLastMs: now - previous,
      });
      return;
    }
  }
  lastAlertAt.set(args.kind, now);

  logger.warn('pushover_alert', { kind: args.kind, title: args.title });

  void sendPushover({
    title: args.title,
    message: `${args.message}\n\nAt: ${formatDisplayTime(now)}`,
    priority: args.priority ?? 1,
  }).catch((err) => {
    logger.warn('pushover_alert_failed', {
      kind: args.kind,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/** Test seam — clears throttle state. */
export function resetAlertThrottle(): void {
  lastAlertAt.clear();
}
