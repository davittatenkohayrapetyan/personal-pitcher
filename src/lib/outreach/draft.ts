import fs from 'fs';
import type { Draft, ExtractedPosting, FitVerdict, OutreachViolation } from './types';
import type { Preferences } from './preferences';
import { PROFILE_FILE, disclosureLine } from './config';
import { openOutreachModel, parseJsonBlock, type OutreachModel } from './llm';
import { loadProjects, toneExamples } from '../refresh/propose';
import { POSTING_LIMITS, sanitizeEditedBody, sanitizeEditedField } from './sanitize';
import { mentionsMoney } from './rubric';
import { logger } from '../logger';

/**
 * Stage C — the message itself (§7, §17.5).
 *
 * The third and last model call, and the only one whose output a human being
 * on the other end will read. Its inputs are deliberately *all* second-hand:
 * the sanitised `ExtractedPosting`, stage B's `FitVerdict`, the typed
 * preferences, and `data/profile.md`. It never sees a line of the employer's
 * prose. That is the same split stages A and B keep, for the same reason — the
 * stage that composes a message must not also be the stage that read an
 * attacker's text.
 *
 * ## What it is not allowed to do
 *
 * - **Invent experience.** The profile is the only source for a claim about
 *   Davit, and the system prompt says so in as many words. A letter that
 *   credits him with Kubernetes he has never run is worse than no letter: it
 *   gets found out in the first interview.
 * - **Quote a salary.** No figure reaches this prompt in either currency —
 *   `preferenceLines` omits them and so does everything below. §5 keeps the
 *   numbers for the code paths that compare against them, and §23 records why:
 *   a number in a prompt is a number that can be quoted back in a draft.
 * - **Write the disclosure.** The line naming Personal Pitcher is appended by
 *   code afterwards and is never asked for, so it cannot be reworded, softened
 *   or dropped by a model having an inventive morning. §17.5 is explicit about
 *   this and it is the one sentence in the message whose exact wording is a
 *   commitment rather than a pitch.
 *
 * ## Why this returns JSON when §17.5 says plain text
 *
 * §17.5's reasoning is that "a letter is prose", and it is right about the
 * body. It is not right about the subject, which is a field: a header with a
 * length limit that has to survive being put in an envelope. The alternatives
 * were a second model call — 45 to 90 seconds on the Mac for one line — or
 * parsing a `Subject:` prefix out of free text, which fails the first time a
 * model writes `Subject line:` instead. `Draft` has carried both fields since
 * phase 4, so one schema-constrained call fills the shape that already exists.
 * §23 records the divergence.
 *
 * ## Nothing here sends
 *
 * Stage C drafts; stage D transmits a stored, approved, byte-identical draft
 * (§3's third rule). This module has no idea that `send.ts` will exist, and the
 * draft it writes is editable in `/admin` before anyone approves it —
 * regenerating at send time would mean the approved text and the sent text can
 * differ, which makes the approval meaningless.
 */

/** Bytes of profile handed over. The whole file today; the cap is for when it grows. */
const PROFILE_BUDGET = 16_000;

/** §7: 150–250 words. This is the ceiling the sanitiser enforces, not the target. */
const BODY_LIMIT = 4_000;

/**
 * Note what is missing: a `maxLength` on `body`.
 *
 * It was there, at 2600, and every call came back `400 Bad Request` from
 * Ollama. Bisected rather than guessed at: two fields are fine, a small
 * `maxLength` is fine, and `maxLength: 600` on one field is fine, while
 * `maxLength: 2600` fails on its own. llama.cpp turns a JSON schema into a GBNF
 * grammar and expands `maxLength: N` into N optional repetitions, so a
 * letter-sized bound produces a grammar too large to compile. Stage A never hit
 * it because its longest field is 200 characters.
 *
 * The right split anyway: the schema is for the *shape* — two fields, both
 * strings, nothing else — and `sanitizeEditedBody` below is for the size. A
 * bound the sanitiser enforces is one that holds for a hand-typed draft too.
 */
const DRAFT_SCHEMA = {
  type: 'object',
  required: ['subject', 'body'],
  additionalProperties: false,
  properties: {
    subject: { type: 'string', maxLength: 120 },
    body: { type: 'string' },
  },
} as const;

/**
 * The two openings, and why there are two.
 *
 * Davit asked to be shown two letters in different registers and to pick one,
 * rather than to be handed a single letter and told it won the internal
 * argument. That is a better use of the loop than it sounds: the rubric can say
 * which candidate has fewer problems, and the critic can say whether the
 * argument is about this posting, but neither can say which of two clean,
 * on-topic letters *sounds like him*. He can, in about fifteen seconds, and the
 * answer is recorded (`TonePreference`) and fed back into later prompts.
 *
 * Both variants sit inside §7's triad — friendly, professional, confident — and
 * neither relaxes any rule. What differs is the **opening move**, which is the
 * part of a cover letter a reader actually decides on:
 *
 * - `evidence` leads with the strongest checkable fact. It is the register §7
 *   argues for most directly: "p95 under 500 ms at 100,000 requests a minute"
 *   in the first eighty words, before any framing.
 * - `problem` leads with the thing the posting says it needs, then answers it.
 *   It reads as more consultative and risks being slower to the point, which is
 *   exactly the trade worth putting in front of a person rather than guessing.
 *
 * `neutral` carries no extra instruction and is what the one-shot button uses,
 * so the fast path is byte-for-byte the prompt it has always sent and the loop's
 * contribution stays measurable against it.
 */
export interface DraftVariant {
  id: string;
  /** Shown on the card next to the letter. */
  label: string;
  /** One sentence added to the system prompt. Never relaxes a rule. */
  instruction: string;
}

export const NEUTRAL_VARIANT: DraftVariant = {
  id: 'neutral',
  label: 'Default',
  instruction: '',
};

export const DRAFT_VARIANTS: DraftVariant[] = [
  {
    id: 'evidence',
    label: 'Evidence first',
    instruction:
      'OPENING: after one short line saying who is writing and about which role, go straight to the ' +
      'single most checkable fact in the profile that bears on this posting — a measured number, ' +
      'named system or named platform — and build the letter outward from it.',
  },
  {
    id: 'problem',
    label: 'Problem first',
    instruction:
      'OPENING: after one short line saying who is writing and about which role, name the problem ' +
      'this posting is describing in your own words, in one sentence, and then answer it with what ' +
      'he has actually done. Do not flatter the company and do not speculate about its business.',
  },
];

export function variantById(id: string): DraftVariant {
  return DRAFT_VARIANTS.find((variant) => variant.id === id) ?? NEUTRAL_VARIANT;
}

const SYSTEM_PROMPT = `You are writing one short job application email, as the candidate, in the first person.

TONE: friendly, professional, confident.
- Confident means stating what he did, plainly and once. "I led the modernization of a wealth-management platform" — not "I believe I could bring value" and not "I feel I would be a good fit".
- Friendly means a person wrote it. Contractions are fine. A plain opening sentence beats a formal one. The reader is a colleague, not a gatekeeper.
- Professional bounds the other two: no jokes, no exclamation marks, no familiarity with someone he has never met.

NEVER SOUND NEEDY. This is the failure that costs a reply. Do not write "I would love", "I am excited", "dream role", "I hope to hear from you", "please consider me", or thank anyone in advance for their time.

NEVER OVERSELL. Do not write "world-class", "expert", "passionate", "perfect fit", "proven track record", or any superlative. These are not facts about anyone. A number from the profile is worth more than every adjective in this paragraph: a specific latency or throughput figure is something the reader can check.

Rules, all of them absolute:
- Use ONLY facts from the candidate profile you are given. If the profile does not say it, you may not claim it. Never invent an employer, a number of years, a technology, a metric or a qualification.
- Prefer the profile's concrete numbers and named systems over descriptions of them. If the profile gives a measured outcome that is relevant to this posting, use it.
- Address what the posting actually asks for. Name the two or three requirements the candidate genuinely matches, and say what he did that is evidence for each.
- Do not mention salary, rates, compensation or notice period. Not once, in any currency.
- Do not flatter the company or praise its product.
- No placeholders of any kind. Never write [Your Name], [Company] or similar. If you do not know something, leave it out of the sentence.
- Plain prose. No markdown, no bullet lists, no headings, no signature block, no "Best regards" sign-off.
- 150 to 250 words in the body. Four short paragraphs at most.

The subject is a header, not a sentence: name the role and say who is writing, under 80 characters.

Return JSON with exactly two fields, "subject" and "body".`;

function readProfile(): string {
  try {
    return fs.readFileSync(PROFILE_FILE, 'utf-8').slice(0, PROFILE_BUDGET);
  } catch {
    // The profile is the only source of claims about Davit, so its absence is
    // not something to write around: the caller refuses rather than letting a
    // model fill the gap from whatever it remembers about senior engineers.
    return '';
  }
}

/**
 * Davit's own prose, as a register reference.
 *
 * §7 asks for this by name — "tone examples come from existing `data/` prose,
 * reusing the `toneExamples()` trick in `refresh/propose.ts`" — and it is the
 * cheapest quality lever stage C has. The alternative inputs are a profile,
 * which is a list of facts, and a posting, which is somebody else's marketing.
 * Neither tells a model what Davit sounds like when he writes a sentence about
 * his own work, and that is exactly what a cover letter is.
 *
 * They are `description | highlight` pairs out of `projects.json`: sentences he
 * wrote, published under his own name, about things he actually built. Not
 * example letters — there are none, and inventing them would be putting words
 * in his mouth at the one point where the whole letter is supposed to be his.
 *
 * Passed as voice and never as content, with the prompt saying so, exactly as
 * `refresh/edit.ts` does. A letter that cited a project the posting has no use
 * for because it appeared in this block would be a worse letter, and the
 * grounding check cannot catch it — `projects.json` is also in `profile.md`, so
 * it is grounded and wrong.
 *
 * Returns an empty array rather than throwing. A drafting stage that fails
 * because `projects.json` moved would be trading the whole letter for its
 * register.
 */
function voiceExamples(): string[] {
  try {
    return toneExamples(loadProjects());
  } catch {
    return [];
  }
}

/**
 * What the model is told about the candidate's preferences.
 *
 * `notes` is included and the numbers are not. `preferences.ts` describes that
 * field as "read by the drafting stage only", and it is the one place the
 * preference doc's prose is genuinely useful — it is how "I would want to keep
 * doing architecture work" reaches a letter. The salary band stays where §5 put
 * it.
 */
function preferenceLines(preferences: Preferences): string {
  const lines: string[] = [];
  if (preferences.targetRoles.length) lines.push(`roles he is looking for: ${preferences.targetRoles.join('; ')}`);
  if (preferences.preferredStack.length) lines.push(`stack he prefers: ${preferences.preferredStack.join(', ')}`);
  if (preferences.notes.trim()) lines.push(`his own notes: ${preferences.notes.trim()}`);
  return lines.join('\n');
}

function buildPrompt(inputs: DraftInputs): string {
  const { extracted, verdict, preferences, profile, voice, preferred } = inputs;
  return [
    'THE ROLE',
    `company: ${extracted.company}`,
    `title: ${extracted.title}`,
    `seniority: ${extracted.seniority}`,
    `engagement: ${extracted.engagement}`,
    `work mode: ${extracted.workMode}`,
    `location: ${extracted.officeLocation || '(not stated)'}`,
    `stack named in the posting: ${extracted.stack.join(', ') || '(not stated)'}`,
    `what the role involves: ${extracted.responsibilities.join('; ') || '(not stated)'}`,
    '',
    // Stage B's reasons are why this role was worth a letter at all, so they
    // are the outline of the letter's middle. They are also already sanitised.
    //
    // Filtered for money, and this is not belt-and-braces: stage B's own prompt
    // *does* receive `compensation`, so a reason reading "the posted band sits
    // above his floor, at …" is a published figure arriving in the drafting
    // prompt by the back door. §5 says no figure in any currency, and §23 says
    // why — a number in a prompt is a number that can be quoted back in a
    // letter. Dropping one reason costs a sentence of outline; letting it
    // through costs a salary figure in a message to a stranger.
    ...(verdict && verdict.reasons.filter((reason) => !mentionsMoney(reason)).length
      ? [
          'WHY THIS ROLE WAS SHORTLISTED',
          ...verdict.reasons.filter((reason) => !mentionsMoney(reason)).map((reason) => `- ${reason}`),
          '',
        ]
      : []),
    'THE CANDIDATE — the only permitted source of claims about him',
    profile,
    '',
    ...(preferenceLines(preferences) ? ['WHAT HE IS LOOKING FOR', preferenceLines(preferences), ''] : []),
    ...(preferred.length
      ? [
          'A LETTER DAVIT CHOSE over an alternative for a different role. This is the register he',
          'picked when he was shown two. Match the register; do not reuse a sentence of it, and do',
          'not carry over a fact that is not in this posting or this profile:',
          preferred[0],
          '',
        ]
      : []),
    ...(voice.length
      ? [
          'VOICE REFERENCE — sentences Davit wrote about his own work, for tone only.',
          'Do not copy their content and do not mention these projects unless this posting',
          'gives you a reason to:',
          ...voice.map((example) => `  - ${example}`),
          '',
        ]
      : []),
    'Write the email now.',
  ].join('\n');
}

/**
 * Everything a draft call needs that is not the model.
 *
 * Bundled because the loop makes up to eleven calls for one opportunity and
 * every one of them wants the same profile, the same voice examples and the
 * same preferences. Reading `data/profile.md` eleven times would be harmless
 * and re-opening the model gate would not: `openOutreachModel` probes the Mac
 * for reachability, and eleven probes against a machine that has just answered
 * one is eleven LAN round trips bought for nothing.
 */
export interface DraftInputs {
  extracted: ExtractedPosting;
  verdict: FitVerdict | null;
  preferences: Preferences;
  profile: string;
  voice: string[];
  /**
   * Letters Davit has picked before, as register reference. At most one, and
   * that bound is deliberate: `num_ctx` is the one budget in this prompt nobody
   * has measured (§23), the profile alone is already 12 kB, and Ollama truncates
   * rather than erroring — so the failure mode of being generous here is the
   * front of the prompt, where the rules are, silently falling off the end.
   */
  preferred: string[];
}

/**
 * Gathers the inputs, or returns null when the profile is unreadable.
 *
 * Null rather than a default, for the reason `readProfile` gives: the profile
 * is the only permitted source of claims about Davit, so its absence is not
 * something to write around.
 */
export function loadDraftInputs(
  extracted: ExtractedPosting,
  verdict: FitVerdict | null,
  preferences: Preferences,
  preferred: string[] = [],
): DraftInputs | null {
  const profile = readProfile();
  if (!profile.trim()) return null;
  return { extracted, verdict, preferences, profile, voice: voiceExamples(), preferred };
}

export interface DraftResult {
  draft: Draft | null;
  violations: OutreachViolation[];
  /** A stable slug when there is no draft: `no_model`, `no_profile`, `unparseable`, `rejected`. */
  reason?: string;
}

/**
 * Asks for one letter and returns it unsanitised.
 *
 * The single place a drafting prompt is sent, used by the one-shot button and by
 * every step of the loop. Sanitising is the caller's job because the loop scores
 * candidates it will throw away, and running the outbound-text sanitiser over a
 * letter that is never going anywhere would record violations against `draft`
 * for text nobody will ever see.
 *
 * Never throws: a model failure is an ordinary outcome here.
 */
export async function generateCandidate(
  model: OutreachModel,
  inputs: DraftInputs,
  variant: DraftVariant,
  revision?: { body: string; instructions: string[] },
): Promise<{ subject: string; body: string; reason?: string; durationMs: number; promptChars: number }> {
  const started = Date.now();
  const system = [SYSTEM_PROMPT, variant.instruction].filter(Boolean).join('\n\n');

  const prompt = revision
    ? [
        buildPrompt(inputs),
        '',
        'YOU HAVE ALREADY WRITTEN A DRAFT. Here it is:',
        '---',
        revision.body,
        '---',
        '',
        'Rewrite it, fixing every point below and changing nothing else. Keep what already works;',
        'this is an edit, not a fresh attempt. All the rules above still apply.',
        ...revision.instructions.map((instruction) => `- ${instruction}`),
        '',
        'Return the rewritten email as JSON with exactly two fields, "subject" and "body".',
      ].join('\n')
    : buildPrompt(inputs);

  // §23 records the context window as unmeasured, and this is the measurement,
  // carried out to the caller rather than logged per call: Ollama truncates
  // rather than erroring, and the rules are at the *front* of this prompt, so an
  // input that outgrows `num_ctx` loses the half that keeps the letter honest.
  // Roughly four characters to a token. `OUTREACH_DRAFT_NUM_CTX` is the lever
  // and `config.ts` explains why it is not pulled by default.
  const promptChars = system.length + prompt.length;

  let raw: string;
  try {
    raw = await model.generate(system, prompt, DRAFT_SCHEMA);
  } catch (err) {
    logger.warn('outreach_draft_failed', {
      job: 'outreach',
      company: inputs.extracted.company,
      variant: variant.id,
      reason: err instanceof Error ? err.message : String(err),
    });
    return { subject: '', body: '', reason: 'model_failed', durationMs: Date.now() - started, promptChars };
  }

  const parsed = parseJsonBlock(raw) as { subject?: unknown; body?: unknown } | null;
  if (!parsed || typeof parsed.subject !== 'string' || typeof parsed.body !== 'string') {
    logger.warn('outreach_draft_failed', {
      job: 'outreach',
      company: inputs.extracted.company,
      variant: variant.id,
      reason: 'unparseable',
    });
    return { subject: '', body: '', reason: 'unparseable', durationMs: Date.now() - started, promptChars };
  }

  return { subject: parsed.subject, body: parsed.body, durationMs: Date.now() - started, promptChars };
}

/**
 * Turns an accepted subject and body into the thing that would be sent.
 *
 * The one place the disclosure line is attached, so there is one place to read
 * if anyone ever wonders whether a code path can produce a letter without it.
 */
export function finaliseDraft(
  subject: string,
  body: string,
  /** Null is a real case: a card with no stage A extraction has no address. */
  extracted: ExtractedPosting | null,
  model: string,
): Draft {
  return {
    subject,
    // Appended here and nowhere else. A model asked to include a disclosure
    // will reword it, and the wording is the commitment.
    body: `${body.trim()}\n\n${disclosureLine()}`,
    to: extracted?.applyMethod === 'email' ? extracted.applyTarget : '',
    model,
    draftedAt: new Date().toISOString(),
  };
}

/**
 * The two checks a hand-typed draft passes in the admin route, applied to a
 * model-written one — same path, weaker author.
 */
export function sanitizeCandidate(
  subject: string,
  body: string,
): { subject: string; body: string; violations: OutreachViolation[] } | { violations: OutreachViolation[] } {
  const checkedSubject = sanitizeEditedField('subject', subject, POSTING_LIMITS.title, 'draft');
  const checkedBody = sanitizeEditedBody('body', body, BODY_LIMIT, 'draft');
  const violations = [...checkedSubject.violations, ...checkedBody.violations];

  if (!checkedSubject.ok || checkedSubject.value === null || !checkedBody.ok || checkedBody.value === null) {
    return { violations };
  }

  return { subject: checkedSubject.value, body: checkedBody.value, violations };
}

function violation(field: string, rule: string, detail: string): OutreachViolation {
  return { stage: 'draft', field, rule, detail };
}

/**
 * Drafts one message, or explains why it could not.
 *
 * Never throws. A drafting failure is an ordinary outcome — the Mac is asleep,
 * the model wandered off-schema — and the card it belongs to is still a perfect
 * card with an empty message box that a person can type into. That is exactly
 * what the queue did before this stage existed.
 */
export async function draftMessage(
  extracted: ExtractedPosting,
  verdict: FitVerdict | null,
  preferences: Preferences,
): Promise<DraftResult> {
  const inputs = loadDraftInputs(extracted, verdict, preferences);
  if (!inputs) {
    logger.warn('outreach_draft_skipped', { job: 'outreach', reason: 'no_profile' });
    return { draft: null, violations: [], reason: 'no_profile' };
  }

  const gate = await openOutreachModel('draft');
  if (!gate.ok) {
    logger.info('outreach_draft_skipped', { job: 'outreach', reason: gate.reason });
    return { draft: null, violations: [], reason: 'no_model' };
  }

  // `NEUTRAL_VARIANT` carries no extra instruction, so the fast path sends the
  // prompt it has always sent. That is the point: the loop's contribution has
  // to be measurable against something that did not move.
  const candidate = await generateCandidate(gate.model, inputs, NEUTRAL_VARIANT);
  if (candidate.reason) {
    return {
      draft: null,
      violations:
        candidate.reason === 'unparseable'
          ? [violation('draft', 'unparseable', 'stage C returned no usable JSON')]
          : [],
      reason: candidate.reason,
    };
  }

  const checked = sanitizeCandidate(candidate.subject, candidate.body);
  if (!('subject' in checked)) {
    logger.warn('outreach_draft_rejected', {
      job: 'outreach',
      company: extracted.company,
      rules: checked.violations.map((entry) => entry.rule),
    });
    return { draft: null, violations: checked.violations, reason: 'rejected' };
  }

  logger.info('outreach_drafted', {
    job: 'outreach',
    company: extracted.company,
    title: extracted.title,
    model: gate.model.model,
    durationMs: candidate.durationMs,
    promptChars: candidate.promptChars,
    // The body is not logged. It is bounded third-party-adjacent prose and
    // `logs/` rotates daily (§20); the draft itself is in `pending.json`, which
    // is where a person reads it anyway.
    bodyChars: checked.body.length,
  });

  return {
    draft: finaliseDraft(
      checked.subject,
      checked.body,
      extracted,
      `${gate.model.label}:${gate.model.model}`,
    ),
    violations: checked.violations,
  };
}
