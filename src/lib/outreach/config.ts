import path from 'path';
import type { SourceId } from './types';

/**
 * Environment parsing for the outreach jobs, in one place so the scripts and
 * the library never disagree about a default.
 *
 * Only the variables phases 0 to 2 actually honour are read here. §15 of
 * `docs/job-outreach-plan.md` lists the full set; each one arrives with the
 * phase that obeys it, because a documented variable the code ignores is worse
 * than an undocumented one — it gets set, and then it gets trusted.
 */

/** Every source the plan names, in the order §15 lists them. */
const ALL_SOURCES: SourceId[] = [
  'workday',
  'pinpoint',
  'greenhouse',
  'lever',
  'ashby',
  'remotive',
  'remoteok',
  'arbeitnow',
  'himalayas',
];

/**
 * The ones that exist today.
 *
 * All nine as of phase 2. `eightfold` is in `AtsId` but has no adapter and is
 * not listed here, so a watch-list entry using it reports `not_implemented`
 * rather than failing — the same treatment the aggregators had before this
 * phase.
 */
export const IMPLEMENTED_SOURCES: SourceId[] = [...ALL_SOURCES];

/**
 * Sources that are fetched once for everyone rather than once per company.
 *
 * The distinction decides the shape of a unit of work in the run loop: an ATS
 * adapter is called with a company and an aggregator is called without one.
 */
export const AGGREGATOR_SOURCES: SourceId[] = ['remotive', 'remoteok', 'arbeitnow', 'himalayas'];

export function isAggregator(source: SourceId): boolean {
  return AGGREGATOR_SOURCES.includes(source);
}

export const DATA_DIR = path.resolve(process.cwd(), 'data');
export const OUTREACH_DIR = path.join(DATA_DIR, 'outreach');
export const FIXTURE_DIR = path.join(OUTREACH_DIR, 'fixtures');
export const COMPANIES_FILE = path.join(OUTREACH_DIR, 'companies.json');
export const SEEN_FILE = path.join(OUTREACH_DIR, 'seen.json');
/** Per-company counters. Kept out of the committed watch list — see `CompanyStats`. */
export const COMPANY_STATS_FILE = path.join(OUTREACH_DIR, 'company-stats.json');
export const RUN_REPORT_FILE = path.join(OUTREACH_DIR, 'last-run.json');
/** The review queue. Queues rather than being overwritten — see `QueuedOpportunity`. */
export const PENDING_FILE = path.join(OUTREACH_DIR, 'pending.json');
/** Source rotation, so a budgeted run does not read the same sources every day. */
export const CURSOR_FILE = path.join(OUTREACH_DIR, 'cursor.json');
/** The feed cache the 07:00 and 08:00 jobs share. One file per entry. */
export const CACHE_DIR = path.join(OUTREACH_DIR, 'cache');
/** Decisions: "not interested", by `dedupeHash`. Never the ledger (§8). */
export const REJECTED_FILE = path.join(OUTREACH_DIR, 'rejected.json');
/**
 * The permanent ledger (§8.1), and its backup.
 *
 * Losing `seen.json` costs a day of duplicated noise in the review queue.
 * Losing this file means the system re-applies to everyone it has ever
 * contacted, with no way to know it is doing so — which is why every write goes
 * through the `.bak` copy first and why nothing here is ever pruned.
 */
export const APPLIED_FILE = path.join(OUTREACH_DIR, 'applied.json');
export const APPLIED_BACKUP_FILE = path.join(OUTREACH_DIR, 'applied.json.bak');
/** The 07:00 job's proposals, reviewed in the same tab. */
export const SUGGESTIONS_FILE = path.join(OUTREACH_DIR, 'suggestions.json');
/** One pending form handoff, written by the API and read by the host (§17.1). */
export const HANDOFF_FILE = path.join(OUTREACH_DIR, 'handoff.json');

/**
 * The private preference doc (§5).
 *
 * Outside `data/` entirely, and deliberately reached only from this directory.
 * `src/lib/profile/loader.ts` reads an explicit list of files and must stay
 * explicit, so there is no path from a visitor's question to this one.
 */
export const PRIVATE_DIR = path.resolve(process.cwd(), 'private');
export const PREFERENCES_FILE = path.join(PRIVATE_DIR, 'job-preferences.md');

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

/**
 * Which adapters to run. A comma list rather than one flag per source, so
 * disabling an adapter that started failing is an env edit rather than a deploy.
 *
 * Filtered against `IMPLEMENTED_SOURCES` as well as against the request, so the
 * default value from §15 — which names all nine — can be pasted into `.env`
 * today without the run trying to call four adapters that do not exist yet. The
 * requested-but-missing ones are reported as `not_implemented` rather than
 * dropped silently; see `runOutreach`.
 */
export function requestedSources(): SourceId[] {
  const raw = env('OUTREACH_SOURCES');
  if (!raw) return [...IMPLEMENTED_SOURCES];
  const requested = raw.split(',').map((s) => s.trim());
  return ALL_SOURCES.filter((s) => requested.includes(s));
}

/**
 * Upper bound on postings pulled into memory in one run.
 *
 * A guard against an adapter that starts returning a whole board rather than a
 * filtered slice, not a tuning knob — the run is bounded by its deadline from
 * phase 2 onwards.
 */
export function maxPostingsPerRun(): number {
  const parsed = parseInt(env('OUTREACH_MAX_POSTINGS_PER_RUN') ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 300;
}

/**
 * Server-side search terms for Workday boards.
 *
 * Workday filters on the *whole* location set of a posting, including the
 * additional locations a multi-site role carries — which is how NVIDIA's Munich
 * requisition surfaces under `Armenia`, because Armenia is one of the four
 * remote locations it also accepts. Two geographic terms therefore cover both
 * families this job cares about: a Yerevan office role, and a global remote
 * role that happens to accept Armenia.
 *
 * Role words can be added, and the plan suggests two or three (§17.3) — but
 * each term is another request against a board behind bot management, and a
 * role word returns mostly postings the geo filter will drop anyway. Start
 * narrow; widen when a morning is provably too quiet.
 */
export function workdaySearchTerms(): string[] {
  const raw = env('OUTREACH_WORKDAY_SEARCH_TERMS');
  if (!raw) return ['Armenia', 'Yerevan'];
  return raw
    .split(',')
    .map((term) => term.trim())
    .filter(Boolean);
}

/**
 * The wall-clock time the 08:00 run stops, in `DISPLAY_TIMEZONE`.
 *
 * A time, not a duration, and §11 is emphatic about the difference: the task
 * can fire at 08:40 because the laptop was asleep, and the run should still be
 * over before the working day rather than getting a full hour from whenever it
 * happened to start.
 */
export function runDeadline(): string {
  return env('OUTREACH_RUN_DEADLINE') ?? '09:00';
}

/**
 * Belt and braces for a run started by hand at an odd hour, when the wall-clock
 * deadline has already passed and would otherwise bound nothing.
 */
export function runBudgetMs(): number {
  const parsed = parseInt(env('OUTREACH_RUN_BUDGET_MS') ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 3_600_000;
}

/**
 * Queue-worthy postings after which the run stops early.
 *
 * §7 is strict about what counts: only postings that reach the review queue,
 * never postings fetched and never the ones scoring will discard — otherwise a
 * morning with 200 junior React postings "finds its matches" and stops before
 * reaching anything real.
 *
 * Ten rather than the plan's five, changed 2026-09-15. The number to understand
 * is not this one but the ratio behind it: the first full scored run took 58
 * minutes to reach three queue-worthy postings out of 42 scored, because most
 * of a real ATS board is roles Davit would never take. At that ratio ten is
 * more than an hour's work, so the *deadline* becomes the binding constraint
 * and this is a ceiling rather than a target — which is the right shape for it:
 * it stops a freak morning from queueing forty cards, and otherwise stays out
 * of the way. §23 records what that does to §12's diagnostic.
 */
export function stopAfterMatches(): number {
  const parsed = parseInt(env('OUTREACH_STOP_AFTER_MATCHES') ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 10;
}

/** How long a cached feed stays fresh. 90 minutes covers 07:00 handing to 08:00. */
export function cacheTtlMs(): number {
  const parsed = parseInt(env('OUTREACH_CACHE_TTL_MS') ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 5_400_000;
}

/**
 * Rows taken from one aggregator feed in one run.
 *
 * Aggregators hand over their whole front page in a single call — Arbeitnow
 * returns 250 postings and 2 MB — so this bounds the work the geo filter and
 * the report do, not the number of requests. Postings past the cap are not
 * lost: they are the older half of a feed sorted newest-first, and tomorrow's
 * run sees the same rows again.
 */
export function aggregatorPageLimit(): number {
  const parsed = parseInt(env('OUTREACH_AGGREGATOR_PAGE_LIMIT') ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 100;
}

/**
 * Pages of the Himalayas feed to walk per run.
 *
 * Alone among the four, Himalayas caps `limit` at 20 and pages by cursor, so
 * one call is 20 postings against a feed of six figures. Three pages is 60
 * postings of the newest jobs, which is the slice a daily run can act on;
 * walking deeper reads yesterday's feed, which yesterday's run already read.
 */
export function himalayasPages(): number {
  const parsed = parseInt(env('OUTREACH_HIMALAYAS_PAGES') ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 3;
}

// ─── Models (phase 3) ─────────────────────────────────────────────────

/**
 * Which model a stage runs on, or undefined for "whatever the site is running".
 *
 * Undefined is the right default and not laziness: naming a different model
 * makes Ollama evict the resident one, so the next visitor to the website pays
 * a cold start of tens of seconds. That cost lands on the site, not in this
 * job's logs, which is exactly the kind of cost that goes unnoticed.
 */
export function stageModel(stage: 'extract' | 'score' | 'draft'): string | undefined {
  const names = {
    extract: 'OUTREACH_EXTRACT_MODEL',
    score: 'OUTREACH_SCORE_MODEL',
    draft: 'OUTREACH_DRAFT_MODEL',
  } as const;
  return env(names[stage]);
}

/**
 * Whether a stage may fall back to OpenAI when the Mac is away.
 *
 * Off by default, same argument as the refresh job: the fallback chain exists
 * so a *visitor* never waits on a sleeping laptop, and a batch job has no
 * visitor. A run with no model still produces a queue — unscored, with real
 * links — which is worth more than a surprise invoice.
 */
export function allowPaidFallback(): boolean {
  return env('OUTREACH_ALLOW_PAID_FALLBACK') === 'true';
}

/**
 * Per-call timeout. Generous, because the first call after the Mac has been
 * idle pays for loading the model — tens of seconds — and a timeout that fires
 * during a cold load turns a slow morning into an empty one.
 */
export function outreachTimeoutMs(): number {
  const parsed = parseInt(env('OUTREACH_TIMEOUT_MS') ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 180_000;
}

/**
 * §7: a role in Yerevan is never auto-drafted, whatever it scores.
 *
 * Not because those roles are worse — the Align Sr. Java Engineer is the best
 * match this design has found — but because the decision behind them is a
 * different size. A remote contract is reversible and additive; a local
 * full-time offer is a change of employer, and it is the family where an
 * auto-sent application is most likely to reach someone Davit will meet in
 * person in a city with one engineering scene.
 *
 * A setting rather than a constant only so that it can be turned off
 * deliberately and visibly; the override itself lives in `score.ts` as code,
 * never as prompt wording, because a rule this categorical should not depend on
 * a model honouring it.
 */
export function localAlwaysSurface(): boolean {
  return env('OUTREACH_LOCAL_ALWAYS_SURFACE') !== 'false';
}

/**
 * How long a queued posting waits for a decision before it expires.
 *
 * Three weeks, because a posting is an external event with its own lifetime:
 * most stay open for weeks, and one that has been in the queue for a month is
 * either filled or not worth the application. Expiry is not a decision and
 * never becomes one — nothing is ever recorded as applied because it timed out.
 */
export function queueTtlDays(): number {
  const parsed = parseInt(env('OUTREACH_QUEUE_TTL_DAYS') ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 21;
}

// ─── Sending and the ledger (§8.1, §10) ────────────────────────────────────

/**
 * Nothing is transmitted while this is true, and it is true unless someone
 * deliberately says otherwise.
 *
 * §15: "not caution theatre — the first bug in a system that emails strangers
 * should be found in a log file". Note the shape of the check: only the exact
 * string `false` turns it off, so a typo, an empty value or an unset variable
 * all mean "do not send".
 */
export function dryRun(): boolean {
  return env('OUTREACH_DRY_RUN') !== 'false';
}

/**
 * Applications transmitted in one local day.
 *
 * Enforced where the sending happens, never in the UI. A new sending domain
 * that mails fifty strangers on day one has a deliverability problem by day
 * two, and the reputation being spent belongs to the same domain the portfolio
 * site runs on.
 */
export function maxSendsPerDay(): number {
  const parsed = parseInt(env('OUTREACH_MAX_SENDS_PER_DAY') ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 5;
}

/**
 * Applications to one company inside the cooldown window (§8.1, row 4).
 *
 * The difference between a duplicate and spam. Five applications to five
 * companies is a good morning; five to one company is a pattern a recruiter
 * notices, and they all land with the same ATS and often the same reviewer.
 */
export function maxApplicationsPerCompany(): number {
  const parsed = parseInt(env('OUTREACH_MAX_APPLICATIONS_PER_COMPANY') ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 1;
}

export function companyCooldownDays(): number {
  const parsed = parseInt(env('OUTREACH_COMPANY_COOLDOWN_DAYS') ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 30;
}

/**
 * Days after which the same role may be applied to again. `0` means never.
 *
 * A role reposted six months later is still the same role at the same company,
 * so raising this is a deliberate act rather than a tuning decision.
 */
export function reapplyAfterDays(): number {
  const parsed = parseInt(env('OUTREACH_REAPPLY_AFTER_DAYS') ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Days before an unconfirmed form handoff comes back asking.
 *
 * A human clicks Submit on the host, so the ledger only learns about it if
 * told. Guessing either way is worse than asking: assume sent and a good role
 * is silently dropped, assume not and the system may duplicate a real
 * application.
 */
export function formConfirmAfterDays(): number {
  const parsed = parseInt(env('OUTREACH_FORM_CONFIRM_AFTER_DAYS') ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 3;
}

/**
 * Where a notification points for review.
 *
 * The same `PUBLIC_BASE_URL` the refresh job uses, so both notifications lead
 * to the same screen and neither has its own idea of where that is. A
 * notification whose only action is "go and find it yourself" is one that gets
 * postponed, and postponed review is the failure mode this workflow exists to
 * avoid.
 */
export function reviewUrl(): string {
  const base = (env('PUBLIC_BASE_URL') ?? 'https://davithayrapetyan.dev').replace(/\/+$/, '');
  return `${base}/admin`;
}
