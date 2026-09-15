import fs from 'fs';
import type { Draft, ExtractedPosting, FitVerdict, OutreachViolation } from './types';
import type { Preferences } from './preferences';
import { PROFILE_FILE, disclosureLine } from './config';
import { openOutreachModel, parseJsonBlock } from './llm';
import { POSTING_LIMITS, sanitizeEditedBody, sanitizeEditedField } from './sanitize';
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

function buildPrompt(
  extracted: ExtractedPosting,
  verdict: FitVerdict | null,
  preferences: Preferences,
  profile: string,
): string {
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
    ...(verdict && verdict.reasons.length
      ? ['WHY THIS ROLE WAS SHORTLISTED', ...verdict.reasons.map((reason) => `- ${reason}`), '']
      : []),
    'THE CANDIDATE — the only permitted source of claims about him',
    profile,
    '',
    ...(preferenceLines(preferences) ? ['WHAT HE IS LOOKING FOR', preferenceLines(preferences), ''] : []),
    'Write the email now.',
  ].join('\n');
}

export interface DraftResult {
  draft: Draft | null;
  violations: OutreachViolation[];
  /** A stable slug when there is no draft: `no_model`, `no_profile`, `unparseable`, `rejected`. */
  reason?: string;
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
  const profile = readProfile();
  if (!profile.trim()) {
    logger.warn('outreach_draft_skipped', { job: 'outreach', reason: 'no_profile' });
    return { draft: null, violations: [], reason: 'no_profile' };
  }

  const gate = await openOutreachModel('draft');
  if (!gate.ok) {
    logger.info('outreach_draft_skipped', { job: 'outreach', reason: gate.reason });
    return { draft: null, violations: [], reason: 'no_model' };
  }

  const started = Date.now();
  let raw: string;
  try {
    raw = await gate.model.generate(
      SYSTEM_PROMPT,
      buildPrompt(extracted, verdict, preferences, profile),
      DRAFT_SCHEMA,
    );
  } catch (err) {
    logger.warn('outreach_draft_failed', {
      job: 'outreach',
      company: extracted.company,
      reason: err instanceof Error ? err.message : String(err),
    });
    return { draft: null, violations: [], reason: 'model_failed' };
  }

  const parsed = parseJsonBlock(raw) as { subject?: unknown; body?: unknown } | null;
  if (!parsed || typeof parsed.subject !== 'string' || typeof parsed.body !== 'string') {
    logger.warn('outreach_draft_failed', {
      job: 'outreach',
      company: extracted.company,
      reason: 'unparseable',
    });
    return {
      draft: null,
      violations: [violation('draft', 'unparseable', 'stage C returned no usable JSON')],
      reason: 'unparseable',
    };
  }

  // The same two checks a hand-typed draft passes in the admin route, and for a
  // stronger reason: this text was written by a model, and the sanitiser is the
  // thing standing between a model and an outbound channel.
  const subject = sanitizeEditedField('subject', parsed.subject, POSTING_LIMITS.title, 'draft');
  const body = sanitizeEditedBody('body', parsed.body, BODY_LIMIT, 'draft');
  const violations = [...subject.violations, ...body.violations];

  if (!subject.ok || subject.value === null || !body.ok || body.value === null) {
    logger.warn('outreach_draft_rejected', {
      job: 'outreach',
      company: extracted.company,
      rules: violations.map((entry) => entry.rule),
    });
    return { draft: null, violations, reason: 'rejected' };
  }

  logger.info('outreach_drafted', {
    job: 'outreach',
    company: extracted.company,
    title: extracted.title,
    model: gate.model.model,
    durationMs: Date.now() - started,
    // The body is not logged. It is bounded third-party-adjacent prose and
    // `logs/` rotates daily (§20); the draft itself is in `pending.json`, which
    // is where a person reads it anyway.
    bodyChars: body.value.length,
  });

  return {
    draft: {
      subject: subject.value,
      // Appended here and nowhere else. A model asked to include a disclosure
      // will reword it, and the wording is the commitment.
      body: `${body.value.trim()}\n\n${disclosureLine()}`,
      to: extracted.applyMethod === 'email' ? extracted.applyTarget : '',
      model: `${gate.model.label}:${gate.model.model}`,
      draftedAt: new Date().toISOString(),
    },
    violations,
  };
}
