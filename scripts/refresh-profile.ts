#!/usr/bin/env -S npx tsx
/**
 * Entry point for the scheduled profile refresh.
 *
 *   npm run refresh:profile              # fetch, propose, write nothing to data/
 *   npm run refresh:profile -- --apply   # also write the changes into data/
 *   npm run refresh:profile -- --no-model  # adapters only, no Mac required
 *   npm run refresh:profile -- --sources=github
 *
 * Exit codes matter here because a scheduler is the caller: 0 means the run
 * completed (with or without changes to propose), 1 means a source failed and
 * someone should look. "The Mac was asleep" is not a failure — it is the normal
 * state of a laptop at 03:00, and exiting non-zero for it would train whoever
 * reads the scheduler's history to ignore it.
 */

import { runRefresh } from '../src/lib/refresh';

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function flagValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function main(): Promise<void> {
  const sources = flagValue('sources');
  if (sources) process.env.REFRESH_SOURCES = sources;

  const run = await runRefresh({
    apply: hasFlag('apply'),
    noModel: hasFlag('no-model'),
  });

  console.log('');
  console.log(`Profile refresh finished in ${(run.durationMs / 1000).toFixed(1)}s`);
  console.log(`  extract model: ${run.extractModel ?? 'skipped'}`);
  console.log(`  edit model:    ${run.editModel ?? 'skipped'}`);
  console.log('');

  for (const outcome of run.outcomes) {
    const suffix = outcome.reason ? ` (${outcome.reason})` : '';
    console.log(
      `  ${outcome.source.padEnd(11)} ${outcome.status}${suffix} — ` +
        `${outcome.recordsFetched} records, ${outcome.changesProposed} changes, ` +
        `${outcome.violations.length} rejections`,
    );
  }

  console.log('');
  console.log(`  ${run.changes.length} proposed change(s)`);
  if (run.proposalPath) console.log(`  proposal: ${run.proposalPath}`);
  if (run.applied) console.log('  APPLIED to data/ — review `git diff data/` before committing');
  console.log('');

  if (run.outcomes.some((o) => o.status === 'failed')) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Profile refresh crashed:', err);
  process.exitCode = 1;
});
