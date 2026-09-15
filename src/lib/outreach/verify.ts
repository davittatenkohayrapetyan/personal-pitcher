import type { Budget, FetchCache, FetchContext, RawPosting, WatchedCompany } from './types';
import type { Candidate } from './candidates';
import { detectAts, type Detection } from './detect';
import { geoVerdict } from './geo';
import { ATS_ADAPTERS } from './sources/registry';
import { validatePostings } from './sources/validate';
import { USER_AGENT } from './sources/http';

/**
 * Proving that a candidate company can actually be monitored (§9).
 *
 * This is the whole point of the 07:00 job, and the plan says so in as many
 * words: *verification is the point, not the summary.* A watch list full of
 * entries that quietly return nothing is worse than a short one, because every
 * morning pays for them and nobody notices — the failure is invisible by
 * construction, since "no postings today" is also what a healthy quiet company
 * looks like.
 *
 * So a candidate is not proposed until this module has:
 *
 *  1. fetched a page that might name its ATS,
 *  2. detected that ATS **by marker** (`detect.ts` — never from the company
 *     name; three name-based guesses at Align's ATS all returned 404), and
 *  3. **called the resulting endpoint with the adapter the 08:00 run would use,
 *     and got back at least one posting that adapter could parse.**
 *
 * Step 3 is deliberately the real adapter rather than a "does this URL return
 * 200?" probe. A 200 proves a server answered; it does not prove that
 * `fetchAshby` can find `payload.jobs` in the answer, and the difference
 * between those two is exactly the class of watch-list entry that returns
 * nothing for a month. Running the adapter also means a company is added on the
 * evidence of the code path that will read it every morning afterwards.
 *
 * ## "Empty" counts as a failure, and that is deliberate for Workday
 *
 * Four of the five ATS adapters return a company's whole board, so "at least
 * one posting" is trivially true and `eligibleCount` does the discriminating.
 * Workday is different: `fetchWorkday` queries server-side for
 * `OUTREACH_WORKDAY_SEARCH_TERMS`, so a Workday board with nothing matching
 * `Armenia` or `Yerevan` verifies as empty. That is the right answer rather
 * than a false negative — it is precisely what the 08:00 run would see from
 * that company every morning, which is the entry §9 exists to keep off the
 * list. `candidates.ts` lets it be tried again in a month.
 *
 * A candidate that fails any step is discarded silently — not proposed with a
 * caveat, not queued for a human to figure out. The reason is logged, because
 * §12 reads `outreach_candidate_rejected` as a diagnostic about *detection*
 * rather than about the candidates.
 */

/** One page fetch, one endpoint call. Generous enough for a slow careers page. */
const PAGE_TIMEOUT_MS = 15_000;

/**
 * Bytes of careers-page HTML kept.
 *
 * A marker is a URL in a script tag or an anchor, and pages that carry one
 * carry it early. Half a megabyte is several times the largest careers page
 * checked while this was written, and the cap is what stops a run holding a
 * 20 MB single-page-app bundle in memory while it runs twelve regexes over it.
 */
const HTML_BUDGET = 512_000;

/** Endpoint calls per candidate. Detection ranks its guesses; this bounds them. */
const MAX_ATTEMPTS = 3;

/**
 * Why a candidate was discarded. Stable strings: §12 counts them, and a count
 * that is dominated by `no-marker` means the detector needs work, while one
 * dominated by `endpoint-empty` means the candidates do.
 */
export type RejectionReason =
  | 'no-url'
  | 'page-unreachable'
  | 'page-fetch-failed'
  | 'no-marker'
  | 'unsupported-ats'
  | 'endpoint-unreadable'
  | 'endpoint-empty'
  /**
   * The run ended in the middle of this candidate.
   *
   * Not a fact about the company, and kept apart from every reason above for
   * exactly that: recorded as one of those it would be *terminal*, and a run
   * that hit 07:30 halfway through a page fetch would have suppressed a
   * perfectly good candidate for a month on the strength of the clock.
   */
  | 'run-stopped';

export interface Verified {
  detection: Detection;
  /** What the endpoint returned, parsed by the adapter that will read it daily. */
  postingCount: number;
  /** How many of those pass the Yerevan filter today (§9's card, line 2). */
  eligibleCount: number;
  /**
   * How many name Armenia or Yerevan outright — the geo filter's override rule.
   *
   * Kept apart from `eligibleCount` because on a whole-company board the two
   * are wildly different numbers and only one of them is decisive. Figma's
   * board verifies at 155 of 158 "eligible", which says little more than that
   * the company does not publish geographic restrictions; Align's four Yerevan
   * postings out of 218 are the reason to watch Align. This is the second
   * number, and it goes in the card's sentence.
   */
  localCount: number;
  /** Up to three real postings, so the claim on the card can be checked. */
  evidence: { title: string; url: string }[];
}

export type VerifyResult =
  | { ok: true; verified: Verified }
  | {
      ok: false;
      reason: RejectionReason;
      detail?: string;
      /** True when tomorrow's answer would be the same. See `candidates.ts`. */
      terminal: boolean;
      /** A recognised ATS with no adapter, when that is why this failed. */
      unsupported?: string[];
    };

export interface VerifyContext {
  budget: Budget;
  cache: FetchCache;
  log: (event: string, fields: Record<string, unknown>) => void;
}

/**
 * Fetches one page as a browser would be served it.
 *
 * Plain `fetch` with the honest User-Agent §6 requires — the same one every
 * adapter sends. This is one GET of one public page per candidate, which is
 * what §9 describes; nothing here crawls, follows links, or comes back for a
 * second page.
 */
async function fetchPage(url: string): Promise<{ status: number; html: string; finalUrl: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': USER_AGENT,
      },
      signal: controller.signal,
    });

    const body = response.ok ? (await response.text()).slice(0, HTML_BUDGET) : '';
    return { status: response.status, html: body, finalUrl: response.url || url };
  } finally {
    clearTimeout(timer);
  }
}

/** Everything the employer wrote about one posting, as one string for the filter. */
function untrustedBlob(posting: RawPosting): string {
  return Object.values(posting.untrusted).filter(Boolean).join(' ');
}

/**
 * Calls one detected endpoint with its real adapter.
 *
 * The synthetic `WatchedCompany` is the same shape the watch list would hold if
 * this candidate were approved — including the Workday triple, which the
 * adapter needs to build detail URLs. That is what makes this a rehearsal of
 * tomorrow morning rather than an approximation of it.
 */
async function callEndpoint(
  candidate: Candidate,
  detection: Detection,
  ctx: VerifyContext,
): Promise<RawPosting[]> {
  const fetcher = ATS_ADAPTERS[detection.ats];
  if (!fetcher) throw new Error(`no adapter for ${detection.ats}`);

  const company: WatchedCompany = {
    name: candidate.name,
    ats: detection.ats,
    endpoint: detection.endpoint,
    careersUrl: detection.careersUrl,
    workday: detection.workday,
    addedAt: new Date().toISOString().slice(0, 10),
    addedBy: 'approved',
  };

  const context: FetchContext = {
    company,
    budget: ctx.budget,
    cache: ctx.cache,
    log: ctx.log,
  };

  const { postings } = validatePostings(await fetcher(context));
  return postings;
}

/**
 * The verification pipeline for one candidate.
 *
 * Reads as the three steps of §9 because it is them, in order, with the
 * cheapest first: detection is tried against the candidate's URLs *as strings*
 * before anything is fetched, since an aggregator's posting URL is frequently
 * an ATS board URL already and costs nothing to read.
 */
export async function verifyCandidate(
  candidate: Candidate,
  ctx: VerifyContext,
): Promise<VerifyResult> {
  if (candidate.urls.length === 0) {
    return {
      ok: false,
      reason: 'no-url',
      // Terminal, and the annotation in `candidates.txt` says what to do about
      // it: §9's "resolve the name by search" needs the one open-web query this
      // design allows, and there is no search credential here (§23).
      terminal: true,
      detail: 'no careers page URL — add one beside the name',
    };
  }

  const detections: Detection[] = [];
  const unsupported = new Set<string>();
  let lastPageFailure: { reason: RejectionReason; detail: string; terminal: boolean } | null = null;

  // Pass one: the URLs themselves. Free, and often decisive.
  for (const entry of candidate.urls) {
    const found = detectAts('', entry.url, {
      allowOriginFallback: false,
      companyName: candidate.name,
    });
    detections.push(...found.detections);
    for (const name of found.unsupported) unsupported.add(name);
  }

  let stoppedByBudget = false;

  // Pass two: the pages behind them, until something is detected.
  for (const entry of candidate.urls) {
    if (detections.length > 0) break;
    if (ctx.budget.expired()) {
      stoppedByBudget = true;
      break;
    }

    let page: { status: number; html: string; finalUrl: string };
    try {
      page = await fetchPage(entry.url);
    } catch (err) {
      lastPageFailure = {
        reason: 'page-fetch-failed',
        detail: err instanceof Error ? err.message : String(err),
        // A timeout or a DNS failure says nothing about the company. Recording
        // it as conclusive would let one bad network morning eat the candidate
        // list for a month.
        terminal: false,
      };
      continue;
    }

    if (!page.html) {
      lastPageFailure = {
        reason: 'page-unreachable',
        detail: `HTTP ${page.status}`,
        terminal: true,
      };
      continue;
    }

    const found = detectAts(page.html, page.finalUrl, {
      // Only a URL a person wrote down is treated as the company's own page.
      // On a third party's page — an aggregator posting — a Pinpoint marker
      // would otherwise resolve to that aggregator's origin, and a sidebar link
      // to an unrelated board would resolve to an unrelated company.
      allowOriginFallback: entry.trusted,
      companyName: candidate.name,
    });

    detections.push(...found.detections);
    for (const name of found.unsupported) unsupported.add(name);
  }

  if (detections.length === 0) {
    // Asked before "no marker", because the two are opposite claims: one says
    // this company's page does not name an ATS, the other says we never
    // finished looking.
    if (stoppedByBudget) return { ok: false, reason: 'run-stopped', terminal: false };
    if (unsupported.size > 0) {
      return {
        ok: false,
        reason: 'unsupported-ats',
        detail: [...unsupported].join(', '),
        terminal: true,
        unsupported: [...unsupported],
      };
    }
    if (lastPageFailure) return { ok: false, ...lastPageFailure };
    return { ok: false, reason: 'no-marker', terminal: true };
  }

  let lastEndpointFailure: { reason: RejectionReason; detail: string } | null = null;

  for (const detection of detections.slice(0, MAX_ATTEMPTS)) {
    if (ctx.budget.expired()) {
      stoppedByBudget = true;
      break;
    }

    let postings: RawPosting[];
    try {
      postings = await callEndpoint(candidate, detection, ctx);
    } catch (err) {
      lastEndpointFailure = {
        reason: 'endpoint-unreadable',
        detail: err instanceof Error ? err.message : String(err),
      };
      ctx.log('outreach_candidate_endpoint_failed', {
        job: 'discovery',
        company: candidate.name,
        ats: detection.ats,
        marker: detection.marker,
        endpoint: detection.endpoint,
        reason: lastEndpointFailure.detail,
      });
      continue;
    }

    // §9's rule, exactly: at least one posting the adapter could parse. An
    // endpoint that answers with an empty board proves the URL exists and
    // proves nothing about whether this system can read it.
    if (postings.length === 0) {
      lastEndpointFailure = { reason: 'endpoint-empty', detail: detection.endpoint };
      continue;
    }

    // Each posting is judged once and the decision is kept, because the card
    // needs both what the verdict was and *which rule* produced it.
    const judged = postings.map((posting) => ({
      posting,
      decision: geoVerdict(posting.locationText, untrustedBlob(posting), posting.structured),
    }));

    const eligible = judged.filter((entry) => entry.decision.verdict !== 'drop');
    const local = eligible.filter((entry) => entry.decision.rule === 'yerevan-override');

    return {
      ok: true,
      verified: {
        detection,
        postingCount: postings.length,
        eligibleCount: eligible.length,
        localCount: local.length,
        // Postings naming Armenia first, then merely eligible ones, then the
        // rest, deduped by URL. The ordering is what makes the card decisive:
        // a board with one Yerevan role and two hundred others should lead with
        // that role, and `eligible.slice(0, 3)` would lead with whatever the
        // board happened to list first — three sales roles in Bengaluru, as it
        // did the first time this ran.
        evidence: [
          ...new Map(
            [...local, ...eligible, ...judged].map((entry) => [
              entry.posting.url,
              { title: entry.posting.title, url: entry.posting.url },
            ]),
          ).values(),
        ].slice(0, 3),
      },
    };
  }

  if (!lastEndpointFailure && stoppedByBudget) {
    return { ok: false, reason: 'run-stopped', terminal: false };
  }

  return {
    ok: false,
    reason: lastEndpointFailure?.reason ?? 'endpoint-unreadable',
    detail: lastEndpointFailure?.detail,
    terminal: true,
  };
}
