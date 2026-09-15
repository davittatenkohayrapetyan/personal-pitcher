import type {
  Engagement,
  ExtractedPosting,
  FitVerdict,
  OutreachViolation,
  RawPosting,
  Seniority,
  WorkMode,
} from './types';
import { checkField, filterUngrounded, normalizeText } from '../refresh/sanitize';

/**
 * Programmatic validation of what the models emit, between stage A and stage B
 * and again between stage B and the queue.
 *
 * ## Why this is not `refresh/sanitize.ts`
 *
 * §17.6 is explicit that two things in that file look reusable and are not, and
 * both reasons hold up in the code rather than only on paper:
 *
 *  - **`sanitizeExtracted()` is bound to `ExtractedFacts` and `SourceRecord`.**
 *    It validates a summary, a tech list and a highlight list. There is no
 *    version of that function that also validates an engagement enum and an
 *    apply target. So this file is written out of `checkField` and
 *    `filterUngrounded`, which are generic, exactly as §17.6 says to.
 *  - **`URL_ALLOWLIST` is module-private and wrong for this job.** It allows
 *    GitHub, Spotify and SoundCloud, because it is answering "may this link
 *    appear on Davit's public site?". The question here is different: "is this
 *    apply address on the posting's own domain?" — a different check, against a
 *    different input, with a different answer for every posting. `applyTarget`
 *    below is that check.
 *
 * What *is* imported is everything that was already general: `normalizeText`
 * (zero-width and bidi characters removed **before** pattern matching, so a
 * payload cannot look different to a human than to a tokeniser), `checkField`
 * (the injection and infra rule batteries plus length), and `filterUngrounded`
 * (the hallucination guard).
 *
 * ## Which violations are fatal
 *
 * Injection or infra-disclosure content fails the **whole record**, not just the
 * field (§4). A value that needed editing to become safe is a value nobody
 * should trust.
 *
 * The set is defined by exclusion — `STRUCTURAL_RULES` lists the rules that are
 * *not* fatal, and everything else is. That direction is deliberate: if the
 * upstream rule tables gain a new injection pattern, it becomes fatal here
 * automatically, whereas a hand-maintained list of fatal names would silently
 * fail to include it. The two URL rules are structural here precisely because
 * they are testing the profile site's allowlist, which has nothing to do with
 * job postings; a posting quoting its own careers URL is not a violation.
 *
 * As in the refresh job: a regex list is not a security boundary. Its job is to
 * make a hijacked stage A **loud**. The boundary that actually holds is that
 * nothing is sent without Davit reading the link.
 */

// ─── Limits ────────────────────────────────────────────────────────

/** The numbers in §4 and §17.5, in one place so the schema and the checks agree. */
export const POSTING_LIMITS = {
  title: 120,
  company: 80,
  officeLocation: 120,
  geoRestriction: 200,
  timezoneRequirement: 120,
  stackItem: 30,
  stackCount: 12,
  responsibilityItem: 160,
  responsibilityCount: 6,
  compensation: 120,
  applyTarget: 200,
  /** Stage B. The evidence is a sentence quoted out of a posting. */
  evidence: 300,
  reasonItem: 240,
  reasonCount: 6,
  flagItem: 40,
  flagCount: 8,
} as const;

/**
 * Rules that describe a value's *shape* rather than its content.
 *
 * Everything not listed here fails the record. See the header for why the list
 * is written this way round.
 */
const STRUCTURAL_RULES = new Set([
  'empty',
  'too-long',
  'not-a-string',
  'not-an-array',
  'too-many-items',
  'ungrounded',
  // The profile site's allowlist, not ours — see the header.
  'url-not-allowlisted',
  'malformed-url',
  // This file's own field-level rules. They have to be listed because the set
  // is defined by exclusion, and the drill caught the omission immediately: an
  // apply URL on an unknown host was failing the whole record when it should
  // only empty the field. Note which one is *not* here —
  // `apply-target-off-domain`, the email case, is fatal by design.
  'apply-target-unknown-host',
  'apply-target-unparseable',
]);

function isFatal(violation: OutreachViolation): boolean {
  return !STRUCTURAL_RULES.has(violation.rule);
}

/**
 * Fields whose items are dropped individually rather than failing the record.
 *
 * §4 says injection content fails the whole record, and for the fields that
 * *decide* something — where the candidate may be, what the job pays, where an
 * application would be sent — that is right. Applying it to the two list fields
 * as well turned out to discard ordinary job postings, and the reason is worth
 * writing down because it is not obvious from either file alone.
 *
 * The rule battery in `refresh/sanitize.ts` was written against GitHub
 * repository descriptions, where its own comment is fair: "a repository
 * description has no legitimate reason to contain any of these". A job posting
 * does. Checked against the real patterns:
 *
 *     "Act as the technical owner of the ingestion pipeline"  -> role-reassignment
 *     "You will act as a mentor to junior engineers"          -> role-reassignment
 *     "Own the system message bus and its consumers"          -> system-prompt-reference
 *     "Show the team the value of clean configuration ..."    -> exfiltration
 *
 * That is boilerplate in exactly the staff-and-above postings this job exists to
 * find, and the extract prompt asks the model to copy responsibilities clause by
 * clause, so it lands in `responsibilities[i]` verbatim.
 *
 * Dropping the item is not a weaker mitigation than dropping the record: the
 * payload does not reach stage B, the card, or anything later, and the violation
 * is still counted and logged. What it does not additionally do is throw away
 * the posting. `refresh/sanitize.ts` already draws this exact line — `summary`
 * fails the record, list items are dropped — and the mistake here was applying
 * one rule uniformly to fields that are not alike.
 */
const DROPPABLE_ITEM = /^(stack|responsibilities|reasons|flags)\[/;

/** True when this violation should take the whole record down with it. */
function failsRecord(violation: OutreachViolation): boolean {
  return isFatal(violation) && !DROPPABLE_ITEM.test(violation.field);
}

/**
 * Rules that say the *posting* was hostile, as against the generation being
 * broken.
 *
 * Both reject the record. The difference is what happens tomorrow: a posting
 * whose text attacks the extractor will attack it again, so retrying spends a
 * laptop's battery arguing with itself, while a generation that fell apart
 * mid-field is a coin that can be flipped again.
 *
 * The distinction is not theoretical. On the first live run a legitimate NVIDIA
 * systems role — one that accepts Armenia-Remote, so exactly the kind this job
 * exists to find — was rejected because a 26B model degenerated halfway through
 * a responsibility and started emitting HTML fragments and a code fence.
 * Refusing the record was right; refusing it *permanently* would have lost a
 * good role to one bad generation, which is the failure the geo filter's whole
 * design is arranged to avoid.
 *
 * The list is short on purpose, and shorter than the rule battery. Permanence
 * is the expensive half of this decision — getting it wrong loses a role
 * nobody ever learns about — so only patterns with no legitimate use in a job
 * posting are on it. `role-reassignment`, `system-prompt-reference` and
 * `exfiltration` are deliberately absent despite being injection rules: see
 * `DROPPABLE_ITEM` for the four ordinary posting clauses that trip them.
 * `chat-template-token` stays despite being something a confused model also
 * emits, because in a job posting it is a strong enough signal to be worth not
 * retrying.
 */
const HOSTILE_RULES = new Set([
  'ignore-previous',
  'chat-template-token',
  'credential-literal',
  'apply-target-off-domain',
]);

/** True when at least one violation means the posting itself is the problem. */
export function isHostile(violations: OutreachViolation[]): boolean {
  return violations.some((violation) => HOSTILE_RULES.has(violation.rule));
}

// ─── Field plumbing ─────────────────────────────────────────────────

export interface SanitizeResult<T> {
  ok: boolean;
  value: T | null;
  violations: OutreachViolation[];
}

/**
 * `checkField` with this job's stage vocabulary.
 *
 * The imported function types its stage as the refresh pipeline's
 * `extract | edit | source`, which describes a different set of steps. The
 * violations are relabelled rather than the vocabulary being widened upstream:
 * `refresh` has no notion of scoring and should not acquire one.
 */
function checked(
  stage: OutreachViolation['stage'],
  field: string,
  raw: unknown,
  maxLength: number,
): { value: string; violations: OutreachViolation[] } {
  const result = checkField('extract', field, raw, maxLength);
  return {
    value: result.value,
    violations: result.violations.map((violation) => ({ ...violation, stage })),
  };
}

/** A bounded list of bounded strings. Items are individually droppable. */
function checkedList(
  stage: OutreachViolation['stage'],
  field: string,
  raw: unknown,
  maxItems: number,
  maxLength: number,
): { values: string[]; violations: OutreachViolation[] } {
  if (!Array.isArray(raw)) {
    return { values: [], violations: [{ stage, field, rule: 'not-an-array', detail: typeof raw }] };
  }

  const violations: OutreachViolation[] = [];
  const values: string[] = [];

  if (raw.length > maxItems) {
    violations.push({ stage, field, rule: 'too-many-items', detail: `${raw.length} > ${maxItems}` });
  }

  for (const [index, item] of raw.slice(0, maxItems).entries()) {
    const result = checked(stage, `${field}[${index}]`, item, maxLength);

    if (result.violations.length === 0) {
      values.push(result.value);
      continue;
    }

    // An item that is *only* empty is dropped without being reported: a model
    // padding a list to the schema's minimum is sloppy, not hostile. Note the
    // explicit length test — `[].every()` is true, so testing `every` alone
    // would silently discard every valid item as well (§20).
    if (result.violations.length > 0 && result.violations.every((v) => v.rule === 'empty')) continue;

    violations.push(...result.violations);
  }

  return { values, violations };
}

function checkedEnum<T extends string>(
  stage: OutreachViolation['stage'],
  field: string,
  raw: unknown,
  allowed: readonly T[],
): { value: T | null; violations: OutreachViolation[] } {
  if (typeof raw === 'string' && (allowed as readonly string[]).includes(raw)) {
    return { value: raw as T, violations: [] };
  }
  // Constrained decoding cannot produce this, which is exactly why it is worth
  // checking: a value outside the enum means the schema was not applied, and
  // the run should say so rather than quietly coercing to a default.
  return {
    value: null,
    violations: [
      {
        stage,
        field,
        rule: 'not-in-enum',
        detail: typeof raw === 'string' ? raw.slice(0, 60) : typeof raw,
      },
    ],
  };
}

// ─── Grounding ──────────────────────────────────────────────────────

/** Everything the source actually said about one posting, folded for comparison. */
export function groundingCorpus(posting: RawPosting): string {
  const parts = [
    posting.title,
    posting.company,
    posting.locationText,
    ...Object.values(posting.untrusted).filter(Boolean),
  ];

  for (const value of Object.values(posting.structured)) {
    if (Array.isArray(value)) parts.push(...value.map(String));
    else if (value !== undefined && value !== null) parts.push(String(value));
  }

  return fold(parts.join(' '));
}

/** Case, spacing and punctuation blind — the same fold the refresh sanitiser uses. */
function fold(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * `officeLocation: Armenia, Yerevan` -> `Armenia, Yerevan`.
 *
 * Stage B is shown its input as `field: value` lines, and a model asked to copy
 * the deciding sentence copies the label with it. That was not a hypothesis: on
 * the first live run every verdict came back with a field name glued to the
 * front, and every one of them was therefore marked ungrounded — a check that
 * fires on everything tells you nothing.
 *
 * Removing our own prompt's formatting before comparing is not repair. The
 * prefix is a string this code put in front of the model; the words after it
 * are the ones being checked, and they are checked exactly as strictly as
 * before.
 */
function stripFieldPrefix(value: string): string {
  return value.replace(/^[a-zA-Z]{3,24}\s*:\s*/, '').trim();
}

/**
 * One quoted field, checked against the source text.
 *
 * §4 requires `officeLocation`, `geoRestriction` and `compensation` to be
 * substrings of the posting rather than model prose, and this is that check,
 * built out of `filterUngrounded` by treating the field as a one-item list. The
 * comparison is folded rather than literal, which tolerates the whitespace and
 * punctuation differences that survive HTML-to-text conversion while still
 * refusing anything the posting does not say.
 *
 * An ungrounded value empties the field rather than failing the record. Losing
 * a location to a paraphrase costs one blank line on a card a human is reading
 * anyway; losing the posting costs the opportunity.
 */
function groundedField(
  field: string,
  value: string,
  corpus: string,
): { value: string; violations: OutreachViolation[] } {
  if (!value) return { value: '', violations: [] };

  const result = filterUngrounded([value], corpus, field);
  return {
    value: result.kept[0] ?? '',
    violations: result.violations.map((violation) => ({
      ...violation,
      stage: 'extract' as const,
    })),
  };
}

// ─── Apply target ───────────────────────────────────────────────────

const EMAIL = /^[^\s@]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i;

/**
 * `jobs.aligntech.com` -> `aligntech.com`.
 *
 * Two labels, which is wrong for `co.uk` and friends: a posting on
 * `example.co.uk` would accept an address at `other.co.uk`. Living with that is
 * a deliberate trade against shipping a public-suffix list for one check — and
 * the failure it permits is narrow, because the address still has to be on a
 * real second-level domain under the same suffix, and a human reads the card
 * before anything is sent.
 */
function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/^www\./, '').split('.');
  return labels.slice(-2).join('.');
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Validates the address an application would be sent to, against the posting's
 * own domain (§4).
 *
 * This is the concrete defence against a posting that tries to redirect an
 * application somewhere else, and the two halves of it are treated differently
 * on purpose:
 *
 *  - **An email address off the posting's domain fails the whole record.** This
 *    is the actual attack: the machine would transmit to that address, and the
 *    injection fixture in `data/outreach/fixtures/postings.json` is exactly this
 *    shape. §4 says drop the record, and for an email it is plainly right.
 *  - **A URL on an unknown host empties the field**, with the violation logged,
 *    rather than failing the record. §4 makes no distinction, and this is a
 *    considered divergence recorded in §23: an aggregator posting *legitimately*
 *    applies on a host the discovery step never saw — a RemoteOK listing whose
 *    apply link is on `boards.greenhouse.io` is the common case, not the
 *    suspicious one — so the plan's rule as written would discard a large part
 *    of the aggregator half of the system. A URL is also a different risk from
 *    an address: it is clicked by a human who has just read the card, and the
 *    card leads with the posting link rather than with this one.
 */
function checkApplyTarget(
  raw: string,
  posting: RawPosting,
): { value: string; violations: OutreachViolation[]; fatal: boolean } {
  if (!raw) return { value: '', violations: [], fatal: false };

  const postingHost = hostOf(posting.url);
  const allowed = new Set<string>();
  if (postingHost) allowed.add(registrableDomain(postingHost));

  const email = EMAIL.exec(raw);
  if (email) {
    const domain = registrableDomain(email[1]);
    if (allowed.has(domain)) return { value: raw, violations: [], fatal: false };

    return {
      value: '',
      fatal: true,
      violations: [
        {
          stage: 'extract',
          field: 'applyTarget',
          rule: 'apply-target-off-domain',
          detail: `${domain} not in ${[...allowed].join(', ') || '(none)'}`,
        },
      ],
    };
  }

  const host = hostOf(raw);
  if (host && allowed.has(registrableDomain(host))) {
    return { value: raw, violations: [], fatal: false };
  }

  return {
    value: '',
    fatal: false,
    violations: [
      {
        stage: 'extract',
        field: 'applyTarget',
        rule: host ? 'apply-target-unknown-host' : 'apply-target-unparseable',
        detail: (host ?? raw).slice(0, 120),
      },
    ],
  };
}

// ─── Stage A ─────────────────────────────────────────────────────────

const SENIORITY: readonly Seniority[] = [
  'junior',
  'mid',
  'senior',
  'staff',
  'principal',
  'lead',
  'unclear',
];
const ENGAGEMENT: readonly Engagement[] = ['employee', 'contractor', 'eor', 'unclear'];
const WORK_MODE: readonly WorkMode[] = ['remote', 'hybrid', 'onsite', 'unclear'];
const APPLY_METHOD = ['form', 'email', 'unclear'] as const;

/**
 * Validates one stage-A record against the schema *and* the content rules.
 *
 * `key`, `company` and `title` are taken from the adapter rather than from the
 * model, whatever the model returned: the adapter read them out of an API
 * response, which is the same "structured fields beat extracted ones" rule §4
 * applies to compensation. A model that returns a different key or company is
 * not corrected silently — the disagreement is recorded, because it is a signal
 * about the extraction and not about the posting.
 */
export function sanitizeExtractedPosting(
  raw: unknown,
  posting: RawPosting,
): SanitizeResult<ExtractedPosting> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      value: null,
      violations: [
        { stage: 'extract', field: '(root)', rule: 'not-an-object', detail: typeof raw },
      ],
    };
  }

  const candidate = raw as Record<string, unknown>;
  const violations: OutreachViolation[] = [];
  const corpus = groundingCorpus(posting);

  if (typeof candidate.key === 'string' && candidate.key !== posting.key) {
    violations.push({
      stage: 'extract',
      field: 'key',
      rule: 'key-mismatch',
      detail: candidate.key.slice(0, 120),
    });
  }

  // Checked so that hostile content in them is still caught and still fatal,
  // then discarded in favour of the adapter's values below.
  violations.push(...checked('extract', 'title', candidate.title, POSTING_LIMITS.title).violations);
  violations.push(
    ...checked('extract', 'company', candidate.company, POSTING_LIMITS.company).violations,
  );

  const seniority = checkedEnum('extract', 'seniority', candidate.seniority, SENIORITY);
  const engagement = checkedEnum('extract', 'engagement', candidate.engagement, ENGAGEMENT);
  const workMode = checkedEnum('extract', 'workMode', candidate.workMode, WORK_MODE);
  const applyMethod = checkedEnum('extract', 'applyMethod', candidate.applyMethod, APPLY_METHOD);
  violations.push(
    ...seniority.violations,
    ...engagement.violations,
    ...workMode.violations,
    ...applyMethod.violations,
  );

  const officeLocation = checked(
    'extract',
    'officeLocation',
    candidate.officeLocation,
    POSTING_LIMITS.officeLocation,
  );
  const geoRestriction = checked(
    'extract',
    'geoRestriction',
    candidate.geoRestriction,
    POSTING_LIMITS.geoRestriction,
  );
  const timezoneRequirement = checked(
    'extract',
    'timezoneRequirement',
    candidate.timezoneRequirement,
    POSTING_LIMITS.timezoneRequirement,
  );
  const compensation = checked(
    'extract',
    'compensation',
    candidate.compensation,
    POSTING_LIMITS.compensation,
  );

  // An empty quoted field is the correct answer when the posting does not say,
  // so `empty` is not reported for these four. Everything else about them is.
  for (const result of [officeLocation, geoRestriction, timezoneRequirement, compensation]) {
    violations.push(...result.violations.filter((violation) => violation.rule !== 'empty'));
  }

  const stack = checkedList(
    'extract',
    'stack',
    candidate.stack,
    POSTING_LIMITS.stackCount,
    POSTING_LIMITS.stackItem,
  );
  const responsibilities = checkedList(
    'extract',
    'responsibilities',
    candidate.responsibilities,
    POSTING_LIMITS.responsibilityCount,
    POSTING_LIMITS.responsibilityItem,
  );
  violations.push(...stack.violations, ...responsibilities.violations);

  // The hallucination guard, on the field where invention is both most likely
  // and most consequential: a technology on a card is a claim an interviewer
  // may ask Davit about.
  const groundedStack = filterUngrounded(stack.values, corpus, 'stack');
  violations.push(
    ...groundedStack.violations.map((violation) => ({ ...violation, stage: 'extract' as const })),
  );

  const groundedOffice = groundedField('officeLocation', officeLocation.value, corpus);
  const groundedGeo = groundedField('geoRestriction', geoRestriction.value, corpus);
  const groundedPay = groundedField('compensation', compensation.value, corpus);
  violations.push(
    ...groundedOffice.violations,
    ...groundedGeo.violations,
    ...groundedPay.violations,
  );

  const applyTargetRaw = checked(
    'extract',
    'applyTarget',
    candidate.applyTarget,
    POSTING_LIMITS.applyTarget,
  );
  violations.push(
    ...applyTargetRaw.violations.filter((violation) => violation.rule !== 'empty'),
  );

  const applyTarget = checkApplyTarget(applyTargetRaw.value, posting);
  violations.push(...applyTarget.violations);

  const enumsMissing =
    !seniority.value || !engagement.value || !workMode.value || !applyMethod.value;

  if (violations.some(failsRecord) || applyTarget.fatal || enumsMissing) {
    return { ok: false, value: null, violations };
  }

  return {
    ok: true,
    value: {
      key: posting.key,
      title: posting.title,
      company: posting.company,
      seniority: seniority.value!,
      engagement: engagement.value!,
      workMode: workMode.value!,
      officeLocation: groundedOffice.value,
      geoRestriction: groundedGeo.value,
      timezoneRequirement: timezoneRequirement.value,
      stack: groundedStack.kept,
      responsibilities: responsibilities.values,
      compensation: groundedPay.value,
      applyMethod: applyMethod.value!,
      applyTarget: applyTarget.value,
    },
    violations,
  };
}

// ─── Stage B ─────────────────────────────────────────────────────────

const ELIGIBILITY = ['eligible', 'needs_check', 'ineligible'] as const;
const RECOMMENDATION = ['draft', 'surface_only', 'skip'] as const;

/**
 * Validates one stage-B verdict.
 *
 * Stage B only ever saw sanitised input, so in principle this is redundant —
 * which is exactly why it runs. The value of a layer is what it catches when the
 * layer above it was wrong.
 *
 * `eligibilityEvidence` is the one field with a rule of its own: it must be
 * traceable to a field of the `ExtractedPosting` it was given. An evidence
 * sentence the posting never contained is a verdict resting on something the
 * model made up, and the card would present it as the reason a human should
 * believe the decision. Ungrounded evidence does not fail the record; it
 * downgrades the verdict to `needs_check`, which is the honest outcome — the
 * posting has not been shown to be eligible, and asking is cheap.
 */
export function sanitizeVerdict(
  raw: unknown,
  extracted: ExtractedPosting,
): SanitizeResult<FitVerdict> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      value: null,
      violations: [{ stage: 'score', field: '(root)', rule: 'not-an-object', detail: typeof raw }],
    };
  }

  const candidate = raw as Record<string, unknown>;
  const violations: OutreachViolation[] = [];

  const eligibility = checkedEnum('score', 'eligibility', candidate.eligibility, ELIGIBILITY);
  const recommendation = checkedEnum(
    'score',
    'recommendation',
    candidate.recommendation,
    RECOMMENDATION,
  );
  violations.push(...eligibility.violations, ...recommendation.violations);

  const evidence = checked(
    'score',
    'eligibilityEvidence',
    candidate.eligibilityEvidence,
    POSTING_LIMITS.evidence,
  );
  violations.push(...evidence.violations.filter((violation) => violation.rule !== 'empty'));

  const reasons = checkedList(
    'score',
    'reasons',
    candidate.reasons,
    POSTING_LIMITS.reasonCount,
    POSTING_LIMITS.reasonItem,
  );
  const flags = checkedList(
    'score',
    'flags',
    candidate.flags,
    POSTING_LIMITS.flagCount,
    POSTING_LIMITS.flagItem,
  );
  violations.push(...reasons.violations, ...flags.violations);

  const rawFit = typeof candidate.fit === 'number' ? candidate.fit : Number.NaN;
  if (!Number.isFinite(rawFit)) {
    violations.push({
      stage: 'score',
      field: 'fit',
      rule: 'not-a-number',
      detail: String(candidate.fit).slice(0, 60),
    });
  }
  const fit = Number.isFinite(rawFit) ? Math.min(100, Math.max(0, Math.round(rawFit))) : 0;

  if (violations.some(failsRecord) || !eligibility.value || !recommendation.value) {
    return { ok: false, value: null, violations };
  }

  // Everything stage B was shown, folded. All of it, including the enums: a
  // model asked for "the sentence that decided it" will quote `workMode` as
  // readily as it quotes a location, and a corpus missing three fields marks
  // those quotations as inventions.
  const corpus = fold(
    [
      extracted.title,
      extracted.company,
      extracted.seniority,
      extracted.engagement,
      extracted.workMode,
      extracted.officeLocation,
      extracted.geoRestriction,
      extracted.timezoneRequirement,
      extracted.compensation,
      ...extracted.stack,
      ...extracted.responsibilities,
    ].join(' '),
  );

  const quoted = stripFieldPrefix(evidence.value);

  let value: FitVerdict = {
    eligibility: eligibility.value,
    eligibilityEvidence: quoted,
    fit,
    reasons: reasons.values,
    flags: flags.values,
    recommendation: recommendation.value,
  };

  if (quoted && !corpus.includes(fold(quoted))) {
    violations.push({
      stage: 'score',
      field: 'eligibilityEvidence',
      rule: 'ungrounded',
      detail: quoted.slice(0, 120),
    });

    // The sentence is the model's own prose, so it is dropped: a card that
    // presents a paraphrase under the heading "the sentence that decided it"
    // is telling a small lie in the one place a human is checking the machine's
    // work. `reasons` still carries the argument.
    //
    // The downgrade applies to `eligible` alone. §17.5 says "the verdict is
    // downgraded to needs_check", and for an unevidenced *yes* that is exactly
    // right — that is the answer that leads to an application. Applying it to
    // `ineligible` as well would quietly resurface roles that were correctly
    // ruled out, and applying it to `needs_check` changes nothing.
    value = {
      ...value,
      eligibilityEvidence: '',
      eligibility: value.eligibility === 'eligible' ? 'needs_check' : value.eligibility,
      flags: [...value.flags, 'ungrounded_evidence'],
    };
  }

  return { ok: true, value, violations };
}

/**
 * Re-validates a single-line string a human typed into `/admin`.
 *
 * Not because the admin is suspected, but because it is the one path where
 * arbitrary text reaches an outbound channel without having passed the
 * pipeline. For a subject line, collapsing whitespace is right — see
 * `sanitizeEditedBody` for the field where it is emphatically not.
 */
export function sanitizeEditedField(
  field: string,
  raw: unknown,
  maxLength: number,
  /** Which stage to record a refusal against. A model-written draft is not a score. */
  stage: OutreachViolation['stage'] = 'score',
): SanitizeResult<string> {
  const result = checked(stage, field, raw, maxLength);
  const ok = result.violations.length === 0;
  return { ok, value: ok ? result.value : null, violations: result.violations };
}

/**
 * The same checks, for a field whose line breaks are part of its meaning.
 *
 * `normalizeText` collapses every run of whitespace to one space, which is
 * exactly right for pulling a one-line location out of a scraped posting and
 * exactly wrong for a cover letter. Routing the message body through the
 * single-line checker destroyed it silently: a paragraphed letter came back
 * from a reload as one wall of text, permanently, with the UI cheerfully
 * reporting that the draft had been saved. That is a worse outcome than
 * refusing the edit would have been.
 *
 * So the normalisation is applied **per line** rather than across the whole
 * value. Each line goes through `normalizeText`, which is what strips the
 * zero-width and bidi characters and collapses runs of spaces within a line;
 * the newlines between them survive, and three or more in a row become a
 * paragraph break. The rule batteries then run over the result, so nothing is
 * checked less strictly — an injection split across two lines is still one
 * string by the time `checkField` sees it.
 */
export function sanitizeEditedBody(
  field: string,
  raw: unknown,
  maxLength: number,
  /** Which stage to record a refusal against. A model-written draft is not a score. */
  stage: OutreachViolation['stage'] = 'score',
): SanitizeResult<string> {
  if (typeof raw !== 'string') {
    return {
      ok: false,
      value: null,
      violations: [{ stage: 'score', field, rule: 'not-a-string', detail: typeof raw }],
    };
  }

  const preserved = raw
    .split('\n')
    .map((line) => normalizeText(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const result = checked(stage, field, preserved, maxLength);
  const ok = result.violations.length === 0;

  // `result.value` is the flattened form the checks ran against; what is stored
  // is the value a person actually typed.
  return { ok, value: ok ? preserved : null, violations: result.violations };
}

/** Exposed for the fixture drill, which compares normalised text to normalised text. */
export { normalizeText };
