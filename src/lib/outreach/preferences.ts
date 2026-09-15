import fs from 'fs';
import type { Seniority, WorkAuthorization } from './types';
import { PREFERENCES_FILE } from './config';
import { logger } from '../logger';

/**
 * The private preference doc, parsed into typed values.
 *
 * ## Why this is a type and not a prompt
 *
 * The thresholds in `private/job-preferences.md` are what stage B applies to
 * decide `draft` / `surface_only` / `skip`. Handing them to a model as prose
 * would mean a rule like "nothing below Senior" survives only as long as the
 * model feels like honouring it, and the failure would be silent — a mid-level
 * posting drafted into an application, discovered a week later. Parsed into
 * `minSeniority`, the same rule is a comparison in code.
 *
 * The free prose in `## Notes` still reaches a model, but only stage C, which
 * writes and never decides. That split is the whole point of the file's shape:
 * the sections that *decide* are key-value, and a sentence added to the notes
 * cannot silently become a threshold.
 *
 * ## Why this file is not in `data/`
 *
 * `data/` is concatenated into the prompt beside `SYSTEM_PROMPT` on every
 * visitor question. A salary floor kept there would be answered honestly to the
 * first visitor who asked for it. §5 of `docs/job-outreach-plan.md`.
 *
 * Nothing here is imported by `src/lib/profile/` or `src/lib/retrieval.ts`, and
 * the `verify` skill greps to keep it that way.
 */

/** `unclear` is deliberately absent — it is a stage-A outcome, not a rung Davit can ask for. */
const SENIORITY: Seniority[] = ['junior', 'mid', 'senior', 'staff', 'principal', 'lead'];

const WORK_AUTHORIZATION: WorkAuthorization[] = ['armenia', 'eu', 'uk', 'us', 'canada', 'eaeu'];

export interface Preferences {
  /** False when the file is absent. The run continues; scoring is what needs it. */
  present: boolean;
  /** Reference monthly gross for a Yerevan-local role, in AMD (§5). */
  localMonthlyAmd: number | null;
  /**
   * Target monthly band for remote/B2B international work, in USD.
   *
   * This is the number a form field gets. Keeping it typed rather than in the
   * notes is what stops a drafting model from rounding it, converting it, or
   * quoting the wrong end of the range — and what lets scoring drop a posting
   * whose own published range sits clearly below it, before a letter is written
   * for a role that was never going to pay.
   */
  remoteMonthlyUsdMin: number | null;
  remoteMonthlyUsdMax: number | null;
  /**
   * Where Davit may legally work. Always includes `armenia`.
   *
   * The deciding input this whole file exists to keep typed: it is what makes
   * an EU-restricted posting eligible rather than a near-miss, and a US-only
   * one ineligible rather than a maybe.
   */
  workAuthorization: WorkAuthorization[];
  /** Days until he could start. Stored as a number so a posting demanding an immediate start is comparable. */
  noticePeriodDays: number | null;
  /** Below this is `skip`, not `surface_only`. */
  minSeniority: Seniority;
  /** Scope that may be auto-drafted; everything else is surfaced for a human. */
  draftSeniority: Seniority[];
  targetRoles: string[];
  preferredStack: string[];
  /** The "surface it, don't draft it" cases (§7). */
  askFirst: string[];
  /** Hard exclusions. */
  never: string[];
  /** Free prose, verbatim. Read by the drafting stage only. */
  notes: string;
}

const DEFAULTS: Preferences = {
  present: false,
  localMonthlyAmd: null,
  remoteMonthlyUsdMin: null,
  remoteMonthlyUsdMax: null,
  // Not empty: Armenian citizenship is the one fact about this that is not a
  // preference. A file that forgets to state it must not thereby make every
  // posting on earth ineligible.
  workAuthorization: ['armenia'],
  noticePeriodDays: null,
  minSeniority: 'senior',
  draftSeniority: ['staff', 'principal', 'lead'],
  targetRoles: [],
  preferredStack: [],
  askFirst: [],
  never: [],
  notes: '',
};

/** `## Heading` → the lines beneath it, HTML comments and blank lines removed. */
function splitSections(markdown: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string | null = null;

  const withoutComments = markdown.replace(/<!--[\s\S]*?-->/g, '');

  for (const line of withoutComments.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = heading[1].toLowerCase();
      sections.set(current, []);
      continue;
    }
    if (current) sections.get(current)!.push(line);
  }

  return sections;
}

function bullets(lines: string[] | undefined): string[] {
  if (!lines) return [];
  return lines
    .map((line) => /^\s*[-*]\s+(.*\S)\s*$/.exec(line)?.[1])
    .filter((item): item is string => Boolean(item));
}

function seniority(raw: string, field: string): Seniority | null {
  const value = raw.trim().toLowerCase();
  if ((SENIORITY as string[]).includes(value)) return value as Seniority;
  logger.warn('outreach_preferences_bad_value', { field, value });
  return null;
}

function workAuthorization(raw: string, field: string): WorkAuthorization | null {
  const value = raw.trim().toLowerCase();
  if ((WORK_AUTHORIZATION as string[]).includes(value)) return value as WorkAuthorization;
  logger.warn('outreach_preferences_bad_value', { field, value });
  return null;
}

/** Tolerates `7 500`, `7,500` and `7_500`; rejects anything that is not a whole number. */
function wholeNumber(raw: string, field: string): number | null {
  const parsed = parseInt(raw.replace(/[\s_,]/g, ''), 10);
  if (Number.isFinite(parsed)) return parsed;
  logger.warn('outreach_preferences_bad_value', { field, value: raw });
  return null;
}

/**
 * Reads the `key: value` lines under `## Thresholds`.
 *
 * An unrecognised key is logged rather than ignored. A typo in a preference
 * file is indistinguishable from a rule that silently stopped applying, and
 * this is a file where "the rule stopped applying" means an application Davit
 * did not want sent.
 */
function applyThresholds(lines: string[], prefs: Preferences): void {
  for (const line of lines) {
    const match = /^\s*([a-z_]+)\s*:\s*(.+?)\s*$/i.exec(line);
    if (!match) continue;

    const [, key, value] = match;

    switch (key.toLowerCase()) {
      case 'local_monthly_amd': {
        const parsed = wholeNumber(value, key);
        if (parsed !== null) prefs.localMonthlyAmd = parsed;
        break;
      }
      case 'remote_monthly_usd_min': {
        const parsed = wholeNumber(value, key);
        if (parsed !== null) prefs.remoteMonthlyUsdMin = parsed;
        break;
      }
      case 'remote_monthly_usd_max': {
        const parsed = wholeNumber(value, key);
        if (parsed !== null) prefs.remoteMonthlyUsdMax = parsed;
        break;
      }
      case 'notice_period_days': {
        const parsed = wholeNumber(value, key);
        if (parsed !== null) prefs.noticePeriodDays = parsed;
        break;
      }
      case 'work_authorization': {
        const parsed = value
          .split(',')
          .map((item) => workAuthorization(item, key))
          .filter((item): item is WorkAuthorization => item !== null);
        // `armenia` is re-added unconditionally: it is a fact, not a setting,
        // and a file that omits it must not make every posting ineligible.
        if (parsed.length > 0) {
          prefs.workAuthorization = Array.from(new Set<WorkAuthorization>(['armenia', ...parsed]));
        }
        break;
      }
      case 'min_seniority': {
        const parsed = seniority(value, key);
        if (parsed) prefs.minSeniority = parsed;
        break;
      }
      case 'draft_seniority': {
        const parsed = value
          .split(',')
          .map((item) => seniority(item, key))
          .filter((item): item is Seniority => item !== null);
        if (parsed.length > 0) prefs.draftSeniority = parsed;
        break;
      }
      default:
        logger.warn('outreach_preferences_unknown_key', { key });
    }
  }
}

export function parsePreferences(markdown: string): Preferences {
  const prefs: Preferences = { ...DEFAULTS, present: true };
  const sections = splitSections(markdown);

  applyThresholds(sections.get('thresholds') ?? [], prefs);

  // An inverted band is a typo, and the wrong half of it would end up in a form
  // field sent to a stranger. Drop both ends rather than guessing which one was
  // meant: a missing number becomes `needs_check` and asks, which is recoverable.
  const { remoteMonthlyUsdMin: min, remoteMonthlyUsdMax: max } = prefs;
  if (min !== null && max !== null && min > max) {
    logger.warn('outreach_preferences_bad_value', {
      field: 'remote_monthly_usd_min/max',
      value: `${min} > ${max}`,
    });
    prefs.remoteMonthlyUsdMin = null;
    prefs.remoteMonthlyUsdMax = null;
  }

  prefs.targetRoles = bullets(sections.get('target roles'));
  prefs.preferredStack = bullets(sections.get('preferred stack'));
  prefs.askFirst = bullets(sections.get('ask first'));
  prefs.never = bullets(sections.get('never'));
  prefs.notes = (sections.get('notes') ?? []).join('\n').trim();

  return prefs;
}

/**
 * Loads the preference doc, or reports its absence.
 *
 * Absent is a normal state, not a failure: the discovery half of this job needs
 * no preferences at all, and the container that serves the website has no
 * `private/` mounted into it by design. Only the stages that score and draft
 * require the file, and they check `present` themselves.
 */
export function loadPreferences(): Preferences {
  let markdown: string;
  try {
    markdown = fs.readFileSync(PREFERENCES_FILE, 'utf-8');
  } catch {
    logger.info('outreach_preferences_absent', {});
    return { ...DEFAULTS };
  }

  return parsePreferences(markdown);
}
