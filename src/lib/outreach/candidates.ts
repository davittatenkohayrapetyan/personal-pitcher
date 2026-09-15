import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CANDIDATES_FILE, CANDIDATE_STATE_FILE } from './config';
import { logger } from '../logger';

/**
 * Where the 07:00 job's candidates come from, and what it remembers about them.
 *
 * Two stores with opposite lifetimes, which is why they are two files:
 *
 *  - **`candidates.txt` is committed, hand-edited, and both input and log.** A
 *    name Davit drops in after a meetup is picked up by the next morning's run,
 *    verified, and comes back as a card with its endpoint already proven — no
 *    manual ATS archaeology (§9). When a line has been resolved it is commented
 *    out *in place* with the outcome, so the file also answers "did anything
 *    ever come of that?" a month later.
 *  - **`candidate-state.json` is gitignored and machine-written.** Most
 *    candidates are not typed by anyone: they are company names the aggregator
 *    feeds hand over every morning, re-derived from scratch each run. Without a
 *    memory of what was tried, the job would spend its entire budget re-probing
 *    the same twenty companies whose careers pages carry no marker — every
 *    morning, for ever, while the candidates that might have worked sat behind
 *    them.
 *
 * ## Why a rejection here expires and a human's does not
 *
 * `rejected.json` holds decisions a person made, and those are permanent. This
 * file holds what the *network* said, which is a fact with a shelf life:
 * companies launch careers pages, migrate between ATS platforms, and turn
 * boards on. So a failed attempt suppresses a candidate for `RETRY_AFTER_DAYS`
 * and then lets it through again, and a transient failure — a timeout, a DNS
 * hiccup, the deadline arriving first — suppresses nothing at all. A scheduled
 * job that consumed its own input on a bad network morning would lose the input.
 */

/** The identity §17.2 gives a suggestion, and therefore what a rejection is keyed on. */
export function companyKey(name: string): string {
  return crypto
    .createHash('sha256')
    .update(name.toLowerCase().replace(/[^a-z0-9]/g, ''))
    .digest('hex')
    .slice(0, 16);
}

/**
 * How long a conclusive failure keeps a candidate out of the queue.
 *
 * A month, not for ever. The three terminal outcomes — no marker, an ATS with
 * no adapter, an endpoint that could not be read — are all statements about a
 * company's website today, and websites change. A constant rather than an
 * environment variable because it is not a knob anyone would turn: it trades
 * one wasted request a month against noticing that a company has started
 * hiring, and the trade is not close.
 */
const RETRY_AFTER_DAYS = 30;

/** Where a candidate came from. Carried onto the card, because it is evidence. */
export type CandidateOrigin = 'seed-file' | 'queue' | 'feed';

export interface Candidate {
  /** `companyKey(name)`, so this is also the suggestion's id and a rejection's. */
  key: string;
  name: string;
  origin: CandidateOrigin;
  /**
   * Pages that might name the company's ATS, best first.
   *
   * A posting URL is often an ATS board URL already, which detects with no
   * fetch at all; a careers URL from `candidates.txt` is the authoritative one
   * and is marked as such by `trusted`.
   */
  urls: { url: string; trusted: boolean }[];
  /** One line of why this name is here, for the card's `why` and the log. */
  note: string;
  /**
   * Worth a person's attention even if it cannot be verified today.
   *
   * Set for a name in the seed file, a company already in the review queue, and
   * a feed company whose postings actually named Armenia or Yerevan — §9's
   * second tier, which is about a company that hires into this timezone rather
   * than about any company that hires remotely. It decides what reaches the
   * morning's report when there is no address to check: without it, a run that
   * cannot resolve anything prints seventy-five company names, which is a list
   * nobody reads twice.
   */
  strong?: boolean;
}

// ─── candidates.txt ──────────────────────────────────────────────────

/** A line that has not been resolved yet: not blank, not a comment. */
function isLive(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && !trimmed.startsWith('#');
}

const URL_IN_LINE = /(https?:\/\/\S+)/i;

/**
 * Reads the seed file.
 *
 * A line is a company name, optionally followed by the URL of its careers page.
 * The URL is what makes the line actionable: §9's fourth candidate tier
 * resolves a bare name through one open-web search, and there is no search
 * credential in this repo — so a name with no URL is annotated rather than
 * guessed at. See §23; guessing a company's domain from its name is the same
 * mistake as guessing its ATS, one layer down.
 */
export function readCandidateFile(): Candidate[] {
  let raw: string;
  try {
    raw = fs.readFileSync(CANDIDATES_FILE, 'utf-8');
  } catch {
    // Absent is normal: the file only exists because someone put a name in it.
    return [];
  }

  const candidates: Candidate[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!isLive(line)) continue;

    const url = URL_IN_LINE.exec(line)?.[1];
    const name = line.replace(URL_IN_LINE, '').trim().replace(/[\s,;·—-]+$/, '').trim();
    if (!name) continue;

    candidates.push({
      key: companyKey(name),
      name,
      origin: 'seed-file',
      urls: url ? [{ url, trusted: true }] : [],
      note: 'a name in candidates.txt',
      strong: true,
    });
  }

  return candidates;
}

/**
 * Comments a resolved line out in place, with what happened to it.
 *
 * In place rather than appended to the end, and the original text is preserved
 * inside the comment, because this file is read by a person: a name they typed
 * should still be where they typed it, with the answer beside it.
 *
 * Only called for outcomes that will be the same tomorrow. A run that never got
 * to a line, or failed to reach the network, leaves it untouched.
 */
export function annotateCandidate(name: string, outcome: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(CANDIDATES_FILE, 'utf-8');
  } catch {
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const wanted = name.toLowerCase();
  let changed = false;

  const lines = raw.split(/\r?\n/).map((line) => {
    if (changed || !isLive(line)) return line;
    if (!line.toLowerCase().includes(wanted)) return line;

    changed = true;
    return `# ${line.trim()} — ${outcome} ${today}`;
  });

  if (!changed) return;

  try {
    fs.writeFileSync(CANDIDATES_FILE, lines.join('\n'), 'utf-8');
  } catch (err) {
    // The annotation is a convenience; the attempt is recorded in
    // `candidate-state.json` either way, so a read-only checkout costs a note
    // rather than a repeated probe.
    logger.warn('outreach_candidates_unwritable', {
      job: 'discovery',
      file: CANDIDATES_FILE,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── What has already been tried ─────────────────────────────────────

export interface CandidateAttempt {
  name: string;
  lastTriedAt: string;
  /** The stable reason slug — `no-marker`, `endpoint-unreadable`, `verified`. */
  outcome: string;
  /** True when the outcome will be the same tomorrow. Only these suppress. */
  terminal: boolean;
  attempts: number;
}

export function readAttempts(): Record<string, CandidateAttempt> {
  try {
    const parsed = JSON.parse(fs.readFileSync(CANDIDATE_STATE_FILE, 'utf-8')) as Record<
      string,
      CandidateAttempt
    >;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // Absent and corrupt both mean "nothing tried yet". The cost of being wrong
    // is one morning of repeated probes, which is why this never throws.
    return {};
  }
}

export function writeAttempts(attempts: Record<string, CandidateAttempt>): void {
  try {
    fs.mkdirSync(path.dirname(CANDIDATE_STATE_FILE), { recursive: true });
    fs.writeFileSync(CANDIDATE_STATE_FILE, `${JSON.stringify(attempts, null, 2)}\n`, 'utf-8');
  } catch (err) {
    logger.warn('outreach_candidate_state_unwritable', {
      job: 'discovery',
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

export function recordAttempt(
  attempts: Record<string, CandidateAttempt>,
  candidate: Candidate,
  outcome: string,
  terminal: boolean,
): void {
  const known = attempts[candidate.key];
  attempts[candidate.key] = {
    name: candidate.name,
    lastTriedAt: new Date().toISOString(),
    outcome,
    terminal,
    attempts: (known?.attempts ?? 0) + 1,
  };
}

/** True when a conclusive failure is still inside its cooling-off period. */
export function suppressed(
  attempts: Record<string, CandidateAttempt>,
  key: string,
  now: number = Date.now(),
): boolean {
  const attempt = attempts[key];
  if (!attempt?.terminal) return false;

  const age = now - Date.parse(attempt.lastTriedAt);
  return Number.isFinite(age) && age < RETRY_AFTER_DAYS * 86_400_000;
}
