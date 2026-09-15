#!/usr/bin/env -S npx tsx
/**
 * Entry point for the 07:00 company discovery run (§9, §11).
 *
 *   npm run outreach:companies                     # the scheduled behaviour
 *   npm run outreach:companies -- --no-feeds       # candidates.txt and the queue only
 *   npm run outreach:companies -- --max-candidates=3
 *   npm run outreach:companies -- --deadline=23:59 # wall clock, DISPLAY_TIMEZONE
 *   npm run outreach:companies -- --no-cache       # refetch the feeds
 *   npm run outreach:companies -- --detect-fixtures # ATS detection, no network at all
 *
 * Exit codes are the scheduler's only channel: 0 means the run completed, with
 * or without anything to propose, and 1 means a source genuinely failed. **A
 * morning that verifies nothing exits 0** — §9 calls that the normal outcome
 * once the watch list is healthy, and a job whose history is full of red
 * because most days are quiet is a job whose history nobody reads.
 */

import fs from 'fs';
import path from 'path';
import { runDiscovery, lastOpportunityRun } from '../src/lib/outreach/discovery';
import { detectAts } from '../src/lib/outreach/detect';
import { FIXTURE_DIR, maxCompanies } from '../src/lib/outreach/config';
import type { DiscoveryStopReason } from '../src/lib/outreach/types';

/** The same words the log uses, spelled out for a person reading a terminal. */
const STOP_REASONS: Record<DiscoveryStopReason, string> = {
  suggestions: 'suggestions — enough verified companies for one morning',
  deadline: 'deadline — the wall clock ran out before 07:30',
  budget: 'budget — the duration budget ran out',
  candidates: 'candidates — DISCOVERY_MAX_CANDIDATES attempts were spent',
  backlog: 'backlog — enough suggestions are already waiting to be reviewed',
  exhausted: 'exhausted — every candidate was tried',
};

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function flagValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

interface DetectCase {
  name: string;
  /** The page's own URL. Searched as well as the body — a board URL detects on its own. */
  pageUrl: string;
  html: string;
  companyName?: string;
  /** True when the page is the company's own careers page. See `detect.ts`. */
  trusted?: boolean;
  expect: {
    /** `null` when nothing should be detected at all. */
    ats: string | null;
    marker?: string;
    endpoint?: string;
    /** How many detections should survive, when the case is about what is *rejected*. */
    count?: number;
    unsupported?: string[];
  };
}

/**
 * The detection drill: `detect.ts` over saved careers-page HTML.
 *
 * This exists because ATS detection is the textbook case of a thing that works
 * on the two boards it was written against and fails on the third. The cases
 * are not a sample of happy paths — each one is a shape that broke, or would
 * break, a detector written from the obvious rule:
 *
 *  - Greenhouse's embed script and its board URL are different strings for the
 *    same board, and the embed's path segment is `embed`, which is not a slug.
 *  - A Workday `/wday/cxs/` URL matches the shape of a public board URL, and
 *    reading `wday` as the site name produces a plausible endpoint that 404s.
 *  - Align's Pinpoint board names the vendor only in an asset host, so the
 *    endpoint has to come from the page's own origin — which is correct on the
 *    company's careers page and produces `remotive.com/postings.json` anywhere
 *    else. Two cases, same HTML, different `trusted`.
 *  - An aggregator's posting page carries the employer's apply link *and* a
 *    sidebar of unrelated jobs on other boards. The slug has to resemble the
 *    company or the run proposes somebody else's board with real postings in
 *    it, which would verify perfectly.
 *  - SmartRecruiters and Eightfold are recognised and unsupported, which is a
 *    different answer from "no marker" and has to stay one (§12).
 *
 * No network, no model, no Mac: it runs on every change to `detect.ts`.
 */
function runDetectFixtures(): number {
  const file = path.join(FIXTURE_DIR, 'detect.json');
  const { cases } = JSON.parse(fs.readFileSync(file, 'utf-8')) as { cases: DetectCase[] };

  let failures = 0;

  for (const testCase of cases) {
    const result = detectAts(testCase.html, testCase.pageUrl, {
      allowOriginFallback: testCase.trusted === true,
      companyName: testCase.companyName,
    });

    const best = result.detections[0] ?? null;
    const problems: string[] = [];

    if (testCase.expect.ats === null) {
      if (best) problems.push(`expected nothing, got ${best.ats} via ${best.marker}`);
    } else if (!best) {
      problems.push(`expected ${testCase.expect.ats}, detected nothing`);
    } else {
      if (best.ats !== testCase.expect.ats) problems.push(`ats ${best.ats}`);
      if (testCase.expect.marker && best.marker !== testCase.expect.marker) {
        problems.push(`marker ${best.marker}`);
      }
      if (testCase.expect.endpoint && best.endpoint !== testCase.expect.endpoint) {
        problems.push(`endpoint ${best.endpoint}`);
      }
    }

    if (
      typeof testCase.expect.count === 'number' &&
      result.detections.length !== testCase.expect.count
    ) {
      problems.push(`${result.detections.length} detection(s), expected ${testCase.expect.count}`);
    }

    for (const name of testCase.expect.unsupported ?? []) {
      if (!result.unsupported.includes(name)) problems.push(`unsupported missing ${name}`);
    }

    if (problems.length > 0) failures += 1;

    console.log(
      `  ${problems.length === 0 ? 'ok  ' : 'FAIL'} ${testCase.name}` +
        (best ? ` — ${best.ats}/${best.marker} → ${best.endpoint}` : ' — no detection') +
        (result.unsupported.length ? ` · unsupported: ${result.unsupported.join(', ')}` : ''),
    );
    for (const problem of problems) console.log(`         ${problem}`);
  }

  console.log('');
  console.log(`  ${cases.length - failures}/${cases.length} detection fixtures passed`);
  return failures;
}

async function main(): Promise<void> {
  if (hasFlag('detect-fixtures')) {
    console.log('');
    console.log('ATS detection fixtures');
    console.log('');
    if (runDetectFixtures() > 0) process.exitCode = 1;
    console.log('');
    return;
  }

  const maxCandidatesFlag = parseInt(flagValue('max-candidates') ?? '', 10);

  const run = await runDiscovery({
    maxCandidates: Number.isFinite(maxCandidatesFlag) ? maxCandidatesFlag : undefined,
    deadline: flagValue('deadline'),
    noFeeds: hasFlag('no-feeds'),
    noCache: hasFlag('no-cache'),
  });

  console.log('');
  console.log(`Company discovery finished in ${(run.durationMs / 1000).toFixed(1)}s`);
  console.log('');

  for (const outcome of run.feeds) {
    const suffix = outcome.reason ? ` (${outcome.reason})` : '';
    console.log(
      `  ${outcome.source.padEnd(12)} ${outcome.status}${suffix} — ` +
        `${outcome.postingsFetched} postings read, and cached for 08:00`,
    );
  }
  if (run.feeds.length === 0) console.log('  feeds:       not read');

  console.log('');
  console.log(
    `  ${run.considered} candidate(s) with an address to check · ` +
      `${run.attempted} put through verification`,
  );
  console.log(`  stopped by:  ${STOP_REASONS[run.stoppedBy]}`);
  console.log(
    `  proposed:    ${run.suggested.length} new · ${run.pending} waiting in /admin · ` +
      `watch list ${run.watchlistSize}/${maxCompanies()}`,
  );

  for (const suggestion of run.suggested) {
    console.log('');
    console.log(`  * ${suggestion.name} — ${suggestion.ats}`);
    console.log(`      ${suggestion.endpoint}`);
    console.log(
      `      ${suggestion.postingCount} posting(s), ${suggestion.eligibleCount} workable from Yerevan`,
    );
    console.log(`      ${suggestion.why}`);
    if (suggestion.displaces) {
      console.log(`      at the cap — adding this displaces ${suggestion.displaces}`);
    }
  }

  if (run.rejections.length > 0) {
    // Counted by reason, then listed. §12: a log dominated by `no-marker` means
    // detection is failing, which is a different fix from the candidates being
    // bad — and the two are indistinguishable if both read "no suggestions".
    const byReason = new Map<string, number>();
    for (const rejection of run.rejections) {
      byReason.set(rejection.reason, (byReason.get(rejection.reason) ?? 0) + 1);
    }
    console.log('');
    console.log(
      `  discarded:   ${[...byReason.entries()].map(([reason, n]) => `${reason} x${n}`).join(', ')}`,
    );
    for (const rejection of run.rejections.slice(0, 10)) {
      console.log(
        `      ${rejection.company} (${rejection.origin}) — ${rejection.reason}` +
          (rejection.detail ? `: ${rejection.detail}` : ''),
      );
    }
  }

  if (run.unresolvedTotal > 0) {
    // Names, not candidates: the feeds publish a company and their own link to
    // it, never the company's careers page, so these cannot be verified without
    // the one open-web query §9's fourth tier is about (§23). Paste any of them
    // into candidates.txt with a careers URL and tomorrow's run does the rest.
    console.log('');
    console.log(
      `  ${run.unresolvedTotal} name(s) worth a look, with no careers URL to check them at.` +
        ' Add one to data/outreach/candidates.txt to have it verified:',
    );
    for (const entry of run.unresolved) {
      console.log(`      ${entry.company} — ${entry.note}`);
    }
  }

  if (run.hygiene.length > 0) {
    console.log('');
    console.log('  Watch-list hygiene — proposed, never acted on (§9)');
    for (const finding of run.hygiene) {
      console.log(
        finding.kind === 'stale'
          ? `      ${finding.company} — nothing eligible since ${finding.lastEligibleAt ?? 'ever'}` +
            ` (${finding.eligibleSeen ?? 0} seen in total). Consider removing it by hand.`
          : `      ${finding.company} — ${finding.consecutiveFailures} unreadable runs. Re-detect its ATS.`,
      );
    }
  }

  // §11: "both numbers belong in the daily summary", because the two halves
  // diagnose each other. A discovery run that proposes nothing is fine when the
  // queue is moving and is the thing to look at when it is not.
  const opportunity = lastOpportunityRun();
  if (opportunity) {
    console.log('');
    console.log(
      `  last 08:00 run: ${opportunity.queued} card(s) gained, stopped by ${opportunity.stoppedBy}`,
    );
  }

  console.log('');
  if (run.reportPath) console.log(`  report: ${run.reportPath}`);
  console.log('');

  if (run.feeds.some((outcome) => outcome.status === 'failed')) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Company discovery crashed:', err);
  process.exitCode = 1;
});
