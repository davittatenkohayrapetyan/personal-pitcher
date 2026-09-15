import { loadProfileContext } from './profile/loader';
import { matchAllIntents, type Intent } from './classify';
import type { ProfileContext } from '@/types';

let cachedContext: ProfileContext | null = null;

function getContext(): ProfileContext {
  if (!cachedContext) {
    cachedContext = loadProfileContext();
  }
  return cachedContext;
}

/**
 * Drops the cached profile so the next question re-reads `data/` from disk.
 *
 * Called by the admin review UI after it writes an approved change. Without it,
 * an approval would update the files and change nothing a visitor could observe
 * until the process restarted — the cache exists because `data/` was immutable
 * at runtime, and the review UI is what made that stop being true.
 *
 * Note this only reaches the *assistant*. The explore cards under
 * `src/components/cards/` import their JSON statically, so those are fixed at
 * build time and still need a rebuild. See `docs/profile-refresh-plan.md`.
 */
export function invalidateProfileCache(): void {
  cachedContext = null;
}

/** Section content plus the heading `retrieveContext` prints above it. */
const SECTION_BLOCKS: Partial<Record<Intent, { heading: string; body: (ctx: ProfileContext) => string }>> = {
  projects: { heading: 'Projects', body: (ctx) => ctx.projects },
  community: { heading: 'Community Work', body: (ctx) => ctx.community },
  hobbies: { heading: 'Personal Interests', body: (ctx) => ctx.hobbies },
  music: { heading: 'Music', body: (ctx) => ctx.music },
  site: { heading: 'About This Website', body: (ctx) => ctx.site },
};

const EVERYTHING_SECTIONS: Intent[] = ['projects', 'community', 'hobbies', 'music', 'site'];

function buildFullBundle(ctx: ProfileContext): string {
  return [
    ctx.bio,
    ...EVERYTHING_SECTIONS.map((s) => `## ${SECTION_BLOCKS[s]!.heading}\n${SECTION_BLOCKS[s]!.body(ctx)}`),
  ].join('\n\n');
}

/** Sections beyond this are cheaper (and just as complete) to answer from the
 *  full bundle than to keep unioning individually. */
const MAX_UNIONED_SECTIONS = 3;

/**
 * Retrieves the profile content relevant to a question.
 *
 * Previously this switched on the single classified `intent` and returned
 * exactly one section — a question spanning two topics ("his projects and his
 * music") only ever got whichever one the classifier happened to pick. Now the
 * primary intent is unioned with every section `matchAllIntents` finds
 * keyword evidence for in the raw question, so multi-topic questions pull in
 * more than one file's worth of content. `question` is optional so existing
 * callers that only have an intent (e.g. the off-topic short-circuit, which
 * never reaches this function) aren't forced to thread one through.
 */
export function retrieveContext(intent: Intent, question = ''): { text: string; sections: Intent[] } {
  const ctx = getContext();

  if (intent === 'general') {
    return { text: buildFullBundle(ctx), sections: EVERYTHING_SECTIONS };
  }

  // 'background' and 'contact' have no dedicated section of their own — both
  // are answered from `bio` — but the question can still raise other topics
  // worth unioning in (e.g. "what's Davit's GitHub, and what has he built?").
  const matched = matchAllIntents(question);
  const sections = Array.from(
    new Set([intent, ...matched].filter((i): i is Intent => i in SECTION_BLOCKS)),
  );

  if (sections.length === 0) {
    return { text: ctx.bio, sections: [] };
  }

  if (sections.length > MAX_UNIONED_SECTIONS) {
    return { text: buildFullBundle(ctx), sections: EVERYTHING_SECTIONS };
  }

  const text = [
    ctx.bio,
    ...sections.map((s) => `## ${SECTION_BLOCKS[s]!.heading}\n${SECTION_BLOCKS[s]!.body(ctx)}`),
  ].join('\n\n');

  return { text, sections };
}
