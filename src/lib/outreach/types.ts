/**
 * Shared shapes for the scheduled job outreach (`docs/job-outreach-plan.md`).
 *
 * The type that matters most here is `RawPosting`, because it encodes the same
 * trust boundary `src/lib/refresh/types.ts` does: `structured` was read
 * field-by-field out of an API response and is copied verbatim, `untrusted` is
 * free text an employer wrote and that only ever reaches stage A. Keeping the
 * split in the *type* means a later stage's signature can simply refuse to
 * accept anything carrying `untrusted`, and the compiler enforces what a
 * convention would only ask for.
 *
 * Phases 0 to 5 are built. `Draft` has a producer, and it is a person: the
 * review tab writes the subject and body by hand, because stage C is phase 6.
 * `send_failed` is still absent — nothing can fail to send until something can
 * send. `CompanySuggestion` and the `Discovery*` shapes below now have one too:
 * the 07:00 job that fills `suggestions.json`.
 */

/** An applicant tracking system we can call directly. §1 of the plan. */
export type AtsId = 'workday' | 'pinpoint' | 'greenhouse' | 'lever' | 'ashby' | 'eightfold';

/** A job board that aggregates many employers. Phase 2. */
export type AggregatorId = 'remotive' | 'remoteok' | 'arbeitnow' | 'himalayas';

export type SourceId = AtsId | AggregatorId;

/** Seniority vocabulary, shared by the preference doc and (from phase 3) stage A. */
export type Seniority = 'junior' | 'mid' | 'senior' | 'staff' | 'principal' | 'lead' | 'unclear';

/**
 * Where Davit may legally work, from the preference doc.
 *
 * A closed vocabulary rather than free text, because this is a *deciding*
 * input: a posting that says "must be authorized to work in the US" is
 * ineligible, and one that says "EU residents only" is not — and the difference
 * between those two answers cannot be left to a model's reading of a sentence.
 * `armenia` is always present; the rest widen the filter.
 */
export type WorkAuthorization = 'armenia' | 'eu' | 'uk' | 'us' | 'canada' | 'eaeu';

/**
 * One company on the watch list — `data/outreach/companies.json`, committed.
 *
 * The endpoint is stored whole rather than reassembled from a slug at call
 * time, because the endpoint is the thing that was actually *verified*. Three
 * name-based guesses at Align's ATS all returned 404 while the plan was being
 * written (§1.2); a stored slug would let that guesswork back in through the
 * side door.
 */
export interface WatchedCompany {
  name: string;
  ats: AtsId;
  /** The verified, callable endpoint. */
  endpoint: string;
  /** Human-facing careers page, for the admin card and for re-detection. */
  careersUrl: string;
  /** Workday only: needed to build detail and public URLs from `externalPath`. */
  workday?: { origin: string; tenant: string; site: string };
  addedAt: string;
  addedBy: 'seed' | 'approved';
}

/**
 * What a run learned about a watched company — `data/outreach/company-stats.json`,
 * gitignored, keyed by company name.
 *
 * §17.2 keeps these four fields on `WatchedCompany` itself. They are split out
 * here because `companies.json` is committed for one specific reason: so that
 * every change to the watch list shows up in `git diff`. Counters that move on
 * every run would leave that file modified every morning, and an actual
 * approval would then arrive as one edit among the noise — which is the thing
 * the commit was supposed to make visible.
 *
 * A company renamed in the watch list starts its counters again. That is a
 * fair trade for the diff staying meaningful: the counters feed staleness
 * suggestions, which are advisory, and §9 never removes anything automatically.
 */
export interface CompanyStats {
  lastCheckedAt?: string;
  lastEligibleAt?: string;
  /** Running total of postings that passed the geo filter, for staleness (§9). */
  eligibleSeen: number;
  /** Three consecutive unreadable runs ⇒ propose re-detection (§9). */
  consecutiveFailures: number;
}

/**
 * What every adapter produces, field-for-field from the API response.
 *
 * `untrusted` is populated only when the adapter already had the text in hand.
 * No adapter fetches a description *in order to* fill it — that is stage A's
 * budget to spend, from phase 3 onwards.
 */
export interface RawPosting {
  source: SourceId;
  /** Stable per source. Must not change between runs or every run reports it as new. */
  key: string;
  company: string;
  title: string;
  url: string;
  /** Whatever the source calls location, normalised to one string. */
  locationText: string;
  postedAt?: string;
  /** Free text the employer wrote. UNTRUSTED — only stage A sees this. */
  untrusted: { description?: string; responsibilities?: string; requirements?: string };
  /** Facts the adapter read directly. These BEAT stage A (§4). */
  structured: {
    workplaceType?: string;
    employmentType?: string;
    compensationMin?: number;
    compensationMax?: number;
    compensationCurrency?: string;
    compensationPeriod?: string;
    /** Present when the source says the range is publishable. Pinpoint has this. */
    compensationVisible?: boolean;
    /**
     * Compensation as the source states it in words, verbatim.
     *
     * Remotive publishes `"$31,2k- $52k"` and Ashby a tier summary like
     * `"EUR110K - EUR185K"`. Parsing a number out of either would invent a
     * precision the board does not have, and this is the field that ends up in
     * front of a hiring manager.
     */
    compensationText?: string;
    /**
     * Acceptable candidate timezones, as UTC offsets. Himalayas publishes this.
     *
     * Yerevan is UTC+4 and has had no DST since 2012, so a published list that
     * omits 4 is a real constraint rather than an inconvenience.
     */
    timezoneOffsets?: number[];
    /**
     * Where the *candidate* may live, as the source states it — not where the
     * office is.
     *
     * Only set by sources that genuinely publish a restriction: Remotive's
     * `candidate_required_location` and Himalayas' `locationRestrictions`. It is
     * deliberately not set from RemoteOK's `location`, which was checked against
     * the live feed and is mostly a city ("Seoul", "Bishkek"), nor from
     * Arbeitnow's, which is the employer's address. A field that means two
     * different things on two boards is worse than an absent one, because the
     * geo filter acts on it.
     */
    candidateRestrictions?: string[];
  };
}

/**
 * The slice of the run's budget an adapter is allowed to see (§17.3).
 *
 * Two methods, both read-only: an adapter may ask whether to keep going, and it
 * may not move the run's stop conditions. `RunBudget` in `budget.ts` implements
 * this and keeps the counter that decides it.
 */
export interface Budget {
  /** True once the run must stop — deadline, duration budget or match count. */
  expired(): boolean;
  /** Wall clock left in ms, for a source deciding whether another page is worth it. */
  remainingMs(): number;
}

/**
 * Why a run ended. Reported as `stoppedBy`, which is how §12 reads the morning.
 *
 * §11 names three stop conditions; `cap` is the fourth, and it is here because
 * the alternative was reporting it as `exhausted`. They mean opposite things to
 * whoever reads a week of these: `exhausted` says every source was read and the
 * watch list is too small, while `cap` says the run filled its memory guard and
 * three sources were never opened.
 */
export type StopReason = 'matches' | 'deadline' | 'budget' | 'cap' | 'exhausted';

/**
 * The shared feed cache (§17.7), as adapters see it.
 *
 * Read-through and deliberately GET-only: caching is for the aggregator feeds
 * the 07:00 job and the 08:00 job both read, and a replayed Workday POST is
 * meaningless against bot management. An adapter that must not be cached simply
 * calls `fetch` itself, which is why this is one method and not a `fetch`
 * replacement.
 */
export interface FetchCache {
  json<T>(url: string, init?: { headers?: Record<string, string> }): Promise<T>;
}

/**
 * What an adapter is handed for one call.
 *
 * `budget` and `cache` are required rather than optional so that every adapter
 * has to have been visited by the phase that introduced them, instead of one
 * adapter silently never checking the deadline.
 */
export interface FetchContext {
  /** Present for ATS adapters; an aggregator fetches once for everyone. */
  company?: WatchedCompany;
  budget: Budget;
  cache: FetchCache;
  log: (event: string, fields: Record<string, unknown>) => void;
}

export interface SourceAdapter {
  id: SourceId;
  /** One call per company (ATS) or one per source (aggregator). */
  fetch(ctx: FetchContext): Promise<RawPosting[]>;
}

/** Per-source result for one run. Mirrors `SourceOutcome` in the refresh job. */
export interface OutreachOutcome {
  source: SourceId;
  company?: string;
  status: 'ok' | 'skipped' | 'failed';
  /** Populated for `skipped`/`failed`; a stable identifier, not a sentence. */
  reason?: string;
  postingsFetched: number;
  /**
   * Rows the adapter produced that could not be addressed — see
   * `sources/validate.ts`. Absent rather than zero when there were none, so a
   * report is silent about a thing that did not happen.
   */
  malformed?: number;
  /** Postings from this unit that reached the review queue. */
  queued?: number;
  /** Passed or flagged by the geo filter. */
  eligible: number;
  /** Eligible, and not seen on an earlier run. */
  newlyFound: number;
}

/** One posting that survived the geo filter, as the phase-1 report prints it. */
export interface FoundPosting {
  id: string;
  dedupeHash: string;
  source: SourceId;
  company: string;
  title: string;
  url: string;
  locationText: string;
  verdict: 'pass' | 'flag';
  /** Which geo rule decided it, so the report can be audited. */
  rule: string;
  postedAt?: string;
  isNew: boolean;
  /**
   * What stage B made of it, when a model was available.
   *
   * A flattened copy of the fields a person scanning a terminal wants, rather
   * than the whole `FitVerdict`: the queue in `pending.json` is the record, and
   * this is the run's summary of it.
   */
  assessment?: {
    eligibility: FitVerdict['eligibility'];
    fit: number;
    recommendation: FitVerdict['recommendation'];
    evidence: string;
    flags: string[];
  };
}

export interface OutreachRun {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** False until phase 3; phases 1 and 2 never open a model. */
  scored: boolean;
  /** Which of the three stop conditions ended the run (§11). */
  stoppedBy: StopReason;
  outcomes: OutreachOutcome[];
  found: FoundPosting[];
  /** Postings the geo filter dropped, counted rather than listed. */
  droppedByGeo: number;
  /** Eligible postings already recorded in `seen.json` on an earlier run. */
  alreadySeen: number;
  /**
   * Postings fetched but never reached, because the run stopped first.
   *
   * Recorded in `seen.json` as `deferred` so tomorrow starts with them rather
   * than re-deriving the same list (§11). An early stop is a pause, not a
   * discard.
   */
  deferred: number;
  /**
   * Cards the queue actually *gained* this run — not queue writes.
   *
   * A posting already in `pending.json` is re-judged, because it is still
   * unfinished work, and rewritten if its verdict improved. It is not news
   * though: it has been on the screen since the morning it arrived. This is
   * what the early stop counts and what the notification reports, because both
   * are statements about what a person has not seen yet.
   */
  queued: number;
  /** Of those, how many have no verdict — a link and a title, honestly labelled. */
  unscored: number;
  /** Judged `skip` and therefore never shown. Counted here so the count is visible (§7). */
  skippedByScore: number;
  /**
   * Records the sanitiser refused. Counted apart from `skippedByScore` because
   * the two mean opposite things: a skip is scoring working, a refusal is
   * scoring not having happened.
   */
  rejected: number;
  /**
   * Eligible postings passed over because a human had already answered for
   * them — "not interested", or already in the ledger. Counted so that a queue
   * that stays quiet because the decisions are working is distinguishable from
   * one that is quiet because the filters broke.
   */
  decided: number;
  /** Sanitiser rejections, by rule. The number that says whether stage A is being attacked. */
  violations: OutreachViolation[];
  /** Work units the run never opened at all. Tomorrow's cursor starts here. */
  unreachedUnits: string[];
  reportPath: string | null;
  /** Populated only under `--explain`; one line per posting the run considered. */
  explain?: ExplainLine[];
}

/**
 * One posting's geo decision, printed by `--explain` (§19.3).
 *
 * Collected only when asked for. A filter you cannot audit is a filter you stop
 * trusting, and this is what makes "why was that dropped?" answerable without
 * adding a debugger to a scheduled job.
 */
export interface ExplainLine {
  source: SourceId;
  company: string;
  title: string;
  url: string;
  locationText: string;
  verdict: 'pass' | 'drop' | 'flag';
  rule: string;
  evidence: string;
}

/**
 * Source rotation across runs — `data/outreach/cursor.json` (§11).
 *
 * A budgeted crawler has one classic failure: whatever it processes first gets
 * processed every day, and the tail is never read. `order` is the unit list as
 * the last run saw it and `nextIndex` points at the first unit that run did not
 * reach, so today starts there and wraps.
 */
export interface Cursor {
  order: string[];
  nextIndex: number;
  updatedAt: string;
}

// ─── Stage A ─────────────────────────────────────────────────────────

/** How the work is contracted, which decides whether a "remote" role is reachable at all. */
export type Engagement = 'employee' | 'contractor' | 'eor' | 'unclear';

export type WorkMode = 'remote' | 'hybrid' | 'onsite' | 'unclear';

/**
 * What stage A pulls out of one posting's text (§4).
 *
 * Narrow on purpose, and the narrowness is the mitigation rather than a
 * convenience: every field is a bounded string or a bounded array of bounded
 * strings, there is no free-form field, and there is nowhere nested to hide a
 * payload. That is what lets `sanitize.ts` check the whole shape exhaustively,
 * which is not possible against a schema with an open object in it.
 *
 * Three of these fields are quoted rather than paraphrased, and the sanitiser
 * enforces it: `officeLocation`, `geoRestriction` and `compensation` are where
 * a hallucination becomes a wasted application or a wrong salary expectation,
 * and all three genuinely appear verbatim in postings that have them.
 */
export interface ExtractedPosting {
  /** Echoed back for matching. The adapter's value wins; a mismatch is a signal. */
  key: string;
  title: string;
  company: string;
  seniority: Seniority;
  engagement: Engagement;
  workMode: WorkMode;
  /** For the local-office family. Quoted. */
  officeLocation: string;
  /** Quoted from the posting, never paraphrased. */
  geoRestriction: string;
  timezoneRequirement: string;
  /** Each entry must appear in the source text, or it is dropped. */
  stack: string[];
  responsibilities: string[];
  /** Verbatim or empty. Never a number the model worked out. */
  compensation: string;
  applyMethod: 'form' | 'email' | 'unclear';
  /** An email address or a URL, checked against the posting's own domain. */
  applyTarget: string;
}

// ─── Stage B ─────────────────────────────────────────────────────────

/**
 * What stage B decides (§7).
 *
 * `needs_check` is a first-class outcome, not a hedge. A posting saying "remote,
 * global, contractors welcome" and one saying "remote" and nothing else are not
 * the same posting, and pretending a model can tell them apart is how you apply
 * to a job that needs a US social security number.
 */
export interface FitVerdict {
  eligibility: 'eligible' | 'needs_check' | 'ineligible';
  /** The quoted sentence that decided it. Must be traceable to a sanitised field. */
  eligibilityEvidence: string;
  /** 0–100. */
  fit: number;
  reasons: string[];
  /** `salary_required` | `relocation` | `below_seniority` | `local_role` | ... */
  flags: string[];
  /**
   * What to do about it. Only `draft` and `surface_only` reach the queue;
   * `skip` items are counted in the run summary and never shown, because a
   * review queue containing things you would never do is a queue you stop
   * reading.
   */
  recommendation: 'draft' | 'surface_only' | 'skip';
}

/**
 * A sanitiser rejection. `rule` is stable so violations can be counted over time.
 *
 * Deliberately not `refresh`'s `Violation`: that type's `stage` vocabulary is
 * `extract | edit | source`, which describes a different pipeline. The rule
 * names are shared, because they come from the same rule tables.
 */
export interface OutreachViolation {
  stage: 'extract' | 'score';
  field: string;
  rule: string;
  detail: string;
}

// ─── The review queue ───────────────────────────────────────────────

/**
 * One posting in `data/outreach/pending.json` (§17.2).
 *
 * **This queues rather than being overwritten**, which is the opposite of the
 * refresh job's pending proposal and for the opposite reason. A profile diff is
 * only meaningful against the `data/` it was computed from, so it is disposable
 * and re-derivable. A job posting is an external event with its own lifetime,
 * and missing one costs a real opportunity.
 *
 * `unscored` means exactly one thing: `verdict` is null. The Mac was away, or
 * the posting had no text left to read, so it is here as a link with a real
 * title and nothing that pretends to be a judgement. Six unscored links beat an
 * empty morning, and the next run that has a model scores it and replaces the
 * placeholder. `extracted` may be present without a verdict — stage A can
 * succeed and stage B still be unreachable.
 */
export interface QueuedOpportunity {
  id: string;
  dedupeHash: string;
  company: string;
  title: string;
  /** The posting itself, for a human. The only thing on the card that is not an opinion. */
  url: string;
  source: SourceId;
  discoveredAt: string;
  /** `discoveredAt` + `OUTREACH_QUEUE_TTL_DAYS`. */
  expiresAt: string;
  extracted: ExtractedPosting | null;
  verdict: FitVerdict | null;
  /**
   * The message, when there is one. Written by hand in `/admin` until stage C
   * exists; `model` says which.
   */
  draft: Draft | null;
  /**
   * `awaiting_form` is a handoff a human has to finish and confirm — it is
   * deliberately *not* counted as applied and *not* released back into the
   * queue, because guessing either way is worse than asking (§8.1).
   * `send_failed` arrives with the code that can fail to send.
   */
  status: 'unscored' | 'queued' | 'awaiting_form';
  /** Set by `Snooze`. Postponing is not a decision, so it does not touch the ledger. */
  snoozedUntil?: string;
}

/**
 * What would be sent, exactly as it would be sent.
 *
 * §3's third rule: no message is composed by the same call that decides to send
 * it. Stage C drafts and stage D transmits a stored, approved, byte-identical
 * draft — regenerating at send time would mean the approved text and the sent
 * text can differ, which makes the approval meaningless. The same holds for a
 * draft a person typed.
 */
export interface Draft {
  subject: string;
  /** Includes the fixed disclosure line once stage C appends it (§7). */
  body: string;
  /** From `extracted.applyTarget`, domain-checked. Empty until there is one. */
  to: string;
  /** `human` until stage C exists. Never invented — this is an audit field. */
  model: string;
  draftedAt: string;
}

// ─── The ledger and the decisions ────────────────────────────────────────

/**
 * One application that has gone out, by any channel — `data/outreach/applied.json`.
 *
 * The most important file this system owns (§8.1). It is never pruned, it is
 * backed up on every write, and it is the only defence against the one
 * unrecoverable error here: applying twice to the same role, which reads to the
 * recipient as either careless or automated.
 *
 * `channel: 'manual'` is the row the original design missed. A system that
 * remembers only what *it* sent will confidently apply to a role Davit emailed
 * about last month, so "Already applied" writes one of these and sends nothing.
 */
export interface AppliedApplication {
  /** Absent for a manual entry with no known posting. */
  id?: string;
  /** The field every duplicate check actually uses. */
  dedupeHash: string;
  company: string;
  title: string;
  url?: string;
  appliedAt: string;
  /** `manual` = Davit applied himself, recorded after the fact. */
  channel: 'email' | 'form' | 'manual';
  /** Present for `email`. Exactly what was transmitted (§8.1). */
  to?: string;
  subject?: string;
  body?: string;
  providerMessageId?: string;
  /** Set when `OUTREACH_DRY_RUN` was on, so a rehearsal is never mistaken for a send. */
  dryRun?: true;
  /** Set when this was a deliberate second attempt; names the first one's date. */
  reapplicationOf?: string;
}

/**
 * "Not interested" — `data/outreach/rejected.json`.
 *
 * Keyed by `dedupeHash` rather than by posting id, so a role said no to does not
 * come back next week because a different board listed it. It writes **neither
 * the ledger nor the cooldown**: a rejection is not an application, and letting
 * it consume the per-company budget would mean saying no to one bad role at
 * NVIDIA blocked a good one for a month (§8).
 */
export interface OutreachRejection {
  /** The `dedupeHash` of the role, which is what suppression is keyed on. */
  id: string;
  kind: 'opportunity' | 'company';
  summary: string;
  rejectedAt: string;
}

/**
 * The 07:00 job's output — `data/outreach/suggestions.json`.
 *
 * Declared in phase 4 because the review tab is what consumes it, and a view is
 * a producer of the shape it renders. Phase 5 fills the file: every field below
 * is something `verify.ts` proved by calling the endpoint, which is why the
 * card can show the endpoint in full and the posting counts beside it.
 */
export interface CompanySuggestion {
  /** `sha256(folded name)`, so a rejection stays keyed to the company for ever. */
  id: string;
  name: string;
  careersUrl: string;
  ats: AtsId;
  /** Shown in full on the card: it is the thing that was actually verified. */
  endpoint: string;
  /**
   * Workday only, and it has to travel with the suggestion rather than being
   * re-derived on approval: the adapter builds detail and public URLs from
   * these three, and they were parsed out of the URL the marker was found in.
   * Rebuilding them in the approval route would be exactly the reassembly
   * `endpoint` is stored whole to avoid.
   */
  workday?: { origin: string; tenant: string; site: string };
  verifiedAt: string;
  postingCount: number;
  eligibleCount: number;
  /** Real postings, so the claim below can be checked against them. */
  evidence: { title: string; url: string }[];
  why: string;
  /** Set when the watch list is at its cap and this would displace someone. */
  displaces?: string;
}

// ─── The 07:00 discovery run (§9) ───────────────────────────────────

/**
 * Why the discovery run ended.
 *
 * §12 names three of these. `candidates` and `backlog` are here for the same
 * reason `cap` joined `StopReason` in phase 2: reporting them as `exhausted`
 * would tell whoever reads a week of mornings that the candidate list had run
 * dry, when in fact the run stopped with names still in the queue. They mean
 * opposite things — `exhausted` says generate more candidates, `candidates`
 * says the attempt budget is the binding constraint, and `backlog` says the
 * person is.
 */
export type DiscoveryStopReason =
  | 'suggestions'
  | 'deadline'
  | 'budget'
  | 'candidates'
  | 'backlog'
  | 'exhausted';

/** One candidate the run discarded, with the reason §12 counts. */
export interface DiscoveryRejection {
  company: string;
  origin: string;
  /** A stable slug from `verify.ts`, never a sentence. */
  reason: string;
  detail?: string;
}

/**
 * A watch-list company §9's hygiene rules have something to say about.
 *
 * Surfaced, never acted on. A quiet quarter at a company Davit cares about is
 * not a reason to stop watching it, so this is a line in a report and a log
 * event — there is no code path anywhere that removes a company.
 */
export interface CompanyHygiene {
  company: string;
  /** `stale` — nothing eligible in OUTREACH_STALE_COMPANY_DAYS. `redetect` — three unreadable runs. */
  kind: 'stale' | 'redetect';
  lastEligibleAt?: string;
  eligibleSeen?: number;
  consecutiveFailures?: number;
}

/**
 * What the 07:00 job did — `data/outreach/last-discovery.json`.
 *
 * Separate from `OutreachRun` rather than a variant of it, because the two jobs
 * answer different questions and a shared shape would have to carry both sets
 * of counters with half of them always zero. §9: "It asks a different question
 * and deserves its own answer."
 */
export interface DiscoveryRun {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stoppedBy: DiscoveryStopReason;
  /** The aggregator reads, which double as this run's gift to the 08:00 one. */
  feeds: OutreachOutcome[];
  /** Candidates generated, after everything already known was filtered out. */
  considered: number;
  /** Of those, how many were actually put through verification. */
  attempted: number;
  /** New suggestions written this run. A run that verifies nothing is normal (§9). */
  suggested: CompanySuggestion[];
  /** Everything waiting in `suggestions.json` afterwards, including earlier mornings'. */
  pending: number;
  rejections: DiscoveryRejection[];
  /**
   * Companies seen today with no address to check them at, best first.
   *
   * §9's first two candidate tiers assume a company in the aggregator results
   * is a candidate with its evidence attached, and the evidence is — but the
   * *address* is not. Every URL the four feeds publish points back at the feed,
   * so a name from them cannot be verified without one open-web query, which
   * §9's fourth tier is about and which this repo has no credential for. So the
   * tier degrades honestly: these are names worth a look, offered to whoever
   * reads the morning's report, and a line in `candidates.txt` with a careers
   * URL turns any of them into a verified card tomorrow. See §23.
   */
  unresolved: { company: string; origin: string; note: string }[];
  /** How many there were before the report bounded the list. */
  unresolvedTotal: number;
  hygiene: CompanyHygiene[];
  watchlistSize: number;
  reportPath: string | null;
}

/** One pending form handoff — written by the API, read by the host (§17.1). */
export interface Handoff {
  id: string;
  requestedAt: string;
}
