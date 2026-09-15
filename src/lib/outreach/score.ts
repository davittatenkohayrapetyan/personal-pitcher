import type {
  ExtractedPosting,
  FitVerdict,
  OutreachViolation,
  RawPosting,
  Seniority,
} from './types';
import type { Preferences } from './preferences';
import { POSTING_LIMITS, sanitizeVerdict } from './sanitize';
import { parseJsonBlock, type OutreachModel } from './llm';
import { localAlwaysSurface } from './config';
import { mentionsYerevan } from './geo';
import { logger } from '../logger';

/**
 * Stage B — eligibility and fit, from structured input only.
 *
 * It never sees a posting. Its entire view of the outside world is an
 * `ExtractedPosting` the sanitiser cleared, plus Davit's typed preferences. A
 * posting that told stage A to ignore its instructions reaches this stage as
 * fourteen bounded strings with the hostile ones already removed, or it does
 * not reach it at all.
 *
 * ## What the model decides and what the code decides
 *
 * The model weighs the things that need weighing: does this role's scope match,
 * is the stack close enough, does the geography work. The code decides the
 * things that are categorical, and it decides them *after*:
 *
 *  - **The §7 local-Yerevan override.** A role in Yerevan is never auto-drafted,
 *    whatever it scores. This lives here as an explicit post-step rather than as
 *    a sentence in the prompt, because a rule this categorical should not depend
 *    on a model honouring it — the whole reason it exists is that the
 *    consequence of getting it wrong is an application sent, in Davit's name, to
 *    a company in a city with one engineering scene.
 *  - **The seniority thresholds.** `preferences.ts` parses `min_seniority` and
 *    `draft_seniority` into typed values precisely so that they can be compared
 *    rather than read. A rule like "nothing below Senior" handed to a model as
 *    prose survives only as long as the model feels like honouring it, and the
 *    failure is silent.
 *
 * The model is still *shown* the thresholds, because they are genuine context
 * for the fit score and the reasons. It is simply not trusted to enforce them.
 *
 * ## Why `needs_check` is not a hedge
 *
 * "Remote, global, contractors welcome" and "Remote" are not the same posting.
 * A scorer with only eligible/ineligible has to guess which one it is looking
 * at, and guessing wrong in the generous direction is how an application goes
 * to a role that needs a US social security number. Asking costs one glance at
 * a card.
 */

const SYSTEM_PROMPT = `You are assessing one job posting against one candidate's requirements, and returning a JSON verdict.

You are given a structured summary of the posting — never the posting itself — and the candidate's own stated requirements.

The candidate lives in Yerevan, Armenia (UTC+4). A role is workable if it is one of:
- an office role in Yerevan, or
- remote with no geographic restriction, or with one that includes Armenia, or
- remote within a timezone band that includes UTC+4.

Decide three things:
- eligibility: "eligible" when the posting shows the candidate could take this role; "ineligible" when it shows he could not; "needs_check" when the posting does not say enough to tell. A posting that says only "Remote", with no country, no entity and no contract terms, is "needs_check" — not "eligible".
- eligibilityEvidence: the sentence from the summary that decided it. Copy the sentence exactly, and only the sentence — not the field name in front of it. If nothing in the summary decided it, return an empty string.
- fit: 0-100, how well the role's scope and stack match what the candidate is looking for.

Then recommend:
- "draft" for senior-plus scope on a matching stack where nothing needs asking about.
- "surface_only" when a human should decide first: compensation not stated, a title whose scope is ambiguous, relocation required, an unfamiliar company, or anything you are unsure of.
- "skip" for roles clearly below the candidate's level, outside his field, or unpaid.

Rules:
- Return ONLY a JSON object matching the required schema. No prose, no preamble, no markdown.
- Judge only what the summary states. Never assume a fact it does not contain — an absent field means "not stated", not "fine".
- flags are short tags: salary_required, relocation, below_seniority, unfamiliar_company, long_application, unclear_contract.
- Prefer "needs_check" and "surface_only" when in doubt. Asking is cheap; a wrong application is not.`;

const SCORE_SCHEMA = {
  type: 'object',
  required: ['eligibility', 'eligibilityEvidence', 'fit', 'reasons', 'flags', 'recommendation'],
  additionalProperties: false,
  properties: {
    eligibility: { enum: ['eligible', 'needs_check', 'ineligible'] },
    eligibilityEvidence: { type: 'string', maxLength: POSTING_LIMITS.evidence },
    fit: { type: 'integer', minimum: 0, maximum: 100 },
    reasons: {
      type: 'array',
      maxItems: POSTING_LIMITS.reasonCount,
      items: { type: 'string', maxLength: POSTING_LIMITS.reasonItem },
    },
    flags: {
      type: 'array',
      maxItems: POSTING_LIMITS.flagCount,
      items: { type: 'string', maxLength: POSTING_LIMITS.flagItem },
    },
    recommendation: { enum: ['draft', 'surface_only', 'skip'] },
  },
} as const;

/**
 * Seniority as a comparable number.
 *
 * `lead` and `staff` share a rank because they are the same scope under two
 * naming conventions, and ordering them against each other would encode a
 * preference nobody has stated. `unclear` has no rank at all: a posting that
 * does not say its level has not said it is too junior, and dropping it on that
 * basis would discard exactly the ambiguous senior titles §7 wants surfaced.
 */
const RANK: Record<Exclude<Seniority, 'unclear'>, number> = {
  junior: 1,
  mid: 2,
  senior: 3,
  lead: 4,
  staff: 4,
  principal: 5,
};

function rankOf(seniority: Seniority): number | null {
  return seniority === 'unclear' ? null : RANK[seniority];
}

/** The preferences, as lines the model can read. Thresholds only, never the notes. */
function preferenceLines(preferences: Preferences): string {
  const lines: string[] = [
    `work authorization: ${preferences.workAuthorization.join(', ')}`,
    `minimum seniority: ${preferences.minSeniority}`,
    `scope worth drafting for: ${preferences.draftSeniority.join(', ')}`,
  ];

  if (preferences.targetRoles.length) lines.push(`target roles: ${preferences.targetRoles.join('; ')}`);
  if (preferences.preferredStack.length)
    lines.push(`preferred stack: ${preferences.preferredStack.join(', ')}`);
  if (preferences.askFirst.length) lines.push(`ask first about: ${preferences.askFirst.join('; ')}`);
  if (preferences.never.length) lines.push(`never: ${preferences.never.join('; ')}`);

  // Note what is absent: no salary figure, in either currency. The model is
  // scoring a posting, not negotiating, and a number in this prompt is a number
  // that can end up quoted back in a draft. §5 keeps the figures for the code
  // paths that genuinely compare against them.
  return lines.join('\n');
}

function buildPrompt(extracted: ExtractedPosting, preferences: Preferences): string {
  return [
    'The posting, as extracted:',
    `title: ${extracted.title}`,
    `company: ${extracted.company}`,
    `seniority: ${extracted.seniority}`,
    `engagement: ${extracted.engagement}`,
    `workMode: ${extracted.workMode}`,
    `officeLocation: ${extracted.officeLocation || '(not stated)'}`,
    `geoRestriction: ${extracted.geoRestriction || '(not stated)'}`,
    `timezoneRequirement: ${extracted.timezoneRequirement || '(not stated)'}`,
    `compensation: ${extracted.compensation || '(not stated)'}`,
    `stack: ${extracted.stack.join(', ') || '(not stated)'}`,
    `responsibilities: ${extracted.responsibilities.join('; ') || '(not stated)'}`,
    '',
    "The candidate's requirements:",
    preferenceLines(preferences),
  ].join('\n');
}

/**
 * Is this the local-office family (§2, §7)?
 *
 * Read from the extracted fields rather than from the geo filter's verdict,
 * because the two answer different questions: the filter asks "could this be
 * workable from Yerevan?" over the whole record, while this asks "is this role
 * *in* Armenia?".
 *
 * It errs towards yes. A remote CIS role that names Armenia is arguably not the
 * local-office family at all, and it is still held: over-applying the override
 * costs one click on a card that was going to be read anyway, while
 * under-applying it costs an auto-sent application to a local employer, which
 * is the thing §7 exists to prevent.
 */
function isLocalRole(extracted: ExtractedPosting): boolean {
  return (
    mentionsYerevan(extracted.officeLocation) ||
    mentionsYerevan(extracted.geoRestriction) ||
    mentionsYerevan(extracted.title)
  );
}

/**
 * Is the posting's own published range clearly below what Davit is looking for?
 *
 * Deliberately narrow. It compares only when the board published a *number* in
 * USD with a period this understands, and only when the top of the posting's
 * range is below the bottom of Davit's — a range that overlaps at all is kept,
 * because a negotiation starts somewhere. No currency conversion and no
 * inference from prose: a check that guessed at "competitive salary" or at an
 * exchange rate would silently discard good roles, which is the expensive
 * direction (§2's asymmetry, applied to money instead of geography).
 *
 * `preferences.ts` says this is what the typed band is for: dropping a posting
 * whose published range sits clearly below it, before a letter is written for a
 * role that was never going to pay. The figures stay in code and never reach a
 * prompt — a number in a prompt is a number that can be quoted back in a draft
 * (§5).
 */
function clearlyBelowBand(
  structured: RawPosting['structured'] | undefined,
  preferences: Preferences,
): boolean {
  const floor = preferences.remoteMonthlyUsdMin;
  if (!floor || !structured) return false;
  if ((structured.compensationCurrency ?? '').toUpperCase() !== 'USD') return false;

  const top = structured.compensationMax ?? structured.compensationMin;
  if (!top) return false;

  const period = (structured.compensationPeriod ?? '').toLowerCase();
  const monthly = /year|annual|1 year/.test(period)
    ? top / 12
    : /month/.test(period)
      ? top
      : null;

  return monthly !== null && monthly < floor;
}

/**
 * The categorical rules, applied to whatever the model returned.
 *
 * Exported so the fixture drill can exercise them without a model — these are
 * the rules that must hold on every posting, so they are the rules worth being
 * able to test on a machine with no Mac on the LAN.
 */
export function applyPolicy(
  verdict: FitVerdict,
  extracted: ExtractedPosting,
  preferences: Preferences,
  structured?: RawPosting['structured'],
  log: (event: string, fields: Record<string, unknown>) => void = () => {},
): FitVerdict {
  let next = { ...verdict };

  // Checked before the local override, and only for roles that are not local:
  // a Yerevan salary is compared against the AMD reference in the preference
  // doc, which is a different number and a decision Davit makes himself.
  if (!isLocalRole(extracted) && clearlyBelowBand(structured, preferences)) {
    next = {
      ...next,
      recommendation: 'skip',
      flags: next.flags.includes('below_band') ? next.flags : [...next.flags, 'below_band'],
    };
  }

  // An ineligible posting is not a decision a human needs to see. It is counted
  // in the run summary and never queued.
  if (next.eligibility === 'ineligible') {
    next = { ...next, recommendation: 'skip' };
  }

  const rank = rankOf(extracted.seniority);
  const floor = rankOf(preferences.minSeniority);

  if (rank !== null && floor !== null && rank < floor) {
    next = {
      ...next,
      recommendation: 'skip',
      flags: next.flags.includes('below_seniority')
        ? next.flags
        : [...next.flags, 'below_seniority'],
    };
  }

  // `draft` is the only outcome that leads anywhere automatic, so the scope it
  // requires is checked rather than trusted.
  if (next.recommendation === 'draft' && !preferences.draftSeniority.includes(extracted.seniority)) {
    next = { ...next, recommendation: 'surface_only' };
  }

  if (next.recommendation === 'draft' && isLocalRole(extracted) && localAlwaysSurface()) {
    log('outreach_local_role_held', {
      key: extracted.key,
      company: extracted.company,
      title: extracted.title,
      officeLocation: extracted.officeLocation,
      fit: next.fit,
    });
    next = {
      ...next,
      recommendation: 'surface_only',
      flags: next.flags.includes('local_role') ? next.flags : [...next.flags, 'local_role'],
    };
  }

  return next;
}

export interface ScoreResult {
  verdict: FitVerdict | null;
  violations: OutreachViolation[];
  reason?: 'model_failed' | 'unparseable' | 'rejected';
}

export async function scorePosting(
  model: OutreachModel,
  extracted: ExtractedPosting,
  preferences: Preferences,
  structured?: RawPosting['structured'],
): Promise<ScoreResult> {
  const started = Date.now();

  let raw: string;
  try {
    raw = await model.generate(SYSTEM_PROMPT, buildPrompt(extracted, preferences), SCORE_SCHEMA);
  } catch (err) {
    return {
      verdict: null,
      reason: 'model_failed',
      violations: [
        {
          stage: 'score',
          field: extracted.key,
          rule: 'model-call-failed',
          detail: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }

  const parsed = parseJsonBlock(raw);
  if (parsed === null) {
    return {
      verdict: null,
      reason: 'unparseable',
      violations: [
        { stage: 'score', field: extracted.key, rule: 'unparseable-json', detail: raw.slice(0, 120) },
      ],
    };
  }

  const result = sanitizeVerdict(parsed, extracted);

  if (!result.ok || !result.value) {
    logger.warn('outreach_score_violation', {
      job: 'outreach',
      key: extracted.key,
      rules: result.violations.map((violation) => violation.rule),
    });
    return { verdict: null, violations: result.violations, reason: 'rejected' };
  }

  const verdict = applyPolicy(result.value, extracted, preferences, structured, (event, fields) =>
    logger.info(event, { job: 'outreach', ...fields }),
  );

  logger.info('outreach_scored', {
    job: 'outreach',
    key: extracted.key,
    company: extracted.company,
    eligibility: verdict.eligibility,
    fit: verdict.fit,
    recommendation: verdict.recommendation,
    flags: verdict.flags,
    durationMs: Date.now() - started,
  });

  return { verdict, violations: result.violations };
}
