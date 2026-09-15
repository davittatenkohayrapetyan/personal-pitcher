import fs from 'fs';
import path from 'path';
import type { AppliedApplication } from './types';
import {
  APPLIED_BACKUP_FILE,
  APPLIED_FILE,
  companyCooldownDays,
  maxApplicationsPerCompany,
  maxSendsPerDay,
  reapplyAfterDays,
} from './config';
import { displayTimeZone } from '../time';
import { logger } from '../logger';

/**
 * `data/outreach/applied.json` — the permanent record of every application that
 * has gone out, by any channel, including the ones Davit sent himself.
 *
 * Its own file rather than a section of `store.ts`, because §8.1 calls it the
 * most important file this system owns and the rules attached to it are not the
 * rules the other stores follow: never pruned, backed up on every write, and
 * read by four different checks that each answer a different question.
 *
 * ## The four guards, and why they are four and not one
 *
 * They look like one idea — "don't apply twice" — and they fail in four
 * different ways:
 *
 *  1. **The same posting on a later run.** Handled upstream by `seen.json`.
 *  2. **The same role through a different board.** `dedupeHash`, which is why
 *     that field exists at all: RemoteOK, Remotive and the company's own board
 *     list one job three times.
 *  3. **A role Davit applied to himself**, before this system existed or outside
 *     it. Nothing automatic can know this, so "Already applied" writes a
 *     `manual` row and sends nothing. This is the row the original design
 *     missed, and the one whose absence is worst: a system that remembers only
 *     what *it* sent will confidently write to someone Davit emailed last
 *     month, and the recipient sees a duplicate from the same person.
 *  4. **Four roles at one company in one week** — each legitimate alone,
 *     collectively spam, and all landing with the same ATS and often the same
 *     reviewer. That is the cooldown, and it is the one guard a *rejection* must
 *     never consume (§8): saying no to one bad role at NVIDIA must not block a
 *     good one for a month.
 *
 * Guard 1's other half and the send-time repeat of guard 2 arrive with
 * `send.ts` in phase 6. §17.8 requires that check to run twice — once in the
 * route, once immediately before the HTTP call — because the two are separated
 * by a human, a network and an await.
 */

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

export function readApplied(): AppliedApplication[] {
  const parsed = readJsonFile<AppliedApplication[]>(APPLIED_FILE, []);
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Appends one row, copying the previous contents aside first.
 *
 * The backup is written *before* the new file, so the failure mode of a crash
 * mid-write is a stale ledger rather than no ledger. Appending is the only
 * operation: there is no update and no delete, because the question this file
 * answers is "has this ever gone out?" and that answer does not become false.
 */
export function appendApplied(entry: AppliedApplication): AppliedApplication[] {
  const existing = readApplied();
  const merged = [...existing, entry];

  fs.mkdirSync(path.dirname(APPLIED_FILE), { recursive: true });

  if (existing.length > 0) {
    try {
      fs.copyFileSync(APPLIED_FILE, APPLIED_BACKUP_FILE);
    } catch (err) {
      // Logged loudly and then written anyway. A backup that cannot be made is
      // worth knowing about; refusing to record an application that has already
      // been sent would be worse, because the send is what cannot be undone.
      logger.error('outreach_ledger_backup_failed', {
        job: 'outreach',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  fs.writeFileSync(APPLIED_FILE, `${JSON.stringify(merged, null, 2)}\n`, 'utf-8');

  logger.info('outreach_marked_applied', {
    job: 'outreach',
    dedupeHash: entry.dedupeHash,
    company: entry.company,
    title: entry.title,
    // The field that distinguishes a manual record from a transmission. §12
    // names it explicitly, because a ledger where those look alike is a ledger
    // that cannot answer "what did we actually tell them?".
    channel: entry.channel,
    dryRun: entry.dryRun ?? false,
  });

  return merged;
}

/** Guard 2 and 3: has this role been applied to, by any channel? */
export function appliedFor(
  applied: AppliedApplication[],
  dedupeHash: string,
): AppliedApplication | null {
  return applied.find((entry) => entry.dedupeHash === dedupeHash) ?? null;
}

/**
 * Whether a role in the ledger may be applied to again.
 *
 * `OUTREACH_REAPPLY_AFTER_DAYS` is 0 by default, meaning never: a role reposted
 * six months later is still the same role at the same company. Raising it is a
 * deliberate act, and the card for a second attempt says so in plain words.
 */
export function reapplyAllowed(previous: AppliedApplication, now = new Date()): boolean {
  const after = reapplyAfterDays();
  if (after <= 0) return false;

  const applied = Date.parse(previous.appliedAt);
  if (!Number.isFinite(applied)) return false;

  return now.getTime() - applied >= after * 86_400_000;
}

export interface CooldownHold {
  /** How many applications to this company are inside the window. */
  count: number;
  limit: number;
  /** When the oldest of them frees up. */
  until: string;
  /** The most recent one, for the message. */
  last: AppliedApplication;
}

/**
 * Guard 4: is this company inside its cooldown?
 *
 * Counts by folded company name rather than by any identifier, because the
 * ledger's manual rows are typed by a human and "NVIDIA" and "Nvidia " are the
 * same employer to a recruiter.
 */
export function cooldownHold(
  applied: AppliedApplication[],
  company: string,
  now = new Date(),
): CooldownHold | null {
  const fold = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const windowMs = companyCooldownDays() * 86_400_000;
  const limit = maxApplicationsPerCompany();

  const recent = applied
    .filter((entry) => fold(entry.company) === fold(company))
    .filter((entry) => {
      const at = Date.parse(entry.appliedAt);
      return Number.isFinite(at) && now.getTime() - at < windowMs;
    })
    .sort((a, b) => Date.parse(a.appliedAt) - Date.parse(b.appliedAt));

  if (recent.length < limit) return null;

  return {
    count: recent.length,
    limit,
    until: new Date(Date.parse(recent[0].appliedAt) + windowMs).toISOString(),
    last: recent[recent.length - 1],
  };
}

/**
 * How many applications were transmitted today, in `DISPLAY_TIMEZONE`.
 *
 * The local day, not the UTC one, because the cap is a statement about a
 * person's morning. On a host running UTC those are different days for four
 * hours out of every twenty-four, and the bug would only ever appear in
 * production (§20).
 *
 * Two exclusions, and they go opposite ways for the same reason — what the cap
 * is actually protecting:
 *
 *  - **`manual` rows do not count.** The cap protects the sending domain's
 *    reputation, and a row recording that Davit emailed someone himself last
 *    month spent none of it. This matters most on the day the ledger is seeded
 *    (§8.1): twenty historical applications must not block today's first one.
 *  - **`dryRun` rows *do* count**, which looks inconsistent and is not. While
 *    `OUTREACH_DRY_RUN` is on — the default, and a deliberate one — *every*
 *    approval is a dry run, so excluding them would leave the cap completely
 *    unexercised until the first day it has to work. §19.6 asks for exactly
 *    this: approve one item under dry run and confirm the cap decrements. A
 *    guard whose first real test is the day it matters is not a guard.
 */
export function sentToday(applied: AppliedApplication[], now = new Date()): number {
  const today = localDay(now);
  return applied.filter(
    (entry) => entry.channel !== 'manual' && localDay(new Date(entry.appliedAt)) === today,
  ).length;
}

export function sendCapReached(applied: AppliedApplication[], now = new Date()): boolean {
  return sentToday(applied, now) >= maxSendsPerDay();
}

function localDay(date: Date): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: displayTimeZone(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}
