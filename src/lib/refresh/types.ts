/**
 * Shared shapes for the scheduled profile refresh (`docs/profile-refresh-plan.md`).
 *
 * The type that matters most here is `SourceRecord`, because it encodes the
 * trust boundary the whole job is built around: `facts` were read field-by-field
 * out of an API response and are copied verbatim, `untrusted` is free text that
 * a third party could have written and that only ever reaches stage A.
 */

export type SourceId = 'github' | 'spotify' | 'appleMusic' | 'soundcloud';

/** Which `data/` file a source contributes to. */
export type TargetFile = 'projects.json' | 'music.json';

/** A JSON-ish value an adapter can copy straight out of an API response. */
export type FactValue = string | number | boolean | null | string[];

/**
 * One item from a source — a repository, an album — split along the trust line.
 *
 * Keeping the split in the *type* rather than in a convention means stage B's
 * signature can simply refuse to accept anything carrying `untrusted`, and the
 * compiler enforces that raw third-party prose never reaches the model that
 * edits the profile.
 */
export interface SourceRecord {
  source: SourceId;
  /**
   * Stable identity, used to match this record against an existing profile
   * entry. For GitHub it is the repo's HTML URL; for releases, a normalised
   * title. Must not change between runs or every run proposes duplicates.
   */
  key: string;
  /** Read directly from the API response. Never passed through a model. */
  facts: Record<string, FactValue>;
  /**
   * Free text written by whoever controls the source. UNTRUSTED. Only stage A
   * (`extract.ts`) ever sees this, and only inside a delimited data block.
   */
  untrusted: Record<string, string>;
}

/** What an adapter returns for one run. */
export interface SourceFetch {
  source: SourceId;
  target: TargetFile;
  records: SourceRecord[];
  /** Source-level facts that aren't per-record, e.g. follower counts. */
  summary: Record<string, FactValue>;
  /**
   * Watermark bookkeeping for sources that can skip unchanged items.
   *
   * `upstreamByKey` covers *every* item the source knows about, including the
   * ones it skipped — pruning stale entries needs the full list, not just the
   * processed subset.
   */
  itemState?: {
    upstreamByKey: Map<string, string | null>;
    skippedKeys: Set<string>;
  };
  fetchedAt: string;
}

/**
 * Stage A's output shape, after sanitisation.
 *
 * Deliberately narrow. Every field is a bounded string or a bounded array of
 * bounded strings — there is no free-form field, no nested object and no URL
 * field, because a shape with nowhere to put a payload is much easier to
 * validate than one that tries to detect payloads.
 */
export interface ExtractedFacts {
  key: string;
  /** One-sentence description in the profile's voice. */
  summary: string;
  /** Technologies. Each must be evidenced in the source text — see `sanitize.ts`. */
  tech: string[];
  /** Short bullet points, each a single capability or outcome. */
  highlights: string[];
}

/** A single proposed edit to a `data/` file. */
export interface ProposedChange {
  target: TargetFile;
  /** Human-facing path into the file, e.g. `projects[7].highlights`. */
  path: string;
  op: 'add-entry' | 'add-items' | 'replace-value';
  /** Present for `replace-value`; the value currently in `data/`. */
  before?: unknown;
  after: unknown;
  /** Why the change is proposed. Written by stage B, sanitised like everything else. */
  reason: string;
  source: SourceId;
  /**
   * Which source item this change came from — a repo URL for GitHub.
   *
   * Used to decide whether that item still has something outstanding at the end
   * of a run, which is what `sourceState.ts` needs to know before it is allowed
   * to skip the item next time. Absent for sources without per-item watermarks.
   */
  subjectKey?: string;
}

export interface SourceOutcome {
  source: SourceId;
  status: 'ok' | 'skipped' | 'failed';
  /** Populated for `skipped`/`failed`; a stable identifier, not a sentence. */
  reason?: string;
  recordsFetched: number;
  changesProposed: number;
  /** Sanitiser rejections, kept so a silently-filtering run is still visible. */
  violations: Violation[];
}

/** A sanitiser rejection. `rule` is stable so violations can be counted over time. */
export interface Violation {
  stage: 'extract' | 'edit' | 'source';
  field: string;
  rule: string;
  detail: string;
}

export interface RefreshRun {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  extractModel: string | null;
  editModel: string | null;
  outcomes: SourceOutcome[];
  changes: ProposedChange[];
  proposalPath: string | null;
  applied: boolean;
}
