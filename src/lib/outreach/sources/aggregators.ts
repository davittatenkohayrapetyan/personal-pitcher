import type { FetchContext, RawPosting } from '../types';
import { aggregatorPageLimit, himalayasPages } from '../config';
import { htmlToText } from './html';
import { jsonHeaders } from './http';

/**
 * The four aggregators: Remotive, RemoteOK, Arbeitnow and Himalayas.
 *
 * One module rather than four files, because the interesting part is not any
 * one of them — it is the normalisation. Four boards describe the same job four
 * ways, and everything downstream of the `normalise*` functions below is
 * written against one shape. Splitting them up would put four copies of that
 * mapping in four places and make the differences between the boards harder to
 * see, when the differences are exactly what this file is for.
 *
 * All four were called live on 2026-09-14 and the field names below are what
 * came back, not what the documentation claims. Three things that only a live
 * call reveals:
 *
 *  - **Remotive's whole feed was 16 postings** that morning (`total-job-count`),
 *    and `limit` did not change it. The API also returns a legal notice as a
 *    top-level key demanding attribution and forbidding redistribution — which
 *    this job honours by never republishing anything: postings are read by one
 *    person in a private admin tab, and every card leads with the source link.
 *  - **Himalayas caps `limit` at 20** and pages by cursor; its own `comments`
 *    field says `offset` is deprecated and will be removed. Its query
 *    parameters do nothing: `?timezone=4`, `?country=Armenia` and
 *    `?seniority=Senior` each returned the same unfiltered page as a bare call,
 *    with an India-restricted role at the top. §1's "filters by
 *    country/seniority/timezone" is not true of the public endpoint, so the
 *    filtering happens here (see §23 of the plan).
 *  - **RemoteOK's `location` is not a candidate restriction.** Sixty-two
 *    distinct values in one page, mostly cities: "Seoul", "San Francisco",
 *    "Bishkek, Bishkek, Bishkek City, Kyrgyzstan". So it is passed as location
 *    text and never as `candidateRestrictions`, which the geo filter acts on.
 *    Remotive and Himalayas do publish a real restriction, and theirs is.
 *
 * ## Why none of them is asked to search
 *
 * Every one of these boards will filter server-side, and this adapter uses none
 * of it. A keyword search costs the same one request as the unfiltered feed —
 * the saving is ours, not the board's — and it buys that nothing by throwing
 * away recall. The role in §1.2 that made the strongest case for this whole
 * system, NVIDIA's remote CIS developer-relations post, matches no keyword a
 * Java architect would think to type. The geo filter reads the whole record for
 * free; a search box reads the title.
 */

/** Bytes kept per description. Enough for stage A, not enough to fill a log (§20). */
const TEXT_BUDGET = 8_000;

/** Himalayas caps `limit` at 20 whatever is asked for. Measured, not documented. */
const HIMALAYAS_PAGE_SIZE = 20;

// ─── Remotive ────────────────────────────────────────────────────────────────

interface RemotiveJob {
  id: number | string;
  url: string;
  title: string;
  company_name: string;
  category?: string;
  tags?: string[];
  job_type?: string;
  publication_date?: string;
  candidate_required_location?: string;
  salary?: string;
  description?: string;
}

export async function fetchRemotive(ctx: FetchContext): Promise<RawPosting[]> {
  if (ctx.budget.expired()) return [];

  const payload = await ctx.cache.json<{ jobs?: RemotiveJob[] }>(
    'https://remotive.com/api/remote-jobs',
    { headers: jsonHeaders() },
  );

  const rows = (payload.jobs ?? []).slice(0, aggregatorPageLimit());
  ctx.log('outreach_source_page', { source: 'remotive', returned: rows.length });

  return normaliseRemotive(rows);
}

/**
 * The mapping, separated from the call that produces its input.
 *
 * Every adapter in this directory exposes one of these, and `--source-fixtures`
 * runs them over the saved responses in `data/outreach/fixtures/`. That drill is
 * the whole reason for the split: this repo has no test framework, and a
 * normaliser written from memory against a board's documentation compiles,
 * returns empty strings for every posting, and produces a run that finds
 * nothing while reporting no errors at all. Lever's title lives in `text`.
 */
export function normaliseRemotive(rows: RemotiveJob[]): RawPosting[] {
  return rows.map((row) => ({
    source: 'remotive' as const,
    key: String(row.id),
    company: row.company_name.trim(),
    title: row.title,
    url: row.url,
    locationText: row.candidate_required_location ?? '',
    postedAt: row.publication_date,
    untrusted: {
      description: row.description ? htmlToText(row.description, TEXT_BUDGET) : undefined,
    },
    structured: {
      employmentType: row.job_type,
      // "$31,2k- $52k" — free text, and kept as free text. Parsing a number out
      // of it would invent a precision the board does not have, and this is the
      // field that ends up in front of a hiring manager.
      compensationText: row.salary?.trim() || undefined,
      // A real restriction field: "Worldwide", "USA", "LATAM, Europe, USA,
      // Canada, APAC". Split, because the geo filter's question is whether any
      // one of the listed regions could include Armenia.
      candidateRestrictions: splitRestrictions(row.candidate_required_location),
    },
  }));
}

// ─── RemoteOK ────────────────────────────────────────────────────────────────

interface RemoteOkRow {
  id?: string;
  slug?: string;
  company?: string;
  position?: string;
  date?: string;
  location?: string;
  description?: string;
  url?: string;
  apply_url?: string;
  salary_min?: number;
  salary_max?: number;
  /** Only on the notice at index 0. Its presence is how that row is recognised. */
  legal?: string;
}

export async function fetchRemoteOk(ctx: FetchContext): Promise<RawPosting[]> {
  if (ctx.budget.expired()) return [];

  const payload = await ctx.cache.json<RemoteOkRow[]>('https://remoteok.com/api', {
    // RemoteOK refuses a request with no User-Agent outright.
    headers: jsonHeaders(),
  });

  const rows = (Array.isArray(payload) ? payload : []).slice(0, aggregatorPageLimit() + 1);
  ctx.log('outreach_source_page', { source: 'remoteok', returned: rows.length });

  return normaliseRemoteOk(rows).slice(0, aggregatorPageLimit());
}

export function normaliseRemoteOk(rows: RemoteOkRow[]): RawPosting[] {
  // §1 says to skip index 0, which is a legal notice rather than a job. Checked
  // by shape instead of by position, and inside the normaliser rather than at
  // the call site: if the notice ever moves or disappears, a positional skip
  // silently discards a real posting, and putting the check here is what lets
  // the fixture drill prove the notice never becomes one.
  return rows
    .filter((row) => !row.legal && row.id && row.position)
    .map((row) => {
      // 0 means "not stated" on this board, not "unpaid".
      const min = row.salary_min && row.salary_min > 0 ? row.salary_min : undefined;
      const max = row.salary_max && row.salary_max > 0 ? row.salary_max : undefined;

      return {
        source: 'remoteok' as const,
        key: String(row.id),
        company: (row.company ?? '').trim(),
        title: row.position ?? '',
        url: row.url ?? row.apply_url ?? '',
        // The employer's city, not a restriction on the candidate — see the
        // header. It goes in the haystack the geo filter reads, where a city name
        // is evidence, and not into `candidateRestrictions`, where it would be
        // treated as a rule.
        locationText: row.location ?? '',
        postedAt: row.date,
        untrusted: {
          description: row.description ? htmlToText(row.description, TEXT_BUDGET) : undefined,
        },
        structured: {
          compensationMin: min,
          compensationMax: max,
          // RemoteOK publishes these as annual USD; there is no currency field to
          // read, so the constant is stated here rather than left to be assumed
          // downstream by whoever compares it against a preference in USD.
          compensationCurrency: min || max ? 'USD' : undefined,
          compensationPeriod: min || max ? 'year' : undefined,
        },
      };
    });
}

// ─── Arbeitnow ───────────────────────────────────────────────────────────────

interface ArbeitnowJob {
  slug: string;
  company_name: string;
  title: string;
  description?: string;
  remote?: boolean;
  url: string;
  tags?: string[];
  job_types?: string[];
  location?: string;
  created_at?: number;
}

export async function fetchArbeitnow(ctx: FetchContext): Promise<RawPosting[]> {
  if (ctx.budget.expired()) return [];

  const payload = await ctx.cache.json<{ data?: ArbeitnowJob[] }>(
    'https://www.arbeitnow.com/api/job-board-api',
    { headers: jsonHeaders() },
  );

  const rows = (payload.data ?? []).slice(0, aggregatorPageLimit());
  ctx.log('outreach_source_page', { source: 'arbeitnow', returned: rows.length });

  return normaliseArbeitnow(rows);
}

export function normaliseArbeitnow(rows: ArbeitnowJob[]): RawPosting[] {
  return rows.map((row) => ({
    source: 'arbeitnow' as const,
    key: row.slug,
    company: row.company_name,
    title: row.title,
    url: row.url,
    // The employer's address. Most of this board is German on-site work, which
    // is why the `remote` flag below matters more here than anywhere else.
    locationText: row.location ?? '',
    postedAt: row.created_at ? new Date(row.created_at * 1000).toISOString() : undefined,
    untrusted: {
      description: row.description ? htmlToText(row.description, TEXT_BUDGET) : undefined,
    },
    structured: {
      // §1: "includes on-site, so read the `remote` flag". `false` means the
      // role is at `location`, so it reaches the geo filter as `onsite` and is
      // dropped unless the Yerevan override fires first — which is exactly the
      // treatment a Frankfurt office role should get and a Yerevan one must not.
      workplaceType: row.remote === true ? 'remote' : 'onsite',
      employmentType: row.job_types?.length ? row.job_types.join(', ') : undefined,
    },
  }));
}

// ─── Himalayas ───────────────────────────────────────────────────────────────

interface HimalayasJob {
  guid: string;
  title: string;
  companyName: string;
  applicationLink?: string;
  description?: string;
  excerpt?: string;
  employmentType?: string;
  minSalary?: number | null;
  maxSalary?: number | null;
  currency?: string | null;
  salaryPeriod?: string | null;
  seniority?: string[];
  locationRestrictions?: string[];
  timezoneRestrictions?: number[];
  pubDate?: number;
}

export async function fetchHimalayas(ctx: FetchContext): Promise<RawPosting[]> {
  const postings: RawPosting[] = [];
  const pages = himalayasPages();
  let cursor: string | undefined;

  for (let page = 0; page < pages; page += 1) {
    // Checked before every request, not just at the top: paging is the one
    // place in this file where one unit of work is several HTTP calls, so it is
    // the one place a deadline can pass in the middle of a source.
    if (ctx.budget.expired()) {
      ctx.log('outreach_source_paging_stopped', { source: 'himalayas', page, reason: 'budget' });
      break;
    }

    const url =
      `https://himalayas.app/jobs/api?limit=${HIMALAYAS_PAGE_SIZE}` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');

    const payload = await ctx.cache.json<{ jobs?: HimalayasJob[]; nextCursor?: string }>(url, {
      headers: jsonHeaders(),
    });

    const rows = payload.jobs ?? [];
    ctx.log('outreach_source_page', { source: 'himalayas', page, returned: rows.length });

    postings.push(...normaliseHimalayas(rows));

    if (!payload.nextCursor || rows.length === 0) break;
    cursor = payload.nextCursor;
  }

  return postings.slice(0, aggregatorPageLimit());
}

export function normaliseHimalayas(rows: HimalayasJob[]): RawPosting[] {
  return rows.map((row) => ({
    source: 'himalayas' as const,
    key: row.guid,
    company: row.companyName,
    title: row.title,
    url: row.applicationLink ?? row.guid,
    locationText: (row.locationRestrictions ?? []).join(', '),
    postedAt: row.pubDate ? new Date(row.pubDate * 1000).toISOString() : undefined,
    untrusted: {
      description: row.description
        ? htmlToText(row.description, TEXT_BUDGET)
        : row.excerpt
          ? htmlToText(row.excerpt, TEXT_BUDGET)
          : undefined,
    },
    structured: {
      employmentType: row.employmentType ?? undefined,
      compensationMin: row.minSalary ?? undefined,
      compensationMax: row.maxSalary ?? undefined,
      compensationCurrency: row.currency ?? undefined,
      compensationPeriod: row.salaryPeriod ?? undefined,
      candidateRestrictions: row.locationRestrictions?.filter(Boolean),
      // The reason this board is on the list at all (§1): a published list of
      // acceptable candidate timezones, as UTC offsets. Yerevan is +4.
      timezoneOffsets: row.timezoneRestrictions?.length ? row.timezoneRestrictions : undefined,
    },
  }));
}

// ─── Shared ──────────────────────────────────────────────────────────────────

/**
 * `"LATAM, Europe, USA, Canada, APAC"` → five entries.
 *
 * Returns undefined rather than an empty array when there is nothing to split.
 * The geo filter treats "no restriction published" and "restricted to nowhere"
 * very differently, and an empty array is the sort of value that quietly
 * becomes the second one.
 */
function splitRestrictions(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}
