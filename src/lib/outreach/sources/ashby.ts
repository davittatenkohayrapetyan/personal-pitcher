import type { FetchContext, RawPosting, WatchedCompany } from '../types';
import { jsonHeaders } from './http';

/**
 * Ashby job boards — `api.ashbyhq.com/posting-api/job-board/{name}?includeCompensation=true`.
 *
 * Verified live on 2026-09-14 against two boards. Like Lever it publishes a
 * plain-text rendering of every description, so no HTML is parsed here.
 *
 * ## Compensation, and the flag that gates it
 *
 * `includeCompensation=true` returns a `compensation` object per posting, but
 * the number that matters is behind `shouldDisplayCompensationOnJobPostings`.
 * That flag is this board's equivalent of Pinpoint's `compensation_visible`,
 * and it is honoured for the same reason: a range the employer has marked as
 * not-for-publication is not ours to put in an application, whatever the API
 * hands over.
 *
 * `summaryComponents` is a list — salary, equity, bonus — so the salary entry
 * is selected by `compensationType` rather than by position. On the board
 * checked, equity came first.
 *
 * ## `workplaceType` beats `isRemote`
 *
 * Both fields exist and they disagree: one posting on Notion's board is
 * `workplaceType: "Hybrid"` and `isRemote: true`. `workplaceType` is the field
 * the board's own UI renders, and it is the one the geo filter reads. The
 * disagreement is not resolved here — picking one and silently dropping the
 * other is how a hybrid role in San Francisco ends up in a queue of remote work.
 */

/** Bytes kept per description. Enough for stage A, not enough to fill a log (§20). */
const TEXT_BUDGET = 8_000;

interface AshbyCompensationComponent {
  compensationType?: string;
  interval?: string;
  currencyCode?: string | null;
  minValue?: number | null;
  maxValue?: number | null;
}

interface AshbyJob {
  id: string;
  title: string;
  department?: string;
  team?: string;
  employmentType?: string;
  location?: string;
  secondaryLocations?: { location?: string }[];
  publishedAt?: string;
  isListed?: boolean;
  isRemote?: boolean;
  workplaceType?: string;
  jobUrl?: string;
  applyUrl?: string;
  descriptionPlain?: string;
  shouldDisplayCompensationOnJobPostings?: boolean;
  compensation?: {
    compensationTierSummary?: string | null;
    scrapeableCompensationSalarySummary?: string | null;
    summaryComponents?: AshbyCompensationComponent[];
  } | null;
}

export async function fetchAshby(ctx: FetchContext): Promise<RawPosting[]> {
  const company = ctx.company;
  if (!company) throw new Error('Ashby adapter requires a company');
  if (ctx.budget.expired()) return [];

  const response = await fetch(company.endpoint, { headers: jsonHeaders() });
  if (!response.ok) {
    throw new Error(`Ashby ${response.status} ${response.statusText} for ${company.endpoint}`);
  }

  const payload = (await response.json()) as { jobs?: AshbyJob[] };
  const rows = payload.jobs ?? [];

  ctx.log('outreach_source_page', {
    source: 'ashby',
    company: company.name,
    returned: rows.length,
  });

  return normaliseAshby(rows, company);
}

export function normaliseAshby(rows: AshbyJob[], company: WatchedCompany): RawPosting[] {
  // `isListed: false` is a posting the company has taken down but not deleted.
  // It is excluded rather than surfaced: applying to a delisted role is at best
  // wasted, and at worst an application to something already filled.
  return rows
    .filter((row) => row.isListed !== false)
    .map((row) => {
      const visible = row.shouldDisplayCompensationOnJobPostings === true;
      const salary = visible
        ? row.compensation?.summaryComponents?.find(
            (component) => component.compensationType === 'Salary',
          )
        : undefined;

      const secondary = (row.secondaryLocations ?? [])
        .map((entry) => entry.location)
        .filter(Boolean);

      return {
        source: 'ashby' as const,
        key: row.id,
        company: company.name,
        title: row.title,
        url: row.jobUrl ?? row.applyUrl ?? '',
        locationText: [row.location, ...secondary].filter(Boolean).join('; '),
        postedAt: row.publishedAt,
        untrusted: {
          description: row.descriptionPlain?.slice(0, TEXT_BUDGET) || undefined,
        },
        structured: {
          workplaceType: row.workplaceType,
          employmentType: row.employmentType,
          compensationMin: salary?.minValue ?? undefined,
          compensationMax: salary?.maxValue ?? undefined,
          compensationCurrency: salary?.currencyCode ?? undefined,
          // "1 YEAR" on the board checked — kept as the board says it rather than
          // normalised to "year", so a value that turns up in a form field is
          // traceable to the source it came from.
          compensationPeriod: salary?.interval ?? undefined,
          compensationText: visible
            ? (row.compensation?.scrapeableCompensationSalarySummary ??
              row.compensation?.compensationTierSummary ??
              undefined)
            : undefined,
          compensationVisible: row.shouldDisplayCompensationOnJobPostings,
        },
      };
    });
}
