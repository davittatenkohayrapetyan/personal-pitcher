import fs from 'fs';
import path from 'path';
import type {
  ExtractedFacts,
  ProposedChange,
  RefreshRun,
  SourceFetch,
  Violation,
} from './types';
import type { ProfileEntry } from './edit';
import { DATA_DIR, PROPOSAL_DIR, SNAPSHOT_DIR } from './config';
import { LIMITS, sanitizeSourceValue } from './sanitize';
import { formatDisplayTime } from '../time';

/**
 * Turning fetched data into a reviewable diff, and — only when explicitly asked
 * — into an edit of `data/`.
 *
 * ## Why a proposal rather than a write
 *
 * This originally had two reasons, and only one of them still holds — worth
 * recording, because the weaker one is the kind that quietly outlives its truth.
 *
 * The reason that is gone: `data/` used to be baked into the image with no
 * mount, so a runtime write was physically pointless. `docker-compose.yml` now
 * bind-mounts `./data`, precisely so the `/admin` review flow can write. Anyone
 * reasoning from "the deployment makes writes impossible" is reasoning from a
 * fact that expired.
 *
 * The reason that remains, and was always the stronger one: this is the file
 * that represents Davit professionally, every answer on the public site is
 * generated from it, and the run that proposes edits is unattended and driven
 * partly by text from third-party servers. A human reads the diff.
 */

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8')) as T;
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(path.join(DATA_DIR, file), `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

// ─── projects.json ───────────────────────────────────────────────────────────

export interface ProjectEntry extends ProfileEntry {
  category: string;
  url?: string;
}

export function loadProjects(): ProjectEntry[] {
  return readJson<{ projects: ProjectEntry[] }>('projects.json').projects;
}

/** Index by repo URL — the identity `projects.json` already stores. */
export function indexProjectsByUrl(projects: ProjectEntry[]): Map<string, number> {
  const index = new Map<string, number>();
  projects.forEach((project, position) => {
    if (project.url) index.set(project.url.replace(/\/+$/, ''), position);
  });
  return index;
}

/**
 * A handful of existing entries, rendered as tone reference for stage B.
 *
 * Passed as *voice*, explicitly not as content — the prompt says so, and stage B
 * has no way to cite them anyway since its output is checked against the facts
 * it was given, not against these.
 */
export function toneExamples(projects: ProjectEntry[], limit = 3): string[] {
  return projects
    .filter((project) => project.highlights?.length)
    .slice(0, limit)
    .map((project) => `${project.description} | ${project.highlights[0]}`);
}

/**
 * A repo with no matching entry in `projects.json`.
 *
 * Proposed as a whole new entry rather than routed through stage B, which only
 * knows how to amend an existing one. `category` is fixed to the value the file
 * already uses for public repos rather than asked for: taxonomy is Davit's, and
 * there are exactly two categories, one of which describes client work a public
 * repo by definition is not.
 */
export function proposeNewProject(facts: ExtractedFacts, repoUrl: string): ProposedChange {
  return {
    target: 'projects.json',
    path: 'projects[]',
    op: 'add-entry',
    after: {
      name: facts.key.split('/').pop() ?? facts.key,
      category: 'Public GitHub Project',
      description: facts.summary,
      tech: facts.tech,
      url: repoUrl,
      highlights: facts.highlights,
    },
    reason: 'Public repository with no matching entry in projects.json',
    source: 'github',
    subjectKey: repoUrl,
  };
}

// ─── music.json ──────────────────────────────────────────────────────────────

interface Release {
  title: string;
  year: number;
  url?: string | null;
  spotifyId?: string | null;
  appleId?: number | null;
  latest?: boolean;
}

interface MusicFile {
  music: {
    albums: Release[];
    eps: Release[];
    singles: Release[];
    links: Record<string, string>;
    stats: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export function loadMusic(): MusicFile['music'] {
  return readJson<MusicFile>('music.json').music;
}

function fold(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Diffs a music source against `music.json` without involving a model at all.
 *
 * A release is a title, a year and a URL. There is no prose to rewrite and no
 * judgement to make, so putting a 26B model in this path would add latency, a
 * hallucination risk and a dependency on the Mac being awake, in exchange for
 * nothing. Stage A is skipped for these records for the same reason.
 *
 * Additive only: a release that `music.json` lists but the API does not is left
 * alone. Streaming catalogs lose regional availability for reasons that have
 * nothing to do with whether a record exists, and silently deleting an artist's
 * back catalogue on the strength of one API response would be wrong.
 */
export function diffMusic(
  fetched: SourceFetch,
  current: MusicFile['music'],
): { changes: ProposedChange[]; violations: Violation[] } {
  const changes: ProposedChange[] = [];
  const violations: Violation[] = [];

  const known = new Set(
    [...current.albums, ...current.eps, ...current.singles].map((r) => fold(r.title)),
  );

  for (const record of fetched.records) {
    const title = String(record.facts.title ?? '');
    const checked = sanitizeSourceValue(`${fetched.source}.title`, title, LIMITS.title);
    if (!checked.ok || !checked.value) {
      violations.push(...checked.violations);
      continue;
    }
    if (known.has(fold(checked.value))) continue;

    const kind = String(record.facts.kind ?? 'single');
    const bucket = kind === 'album' ? 'albums' : kind === 'ep' ? 'eps' : 'singles';

    changes.push({
      target: 'music.json',
      path: `music.${bucket}`,
      op: 'add-items',
      after: [
        {
          title: checked.value,
          year: record.facts.year,
          url: record.facts.url,
          ...(record.facts.spotifyId ? { spotifyId: record.facts.spotifyId } : {}),
          ...(record.facts.appleId ? { appleId: record.facts.appleId } : {}),
        },
      ],
      reason: `Released ${record.facts.releaseDate} and listed on ${fetched.source}, but absent from music.json`,
      source: fetched.source,
    });

    // Guards against Apple and Spotify each proposing the same release in one run.
    known.add(fold(checked.value));
  }

  // Follower counts move on their own and are stamped with `asOf`, so a changed
  // number is reported as a replacement rather than an addition.
  if (typeof fetched.summary.followers === 'number') {
    const before = (current.stats as { followers?: number }).followers;
    if (before !== fetched.summary.followers) {
      changes.push({
        target: 'music.json',
        path: 'music.stats.followers',
        op: 'replace-value',
        before,
        after: fetched.summary.followers,
        reason: `Spotify reports ${fetched.summary.followers} followers; music.json says ${before}`,
        source: fetched.source,
      });
    }
  }

  return { changes, violations };
}

// ─── Output ──────────────────────────────────────────────────────────────────

/**
 * Snapshots what a source actually returned.
 *
 * Committed, so the *input* to a proposal is diffable too. When a future run
 * proposes something odd, the question is always "did the source change or did
 * the model?", and without the snapshot that question has no answer.
 */
export function writeSnapshot(fetched: SourceFetch): string {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const file = path.join(SNAPSHOT_DIR, `${fetched.source}.raw.json`);

  // `itemState` is dropped rather than serialised: it holds a Map and a Set,
  // both of which `JSON.stringify` silently renders as `{}`. Two empty objects
  // in a committed snapshot are worse than no field at all — they look like
  // data that failed to load. The real watermarks live in `<source>.state.json`.
  const { itemState: _itemState, ...serialisable } = fetched;

  fs.writeFileSync(file, `${JSON.stringify(serialisable, null, 2)}\n`, 'utf-8');
  return file;
}

function renderMarkdown(run: RefreshRun): string {
  const lines: string[] = [
    `# Profile refresh — ${formatDisplayTime(run.startedAt)}`,
    '',
    `Duration: ${(run.durationMs / 1000).toFixed(1)}s · extract: ${run.extractModel ?? 'skipped'} · edit: ${run.editModel ?? 'skipped'}`,
    '',
    '## Sources',
    '',
    '| Source | Status | Records | Changes | Violations |',
    '|---|---|---|---|---|',
    ...run.outcomes.map(
      (o) =>
        `| ${o.source} | ${o.status}${o.reason ? ` (${o.reason})` : ''} | ${o.recordsFetched} | ${o.changesProposed} | ${o.violations.length} |`,
    ),
    '',
  ];

  if (run.changes.length === 0) {
    lines.push('## Proposed changes', '', 'None — the profile is up to date with every source.', '');
  } else {
    lines.push(`## Proposed changes (${run.changes.length})`, '');
    for (const change of run.changes) {
      lines.push(`### \`${change.path}\` — ${change.op}`, '');
      lines.push(`*${change.reason}* (${change.source})`, '');
      if (change.before !== undefined) {
        lines.push('Before:', '', '```json', JSON.stringify(change.before, null, 2), '```', '');
      }
      lines.push('After:', '', '```json', JSON.stringify(change.after, null, 2), '```', '');
    }
  }

  const violations = run.outcomes.flatMap((o) => o.violations);
  if (violations.length > 0) {
    lines.push(
      `## Sanitiser rejections (${violations.length})`,
      '',
      'Values a model produced that were refused. A cluster of `ungrounded` is a model',
      'inventing; anything from the injection or infra rules is worth reading in full.',
      '',
      '| Stage | Field | Rule | Detail |',
      '|---|---|---|---|',
      ...violations.map(
        (v) => `| ${v.stage} | ${v.field} | \`${v.rule}\` | ${v.detail.replace(/\|/g, '\\|').slice(0, 80)} |`,
      ),
      '',
    );
  }

  lines.push(
    '## Applying',
    '',
    'Review at `/login` → `/admin`, where each change can be approved, rejected or',
    'edited. Approving writes to `data/` and the assistant picks it up immediately;',
    'the statically-imported explore cards still need a rebuild.',
    '',
    'From the CLI instead: `npm run refresh:profile -- --apply` applies everything',
    'unreviewed, which is the blunt version of the same thing.',
    '',
  );

  return lines.join('\n');
}

/**
 * Writes the human-readable run report.
 *
 * Overwritten each run rather than timestamped, for the same reason the pending
 * proposal is (see `store.ts`): a report is only meaningful against the `data/`
 * it was diffed from, so yesterday's would be a stale file nobody can safely act
 * on. The *reviewable* artifact is `pending.json`, which `/admin` reads; this
 * one is for reading over SSH.
 */
export function writeProposal(run: RefreshRun): string {
  fs.mkdirSync(PROPOSAL_DIR, { recursive: true });
  const mdPath = path.join(PROPOSAL_DIR, 'latest.md');
  fs.writeFileSync(mdPath, renderMarkdown(run), 'utf-8');
  return mdPath;
}

/**
 * Writes accepted changes into `data/`. Only ever reached via `--apply`.
 *
 * Deliberately dumb: it applies exactly what the proposal says, having already
 * been read by a person. All the judgement lives upstream — this function's only
 * job is to not corrupt the file while doing what it was told.
 */
export function applyChanges(changes: ProposedChange[]): void {
  const projectChanges = changes.filter((c) => c.target === 'projects.json');
  const musicChanges = changes.filter((c) => c.target === 'music.json');

  if (projectChanges.length > 0) {
    const projects = loadProjects();
    const byUrl = indexProjectsByUrl(projects);

    for (const change of projectChanges) {
      if (change.op === 'add-entry') {
        projects.push(change.after as ProjectEntry);
        continue;
      }

      // `projects[<url>].<field>` — resolved by URL rather than by index, so a
      // proposal stays valid even if the array was reordered since it was written.
      const match = /^projects\[(.+)\]\.(description|tech|highlights)$/.exec(change.path);
      if (!match) continue;
      const position = byUrl.get(match[1]);
      if (position === undefined) continue;

      const entry = projects[position];
      const field = match[2] as 'description' | 'tech' | 'highlights';

      if (change.op === 'replace-value' && field === 'description') {
        entry.description = change.after as string;
      } else if (change.op === 'add-items' && field !== 'description') {
        entry[field] = [...entry[field], ...(change.after as string[])];
      }
    }

    writeJson('projects.json', { projects });
  }

  if (musicChanges.length > 0) {
    const music = loadMusic();

    for (const change of musicChanges) {
      if (change.path === 'music.stats.followers') {
        (music.stats as Record<string, unknown>).followers = change.after;
        (music.stats as Record<string, unknown>).asOf = new Date().toISOString().slice(0, 7);
        continue;
      }

      const match = /^music\.(albums|eps|singles)$/.exec(change.path);
      if (!match) continue;
      const bucket = match[1] as 'albums' | 'eps' | 'singles';
      music[bucket] = [...music[bucket], ...(change.after as Release[])].sort(
        (a, b) => b.year - a.year,
      );
    }

    writeJson('music.json', { music });
  }
}
