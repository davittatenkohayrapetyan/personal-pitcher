import fs from 'fs';
import path from 'path';
import type { CompanyStats, WatchedCompany } from './types';
import { COMPANIES_FILE, COMPANY_STATS_FILE } from './config';
import { logger } from '../logger';

/**
 * The watch list — `data/outreach/companies.json`.
 *
 * Committed, unlike every other store in `data/outreach/`, so that every change
 * to it shows up in `git diff`: the same "approve, then review the diff" loop
 * the profile refresh uses. It is also the one file here that is not a
 * statement about Davit — it is a list of employers — which is why it is safe
 * to commit at all. It still has no path into `src/lib/profile/`: the site has
 * no reason to tell a visitor which companies are being watched.
 *
 * The per-run counters live beside it in a gitignored sidecar rather than in
 * the file itself (see `CompanyStats`), so this file changes only when the list
 * itself does. Adding a company happens in
 * `/admin` from phase 5, and only after the candidate's endpoint has returned a
 * parseable posting (§9) — guessing Align's ATS from its name failed three
 * times while the plan was being written, and an entry that quietly returns
 * nothing is worse than a short list, because every run pays for it and nobody
 * notices.
 */

export function readWatchlist(): WatchedCompany[] {
  let raw: string;
  try {
    raw = fs.readFileSync(COMPANIES_FILE, 'utf-8');
  } catch {
    logger.warn('outreach_watchlist_missing', { file: COMPANIES_FILE });
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as WatchedCompany[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    // Unlike the derived stores, this file is hand-edited and committed, so a
    // syntax error in it is a mistake someone made and wants to hear about —
    // not a transient state to recover from silently.
    logger.error('outreach_watchlist_unreadable', {
      file: COMPANIES_FILE,
      reason: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Loose match for `--company=nvidia`: case, spacing and punctuation blind. */
export function matchCompany(companies: WatchedCompany[], needle: string): WatchedCompany[] {
  const fold = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = fold(needle);
  return companies.filter((company) => fold(company.name).includes(wanted));
}

export function readCompanyStats(): Record<string, CompanyStats> {
  try {
    const parsed = JSON.parse(fs.readFileSync(COMPANY_STATS_FILE, 'utf-8')) as Record<
      string,
      CompanyStats
    >;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // Absent and corrupt both mean "nothing counted yet". These are advisory
    // numbers behind a suggestion a human reads; losing them costs a staleness
    // hint, not a posting.
    return {};
  }
}

export interface CheckResult {
  /** How many of this company's postings passed or were flagged by the geo filter. */
  eligible: number;
  /** How many of those had not been seen on an earlier run. */
  newlyFound: number;
  /** True when the endpoint could not be read at all. */
  failed: boolean;
}

/**
 * Writes back what this run learned about each company.
 *
 * `consecutiveFailures` resets on any successful read, so three means three in
 * a row — a company that migrated between ATS platforms, which §9 turns into a
 * re-detection suggestion. A company that is merely quiet keeps its counters
 * and is proposed for removal only by the staleness rule, never automatically:
 * a quiet quarter at a company Davit cares about is not a reason to stop
 * watching.
 */
export function recordChecks(results: Map<string, CheckResult>): void {
  if (results.size === 0) return;

  const stats = readCompanyStats();
  const now = new Date().toISOString();

  for (const [name, result] of results) {
    const entry = stats[name] ?? { eligibleSeen: 0, consecutiveFailures: 0 };

    entry.lastCheckedAt = now;
    entry.consecutiveFailures = result.failed ? entry.consecutiveFailures + 1 : 0;

    // Two different questions, and they need the two different numbers. Is the
    // company still open to us? — any eligible posting answers that, including
    // one that has been open for four months, which is why staleness reads
    // `eligible` and not `newlyFound`. How much has this company actually
    // produced? — only postings never counted before, or a single long-lived
    // Yerevan role would add one to the total every morning and a quiet
    // company would look prolific.
    if (result.eligible > 0) entry.lastEligibleAt = now;
    entry.eligibleSeen += result.newlyFound;

    stats[name] = entry;

    if (entry.consecutiveFailures >= 3) {
      logger.warn('outreach_company_unreadable', {
        company: name,
        consecutiveFailures: entry.consecutiveFailures,
      });
    }
  }

  fs.mkdirSync(path.dirname(COMPANY_STATS_FILE), { recursive: true });
  fs.writeFileSync(COMPANY_STATS_FILE, `${JSON.stringify(stats, null, 2)}
`, 'utf-8');
}
