import type { ExtractedPosting } from './types';
import { disclosureLine } from './config';

/**
 * The quality bar for a drafted letter, with no model anywhere in it (§7).
 *
 * ## Why this exists, and why it is not a model
 *
 * The obvious way to grade a letter is to ask a model. This repo's only model
 * is the one that wrote it, and **a same-model judge is weak**: `gemma4:26b`
 * grading its own output rewards the thing it is already good at — fluency —
 * and forgives its own failure modes, because the generator and the judge share
 * a prior about what a good sentence looks like. Ask it "is this needy?" and it
 * will say no about a letter that opens "I would be thrilled", because that
 * sentence is well formed and on topic. The failure is not in the judge's
 * reasoning; it is that the judge and the author are the same thing, so there
 * is no second opinion in the room.
 *
 * There is a second, blunter reason. **A model judge cannot be fixtured.** You
 * cannot hand it a hand-written bad letter, assert that it scores 40, and have
 * that assertion still hold next week — the same call returns a different
 * number, and a "quality bar" that moves on its own is a vibe with a number
 * printed next to it. This module can be fixtured, and
 * `npm run outreach -- --rubric-fixtures` is that fixture: hand-written good and
 * bad letters with asserted scores, the same drill `--policy-fixtures` is for
 * §7's categorical rules.
 *
 * So the split is: **rules carry everything a rule can carry**, and the one
 * model critic (`critic.ts`) is asked only the question no rule can answer —
 * is this argument about *this* posting, or is it generic? It is handed this
 * rubric's findings rather than asked for "feedback", precisely so it does not
 * spend its one pass re-deciding things already decided here.
 *
 * ## The disclosure line is not scored
 *
 * `config.ts`'s `disclosureLine()` is Davit's own wording, appended by code in
 * `draft.ts` and never asked of the model (§7, §23). It is therefore not the
 * model's prose and must not be judged as if it were: it is stripped before
 * anything below counts a word, a paragraph or a tone marker. Left in, it would
 * spend about 35 of the letter's 250-word budget, and "there is more about my
 * work ... on the site" reads to a needy-marker regex exactly like the thing the
 * needy-marker regex is for.
 *
 * Its presence is reported (`disclosurePresent`) and not scored. Candidates
 * inside the best-of-N loop have not had it appended yet, so scoring it would
 * mark every one of them down for the absence of a line they are not allowed to
 * write.
 *
 * ## What a score is and is not
 *
 * `total` is 0–100, weighted across the categories below. It is an *ordering*
 * device — it exists so best-of-N can pick a survivor and so "why is this the
 * letter?" has an answer — and not a grade to chase. Nothing here loops until
 * the number is high enough; `draftLoop.ts` has a hard ceiling on revisions for
 * that reason.
 *
 * `blockers` is the separate, harder signal: a letter with a placeholder in it
 * or a claim traceable to nothing is not a slightly worse letter, it is one that
 * cannot be sent. Ranking puts blocker count ahead of score, so a fluent letter
 * that invents an employer never beats a plainer one that does not.
 */

// ─── Shape ───────────────────────────────────────────────────────────

export type RubricCategoryId =
  | 'grounding'
  | 'requirements'
  | 'needy'
  | 'oversell'
  | 'length'
  | 'paragraphs'
  | 'placeholders'
  | 'markdown'
  | 'signoff'
  | 'money';

export interface RubricCategory {
  id: RubricCategoryId;
  /** 0–100 within the category. */
  score: number;
  /** Share of `total`. The weights sum to 100. */
  weight: number;
  /** What was found, in words a person can act on. The critic is given these. */
  findings: string[];
}

export interface RubricScore {
  /** 0–100, weighted. An ordering device, not a grade. */
  total: number;
  categories: RubricCategory[];
  /**
   * Findings that make a letter unsendable rather than merely worse — a
   * placeholder, markdown, a sign-off block, or a claim grounded in nothing.
   * Ranked ahead of `total`, so fluency can never outrank truthfulness.
   */
  blockers: string[];
  /** Words in the body, disclosure line excluded. §7 wants 150–250. */
  words: number;
  /** Informational. Never scored — see the header. */
  disclosurePresent: boolean;
}

/**
 * The weights, in one place because the argument for them is a single argument.
 *
 * Grounding and requirements are half the score between them, and that is the
 * whole thesis of §7: a letter is worth reading because it is *checkable* and
 * because it is about *this job*. The tone pair is the next thirty, because
 * needy and oversell are the two ways a checkable, on-topic letter still fails
 * to get a reply. The mechanical four are small on purpose — they are cheap to
 * fix and they are `blockers` anyway, so their real weight is in the ranking
 * rather than in the number.
 */
const WEIGHTS: Record<RubricCategoryId, number> = {
  grounding: 25,
  requirements: 20,
  needy: 13,
  oversell: 13,
  length: 10,
  paragraphs: 5,
  placeholders: 4,
  markdown: 4,
  money: 4,
  signoff: 2,
};

// ─── §7's actual phrasings ───────────────────────────────────────────

/**
 * Needy markers.
 *
 * The first five are §7's own examples, quoted from the plan rather than
 * invented here — "I would love the opportunity", "I hope to hear from you",
 * thanking someone in advance for their time, "I believe I could bring value
 * to", "I feel I would be a good fit". The rest are the same register: a
 * sentence that asks for something rather than stating something.
 *
 * §7's argument for why this is the expensive failure mode and not a style
 * preference: neediness is what costs a reply. A hiring manager reading "I would
 * be grateful for the chance" has learned nothing about the candidate and quite
 * a lot about how the candidate expects the exchange to go.
 *
 * Matched case-insensitively against whitespace-folded text, so a line break in
 * the middle of a phrase does not hide it.
 */
const NEEDY_MARKERS: string[] = [
  // §7, verbatim
  'i would love',
  "i'd love",
  'i hope to hear',
  'hoping to hear',
  'thank you for your time',
  'thanks for your time',
  'thank you in advance',
  'thanks in advance',
  'i believe i could bring',
  'i feel i would be a good fit',
  'i believe i would be a good fit',
  // the same register
  'i am excited',
  "i'm excited",
  'i am thrilled',
  "i'm thrilled",
  'i would be thrilled',
  'i would be grateful',
  'dream role',
  'dream job',
  'please consider me',
  'i would appreciate',
  'if given the chance',
  'if given the opportunity',
  'looking forward to hearing',
  'i look forward to hearing',
  'i hope this finds you',
  'i would welcome the chance',
  'i would welcome the opportunity',
  'any consideration',
  'take a chance on me',
  'i know i can',
  'give me the opportunity',
];

/**
 * Oversell markers.
 *
 * §7 names "world-class", "expert" and "perfect fit" and gives the reason that
 * generalises: *these are not facts about anyone*. They cannot be traced to a
 * line in `data/profile.md`, which is the same rule that forbids inventing an
 * employer, applied to adjectives. A number that is in the profile is worth more
 * than every word on this list — "p95 under 500 ms at 100,000 requests a minute"
 * is a sentence a hiring manager can check, and "highly performant systems" is
 * one they have read four hundred times.
 *
 * `expert` is matched as a word so that "expertise" does not trip it; the noun
 * describing a field is not the same claim as the label applied to a person.
 */
const OVERSELL_MARKERS: string[] = [
  // §7, verbatim
  'world-class',
  'world class',
  'perfect fit',
  'proven track record',
  'passionate',
  // the same register: a label rather than an event
  'best-in-class',
  'best in class',
  'cutting-edge',
  'cutting edge',
  'bleeding-edge',
  'unparalleled',
  'second to none',
  'top-tier',
  'top tier',
  'rock star',
  'rockstar',
  'ninja',
  'guru',
  'wizard',
  'exceptional ability',
  'unmatched',
  'the ideal candidate',
  'ideally suited',
  'seasoned professional',
  'highly skilled',
  'highly motivated',
  'extremely experienced',
  'deep expertise in everything',
  'i am the best',
  'no one better',
];

/** Word-boundary cases, kept separate so "expertise" and "experts" do not trip. */
const OVERSELL_WORDS: string[] = ['expert', 'experts', 'guru', 'visionary', 'legendary', 'flawless'];

/** §7: "no signature block, no 'Best regards' sign-off". */
const SIGNOFF_MARKERS: string[] = [
  'best regards',
  'kind regards',
  'warm regards',
  'regards,',
  'sincerely',
  'yours truly',
  'yours faithfully',
  'cheers,',
  'many thanks,',
  'respectfully,',
];

/**
 * Words that start an English sentence and are not a company or a technology.
 *
 * This list is the whole reason the grounding check can look at capitalised
 * tokens at all. Without it, every sentence in the letter contributes its first
 * word as an "entity" and the check reports "The", "Recently" and "Over" as
 * ungrounded claims — which is worse than not checking, because a check that
 * cries wolf gets switched off.
 *
 * It is deliberately long and deliberately boring, and the fixture file is
 * where a gap in it gets found: a good letter that the rubric marks down for an
 * ungrounded "Their" is a bug in this list, not in the letter.
 */
const CAPITALISED_STOPWORDS = new Set(
  (
    'a an and as at after also all although am among any are around at back be because been before ' +
    'being besides beyond both but by can could currently despite did do does doing done down during ' +
    'each either else even every everything few first for from further given had has have having he ' +
    'hello her here hers him his how however i if in include including instead into is it its just ' +
    'last later lately least less let like likely made make many may maybe me more moreover most much ' +
    'must my near neither never next no nor not nothing now of off often on once one only or other ' +
    'others otherwise our out over own part per perhaps plus previously prior rather really recently ' +
    'right same several she since so some something still such team than that the their them then ' +
    'there these they this those though three through throughout thus to today together too two under ' +
    'unless until up upon us very was we well were what when where whether which while who whose why ' +
    'will with within without work working would yes yet you your yours ' +
    'dear hi hello subject re building leading built led writing wrote applying happy glad ' +
    // Currency codes. A figure of money is `money`'s business, and reporting
    // "USD" as an invented employer on top of it is the same double-count that
    // had `[Hiring Manager]` arriving as both a placeholder and a fabrication.
    'usd eur gbp amd chf sek nok pln czk rub try inr cad aud jpy cny'
  ).split(' '),
);

// ─── Text handling ───────────────────────────────────────────────────

/**
 * Removes the fixed disclosure line before anything is counted.
 *
 * Exact match first, because that is what `draft.ts` appends and what a
 * round-tripped draft still carries.
 *
 * The fallback exists because the wording has already changed once: two drafts
 * written before commit `ccc4dd1` are sitting in `pending.json` right now
 * carrying the *superseded* line — "P.S. I drafted this with Personal Pitcher,
 * an application assistant I built and run on my own hardware …" — which §23
 * records as the overreach Davit rejected. Matching only the current phrasing
 * left those two being scored as though thirty words of disclosure were the
 * model's argument, which is exactly what this function exists to prevent.
 *
 * It needs the site URL **and** a marker that the block is a claim about how the
 * letter was made. The URL alone is not enough, and a fixture proved it on the
 * first run: the markdown case ends "More at [my site](https://davithayrapetyan.dev)",
 * which is ordinary content, and stripping it silently hid a real markdown
 * blocker. A disclosure says who wrote the thing; a link says where to read more.
 */
/** What makes a trailing block a claim about authorship rather than content. */
const DISCLOSURE_MARKERS = ['davo', 'personal pitcher', 'drafted this', 'generated by'];

export function stripDisclosure(body: string): { body: string; present: boolean } {
  const trimmed = body.trim();
  const line = disclosureLine().trim();

  if (line && trimmed.endsWith(line)) {
    return { body: trimmed.slice(0, trimmed.length - line.length).trim(), present: true };
  }

  const blocks = trimmed.split(/\n\s*\n/);
  const lastBlock = (blocks[blocks.length - 1] ?? '').toLowerCase();
  const claimsAuthorship = DISCLOSURE_MARKERS.some((marker) => lastBlock.includes(marker));

  if (blocks.length > 1 && lastBlock.includes('davithayrapetyan.dev') && claimsAuthorship) {
    return { body: blocks.slice(0, -1).join('\n\n').trim(), present: true };
  }

  return { body: trimmed, present: false };
}

/**
 * What the grounding check reads: the letter with its non-prose removed.
 *
 * A placeholder is an unfilled slot, a markdown link is syntax and a URL is an
 * address. None of them is a claim about Davit, and all three have their own
 * category already — so leaving them in meant `[Hiring Manager]` was counted
 * once as a placeholder and again as an invented employer, and one bad letter
 * arrived with six blockers describing three problems. The fixtures found it.
 */
function claimText(body: string): string {
  return body
    .replace(/\[[^\]\n]*\]\([^)\n]*\)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\[[^\]\n]*\]/g, ' ')
    .replace(/\{\{[^}\n]*\}\}/g, ' ')
    .replace(/<[^>\n]*>/g, ' ')
    .replace(/\b(TBD|TODO|XXX|FIXME|INSERT)\b/g, ' ');
}

/** Case- and whitespace-blind, so a phrase broken across a line still matches. */
function flatten(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ');
}

/** The fold `filterUngrounded` uses: case, spacing and punctuation blind. */
function fold(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function countWords(text: string): number {
  const cleaned = text.trim();
  return cleaned ? cleaned.split(/\s+/).length : 0;
}

/**
 * Capitalised and acronym-shaped runs, which is as close to "employer or
 * technology" as a rule can get.
 *
 * Adjacent capitalised tokens are joined, so "Grid Dynamics" and "Raymond
 * James" are one entity rather than two halves that each fail on their own. A
 * token keeps `+`, `#` and `.` because `C++`, `C#` and `Node.js` are how those
 * are written, and a trailing `.` is stripped so a sentence-final "Kafka."
 * matches "Kafka".
 *
 * **A capitalised word that opens a sentence is not counted**, unless it is part
 * of a longer capitalised run or is shaped like a technology (a digit, a `.`,
 * a `+`, a `#`, or all caps). Without that rule this check is unusable, and the
 * fixtures proved it on the first run: "Keeping those figures true", "Thank you
 * in advance", "Whatever the pipeline needs" and "Best regards" were all
 * reported as invented employers, which would have made the loop reject two
 * hand-written good letters. A grounding check that cries wolf is one somebody
 * switches off, and then nothing is checking for invented employers at all.
 *
 * Two things it therefore misses, stated plainly rather than discovered later:
 *
 * - **A technology written in lower case.** "we used kafka" is not reported. The
 *   alternative is a hand-maintained technology lexicon, which is a second list
 *   to keep in sync with reality and which fails on exactly the technology
 *   nobody thought of. A letter drafted by this system writes proper nouns as
 *   proper nouns.
 * - **A single invented name opening a sentence.** "Netflix taught me to ..." is
 *   missed where "At Netflix I learned ..." is caught. This is the cost of the
 *   rule above, paid deliberately: a false positive rejects a good letter
 *   silently, while this false negative still faces the critic pass and a human
 *   reading the card before anything is sent.
 */
export function namedEntities(text: string): string[] {
  const entities: string[] = [];
  let run: { token: string; opensSentence: boolean }[] = [];
  let sentenceStart = true;

  /**
   * Strips punctuation, and a **lower-case hyphen suffix** with it.
   *
   * "Java-based", "AI-driven" and "GPU-accelerated" are claims about Java, AI
   * and GPUs with an English participle bolted on, and folding them whole
   * produced `javabased`, which is in no profile ever written. All three were
   * reported as invented technologies in real stored drafts. A hyphenated part
   * that is itself capitalised — `Grid-Dynamics` — is kept, because that is a
   * name rather than a modifier.
   */
  const cleanToken = (part: string) =>
    part
      .replace(/^[^A-Za-z0-9]+/, '')
      .replace(/[^A-Za-z0-9+#.]+$/, '')
      .replace(/\.$/, '')
      .replace(/-[a-z]+$/, '');

  /** Shaped like a technology rather than like a word: `C++`, `Java17`, `AWS`. */
  const technical = (token: string) => /[0-9+#.]/.test(token) || /^[A-Z][A-Z0-9+#.]{1,}$/.test(token);

  const flush = () => {
    if (run.length === 1 && run[0].opensSentence && !technical(run[0].token)) {
      run = [];
      return;
    }
    if (run.length) entities.push(run.map((entry) => entry.token).join(' '));
    run = [];
  };

  // Split keeping the separators, because a newline starts a sentence just as
  // a full stop does and `split(/\s+/)` throws that away.
  for (const part of text.split(/(\s+)/)) {
    if (part === '') continue;

    if (/^\s+$/.test(part)) {
      if (part.includes('\n')) sentenceStart = true;
      continue;
    }

    const token = cleanToken(part);
    const opensSentence = sentenceStart;
    sentenceStart = /[.!?:;]["'\)\]]?$/.test(part);
    // A comma or a slash between two proper nouns means two names, not one. The
    // trailing-punctuation strip above erases the comma before the run can see
    // it, so "Kafka, Redis" became the entity "Kafka Redis" — grounded nowhere,
    // reported as an invented employer, and found by scoring a real stored draft.
    const separates = /[,;/]["'\)\]]?$/.test(part);

    const capitalised = /^[A-Z][A-Za-z0-9+#.-]*$/.test(token);
    const acronym = /^[A-Z][A-Z0-9+#.]+$/.test(token);

    if ((capitalised || acronym) && !CAPITALISED_STOPWORDS.has(token.toLowerCase())) {
      run.push({ token, opensSentence });
      if (separates) flush();
      continue;
    }

    flush();
  }

  flush();

  // A run of two or more is also worth checking as its parts: "Spring Boot" may
  // be grounded as a pair, but "Grid Dynamics Kafka" is three tokens the writer
  // happened to put in a row and only the pair is a real name.
  const expanded = new Set<string>();
  for (const entity of entities) {
    expanded.add(entity);
    const parts = entity.split(' ');
    if (parts.length > 1) for (const part of parts) expanded.add(part);
  }

  return [...expanded];
}

// ─── The categories ──────────────────────────────────────────────────

function markerCategory(
  id: 'needy' | 'oversell',
  flat: string,
  phrases: string[],
  words: string[] = [],
): RubricCategory {
  const findings: string[] = [];

  for (const phrase of phrases) {
    if (flat.includes(phrase)) findings.push(`"${phrase}"`);
  }

  for (const word of words) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(flat)) findings.push(`"${word}"`);
  }

  // Each hit costs a third of the category. Three markers in one letter is a
  // register problem rather than a slip, and a fourth tells you nothing new.
  const score = Math.max(0, 100 - findings.length * 34);
  return { id, score, weight: WEIGHTS[id], findings };
}

/**
 * Sign-off: one fact, not a tally.
 *
 * A letter ending "Best regards," matches both `best regards` and `regards,`,
 * and counting that as two problems is counting the same block twice — which
 * showed up in the fixtures as a single sign-off costing two blockers and
 * two-thirds of the category. There is either a sign-off block or there is not,
 * so this reports the first marker it finds and stops.
 */
function signoffCategory(flat: string): RubricCategory {
  const hit = SIGNOFF_MARKERS.find((marker) => flat.includes(marker));
  return {
    id: 'signoff',
    score: hit ? 0 : 100,
    weight: WEIGHTS.signoff,
    findings: hit ? [`"${hit}" — §7 asks for no signature block`] : [],
  };
}

/**
 * Every employer and technology named must appear in `data/profile.md`.
 *
 * Three outcomes rather than two, because the middle one is real and a
 * two-outcome check gets it wrong in whichever direction it rounds.
 *
 * - **Grounded in the profile.** The ordinary case, and fine.
 * - **Grounded only in the posting's stack or responsibilities.** The letter is
 *   *supposed* to name what the posting asks for (§7), so a technology from the
 *   posting's own stack is not a lie by appearing here. It is also exactly the
 *   shape of the lie we care about — "I have deep Rust experience", where the
 *   posting wants Rust and the profile has never heard of it. A rule cannot tell
 *   "you ask for Rust" from "I know Rust", so this is reported, weighted
 *   lightly, and named to the critic, which *can* read the sentence around it.
 * - **Grounded nowhere.** An employer or a technology that is in neither
 *   document is an invention, and it is a blocker.
 *
 * The posting's **company, title and office location count as fully grounded**,
 * not as the middle case. They are the letter's address rather than a claim
 * about the writer: every letter names the role it is answering, and a rubric
 * that charged for it would mark down all of them, including the good ones. The
 * middle case is only `stack` and `responsibilities`, which is where a claim of
 * experience can hide.
 */
function groundingCategory(body: string, profile: string, extracted: ExtractedPosting | null): {
  category: RubricCategory;
  blockers: string[];
} {
  // The letter's address: naming who it is to and which role is never a claim.
  const groundedCorpus = fold(
    [profile, extracted?.company ?? '', extracted?.title ?? '', extracted?.officeLocation ?? ''].join(' '),
  );
  // Claims territory: what the posting says it wants, which is the one place a
  // technology can be legitimately named and also falsely claimed.
  const postingCorpus = extracted ? fold([...extracted.stack, ...extracted.responsibilities].join(' ')) : '';

  const invented: string[] = [];
  const postingOnly: string[] = [];

  /** `grounded` | `posting` | `invented`, for one entity, ignoring its parts. */
  const classify = (entity: string): 'grounded' | 'posting' | 'invented' => {
    const folded = fold(entity);
    // One- and two-character folds are initials and noise, not claims.
    if (folded.length < 3) return 'grounded';
    if (groundedCorpus.includes(folded)) return 'grounded';
    if (postingCorpus.includes(folded)) return 'posting';
    return 'invented';
  };

  for (const entity of namedEntities(claimText(body))) {
    const verdict = classify(entity);
    if (verdict === 'grounded') continue;

    // A multi-word run whose every part is grounded on its own is a phrase the
    // writer composed out of real names, not an invented one — "Spring Boot
    // Kafka" is three things he has used, written in a row. Reporting it as an
    // invented employer is a false positive, and a false positive here is the
    // loop silently discarding a good letter.
    const parts = entity.split(' ');
    if (parts.length > 1 && parts.every((part) => classify(part) === 'grounded')) continue;

    if (verdict === 'posting') postingOnly.push(entity);
    else invented.push(entity);
  }

  const findings: string[] = [];
  for (const entity of invented) {
    findings.push(`"${entity}" appears in neither data/profile.md nor the posting`);
  }
  for (const entity of postingOnly) {
    findings.push(
      `"${entity}" is in the posting's requirements but not in the profile — check it is not claimed as experience`,
    );
  }

  const score = Math.max(0, 100 - invented.length * 50 - postingOnly.length * 10);

  return {
    category: { id: 'grounding', score, weight: WEIGHTS.grounding, findings },
    blockers: invented.map((entity) => `ungrounded: ${entity}`),
  };
}

/**
 * Does the letter name at least two concrete requirements from the posting?
 *
 * This is the "is it about this job" check that a rule *can* do, and it is
 * deliberately the weaker half of that question — it asks whether the posting's
 * own words are present, not whether the argument built from them is any good.
 * The second half is the critic's one job.
 *
 * A requirement counts as named when a distinctive token from it appears in the
 * letter. Distinctive means: longer than three characters, and not a word every
 * job posting on earth contains. Without that filter, "experience" and "team"
 * would match every requirement in every posting and the check would always
 * pass, which is the failure mode of every keyword metric ever written.
 */
function requirementsCategory(body: string, extracted: ExtractedPosting | null): RubricCategory {
  if (!extracted) {
    return {
      id: 'requirements',
      score: 0,
      weight: WEIGHTS.requirements,
      findings: ['no extracted posting to check against'],
    };
  }

  const haystack = fold(body);
  const matched: string[] = [];
  const missed: string[] = [];

  const items = [...extracted.stack, ...extracted.responsibilities];

  for (const item of items) {
    const tokens = item
      .toLowerCase()
      .split(/[^a-z0-9+#.]+/)
      .filter((token) => token.length > 3 && !REQUIREMENT_STOPWORDS.has(token));

    // A stack entry is often one word ("Kafka"), and one word is enough for it.
    // A responsibility sentence needs a distinctive word, not any word.
    const hit = tokens.some((token) => haystack.includes(fold(token)));
    if (hit) matched.push(item);
    else missed.push(item);
  }

  const findings: string[] = [];
  if (matched.length === 0) findings.push('names nothing the posting actually asks for');
  else if (matched.length === 1) findings.push(`names one requirement only: "${matched[0]}"`);

  if (matched.length >= 2 && missed.length) {
    findings.push(`names ${matched.length} of ${items.length} requirements`);
  }

  // Two is the bar §7 sets. Three or more is better but not proportionally
  // better: a letter that mentions eight requirements is a list, not an
  // argument.
  const score = matched.length === 0 ? 0 : matched.length === 1 ? 45 : matched.length === 2 ? 85 : 100;

  return { id: 'requirements', score, weight: WEIGHTS.requirements, findings };
}

/** Words that appear in every posting and therefore distinguish none of them. */
const REQUIREMENT_STOPWORDS = new Set(
  (
    'about above across after against along among another around because before behind being below ' +
    'between both building business collaborate collaboration company complex deliver delivering ' +
    'design designing develop developing development drive driving during ensure ensuring every ' +
    'excellent experience experienced from great have help helping high highly into join large ' +
    'lead leading learn level look looking make making manage managing more most must other others ' +
    'over own partner people platform position product products project projects provide quality ' +
    'role roles skills solution solutions some strong such support supporting system systems take ' +
    'team teams technical technology than that their them then there these they this those through ' +
    'together tools toward towards understand using variety very well what when where which while ' +
    'will with within without work working world years your'
  ).split(' '),
);

function lengthCategory(words: number): RubricCategory {
  const findings: string[] = [];
  let score = 100;

  // §7: 150-250 words. The band is the target; outside it the score falls off
  // linearly rather than cliff-edging, because a 262-word letter is not a
  // failure and a 90-word one is.
  if (words < 150) {
    score = Math.max(0, Math.round((words / 150) * 100));
    findings.push(`${words} words — §7 asks for 150–250`);
  } else if (words > 250) {
    score = Math.max(0, 100 - Math.round(((words - 250) / 150) * 100));
    findings.push(`${words} words — §7 asks for 150–250`);
  }

  return { id: 'length', score, weight: WEIGHTS.length, findings };
}

function paragraphsCategory(body: string): RubricCategory {
  const paragraphs = body.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  const findings: string[] = [];
  let score = 100;

  // §7: "four short paragraphs at most". One paragraph is the other failure —
  // a 200-word block with no breaks is a letter nobody finishes.
  if (paragraphs.length === 0) {
    score = 0;
    findings.push('empty');
  } else if (paragraphs.length === 1) {
    score = 40;
    findings.push('one unbroken block — §7 wants up to four short paragraphs');
  } else if (paragraphs.length > 4) {
    score = Math.max(0, 100 - (paragraphs.length - 4) * 30);
    findings.push(`${paragraphs.length} paragraphs — §7 allows four`);
  }

  return { id: 'paragraphs', score, weight: WEIGHTS.paragraphs, findings };
}

/**
 * Placeholders.
 *
 * The one failure that is unambiguously fatal and unambiguously detectable: a
 * letter reading "Dear [Hiring Manager]" tells the reader the whole pipeline in
 * one bracket. Square brackets, curly-brace templating and angle-bracket slots
 * all appear in the wild; so does a bare `TBD`.
 */
function placeholdersCategory(body: string): { category: RubricCategory; blockers: string[] } {
  const findings: string[] = [];

  // Markdown links first, or `[my site](https://…)` is reported as an unfilled
  // slot as well as as markdown. It is markdown; `markdownCategory` has it.
  const text = body.replace(/\[[^\]\n]+\]\([^)\n]+\)/g, ' ');

  const patterns: [RegExp, string][] = [
    [/\[[^\]\n]{1,60}\]/g, 'square-bracket placeholder'],
    [/\{\{[^}\n]{1,60}\}\}/g, 'templating placeholder'],
    [/<[A-Za-z][A-Za-z ._-]{1,40}>/g, 'angle-bracket placeholder'],
    [/\b(TBD|TODO|XXX|FIXME|INSERT)\b/g, 'unfilled marker'],
    [/\byour name\b/gi, 'literal "your name"'],
  ];

  for (const [pattern, label] of patterns) {
    const hits = text.match(pattern);
    if (hits) findings.push(`${label}: ${[...new Set(hits)].slice(0, 3).join(', ')}`);
  }

  const score = findings.length ? 0 : 100;
  return {
    category: { id: 'placeholders', score, weight: WEIGHTS.placeholders, findings },
    blockers: findings.map((finding) => `placeholder: ${finding}`),
  };
}

/**
 * Markdown.
 *
 * §7 asks for plain prose, and the reason is the medium rather than taste: this
 * goes out as an email body, where `**Staff Engineer**` arrives as literal
 * asterisks. Line-start patterns are anchored per line so that a hyphen inside a
 * sentence — "a well-run team" — is not read as a bullet.
 */
function markdownCategory(body: string): { category: RubricCategory; blockers: string[] } {
  const findings: string[] = [];
  const lines = body.split('\n');

  if (/\*\*[^*\n]+\*\*/.test(body)) findings.push('bold (**…**)');
  if (/(^|\s)_[^_\n]{2,}_(\s|$)/.test(body)) findings.push('underscore emphasis');
  if (/`[^`\n]+`/.test(body)) findings.push('backticks');
  if (lines.some((line) => /^\s*#{1,6}\s/.test(line))) findings.push('heading');
  if (lines.some((line) => /^\s*[-*+]\s+/.test(line))) findings.push('bullet list');
  if (lines.some((line) => /^\s*\d+[.)]\s+/.test(line))) findings.push('numbered list');
  if (/\[[^\]\n]+\]\([^)\n]+\)/.test(body)) findings.push('markdown link');

  const score = findings.length ? 0 : 100;
  return {
    category: { id: 'markdown', score, weight: WEIGHTS.markdown, findings },
    blockers: findings.map((finding) => `markdown: ${finding}`),
  };
}

/**
 * A figure of money, in any currency, anywhere in the letter.
 *
 * §5 is categorical: no salary figure may reach a drafting prompt, in any
 * currency, and §23 records the reason — *a number in a prompt is a number that
 * can be quoted back in a letter*. Everything upstream of this honours it:
 * `preferenceLines` omits the band, the comparison against it happens in code
 * rather than in a prompt, and `SYSTEM_PROMPT` tells the model not to mention
 * compensation.
 *
 * All of that is prompt-side, and the drafting loop opened a path around it.
 * `preferredLetters()` feeds a letter Davit picked into **every subsequent**
 * draft prompt as register reference, so a figure that got into one letter —
 * quoted out of a posting's published range, say, by way of `verdict.reasons` —
 * would become permanent input to every letter after it. A prompt instruction
 * cannot catch that; a rule can, and unlike the instruction it can be fixtured.
 *
 * Deliberately narrow, because the expensive direction is a false positive:
 * this profile is *full* of numbers that are the whole point of it — 100,000
 * requests per minute, p95 under 500 ms, Java 17. So a bare number never
 * matches. What matches is a number wearing a currency, or a number standing
 * next to a word about pay.
 *
 * The finding never quotes the matched text, which would put the figure into
 * the critic's prompt — the exact thing this category exists to prevent.
 */
const MONEY_PATTERNS: [RegExp, string][] = [
  [/[$€£₽₴¥]\s?\d/, 'a currency symbol before a number'],
  [/֏\s?\d|\d\s?֏/, 'an Armenian dram figure'],
  [/\b\d[\d,.\s]{0,12}\s?(?:k|m)?\s?(?:usd|eur|gbp|amd|dram|dollars?|euros?|pounds?)\b/i, 'a number with a currency'],
  [/\b(?:usd|eur|gbp|amd)\s?\d/i, 'a currency code before a number'],
  [
    /\b(?:salary|salaries|compensation|remuneration|day ?rate|hourly rate|annual salary|per annum)\b[^.\n]{0,40}?\d/i,
    'a pay word within a sentence of a number',
  ],
];

function moneyCategory(body: string): { category: RubricCategory; blockers: string[] } {
  // The first match and no more. "90,000 EUR to 120,000 EUR" trips three of the
  // patterns below, and reporting one sentence as three violations is the same
  // double-count `signoffCategory` had to correct: there is either a figure of
  // money in this letter or there is not.
  const hit = MONEY_PATTERNS.find(([pattern]) => pattern.test(body));
  const findings = hit ? [hit[1]] : [];

  const score = findings.length ? 0 : 100;
  return {
    category: { id: 'money', score, weight: WEIGHTS.money, findings },
    blockers: findings.map((finding) => `money: ${finding}`),
  };
}

/** True when a letter names a figure of money. The §5 guard, reusable. */
export function mentionsMoney(text: string): boolean {
  return MONEY_PATTERNS.some(([pattern]) => pattern.test(text));
}

// ─── The score ───────────────────────────────────────────────────────

export interface RubricInput {
  body: string;
  /** `data/profile.md`. The only permitted source of claims about Davit (§7). */
  profile: string;
  /** What the posting asked for. Null scores `requirements` at zero, honestly. */
  extracted: ExtractedPosting | null;
}

/**
 * Scores one candidate letter. Pure: no model, no clock, no filesystem.
 *
 * The subject line is deliberately not scored. It is a header with a length
 * limit, `sanitizeEditedField` already bounds it, and folding it into a prose
 * rubric would mean a letter's tone score moved because its subject was long.
 */
export function scoreLetter(input: RubricInput): RubricScore {
  const { body: prose, present } = stripDisclosure(input.body);
  const flat = flatten(prose);
  const words = countWords(prose);

  const grounding = groundingCategory(prose, input.profile, input.extracted);
  const placeholders = placeholdersCategory(prose);
  const markdown = markdownCategory(prose);
  const signoff = signoffCategory(flat);
  const money = moneyCategory(prose);

  const categories: RubricCategory[] = [
    grounding.category,
    requirementsCategory(prose, input.extracted),
    markerCategory('needy', flat, NEEDY_MARKERS),
    markerCategory('oversell', flat, OVERSELL_MARKERS, OVERSELL_WORDS),
    lengthCategory(words),
    paragraphsCategory(prose),
    placeholders.category,
    markdown.category,
    money.category,
    signoff,
  ];

  const total = Math.round(
    categories.reduce((sum, category) => sum + (category.score * category.weight) / 100, 0),
  );

  const blockers = [
    ...grounding.blockers,
    ...money.blockers,
    ...placeholders.blockers,
    ...markdown.blockers,
    ...signoff.findings.map((finding) => `sign-off: ${finding}`),
  ];

  return { total, categories, blockers, words, disclosurePresent: present };
}

/**
 * Ranking: blockers first, then score.
 *
 * Sorts ascending-by-badness, so `[0]` is the survivor. Blocker *count* rather
 * than presence, because when every candidate has one — a bad batch, which
 * happens — the loop still has to pick, and one problem is better than three.
 */
export function compareByQuality(a: RubricScore, b: RubricScore): number {
  if (a.blockers.length !== b.blockers.length) return a.blockers.length - b.blockers.length;
  return b.total - a.total;
}

/** One line per category, for a log, a card, or the critic's prompt. */
export function explainScore(score: RubricScore): string[] {
  const lines = [`total ${score.total}/100, ${score.words} words, ${score.blockers.length} blockers`];
  for (const category of score.categories) {
    if (category.score === 100 && category.findings.length === 0) continue;
    lines.push(`${category.id} ${category.score}/100: ${category.findings.join('; ') || 'below full marks'}`);
  }
  return lines;
}
