import type { DraftCandidate, DraftRecord, ExtractedPosting, FitVerdict, OutreachViolation } from './types';
import type { Preferences } from './preferences';
import {
  DRAFT_VARIANTS,
  NEUTRAL_VARIANT,
  generateCandidate,
  loadDraftInputs,
  sanitizeCandidate,
  type DraftInputs,
  type DraftVariant,
} from './draft';
import { critiqueLetters, type CriticReview } from './critic';
import { compareByQuality, scoreLetter, type RubricCategory, type RubricScore } from './rubric';
import { openOutreachModel } from './llm';
import { draftCandidates, draftRevisions, draftVariants } from './config';
import { preferredLetters } from './store';
import { logger } from '../logger';

/**
 * Best-of-N against a deterministic rubric, one model critic, at most two
 * revisions, and every candidate kept (§7).
 *
 * ## It must not run in a web request, and that is not a preference
 *
 * This makes up to eleven model calls. At the Mac's measured 46–58 seconds each
 * that is seven to ten minutes during which Ollama — which serialises per model
 * — has nothing left for anyone else. §23 records what a *single* 90-second call
 * in the website's process can already do: a visitor asking one question makes
 * two tier-0 calls, classify and answer, and both can time out behind the draft.
 * Two timeouts is the whole of `MAC_CB_FAILURE_THRESHOLD`, so the breaker opens,
 * an alert fires about a machine that is healthy and busy, and five minutes of
 * visitors are answered by OpenAI. `draftTimeoutMs()` narrows that window; it
 * does not close it, and eleven calls widen it by an order of magnitude.
 *
 * So this runs on the host, out of process, through `npm run outreach:draft --
 * --id=…`, which is §17.1's established pattern for exactly this — the same
 * shape as `outreach:form`, with the copyable command on the card. The one-shot
 * `Generate draft` button stays as the fast path and still runs in the request,
 * because one call is the risk §23 already weighed and accepted.
 *
 * ## Why a rubric first and a model second
 *
 * The full argument is in `rubric.ts`'s header and it is short: the only model
 * available is the one that wrote the letter, a same-model judge favours its own
 * fluency and forgives its own failure modes, and — decisively — a model judge
 * cannot be fixtured, so a quality bar built on one is a vibe with a number
 * printed next to it. The rubric is fixtured, in
 * `npm run outreach -- --rubric-fixtures`, against hand-written good and bad
 * letters. The critic gets the one question rules cannot answer.
 *
 * ## The ceiling
 *
 * Two revisions maximum, and then the best-scoring candidate seen, whatever its
 * score. There is deliberately **no quality threshold to loop towards**: a loop
 * that runs until the score is high enough has no bound on the morning the model
 * wanders, and because every candidate is kept and scored, stopping early can
 * never return something worse than what was already in hand.
 */

export interface DraftLoopResult {
  record: DraftRecord | null;
  /** The chosen candidate, ready for `finaliseDraft`. Null when nothing survived. */
  chosen: DraftCandidate | null;
  violations: OutreachViolation[];
  /** `no_profile` | `no_model` | `no_candidates`. Absent on success. */
  reason?: string;
}

export interface DraftLoopOptions {
  /** Overrides `OUTREACH_DRAFT_CANDIDATES`, per variant. */
  candidates?: number;
  /** Overrides `OUTREACH_DRAFT_VARIANTS`. 1 or 2. */
  variants?: number;
  /** Overrides `OUTREACH_DRAFT_REVISIONS`. Never above two. */
  revisions?: number;
  /** Called after each model call, so a seven-minute script is not silent. */
  onProgress?: (message: string) => void;
}

/** A model can act on about four instructions in one pass; beyond that it picks. */
const MAX_INSTRUCTIONS = 4;

/**
 * Turns a scored candidate and a critic review into revision instructions.
 *
 * ## Only categories that scored below full marks contribute
 *
 * A finding is not automatically a defect. `requirementsCategory` reports
 * `names 5 of 7 requirements` on a letter scoring **100/100**, because that is
 * useful context for the critic — and the first version of this function turned
 * it into "Rewrite it, fixing every point below: names 5 of 7 requirements",
 * which is a count rather than a fault. Two consequences, both found by review
 * rather than by running it: every letter got a revision round it did not need,
 * costing `REVISIONS × VARIANTS` calls on the Mac; and the guard below —
 * "nothing left to ask for, so no revision call is made" — could never fire,
 * because the list was never empty. It is dead code no longer.
 *
 * ## The critic is not allowed to be truncated away
 *
 * The critic is the one model judgement in this loop and the whole reason
 * `critic.ts` exists. The first version appended every rubric finding, then the
 * critic's, then took the first four — so on any letter with four or more
 * rubric findings (five of the thirteen fixture letters) the critic's verdict
 * and all its notes were silently dropped, and the loop paid forty-five seconds
 * for an opinion it then threw away.
 *
 * The order is now: **blockers first** (a placeholder is unsendable and not a
 * matter of opinion), then the critic's `generic` verdict, then its notes, then
 * whatever non-blocking rubric findings still fit. Facts that make a letter
 * unsendable outrank an opinion; an opinion outranks a fact about style.
 */
function revisionInstructions(score: RubricScore, review: CriticReview | undefined): string[] {
  const blocking: string[] = [];
  const stylistic: string[] = [];

  for (const category of score.categories) {
    // Nothing to fix in a category that scored full marks, whatever it reported.
    if (category.score === 100) continue;
    for (const finding of category.findings) {
      (score.blockers.length && isBlockingCategory(category.id) ? blocking : stylistic).push(
        `${category.id}: ${finding}`,
      );
    }
  }

  const fromCritic: string[] = [];
  if (review?.generic) {
    fromCritic.push(
      'The argument is generic: it would read the same against another posting with a similar ' +
        'title. Rebuild the middle of the letter so that it only makes sense for this one.',
    );
  }
  for (const note of review?.notes ?? []) fromCritic.push(note);

  return [...blocking, ...fromCritic, ...stylistic].slice(0, MAX_INSTRUCTIONS);
}

/** The categories whose findings are `blockers` rather than matters of degree. */
function isBlockingCategory(id: RubricCategory['id']): boolean {
  return id === 'placeholders' || id === 'markdown' || id === 'signoff' || id === 'grounding';
}

function scoreCandidate(
  id: string,
  variant: DraftVariant,
  stage: string,
  subject: string,
  body: string,
  inputs: DraftInputs,
  model: string,
  durationMs: number,
): DraftCandidate {
  return {
    id,
    variant: variant.id,
    subject,
    body,
    score: scoreLetter({ body, profile: inputs.profile, extracted: inputs.extracted }),
    stage,
    model,
    durationMs,
  };
}

/**
 * Runs the loop for one opportunity.
 *
 * Never throws. Every failure below ends with either a letter or a stated
 * reason, because the card this is for works perfectly well with an empty box
 * that a person types into — which is what the queue did for two phases before
 * drafting existed.
 */
export async function runDraftLoop(
  extracted: ExtractedPosting,
  verdict: FitVerdict | null,
  preferences: Preferences,
  options: DraftLoopOptions = {},
): Promise<DraftLoopResult> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const progress = options.onProgress ?? (() => {});

  const inputs = loadDraftInputs(extracted, verdict, preferences, preferredLetters(1));
  if (!inputs) {
    logger.warn('outreach_draft_skipped', { job: 'outreach', reason: 'no_profile' });
    return { record: null, chosen: null, violations: [], reason: 'no_profile' };
  }

  const gate = await openOutreachModel('draft');
  if (!gate.ok) {
    logger.info('outreach_draft_skipped', { job: 'outreach', reason: gate.reason });
    return { record: null, chosen: null, violations: [], reason: 'no_model' };
  }

  const modelLabel = `${gate.model.label}:${gate.model.model}`;
  // Clamped here as well as in `config.ts`, because `??` skips the config
  // function entirely when the flag is present — so `--candidates=20
  // --variants=2` was forty letters and about forty minutes of the Mac.
  const perVariant = Math.min(5, Math.max(1, options.candidates ?? draftCandidates()));
  const variantCount = Math.min(2, Math.max(1, options.variants ?? draftVariants()));
  const revisionRounds = Math.min(2, Math.max(0, options.revisions ?? draftRevisions()));
  const variants = variantCount === 1 ? [NEUTRAL_VARIANT] : DRAFT_VARIANTS.slice(0, variantCount);

  const candidates: DraftCandidate[] = [];
  const violations: OutreachViolation[] = [];
  const survivors = new Map<string, DraftCandidate>();
  let maxPromptChars = 0;

  // ── Best-of-N, per variant ────────────────────────────────────────────────

  for (const variant of variants) {
    for (let attempt = 1; attempt <= perVariant; attempt += 1) {
      const id = `${variant.id}-${attempt}`;
      progress(`drafting ${id}…`);

      const produced = await generateCandidate(gate.model, inputs, variant);
      maxPromptChars = Math.max(maxPromptChars, produced.promptChars);
      if (produced.reason) {
        progress(`  ${id} failed: ${produced.reason}`);
        continue;
      }

      // Sanitised here rather than at the end, because an unsendable candidate
      // is not a candidate — and because the violations are worth recording
      // against the attempt that caused them rather than against the winner.
      const checked = sanitizeCandidate(produced.subject, produced.body);
      if (!('subject' in checked)) {
        violations.push(...checked.violations);
        progress(`  ${id} refused by the sanitiser: ${checked.violations.map((v) => v.rule).join(', ')}`);
        continue;
      }
      violations.push(...checked.violations);

      const candidate = scoreCandidate(
        id,
        variant,
        'candidate',
        checked.subject,
        checked.body,
        inputs,
        modelLabel,
        produced.durationMs,
      );
      candidates.push(candidate);
      progress(
        `  ${id}: ${candidate.score.total}/100, ${candidate.score.words} words, ` +
          `${candidate.score.blockers.length} blockers (${Math.round(produced.durationMs / 1000)}s)`,
      );

      const best = survivors.get(variant.id);
      if (!best || compareByQuality(candidate.score, best.score) < 0) survivors.set(variant.id, candidate);
    }
  }

  if (survivors.size === 0) {
    logger.warn('outreach_draft_loop_empty', { job: 'outreach', company: extracted.company });
    return { record: null, chosen: null, violations, reason: 'no_candidates' };
  }

  // ── One critic pass, over the survivors ───────────────────────────────────

  progress('critiquing…');
  const critique = await critiqueLetters(
    gate.model,
    extracted,
    [...survivors.values()].map((candidate) => ({
      id: candidate.id,
      body: candidate.body,
      score: candidate.score,
    })),
  );

  const reviewFor = new Map(critique.reviews.map((review) => [review.id, review]));
  for (const review of critique.reviews) {
    progress(`  ${review.id}: ${review.generic ? 'generic' : 'specific'}, ${review.notes.length} notes`);
  }
  if (critique.reason) progress(`  critic unavailable (${critique.reason}); revising on the rubric alone`);

  // ── At most two revisions, then stop ──────────────────────────────────────

  for (let round = 1; round <= revisionRounds; round += 1) {
    let asked = false;

    for (const variant of variants) {
      const current = survivors.get(variant.id);
      if (!current) continue;

      // The critic ran once, on the round-one survivor. Later rounds carry its
      // verdict forward and pair it with a *freshly computed* rubric on the
      // revision, which is what stops round two repeating round one's
      // instructions verbatim. The critic is never re-run: a judge asked twice
      // about text it has just influenced is measuring its own echo.
      const instructions = revisionInstructions(current.score, reviewFor.get(current.id));
      if (instructions.length === 0) continue;

      asked = true;
      const id = `${current.id}r${round}`;
      progress(`revising ${current.id} → ${id}…`);

      const produced = await generateCandidate(gate.model, inputs, variant, {
        body: current.body,
        instructions,
      });
      maxPromptChars = Math.max(maxPromptChars, produced.promptChars);
      if (produced.reason) {
        progress(`  ${id} failed: ${produced.reason}`);
        continue;
      }

      const checked = sanitizeCandidate(produced.subject, produced.body);
      if (!('subject' in checked)) {
        violations.push(...checked.violations);
        progress(`  ${id} refused by the sanitiser: ${checked.violations.map((v) => v.rule).join(', ')}`);
        continue;
      }
      violations.push(...checked.violations);

      const revised = scoreCandidate(
        id,
        variant,
        `revision-${round}`,
        checked.subject,
        checked.body,
        inputs,
        modelLabel,
        produced.durationMs,
      );
      candidates.push(revised);
      progress(
        `  ${id}: ${revised.score.total}/100, ${revised.score.words} words, ` +
          `${revised.score.blockers.length} blockers (${Math.round(produced.durationMs / 1000)}s)`,
      );

      // A revision that came back worse is thrown away and the original stands.
      // This is the whole reason every candidate is kept and scored: a model
      // told to fix four things can and does break a fifth, and without the
      // comparison the loop would hand over a letter worse than the one it
      // already had and call it an improvement.
      if (compareByQuality(revised.score, current.score) < 0) {
        survivors.set(variant.id, revised);
        // The critic's verdict travels with the letter it was about.
        const review = reviewFor.get(current.id);
        if (review) reviewFor.set(revised.id, { ...review, id: revised.id });
      } else {
        progress(`  ${id} did not improve on ${current.id}; keeping ${current.id}`);
      }
    }

    // Nothing left to ask for. Not a quality threshold — an empty instruction
    // list, which is a different thing and has a bound of its own.
    if (!asked) {
      progress('nothing left to revise');
      break;
    }
  }

  // ── The record ────────────────────────────────────────────────────────────

  const finalists = [...survivors.values()].sort((a, b) => compareByQuality(a.score, b.score));
  const chosen = finalists[0];

  const record: DraftRecord = {
    candidates,
    // Offered only when there is a genuine choice of register. One variant means
    // the rubric's pick stands unopposed, and presenting that as a "choice"
    // between a letter and nothing would be theatre.
    //
    // Ordered by **variant**, not by rank. The card renders them in this order,
    // so ranking them would put the rubric's winner on the left every single
    // time — and the entire reason this control exists is that the rubric cannot
    // tell which of two clean letters sounds like Davit. Pre-answering the
    // question with position is a quieter way of pre-answering it than
    // pre-selecting one. The rubric's pick is still labelled on the card.
    offered:
      finalists.length > 1
        ? variants
            .map((variant) => survivors.get(variant.id)?.id)
            .filter((id): id is string => Boolean(id))
        : [],
    chosenId: chosen.id,
    chosenBy: 'rubric',
    critique: critique.reviews
      .map((review) => `${review.id}: ${review.generic ? 'generic' : 'specific'}${review.notes.length ? ` — ${review.notes.join(' ')}` : ''}`)
      .join('\n'),
    startedAt,
    durationMs: Date.now() - started,
  };

  logger.info('outreach_draft_loop', {
    job: 'outreach',
    company: extracted.company,
    title: extracted.title,
    model: gate.model.model,
    variants: variants.map((variant) => variant.id).join(','),
    candidates: candidates.length,
    chosen: chosen.id,
    chosenScore: chosen.score.total,
    // The spread is the number that says whether the loop is earning its
    // minutes: if the worst candidate scores what the best one does, best-of-N
    // is buying nothing and `OUTREACH_DRAFT_CANDIDATES=1` is the honest setting.
    spread: candidates.length
      ? Math.max(...candidates.map((c) => c.score.total)) - Math.min(...candidates.map((c) => c.score.total))
      : 0,
    blockers: chosen.score.blockers.length,
    // The unmeasured budget in §23, made visible. Four characters to a token,
    // very roughly; compare against whatever `num_ctx` the Mac's Ollama is
    // actually using before `data/profile.md` grows again.
    maxPromptChars,
    durationMs: record.durationMs,
  });

  return { record, chosen, violations };
}
