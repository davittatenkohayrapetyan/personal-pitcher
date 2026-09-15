import type { FetchContext, RawPosting, WatchedCompany } from '../types';
import { htmlToText } from './html';
import { jsonHeaders } from './http';

/**
 * Pinpoint adapter — `{careers-domain}/postings.json`. Align Technology is here.
 *
 * The most generous feed on the list: one keyless GET returns every open
 * posting with its full description *and* structured compensation, which is
 * rare. Verified by hand on 2026-09-13 and again on 2026-09-14 — 218 postings,
 * four of them in Yerevan, one of which is the Sr. Java Engineer role that made
 * §2 of the plan rewrite its own geo filter.
 *
 * Finding this endpoint at all is why §9 verifies rather than guesses: three
 * name-based guesses at Align's ATS (Lever, Greenhouse, Ashby) all returned
 * 404, and the answer came from one grep of the careers page for
 * `pinpointhq.com`.
 *
 * ## Structured beats extracted
 *
 * `workplace_type`, `employment_type` and the compensation range are read
 * straight out of the response and carried in `structured`, where §4 says they
 * outrank anything stage A would later say about the same facts. That is a
 * model call not made and a hallucination surface that never opens.
 * `compensation_visible` gates the range: a min and max the employer has marked
 * unpublishable are not ours to put in an application.
 *
 * The three prose fields are HTML, and they go into `untrusted` — this is the
 * text an employer wrote, so nothing but stage A ever reads it.
 */

/** Bytes kept per prose field. Align's descriptions run to a few thousand. */
const TEXT_BUDGET = 8_000;

interface PinpointLocation {
  name?: string;
  city?: string;
  province?: string | null;
  street_address?: string | null;
}

interface PinpointPosting {
  id: string;
  title: string;
  url: string;
  location?: PinpointLocation | null;
  employment_type?: string | null;
  employment_type_text?: string | null;
  workplace_type?: string | null;
  workplace_type_text?: string | null;
  description?: string | null;
  key_responsibilities?: string | null;
  skills_knowledge_expertise?: string | null;
  compensation_minimum?: number | string | null;
  compensation_maximum?: number | string | null;
  compensation_currency?: string | null;
  compensation_frequency?: string | null;
  compensation_visible?: boolean | null;
}

function amount(raw: number | string | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * `{ name: 'EMEA-Armenia-Yerevan', city: 'Yerevan' }` -> `EMEA-Armenia-Yerevan Yerevan`.
 *
 * Note that `location` is an object here. §17.3 of the plan describes it as "a
 * plain string like `EMEA-Armenia-Yerevan`" — that string is the `name` field.
 * Both it and `city` are joined, because the hyphenated `name` is a slug and
 * the geo filter's word-boundary rules read the city more reliably.
 */
function locationText(location: PinpointLocation | null | undefined): string {
  if (!location) return '';
  return [location.name, location.city, location.province].filter(Boolean).join(' ');
}

export async function fetchPinpoint(ctx: FetchContext): Promise<RawPosting[]> {
  const company = ctx.company;
  if (!company) throw new Error('Pinpoint adapter requires a company');

  // One request for the whole board, so the deadline is checked once. An
  // adapter that cannot be interrupted halfway still has to ask before it
  // starts — a run that is over should not open another connection.
  if (ctx.budget.expired()) return [];

  const response = await fetch(company.endpoint, { headers: jsonHeaders() });

  if (!response.ok) {
    throw new Error(`Pinpoint ${response.status} ${response.statusText} for ${company.endpoint}`);
  }

  const payload = (await response.json()) as { data?: PinpointPosting[] };
  const rows = payload.data ?? [];

  ctx.log('outreach_source_page', {
    source: 'pinpoint',
    company: company.name,
    returned: rows.length,
  });

  return normalisePinpoint(rows, company);
}

export function normalisePinpoint(rows: PinpointPosting[], company: WatchedCompany): RawPosting[] {
  return rows.map((row) => {
    const visible = row.compensation_visible === true;

    return {
      source: 'pinpoint' as const,
      key: row.id,
      company: company.name,
      title: row.title,
      url: row.url,
      locationText: locationText(row.location),
      // The feed carries no publication date — not even `created_at` — so this
      // stays undefined rather than being filled with the time we happened to
      // read it, which would make every posting look new every morning.
      postedAt: undefined,
      untrusted: {
        description: row.description ? htmlToText(row.description, TEXT_BUDGET) : undefined,
        responsibilities: row.key_responsibilities
          ? htmlToText(row.key_responsibilities, TEXT_BUDGET)
          : undefined,
        requirements: row.skills_knowledge_expertise
          ? htmlToText(row.skills_knowledge_expertise, TEXT_BUDGET)
          : undefined,
      },
      structured: {
        workplaceType: row.workplace_type_text ?? row.workplace_type ?? undefined,
        employmentType: row.employment_type_text ?? row.employment_type ?? undefined,
        compensationMin: visible ? amount(row.compensation_minimum) : undefined,
        compensationMax: visible ? amount(row.compensation_maximum) : undefined,
        compensationCurrency: visible ? (row.compensation_currency ?? undefined) : undefined,
        compensationPeriod: visible ? (row.compensation_frequency ?? undefined) : undefined,
        compensationVisible: row.compensation_visible ?? undefined,
      },
    };
  });
}
