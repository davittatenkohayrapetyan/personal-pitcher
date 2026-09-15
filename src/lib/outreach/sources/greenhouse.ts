import type { FetchContext, RawPosting, WatchedCompany } from '../types';
import { decodeEntities, htmlToText } from './html';
import { jsonHeaders } from './http';

/**
 * Greenhouse boards — `boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true`.
 *
 * The most common ATS among product companies, and the simplest of the six: one
 * keyless GET returns the whole board with descriptions included. Verified
 * against three live boards on 2026-09-14 (Figma, 153 postings; Stripe; GitLab).
 *
 * ## `content` is HTML inside HTML
 *
 * The field arrives entity-encoded: `&lt;div class=&quot;content-intro&quot;&gt;`
 * rather than `<div class="content-intro">`. Run it through `htmlToText` alone
 * and the tags survive as literal text, so stage A would read markup as prose
 * and the geo filter would match words inside attribute values. It is decoded
 * first and stripped second, which is the only order that ends with the text a
 * human would see on the page.
 *
 * ## No compensation, and no guessing at one
 *
 * Greenhouse's board API returns no pay fields — not on any of the three boards
 * checked. Where a company publishes a range it is prose inside `content`, so
 * it reaches stage A like any other sentence and nothing here pretends to a
 * structured number it does not have.
 *
 * ## Why the volume is not a problem here
 *
 * A Greenhouse board is a whole company's hiring, most of it in offices that
 * are not Yerevan, and `location.name` is free text with no workplace-type
 * field to read — so the structured drop rules the aggregators rely on have
 * nothing to bite on. That is tolerable because this adapter only ever runs for
 * a company already on the watch list: the list is curated, approved one entry
 * at a time (§9), and a run reads it rather than the whole of Greenhouse.
 */

/** Bytes kept per description. Enough for stage A, not enough to fill a log (§20). */
const TEXT_BUDGET = 8_000;

interface GreenhouseJob {
  id: number | string;
  title: string;
  absolute_url: string;
  updated_at?: string;
  first_published?: string;
  requisition_id?: string;
  company_name?: string;
  location?: { name?: string } | null;
  offices?: { name?: string }[];
  content?: string;
}

export async function fetchGreenhouse(ctx: FetchContext): Promise<RawPosting[]> {
  const company = ctx.company;
  if (!company) throw new Error('Greenhouse adapter requires a company');
  if (ctx.budget.expired()) return [];

  const response = await fetch(company.endpoint, { headers: jsonHeaders() });
  if (!response.ok) {
    throw new Error(`Greenhouse ${response.status} ${response.statusText} for ${company.endpoint}`);
  }

  const payload = (await response.json()) as { jobs?: GreenhouseJob[] };
  const rows = payload.jobs ?? [];

  ctx.log('outreach_source_page', {
    source: 'greenhouse',
    company: company.name,
    returned: rows.length,
  });

  return normaliseGreenhouse(rows, company);
}

export function normaliseGreenhouse(rows: GreenhouseJob[], company: WatchedCompany): RawPosting[] {
  return rows.map((row) => {
    // `location.name` is one string that may already hold several places
    // ("San Francisco, CA - New York, NY - United States"); `offices[]` is the
    // board's own taxonomy ("US"). Both are joined because the filter's job is
    // to find any mention of Armenia, and either field can be the one carrying
    // it.
    const offices = (row.offices ?? []).map((office) => office.name).filter(Boolean);
    const locationText = [row.location?.name, ...offices].filter(Boolean).join('; ');

    return {
      source: 'greenhouse' as const,
      key: String(row.id),
      // The watch-list name wins over `company_name`: it is what the rest of
      // the system dedupes and counts on, and a board that renames itself
      // mid-quarter must not split one company into two.
      company: company.name,
      title: row.title,
      url: row.absolute_url,
      locationText,
      postedAt: row.first_published ?? row.updated_at,
      untrusted: {
        description: row.content
          ? htmlToText(decodeEntities(row.content), TEXT_BUDGET)
          : undefined,
      },
      structured: {},
    };
  });
}
