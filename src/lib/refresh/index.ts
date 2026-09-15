import type {
  ProposedChange,
  RefreshRun,
  SourceFetch,
  SourceId,
  SourceOutcome,
} from './types';
import { enabledSources, editModel, extractModel } from './config';
import { openRefreshModel, type RefreshModel } from './llm';
import { extractRecords } from './extract';
import { proposeEdits } from './edit';
import {
  applyChanges,
  diffMusic,
  indexProjectsByUrl,
  loadMusic,
  loadProjects,
  proposeNewProject,
  toneExamples,
  writeProposal,
  writeSnapshot,
} from './propose';
import { fetchGitHub, GitHubRateLimitError } from './sources/github';
import { fetchSpotify, SpotifyNotConfiguredError } from './sources/spotify';
import { fetchAppleMusic } from './sources/appleMusic';
import { fetchSoundCloud } from './sources/soundcloud';
import {
  clearPending,
  describe,
  filterRejected,
  identify,
  writePending,
  type IdentifiedChange,
} from './store';
import { reviewUrl } from './config';
import { recordSourceState } from './sourceState';
import { logger } from '../logger';
import { sendAlert } from '../pushover';

/**
 * The scheduled profile refresh, end to end.
 *
 * Fetch (deterministic adapters) → stage A (reads untrusted text, narrow schema)
 * → programmatic sanitisation → stage B (edits the profile, never sees raw text)
 * → proposal. See `docs/profile-refresh-plan.md` for why the boundary sits where
 * it does.
 *
 * ## Degrading rather than failing
 *
 * Every stage can be absent and the run still produces something useful:
 *
 *  - No Spotify credentials → that adapter reports `not_configured`; Apple Music
 *    needs no key, so the music section still refreshes.
 *  - Mac asleep → both model stages are skipped. Sources are still fetched and
 *    snapshotted, and the music diff — which needs no model — still runs. Only
 *    the GitHub prose work waits for tomorrow.
 *  - Everything down → the run reports it and alerts once.
 *
 * A job that reported "failed" because a laptop was closed would be a job whose
 * output nobody reads.
 */

type Fetcher = () => Promise<SourceFetch>;

const FETCHERS: Record<SourceId, Fetcher> = {
  github: fetchGitHub,
  spotify: fetchSpotify,
  appleMusic: fetchAppleMusic,
  soundcloud: fetchSoundCloud,
};

export interface RefreshOptions {
  /** Write accepted changes into `data/` as well as into a proposal. */
  apply?: boolean;
  /** Skip both model stages. Useful for exercising the adapters alone. */
  noModel?: boolean;
}

function emptyOutcome(source: SourceId): SourceOutcome {
  return { source, status: 'ok', recordsFetched: 0, changesProposed: 0, violations: [] };
}

/**
 * GitHub → `projects.json`.
 *
 * Split in two because the two cases genuinely differ: a repo with no entry
 * needs a whole entry drafted from stage A's output, while a repo that already
 * has one needs stage B to work out what that entry is missing. Only the second
 * is an editing problem.
 */
async function refreshProjects(
  fetched: SourceFetch,
  models: { extract: RefreshModel | null; edit: RefreshModel | null },
  outcome: SourceOutcome,
): Promise<{ changes: ProposedChange[]; processedKeys: Set<string> }> {
  if (!models.extract) {
    outcome.status = 'skipped';
    outcome.reason = 'no_model_available';
    return { changes: [], processedKeys: new Set() };
  }

  const projects = loadProjects();
  const byUrl = indexProjectsByUrl(projects);
  const tone = toneExamples(projects);

  const extracted = await extractRecords(models.extract, fetched.records);
  outcome.violations.push(...extracted.violations);

  const changes: ProposedChange[] = [];

  for (const facts of extracted.facts) {
    const url = facts.key.replace(/\/+$/, '');
    const position = byUrl.get(url);

    if (position === undefined) {
      changes.push(proposeNewProject(facts, url));
      continue;
    }

    if (!models.edit) continue;

    const entry = projects[position];
    const result = await proposeEdits(models.edit, {
      source: 'github',
      target: 'projects.json',
      // Keyed by URL rather than index so the proposal survives the array being
      // reordered between the run and the review — see `applyChanges`.
      path: `projects[${url}]`,
      subjectKey: url,
      entry: {
        name: entry.name,
        description: entry.description,
        tech: entry.tech ?? [],
        highlights: entry.highlights ?? [],
      },
      facts,
      toneExamples: tone,
    });

    outcome.violations.push(...result.violations);
    changes.push(...result.changes);
  }

  // Only repos that made it through extraction count as processed. A repo whose
  // model call failed or whose output the sanitiser refused produced no changes,
  // and treating "no changes" as "in sync" would mark it clean and skip it
  // forever — a silent permanent hole, from a transient failure.
  return { changes, processedKeys: new Set(extracted.facts.map((f) => f.key)) };
}

export async function runRefresh(options: RefreshOptions = {}): Promise<RefreshRun> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const sources = enabledSources();

  logger.info('refresh_started', { sources, apply: Boolean(options.apply) });

  // Opened once for the whole run rather than per source. A run is minutes long
  // — twenty repos at ~20s a call — so a Mac that goes to sleep partway through
  // is possible, but re-probing per source would not save it either: the failure
  // surfaces as a per-record `model-call-failed` violation, which is a more
  // precise report than a mid-run gate flip would give.
  const extractGate = options.noModel
    ? ({ ok: false, reason: 'no_model_requested' } as const)
    : await openRefreshModel('extract', extractModel());
  const editGate = options.noModel
    ? ({ ok: false, reason: 'no_model_requested' } as const)
    : await openRefreshModel('edit', editModel());

  const models = {
    extract: extractGate.ok ? extractGate.model : null,
    edit: editGate.ok ? editGate.model : null,
  };

  const outcomes: SourceOutcome[] = [];
  const changes: ProposedChange[] = [];
  // Kept so watermarks can be written *after* rejection filtering — an item whose
  // only proposals were rejected is in sync, and marking it otherwise would make
  // it reprocess forever.
  const fetchedBySource = new Map<SourceId, SourceFetch>();
  /** Keys that genuinely completed the pipeline this run — not merely fetched. */
  const processedBySource = new Map<SourceId, Set<string>>();

  for (const source of sources) {
    const outcome = emptyOutcome(source);
    outcomes.push(outcome);

    let fetched: SourceFetch;
    try {
      fetched = await FETCHERS[source]();
    } catch (err) {
      // A missing credential and a spent rate limit are both *configuration*,
      // not incidents: neither means the source broke, and both are fixed by
      // editing `.env` rather than by debugging. Classing them as failures would
      // fire the Pushover alert that is supposed to mean "something is wrong",
      // every day, until someone stopped reading it.
      const isConfiguration =
        err instanceof SpotifyNotConfiguredError || err instanceof GitHubRateLimitError;

      outcome.status = isConfiguration ? 'skipped' : 'failed';
      outcome.reason =
        err instanceof SpotifyNotConfiguredError
          ? 'not_configured'
          : err instanceof Error
            ? err.message
            : String(err);
      // A missing credential is a configuration choice, not an incident — it
      // must not log at the same level as a source that actually broke, or the
      // one real failure gets lost among three routine warnings.
      if (outcome.status === 'failed') {
        logger.warn('refresh_source_failed', { source, reason: outcome.reason });
      } else {
        logger.info('refresh_source_skipped', { source, reason: outcome.reason });
      }
      continue;
    }

    outcome.recordsFetched = fetched.records.length;
    fetchedBySource.set(source, fetched);
    writeSnapshot(fetched);

    const before = changes.length;

    if (fetched.target === 'projects.json') {
      const result = await refreshProjects(fetched, models, outcome);
      changes.push(...result.changes);
      processedBySource.set(source, result.processedKeys);
    } else {
      // Music is pure structured data — no model in this path at all. See
      // `diffMusic` for why that is a decision rather than an omission.
      const result = diffMusic(fetched, loadMusic());
      outcome.violations.push(...result.violations);
      changes.push(...result.changes);
    }

    outcome.changesProposed = changes.length - before;
  }

  const run: RefreshRun = {
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    extractModel: models.extract?.model ?? null,
    editModel: models.edit?.model ?? null,
    outcomes,
    changes,
    proposalPath: null,
    applied: false,
  };

  // Fingerprint every change, then drop the ones already rejected in `/admin`.
  // A rejection is the only decision the job cannot re-derive from the sources,
  // so it is the one thing that survives regeneration — see `store.ts`.
  const identified = filterRejected(identify(changes));
  const suppressed = changes.length - identified.length;
  run.changes = identified;

  // The report is written first, unconditionally, and overwrites the previous
  // one. An un-reviewed proposal is not *lost* when replaced: the same gap gets
  // re-derived from whatever `data/` looks like on the next run.
  run.proposalPath = writeProposal(run);

  if (identified.length > 0) {
    writePending({
      generatedAt: startedAt,
      extractModel: run.extractModel,
      editModel: run.editModel,
      outcomes,
      changes: identified,
    });
  } else {
    // Nothing outstanding, so nothing should be sitting in `/admin` either.
    clearPending();
  }

  if (options.apply && identified.length > 0) {
    applyChanges(identified);
    run.applied = true;
    clearPending();
    logger.info('refresh_applied', { changes: identified.length });
  }

  // Watermarks last, and computed from what is *actually left pending* — after
  // rejection filtering and after any `--apply`. An item is in sync when nothing
  // is outstanding for it, which is the only condition under which skipping it
  // next run cannot lose work. See `sourceState.ts`.
  const pendingKeys = new Set(
    (run.applied ? [] : identified)
      .map((change) => change.subjectKey)
      .filter((key): key is string => Boolean(key)),
  );

  for (const [source, fetched] of fetchedBySource) {
    if (!fetched.itemState) continue;

    recordSourceState(source, {
      upstreamByKey: fetched.itemState.upstreamByKey,
      // Taken from what actually completed, not from "everything we fetched".
      // A `--no-model` run, a sleeping Mac, or a single failed extraction all
      // leave items unprocessed, and marking those in sync would skip them
      // permanently on the strength of work that never happened.
      processedKeys: processedBySource.get(source) ?? new Set(),
      pendingKeys,
      presentKeys: new Set(fetched.itemState.upstreamByKey.keys()),
    });
  }

  logger.info('refresh_completed', {
    durationMs: run.durationMs,
    extractModel: run.extractModel,
    editModel: run.editModel,
    changes: identified.length,
    suppressedByRejection: suppressed,
    skippedUnchanged: [...fetchedBySource.values()].reduce(
      (total, f) => total + (f.itemState?.skippedKeys.size ?? 0),
      0,
    ),
    violations: outcomes.reduce((total, o) => total + o.violations.length, 0),
    outcomes: outcomes.map((o) => ({
      source: o.source,
      status: o.status,
      reason: o.reason,
      records: o.recordsFetched,
      changes: o.changesProposed,
    })),
  });

  notify(run);
  return run;
}

/**
 * Pushover, following the rules in `CLAUDE.md`'s observability section.
 *
 * `kind` is stable across runs so the 1h throttle works — a source that stays
 * broken must not push once per scheduled run forever. And a run that found
 * nothing sends nothing: a weekly "no changes" notification is a notification
 * that gets muted, and a muted channel is not a monitor.
 */
function notify(run: RefreshRun): void {
  const failed = run.outcomes.filter((o) => o.status === 'failed');

  if (failed.length > 0) {
    sendAlert({
      kind: 'profile_refresh_failed',
      title: 'Profile refresh: source failed',
      message: failed.map((o) => `${o.source}: ${o.reason}`).join('\n'),
    });
    return;
  }

  if (run.changes.length === 0) return;

  const changes = run.changes as IdentifiedChange[];

  sendAlert({
    kind: 'profile_refresh_proposal',
    title: `Profile refresh: ${changes.length} change(s) to review`,
    message: [
      ...changes.slice(0, 5).map((c) => `• ${describe(c)}`),
      changes.length > 5 ? `…and ${changes.length - 5} more` : '',
      '',
      `Review: ${reviewUrl()}`,
    ]
      .filter(Boolean)
      .join('\n'),
    // Low priority: a daily "there is something to look at", not an incident.
    // The alert that should actually buzz is a source failing, above.
    priority: -1,
  });
}
