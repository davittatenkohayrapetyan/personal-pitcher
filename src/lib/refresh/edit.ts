import type { ExtractedFacts, ProposedChange, SourceId, TargetFile, Violation } from './types';
import { LIMITS, sanitizeEditedText } from './sanitize';
import { parseJsonBlock, type RefreshModel } from './llm';
import { logger } from '../logger';

/**
 * Stage B — the model that decides what is missing from the profile.
 *
 * ## What makes this stage different
 *
 * Stage B never sees a byte of third-party text. Its entire view of the outside
 * world is the `ExtractedFacts` that stage A produced and `sanitize.ts` cleared:
 * three bounded fields, every URL stripped, every known instruction shape
 * refused, every claimed technology traced back to something the API actually
 * said. That is the whole reason the work is split across two calls rather than
 * done in one — a single model asked to both read a README and edit the profile
 * would be holding attacker-influenced text and write intent at the same moment.
 *
 * ## What it is allowed to change
 *
 * `description`, `tech` and `highlights`. Not `name`, not `url`, not `category`
 * — those are identity and taxonomy, they come from the adapter or from Davit,
 * and a model that can rewrite a project's URL is a model that can point a
 * portfolio entry somewhere else.
 *
 * Additive by default: the job's stated purpose is finding what is *missing*, and
 * a run that quietly deletes a hand-written highlight is a worse failure than
 * one that misses an update. `replace-value` on `description` is the single
 * exception, and it still lands in a proposal a human reads.
 */

const SYSTEM_PROMPT = `You are an editor maintaining a professional portfolio's project data. You are given the entry as it exists today, and verified facts about the same project gathered from its source of record.

Your job is to find what the existing entry is MISSING or has WRONG, and propose the smallest set of changes that fixes it.

Rules:
- Return ONLY a JSON object matching the required schema. No prose, no markdown.
- Propose a change only when the verified facts contain something the current entry does not. If the entry is already accurate and complete, return an empty changes array. An empty array is a good answer.
- Never invent. Every proposed value must be supported by the verified facts you were given.
- Match the existing entry's voice exactly: third person, concrete, factual, no marketing language, no superlatives, no exclamation marks.
- Highlights are single capabilities or outcomes, one clause each, no trailing period.
- Prefer adding to a list over rewriting it. Only propose replacing the description when the current one states something the verified facts contradict.
- Never include URLs, file paths, IP addresses, host names, ports, environment variable names, or credentials in any value.
- Every change needs a one-sentence reason naming which verified fact motivated it.

Where to put the new content, exactly:
- op "add-items" (for tech and highlights): put the new entries in the "items" array. Leave "value" out.
- op "replace-value" (for description only): put the new text in "value". Leave "items" out.`;

const EDIT_SCHEMA = {
  type: 'object',
  properties: {
    changes: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: ['description', 'tech', 'highlights'] },
          op: { type: 'string', enum: ['add-items', 'replace-value'] },
          value: { type: 'string', maxLength: LIMITS.summary },
          items: {
            type: 'array',
            maxItems: LIMITS.highlightCount,
            items: { type: 'string', maxLength: LIMITS.highlightItem },
          },
          reason: { type: 'string', maxLength: LIMITS.reason },
        },
        required: ['field', 'op', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['changes'],
  additionalProperties: false,
} as const;

/** The shape of an existing `data/projects.json` entry, as far as this file cares. */
export interface ProfileEntry {
  name: string;
  description: string;
  tech: string[];
  highlights: string[];
}

interface RawChange {
  field?: unknown;
  op?: unknown;
  value?: unknown;
  items?: unknown;
  reason?: unknown;
}

function buildPrompt(entry: ProfileEntry, facts: ExtractedFacts, toneExamples: string[]): string {
  return [
    'CURRENT ENTRY (as published today):',
    `name: ${entry.name}`,
    `description: ${entry.description}`,
    `tech: ${entry.tech.join(', ')}`,
    'highlights:',
    ...entry.highlights.map((h) => `  - ${h}`),
    '',
    'VERIFIED FACTS from the source of record:',
    `summary: ${facts.summary}`,
    `tech: ${facts.tech.join(', ')}`,
    'highlights:',
    ...facts.highlights.map((h) => `  - ${h}`),
    '',
    'VOICE REFERENCE — other entries in this profile, for tone only. Do not copy their content:',
    ...toneExamples.map((t) => `  - ${t}`),
    '',
    'Return JSON: { "changes": [...] }. Return an empty array if nothing is missing.',
  ].join('\n');
}

/**
 * Case-, punctuation- and version-insensitive membership.
 *
 * "Spring Boot" against an existing "spring-boot" is a duplicate, and so is
 * "Next.js" against "Next.js 16" — `projects.json` pins versions by hand and the
 * API does not, so without the version fold the model proposes the unversioned
 * name on *every* run, forever. A report that repeats itself weekly is a report
 * nobody reads, which costs more than the occasional missed addition.
 *
 * Only trailing version tokens are stripped, deliberately. General substring
 * matching would be the obvious generalisation and it is wrong: folded "java" is
 * a substring of "javascript", so it would silently suppress a real technology.
 */
function alreadyPresent(existing: string[], candidate: string): boolean {
  const fold = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .replace(/v?\d+$/, '');

  const folded = fold(candidate);
  return existing.some((item) => fold(item) === folded);
}

export interface EditResult {
  changes: ProposedChange[];
  violations: Violation[];
}

/**
 * Asks stage B what the entry at `path` is missing, and validates the answer.
 *
 * Every returned string is re-sanitised even though stage B only saw sanitised
 * input. That is not belt-and-braces for its own sake: if stage A's output were
 * ever widened, or a rule there regressed, this is the check that still stands
 * between a crafted string and `data/`.
 */
export async function proposeEdits(
  model: RefreshModel,
  args: {
    source: SourceId;
    target: TargetFile;
    path: string;
    /** Stamped onto every change so `sourceState.ts` can tell which repo is outstanding. */
    subjectKey?: string;
    entry: ProfileEntry;
    facts: ExtractedFacts;
    toneExamples: string[];
  },
): Promise<EditResult> {
  const changes: ProposedChange[] = [];
  const violations: Violation[] = [];

  let raw: string;
  try {
    raw = await model.generate(
      SYSTEM_PROMPT,
      buildPrompt(args.entry, args.facts, args.toneExamples),
      EDIT_SCHEMA,
    );
  } catch (err) {
    return {
      changes,
      violations: [
        {
          stage: 'edit',
          field: args.path,
          rule: 'model-call-failed',
          detail: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }

  const parsed = parseJsonBlock(raw);
  const list = (parsed as { changes?: unknown } | null)?.changes;

  if (!Array.isArray(list)) {
    return {
      changes,
      violations: [
        { stage: 'edit', field: args.path, rule: 'unparseable-json', detail: raw.slice(0, 120) },
      ],
    };
  }

  for (const item of list as RawChange[]) {
    const field = item.field;
    const op = item.op;

    if (field !== 'description' && field !== 'tech' && field !== 'highlights') {
      violations.push({ stage: 'edit', field: args.path, rule: 'field-not-editable', detail: String(field) });
      continue;
    }
    if (op !== 'add-items' && op !== 'replace-value') {
      violations.push({ stage: 'edit', field: args.path, rule: 'op-not-allowed', detail: String(op) });
      continue;
    }
    // `description` is a single string and the lists are lists. A mismatch is a
    // confused model, and applying it would silently corrupt the file's shape.
    if ((field === 'description') !== (op === 'replace-value')) {
      violations.push({
        stage: 'edit',
        field: `${args.path}.${field}`,
        rule: 'op-field-mismatch',
        detail: `${op} on ${field}`,
      });
      continue;
    }

    const reason = sanitizeEditedText(`${args.path}.reason`, item.reason, LIMITS.reason);
    violations.push(...reason.violations);
    if (!reason.ok || !reason.value) continue;

    if (op === 'replace-value') {
      const value = sanitizeEditedText(`${args.path}.description`, item.value, LIMITS.summary);
      violations.push(...value.violations);
      if (!value.ok || !value.value) continue;
      if (value.value === args.entry.description) continue;

      changes.push({
        target: args.target,
        path: `${args.path}.description`,
        op: 'replace-value',
        before: args.entry.description,
        after: value.value,
        reason: reason.value,
        source: args.source,
        subjectKey: args.subjectKey,
      });
      continue;
    }

    // Unreachable given the XOR check above, but TypeScript cannot follow that
    // inference and the alternative is a cast — which would also silence a real
    // bug if the check above were ever loosened.
    if (field === 'description') continue;

    // A model that puts a single addition in `value` instead of `items` is
    // using the wrong field, not proposing something dangerous — and dropping
    // the change loses a legitimate proposal for a formatting slip. Coerced
    // rather than rejected; the value still goes through `sanitizeEditedText`
    // below, so this loosens the *shape* check and nothing else.
    const rawItems = Array.isArray(item.items)
      ? item.items
      : typeof item.value === 'string' && item.value.trim()
        ? [item.value]
        : null;

    if (rawItems === null) {
      violations.push({
        stage: 'edit',
        field: `${args.path}.${field}`,
        rule: 'not-an-array',
        detail: typeof item.items,
      });
      continue;
    }

    const existing = args.entry[field];
    const maxLength = field === 'tech' ? LIMITS.techItem : LIMITS.highlightItem;
    const accepted: string[] = [];

    for (const candidate of rawItems) {
      const checked = sanitizeEditedText(`${args.path}.${field}[]`, candidate, maxLength);
      violations.push(...checked.violations);
      if (!checked.ok || !checked.value) continue;
      if (alreadyPresent(existing, checked.value)) continue;
      if (alreadyPresent(accepted, checked.value)) continue;
      accepted.push(checked.value);
    }

    if (accepted.length === 0) continue;

    changes.push({
      target: args.target,
      path: `${args.path}.${field}`,
      op: 'add-items',
      after: accepted,
      reason: reason.value,
      source: args.source,
      subjectKey: args.subjectKey,
    });
  }

  if (violations.length > 0) {
    logger.warn('refresh_edit_violations', {
      path: args.path,
      rules: violations.map((v) => v.rule),
    });
  }

  return { changes, violations };
}
