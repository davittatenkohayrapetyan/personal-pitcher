import type {
  ExplainLine,
  ExtractedPosting,
  FetchContext,
  FitVerdict,
  FoundPosting,
  OutreachOutcome,
  OutreachRun,
  OutreachViolation,
  QueuedOpportunity,
  RawPosting,
  SourceId,
  StopReason,
  WatchedCompany,
} from './types';
import {
  isAggregator,
  maxPostingsPerRun,
  requestedSources,
  runBudgetMs,
  runDeadline,
  reviewUrl,
  stageModel,
  stopAfterMatches,
} from './config';
import { RunBudget, resolveDeadline } from './budget';
import { openCache } from './cache';
import { geoVerdict } from './geo';
import { loadPreferences, type Preferences } from './preferences';
import { openOutreachModel, type OutreachModel } from './llm';
import { extractPosting } from './extract';
import { isHostile } from './sanitize';
import { scorePosting } from './score';
import { readWatchlist, matchCompany, recordChecks, type CheckResult } from './watchlist';
import { readApplied } from './ledger';
import {
  appendPending,
  dedupeHashFor,
  expiryFrom,
  postingId,
  readCursor,
  readPending,
  readSeen,
  readSuggestions,
  rejectedHashes,
  recordSeen,
  seenEntryFor,
  writeCursor,
  writeRunReport,
  type SeenEntry,
} from './store';
import { validatePostings } from './sources/validate';
import { hydrateWorkday, WorkdayBlockedError } from './sources/workday';
import { ATS_ADAPTERS, AGGREGATOR_ADAPTERS, type Fetcher } from './sources/registry';
import { logger } from '../logger';
import { isPushoverConfigured, sendAlert } from '../pushover';

/**
 * The 08:00 opportunity run, end to end.
 *
 * Watch list -> ATS adapters -> aggregators -> deterministic geo filter ->
 * dedupe -> stage A -> the sanitiser -> stage B -> a review queue. No browser
 * and no email: the only things that leave this process are public GETs and
 * POSTs to job boards, and one LAN call per posting to a model that has no
 * tools and no credentials.
 *
 * ## What the budget is for
 *
 * The run ends on whichever comes first (§11): the wall-clock deadline, the
 * duration budget, or `OUTREACH_STOP_AFTER_MATCHES` queue-worthy postings. All three are the same
 * object, because an adapter asking "should I make another request?" does not
 * care which of them has fired.
 *
 * The third condition is the one that needs saying out loud: **an early stop is
 * a pause, not a discard.** Postings that were fetched and never reached are
 * written to `seen.json` as `deferred`, and the source cursor records which
 * feeds the run never opened. Tomorrow starts with both, so the tail of the
 * source list is read every few days rather than never — which is the classic
 * failure of a budgeted crawler and the reason §11 specifies a rotation at all.
 *
 * ## What counts toward the early stop
 *
 * A posting **added to the review queue this run** — §11's own words. That is
 * `draft` and `surface_only` verdicts, and postings queued as `unscored`
 * because no model was available to judge them. What it is emphatically not is
 * `skip`: a morning of 200 junior React postings must not "find its matches"
 * and stop before reaching anything real (§7).
 *
 * A posting an earlier run already judged is reported and passed over. Only
 * unfinished work — never seen, or seen and left `deferred` — is scored, which
 * is what makes the resumption real: yesterday's deferred postings are today's
 * first work, not postings today skips because it recognises them.
 *
 * ## Degrading rather than failing
 *
 * Every stage can be absent and the run still produces something useful. A
 * source that fails is recorded against its unit and the run continues — one
 * blocked board must not cost the morning's other findings. A Mac that is away
 * costs the verdicts, not the queue: postings arrive as `unscored` links with
 * real titles, and the next run that finds a model replaces the placeholder.
 * The exit code is the script's business; this function reports and never
 * throws.
 */

type LogFn = (event: string, fields: Record<string, unknown>) => void;

export interface OutreachOptions {
  /** Skip every model stage. Phases 1 and 2 have none, so this only affects the report. */
  noModel?: boolean;
  /** Collect a per-posting record of which geo rule decided it. */
  explain?: boolean;
  /** `--source=workday`, overriding `OUTREACH_SOURCES`. */
  sources?: SourceId[];
  /** `--company=nvidia`, matched loosely against the watch list. */
  company?: string;
  /** `--max=N`, overriding `OUTREACH_MAX_POSTINGS_PER_RUN`. */
  max?: number;
  /** `--deadline=HH:MM` in `DISPLAY_TIMEZONE`, overriding `OUTREACH_RUN_DEADLINE`. */
  deadline?: string;
  /** `--no-cache`: refetch every feed, for when a board has changed shape. */
  noCache?: boolean;
}

/**
 * One fetchable thing: a company on an ATS, or an aggregator feed.
 *
 * The unit is what the cursor rotates over and what the budget is checked
 * between, so it has to be the granularity at which work is genuinely
 * independent — a company's whole board, or a feed's whole front page.
 */
interface WorkUnit {
  /** `workday:NVIDIA` or `remotive`. Stable across runs; the cursor stores it. */
  id: string;
  source: SourceId;
  company?: WatchedCompany;
  fetch: Fetcher;
}

/** Everything an employer wrote about one posting, as one string for the filter. */
function untrustedBlob(posting: RawPosting): string {
  return Object.values(posting.untrusted).filter(Boolean).join(' ');
}

/** The two model stages, opened once per run. Either may be absent. */
interface Models {
  extract: OutreachModel | null;
  score: OutreachModel | null;
}

/**
 * Fetches a description for a posting whose adapter did not carry one.
 *
 * Only Workday needs this, and only for rows that stated their location in the
 * list and therefore never had their detail record read. It is done here rather
 * than in the adapter because of what it costs: one request against a
 * bot-managed host per posting, and the adapter has no idea which of its twenty
 * rows will survive the geo filter and reach a model. By this point the budget
 * has narrowed that to a handful.
 */
async function hydrate(posting: RawPosting, company: WatchedCompany | undefined, log: LogFn) {
  if (posting.source !== 'workday' || !company) return posting;
  if (Object.values(posting.untrusted).some((value) => value?.trim())) return posting;

  const detail = await hydrateWorkday(company, posting.key, log);
  if (!detail?.description) return posting;

  return {
    ...posting,
    untrusted: { ...posting.untrusted, description: detail.description },
    structured: {
      ...posting.structured,
      employmentType: posting.structured.employmentType ?? detail.employmentType,
    },
  };
}

interface Judgement {
  /** Null when nothing reached the queue: a `skip` verdict, or a refused record. */
  queued: QueuedOpportunity | null;
  verdict: FitVerdict | null;
  seenStatus: SeenEntry['status'];
  violations: OutreachViolation[];
  /**
   * Set when the sanitiser refused the record rather than a verdict saying no.
   *
   * The two are counted apart because they mean opposite things about the
   * system: `skip` is scoring working, and a refusal is scoring not having
   * happened. Reporting a refusal as "skipped by scoring" would hide the one
   * number that says whether stage A is being attacked or is falling over.
   */
  rejected?: true;
}

/**
 * Stage A, the sanitiser, stage B, and the decision about what to do with the
 * answer — for one posting.
 *
 * The three outcomes are deliberately not symmetrical, because what they mean
 * for tomorrow's run is not symmetrical either:
 *
 *  - **Judged, and worth a look** (`draft` or `surface_only`): queued, and
 *    `seen.json` records `queued`. Terminal. Tomorrow leaves it alone.
 *  - **Judged, and not worth a look** (`skip`): not queued, and `seen.json`
 *    records `skipped`. Also terminal — §7 is explicit that `skip` items are
 *    counted in the summary and never shown, because a review queue containing
 *    things you would never do is a queue you stop reading.
 *  - **Not judged** (no model, a model that failed, a posting with no text
 *    left to read): queued as `unscored`, and `seen.json` stays `deferred`.
 *    *Not* terminal, which is the point — a link with a real title beats an
 *    empty morning (§11), and the next run that has a model scores it and
 *    replaces the placeholder.
 *
 * A record the sanitiser *rejected* splits those last two cases in half, and
 * `isHostile()` is where the line is drawn. A posting whose text attacked the
 * extractor is terminal — retrying it tomorrow breaks the same rule and spends
 * the same battery. A generation that simply fell apart is not: the posting is
 * fine and the model wobbled, so it stays `deferred` for another morning.
 *
 * One inefficiency is accepted knowingly. When the budget expires between the
 * two stages, the extraction is queued but `seen.json` stays `deferred`, so the
 * next run extracts the same posting again rather than reading the struct back
 * out of `pending.json`. It costs one model call in the narrow window where a
 * deadline lands between stage A and stage B, and the alternative is threading
 * the queue into the scorer so that two stores have to agree about what has
 * been done to a posting.
 */
async function judgePosting(
  posting: RawPosting,
  company: WatchedCompany | undefined,
  models: Models,
  preferences: Preferences,
  budget: RunBudget,
  log: LogFn,
): Promise<Judgement> {
  const violations: OutreachViolation[] = [];
  const discoveredAt = new Date().toISOString();

  const base = {
    id: postingId(posting.source, posting.key),
    dedupeHash: dedupeHashFor(posting.company, posting.title),
    company: posting.company,
    title: posting.title,
    url: posting.url,
    source: posting.source,
    discoveredAt,
    expiresAt: expiryFrom(discoveredAt),
    // No drafting stage yet (§14, phase 6). A queued card offers an empty
    // subject and body for a human to fill, which is the same shape stage C
    // will produce and therefore needs no migration when it arrives.
    draft: null,
    // No loop ran, so there is nothing to explain. `draftLoop.ts` fills this
    // when it writes the draft; a hand-typed one leaves it null for ever.
    draftRecord: null,
  };

  const placeholder = (extracted: ExtractedPosting | null): Judgement => ({
    queued: { ...base, extracted, verdict: null, status: 'unscored' },
    verdict: null,
    seenStatus: 'deferred',
    violations,
  });

  if (!models.extract) return placeholder(null);

  const hydrated = await hydrate(posting, company, log);
  const extraction = await extractPosting(models.extract, hydrated);
  violations.push(...extraction.violations);

  if (!extraction.extracted) {
    // The sanitiser refused the record. Final only when the *posting* was the
    // problem: a hostile text will be hostile again tomorrow, while a
    // generation that fell apart mid-field is worth one more attempt on another
    // morning. See `isHostile` for the live case that made the distinction.
    if (extraction.reason === 'rejected' && isHostile(extraction.violations)) {
      return { queued: null, verdict: null, seenStatus: 'skipped', violations, rejected: true };
    }

    // A posting with no text left to read after hydration is queued as a link
    // and marked done. Nothing about it will be different tomorrow, and leaving
    // it `deferred` means re-hydrating it every morning — for a Workday row that
    // is a daily request against a bot-managed host, for ever, to learn the same
    // nothing.
    if (extraction.reason === 'no_text') {
      return { ...placeholder(null), seenStatus: 'queued' };
    }

    return placeholder(null);
  }

  if (!models.score || budget.expired()) return placeholder(extraction.extracted);

  const scoring = await scorePosting(
    models.score,
    extraction.extracted,
    preferences,
    hydrated.structured,
  );
  violations.push(...scoring.violations);

  // No `isHostile` check here, and that is not an omission. Stage B's input is
  // the sanitised struct plus typed preferences — by construction it contains no
  // unsanitised posting text — so a content rule firing on its output means the
  // scorer degenerated, never that the posting attacked anything. Treating that
  // as a permanent decision would lose a good role to one bad generation, which
  // is the failure the extract-stage split exists to prevent.
  if (!scoring.verdict) return placeholder(extraction.extracted);

  if (scoring.verdict.recommendation === 'skip') {
    return { queued: null, verdict: scoring.verdict, seenStatus: 'skipped', violations };
  }

  return {
    queued: {
      ...base,
      extracted: extraction.extracted,
      verdict: scoring.verdict,
      status: 'queued',
    },
    verdict: scoring.verdict,
    seenStatus: 'queued',
    violations,
  };
}

/**
 * Builds the run's two tiers of work.
 *
 * **The watch list is read first, every run, in watch-list order.** These are
 * the companies Davit chose one at a time and approved individually (§9), and
 * each costs a single HTTP call — one against NVIDIA's board is worth more than
 * one against a board of everybody's jobs. Rotating them would mean the two
 * best sources in the system got read every few mornings instead of every
 * morning, which an early stop partway through the list makes certain rather than
 * likely.
 *
 * **Only the aggregators rotate.** They are the tier where the fairness problem
 * actually exists: four interchangeable feeds, any of which can eat the rest of
 * a budget, and none of which has a claim to being read before the others. §11
 * asks for both "cheapest-and-highest-yield first" and "resuming where the
 * previous run stopped" without saying how the two compose; this is the
 * composition, and §23 records it.
 */
function buildUnits(
  sources: SourceId[],
  companies: WatchedCompany[],
  outcomes: OutreachOutcome[],
): { ats: WorkUnit[]; aggregators: WorkUnit[] } {
  const ats: WorkUnit[] = [];
  const aggregators: WorkUnit[] = [];

  for (const company of companies) {
    const fetch = ATS_ADAPTERS[company.ats];

    // Checked before the `--source` filter, and that order is the whole point:
    // `eightfold` is a valid `AtsId` with no adapter, and it is not in
    // `ALL_SOURCES`, so a filter-first test made this branch unreachable and a
    // watch-list entry using it vanished in silence. A company being paid for
    // on every run and never read is exactly the thing this report exists to
    // say out loud.
    if (!fetch) {
      outcomes.push({
        source: company.ats,
        company: company.name,
        status: 'skipped',
        reason: 'not_implemented',
        postingsFetched: 0,
        eligible: 0,
        newlyFound: 0,
      });
      continue;
    }

    // An explicit `--source=` or `OUTREACH_SOURCES` narrowing is a decision
    // someone made, so it passes over quietly.
    if (!sources.includes(company.ats)) continue;

    ats.push({ id: `${company.ats}:${company.name}`, source: company.ats, company, fetch });
  }

  for (const source of sources) {
    if (!isAggregator(source)) continue;
    const fetch = AGGREGATOR_ADAPTERS[source];
    if (!fetch) continue;
    aggregators.push({ id: source, source, fetch });
  }

  return { ats, aggregators };
}

/**
 * Rotates the aggregator tier so it starts where the last run stopped.
 *
 * A unit the stored cursor names but this run does not have — a source disabled
 * in `OUTREACH_SOURCES` — falls back to starting at the beginning. That loses
 * one run's worth of fairness rather than silently skipping units, which is the
 * failure worth avoiding.
 */
function rotateToCursor(units: WorkUnit[]): WorkUnit[] {
  const cursor = readCursor();
  if (!cursor || units.length === 0) return units;

  const resumeAt = cursor.order[cursor.nextIndex];
  if (!resumeAt) return units;

  const index = units.findIndex((unit) => unit.id === resumeAt);
  if (index <= 0) return units;

  return [...units.slice(index), ...units.slice(0, index)];
}

/**
 * Opens both model stages, or reports that there is no model.
 *
 * A run with no model is an ordinary morning, not an error path: adapters and
 * the geo filter need nothing, so postings still reach the queue as `unscored`
 * links with real titles. `--no-model` takes the same route deliberately, which
 * is what makes it a faithful rehearsal of a day when the Mac is at the office.
 */
async function openModels(noModel: boolean): Promise<Models> {
  if (noModel) {
    logger.info('outreach_scoring_skipped', { job: 'outreach', stage: 'both', reason: 'no_model_flag' });
    return { extract: null, score: null };
  }

  const extract = await openOutreachModel('extract');
  if (!extract.ok) {
    logger.info('outreach_scoring_skipped', {
      job: 'outreach',
      stage: 'both',
      reason: extract.reason,
    });
    return { extract: null, score: null };
  }

  // One gate when both stages resolve to the same model, which is the default
  // and the recommended configuration. Opening a second would mean a second
  // reachability probe against a machine that has just answered one — and, with
  // the paid fallback enabled, a second `macBreaker.onFailure()` for a single
  // absent Mac, which is the whole `MAC_CB_FAILURE_THRESHOLD` of 2 spent in one
  // line of code.
  if (stageModel('extract') === stageModel('score')) {
    return { extract: extract.model, score: extract.model };
  }

  const score = await openOutreachModel('score');
  if (!score.ok) {
    // Said out loud. Without this the run pays for a full stage A on every
    // posting, queues every one of them `unscored`, and reports itself as
    // scored — a morning where every verdict was lost, looking like a normal one.
    logger.warn('outreach_scoring_skipped', {
      job: 'outreach',
      stage: 'score',
      reason: score.reason,
    });
  }

  return { extract: extract.model, score: score.ok ? score.model : null };
}

/**
 * One notification, when there is something to look at.
 *
 * §12's rules, and each one is a rule about *not* sending:
 *
 *  - **A run with nothing new sends nothing.** A daily "no jobs today" push
 *    gets muted, and a muted channel is not a monitor. The count that decides
 *    this is the queue gain, not the number of postings fetched — a morning
 *    that read three hundred postings and queued none has nothing to say.
 *  - **Priority -1**, because this should not buzz. The one that buzzes is
 *    `outreach_application_sent`, which arrives with the code that sends.
 *  - **A stable `kind`**, so the hour-long throttle in `pushover.ts` works. It
 *    is the same string every morning on purpose: two runs in one hour is a
 *    manual re-run, and the second one does not need announcing.
 *  - **The pending company suggestions are folded in rather than pushed
 *    separately.** The 07:00 job stays silent and this one carries its count,
 *    because two pushes half an hour apart both saying "go and look at the
 *    same screen" is how a channel gets muted.
 */
function notify(run: OutreachRun, suggestions: number): void {
  // The trigger is this run's queue gain, and *only* that. Pending company
  // suggestions ride along in the message when there are any, but they cannot
  // cause a push on their own: they are a standing count, not an event, so
  // firing on them would put out the same "1 company to review" every morning
  // until it was reviewed — which is precisely the muted channel §12 is trying
  // to avoid. §12 also says where the real record is: the suggestions are in
  // the tab with a badge whether or not anything was pushed.
  if (run.queued === 0) return;
  if (!isPushoverConfigured()) return;

  const best = run.found
    .filter((posting) => posting.assessment)
    .sort((a, b) => (b.assessment?.fit ?? 0) - (a.assessment?.fit ?? 0))
    .slice(0, 3);

  const lines = best.map(
    (posting) =>
      `· ${posting.company} — ${posting.title}` +
      (posting.assessment ? ` (fit ${posting.assessment.fit})` : ''),
  );

  const parts = [
    `${run.queued} role${run.queued === 1 ? '' : 's'} to review`,
    suggestions > 0 ? `${suggestions} compan${suggestions === 1 ? 'y' : 'ies'} to review` : null,
  ].filter(Boolean);

  sendAlert({
    kind: 'outreach_opportunities',
    title: `Job outreach: ${parts.join(', ')}`,
    message: [...lines, '', reviewUrl()].join('\n'),
    priority: -1,
  });
}

export async function runOutreach(options: OutreachOptions = {}): Promise<OutreachRun> {
  const startedAt = new Date().toISOString();
  const started = Date.now();

  const sources = options.sources ?? requestedSources();
  const cap = options.max ?? maxPostingsPerRun();

  const clock = options.deadline ?? runDeadline();
  const deadlineAt = resolveDeadline(clock);
  const budget = new RunBudget({
    deadlineAt,
    durationMs: runBudgetMs(),
    stopAfterMatches: stopAfterMatches(),
  });

  const watchlist = readWatchlist();
  const companies = options.company ? matchCompany(watchlist, options.company) : watchlist;

  const preferences = loadPreferences();
  // Opened once, before any posting is fetched, so that "the Mac is away" is a
  // fact the run states at the top rather than something it discovers 40
  // postings in. Both gates are asked for separately because §15 allows a
  // different model per stage; with the defaults they resolve to the same one.
  const models = await openModels(options.noModel === true);

  const outcomes: OutreachOutcome[] = [];
  const tiers = buildUnits(sources, companies, outcomes);
  const rotated = rotateToCursor(tiers.aggregators);
  const units = [...tiers.ats, ...rotated];

  logger.info('outreach_run_started', {
    job: 'outreach',
    sources,
    companies: companies.length,
    units: units.map((unit) => unit.id),
    // Logged apart from `units` so the composition is visible in a log line: the
    // watch list is read in full order every morning, and only these rotate.
    rotating: rotated.map((unit) => unit.id),
    cap,
    // Stated explicitly, because "no deadline" is a real state with a cause: a
    // run started by hand after 09:00 is bounded by its duration alone, and a
    // log that omitted that would make a 60-minute afternoon run look like a
    // deadline that had failed to fire.
    deadline: deadlineAt ? new Date(deadlineAt).toISOString() : null,
    deadlineClock: clock,
    budgetMs: runBudgetMs(),
    stopAfterMatches: stopAfterMatches(),
  });

  const found: FoundPosting[] = [];
  const queue: QueuedOpportunity[] = [];
  const violations: OutreachViolation[] = [];
  const explain: ExplainLine[] = [];
  const checks = new Map<string, CheckResult>();
  const cache = openCache({
    bypass: options.noCache,
    log: (event, fields) => logger.info(event, { job: 'outreach', ...fields }),
  });

  // Seeded from `seen.json`, and added to as the run goes so a role listed by
  // two sources is counted once within a run as well as across runs. Both keys
  // matter: `id` is the posting's identity within its source, `dedupeHash` is
  // the same role reached through a different board.
  const seenById = new Map<string, SeenEntry>();
  const seenByDedupe = new Map<string, SeenEntry>();
  for (const entry of readSeen()) {
    seenById.set(entry.id, entry);
    // First writer wins: the oldest sighting of a role is the one whose status
    // says how far the system has got with it.
    if (!seenByDedupe.has(entry.dedupeHash)) seenByDedupe.set(entry.dedupeHash, entry);
  }
  const countedThisRun = new Set<string>();

  // What the queue already holds, by both keys. Read once: the early stop
  // counts cards a person has not seen, and a placeholder queued on Tuesday is
  // not a new card on Wednesday.
  const alreadyQueued = new Set<string>();
  for (const item of readPending()) {
    alreadyQueued.add(item.id);
    alreadyQueued.add(item.dedupeHash);
  }

  // The decisions a human has already made, which the run must not undo.
  //
  // Both are keyed on `dedupeHash` rather than on a posting id, and that is the
  // whole point of the field: a role said no to must not come back next week
  // because a different board listed it, and a role already applied to must not
  // come back at all (§8, §8.1). Without these two lines "Not interested" is
  // indistinguishable from "ignore" and "Already applied" protects nothing —
  // the card simply returns tomorrow morning.
  const decided = rejectedHashes();
  for (const entry of readApplied()) decided.add(entry.dedupeHash);

  let droppedByGeo = 0;
  let alreadySeen = 0;
  let deferred = 0;
  let unscored = 0;
  /** Cards the queue actually gained — see the `fresh` check below. */
  let queuedNew = 0;
  let skippedByScore = 0;
  let rejected = 0;
  let decidedSkips = 0;
  let fetchedTotal = 0;
  let stopped: StopReason | null = null;
  let nextIndex = 0;

  for (const [position, unit] of units.entries()) {
    if (budget.expired()) {
      stopped = budget.stoppedBy();
      nextIndex = position;
      break;
    }

    // The posting cap is checked here rather than only after a fetch, because
    // the first version checked it afterwards and the cost was visible
    // immediately: three sources were called over HTTP — one of them a 2 MB
    // feed — and every row was then sliced away by a cap that had already been
    // reached, while the outcome line read "ok, 0 postings" as though the board
    // had been empty. A guard that spends the request and discards the answer
    // is not a guard.
    if (fetchedTotal >= cap) {
      logger.warn('outreach_posting_cap_hit', {
        job: 'outreach',
        unit: unit.id,
        reason: 'no_room',
        cap,
      });
      stopped = 'cap';
      nextIndex = position;
      break;
    }
    // Every unit the loop opens is a unit this run is responsible for; if it
    // finishes, tomorrow starts after it.
    nextIndex = position + 1;

    const outcome: OutreachOutcome = {
      source: unit.source,
      company: unit.company?.name,
      status: 'ok',
      postingsFetched: 0,
      eligible: 0,
      newlyFound: 0,
    };
    outcomes.push(outcome);

    const log = (event: string, fields: Record<string, unknown>) =>
      logger.info(event, { job: 'outreach', ...fields });

    let postings: RawPosting[];
    try {
      postings = await unit.fetch({ company: unit.company, budget, cache, log });
    } catch (err) {
      // A 403 is its own outcome, not a generic failure: it means the board
      // said stop, and the correct response is to be absent from it until
      // tomorrow rather than to try again with different headers.
      const blocked = err instanceof WorkdayBlockedError;
      outcome.status = 'failed';
      outcome.reason = blocked ? 'blocked' : err instanceof Error ? err.message : String(err);
      if (unit.company) {
        checks.set(unit.company.name, { eligible: 0, newlyFound: 0, failed: true });
      }
      logger.warn('outreach_source_failed', {
        job: 'outreach',
        source: unit.source,
        company: unit.company?.name,
        reason: outcome.reason,
      });
      continue;
    }

    // Checked at the boundary, before any of it is hashed, filtered or counted.
    // A row that cannot be addressed is one dropped posting and one log line —
    // see `validate.ts` for why the alternative is a job that wedges itself.
    const validated = validatePostings(postings);
    postings = validated.postings;

    if (validated.defects.length > 0) {
      outcome.malformed = validated.defects.length;
      logger.warn('outreach_posting_malformed', {
        job: 'outreach',
        unit: unit.id,
        dropped: validated.defects.length,
        // Bounded: a feed that has gone wrong everywhere must not write three
        // hundred lines into a log that rotates daily (§20).
        defects: validated.defects.slice(0, 5),
      });
    }

    if (fetchedTotal + postings.length > cap) {
      const room = cap - fetchedTotal;
      const overflow = postings.slice(room);
      logger.warn('outreach_posting_cap_hit', {
        job: 'outreach',
        unit: unit.id,
        reason: 'overflow',
        returned: postings.length,
        kept: room,
        deferred: overflow.length,
        cap,
      });
      // Fetched and never looked at, which is the definition of deferred. The
      // rows are recorded so that the next run to reach this unit treats them
      // as unfinished rather than as postings it has already judged.
      recordSeen(overflow.map((posting) => seenEntryFor(posting, 'deferred')));
      deferred += overflow.length;
      postings = postings.slice(0, room);
    }

    fetchedTotal += postings.length;
    outcome.postingsFetched = postings.length;

    const entries: SeenEntry[] = [];
    let stoppedInUnit = false;

    for (const [index, posting] of postings.entries()) {
      if (budget.expired()) {
        // Everything left in this unit was fetched and never looked at. It is
        // recorded as `deferred` rather than dropped, so tomorrow treats it as
        // unfinished work rather than as a posting it has already dealt with.
        const remaining = postings.slice(index);
        for (const skipped of remaining) entries.push(seenEntryFor(skipped, 'deferred'));
        deferred += remaining.length;

        logger.info('outreach_deferred', {
          job: 'outreach',
          unit: unit.id,
          deferred: remaining.length,
          stoppedBy: budget.stoppedBy(),
        });

        stopped = budget.stoppedBy();
        // Note what `nextIndex` is deliberately *not* doing here: it stays at
        // `position + 1`, so tomorrow starts after this unit rather than
        // re-opening it. A unit is a whole board or a whole feed, fetched from
        // the top every time — there is no offset to resume from, so a cursor
        // that pointed back at it would re-read the same rows, stop on the
        // same matches, and never reach the sources behind it. That is the
        // starvation §11 introduces the rotation to prevent, and it was
        // observable: a first run stopped inside Align's 218 postings and would
        // have stopped there every morning afterwards.
        //
        // Nothing is lost by moving on. The postings left behind are recorded
        // as `deferred` below, so when the rotation brings this unit round
        // again they still count as unfinished work rather than as postings the
        // system has already dealt with.
        stoppedInUnit = true;
        break;
      }

      const decision = geoVerdict(posting.locationText, untrustedBlob(posting), posting.structured);

      if (options.explain) {
        explain.push({
          source: posting.source,
          company: posting.company,
          title: posting.title,
          url: posting.url,
          locationText: posting.locationText,
          verdict: decision.verdict,
          rule: decision.rule,
          evidence: decision.evidence,
        });
      }

      if (decision.verdict === 'drop') {
        droppedByGeo += 1;
        entries.push(seenEntryFor(posting, 'ineligible'));
        // The id and the rule, never the body (§20). This is the line that
        // makes "why didn't it find that job?" answerable a week later.
        logger.info('outreach_geo_dropped', {
          job: 'outreach',
          source: posting.source,
          key: posting.key,
          rule: decision.rule,
          evidence: decision.evidence,
        });
        continue;
      }

      outcome.eligible += 1;

      const id = postingId(posting.source, posting.key);
      const dedupeHash = dedupeHashFor(posting.company, posting.title);
      const prior = seenById.get(id) ?? seenByDedupe.get(dedupeHash);
      const isNew = !prior;

      if (isNew) outcome.newlyFound += 1;
      else alreadySeen += 1;

      // Unfinished work, whether it is new or was deferred by an earlier run.
      // A posting an earlier run already judged is reported and left alone.
      const unfinished = !prior || prior.status === 'deferred';
      const first = unfinished && !countedThisRun.has(dedupeHash);
      if (first) countedThisRun.add(dedupeHash);

      // Checked before anything is scored, so a decided role costs no model
      // time either. It stays out of `found` as well: the report is what a
      // person reads, and a role they have already answered for is not news.
      if (decided.has(dedupeHash)) {
        entries.push(seenEntryFor(posting, 'skipped'));
        decidedSkips += 1;
        continue;
      }

      const entry: FoundPosting = {
        id,
        dedupeHash,
        source: posting.source,
        company: posting.company,
        title: posting.title,
        url: posting.url,
        locationText: posting.locationText,
        verdict: decision.verdict,
        rule: decision.rule,
        postedAt: posting.postedAt,
        isNew,
      };

      if (!first) {
        // Not unfinished work: either an earlier run judged this role, or
        // another board in this run already produced it. Recorded as `skipped`
        // rather than `deferred` so that tomorrow does not spend a model call
        // re-scoring a role the queue would refuse on `dedupeHash` anyway. The
        // upsert in `recordSeen` means this cannot walk back a stronger status.
        entries.push(seenEntryFor(posting, 'skipped'));
        found.push(entry);
        continue;
      }

      const judged = await judgePosting(posting, unit.company, models, preferences, budget, log);
      violations.push(...judged.violations);
      entries.push(seenEntryFor(posting, judged.seenStatus));

      if (judged.queued) {
        // Written either way: a placeholder that has since been scored is an
        // upgrade worth storing, and `appendPending` knows to replace an
        // `unscored` entry with a judged one.
        queue.push(judged.queued);

        // §11 counts postings *added to the queue this run*, and "added" has to
        // mean added. A card already in `pending.json` from an earlier run is
        // still unfinished work, so it is still re-judged — but counting it
        // again gets two things wrong, and both were observed rather than
        // predicted:
        //
        //  - The early stop would end every morning on the same placeholders,
        //    having produced no new card and never reached an aggregator — the
        //    starvation the rotation exists to prevent, arriving through the
        //    counter instead of the cursor.
        //  - The notification would fire every morning announcing cards that
        //    have been sitting on the screen since Tuesday. §12 is explicit
        //    that a run with nothing new sends nothing, because a push that
        //    repeats itself daily gets muted, and a muted channel is not a
        //    monitor.
        const fresh = !alreadyQueued.has(judged.queued.id) && !alreadyQueued.has(dedupeHash);

        if (fresh) {
          alreadyQueued.add(judged.queued.id);
          alreadyQueued.add(dedupeHash);
          outcome.queued = (outcome.queued ?? 0) + 1;
          queuedNew += 1;
          if (judged.queued.status === 'unscored') unscored += 1;
          budget.noteQueued();
        }
      } else if (judged.rejected) {
        rejected += 1;
      } else {
        skippedByScore += 1;
      }

      if (judged.verdict) {
        entry.assessment = {
          eligibility: judged.verdict.eligibility,
          fit: judged.verdict.fit,
          recommendation: judged.verdict.recommendation,
          evidence: judged.verdict.eligibilityEvidence,
          flags: judged.verdict.flags,
        };
      }

      found.push(entry);
    }

    if (unit.company) {
      checks.set(unit.company.name, {
        eligible: outcome.eligible,
        newlyFound: outcome.newlyFound,
        failed: false,
      });
    }

    // Written per unit rather than once at the end, so a run that dies on the
    // third board keeps what the first two learned.
    recordSeen(entries);

    if (stoppedInUnit) break;
  }

  recordChecks(checks);

  // Written once, at the end, and appended rather than overwritten: the queue is
  // the one store here that a human is in the middle of working through, and a
  // run that replaced it would throw away decisions made since this morning.
  if (queue.length > 0) appendPending(queue);

  const unreachedUnits = units.slice(nextIndex).map((unit) => unit.id);

  // The cursor holds the aggregator tier only. `nextIndex` counts through the
  // whole run, so the watch list's length comes off the front; a run that
  // stopped inside the watch list leaves the aggregator cursor where it was,
  // which is right — those feeds were not reached, and none of them was skipped
  // in favour of another.
  const aggregatorIndex = Math.max(0, nextIndex - tiers.ats.length);
  // It wraps rather than pointing past the end: a run that reached every feed
  // has no unfairness to correct, and tomorrow starts at the top again.
  writeCursor(
    rotated.map((unit) => unit.id),
    aggregatorIndex >= rotated.length ? 0 : aggregatorIndex,
  );

  const run: OutreachRun = {
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    scored: models.extract !== null && models.score !== null,
    stoppedBy: stopped ?? 'exhausted',
    outcomes,
    found,
    droppedByGeo,
    alreadySeen,
    deferred,
    queued: queuedNew,
    unscored,
    skippedByScore,
    rejected,
    decided: decidedSkips,
    violations,
    unreachedUnits,
    reportPath: null,
    ...(options.explain ? { explain } : {}),
  };

  run.reportPath = writeRunReport(run);

  notify(run, readSuggestions().length);

  logger.info('outreach_run_completed', {
    job: 'outreach',
    durationMs: run.durationMs,
    stoppedBy: run.stoppedBy,
    fetched: fetchedTotal,
    eligible: found.length,
    newlyFound: found.filter((posting) => posting.isNew).length,
    droppedByGeo,
    alreadySeen,
    deferred,
    queued: queuedNew,
    // Writes to `pending.json`, including re-judged cards whose verdict
    // improved. It can exceed `queued`, and the difference is upgrades
    // rather than news.
    queueWrites: queue.length,
    unscored,
    skippedByScore,
    rejected,
    decided: decidedSkips,
    violations: violations.length,
    unreached: unreachedUnits,
    scored: models.extract !== null && models.score !== null,
    outcomes: outcomes.map((outcome) => ({
      source: outcome.source,
      company: outcome.company,
      status: outcome.status,
      reason: outcome.reason,
      postings: outcome.postingsFetched,
      eligible: outcome.eligible,
    })),
  });

  return run;
}
