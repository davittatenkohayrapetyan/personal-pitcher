import type { FetchContext, RawPosting, WatchedCompany } from '../types';
import { jsonHeaders } from './http';

/**
 * Lever postings — `api.lever.co/v0/postings/{company}?mode=json`.
 *
 * Verified live on 2026-09-14. Two things about this feed are unusual enough to
 * shape the adapter:
 *
 * **It ships plain text alongside every HTML field.** `descriptionPlain`,
 * `additionalPlain` and `openingPlain` are Lever's own renderings of the same
 * content. They are used instead of running the HTML through `htmlToText`,
 * because a cleaner that has to guess where a `<li>` ended is a cleaner that can
 * get it wrong, and the board has already answered the question.
 *
 * **The title is in `text`.** There is no `title` field. A `row.title ?? ''`
 * written from memory compiles, returns empty strings for every posting, and
 * produces a run that finds nothing while reporting no errors at all.
 *
 * `workplaceType` is one of `remote`, `hybrid`, `onsite` or `unspecified`, and
 * goes through to the geo filter untouched — `unspecified` is not `onsite`, and
 * treating it as either would be the adapter deciding something the employer
 * declined to.
 */

/** Bytes kept per prose field. Enough for stage A, not enough to fill a log (§20). */
const TEXT_BUDGET = 8_000;

interface LeverPosting {
  id: string;
  /** The title. Lever has no `title` field — see the header. */
  text: string;
  hostedUrl?: string;
  applyUrl?: string;
  createdAt?: number;
  country?: string;
  workplaceType?: string;
  categories?: {
    location?: string;
    allLocations?: string[];
    team?: string;
    department?: string;
    commitment?: string;
  };
  descriptionPlain?: string;
  additionalPlain?: string;
  openingPlain?: string;
  salaryRange?: {
    min?: number;
    max?: number;
    currency?: string;
    /** `per-year-salary` on the boards checked. */
    interval?: string;
  } | null;
}

export async function fetchLever(ctx: FetchContext): Promise<RawPosting[]> {
  const company = ctx.company;
  if (!company) throw new Error('Lever adapter requires a company');
  if (ctx.budget.expired()) return [];

  const response = await fetch(company.endpoint, { headers: jsonHeaders() });
  if (!response.ok) {
    throw new Error(`Lever ${response.status} ${response.statusText} for ${company.endpoint}`);
  }

  const rows = (await response.json()) as LeverPosting[];
  const postings = Array.isArray(rows) ? rows : [];

  ctx.log('outreach_source_page', {
    source: 'lever',
    company: company.name,
    returned: postings.length,
  });

  return normaliseLever(postings, company);
}

export function normaliseLever(rows: LeverPosting[], company: WatchedCompany): RawPosting[] {
  return rows.map((row) => {
    const locations = row.categories?.allLocations?.length
      ? row.categories.allLocations
      : [row.categories?.location].filter(Boolean);

    return {
      source: 'lever' as const,
      key: row.id,
      company: company.name,
      title: row.text,
      url: row.hostedUrl ?? row.applyUrl ?? '',
      locationText: [...locations, row.country].filter(Boolean).join('; '),
      postedAt: row.createdAt ? new Date(row.createdAt).toISOString() : undefined,
      untrusted: {
        // `opening` is the pitch, `description` the role, `additional` the
        // boilerplate. All three are the employer's words, so all three are
        // untrusted; they are kept apart because stage A reads them as labelled
        // sections rather than as one wall of text.
        description: row.descriptionPlain?.slice(0, TEXT_BUDGET) || undefined,
        responsibilities: row.openingPlain?.slice(0, TEXT_BUDGET) || undefined,
        requirements: row.additionalPlain?.slice(0, TEXT_BUDGET) || undefined,
      },
      structured: {
        workplaceType: row.workplaceType,
        employmentType: row.categories?.commitment,
        compensationMin: row.salaryRange?.min,
        compensationMax: row.salaryRange?.max,
        compensationCurrency: row.salaryRange?.currency,
        compensationPeriod: row.salaryRange?.interval,
      },
    };
  });
}
