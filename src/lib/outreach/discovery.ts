import fs from 'fs';
import type {
  CompanyHygiene,
  CompanySuggestion,
  DiscoveryRejection,
  DiscoveryRun,
  DiscoveryStopReason,
  OutreachOutcome,
  RawPosting,
} from './types';
import {
  RUN_REPORT_FILE,
  discoveryBudgetMs,
  discoveryDeadline,
  isAggregator,
  maxCandidates,
  maxCompanies,
  maxPendingSuggestions,
  maxSuggestions,
  requestedSources,
  staleCompanyDays,
} from './config';
import { RunBudget, resolveDeadline } from './budget';
import { openCache } from './cache';
import { geoVerdict, mentionsYerevan } from './geo';
import {
  annotateCandidate,
  readAttempts,
  readCandidateFile,
  recordAttempt,
  suppressed,
  writeAttempts,
  companyKey,
  type Candidate,
} from './candidates';
import { verifyCandidate, type VerifyResult } from './verify';
import { readCompanyStats, readWatchlist } from './watchlist';
import {
  appendSuggestions,
  readPending,
  readSuggestions,
  rejectedCompanyKeys,
  writeDiscoveryReport,
} from './store';
import { AGGREGATOR_ADAPTERS } from './sources/registry';
import { validatePostings } from './sources/validate';
import { logger } from '../logger';

/**
 * The 07:00 company discovery run (§9).
 *
 * It asks a different question from the 08:00 job — "which employers should we
 * be watching at all?" rather than "which roles fit?" — and §9 gives three
 * reasons it gets its own half hour rather than running on the other job's
 * leftovers. The one that decides the shape of this file is the first: leftover
 * budget is never left over. A pass that only runs when the main job finishes
 * early runs on quiet days and never on busy ones, which is exactly backwards,
 * since a busy day is evidence the watch list is working and a quiet one is
 * evidence it needs growing.
 *
 * ## Nothing here calls a model
 *
 * §9's card asks for two or three sentences saying why a company fits,
 * "grounded in that company's *actual current postings*, not in the model's
 * background knowledge of the brand". This run writes that sentence from the
 * verification result itself — the posting count, how many pass the Yerevan
 * filter, and the titles of up to three real postings — rather than asking a
 * model to write it.
 *
 * That is a divergence from what §9 implies and §23 records it, for four
 * reasons that all point the same way. §9's own heading says *verification is
 * the point, not the summary*. A sentence composed from the verified numbers is
 * grounded by construction, so the one failure mode §9 names — a model reciting
 * what it knows about a brand — cannot occur. A model call here would mean
 * feeding an unverified third party's posting text to the Mac, which is the
 * input stage A's whole sanitiser apparatus exists to handle and which this job
 * has no need to read at all. And the window is thirty minutes against 45–90
 * seconds per Mac call with up to twenty-five candidates, so the summary would
 * be competing with the verification for the budget.
 *
 * It has a pleasant consequence §11 asked about: this job can no longer trip
 * `macBreaker` at 07:00 and cause the 08:00 job to skip tier 0 without probing.
 *
 * ## The feeds are read even when nothing comes of them
 *
 * The aggregator feeds are this run's cheapest candidate source, and reading
 * them is also §9's third reason for the separate window: the responses land in
 * `data/outreach/cache/` and the 08:00 job starts with its cheapest source
 * already local, spending more of its hour on the Mac and less on HTTP. So the
 * feeds are read first, before anything is verified, and a morning that
 * proposes nothing has still done that much.
 *
 * ## A run that verifies nothing is a normal outcome
 *
 * §9 says so explicitly, and it is worth stating in code as well as in prose,
 * because the alternative — proposing a company whose endpoint could not be
 * read, with a caveat on the card — is precisely the watch-list rot this job
 * exists to prevent. It logs what it tried and exits 0.
 */

export interface DiscoveryOptions {
  /** `--max-candidates=N`, overriding `DISCOVERY_MAX_CANDIDATES`. */
  maxCandidates?: number;
  /** `--deadline=HH:MM` in `DISPLAY_TIMEZONE`. */
  deadline?: string;
  /** `--no-feeds`: skip candidate generation from the aggregators. */
  noFeeds?: boolean;
  /** `--no-cache`: refetch every feed. */
  noCache?: boolean;
}

/** URLs kept per candidate. Each one is a potential page fetch; three is plenty. */
const MAX_URLS = 3;

/**
 * Hosts whose pages describe the middleman rather than the employer.
 *
 * This was measured rather than assumed, and it is the single most expensive
 * thing this file knows. §9's first two candidate tiers say a company in the
 * aggregator results is "a candidate with evidence already attached — this is
 * free, the fetch already happened". The evidence is attached; the *address* is
 * not. Every URL the four feeds publish points back at the feed:
 * `himalayas.app/companies/…`, `arbeitnow.com/jobs/companies/…`,
 * `remoteok.com/remote-jobs/…`, `remotive.com/remote-jobs/…`. None of them
 * carries the employer's own site, and none carries an ATS link.
 *
 * Fetching them was tried against the live feeds on 2026-09-15: twenty-six
 * candidates, twenty-six failures — Himalayas returns 403 to our User-Agent,
 * and an Arbeitnow posting page is 220 kB of application shell with no ATS
 * marker anywhere in it. That is twenty-six requests to third parties every
 * morning to learn the same nothing, which is the shape of politeness bug §6
 * cares about as well as a waste of the attempt budget.
 *
 * So a feed candidate is only *fetched* when the feed happened to hand over an
 * address that is not the feed's own. Otherwise it is reported as a name
 * waiting for a careers URL — see `DiscoveryRun.unresolved` and §23.
 */
const MIDDLEMAN_HOSTS = [
  'himalayas.app',
  'remotive.com',
  'remoteok.com',
  'remoteok.io',
  'arbeitnow.com',
];

function isMiddleman(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return MIDDLEMAN_HOSTS.some((known) => host === known || host.endsWith(`.${known}`));
  } catch {
    return true;
  }
}

/** `why` is bounded by §17.2 at 400 characters. */
const WHY_BUDGET = 400;

type LogFn = (event: string, fields: Record<string, unknown>) => void;

/** Case, spacing and punctuation blind, so "NVIDIA" and "Nvidia, Inc." are one company. */
function fold(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Reads the four aggregator feeds, both for candidates and for the 08:00 job.
 *
 * Failures are recorded per feed and never thrown: one board being down is a
 * thinner morning, not a failed run, and the same rule the opportunity run
 * follows.
 */
async function readFeeds(
  budget: RunBudget,
  cache: ReturnType<typeof openCache>,
  log: LogFn,
): Promise<{ postings: RawPosting[]; outcomes: OutreachOutcome[] }> {
  const postings: RawPosting[] = [];
  const outcomes: OutreachOutcome[] = [];

  for (const source of requestedSources()) {
    if (!isAggregator(source)) continue;

    const fetcher = AGGREGATOR_ADAPTERS[source];
    if (!fetcher) continue;

    if (budget.expired()) break;

    const outcome: OutreachOutcome = {
      source,
      status: 'ok',
      postingsFetched: 0,
      eligible: 0,
      newlyFound: 0,
    };
    outcomes.push(outcome);

    try {
      const { postings: rows, defects } = validatePostings(
        await fetcher({ budget, cache, log }),
      );
      if (defects.length > 0) outcome.malformed = defects.length;
      outcome.postingsFetched = rows.length;
      postings.push(...rows);
    } catch (err) {
      outcome.status = 'failed';
      outcome.reason = err instanceof Error ? err.message : String(err);
      log('outreach_source_failed', { source, reason: outcome.reason });
    }
  }

  return { postings, outcomes };
}

/**
 * Turns this morning's feed rows into candidate companies.
 *
 * §9's second tier: a company that hires into this timezone once will do it
 * again. So a posting that the geo filter did not drop makes its employer a
 * candidate, and one that actually names Armenia or Yerevan makes it a better
 * one — which is what the ordering below encodes.
 *
 * The posting URL travels with the candidate because it is frequently an ATS
 * board URL already (`jobs.lever.co/acme/…`), and `verify.ts` reads those
 * without fetching anything at all.
 */
function candidatesFromFeeds(postings: RawPosting[]): Candidate[] {
  const byKey = new Map<string, Candidate & { local: boolean; hits: number }>();

  for (const posting of postings) {
    const blob = Object.values(posting.untrusted).filter(Boolean).join(' ');
    if (geoVerdict(posting.locationText, blob, posting.structured).verdict === 'drop') continue;

    const key = companyKey(posting.company);
    const local = mentionsYerevan(`${posting.locationText} ${blob}`);
    const known = byKey.get(key);

    // The feed's own posting page is not the employer's page — see
    // `MIDDLEMAN_HOSTS`. A URL that survives this is one of the rare rows whose
    // apply link points somewhere real, and it is worth a fetch.
    const usable = posting.url && !isMiddleman(posting.url) ? posting.url : null;

    if (known) {
      known.hits += 1;
      known.local = known.local || local;
      if (usable && known.urls.length < MAX_URLS) {
        known.urls.push({ url: usable, trusted: false });
      }
      continue;
    }

    byKey.set(key, {
      key,
      name: posting.company,
      origin: 'feed',
      urls: usable ? [{ url: usable, trusted: false }] : [],
      note: '',
      local,
      hits: 1,
    });
  }

  return [...byKey.values()]
    .sort((a, b) => (a.local === b.local ? b.hits - a.hits : a.local ? -1 : 1))
    .map((entry) => ({
      key: entry.key,
      name: entry.name,
      origin: entry.origin,
      urls: entry.urls,
      note: entry.local
        ? `${entry.hits} posting(s) in today's feeds naming Armenia or Yerevan`
        : `${entry.hits} posting(s) in today's feeds workable from Yerevan`,
      strong: entry.local,
    }));
}

/**
 * §9's first tier: companies already in the queue, with the evidence attached.
 *
 * A posting that reached `pending.json` was judged worth a human's attention,
 * and if its employer is not on the watch list then the only reason we saw it
 * is that an aggregator happened to carry it. Watching the company directly
 * means seeing the next one on the day it opens rather than on the day a board
 * picks it up — which is the whole argument for a watch list.
 *
 * This is free: the fetch already happened, yesterday.
 */
function candidatesFromQueue(): Candidate[] {
  const byKey = new Map<string, Candidate>();

  for (const item of readPending()) {
    const key = companyKey(item.company);
    if (byKey.has(key)) continue;

    byKey.set(key, {
      key,
      name: item.company,
      origin: 'queue',
      // Same rule as the feeds: a card that arrived through an aggregator
      // carries that aggregator's link, which describes the aggregator.
      urls: item.url && !isMiddleman(item.url) ? [{ url: item.url, trusted: false }] : [],
      note: `already in the review queue — "${item.title}"`,
      strong: true,
    });
  }

  return [...byKey.values()];
}

/**
 * The sentence on the card, composed from what verification proved.
 *
 * Every clause is a number this run measured or a title it was handed by the
 * company's own endpoint, which is what "grounded in that company's actual
 * current postings" means when nothing is generating prose. It cites the
 * evidence the card lists directly beneath it, so the claim and its support
 * cannot drift apart.
 */
function why(candidate: Candidate, result: Extract<VerifyResult, { ok: true }>): string {
  const { detection, postingCount, eligibleCount, localCount, evidence } = result.verified;

  const titles = evidence.map((entry) => entry.title).join('; ');
  const sentences = [
    `Its ${detection.ats} board returns ${postingCount} posting(s), ${eligibleCount} workable from Yerevan today` +
      (localCount > 0 ? ` and ${localCount} naming Armenia or Yerevan outright.` : '.'),
    titles ? `Currently open: ${titles}.` : '',
    `Why it came up: ${candidate.note}.`,
  ].filter(Boolean);

  const text = sentences.join(' ');
  return text.length > WHY_BUDGET ? `${text.slice(0, WHY_BUDGET - 1)}…` : text;
}

/**
 * §9's hygiene rules, which propose and never act.
 *
 * Both of these are advisory by design. A company with no eligible posting for
 * a quarter may simply have had a quiet quarter, and one whose endpoint has
 * failed three mornings running has probably migrated ATS rather than stopped
 * hiring — so the answer to each is a line in a report and a log event, never a
 * deletion. Nothing in this codebase removes a company from the watch list;
 * that edit is a human's, in a committed file, visible in `git diff`.
 */
function hygiene(log: LogFn): CompanyHygiene[] {
  const stats = readCompanyStats();
  const staleAfterMs = staleCompanyDays() * 86_400_000;
  const now = Date.now();
  const findings: CompanyHygiene[] = [];

  for (const company of readWatchlist()) {
    const entry = stats[company.name];
    if (!entry) continue;

    if (entry.consecutiveFailures >= 3) {
      findings.push({
        company: company.name,
        kind: 'redetect',
        consecutiveFailures: entry.consecutiveFailures,
      });
      log('outreach_company_redetect_suggested', {
        company: company.name,
        consecutiveFailures: entry.consecutiveFailures,
        careersUrl: company.careersUrl,
      });
      continue;
    }

    // A company checked for the first time this week is not stale; it is new.
    // The reference point is the last time it produced something eligible,
    // falling back to when it was first checked at all.
    const reference = Date.parse(entry.lastEligibleAt ?? entry.lastCheckedAt ?? '');
    if (!Number.isFinite(reference) || now - reference < staleAfterMs) continue;

    findings.push({
      company: company.name,
      kind: 'stale',
      lastEligibleAt: entry.lastEligibleAt,
      eligibleSeen: entry.eligibleSeen,
    });
    log('outreach_company_stale', {
      company: company.name,
      lastEligibleAt: entry.lastEligibleAt ?? null,
      eligibleSeen: entry.eligibleSeen,
      staleAfterDays: staleCompanyDays(),
    });
  }

  return findings;
}

/**
 * Which company a new one would displace, once the list is at its cap (§9).
 *
 * The quietest: the company that has gone longest without an eligible posting,
 * with the one that has produced fewest as the tiebreak. It is named on the
 * card rather than acted on — approving still only *adds*, and removing the
 * displaced entry is an edit Davit makes in the committed file.
 */
function displaced(): string | undefined {
  const stats = readCompanyStats();
  const ranked = readWatchlist()
    .map((company) => {
      const entry = stats[company.name];
      return {
        name: company.name,
        lastEligible: Date.parse(entry?.lastEligibleAt ?? '') || 0,
        seen: entry?.eligibleSeen ?? 0,
      };
    })
    .sort((a, b) => (a.lastEligible === b.lastEligible ? a.seen - b.seen : a.lastEligible - b.lastEligible));

  return ranked[0]?.name;
}

/**
 * `RunBudget` is shared with the 08:00 job, and its vocabulary is that job's.
 *
 * Only the count differs: there it is queue-worthy postings, here it is
 * verified companies, so `matches` is renamed on the way out rather than the
 * budget being reimplemented for a second caller. `cap` cannot arise — nothing
 * here fetches postings into memory — and the attempt cap is reported by the
 * loop that owns it.
 */
function stopReason(budget: RunBudget): DiscoveryStopReason {
  const stopped = budget.stoppedBy();
  return stopped === 'matches' ? 'suggestions' : stopped === 'cap' ? 'candidates' : stopped;
}

export async function runDiscovery(options: DiscoveryOptions = {}): Promise<DiscoveryRun> {
  const startedAt = new Date().toISOString();
  const started = Date.now();

  const clock = options.deadline ?? discoveryDeadline();
  const deadlineAt = resolveDeadline(clock);
  const budget = new RunBudget({
    deadlineAt,
    durationMs: discoveryBudgetMs(),
    stopAfterMatches: maxSuggestions(),
  });

  const log: LogFn = (event, fields) => logger.info(event, { job: 'discovery', ...fields });
  const attemptCap = options.maxCandidates ?? maxCandidates();

  logger.info('outreach_run_started', {
    job: 'discovery',
    deadline: deadlineAt ? new Date(deadlineAt).toISOString() : null,
    deadlineClock: clock,
    budgetMs: discoveryBudgetMs(),
    maxSuggestions: maxSuggestions(),
    maxCandidates: attemptCap,
  });

  const cache = openCache({ bypass: options.noCache, log });

  // Read first, and unconditionally: this is the cache the 08:00 run inherits,
  // so it is worth doing even on a morning when every candidate is already
  // known. §9's third reason for a separate window.
  const feeds = options.noFeeds
    ? { postings: [] as RawPosting[], outcomes: [] as OutreachOutcome[] }
    : await readFeeds(budget, cache, log);

  const watchlist = readWatchlist();
  const watched = new Set(watchlist.map((company) => fold(company.name)));
  const pendingSuggestions = readSuggestions();
  const alreadySuggested = new Set(pendingSuggestions.map((entry) => entry.id));
  const rejected = rejectedCompanyKeys();
  const attempts = readAttempts();

  // §9's priority order, cheapest and best-evidenced first: a name a person
  // typed, then a company already proving itself in the review queue, then
  // whatever this morning's feeds turned up.
  const generated = [...readCandidateFile(), ...candidatesFromQueue(), ...candidatesFromFeeds(feeds.postings)];

  const seenKeys = new Set<string>();
  const queue: Candidate[] = [];
  /** Names with no address to check. Reported, never attempted — see `MIDDLEMAN_HOSTS`. */
  const unresolved: DiscoveryRun['unresolved'] = [];

  for (const candidate of generated) {
    if (seenKeys.has(candidate.key)) continue;
    seenKeys.add(candidate.key);

    // A name in the seed file is answered even when the answer is "we already
    // knew": the file is a log as well as an input, and a line that is silently
    // skipped every morning looks exactly like a line nothing has got to yet.
    // The machine-generated candidates below it are re-derived daily and have
    // nowhere to write an answer to, which is what `candidate-state.json` is.
    const already = watched.has(fold(candidate.name))
      ? 'already on the watch list'
      : alreadySuggested.has(candidate.key)
        ? 'already suggested and waiting in /admin'
        : // A human's "no" is permanent; this job's own memory of a failed
          // probe expires, which is the difference `candidates.ts` keeps.
          rejected.has(candidate.key)
          ? 'rejected in /admin'
          : null;

    if (already) {
      if (candidate.origin === 'seed-file') annotateCandidate(candidate.name, already);
      continue;
    }

    if (suppressed(attempts, candidate.key)) continue;

    // A name with nowhere to look is not a failed candidate, so it does not
    // spend an attempt and is not remembered as tried: tomorrow's feeds may
    // carry an address, and the person reading the report may know one. The
    // seed file is the exception — a line someone typed gets an answer, even
    // when the answer is "this needs a URL".
    if (candidate.urls.length === 0 && candidate.origin !== 'seed-file') {
      // Only the ones a person would actually want to see. "Any company on
      // earth that hires remotely" is not a watch-list candidate; "a company
      // whose posting named Armenia" is §9's second tier exactly.
      if (candidate.strong) {
        unresolved.push({ company: candidate.name, origin: candidate.origin, note: candidate.note });
      }
      continue;
    }

    queue.push(candidate);
  }

  const suggested: CompanySuggestion[] = [];
  const rejections: DiscoveryRejection[] = [];
  let attempted = 0;
  let stopped: DiscoveryStopReason | null = null;

  // The tab is not allowed to grow without bound, but the bound is generous:
  // a candidate this job declines to verify today is one the feeds may not
  // mention again, and being away for three days is not a reason to lose it.
  // See `maxPendingSuggestions`.
  if (pendingSuggestions.length >= maxPendingSuggestions()) {
    stopped = 'backlog';
    log('outreach_discovery_backlog', {
      pending: pendingSuggestions.length,
      cap: maxPendingSuggestions(),
    });
  }

  const capacity = maxCompanies() - watchlist.length;

  for (const candidate of queue) {
    if (stopped) break;

    if (budget.expired()) {
      stopped = stopReason(budget);
      break;
    }

    if (attempted >= attemptCap) {
      stopped = 'candidates';
      log('outreach_discovery_attempt_cap', { attempted, cap: attemptCap });
      break;
    }

    attempted += 1;
    const result = await verifyCandidate(candidate, { budget, cache, log });

    if (!result.ok) {
      recordAttempt(attempts, candidate, result.reason, result.terminal);
      rejections.push({
        company: candidate.name,
        origin: candidate.origin,
        reason: result.reason,
        detail: result.detail,
      });

      // §12 reads a log dominated by this event as "ATS detection is failing",
      // which is a different fix from "the candidates are bad" — so the reason
      // is on the line rather than in a summary that flattens them together.
      log('outreach_candidate_rejected', {
        company: candidate.name,
        origin: candidate.origin,
        reason: result.reason,
        detail: result.detail,
        unsupported: result.unsupported,
      });

      // The seed file is a log as well as an input (§17.2). Only a conclusion
      // is written back: a network failure leaves the line for tomorrow, or one
      // bad morning would consume the list.
      if (candidate.origin === 'seed-file' && result.terminal) {
        annotateCandidate(candidate.name, `rejected (${result.reason})`);
      }
      continue;
    }

    const { detection, postingCount, eligibleCount, evidence } = result.verified;

    const suggestion: CompanySuggestion = {
      id: candidate.key,
      name: candidate.name,
      careersUrl: detection.careersUrl,
      ats: detection.ats,
      endpoint: detection.endpoint,
      workday: detection.workday,
      verifiedAt: new Date().toISOString(),
      postingCount,
      eligibleCount,
      evidence,
      why: why(candidate, result),
      ...(capacity - suggested.length <= 0 ? { displaces: displaced() } : {}),
    };

    suggested.push(suggestion);
    recordAttempt(attempts, candidate, 'verified', true);
    budget.noteQueued();

    log('outreach_company_verified', {
      company: candidate.name,
      origin: candidate.origin,
      ats: detection.ats,
      marker: detection.marker,
      endpoint: detection.endpoint,
      postingCount,
      eligibleCount,
    });

    if (candidate.origin === 'seed-file') {
      annotateCandidate(candidate.name, `verified (${detection.ats})`);
    }
  }

  if (!stopped) stopped = budget.expired() ? stopReason(budget) : 'exhausted';

  const pending = suggested.length > 0 ? appendSuggestions(suggested) : pendingSuggestions;
  writeAttempts(attempts);

  const run: DiscoveryRun = {
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    stoppedBy: stopped,
    feeds: feeds.outcomes,
    considered: queue.length,
    attempted,
    suggested,
    pending: pending.length,
    rejections,
    // Bounded: on a normal morning this is most of a hundred companies, and a
    // report nobody can read is a report nobody reads. The count is in the log
    // line below, and the ordering is the same one the queue uses — companies
    // whose postings named Armenia first.
    unresolved: unresolved.slice(0, 15),
    unresolvedTotal: unresolved.length,
    hygiene: hygiene(log),
    watchlistSize: watchlist.length,
    reportPath: null,
  };

  run.reportPath = writeDiscoveryReport(run);

  // No notification, deliberately (§12). The suggestions sit in the tab with a
  // badge and the 08:00 job folds their count into its own push half an hour
  // later; two pushes half an hour apart, both saying "go and look at the same
  // screen", is how a channel gets muted.
  logger.info('outreach_run_completed', {
    job: 'discovery',
    durationMs: run.durationMs,
    stoppedBy: run.stoppedBy,
    considered: run.considered,
    attempted: run.attempted,
    verified: suggested.length,
    pending: run.pending,
    rejected: rejections.length,
    unresolved: unresolved.length,
    rejectedBy: rejections.reduce<Record<string, number>>((counts, entry) => {
      counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
      return counts;
    }, {}),
    hygiene: run.hygiene.length,
    watchlist: run.watchlistSize,
    capacity,
    feeds: feeds.outcomes.map((outcome) => ({
      source: outcome.source,
      status: outcome.status,
      reason: outcome.reason,
      postings: outcome.postingsFetched,
    })),
  });

  return run;
}

/**
 * Whether the 08:00 job has run since this one, for the terminal summary.
 *
 * Not used for any decision — the two jobs are deliberately independent, and
 * neither fails if the other never ran. It is here because §11 asks for both
 * halves' numbers in the daily summary: "the two halves diagnose each other",
 * and a person reading the 07:00 transcript should be able to see whether the
 * queue it is feeding is actually moving.
 */
export function lastOpportunityRun(): { queued: number; stoppedBy: string } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(RUN_REPORT_FILE, 'utf-8')) as {
      queued?: number;
      stoppedBy?: string;
    };
    return { queued: parsed.queued ?? 0, stoppedBy: parsed.stoppedBy ?? 'unknown' };
  } catch {
    return null;
  }
}
