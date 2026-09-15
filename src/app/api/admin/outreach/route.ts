import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { ADMIN_COOKIE, isValidSessionValue } from '@/lib/admin/auth';
import type { AppliedApplication, QueuedOpportunity, WatchedCompany } from '@/lib/outreach/types';
import {
  appendCompany,
  dedupeHashFor,
  patchPending,
  readPending,
  readRejections,
  readSuggestions,
  recordRejection,
  removeFromPending,
  removeSuggestion,
  writeHandoff,
  clearRejections,
} from '@/lib/outreach/store';
import {
  appendApplied,
  appliedFor,
  cooldownHold,
  readApplied,
  reapplyAllowed,
  sendCapReached,
  sentToday,
} from '@/lib/outreach/ledger';
import {
  POSTING_LIMITS,
  sanitizeEditedBody,
  sanitizeEditedField,
} from '@/lib/outreach/sanitize';
import { dryRun, maxSendsPerDay } from '@/lib/outreach/config';
import { logger } from '@/lib/logger';

/**
 * The review API behind the outreach tab (§17.8).
 *
 * Mirrors `api/admin/proposal/route.ts` — same `requireAdmin()` shape, same
 * `runtime = 'nodejs'`, same rule that a rejected edit aborts rather than
 * applying half of something.
 *
 * ## The three decisions are three different writes
 *
 * §8 offers Approve & send, Not interested and Already applied together and
 * equally weighted, because they are the three true answers to "what about this
 * one?". What makes them worth keeping apart is that they mean *opposite*
 * things to the rest of the system:
 *
 *  - **Approve & send** writes the ledger and transmits. It consumes the daily
 *    cap and the per-company cooldown, because it is an application.
 *  - **Not interested** writes `rejected.json` and nothing else. It is not an
 *    application, so it must not consume the cooldown — otherwise saying no to
 *    one bad role at NVIDIA would block a good one for a month.
 *  - **Already applied** writes the ledger and **sends nothing at all**. From
 *    the recipient's side it was an application, so it feeds the duplicate
 *    guard and the cooldown exactly as a send does.
 *
 * Collapsing the last two into one "dismiss" would make the ledger wrong in one
 * direction and the cooldown wrong in the other.
 *
 * ## Why `mark_applied` returns early
 *
 * §17.8: "it must be impossible to reach the Cloudflare call from it". The
 * branch below returns before anything that could send is reached, and phase 6
 * must keep it that way — the import of `send.ts` belongs inside
 * `approve_send`, not at the top of this file, so that the one action which
 * exists precisely *not* to send cannot fall through into one that does.
 *
 * Nothing in this file transmits today: sending is phase 6. `approve_send`
 * writes a `dryRun` ledger row and stops, which exercises every guard around
 * the send without there being a send.
 */

export const runtime = 'nodejs';

async function requireAdmin(): Promise<boolean> {
  const store = await cookies();
  return isValidSessionValue(store.get(ADMIN_COOKIE)?.value);
}

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

/** Everything the tab renders, in one response. */
function snapshot() {
  const applied = readApplied();
  return {
    opportunities: readPending(),
    suggestions: readSuggestions(),
    applied,
    rejections: readRejections(),
    sentToday: sentToday(applied),
    capPerDay: maxSendsPerDay(),
    dryRun: dryRun(),
  };
}

export async function GET() {
  if (!(await requireAdmin())) return unauthorized();
  return NextResponse.json(snapshot());
}

type Action =
  | 'approve_send'
  | 'prepare_form'
  | 'reject'
  | 'mark_applied'
  | 'snooze'
  | 'unreject'
  | 'save_draft'
  | 'company_add'
  | 'company_reject'
  | 'confirm_submitted'
  | 'record_manual';

interface DecisionBody {
  action?: Action;
  id?: unknown;
  edits?: { subject?: unknown; body?: unknown };
  days?: unknown;
  appliedAt?: unknown;
  channel?: unknown;
  entry?: Partial<AppliedApplication>;
}

function ok() {
  return NextResponse.json({ ok: true, ...snapshot() });
}

function fail(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

/**
 * Re-validates a subject and body a human typed.
 *
 * Not because the admin is suspected, but because this is the one path where
 * arbitrary text reaches an outbound channel without having passed the
 * pipeline — the same reason `api/admin/proposal` re-sanitises edits before they
 * reach `data/`.
 */
function checkedDraft(edits: DecisionBody['edits']): { subject: string; body: string } | string {
  const subject = sanitizeEditedField('subject', edits?.subject ?? '', POSTING_LIMITS.title);
  if (!subject.ok || subject.value === null) {
    return `Subject was rejected: ${subject.violations.map((v) => v.rule).join(', ')}`;
  }

  // Not `sanitizeEditedField`: a cover letter's line breaks are part of it.
  const body = sanitizeEditedBody('body', edits?.body ?? '', BODY_LIMIT);
  if (!body.ok || body.value === null) {
    return `Body was rejected: ${body.violations.map((v) => v.rule).join(', ')}`;
  }

  return { subject: subject.value, body: body.value };
}

/** A cover letter is 150–250 words (§7); this is the ceiling, not the target. */
const BODY_LIMIT = 4_000;

export async function POST(request: Request) {
  if (!(await requireAdmin())) return unauthorized();

  let body: DecisionBody;
  try {
    body = (await request.json()) as DecisionBody;
  } catch {
    return fail('Invalid request');
  }

  const id = typeof body.id === 'string' ? body.id : null;

  // ─── Decisions that do not need a queued item ──────────────────────────────

  if (body.action === 'unreject') {
    if (!id) return fail('No decision selected');
    clearRejections([id]);
    logger.info('outreach_unrejected', { job: 'outreach', id });
    return ok();
  }

  if (body.action === 'record_manual') {
    // Seeding the ledger (§8.1, row 3). The same action as "Already applied",
    // reached without a posting: this is how everything applied to in the last
    // six months goes in before the first real send.
    const entry = body.entry ?? {};
    if (!entry.company?.trim() || !entry.title?.trim()) {
      return fail('A manual record needs a company and a title');
    }

    appendApplied({
      // The run's own hash function, imported rather than reimplemented: two
      // spellings of `dedupeHash` that drift apart would mean a hand-seeded
      // ledger row silently failing to match the posting it is about, which is
      // the one failure this file exists to prevent.
      dedupeHash: dedupeHashFor(entry.company, entry.title),
      company: entry.company.trim(),
      title: entry.title.trim(),
      url: entry.url,
      appliedAt: validDate(entry.appliedAt) ?? new Date().toISOString(),
      channel: 'manual',
    });
    return ok();
  }

  if (body.action === 'company_reject') {
    if (!id) return fail('No suggestion selected');
    const suggestion = readSuggestions().find((entry) => entry.id === id);
    if (!suggestion) return fail('That suggestion is no longer pending', 409);

    recordRejection({
      id,
      kind: 'company',
      summary: suggestion.name,
      rejectedAt: new Date().toISOString(),
    });
    removeSuggestion(id);
    logger.info('outreach_company_rejected', { job: 'outreach', company: suggestion.name });
    return ok();
  }

  if (body.action === 'company_add') {
    if (!id) return fail('No suggestion selected');
    const suggestion = readSuggestions().find((entry) => entry.id === id);
    if (!suggestion) return fail('That suggestion is no longer pending', 409);

    const company: WatchedCompany = {
      name: suggestion.name,
      ats: suggestion.ats,
      // Stored whole, because the endpoint is the thing that was verified — not
      // reassembled from a slug, which is how three name-based guesses at
      // Align's ATS all returned 404 (§1.2).
      endpoint: suggestion.endpoint,
      careersUrl: suggestion.careersUrl,
      addedAt: new Date().toISOString().slice(0, 10),
      addedBy: 'approved',
    };

    appendCompany(company);
    removeSuggestion(id);
    logger.info('outreach_company_approved', {
      job: 'outreach',
      company: company.name,
      ats: company.ats,
      endpoint: company.endpoint,
    });
    return ok();
  }

  // ─── Decisions about one queued opportunity ────────────────────────────────

  if (!id) return fail('No opportunity selected');

  const item = readPending().find((entry) => entry.id === id);
  if (!item) return fail('That opportunity is no longer in the queue', 409);

  if (body.action === 'reject') {
    // Keyed on `dedupeHash`, never the posting id: the same role reached
    // through a different board is the same "no". Writes neither the ledger nor
    // the cooldown (§8).
    recordRejection({
      id: item.dedupeHash,
      kind: 'opportunity',
      summary: `${item.company} — ${item.title}`,
      rejectedAt: new Date().toISOString(),
    });
    removeFromPending([id]);
    logger.info('outreach_not_interested', {
      job: 'outreach',
      dedupeHash: item.dedupeHash,
      company: item.company,
      title: item.title,
    });
    return ok();
  }

  if (body.action === 'snooze') {
    // Deliberately not one of the three decisions: postponing is not a
    // decision and should not feel like one (§8).
    const days = typeof body.days === 'number' && body.days > 0 ? body.days : 7;
    patchPending(id, {
      snoozedUntil: new Date(Date.now() + days * 86_400_000).toISOString(),
    });
    return ok();
  }

  if (body.action === 'save_draft') {
    // §17.8 lists no save action, and §21 requires a hand-edited draft to
    // survive a reload. Both can only be true if there is one. See §23.
    const checked = checkedDraft(body.edits);
    if (typeof checked === 'string') return fail(checked);

    patchPending(id, {
      draft: {
        subject: checked.subject,
        body: checked.body,
        to: item.extracted?.applyTarget ?? '',
        model: 'human',
        draftedAt: new Date().toISOString(),
      },
    });
    return ok();
  }

  if (body.action === 'mark_applied') {
    // ── THE BRANCH THAT MUST NEVER SEND ──────────────────────────────────────
    // "I applied to this myself." It writes the ledger and returns, and every
    // line that could transmit is below this point and unreachable from here.
    // Phase 6 adds sending inside `approve_send`; it must not add an import at
    // the top of this file that this branch could fall through into (§17.8).
    const applied = readApplied();
    const previous = appliedFor(applied, item.dedupeHash);
    if (previous) return fail(`Already in the ledger, recorded ${previous.appliedAt.slice(0, 10)}`, 409);

    const channel = body.channel === 'email' || body.channel === 'form' ? body.channel : 'manual';

    appendApplied({
      id: item.id,
      dedupeHash: item.dedupeHash,
      company: item.company,
      title: item.title,
      url: item.url,
      // Defaults to today, and offers a date, because a role applied to three
      // months ago should not start a fresh 30-day cooldown (§8).
      appliedAt: validDate(body.appliedAt) ?? new Date().toISOString(),
      channel,
    });

    removeFromPending([id]);
    return ok();
  }

  if (body.action === 'confirm_submitted') {
    // The form handoff cannot confirm itself: a human clicked Submit on the
    // host, so the ledger only learns about it if told (§8.1).
    if (item.status !== 'awaiting_form') return fail('That item is not awaiting a form', 409);

    appendApplied({
      id: item.id,
      dedupeHash: item.dedupeHash,
      company: item.company,
      title: item.title,
      url: item.url,
      appliedAt: new Date().toISOString(),
      channel: 'form',
    });
    removeFromPending([id]);
    return ok();
  }

  if (body.action === 'prepare_form') {
    const guard = guardApplication(item);
    if (guard) return fail(guard.error, guard.status);

    patchPending(id, { status: 'awaiting_form' });
    writeHandoff({ id, requestedAt: new Date().toISOString() });
    logger.info('outreach_form_prepared', {
      job: 'outreach',
      id,
      company: item.company,
      title: item.title,
    });
    return ok();
  }

  if (body.action !== 'approve_send') return fail('Unknown action');

  // ─── Approve & send ────────────────────────────────────────────────────────

  const guard = guardApplication(item);
  if (guard) return fail(guard.error, guard.status);

  const applied = readApplied();
  if (sendCapReached(applied)) {
    // 429 with a clear message rather than silently queueing (§17.8). A cap
    // that quietly defers is a cap nobody notices until the deliverability is
    // already spent.
    return fail(
      `Daily send cap reached (${sentToday(applied)}/${maxSendsPerDay()}). Try again tomorrow.`,
      429,
    );
  }

  const checked = checkedDraft(body.edits ?? { subject: item.draft?.subject, body: item.draft?.body });
  if (typeof checked === 'string') return fail(checked);
  if (!checked.body.trim()) return fail('There is nothing to send: write a body first');

  if (!dryRun()) {
    // Phase 6 puts the Cloudflare call here, behind its own second
    // `dedupeHash` check (§17.8). Until then, refusing is the only honest
    // answer to "send this for real" — silently writing a ledger row for a
    // message nobody transmitted would corrupt the one file that must not lie.
    return fail(
      'Sending is not built yet (phase 6). Set OUTREACH_DRY_RUN=true to record the approval instead.',
      501,
    );
  }

  appendApplied({
    id: item.id,
    dedupeHash: item.dedupeHash,
    company: item.company,
    title: item.title,
    url: item.url,
    appliedAt: new Date().toISOString(),
    channel: 'email',
    to: item.draft?.to || item.extracted?.applyTarget || '',
    subject: checked.subject,
    body: checked.body,
    dryRun: true,
  });

  removeFromPending([id]);
  return ok();
}

/**
 * The checks every *application* passes and no other decision does.
 *
 * Shared by `approve_send` and `prepare_form` because both end in an
 * application; deliberately not reached by `reject`, which is not one.
 */
function guardApplication(
  item: QueuedOpportunity,
): { error: string; status: number } | null {
  const applied = readApplied();

  const previous = appliedFor(applied, item.dedupeHash);
  if (previous && !reapplyAllowed(previous)) {
    return {
      error:
        `Already applied to this role on ${previous.appliedAt.slice(0, 10)} ` +
        `(${previous.channel}). Re-application is off by default.`,
      status: 409,
    };
  }

  const hold = cooldownHold(applied, item.company);
  if (hold) {
    logger.info('outreach_cooldown_held', {
      job: 'outreach',
      company: item.company,
      count: hold.count,
      limit: hold.limit,
      until: hold.until,
    });
    return {
      error:
        `${item.company} is inside its cooldown: ${hold.count}/${hold.limit} application(s) ` +
        `since ${hold.last.appliedAt.slice(0, 10)}. Frees up ${hold.until.slice(0, 10)}.`,
      status: 409,
    };
  }

  return null;
}

/** An ISO date the caller supplied, or null. Never a silently-corrected one. */
function validDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
