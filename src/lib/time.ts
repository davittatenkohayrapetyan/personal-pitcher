/**
 * Formatting for timestamps a human reads.
 *
 * ## Why this is not just `toISOString()`
 *
 * Logs stay in UTC — they are correlated across machines and read by tooling,
 * and a log line in local time is a log line you cannot line up with anything.
 * Notifications are the opposite: they are read by one person, on a phone, who
 * wants to know whether the thing happened *just now* or overnight. `2026-09-12
 * T19:40:19.000Z` fails at that when you live in UTC+4, because it is four hours
 * off every glance.
 *
 * So the rule in this codebase is: **structured logs UTC, human messages local.**
 * This file is the local half.
 *
 * ## Why an IANA zone rather than a fixed offset
 *
 * `DISPLAY_TIMEZONE` takes a zone name (default `Asia/Yerevan`), not `+04:00`.
 * Armenia has had no DST since 2012, so the two are identical today — but a
 * fixed offset encodes an assumption that a government decision could silently
 * invalidate, and it would break in the least visible way possible: timestamps
 * quietly an hour out, in notifications nobody cross-checks. A zone name stays
 * correct through any such change.
 */

const DEFAULT_TIMEZONE = 'Asia/Yerevan';

export function displayTimeZone(): string {
  return process.env.DISPLAY_TIMEZONE?.trim() || DEFAULT_TIMEZONE;
}

/**
 * `12 Sep 2026, 23:40 (+04)` — date, time and the offset that time is in.
 *
 * The offset is included deliberately. Without it a bare "23:40" is ambiguous
 * the moment it is read anywhere other than at home, which for a notification
 * about a server is exactly when it matters.
 *
 * Falls back to ISO if the configured zone is not recognised: a bad
 * `DISPLAY_TIMEZONE` should degrade the formatting, never throw inside the
 * fire-and-forget notification path.
 */
export function formatDisplayTime(value: Date | number | string): string {
  const date = value instanceof Date ? value : new Date(value);
  const timeZone = displayTimeZone();

  try {
    const formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZoneName: 'shortOffset',
    }).format(date);

    // en-GB renders as "12 Sep 2026, 23:40 GMT+4"; the parenthesised offset
    // reads better at a glance in a push notification.
    return formatted.replace(/\s(GMT[+-]\d+|UTC)$/, ' ($1)');
  } catch {
    return date.toISOString();
  }
}
