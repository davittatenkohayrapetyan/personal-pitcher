#!/usr/bin/env -S npx tsx
/**
 * The drafting loop, run on the Windows host for one queued opportunity.
 *
 *   npm run outreach:draft -- --id=<id>
 *   npm run outreach:draft -- --id=<id> --variants=1      # one register, roughly half the time
 *   npm run outreach:draft -- --id=<id> --candidates=1 --revisions=0   # one letter, one call
 *   npm run outreach:draft -- --list                      # what is in the queue, with ids
 *   npm run outreach:draft -- --id=<id> --dry             # score and critique, write nothing
 *
 * ## Why this is a script and not a button
 *
 * §16's fourth open question — may stage C use the paid tier? — was answered
 * **no** on 2026-09-16: drafting stays on the Mac. That answer decides this
 * file's existence. Best-of-3 across two tone variants, plus a critic, plus a
 * revision round is up to eleven model calls, and at the Mac's measured 46–58
 * seconds each that is seven to ten minutes in which Ollama, which serialises
 * per model, has nothing left for a visitor to the website.
 *
 * §23 records what a *single* 90-second call in the web process can already do:
 * a visitor's one question makes two tier-0 calls, both can time out behind the
 * draft, and two timeouts is the whole of `MAC_CB_FAILURE_THRESHOLD` — so the
 * breaker opens, an alert fires about a machine that is healthy and busy, and
 * five minutes of visitors are answered by OpenAI. Eleven calls do not narrow
 * that window, they widen it by an order of magnitude. So the loop runs here,
 * in a `tsx` process on the host, exactly as §17.1 already does for
 * `outreach:form`: the card shows the command, a person copies it, and the
 * website's process is never inside it.
 *
 * The one-shot `Generate draft` button in `/admin` is unchanged and stays the
 * fast path. One call is the risk §23 weighed and accepted.
 *
 * ## What it writes
 *
 * The chosen letter into the queue entry's `draft`, exactly as the button does,
 * and the whole `DraftRecord` — every candidate, every rubric score, the
 * critic's verdict — beside it. Nothing is sent and nothing can be: there is no
 * sender, `OUTREACH_DRY_RUN` is untouched, and `approve_send` still refuses with
 * 501 (§23).
 *
 * Exit codes: 0 when a letter was written, 1 when it could not be.
 */

import { runDraftLoop } from '../src/lib/outreach/draftLoop';
import { finaliseDraft } from '../src/lib/outreach/draft';
import { loadPreferences } from '../src/lib/outreach/preferences';
import { patchPending, readPending } from '../src/lib/outreach/store';
import { explainScore } from '../src/lib/outreach/rubric';
import { formatDisplayTime } from '../src/lib/time';
import type { QueuedOpportunity } from '../src/lib/outreach/types';

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function flagValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function numberFlag(name: string): number | undefined {
  const parsed = parseInt(flagValue(name) ?? '', 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** One line per card, so `--id=` can be filled in without opening `/admin`. */
function listQueue(queue: QueuedOpportunity[]): void {
  if (queue.length === 0) {
    console.log('  The queue is empty.');
    return;
  }

  for (const item of queue) {
    const fit = item.verdict ? `fit ${item.verdict.fit}` : 'unscored';
    const drafted = item.draftRecord ? 'looped' : item.draft ? 'drafted' : '—';
    const readable = item.extracted ? '' : '   (no stage A extraction — nothing to draft from)';
    console.log(
      `  ${item.id}\n` +
        `     ${item.company} · ${item.title}\n` +
        `     ${fit}, ${drafted}${readable}`,
    );
  }
}

async function main(): Promise<void> {
  const queue = readPending();

  if (hasFlag('list') || (!flagValue('id') && !hasFlag('help'))) {
    console.log('');
    console.log('Queued opportunities');
    console.log('');
    listQueue(queue);
    console.log('');
    console.log('  npm run outreach:draft -- --id=<id>');
    console.log('');
    // Listing is a successful run of `--list`, and the honest answer to a bare
    // invocation with no id: nothing was asked for and nothing failed.
    return;
  }

  const id = flagValue('id');
  const item = queue.find((entry) => entry.id === id);

  if (!item) {
    console.error(`  No queued opportunity with id "${id}". Run with --list to see what there is.`);
    process.exitCode = 1;
    return;
  }

  if (!item.extracted) {
    // The same refusal the button gives, for the same reason: stage A has not
    // read this posting, so there is nothing to write a letter from and a model
    // asked anyway would fill the gap from whatever it remembers.
    console.error(
      `  "${item.company} · ${item.title}" was never read by stage A, so there is nothing to draft\n` +
        '  from. The next run with a model available will extract it.',
    );
    process.exitCode = 1;
    return;
  }

  const preferences = loadPreferences();
  if (!preferences.present) {
    // Not fatal: `data/profile.md` is the substance and it is what the claims
    // come from. But §23 records that a letter quietly missing its steer is the
    // kind of degradation nobody notices, so it is said out loud here too.
    console.log('  Note: private/job-preferences.md could not be read, so the letter is being written');
    console.log('  without the target roles, preferred stack and notes.');
    console.log('');
  }

  console.log('');
  console.log(`  ${item.company} · ${item.title}`);
  console.log(`  ${item.url}`);
  console.log('');
  console.log('  This runs on the Mac and takes minutes, not seconds. Every line below is one call.');
  console.log('');

  const result = await runDraftLoop(item.extracted, item.verdict, preferences, {
    candidates: numberFlag('candidates'),
    variants: numberFlag('variants'),
    revisions: numberFlag('revisions'),
    onProgress: (message) => console.log(`  ${message}`),
  });

  console.log('');

  if (!result.record || !result.chosen) {
    const reasons: Record<string, string> = {
      no_profile: 'data/profile.md could not be read, and it is the only permitted source of claims.',
      no_model: 'The Mac is not reachable, so there is no model to draft with.',
      no_candidates: 'Every candidate failed or was refused by the sanitiser. The log has the rules.',
    };
    console.error(`  ${reasons[result.reason ?? ''] ?? 'The loop produced nothing.'}`);
    process.exitCode = 1;
    return;
  }

  // ── What happened, in the order a person would ask ────────────────────────

  console.log('  Candidates');
  console.log('');
  for (const candidate of result.record.candidates) {
    const marker = candidate.id === result.chosen.id ? '→' : ' ';
    console.log(
      `  ${marker} ${candidate.id.padEnd(14)} ${String(candidate.score.total).padStart(3)}/100  ` +
        `${String(candidate.score.words).padStart(3)}w  ` +
        `${candidate.score.blockers.length} blockers  ${Math.round(candidate.durationMs / 1000)}s`,
    );
  }

  console.log('');
  for (const line of explainScore(result.chosen.score)) console.log(`  ${line}`);

  // A candidate the sanitiser refused has no score and is therefore not in
  // `candidates`, so without this it leaves no trace anywhere a person looks:
  // the rules it broke were collected and then dropped on the floor. Two of six
  // candidates being refused is a prompt problem worth seeing.
  if (result.violations.length > 0) {
    const rules = [...new Set(result.violations.map((violation) => violation.rule))];
    console.log('');
    console.log(`  Sanitiser refusals during the loop: ${rules.join(', ')}`);
  }

  if (result.record.critique) {
    console.log('');
    console.log('  Critic');
    for (const line of result.record.critique.split('\n')) console.log(`    ${line}`);
  }

  if (hasFlag('dry')) {
    console.log('');
    console.log('  --dry: nothing written. The letter, as it would have been stored:');
    console.log('');
    console.log(result.chosen.body.split('\n').map((line) => `    ${line}`).join('\n'));
    console.log('');
    return;
  }

  const draft = finaliseDraft(
    result.chosen.subject,
    result.chosen.body,
    item.extracted,
    result.chosen.model,
  );

  // A card can leave the queue during a seven-minute loop — a second tab
  // deciding it, or the 08:00 run pruning an expiry. Reporting success about a
  // card that is gone sends a person looking for something that is not there,
  // and this window is five times the one §23 already recorded for the button.
  if (!patchPending(item.id, { draft, draftRecord: result.record })) {
    console.error('  That card left the queue while the loop was running. Nothing was written.');
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log(`  Written to the queue at ${formatDisplayTime(new Date())}.`);
  if (result.record.offered.length > 1) {
    console.log('  Two registers were produced. Open the card in /admin and pick the one that sounds');
    console.log('  like you — the choice is recorded and steers later letters.');
  }
  console.log('  Read it before you approve it. It is a first attempt, not a send.');
  console.log('');
}

main().catch((err) => {
  console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
