import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type {
  CompanySuggestion,
  Cursor,
  DiscoveryRun,
  Handoff,
  OutreachRejection,
  OutreachRun,
  QueuedOpportunity,
  RawPosting,
  WatchedCompany,
} from './types';
import {
  COMPANIES_FILE,
  CURSOR_FILE,
  DISCOVERY_REPORT_FILE,
  HANDOFF_FILE,
  OUTREACH_DIR,
  PENDING_FILE,
  REJECTED_FILE,
  RUN_REPORT_FILE,
  SEEN_FILE,
  SUGGESTIONS_FILE,
  queueTtlDays,
} from './config';
import { logger } from '../logger';

/**
 * The stores behind the outreach job: the permanent dedupe index, the review
 * queue, the source cursor and the run report.
 *
 * ## `seen.json` is permanent, and that is the opposite of the refresh job
 *
 * `src/lib/refresh/store.ts` overwrites its pending proposal every run, because
 * a proposal is only meaningful against the `data/` it was diffed from and is
 * therefore free to re-derive. A job posting is not derived from anything — it
 * is an external event with its own lifetime, and missing one costs a real
 * opportunity. So nothing here is thrown away.
 *
 * The index is keyed twice on purpose. `id` is the posting's identity within
 * its source, which is what stops one board being re-reported every morning.
 * `dedupeHash` is company plus title, which is what stops the same role
 * arriving three times because it is listed on RemoteOK, on Remotive and on the
 * company's own board. Seeing one role three times in a queue is how a person
 * stops reading the queue.
 *
 * ## Ids are content-derived, never sequential
 *
 * `sha256(source|key)` is stable across runs, which is what lets `seen.json`,
 * and later `pending.json` and `rejected.json`, talk about the same posting
 * without a database between them.
 */

export interface SeenEntry {
  id: string;
  dedupeHash: string;
  source: string;
  key: string;
  firstSeenAt: string;
  /**
   * `deferred` is the only non-terminal one: found, and not yet judged. It is
   * what a posting gets when the geo filter passed it and nothing has scored
   * it — whether because scoring does not run this morning, or because the run
   * stopped first (§11). Everything else is a decision. `sent` arrives with the
   * code that sends.
   */
  status: 'deferred' | 'queued' | 'skipped' | 'ineligible' | 'sent';
}

function hash(material: string): string {
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/** Case, spacing and punctuation blind — the same fold `refresh/sanitize.ts` uses. */
function fold(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function postingId(source: string, key: string): string {
  return hash(`${source}|${key}`);
}

/**
 * Cross-source identity: the same role at the same company, however it is listed.
 *
 * Titles are folded rather than compared loosely. "Sr. Java Engineer" and
 * "Senior Java Engineer" still hash differently, which is the conservative
 * direction — two entries for one role is noise, whereas collapsing two
 * genuinely different roles at one company hides one of them completely.
 */
export function dedupeHashFor(company: string, title: string): string {
  return hash(`${fold(company)}|${fold(title)}`);
}

export function seenEntryFor(posting: RawPosting, status: SeenEntry['status']): SeenEntry {
  return {
    id: postingId(posting.source, posting.key),
    dedupeHash: dedupeHashFor(posting.company, posting.title),
    source: posting.source,
    key: posting.key,
    firstSeenAt: new Date().toISOString(),
    status,
  };
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    // Absent and corrupt both mean "nothing recorded yet". A malformed index
    // must not crash a scheduled run; the worst case is that a posting is
    // reported as new twice, which is visible and harmless.
    return fallback;
  }
}

function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

export function readSeen(): SeenEntry[] {
  return readJsonFile<SeenEntry[]>(SEEN_FILE, []);
}

/**
 * Appends new entries and finishes off unfinished ones.
 *
 * Two rules, and the second one arrived with scoring:
 *
 *  - **`firstSeenAt` belongs to the first sighting.** An entry already present
 *    keeps it rather than being refreshed — the field answers "how long has
 *    this been open?", which a daily overwrite would turn into "today".
 *  - **`deferred` is the only status that can be replaced.** It means "found,
 *    not yet judged", so a later run that judges the posting writes the real
 *    answer over it. Every other status is terminal: nothing may walk a posting
 *    back from `queued` or `sent` to `deferred`, because the run that wrote
 *    those statuses knew something this one does not.
 */
export function recordSeen(additions: SeenEntry[]): SeenEntry[] {
  const existing = readSeen();
  const byId = new Map(existing.map((entry) => [entry.id, entry]));
  let changed = false;

  for (const entry of additions) {
    const known = byId.get(entry.id);

    if (!known) {
      byId.set(entry.id, entry);
      changed = true;
      continue;
    }

    if (known.status === 'deferred' && entry.status !== 'deferred') {
      byId.set(entry.id, { ...known, status: entry.status });
      changed = true;
    }
  }

  if (!changed) return existing;

  const merged = [...byId.values()];
  writeJsonFile(SEEN_FILE, merged);
  return merged;
}

// ─── The review queue ───────────────────────────────────────────────

export function readPending(): QueuedOpportunity[] {
  const parsed = readJsonFile<QueuedOpportunity[]>(PENDING_FILE, []);
  return Array.isArray(parsed) ? parsed : [];
}

export function writePending(queue: QueuedOpportunity[]): void {
  writeJsonFile(PENDING_FILE, queue);
}

/**
 * Adds to the queue without disturbing what is already in it.
 *
 * Three things happen here and all three are load-bearing:
 *
 *  - **Expired entries are removed.** A posting that has waited three weeks for
 *    a decision is either filled or not worth applying to. Expiry is *not* a
 *    decision and never becomes one: nothing is ever recorded as applied
 *    because it timed out (§8).
 *  - **An entry already queued is left alone.** It may have been edited in
 *    `/admin`, and a re-score would overwrite a human's words with a model's.
 *    The exception is an `unscored` entry, which is a placeholder by definition
 *    — when a later run manages to score it, the verdict replaces the gap.
 *  - **`dedupeHash` is checked as well as `id`.** The same role listed on three
 *    boards is one card. Seeing it three times is how a person stops reading
 *    the queue.
 */
export function appendPending(additions: QueuedOpportunity[]): QueuedOpportunity[] {
  const now = Date.now();
  const existing = readPending();

  const live = existing.filter((item) => {
    const expiresAt = Date.parse(item.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= now) {
      logger.info('outreach_queue_expired', {
        job: 'outreach',
        id: item.id,
        company: item.company,
        title: item.title,
      });
      return false;
    }
    return true;
  });

  const byId = new Map(live.map((item) => [item.id, item]));
  const hashes = new Set(live.map((item) => item.dedupeHash));

  for (const item of additions) {
    const known = byId.get(item.id);

    if (known) {
      if (known.status === 'unscored' && item.status === 'queued') byId.set(item.id, item);
      continue;
    }

    if (hashes.has(item.dedupeHash)) continue;

    byId.set(item.id, item);
    hashes.add(item.dedupeHash);
  }

  const queue = [...byId.values()];
  writePending(queue);
  return queue;
}

/** `discoveredAt` + the TTL, as an ISO string. */
export function expiryFrom(discoveredAt: string): string {
  return new Date(Date.parse(discoveredAt) + queueTtlDays() * 86_400_000).toISOString();
}

/** Removes decided items, deleting the file once empty. */
export function removeFromPending(ids: string[]): QueuedOpportunity[] {
  const remaining = readPending().filter((item) => !ids.includes(item.id));
  writePending(remaining);
  return remaining;
}

/** Applies a patch to one queued item. Returns null when it is no longer queued. */
export function patchPending(
  id: string,
  patch: Partial<QueuedOpportunity>,
): QueuedOpportunity | null {
  const queue = readPending();
  const index = queue.findIndex((item) => item.id === id);
  if (index === -1) return null;

  const updated = { ...queue[index], ...patch };
  queue[index] = updated;
  writePending(queue);
  return updated;
}

// ─── Decisions ────────────────────────────────────────────────────────

/**
 * "Not interested", and the company suggestions said no to.
 *
 * Rejections persist for the same reason they do in the refresh job: the queue
 * is *derived* and free to re-derive, while a rejection is a **decision** and
 * the only input the job cannot work out for itself. Without a record of it,
 * "reject" would be indistinguishable from "ignore" and the same role would
 * come back every morning — and a queue that repeats itself daily is one nobody
 * reads.
 *
 * Keyed by `dedupeHash` for opportunities, not by posting id (§17.8): a role
 * said no to must not return next week because a different board listed it.
 */
export function readRejections(): OutreachRejection[] {
  const parsed = readJsonFile<OutreachRejection[]>(REJECTED_FILE, []);
  return Array.isArray(parsed) ? parsed : [];
}

export function recordRejection(rejection: OutreachRejection): OutreachRejection[] {
  const existing = readRejections();
  if (existing.some((entry) => entry.id === rejection.id)) return existing;

  const merged = [...existing, rejection];
  writeJsonFile(REJECTED_FILE, merged);
  return merged;
}

/** Un-rejects, so a decision made in haste is reversible without editing JSON. */
export function clearRejections(ids: string[]): OutreachRejection[] {
  const remaining = readRejections().filter((entry) => !ids.includes(entry.id));
  writeJsonFile(REJECTED_FILE, remaining);
  return remaining;
}

/** The `dedupeHash`es a run must not queue. */
export function rejectedHashes(): Set<string> {
  return new Set(
    readRejections()
      .filter((entry) => entry.kind === 'opportunity')
      .map((entry) => entry.id),
  );
}

// ─── Company suggestions ──────────────────────────────────────────────

export function readSuggestions(): CompanySuggestion[] {
  const parsed = readJsonFile<CompanySuggestion[]>(SUGGESTIONS_FILE, []);
  return Array.isArray(parsed) ? parsed : [];
}

export function removeSuggestion(id: string): CompanySuggestion[] {
  const remaining = readSuggestions().filter((entry) => entry.id !== id);
  writeJsonFile(SUGGESTIONS_FILE, remaining);
  return remaining;
}

/**
 * Adds this morning's proposals without disturbing the ones already there.
 *
 * Appends rather than overwrites, for the same reason `pending.json` does: a
 * suggestion is a card a person has not got to yet, and a run that replaced the
 * file would silently discard Tuesday's proposal because Wednesday found a
 * different company. A suggestion already present is left exactly as it was —
 * re-verifying it would spend a request to rewrite a card that is already on
 * the screen.
 */
export function appendSuggestions(additions: CompanySuggestion[]): CompanySuggestion[] {
  const existing = readSuggestions();
  const byId = new Map(existing.map((entry) => [entry.id, entry]));
  let changed = false;

  for (const suggestion of additions) {
    if (byId.has(suggestion.id)) continue;
    byId.set(suggestion.id, suggestion);
    changed = true;
  }

  const merged = [...byId.values()];
  if (changed) writeJsonFile(SUGGESTIONS_FILE, merged);
  return merged;
}

/**
 * The companies a human has said no to, keyed as §17.2 keys a suggestion.
 *
 * Permanent, unlike the discovery job's own memory of what it tried: a company
 * rejected once must not be re-proposed monthly (§9), and that is a decision
 * rather than a fact about the network.
 */
export function rejectedCompanyKeys(): Set<string> {
  return new Set(
    readRejections()
      .filter((entry) => entry.kind === 'company')
      .map((entry) => entry.id),
  );
}

/**
 * Appends an approved company to the **committed** watch list.
 *
 * This is the one write in the whole system that lands in a file `git` tracks,
 * and that is the point (§9): every change to the watch list shows up in
 * `git diff`, the same "approve, then review the diff" loop the profile refresh
 * uses. The counters that move every morning live in a separate, gitignored
 * sidecar precisely so this file only changes when the list itself does.
 */
export function appendCompany(company: WatchedCompany): WatchedCompany[] {
  const existing = readJsonFile<WatchedCompany[]>(COMPANIES_FILE, []);
  const list = Array.isArray(existing) ? existing : [];

  const fold = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (list.some((entry) => fold(entry.name) === fold(company.name))) return list;

  const merged = [...list, company];
  writeJsonFile(COMPANIES_FILE, merged);
  return merged;
}

// ─── Form handoff ───────────────────────────────────────────────────

/**
 * Records that a form is waiting to be filled on the host.
 *
 * The API runs in the container and a headed browser needs the host's display
 * and the CV file, so the two cannot call each other. §17.1's v1 mechanism is
 * this file plus a copyable command on the card; an RPC from a container to a
 * host GUI process is not worth building for a twice-a-week action.
 */
export function writeHandoff(handoff: Handoff): void {
  writeJsonFile(HANDOFF_FILE, handoff);
}

// ─── Source rotation ─────────────────────────────────────────────────────────

/**
 * Where the last run stopped, so today does not re-read what yesterday already
 * read and never reach what yesterday never reached (§11).
 *
 * A missing or unreadable cursor means "start at the beginning", which is the
 * correct behaviour on a first run and a harmless one on a corrupt file: the
 * cost is that one morning is processed in the default order, and the run
 * writes a fresh cursor on its way out.
 */
export function readCursor(): Cursor | null {
  const cursor = readJsonFile<Cursor | null>(CURSOR_FILE, null);
  if (!cursor || !Array.isArray(cursor.order) || typeof cursor.nextIndex !== 'number') {
    return null;
  }
  return cursor;
}

export function writeCursor(order: string[], nextIndex: number): void {
  writeJsonFile(CURSOR_FILE, {
    order,
    nextIndex,
    updatedAt: new Date().toISOString(),
  } satisfies Cursor);
}

/**
 * The run report — what the job found, as JSON, for a human and for the next
 * phase's admin tab.
 *
 * Overwritten each run rather than accumulated: `seen.json` is the permanent
 * record, and a directory of daily reports is a directory nobody reads. The
 * postings themselves carry no employer prose, only the fields the adapter read
 * verbatim, so this file is safe to `cat`.
 */
export function writeRunReport(run: OutreachRun): string {
  fs.mkdirSync(OUTREACH_DIR, { recursive: true });
  writeJsonFile(RUN_REPORT_FILE, run);
  return RUN_REPORT_FILE;
}

/**
 * The 07:00 job's report, in its own file.
 *
 * Two jobs, two reports, and neither overwrites the other's: they run half an
 * hour apart and the first one's output is still the answer to "why was the
 * morning quiet?" long after the second has finished.
 */
export function writeDiscoveryReport(run: DiscoveryRun): string {
  fs.mkdirSync(OUTREACH_DIR, { recursive: true });
  writeJsonFile(DISCOVERY_REPORT_FILE, run);
  return DISCOVERY_REPORT_FILE;
}
