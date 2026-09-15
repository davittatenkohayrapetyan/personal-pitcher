import type { Budget, StopReason } from './types';
import { displayTimeZone } from '../time';

/**
 * What bounds a run: a wall-clock deadline, a duration budget, and a count of
 * postings worth reviewing.
 *
 * ## Why the deadline is wall clock and not a duration
 *
 * §11 of `docs/job-outreach-plan.md` is specific about this. The 08:00 task can
 * fire at 08:40 — a laptop asleep at 08:00 catches up when it wakes — and the
 * point of the window is that the job is *over before the working day*, not
 * that it gets a full hour. A duration budget would let a late start run to
 * 09:40. So the deadline is a local wall-clock time, and the duration is belt
 * and braces for a manual run started at an odd hour.
 *
 * `DISPLAY_TIMEZONE` decides what "09:00" means, for the reason `time.ts` gives:
 * a fixed offset encodes an assumption a government can invalidate, and on a
 * host running UTC a naive `new Date().setHours(10)` is a four-hour bug that
 * only appears in production.
 *
 * ## A deadline already in the past
 *
 * The plan does not say what a run started at 14:00 should do, and taken
 * literally it has no budget at all — which would turn `npm run outreach` into a
 * command that does nothing every afternoon. So a deadline that has already
 * passed is dropped, logged by the caller, and the duration budget governs
 * alone. The scheduled 08:00 run is unaffected; the case only arises when a
 * human starts a run by hand, which is exactly when a duration is the right
 * bound.
 *
 * ## One counter, three stop conditions
 *
 * `expired()` is true when *any* of them has fired, and adapters call it before
 * every request (§17.3). That means the name under-describes it slightly — a run
 * that has found all the postings it was asked for is "expired" too — but the question an
 * adapter is asking is "should I still be making requests?", and there is only
 * one answer to that.
 */

/** `09:00` → minutes since local midnight. Returns null for anything else. */
function parseClock(value: string): number | null {
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(value);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  return hours * 60 + minutes;
}

/** The offset of `timeZone` from UTC at `instant`, in ms. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const field = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');

  const asUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
  );

  // `asUtc` is what the wall clock in that zone reads, expressed as if it were
  // UTC. The difference is the offset, to the second.
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Today's `HH:MM` in `DISPLAY_TIMEZONE`, as an epoch millisecond value.
 *
 * Returns null when the time has already passed, or when the string is not a
 * clock time — both mean "no wall-clock bound", and the caller says so in the
 * log rather than silently running unbounded.
 */
export function resolveDeadline(clock: string, now: Date = new Date()): number | null {
  const minutes = parseClock(clock);
  if (minutes === null) return null;

  const timeZone = displayTimeZone();
  let offset: number;
  try {
    offset = zoneOffsetMs(now, timeZone);
  } catch {
    // An unrecognised zone degrades to the duration budget rather than throwing
    // inside a scheduled run, matching how `formatDisplayTime` handles the same
    // bad value.
    return null;
  }

  const local = new Date(now.getTime() + offset);
  const midnightUtc = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
  );

  const deadline = midnightUtc + minutes * 60_000 - offset;
  return deadline > now.getTime() ? deadline : null;
}

export interface BudgetOptions {
  /** Epoch ms, or null when no wall-clock bound applies. */
  deadlineAt: number | null;
  durationMs: number;
  /** Queue-worthy postings after which the run stops early. */
  stopAfterMatches: number;
}

export class RunBudget implements Budget {
  private readonly startedAt = Date.now();
  private matches = 0;

  constructor(private readonly options: BudgetOptions) {}

  /**
   * Why the run stopped.
   *
   * Ordered so the *binding* constraint is named: a run that fills its queue
   * at 08:12 stopped on matches, even though the deadline would also have
   * stopped it eventually. `exhausted` means nothing stopped it — it ran out of
   * sources, which on a quiet morning is the normal outcome.
   */
  stoppedBy(): StopReason {
    if (this.matchesReached()) return 'matches';
    if (this.deadlinePassed()) return 'deadline';
    if (this.durationSpent()) return 'budget';
    return 'exhausted';
  }

  expired(): boolean {
    return this.matchesReached() || this.deadlinePassed() || this.durationSpent();
  }

  remainingMs(): number {
    const untilDuration = this.options.durationMs - (Date.now() - this.startedAt);
    const untilDeadline =
      this.options.deadlineAt === null ? Infinity : this.options.deadlineAt - Date.now();
    return Math.max(0, Math.min(untilDuration, untilDeadline));
  }

  /** Called once per posting added to the review queue. §7: only `draft` and `surface_only` count. */
  noteQueued(count = 1): void {
    this.matches += count;
  }

  queued(): number {
    return this.matches;
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  private matchesReached(): boolean {
    return this.options.stopAfterMatches > 0 && this.matches >= this.options.stopAfterMatches;
  }

  private deadlinePassed(): boolean {
    return this.options.deadlineAt !== null && Date.now() >= this.options.deadlineAt;
  }

  private durationSpent(): boolean {
    return Date.now() - this.startedAt >= this.options.durationMs;
  }
}
