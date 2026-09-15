import type { FetchContext, RawPosting, WatchedCompany } from '../types';
import { workdaySearchTerms } from '../config';
import { htmlToText } from './html';
import { jsonHeaders } from './http';

/**
 * Workday adapter — `*.myworkdayjobs.com`. NVIDIA is here.
 *
 * The endpoint is the one the careers page itself calls: a keyless POST that
 * hands over a filtered list of requisitions. No browser, no login, no
 * scraping. Verified by hand on 2026-09-13 and again on 2026-09-14.
 *
 * ## Politeness is a correctness requirement here, not a courtesy
 *
 * Akamai bot management sits in front of `/wday/cxs/`, and hammering it from
 * one residential IP gets that IP blocked within minutes. So: one request at a
 * time process-wide, never less than `MIN_INTERVAL_MS` apart, server-side
 * `searchText` filtering instead of paging the whole board, and a 403 treated
 * as "stop for today" rather than "retry harder". A block costs a day of
 * NVIDIA postings; retrying through one costs the address the site is served
 * from.
 *
 * The User-Agent names the bot and carries a contact URL (§6). That was the one
 * open question when this was written — an honest UA against a bot-managed
 * endpoint could plausibly have been refused — so it was tested rather than
 * assumed: the honest string returns 200 with the same body a browser string
 * does. This is Davit's name on the traffic, and a politeness bug here is a
 * reputation bug.
 *
 * ## Why some postings need a second request
 *
 * A list row for a single-location posting carries that location in
 * `locationsText`. A multi-location posting carries the string "2 Locations"
 * instead, and the actual locations exist only on the detail record. That is
 * neither a rare case nor a harmless one: NVIDIA's Munich requisition lists
 * `Armenia, Remote` among its `additionalLocations`, so it is a genuinely
 * Yerevan-workable role whose list row reads "Germany-Munich, 5 Locations".
 * Ask the geo filter about that row as it stands and the answer is `drop` —
 * the exact class of miss §2 of the plan exists to prevent.
 *
 * So the detail record is fetched, at the same rate limit, and only for rows
 * that hid their locations. Rows that already state one cost nothing extra.
 */

const MIN_INTERVAL_MS = 2_000;

/** Rows per search term. The board is filtered server-side; this is not a page walk. */
const PAGE_LIMIT = 20;

/** Detail fetches per company per run. Each is a request against a bot-managed host. */
const MAX_DETAILS = 10;

/** Description bytes kept. Enough for stage A to read; not enough to fill a log. */
const DESCRIPTION_BUDGET = 8_000;

/** A row whose locations live on the detail record rather than in the list. */
const HIDDEN_LOCATIONS = /^\s*\d+\s+locations\s*$/i;

/**
 * A 403 from Workday. Distinct from a transport failure because the remedy is
 * the opposite: stop asking, rather than ask again.
 */
export class WorkdayBlockedError extends Error {
  constructor(url: string) {
    super(`Workday returned 403 for ${url}. Backing off for the rest of the run.`);
    this.name = 'WorkdayBlockedError';
  }
}

/**
 * Set by the first 403 of the process and never cleared.
 *
 * Process-wide rather than per company: the block is applied to the IP, so a
 * second Workday board would be asking the same gatekeeper the same question
 * from the same address, having just been told no.
 */
let blocked = false;

/** Serialises every Workday request in the process and spaces them out. */
let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function headers(company: WatchedCompany): Record<string, string> {
  return jsonHeaders({
    'Content-Type': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    // Workday's own careers page sends this; a request without it is
    // conspicuous in a way that has nothing to do with being polite.
    Referer: company.careersUrl,
  });
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const run = async (): Promise<T> => {
    if (blocked) throw new WorkdayBlockedError(url);

    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    const response = await fetch(url, init);

    if (response.status === 403) {
      blocked = true;
      throw new WorkdayBlockedError(url);
    }
    if (!response.ok) {
      throw new Error(`Workday ${response.status} ${response.statusText} for ${url}`);
    }

    return (await response.json()) as T;
  };

  // Chained rather than called directly, so two companies on the same board
  // cannot interleave their requests. The chain is re-armed with a swallowed
  // rejection so one failure does not poison every request queued behind it.
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}

interface JobPosting {
  title: string;
  externalPath: string;
  locationsText: string;
  postedOn?: string;
  bulletFields?: string[];
}

interface JobDetail {
  jobPostingInfo?: {
    title?: string;
    jobDescription?: string;
    location?: string;
    additionalLocations?: string[];
    postedOn?: string;
    timeType?: string;
    jobReqId?: string;
    externalUrl?: string;
  };
}

function requireWorkday(company: WatchedCompany): { origin: string; tenant: string; site: string } {
  if (!company.workday) {
    // Parsed and stored at watch-list-add time precisely so it is never
    // re-derived from a URL here. An entry missing it is a malformed watch
    // list, not a posting to parse around.
    throw new Error(`Watch list entry "${company.name}" has ats:workday but no workday block`);
  }
  return company.workday;
}

/** `/job/Armenia-Remote/Developer-Relations-Manager-CIS_JR2024290` -> `Armenia Remote`. */
function locationFromPath(externalPath: string): string {
  const segment = externalPath.split('/').filter(Boolean)[1] ?? '';
  return segment.replace(/-/g, ' ').trim();
}

async function fetchDetail(
  company: WatchedCompany,
  posting: JobPosting,
  ctx: FetchContext,
): Promise<NonNullable<JobDetail['jobPostingInfo']> | null> {
  const { origin, tenant, site } = requireWorkday(company);
  const url = `${origin}/wday/cxs/${tenant}/${site}${posting.externalPath}`;

  try {
    const detail = await request<JobDetail>(url, { method: 'GET', headers: headers(company) });
    return detail.jobPostingInfo ?? null;
  } catch (err) {
    if (err instanceof WorkdayBlockedError) throw err;
    // One unreadable detail record is not a failed company: the row still has a
    // title, a URL, and whatever its path says about location.
    ctx.log('outreach_source_detail_failed', {
      source: 'workday',
      company: company.name,
      key: posting.externalPath,
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Fetches the description for one posting, after the fact.
 *
 * Stage A needs text, and a Workday list row carries none unless it hid its
 * locations (see the header). Rather than pulling a description for all twenty
 * rows on the chance that one will be scored — twenty requests against a
 * bot-managed host, nineteen of them wasted — this is called for the postings
 * that actually reach stage A, which the budget has already bounded to a
 * handful.
 *
 * It goes through the same serialised, rate-limited `request` as everything else
 * in this file, so hydrating during scoring cannot overtake the adapter's own
 * politeness. A failure returns null: one posting with no description is
 * `unscored`, which is a state the queue already has words for.
 */
export async function hydrateWorkday(
  company: WatchedCompany,
  key: string,
  log: FetchContext['log'],
): Promise<{ description?: string; employmentType?: string } | null> {
  const { origin, tenant, site } = requireWorkday(company);
  const url = `${origin}/wday/cxs/${tenant}/${site}${key}`;

  try {
    const detail = await request<JobDetail>(url, { method: 'GET', headers: headers(company) });
    const info = detail.jobPostingInfo;
    if (!info?.jobDescription) return null;

    return {
      description: htmlToText(info.jobDescription, DESCRIPTION_BUDGET),
      employmentType: info.timeType,
    };
  } catch (err) {
    log('outreach_source_detail_failed', {
      source: 'workday',
      company: company.name,
      key,
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function fetchWorkday(ctx: FetchContext): Promise<RawPosting[]> {
  const company = ctx.company;
  if (!company) throw new Error('Workday adapter requires a company');

  const { origin, site } = requireWorkday(company);
  const rows = new Map<string, JobPosting>();

  for (const searchText of workdaySearchTerms()) {
    // Each term is its own request, two seconds apart by policy, so this loop
    // is the longest a single company can hold the run open. Checked between
    // terms rather than only at the top: the deadline can pass inside it.
    if (ctx.budget.expired()) {
      ctx.log('outreach_source_paging_stopped', {
        source: 'workday',
        company: company.name,
        searchText,
        reason: 'budget',
      });
      break;
    }

    const payload = await request<{ total?: number; jobPostings?: JobPosting[] }>(
      company.endpoint,
      {
        method: 'POST',
        headers: headers(company),
        body: JSON.stringify({ appliedFacets: {}, limit: PAGE_LIMIT, offset: 0, searchText }),
      },
    );

    const returned = payload.jobPostings ?? [];
    ctx.log('outreach_source_page', {
      source: 'workday',
      company: company.name,
      searchText,
      total: payload.total ?? returned.length,
      returned: returned.length,
    });

    // The terms overlap by design — "Yerevan" is a subset of "Armenia" — so the
    // union is deduped on the path, which is the requisition's identity.
    for (const row of returned) rows.set(row.externalPath, row);
  }

  const postings: RawPosting[] = [];
  let details = 0;

  for (const row of rows.values()) {
    const pathLocation = locationFromPath(row.externalPath);
    const hidden = HIDDEN_LOCATIONS.test(row.locationsText);

    // The list row when it states a location, the path slug when it hides one,
    // and the detail record's full list when there is one. Not all three
    // concatenated: `Armenia, Yerevan Armenia Yerevan` reads like a bug in a
    // report a person is meant to skim.
    let locationText = hidden ? pathLocation : row.locationsText;
    let description: string | undefined;
    let employmentType: string | undefined;

    // A detail fetch is a second request against a bot-managed host, so the
    // budget gates it as well as `MAX_DETAILS` does. A row that goes without
    // one keeps the location its path slug gives — the same degraded-but-honest
    // value the cap already produces, rather than a gap.
    if (hidden && details < MAX_DETAILS && !ctx.budget.expired()) {
      details += 1;
      const detail = await fetchDetail(company, row, ctx);
      if (detail) {
        locationText = [detail.location, ...(detail.additionalLocations ?? [])]
          .filter(Boolean)
          .join('; ');
        employmentType = detail.timeType;
        description = detail.jobDescription
          ? htmlToText(detail.jobDescription, DESCRIPTION_BUDGET)
          : undefined;
      }
    }

    postings.push(toPosting(company, row, { locationText, description, employmentType }));
  }

  return postings;
}

/** What the detail record added, when one was fetched. All three are optional. */
interface Enrichment {
  locationText: string;
  description?: string;
  employmentType?: string;
}

function toPosting(
  company: WatchedCompany,
  row: JobPosting,
  enrichment: Enrichment,
): RawPosting {
  const { origin, site } = requireWorkday(company);

  return {
    source: 'workday',
    // The requisition path rather than the id in `bulletFields`: the path is
    // what every URL here is built from, and a repost reuses the id with a
    // `-1` suffix on the path.
    key: row.externalPath,
    company: company.name,
    title: row.title,
    url: `${origin}/${site}${row.externalPath}`,
    locationText: enrichment.locationText,
    // "Posted 12 Days Ago" — relative prose, not a date. Kept verbatim rather
    // than converted, because the arithmetic would invent a precision the
    // source does not have.
    postedAt: row.postedOn,
    untrusted: enrichment.description ? { description: enrichment.description } : {},
    structured: enrichment.employmentType ? { employmentType: enrichment.employmentType } : {},
  };
}

/**
 * The list rows alone, with no detail fetches — what `--source-fixtures` runs.
 *
 * A row whose locations are hidden behind "5 Locations" keeps its path slug
 * here, which is the same degraded value a live run falls back to when the
 * detail budget is spent. The drill is therefore checking the mapping, not
 * pretending to check the enrichment.
 */
export function normaliseWorkday(rows: JobPosting[], company: WatchedCompany): RawPosting[] {
  return rows.map((row) =>
    toPosting(company, row, {
      locationText: HIDDEN_LOCATIONS.test(row.locationsText)
        ? locationFromPath(row.externalPath)
        : row.locationsText,
    }),
  );
}
