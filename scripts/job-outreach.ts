#!/usr/bin/env -S npx tsx
/**
 * Entry point for the scheduled job outreach run (08:00, §11).
 *
 *   npm run outreach -- --no-model      # adapters + geo filter, no Mac required
 *   npm run outreach -- --explain       # one line per posting with the rule that decided it
 *   npm run outreach -- --source=workday --company=nvidia
 *   npm run outreach -- --max=50
 *   npm run outreach -- --deadline=23:59 # wall clock, DISPLAY_TIMEZONE
 *   npm run outreach -- --no-cache      # refetch every feed, ignoring data/outreach/cache/
 *   npm run outreach -- --geo-fixtures  # the pure-function drill, no network at all
 *   npm run outreach -- --posting-fixtures # the stage A sanitiser, including the injection case
 *   npm run outreach -- --policy-fixtures  # section 7's categorical rules, with no model
 *   npm run outreach -- --rubric-fixtures  # hand-written letters against the drafting rubric
 *   npm run outreach -- --source-fixtures # every adapter's normaliser over a saved response
 *
 * Exit codes matter because a scheduler is the caller: 0 means the run
 * completed, with or without anything to show, and 1 means a source genuinely
 * failed. "Nothing was open this morning" is the normal outcome on most days
 * and must not look like an incident, or whoever reads the scheduler's history
 * learns to ignore it.
 */

import fs from 'fs';
import path from 'path';
import { runOutreach } from '../src/lib/outreach';
import { geoVerdict, type StructuredLocation } from '../src/lib/outreach/geo';
import { loadPreferences } from '../src/lib/outreach/preferences';
import { sanitizeExtractedPosting } from '../src/lib/outreach/sanitize';
import { applyStructured } from '../src/lib/outreach/extract';
import { applyPolicy } from '../src/lib/outreach/score';
import { compareByQuality, scoreLetter, type RubricCategoryId } from '../src/lib/outreach/rubric';
import { FIXTURE_DIR } from '../src/lib/outreach/config';
import { normaliseWorkday } from '../src/lib/outreach/sources/workday';
import { normalisePinpoint } from '../src/lib/outreach/sources/pinpoint';
import { normaliseGreenhouse } from '../src/lib/outreach/sources/greenhouse';
import { normaliseLever } from '../src/lib/outreach/sources/lever';
import { normaliseAshby } from '../src/lib/outreach/sources/ashby';
import {
  normaliseArbeitnow,
  normaliseHimalayas,
  normaliseRemoteOk,
  normaliseRemotive,
} from '../src/lib/outreach/sources/aggregators';
import type {
  ExtractedPosting,
  FitVerdict,
  RawPosting,
  SourceId,
  StopReason,
  WatchedCompany,
} from '../src/lib/outreach/types';
import type { Preferences } from '../src/lib/outreach/preferences';

/** The parts of an `ExtractedPosting` a policy case does not care about. */
const EMPTY_EXTRACTED: ExtractedPosting = {
  key: 'policy-fixture',
  title: '',
  company: 'Fixture Co',
  seniority: 'unclear',
  engagement: 'unclear',
  workMode: 'unclear',
  officeLocation: '',
  geoRestriction: '',
  timezoneRequirement: '',
  stack: [],
  responsibilities: [],
  compensation: '',
  applyMethod: 'unclear',
  applyTarget: '',
};

const EMPTY_VERDICT: FitVerdict = {
  eligibility: 'needs_check',
  eligibilityEvidence: '',
  fit: 0,
  reasons: [],
  flags: [],
  recommendation: 'surface_only',
};

/** Everything `applyPolicy` might read, so a fixture only states what it varies. */
const DEFAULT_PREFERENCES: Preferences = {
  present: true,
  localMonthlyAmd: null,
  remoteMonthlyUsdMin: null,
  remoteMonthlyUsdMax: null,
  workAuthorization: ['armenia'],
  noticePeriodDays: null,
  minSeniority: 'senior',
  draftSeniority: ['staff', 'principal', 'lead'],
  targetRoles: [],
  preferredStack: [],
  askFirst: [],
  never: [],
  notes: '',
};

/** The same four words the log uses, spelled out for a person reading a terminal. */
const STOP_REASONS: Record<StopReason, string> = {
  matches: 'matches — the queue filled before the deadline',
  deadline: 'deadline — the wall clock ran out',
  budget: 'budget — the duration budget ran out',
  cap: 'cap — OUTREACH_MAX_POSTINGS_PER_RUN was reached',
  exhausted: 'exhausted — every source was read',
};

/** Postings printed to the terminal. The report file holds every one of them. */
const PRINT_LIMIT = 20;

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function flagValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

interface PolicyCase {
  name: string;
  /** Only the fields `applyPolicy` reads; the rest of an `ExtractedPosting` is irrelevant to it. */
  extracted: Pick<ExtractedPosting, 'seniority' | 'title' | 'officeLocation' | 'geoRestriction'>;
  structured?: RawPosting['structured'];
  verdict: Pick<FitVerdict, 'recommendation' | 'eligibility' | 'fit' | 'flags'>;
  expect: { recommendation: FitVerdict['recommendation']; flags: string[] };
}

interface PostingCase {
  name: string;
  posting: RawPosting;
  /** What a model returned. Hand-written, including the hijacked ones. */
  model: Record<string, unknown>;
  expect: {
    ok: boolean;
    rules?: string[];
    /** Field-by-field expectations, plus `stackCount` for the grounding filter. */
    fields?: Record<string, unknown>;
  };
}

interface GeoCase {
  name: string;
  locationText: string;
  untrusted: string;
  /** What the adapter read directly, where the source states it as a field. */
  structured?: StructuredLocation;
  expect: { verdict: string; rule: string };
}

/**
 * The geo drill — the closest thing to a unit test this repo has.
 *
 * There is no test framework here, so the fixtures live in
 * `data/outreach/fixtures/geo.json` and this walks them. It touches no network
 * and needs no Mac, which means it can run on every change to `geo.ts` rather
 * than only when someone remembers. A mismatch exits 1.
 */
function runGeoFixtures(): number {
  const file = path.join(FIXTURE_DIR, 'geo.json');
  const { cases } = JSON.parse(fs.readFileSync(file, 'utf-8')) as { cases: GeoCase[] };

  let failures = 0;

  for (const testCase of cases) {
    const decision = geoVerdict(testCase.locationText, testCase.untrusted, testCase.structured);
    const ok =
      decision.verdict === testCase.expect.verdict && decision.rule === testCase.expect.rule;

    if (!ok) failures += 1;

    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'} ${testCase.name}\n` +
        `       expected ${testCase.expect.verdict}/${testCase.expect.rule}, ` +
        `got ${decision.verdict}/${decision.rule}` +
        (decision.evidence ? ` — "${decision.evidence}"` : ''),
    );
  }

  console.log('');
  console.log(`  ${cases.length - failures}/${cases.length} geo fixtures passed`);
  return failures;
}

/**
 * The adapter drill: every normaliser, over the response its board really sent.
 *
 * §19.2 asks for a saved response per adapter, and a fixture nothing runs is
 * decoration. This is what runs them. It exists because of a specific failure
 * mode that no amount of type-checking catches: an adapter written from a
 * board's documentation rather than from its output compiles perfectly, maps
 * `row.title` on a board whose title field is called `text`, and produces a run
 * that finds nothing while reporting no errors at all. Every posting must come
 * out with the four fields the rest of the system addresses it by.
 *
 * The fixtures are real responses, captured on 2026-09-14 and trimmed to a few
 * rows with long descriptions truncated. Rows were chosen to exercise the parts
 * of a mapping that a happy path would not: the Workday fixture includes a row
 * whose locations are hidden behind "2 Locations", the Pinpoint one includes
 * the Yerevan Sr. Java Engineer, the RemoteOK one keeps the legal notice at
 * index 0, and the Ashby one carries rows from two boards so that both a
 * published compensation range and the flag that withholds one appear.
 *
 * They are third-party job postings, so they stay under
 * `data/outreach/fixtures/` and out of the profile loader's explicit file list
 * — §19.8.
 */
function runSourceFixtures(): number {
  const company: WatchedCompany = {
    name: 'Fixture Company',
    ats: 'greenhouse',
    endpoint: 'https://example.invalid/jobs',
    careersUrl: 'https://example.invalid',
    workday: {
      origin: 'https://nvidia.wd5.myworkdayjobs.com',
      tenant: 'nvidia',
      site: 'NVIDIAExternalCareerSite',
    },
    addedAt: '2026-09-14',
    addedBy: 'seed',
  };

  // The row types are private to their adapters — deliberately, since nothing
  // outside one adapter should be writing against one board's field names. So
  // the drill reaches the rows through the envelope key and lets the
  // normaliser's own signature supply the element type.
  const rows = <T,>(payload: unknown, key?: string): T[] => {
    const value = key ? (payload as Record<string, unknown> | null)?.[key] : payload;
    return Array.isArray(value) ? (value as T[]) : [];
  };

  const drills: { source: SourceId; run: (payload: unknown) => RawPosting[] }[] = [
    { source: 'workday', run: (p) => normaliseWorkday(rows(p, 'jobPostings'), company) },
    { source: 'pinpoint', run: (p) => normalisePinpoint(rows(p, 'data'), company) },
    { source: 'greenhouse', run: (p) => normaliseGreenhouse(rows(p, 'jobs'), company) },
    { source: 'lever', run: (p) => normaliseLever(rows(p), company) },
    { source: 'ashby', run: (p) => normaliseAshby(rows(p, 'jobs'), company) },
    { source: 'remotive', run: (p) => normaliseRemotive(rows(p, 'jobs')) },
    { source: 'remoteok', run: (p) => normaliseRemoteOk(rows(p)) },
    { source: 'arbeitnow', run: (p) => normaliseArbeitnow(rows(p, 'data')) },
    { source: 'himalayas', run: (p) => normaliseHimalayas(rows(p, 'jobs')) },
  ];

  let failures = 0;

  for (const drill of drills) {
    const file = path.join(FIXTURE_DIR, `${drill.source}.json`);

    let postings: RawPosting[];
    try {
      postings = drill.run(JSON.parse(fs.readFileSync(file, 'utf-8')));
    } catch (err) {
      failures += 1;
      console.log(`  FAIL ${drill.source.padEnd(11)} ${err instanceof Error ? err.message : err}`);
      continue;
    }

    // An empty result is a failure, not a pass. `[].every()` is true, and a
    // normaliser that returns nothing would otherwise sail through every field
    // check below — the exact bug §20 warns about.
    const problems: string[] = [];
    if (postings.length === 0) problems.push('no postings');

    for (const posting of postings) {
      for (const field of ['key', 'company', 'title', 'url'] as const) {
        if (!posting[field]?.trim()) problems.push(`${field} empty for "${posting.title || posting.key}"`);
      }
    }

    if (problems.length > 0) failures += 1;

    const sample = postings[0];
    console.log(
      `  ${problems.length === 0 ? 'ok  ' : 'FAIL'} ${drill.source.padEnd(11)} ` +
        `${postings.length} posting(s)` +
        (sample ? ` — "${sample.title}" @ ${sample.locationText || 'no location'}` : ''),
    );
    for (const problem of problems) console.log(`         ${problem}`);
  }

  console.log('');
  console.log(`  ${drills.length - failures}/${drills.length} adapter fixtures passed`);
  return failures;
}

/**
 * The policy drill: §7's categorical rules, with no model anywhere near them.
 *
 * These are the rules that exist precisely because a model cannot be trusted to
 * apply them — a Yerevan role is never auto-drafted, nothing below the seniority
 * floor is queued — so checking them by watching a live run agree with them
 * would be checking the wrong thing. The local override in particular only
 * fires when a model has said `draft`, which in a fortnight of real mornings
 * might not happen at all.
 *
 * Preferences come from the fixture rather than from `private/job-preferences.md`:
 * that file is gitignored, holds real salary figures, and must not be something
 * a drill's output depends on (§5).
 */
function runPolicyFixtures(): number {
  const file = path.join(FIXTURE_DIR, 'policy.json');
  const fixture = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
    preferences: Partial<Preferences>;
    cases: PolicyCase[];
  };

  const preferences = { ...DEFAULT_PREFERENCES, ...fixture.preferences } as Preferences;
  let failures = 0;

  for (const testCase of fixture.cases) {
    const extracted = { ...EMPTY_EXTRACTED, ...testCase.extracted };
    const verdict = { ...EMPTY_VERDICT, ...testCase.verdict };
    const result = applyPolicy(verdict, extracted, preferences, testCase.structured);

    const problems: string[] = [];
    if (result.recommendation !== testCase.expect.recommendation) {
      problems.push(
        `expected ${testCase.expect.recommendation}, got ${result.recommendation}`,
      );
    }
    for (const flag of testCase.expect.flags) {
      if (!result.flags.includes(flag)) problems.push(`expected flag "${flag}"`);
    }
    // A flag nobody asked for is as wrong as a missing one: these chips are
    // what a person scans on a card.
    for (const flag of result.flags) {
      if (!testCase.expect.flags.includes(flag)) problems.push(`unexpected flag "${flag}"`);
    }

    if (problems.length > 0) failures += 1;

    console.log(
      `  ${problems.length === 0 ? 'ok  ' : 'FAIL'} ${testCase.name}
` +
        `       ${result.recommendation} [${result.flags.join(', ') || 'no flags'}]`,
    );
    for (const problem of problems) console.log(`       ${problem}`);
  }

  console.log('');
  console.log(`  ${fixture.cases.length - failures}/${fixture.cases.length} policy fixtures passed`);
  return failures;
}

/**
 * The sanitiser drill: what a model returned, against what the posting said.
 *
 * §19.2 asks for four hand-written postings and says the injection one "must
 * fail the whole record". This is where that is proved, and it is a pure
 * function over JSON — no Mac, no network, no tokens — so it can run on every
 * change to `sanitize.ts` rather than only when someone remembers.
 *
 * Each case carries the model's output as well as the posting, because the
 * thing under test is not the model: it is what happens to a *hijacked* one.
 * The injection case is the shape of the attack the whole pipeline is arranged
 * around — a posting instructing the extractor to redirect the application —
 * and two independent rules have to catch it.
 */
function runPostingFixtures(): number {
  const file = path.join(FIXTURE_DIR, 'postings.json');
  const { cases } = JSON.parse(fs.readFileSync(file, 'utf-8')) as { cases: PostingCase[] };

  let failures = 0;

  for (const testCase of cases) {
    const sanitised = sanitizeExtractedPosting(testCase.model, testCase.posting);
    // The structured override is part of what stage A produces, so the drill
    // runs it too — otherwise the one rule that most often changes an answer
    // (§4's "the adapter's value wins") would be the one rule untested.
    const result = {
      ...sanitised,
      value: sanitised.value ? applyStructured(sanitised.value, testCase.posting) : null,
    };
    const rules = result.violations.map((violation) => violation.rule);
    const problems: string[] = [];

    if (result.ok !== testCase.expect.ok) {
      problems.push(`expected ok=${testCase.expect.ok}, got ok=${result.ok}`);
    }

    for (const rule of testCase.expect.rules ?? []) {
      if (!rules.includes(rule)) problems.push(`expected rule "${rule}", got [${rules.join(', ')}]`);
    }

    for (const [field, expected] of Object.entries(testCase.expect.fields ?? {})) {
      const actual =
        field === 'stackCount' ? result.value?.stack.length : (result.value as never)?.[field];
      if (actual !== expected) {
        problems.push(`${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    }

    if (problems.length > 0) failures += 1;

    console.log(
      `  ${problems.length === 0 ? 'ok  ' : 'FAIL'} ${testCase.name}\n` +
        `       ok=${result.ok} rules=[${rules.join(', ') || 'none'}]`,
    );
    for (const problem of problems) console.log(`       ${problem}`);
  }

  console.log('');
  console.log(`  ${cases.length - failures}/${cases.length} posting fixtures passed`);
  return failures;
}

/** One hand-written letter and what it is supposed to score. */
interface LetterCase {
  name: string;
  body: string;
  expect: {
    minTotal: number;
    maxTotal: number;
    blockers: number;
    categories?: Partial<Record<RubricCategoryId, number>>;
    /** Substrings that must appear among a category's findings. */
    findings?: Partial<Record<RubricCategoryId, string[]>>;
    /** Substrings that must appear among the blockers. */
    blockerContains?: string[];
    /** The word count must equal that of the named case — the disclosure-strip test. */
    sameWordsAs?: string;
    disclosurePresent?: boolean;
  };
}

/**
 * The rubric drill: hand-written letters, asserted scores, no model anywhere.
 *
 * This is the drill that makes the drafting loop a quality bar rather than a
 * vibe, and the argument is in `rubric.ts`'s header: a model judge returns a
 * different number for the same letter next week, so there is nothing to
 * assert against. These letters do not move, so the assertions hold, and a
 * change to a marker list or a weight that quietly breaks the good letters
 * fails here instead of in an email to a hiring manager.
 *
 * Two of the thirteen cases are *good* letters, in deliberately different
 * registers, and they matter more than the eleven bad ones. A rubric that only
 * ever proves it can reject is a rubric nobody has checked for false positives,
 * and a false positive here is the loop discarding the letter Davit would
 * actually have sent.
 *
 * The profile and the posting come from the fixture, not from `data/profile.md`
 * and not from the queue — same reason `policy.json` carries its own
 * preferences. A drill whose expected values move when unrelated content is
 * edited is a drill people learn to ignore.
 */
function runRubricFixtures(): number {
  const file = path.join(FIXTURE_DIR, 'letters.json');
  const fixture = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
    profile: string;
    extracted: ExtractedPosting;
    cases: LetterCase[];
    rankings: { name: string; better: string; worse: string }[];
  };

  let failures = 0;
  const wordsByCase = new Map<string, number>();
  const scoreByCase = new Map<string, ReturnType<typeof scoreLetter>>();

  for (const testCase of fixture.cases) {
    const score = scoreLetter({
      body: testCase.body,
      profile: fixture.profile,
      extracted: fixture.extracted,
    });
    wordsByCase.set(testCase.name, score.words);
    scoreByCase.set(testCase.name, score);

    const problems: string[] = [];
    const { expect } = testCase;

    if (score.total < expect.minTotal || score.total > expect.maxTotal) {
      problems.push(`total ${score.total} outside ${expect.minTotal}-${expect.maxTotal}`);
    }

    if (score.blockers.length !== expect.blockers) {
      problems.push(
        `expected ${expect.blockers} blockers, got ${score.blockers.length}: [${score.blockers.join(' | ')}]`,
      );
    }

    for (const [id, wanted] of Object.entries(expect.categories ?? {})) {
      const category = score.categories.find((entry) => entry.id === id);
      if (!category) problems.push(`no category "${id}"`);
      else if (category.score !== wanted) {
        problems.push(`${id}: expected ${wanted}, got ${category.score} (${category.findings.join('; ') || 'no findings'})`);
      }
    }

    for (const [id, wanted] of Object.entries(expect.findings ?? {})) {
      const category = score.categories.find((entry) => entry.id === id);
      const joined = (category?.findings ?? []).join(' | ').toLowerCase();
      for (const needle of wanted ?? []) {
        if (!joined.includes(needle.toLowerCase())) {
          problems.push(`${id} findings missing "${needle}": [${joined}]`);
        }
      }
    }

    for (const needle of expect.blockerContains ?? []) {
      if (!score.blockers.join(' | ').toLowerCase().includes(needle.toLowerCase())) {
        problems.push(`blockers missing "${needle}": [${score.blockers.join(' | ')}]`);
      }
    }

    if (expect.sameWordsAs) {
      // The whole point of the disclosure-strip rule: appending Davit's fixed
      // line must not cost the letter a single word of its budget.
      const other = wordsByCase.get(expect.sameWordsAs);
      if (other === undefined) problems.push(`"${expect.sameWordsAs}" has not run yet`);
      else if (other !== score.words) {
        problems.push(`words ${score.words} != ${other} from "${expect.sameWordsAs}"`);
      }
    }

    if (expect.disclosurePresent !== undefined && score.disclosurePresent !== expect.disclosurePresent) {
      problems.push(`disclosurePresent: expected ${expect.disclosurePresent}, got ${score.disclosurePresent}`);
    }

    if (problems.length > 0) failures += 1;

    console.log(
      `  ${problems.length === 0 ? 'ok  ' : 'FAIL'} ${testCase.name}\n` +
        `       ${score.total}/100, ${score.words} words, ${score.blockers.length} blockers`,
    );
    for (const problem of problems) console.log(`       ${problem}`);
  }

  // The ordering assertions, which are the ones the loop actually depends on.
  // `compareByQuality` is what picks the survivor out of best-of-N, and its
  // whole claim is that blockers rank ahead of the score -- so a fluent letter
  // that invents an employer never beats a plainer one that does not. That
  // claim is a sort comparator, and a sort comparator is testable.
  for (const ranking of fixture.rankings) {
    const better = scoreByCase.get(ranking.better);
    const worse = scoreByCase.get(ranking.worse);
    const problems: string[] = [];

    if (!better || !worse) problems.push('one of the named cases does not exist');
    else if (compareByQuality(better, worse) >= 0) {
      problems.push(
        `"${ranking.better}" (${better.total}/100, ${better.blockers.length} blockers) did not rank ` +
          `above "${ranking.worse}" (${worse.total}/100, ${worse.blockers.length} blockers)`,
      );
    }

    if (problems.length > 0) failures += 1;
    console.log(`  ${problems.length === 0 ? 'ok  ' : 'FAIL'} ${ranking.name}`);
    for (const problem of problems) console.log(`       ${problem}`);
  }

  const total = fixture.cases.length + fixture.rankings.length;
  console.log('');
  console.log(`  ${total - failures}/${total} rubric fixtures passed`);
  return failures;
}

async function main(): Promise<void> {
  if (hasFlag('policy-fixtures')) {
    console.log('');
    console.log('Scoring policy fixtures');
    console.log('');
    if (runPolicyFixtures() > 0) process.exitCode = 1;
    console.log('');
    return;
  }

  if (hasFlag('rubric-fixtures')) {
    console.log('');
    console.log('Drafting rubric fixtures');
    console.log('');
    if (runRubricFixtures() > 0) process.exitCode = 1;
    console.log('');
    return;
  }

  if (hasFlag('posting-fixtures')) {
    console.log('');
    console.log('Stage A sanitiser fixtures');
    console.log('');
    if (runPostingFixtures() > 0) process.exitCode = 1;
    console.log('');
    return;
  }

  if (hasFlag('source-fixtures')) {
    console.log('');
    console.log('Adapter fixtures');
    console.log('');
    if (runSourceFixtures() > 0) process.exitCode = 1;
    console.log('');
    return;
  }

  if (hasFlag('geo-fixtures')) {
    console.log('');
    console.log('Geo filter fixtures');
    console.log('');
    if (runGeoFixtures() > 0) process.exitCode = 1;
    console.log('');
    return;
  }

  const source = flagValue('source');
  const max = parseInt(flagValue('max') ?? '', 10);
  const explain = hasFlag('explain');

  const preferences = loadPreferences();

  const run = await runOutreach({
    noModel: hasFlag('no-model'),
    explain,
    sources: source ? (source.split(',') as SourceId[]) : undefined,
    company: flagValue('company'),
    max: Number.isFinite(max) ? max : undefined,
    deadline: flagValue('deadline'),
    noCache: hasFlag('no-cache'),
  });

  console.log('');
  console.log(`Job outreach finished in ${(run.durationMs / 1000).toFixed(1)}s`);
  console.log(`  preferences: ${preferences.present ? 'loaded' : 'absent (private/job-preferences.md)'}`);
  // Stated rather than left to be inferred from an empty column. A run with no
  // model still produces a queue, and the difference between "nothing matched"
  // and "nothing looked" is the difference between a quiet morning and a broken
  // one.
  console.log(
    `  scoring:     ${run.scored ? 'ran' : 'skipped — no model available, postings are unscored'}`,
  );
  console.log('');

  for (const outcome of run.outcomes) {
    const label = outcome.company ? `${outcome.source}/${outcome.company}` : outcome.source;
    const suffix = outcome.reason ? ` (${outcome.reason})` : '';
    console.log(
      `  ${label.padEnd(28)} ${outcome.status}${suffix} — ` +
        `${outcome.postingsFetched} postings, ${outcome.eligible} eligible, ` +
        `${outcome.newlyFound} new`,
    );
  }

  if (explain && run.explain) {
    console.log('');
    console.log('  Geo decisions');
    for (const line of run.explain) {
      console.log(
        `    ${line.verdict.padEnd(4)} ${line.rule.padEnd(22)} ${line.title} — ${line.locationText}` +
          (line.evidence ? `\n         matched: "${line.evidence}"` : ''),
      );
    }
  }

  console.log('');
  console.log(
    `  ${run.found.length} posting(s) workable from Yerevan · ` +
      `${run.found.filter((posting) => posting.isNew).length} new · ` +
      `${run.alreadySeen} already seen · ${run.droppedByGeo} dropped by the geo filter`,
  );
  // Why the run ended, in the same words `stoppedBy` uses in the log. §11 reads
  // this number over a week: deadline every morning means the watch list has
  // gone quiet, matches before 08:20 means the filters are too loose.
  console.log(`  stopped by:  ${STOP_REASONS[run.stoppedBy]}`);
  console.log(
    `  queued:      ${run.queued} to review` +
      (run.unscored > 0 ? `, ${run.unscored} of them unscored` : '') +
      (run.skippedByScore > 0 ? ` · ${run.skippedByScore} skipped by scoring` : '') +
      (run.rejected > 0 ? ` · ${run.rejected} refused by the sanitiser` : ''),
  );
  if (run.violations.length > 0) {
    // Counted by rule rather than listed. A count that climbs is the signal
    // §4 wants visible: a hijacked stage A should be loud, not silent.
    const byRule = new Map<string, number>();
    for (const violation of run.violations) {
      byRule.set(violation.rule, (byRule.get(violation.rule) ?? 0) + 1);
    }
    const summary = [...byRule.entries()].map(([rule, count]) => `${rule} x${count}`).join(', ');
    console.log(`  violations:  ${summary}`);
  }
  if (run.deferred > 0) {
    console.log(`  deferred:    ${run.deferred} posting(s) fetched but not reached`);
  }
  if (run.unreachedUnits.length > 0) {
    console.log(`  not reached: ${run.unreachedUnits.join(', ')} — tomorrow starts here`);
  }
  console.log('');

  // Assessed postings first: those are the ones a person is here to read. The
  // rest are the morning's raw yield, which the report file holds in full.
  const ordered = [...run.found].sort((a, b) => (b.assessment?.fit ?? -1) - (a.assessment?.fit ?? -1));
  const shown = ordered.slice(0, PRINT_LIMIT);

  for (const posting of shown) {
    console.log(`  ${posting.isNew ? '*' : ' '} ${posting.company} — ${posting.title}`);
    console.log(
      `      ${posting.locationText}${posting.postedAt ? ` · ${posting.postedAt}` : ''}` +
        `${posting.verdict === 'flag' ? ' · FLAGGED: check before applying' : ''}`,
    );

    const assessment = posting.assessment;
    if (assessment) {
      console.log(
        `      ${assessment.recommendation.toUpperCase()} · fit ${assessment.fit} · ` +
          `${assessment.eligibility}` +
          (assessment.flags.length ? ` · ${assessment.flags.join(', ')}` : ''),
      );
      // The quoted sentence that decided eligibility. It is the one line on a
      // card that a human can check against the posting itself.
      if (assessment.evidence) console.log(`      "${assessment.evidence}"`);
    }

    console.log(`      ${posting.url}`);
  }

  if (ordered.length > shown.length) {
    console.log(`  …and ${ordered.length - shown.length} more in ${run.reportPath ?? 'the report'}`);
  }

  console.log('');
  if (run.reportPath) console.log(`  report: ${run.reportPath}`);
  console.log('');

  if (run.outcomes.some((outcome) => outcome.status === 'failed')) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Job outreach crashed:', err);
  process.exitCode = 1;
});
