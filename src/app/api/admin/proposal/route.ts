import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { ADMIN_COOKIE, isValidSessionValue } from '@/lib/admin/auth';
import {
  clearRejections,
  readPending,
  readRejections,
  recordRejections,
  removeFromPending,
  type IdentifiedChange,
} from '@/lib/refresh/store';
import { applyChanges } from '@/lib/refresh/propose';
import { sanitizeEditedText, LIMITS } from '@/lib/refresh/sanitize';
import { invalidateProfileCache } from '@/lib/retrieval';
import { logger } from '@/lib/logger';

/**
 * The review API behind `/admin`.
 *
 * Every proposed change arrives here having already passed the refresh job's
 * sanitiser, but anything the reviewer *edits by hand* has not — so edited
 * values are re-validated with the same rules before they can be applied. The
 * admin is trusted; a browser session that has picked up the admin's cookie is
 * a different question, and the cost of checking is one function call.
 */

export const runtime = 'nodejs';

async function requireAdmin(): Promise<boolean> {
  const store = await cookies();
  return isValidSessionValue(store.get(ADMIN_COOKIE)?.value);
}

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export async function GET() {
  if (!(await requireAdmin())) return unauthorized();

  return NextResponse.json({
    pending: readPending(),
    rejections: readRejections(),
  });
}

interface DecisionBody {
  action?: 'approve' | 'reject' | 'unreject';
  ids?: unknown;
  /** For `approve`: hand-edited replacements, keyed by change id. */
  edits?: unknown;
}

/**
 * Applies a hand edit to a change before approval.
 *
 * The reviewer may retype a description or the items of a list. Both go through
 * `sanitizeEditedText` — not because the admin is suspected, but because this is
 * the one path where arbitrary text can reach `data/` without having passed the
 * refresh pipeline, and `data/` is concatenated into the answer prompt.
 */
function applyEdit(
  change: IdentifiedChange,
  edit: unknown,
): { change: IdentifiedChange; error?: string } {
  if (edit === undefined || edit === null) return { change };

  if (change.op === 'replace-value' || change.op === 'add-entry') {
    if (typeof edit !== 'string') return { change, error: 'Edited value must be text' };
    const checked = sanitizeEditedText(change.path, edit, LIMITS.summary);
    if (!checked.ok || !checked.value) {
      return { change, error: checked.violations.map((v) => v.rule).join(', ') };
    }

    if (change.op === 'replace-value') {
      return { change: { ...change, after: checked.value } };
    }
    // For a new entry only the description is editable inline; the rest of the
    // entry is adapter-supplied identity that a text box has no business changing.
    const entry = change.after as Record<string, unknown>;
    return { change: { ...change, after: { ...entry, description: checked.value } } };
  }

  if (!Array.isArray(edit)) return { change, error: 'Edited items must be a list' };

  const accepted: string[] = [];
  for (const item of edit) {
    const checked = sanitizeEditedText(change.path, item, LIMITS.highlightItem);
    if (!checked.ok || !checked.value) {
      return { change, error: checked.violations.map((v) => v.rule).join(', ') };
    }
    accepted.push(checked.value);
  }

  if (accepted.length === 0) return { change, error: 'Nothing left after editing' };
  return { change: { ...change, after: accepted } };
}

export async function POST(request: Request) {
  if (!(await requireAdmin())) return unauthorized();

  let body: DecisionBody;
  try {
    body = (await request.json()) as DecisionBody;
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: 'No changes selected' }, { status: 400 });
  }

  if (body.action === 'unreject') {
    clearRejections(ids);
    logger.info('admin_unrejected', { count: ids.length });
    return NextResponse.json({ ok: true, pending: readPending(), rejections: readRejections() });
  }

  const pending = readPending();
  if (!pending) {
    return NextResponse.json({ error: 'Nothing pending' }, { status: 409 });
  }

  const selected = pending.changes.filter((change) => ids.includes(change.id));
  if (selected.length === 0) {
    return NextResponse.json({ error: 'Selected changes are no longer pending' }, { status: 409 });
  }

  if (body.action === 'reject') {
    recordRejections(selected);
    const remaining = removeFromPending(ids);
    logger.info('admin_rejected', { count: selected.length, paths: selected.map((c) => c.path) });
    return NextResponse.json({ ok: true, pending: remaining, rejections: readRejections() });
  }

  if (body.action !== 'approve') {
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  }

  const edits = (body.edits ?? {}) as Record<string, unknown>;
  const toApply: IdentifiedChange[] = [];

  for (const change of selected) {
    const result = applyEdit(change, edits[change.id]);
    if (result.error) {
      // Nothing is applied if any edit is rejected. A partial apply would leave
      // the reviewer guessing which half of their batch landed.
      logger.warn('admin_edit_rejected', { id: change.id, reason: result.error });
      return NextResponse.json(
        { error: `Edit to ${change.path} was rejected: ${result.error}` },
        { status: 400 },
      );
    }
    toApply.push(result.change);
  }

  applyChanges(toApply);
  // The assistant reads `data/` through a process-level cache, so without this
  // an approval would change the files and nothing a visitor could observe.
  invalidateProfileCache();

  const remaining = removeFromPending(ids);
  logger.info('admin_approved', {
    count: toApply.length,
    paths: toApply.map((c) => c.path),
    edited: Object.keys(edits).length,
  });

  return NextResponse.json({ ok: true, pending: remaining, rejections: readRejections() });
}
