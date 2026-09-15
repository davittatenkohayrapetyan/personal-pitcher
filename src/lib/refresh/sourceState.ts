import fs from 'fs';
import path from 'path';
import type { SourceId } from './types';
import { SNAPSHOT_DIR } from './config';

/**
 * Per-item watermarks, so a source item that has not changed is not reprocessed.
 *
 * ## The problem this solves
 *
 * The GitHub adapter was re-reading every repository on every nightly run and
 * putting each one through both model stages, whether or not anything about it
 * had moved. Measured on the real schedule: 19 repos, **22 minutes on 13 Sep and
 * 28 minutes on 14 Sep**, mostly spent asking a 26B model to re-derive
 * descriptions for projects that had not been touched in months. The same
 * overlapping changes were then re-proposed each night.
 *
 * GitHub already publishes the answer. Every repo carries `pushed_at`, and the
 * repository *list* endpoint returns it for all repos in a single request — so
 * the decision to skip costs nothing, and a skipped repo then avoids two API
 * calls (README + languages) and two model calls.
 *
 * ## Why a watermark alone is not enough
 *
 * The obvious design — record `pushed_at` after processing, skip when it matches
 * — silently loses work. A proposal is regenerated from scratch each run (see
 * `store.ts`), so if a repo produced an un-reviewed change on Monday and is
 * skipped on Tuesday, that change simply disappears before anyone saw it.
 *
 * So the watermark carries a second field: `inSync`, meaning *the profile had
 * nothing outstanding for this item at the end of that run*. A repo is skipped
 * only when **both** hold — unchanged upstream **and** nothing pending. A repo
 * with unresolved proposals keeps being reprocessed nightly until those are
 * approved or rejected, which is exactly the behaviour that makes a missed
 * notification harmless.
 *
 * The steady state is the good one: once everything is reviewed, a nightly run
 * costs one API call and no model time at all.
 */

export interface ItemState {
  /** `pushed_at` from GitHub as of the run that last processed this item. */
  upstreamAt: string;
  /** When this project last went through the pipeline. */
  refreshedAt: string;
  /**
   * True when that run left nothing pending for this item. False means there are
   * un-reviewed proposals, so it must be reprocessed even if upstream is quiet.
   */
  inSync: boolean;
}

export type SourceState = Record<string, ItemState>;

function stateFile(source: SourceId): string {
  return path.join(SNAPSHOT_DIR, `${source}.state.json`);
}

export function readSourceState(source: SourceId): SourceState {
  try {
    return JSON.parse(fs.readFileSync(stateFile(source), 'utf-8')) as SourceState;
  } catch {
    // Missing or corrupt both mean "nothing is known", which degrades to
    // processing everything — slow, but never wrong.
    return {};
  }
}

export function writeSourceState(source: SourceId, state: SourceState): void {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  fs.writeFileSync(stateFile(source), `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

/**
 * Whether `key` can be skipped this run.
 *
 * Both conditions, deliberately — see the header for why `inSync` is not
 * optional. A missing entry is never skippable, so a new repo is always
 * processed the first time it appears.
 */
export function canSkip(state: SourceState, key: string, upstreamAt: string | null): boolean {
  const entry = state[key];
  if (!entry || !upstreamAt) return false;
  return entry.inSync && entry.upstreamAt === upstreamAt;
}

/**
 * Records the outcome of a run for the items it actually looked at.
 *
 * `pendingKeys` are the items that still have un-reviewed changes; everything
 * else that was processed is marked in sync. Items that were *skipped* this run
 * keep their existing entry untouched — re-stamping `refreshedAt` for work that
 * did not happen would make the file a log of runs rather than of facts.
 *
 * `presentKeys` prunes repos that no longer exist (deleted, archived, made
 * private), so the file cannot grow forever with entries nothing will ever match.
 */
export function recordSourceState(
  source: SourceId,
  args: {
    /** Every key the source returned this run, with its current upstream stamp. */
    upstreamByKey: Map<string, string | null>;
    /** Keys that went through the pipeline (i.e. were not skipped). */
    processedKeys: Set<string>;
    /** Keys with un-reviewed changes after rejection filtering. */
    pendingKeys: Set<string>;
    /** Keys the source still knows about, for pruning. */
    presentKeys: Set<string>;
  },
): void {
  const previous = readSourceState(source);
  const next: SourceState = {};
  const now = new Date().toISOString();

  for (const key of args.presentKeys) {
    const upstreamAt = args.upstreamByKey.get(key) ?? null;

    if (!args.processedKeys.has(key)) {
      // Skipped: carry the existing entry forward verbatim.
      if (previous[key]) next[key] = previous[key];
      continue;
    }

    if (!upstreamAt) {
      // No upstream stamp means nothing to compare against next time, so there
      // is no basis on which to skip it later. Recording it would be a lie.
      continue;
    }

    next[key] = {
      upstreamAt,
      refreshedAt: now,
      inSync: !args.pendingKeys.has(key),
    };
  }

  writeSourceState(source, next);
}
