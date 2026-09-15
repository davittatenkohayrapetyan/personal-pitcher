import type { RawPosting } from '../types';

/**
 * The adapter boundary: everything past this function is a well-formed
 * `RawPosting`, whatever a board sent.
 *
 * ## Why a type is not enough here
 *
 * Every adapter in this directory is written against a response that was
 * captured once and looked at by hand, and the compiler believes the interface
 * it was given. Neither survives contact with a feed that omits a field on one
 * row out of three hundred — an aggregator row missing `company_name` produces
 * `company: undefined`, which is a valid `RawPosting` as far as the compiler
 * ever knows, and the first thing downstream to fold a company name into a
 * dedupe hash calls `.toLowerCase()` on it.
 *
 * That throw is the expensive kind. It escapes the run loop, so there is no
 * report, no cursor write and no per-company counters; every source behind the
 * failing one goes unread; and because the cursor never advanced, the next
 * morning starts in the same place and crashes on the same row. The job is
 * stuck until someone reads a log — which is the one failure mode a scheduled
 * job must not have, because nobody reads the log of a job that has been
 * quietly working for a month.
 *
 * ## Drop the row, keep the run
 *
 * So a malformed posting is one dropped posting and one log line, not a dead
 * morning. The five fields checked are the ones the rest of the system
 * addresses a posting *by*: `key` and `source` are its identity, `company` and
 * `title` are its dedupe hash, and `url` is the only thing on an `/admin` card
 * that is not somebody's opinion. A posting missing any of them cannot be
 * acted on even if everything else about it is perfect.
 *
 * Optional fields are normalised rather than rejected: a missing
 * `locationText` means the geo filter reads an empty string, which is a
 * `default-pass` and a decision for a human — not a reason to discard a role.
 */

/** What is wrong with one row, for the log. Stable strings, so they can be counted. */
export interface PostingDefect {
  source: string;
  key: string;
  reasons: string[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ValidationResult {
  postings: RawPosting[];
  defects: PostingDefect[];
}

export function validatePostings(raw: unknown[]): ValidationResult {
  const postings: RawPosting[] = [];
  const defects: PostingDefect[] = [];

  for (const candidate of raw) {
    if (!isPlainObject(candidate)) {
      defects.push({ source: 'unknown', key: 'unknown', reasons: ['not-an-object'] });
      continue;
    }

    const reasons: string[] = [];
    for (const field of ['source', 'key', 'company', 'title', 'url'] as const) {
      if (!isNonEmptyString(candidate[field])) reasons.push(`${field}-missing`);
    }

    if (reasons.length > 0) {
      defects.push({
        source: typeof candidate.source === 'string' ? candidate.source : 'unknown',
        key: typeof candidate.key === 'string' ? candidate.key : 'unknown',
        reasons,
      });
      continue;
    }

    const posting = candidate as unknown as RawPosting;

    postings.push({
      ...posting,
      // Trimmed here rather than in nine adapters: a trailing space in a company
      // name is a different dedupe hash, and "Coalition Technologies " really
      // does come back that way from Remotive.
      company: posting.company.trim(),
      title: posting.title.trim(),
      locationText: typeof posting.locationText === 'string' ? posting.locationText : '',
      untrusted: isPlainObject(posting.untrusted) ? posting.untrusted : {},
      structured: isPlainObject(posting.structured) ? posting.structured : {},
    });
  }

  return { postings, defects };
}
