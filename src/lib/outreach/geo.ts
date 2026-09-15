/**
 * The deterministic "can Davit do this job from Yerevan?" filter.
 *
 * Pure, no model, and it runs before anything expensive. This is the
 * highest-value forty lines in the job: it removes most of the aggregator
 * volume for free, and a bug here silently discards good roles rather than
 * failing loudly.
 *
 * ## The question is wider than "is it remote?"
 *
 * The first draft of the plan filtered for remote-only and put on-site on the
 * exclusion list. Both seed companies run engineering offices in Yerevan, and
 * Align currently has a Sr. Java Engineer posted there — so that filter would
 * have thrown away the single best match the design has found. Three families
 * are eligible (§2 of `docs/job-outreach-plan.md`): a local office of an
 * international company, remote-worldwide, and remote within a band that
 * includes UTC+4.
 *
 * ## The override is checked first, on purpose
 *
 * A posting that says Yerevan or Armenia anywhere passes, before any exclusion
 * rule gets to look at it. Postings that mention Armenia *and* carry US-only
 * boilerplate in an EEO paragraph are common; ordering the rules the other way
 * round drops exactly the postings this job exists to find. Getting this
 * backwards is what the first draft of the plan did.
 *
 * A false `pass` costs one line in a report that a human is going to read
 * anyway. A false `drop` costs an opportunity nobody ever learns about. The
 * rules below are ordered on that asymmetry, not on precision.
 */

export type GeoVerdict = 'pass' | 'drop' | 'flag';

export interface GeoDecision {
  verdict: GeoVerdict;
  /** Stable rule name, so decisions can be counted and `--explain` can cite one. */
  rule: string;
  /** The matched text, truncated. Never the whole posting body — see §20. */
  evidence: string;
}

/** Enough to identify the sentence that fired, short enough to log at `info`. */
const EVIDENCE_BUDGET = 120;

interface Rule {
  name: string;
  re: RegExp;
  verdict: GeoVerdict;
}

/**
 * The override. Latin and Armenian spellings, and both renderings of the ligature.
 *
 * Note the missing `\b` on the Armenian alternatives: JavaScript's `\b` is
 * defined over `[A-Za-z0-9_]`, so `\bերևան\b` cannot match Armenian text
 * standing on its own — the assertion needs an ASCII word character on one
 * side. The plan's §17.4 writes all three alternatives inside one `\b(...)\b`,
 * which silently reduces to the Latin two. Split rather than "fixed" in place,
 * because the Latin forms genuinely do want the boundary: without it,
 * "Armenia" matches inside no real word, but "us" and "at" in the rules below
 * match inside dozens.
 */
const YEREVAN = /\b(yerevan|armenia|armenian)\b/i;
const YEREVAN_HY = /(երևան|երեւան|հայաստան)/iu;

/**
 * Relocation language. Upgrades an otherwise-dropped on-site role to `flag`:
 * "on-site in Amsterdam, relocation package provided" is a decision for a
 * human, not a filter.
 */
const RELOCATION = /\brelocation\s+(package|assistance|support|offered|provided)\b/i;

/** Tier 2: the posting names a jurisdiction, and it is not one Davit can work in. */
const JURISDICTION_RULES: Rule[] = [
  { name: 'us-only', re: /\b(us|u\.s\.|usa|united states)[-\s]?(only|based|residents?)\b/i, verdict: 'drop' },
  {
    name: 'work-authorisation',
    re: /\bmust (be )?(legally )?(authorized|authorised) to work in the (us|usa|united states|uk|eu)\b/i,
    verdict: 'drop',
  },
  { name: 'visa-status', re: /\b(green card|tn visa|ead)\b/i, verdict: 'drop' },
  {
    name: 'region-only',
    re: /\b(eu|eea|uk|canada|india|latam)[-\s]?(only|residents? only|based only)\b/i,
    verdict: 'drop',
  },
  { name: 'work-permit-required', re: /\bwork permit for\b/i, verdict: 'drop' },
];

/**
 * Tier 3, prose form: an office somewhere that is not Yerevan.
 *
 * No city is captured or compared, and that is not an omission. The override
 * has already run over this same text, so any posting still being tested here
 * mentions neither Yerevan nor Armenia anywhere — the "is the captured city in
 * the Yerevan set?" check §17.4 describes can only answer no by the time
 * control reaches this line.
 */
const ONSITE_PROSE: Rule = {
  name: 'onsite-elsewhere',
  re: /(on[-\s]?site|hybrid)\b[^.]{0,40}\b(in|at)\b/i,
  verdict: 'drop',
};

/**
 * Tier 3, structured form: the adapter was told, rather than having to read it.
 *
 * §17.4 gives tier 3 only as the prose pattern above, which was written with
 * aggregator free text in mind. An ATS states the same fact as a field, and on
 * a real board that is the overwhelmingly common case: of Align's 218 postings,
 * 161 are `workplace_type: "onsite"` at a location like
 * `US-North Carolina-Raleigh` — an on-site role in a named non-Yerevan city
 * that says so in no sentence anywhere, and that the prose rule therefore
 * passes. A filter that lets 216 of 218 through is not a filter.
 *
 * Reading the field rather than the prose is what §4 means by "structured
 * fields beat extracted ones": the fact is already known, so nothing downstream
 * should have to infer it. Only `onsite` and `hybrid` are acted on — a
 * `workplace_type` of `remote` is passed to stage B exactly as a bare "Remote"
 * is, because "remote" alone does not say remote *from where*.
 */
const STRUCTURED_ONSITE = /^\s*(on[-\s]?site|hybrid)\s*$/i;

/**
 * Tier 2, structured form: the source published who may apply.
 *
 * The aggregators that matter here state this as a field rather than in prose —
 * Remotive's `candidate_required_location` ("Worldwide", "USA", "LATAM, Europe,
 * USA, Canada, APAC") and Himalayas' `locationRestrictions` (["United
 * States"]). Checked against the live feeds on 2026-09-14, and the check is
 * what made this rule necessary: the overwhelming majority of those postings
 * say "United States" and nothing else, with no "only" anywhere in the record.
 * §17.4's prose `us-only` pattern needs that word, so without this rule a feed
 * of US-restricted roles passes the filter intact and the queue fills with jobs
 * Davit cannot take.
 *
 * Three outcomes rather than two, in the same order as everything else here:
 *
 *  - Any entry that means "anywhere" wins for the whole posting. A role open to
 *    LATAM *and* worldwide is open worldwide.
 *  - Any entry naming a region that plausibly contains Armenia is a `flag`, not
 *    a pass and not a drop. Armenia is in EMEA and in the Council of Europe but
 *    not in the EU, so "Europe" is a question for a human, and answering it
 *    either way in a regex would be the filter pretending to know something.
 *  - Everything else drops.
 */
const RESTRICTION_WORLDWIDE = /\b(worldwide|anywhere|global|globally|any\s+country|any\s+location)\b/i;
const RESTRICTION_PLAUSIBLE =
  /\b(emea|europe|european|cis|caucasus|middle\s*east|eastern\s+europe|cet)\b/i;

/** Tier 4: workable, but a human should look. */
const FLAG_RULES: Rule[] = [
  { name: 'narrow-timezone', re: /\bCET\s*[+-]\s*[012]\b/i, verdict: 'flag' },
  {
    name: 'us-overlap',
    re: /\b(overlap|overlapping)\b[^.]{0,30}\b(pst|pdt|est|edt)\b/i,
    verdict: 'flag',
  },
];

function evidence(match: RegExpExecArray): string {
  const text = match[0].replace(/\s+/g, ' ').trim();
  return text.length > EVIDENCE_BUDGET ? `${text.slice(0, EVIDENCE_BUDGET)}…` : text;
}

/**
 * What the adapter read directly, where it bears on geography.
 *
 * A subset of `RawPosting['structured']` rather than the whole thing, so this
 * file stays a pure function of the two or three facts that decide the
 * question.
 */
export interface StructuredLocation {
  workplaceType?: string;
  /**
   * Where the *candidate* may live, as the source states it. Set only by
   * sources that genuinely publish a restriction — see `RawPosting`.
   */
  candidateRestrictions?: string[];
  /** Acceptable candidate timezones as UTC offsets. Himalayas publishes these. */
  timezoneOffsets?: number[];
}

/**
 * Yerevan, as an offset. No DST since 2012, so one number rather than two.
 *
 * A posting that publishes its acceptable timezones and omits this one is
 * saying something real: it is not a preference about overlap, it is a list the
 * employer wrote down. It still resolves to `flag` rather than `drop` — a
 * worldwide-hiring company that wants US working hours is a job Davit *can*
 * do and probably does not want, and that is a sentence for a human rather
 * than for a regex.
 */
const YEREVAN_UTC_OFFSET = 4;

/**
 * Decides one posting.
 *
 * Both halves of the prose are searched as one string: an employer who states
 * the geography in the location field and an employer who states it in the
 * third paragraph are saying the same thing, and only one of them is
 * cooperating with the filter.
 *
 * Returns a decision rather than the bare verdict §17.4 specifies, because
 * every drop has to be auditable — `--explain` prints the rule that fired, and
 * a filter you cannot audit is a filter you stop trusting. It also takes the
 * adapter's structured fields, which §17.4 does not mention and both a real ATS
 * board and a real aggregator feed make indispensable — see `STRUCTURED_ONSITE`
 * and `RESTRICTION_WORLDWIDE`.
 */
/**
 * Does this text name Armenia or Yerevan?
 *
 * The override's own test, exported so that §7's local-role rule in `score.ts`
 * asks the same question in the same words. Two spellings of the same rule
 * drifting apart would mean a posting the filter passed *because* it is local
 * being auto-drafted *because* the scorer did not think it was.
 */
export function mentionsYerevan(text: string): boolean {
  return YEREVAN.test(text) || YEREVAN_HY.test(text);
}

export function geoVerdict(
  locationText: string,
  untrustedBlob: string,
  structured: StructuredLocation = {},
): GeoDecision {
  const restrictions = (structured.candidateRestrictions ?? []).filter((entry) => entry.trim());
  const haystack = `${locationText} ${restrictions.join(' ')} ${untrustedBlob}`.replace(/\s+/g, ' ');

  // Tier 1. First, and before every exclusion below it, on purpose.
  const override = YEREVAN.exec(haystack) ?? YEREVAN_HY.exec(haystack);
  if (override) return { verdict: 'pass', rule: 'yerevan-override', evidence: evidence(override) };

  // Tier 2, structured. Before the prose rules, because §4's "structured
  // fields beat extracted ones" applies to the filter as much as to stage A:
  // the source has answered the question, so nothing should be inferring it
  // from a sentence somewhere else in the record.
  if (restrictions.length > 0) {
    const stated = restrictions.join(', ');
    if (!RESTRICTION_WORLDWIDE.test(stated)) {
      const plausible = RESTRICTION_PLAUSIBLE.exec(stated);
      return plausible
        ? {
            verdict: 'flag',
            rule: 'restricted-region-plausible',
            evidence: stated.slice(0, EVIDENCE_BUDGET),
          }
        : {
            verdict: 'drop',
            rule: 'structured-region-restricted',
            evidence: stated.slice(0, EVIDENCE_BUDGET),
          };
    }
  }

  const offsets = structured.timezoneOffsets ?? [];
  if (offsets.length > 0 && !offsets.includes(YEREVAN_UTC_OFFSET)) {
    return {
      verdict: 'flag',
      rule: 'timezone-excluded',
      evidence: `accepts UTC ${offsets.join(', ')}`.slice(0, EVIDENCE_BUDGET),
    };
  }

  for (const rule of JURISDICTION_RULES) {
    const match = rule.re.exec(haystack);
    if (match) return { verdict: rule.verdict, rule: rule.name, evidence: evidence(match) };
  }

  // Tier 3. Relocation language turns a drop into a decision for a human:
  // "on-site in Amsterdam, relocation package provided" is not the same posting
  // as "on-site in Amsterdam".
  const relocation = RELOCATION.exec(haystack);

  if (STRUCTURED_ONSITE.test(structured.workplaceType ?? '')) {
    const detail = `${structured.workplaceType} · ${locationText}`.trim();
    return relocation
      ? { verdict: 'flag', rule: 'onsite-with-relocation', evidence: evidence(relocation) }
      : {
          verdict: 'drop',
          rule: 'structured-onsite-elsewhere',
          evidence: detail.slice(0, EVIDENCE_BUDGET),
        };
  }

  const onsite = ONSITE_PROSE.re.exec(haystack);
  if (onsite) {
    return relocation
      ? { verdict: 'flag', rule: 'onsite-with-relocation', evidence: evidence(relocation) }
      : { verdict: ONSITE_PROSE.verdict, rule: ONSITE_PROSE.name, evidence: evidence(onsite) };
  }

  for (const rule of FLAG_RULES) {
    const match = rule.re.exec(haystack);
    if (match) return { verdict: rule.verdict, rule: rule.name, evidence: evidence(match) };
  }

  // Everything else, including a bare "Remote". A posting that says only
  // "Remote" is a `needs_check` for stage B to resolve, not a drop: the
  // difference between "remote, worldwide, contractors welcome" and "remote"
  // is exactly the difference a filter cannot see and a reader can (§2).
  return { verdict: 'pass', rule: 'default-pass', evidence: '' };
}
