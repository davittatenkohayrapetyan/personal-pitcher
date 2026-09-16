import type { ExtractedPosting } from './types';
import { explainScore, type RubricScore } from './rubric';
import { parseJsonBlock, type OutreachModel } from './llm';
import { logger } from '../logger';

/**
 * The one model pass over a drafted letter, and the only question it is asked.
 *
 * ## A same-model judge is weak, and this module is built around that
 *
 * `gemma4:26b` writes these letters and `gemma4:26b` is the only model on the
 * LAN, so the critic and the author are the same thing. That is not a detail to
 * note and move past — it determines what this pass may be used for.
 *
 * A model grading its own output favours **fluency**: it rewards the register
 * it produces, because the property it is measuring and the property it was
 * optimised for are the same property. Worse, it **forgives its own failure
 * modes**. Ask it whether a letter is needy and it will say no about one that
 * opens "I would be thrilled", because that is a well-formed sentence on topic
 * and the model has no independent notion of what neediness costs. Ask it
 * whether every claim is grounded and it will say yes, because it wrote them
 * and they were plausible when it did. §7's whole argument — a claim is either
 * traceable to `data/profile.md` or absent — is exactly the kind of check a
 * generator cannot run on itself.
 *
 * So `rubric.ts` carries the weight the judge cannot: needy and oversell
 * markers, grounding, word and paragraph counts, placeholders, markdown, and
 * whether the letter names two real requirements. All of it deterministic, all
 * of it fixtured against hand-written letters, none of it asked of a model.
 *
 * ## What is left over, and it is worth one call
 *
 * One thing a rule genuinely cannot see: **is the argument about this posting,
 * or is it generic?** A letter can name Kafka because the posting says Kafka,
 * cite a real number from the profile, and still be four paragraphs that would
 * fit any backend role at any company — the keyword check passes and the letter
 * is worthless. That judgement needs reading comprehension, and it is a
 * judgement about the *input*, not about the model's own prose, which is the one
 * shape of question a same-model judge is not disqualified from answering.
 *
 * The critic is therefore handed the rubric's findings **explicitly**, and told
 * they are already decided. Asking a model for "feedback" on a letter produces
 * what asking a model for feedback always produces: a paragraph about adding a
 * strong closing statement and quantifying impact, generated from the shape of
 * the request rather than from the letter. Naming what has already been checked
 * is what leaves it with only the question worth its forty-five seconds.
 *
 * ## One pass, not a conversation
 *
 * It runs once, on the survivor of best-of-N, and its output feeds at most two
 * revisions (`draftLoop.ts`). It is never re-run to see whether it is happier —
 * a judge asked twice about text it has just influenced is measuring its own
 * echo, and a loop that runs until its judge approves is a loop with no ceiling.
 */

/**
 * Small bounds on purpose. §23 records the bisection: llama.cpp expands
 * `maxLength: N` into N optional grammar repetitions, so a letter-sized bound is
 * a `400 Bad Request` from Ollama. Two hundred characters is what stage A's
 * longest field uses and it compiles.
 */
const CRITIC_SCHEMA = {
  type: 'object',
  required: ['reviews'],
  additionalProperties: false,
  properties: {
    reviews: {
      type: 'array',
      maxItems: 2,
      items: {
        type: 'object',
        required: ['id', 'generic', 'notes'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', maxLength: 40 },
          generic: { type: 'boolean' },
          notes: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 200 } },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `You are reviewing a job application letter that another writer has already drafted. You are not rewriting it and you are not scoring it.

A checker has ALREADY verified all of the following, and you must not comment on any of them:
- word count, paragraph count, markdown, placeholders, sign-off blocks
- needy phrasing and overselling adjectives
- whether every employer and technology named appears in the candidate's profile
- whether the letter mentions requirements from the posting

You have ONE question to answer about each letter:

  Is the argument in this letter about THIS posting, or would it read the same
  against any job with a similar title?

A letter can name the right technologies and quote a real number and still be generic: that happens when the specifics are decoration on an argument that was not built from this posting. A letter is specific when removing this posting's details would break its reasoning, not just its nouns.

Judge only what is in front of you. Do not invent facts about the candidate, do not suggest claims he has not made, and do not propose anything the profile does not support — a suggestion that he "mention his leadership of a large team" is worthless if no such team is in the profile.

For each letter return:
- "generic": true if it would read the same against another posting, false if it would not.
- "notes": at most four short, concrete instructions, each naming a sentence or a paragraph and what to do with it. If the letter is already specific, return an empty array rather than inventing work.

Return JSON: { "reviews": [ { "id": ..., "generic": ..., "notes": [...] } ] }`;

export interface CriticLetter {
  id: string;
  body: string;
  score: RubricScore;
}

export interface CriticReview {
  id: string;
  generic: boolean;
  notes: string[];
}

export interface CriticResult {
  reviews: CriticReview[];
  /** `model_failed` | `unparseable`. Absent on success. */
  reason?: string;
  durationMs: number;
}

function buildPrompt(extracted: ExtractedPosting, letters: CriticLetter[]): string {
  const lines = [
    'THE POSTING',
    `company: ${extracted.company}`,
    `title: ${extracted.title}`,
    `seniority: ${extracted.seniority}`,
    `stack it names: ${extracted.stack.join(', ') || '(not stated)'}`,
    'what it says the role involves:',
    ...extracted.responsibilities.map((item) => `  - ${item}`),
    '',
  ];

  for (const letter of letters) {
    lines.push(
      `LETTER ${letter.id}`,
      '---',
      letter.body,
      '---',
      // Handed over rather than left implicit. The critic is told what is
      // already decided so that its one pass is not spent re-deciding it.
      'Already checked by the deterministic rubric, do not repeat any of this:',
      ...explainScore(letter.score).map((line) => `  ${line}`),
      '',
    );
  }

  lines.push(
    letters.length > 1
      ? `Review both letters. Use the ids exactly as written: ${letters.map((l) => l.id).join(', ')}.`
      : `Review the letter. Use the id exactly as written: ${letters[0]?.id ?? ''}.`,
  );

  return lines.join('\n');
}

/**
 * Reviews one or two letters in a single call.
 *
 * Two in one call rather than two calls, and not only to save forty-five
 * seconds: a critic shown both letters about the same posting is answering a
 * comparison, which is a question it is measurably better at than "is this one
 * good?" asked in isolation. It is also the only call in this loop whose cost
 * does not double when a second tone variant is enabled.
 *
 * Never throws. A critic that fails costs the loop its revisions, not its
 * letter — the survivor of best-of-N is already a scored, sanitised candidate.
 */
export async function critiqueLetters(
  model: OutreachModel,
  extracted: ExtractedPosting,
  letters: CriticLetter[],
): Promise<CriticResult> {
  const started = Date.now();

  if (letters.length === 0) return { reviews: [], durationMs: 0 };

  let raw: string;
  try {
    raw = await model.generate(SYSTEM_PROMPT, buildPrompt(extracted, letters), CRITIC_SCHEMA);
  } catch (err) {
    logger.warn('outreach_critic_failed', {
      job: 'outreach',
      company: extracted.company,
      reason: err instanceof Error ? err.message : String(err),
    });
    return { reviews: [], reason: 'model_failed', durationMs: Date.now() - started };
  }

  const parsed = parseJsonBlock(raw) as { reviews?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.reviews)) {
    logger.warn('outreach_critic_failed', {
      job: 'outreach',
      company: extracted.company,
      reason: 'unparseable',
    });
    return { reviews: [], reason: 'unparseable', durationMs: Date.now() - started };
  }

  const known = new Set(letters.map((letter) => letter.id));
  const reviews: CriticReview[] = [];

  for (const entry of parsed.reviews) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as { id?: unknown; generic?: unknown; notes?: unknown };
    // An id the critic invented is a review of nothing, and applying it to a
    // letter by position would silently attach one letter's notes to the other.
    if (typeof row.id !== 'string' || !known.has(row.id)) continue;

    reviews.push({
      id: row.id,
      generic: row.generic === true,
      notes: Array.isArray(row.notes)
        ? row.notes.filter((note): note is string => typeof note === 'string' && note.trim().length > 0)
        : [],
    });
  }

  logger.info('outreach_critiqued', {
    job: 'outreach',
    company: extracted.company,
    letters: letters.length,
    reviewed: reviews.length,
    generic: reviews.filter((review) => review.generic).length,
    durationMs: Date.now() - started,
  });

  return { reviews, durationMs: Date.now() - started };
}
