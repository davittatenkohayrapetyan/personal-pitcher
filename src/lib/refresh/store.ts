import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { ProposedChange, SourceOutcome } from './types';
import { PROPOSAL_DIR } from './config';

/**
 * The store behind the review workflow.
 *
 * ## One pending proposal, regenerated every run
 *
 * There is exactly one pending proposal at a time (`pending.json`), and every
 * scheduled run overwrites it. Nothing queues up.
 *
 * That is a deliberate choice about what a missed notification means. The
 * alternative — accumulating proposals — would mean a week away produces seven
 * overlapping diffs, several of which contradict each other because each was
 * computed against a `data/` that has since moved. A proposal is only meaningful
 * relative to the profile it was diffed against, so an un-reviewed one is not
 * *lost* when the next run replaces it: the same gap will simply be re-derived
 * from whatever `data/` looks like tomorrow. Miss a notification and nothing
 * breaks; you just review a fresher version of the same thing.
 *
 * ## Rejections do persist
 *
 * "Regenerate from scratch" and "remember rejections" sound contradictory but
 * are not. The pending proposal is a *derived* artifact, so throwing it away
 * costs nothing. A rejection is a *decision*, and it is the only input the job
 * cannot re-derive from the sources. Without a record of it, "reject" would be
 * indistinguishable from "ignore" — the same change would return every single
 * day, and a report that repeats itself daily is one nobody reads.
 *
 * How much of a change its identity covers depends on the operation, because
 * stage B rewords free prose on every run and a naive whole-content hash never
 * matches twice — see `fingerprint` and `itemFingerprint`. Briefly: a rejected
 * description rewrite suppresses *rewrites of that field*, a rejected new
 * project suppresses *that repo*, and a rejected list addition suppresses *those
 * items* while leaving genuinely new ones free to surface.
 */

const PENDING_FILE = path.join(PROPOSAL_DIR, 'pending.json');
const REJECTED_FILE = path.join(PROPOSAL_DIR, 'rejected.json');

/** A change with a stable identity, so the UI can address it and rejections can outlive it. */
export interface IdentifiedChange extends ProposedChange {
  /** Content fingerprint — see `fingerprint()`. Stable across runs. */
  id: string;
}

export interface PendingProposal {
  /** Run timestamp. Changes whenever the proposal is regenerated. */
  generatedAt: string;
  extractModel: string | null;
  editModel: string | null;
  outcomes: SourceOutcome[];
  changes: IdentifiedChange[];
}

export interface RejectionRecord {
  id: string;
  path: string;
  op: string;
  summary: string;
  rejectedAt: string;
  /**
   * Per-item identities for an `add-items` rejection. Present only for that op —
   * see `itemFingerprint` for why those are rejected item-by-item rather than as
   * a whole change.
   */
  itemIds?: string[];
}

/**
 * Identity of a change, for matching a rejection against future proposals.
 *
 * `reason` and `source` are always excluded — the reason is model-written prose
 * that varies run to run for an identical edit, so including it would expire
 * every rejection after a day.
 *
 * **How much of `after` counts depends on the operation**, and getting this
 * wrong was an observed bug rather than a hypothetical one. Rejecting a
 * description rewrite on 15 Sep did not suppress the next night's: stage B had
 * reworded the same edit, the hash differed, and the change came back. A report
 * that returns every morning is one that stops being read.
 *
 * So:
 *
 *  - `add-items` — hashed **with** the items. These are per-item decisions:
 *    rejecting "add Gradle to tech" must not also suppress "add Docker".
 *  - `replace-value` — hashed **without** the value. Rejecting a rewrite of a
 *    free-text field means "this field reads fine as it is", not "not these
 *    exact words"; the model will never produce those exact words twice anyway.
 *  - `add-entry` — hashed on the subject, not the drafted content. Rejecting a
 *    new project means "this repo does not belong in the portfolio", a decision
 *    about the repo rather than about the paragraph proposed for it.
 *
 * All three stay reversible from `/admin`, which is what makes the broader
 * suppressions safe to prefer.
 */
export function fingerprint(change: ProposedChange): string {
  const material =
    change.op === 'add-items'
      ? JSON.stringify([change.target, change.path, change.op, change.after])
      : change.op === 'add-entry'
        ? JSON.stringify([change.target, change.op, change.subjectKey ?? change.path])
        : JSON.stringify([change.target, change.path, change.op]);

  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);
}

export function identify(changes: ProposedChange[]): IdentifiedChange[] {
  return changes.map((change) => ({ ...change, id: fingerprint(change) }));
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    // Absent or corrupt both mean "nothing pending". A malformed pending file
    // must not crash a scheduled run — the next write replaces it anyway.
    return fallback;
  }
}

function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(PROPOSAL_DIR, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

// ─── Pending proposal ────────────────────────────────────────────────────────

export function readPending(): PendingProposal | null {
  return readJsonFile<PendingProposal | null>(PENDING_FILE, null);
}

/** Overwrites whatever was pending. See the header for why that is safe. */
export function writePending(proposal: PendingProposal): void {
  writeJsonFile(PENDING_FILE, proposal);
}

export function clearPending(): void {
  try {
    fs.unlinkSync(PENDING_FILE);
  } catch {
    // Already gone is the desired end state.
  }
}

/**
 * Removes specific changes from the pending proposal, deleting it once empty.
 *
 * An empty pending file and no pending file would render identically, but the
 * distinction matters to the scheduled run's "is there anything to notify
 * about" check, and to anyone reading the directory.
 */
export function removeFromPending(ids: string[]): PendingProposal | null {
  const pending = readPending();
  if (!pending) return null;

  const remaining = pending.changes.filter((change) => !ids.includes(change.id));

  if (remaining.length === 0) {
    clearPending();
    return null;
  }

  const updated = { ...pending, changes: remaining };
  writePending(updated);
  return updated;
}

// ─── Rejections ──────────────────────────────────────────────────────────────

export function readRejections(): RejectionRecord[] {
  return readJsonFile<RejectionRecord[]>(REJECTED_FILE, []);
}

export function recordRejections(changes: IdentifiedChange[]): void {
  const existing = readRejections();
  const known = new Set(existing.map((r) => r.id));

  const added = changes
    .filter((change) => !known.has(change.id))
    .map((change) => ({
      id: change.id,
      path: change.path,
      op: change.op,
      summary: describe(change),
      rejectedAt: new Date().toISOString(),
      ...(change.op === 'add-items' && Array.isArray(change.after)
        ? { itemIds: change.after.map((item) => itemFingerprint(change, item)) }
        : {}),
    }));

  if (added.length > 0) writeJsonFile(REJECTED_FILE, [...existing, ...added]);
}

/** Un-rejects, so a decision made in haste is reversible without editing JSON. */
export function clearRejections(ids: string[]): void {
  const remaining = readRejections().filter((r) => !ids.includes(r.id));
  writeJsonFile(REJECTED_FILE, remaining);
}

/**
 * Identity of a single item inside an `add-items` change.
 *
 * `add-items` is rejected per item rather than per change, because the change as
 * a whole is a moving target: stage B re-derives highlights from the README each
 * night and rewords them slightly, so a whole-change hash never matches twice
 * and the rejection never bites. Per item, "I don't want *that* highlight" is a
 * durable decision, while a genuinely new item still surfaces.
 */
function itemFingerprint(change: ProposedChange, item: unknown): string {
  const material = JSON.stringify([change.target, change.path, 'item', item]);
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/**
 * Drops what the reviewer has already said no to. Applied before writing pending.
 *
 * Two shapes of suppression, matching the two shapes of rejection:
 *
 *  - Whole change, by `id` — for `replace-value` and `add-entry`.
 *  - Individual items, for `add-items`. A change whose items are *all* rejected
 *    disappears; one with something new left is re-issued carrying only the new
 *    items, and re-identified because narrowing `after` changes its identity.
 */
export function filterRejected(changes: IdentifiedChange[]): IdentifiedChange[] {
  const records = readRejections();
  const rejectedChangeIds = new Set(records.map((r) => r.id));
  const rejectedItemIds = new Set(records.flatMap((r) => r.itemIds ?? []));

  const kept: IdentifiedChange[] = [];

  for (const change of changes) {
    if (rejectedChangeIds.has(change.id)) continue;

    if (change.op !== 'add-items' || !Array.isArray(change.after)) {
      kept.push(change);
      continue;
    }

    const survivors = change.after.filter(
      (item) => !rejectedItemIds.has(itemFingerprint(change, item)),
    );

    if (survivors.length === 0) continue;
    if (survivors.length === change.after.length) {
      kept.push(change);
      continue;
    }

    const narrowed = { ...change, after: survivors };
    kept.push({ ...narrowed, id: fingerprint(narrowed) });
  }

  return kept;
}

/** One-line human description, used in the rejection log and in Pushover. */
export function describe(change: ProposedChange): string {
  if (change.op === 'add-entry') {
    const entry = change.after as { name?: string };
    return `Add project "${entry?.name ?? 'unknown'}"`;
  }
  if (change.op === 'add-items') {
    const items = change.after as unknown[];
    return `Add ${items.length} item(s) to ${change.path}`;
  }
  return `Replace ${change.path}`;
}
