'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PendingProposal, IdentifiedChange, RejectionRecord } from '@/lib/refresh/store';

/**
 * The profile-update tab: one card per proposed change, each approvable,
 * rejectable or editable in place.
 *
 * It renders a `<div>` rather than the `<main>` it used to, because `/admin` is
 * now a tab shell and two `<main>` elements on one page is both invalid and a
 * real problem for anyone navigating by landmark. The page chrome — the
 * heading and Sign out — moved up with it.
 *
 * Two things it deliberately shows rather than hides:
 *
 *  - **The current value next to the proposed one.** A diff without its baseline
 *    is a request to trust the job, and the entire reason this screen exists is
 *    that the job is not trusted unattended.
 *  - **Rejections, with an undo.** Rejecting is the only durable decision here —
 *    it suppresses that change on every future run — so it needs to be visible
 *    and reversible rather than a button that makes a row vanish forever.
 */

interface Props {
  initialPending: PendingProposal | null;
  initialRejections: RejectionRecord[];
}

type EditMap = Record<string, string | string[]>;

function isListChange(change: IdentifiedChange): boolean {
  return change.op === 'add-items';
}

function describeTarget(change: IdentifiedChange): string {
  if (change.op === 'add-entry') {
    const entry = change.after as { name?: string };
    return `New project: ${entry?.name ?? 'unknown'}`;
  }
  return change.path;
}

function ChangeBody({
  change,
  edit,
  onEdit,
}: {
  change: IdentifiedChange;
  edit: string | string[] | undefined;
  onEdit: (value: string | string[]) => void;
}) {
  if (change.op === 'add-entry') {
    const entry = change.after as Record<string, unknown>;
    return (
      <div className="space-y-2">
        <textarea
          value={typeof edit === 'string' ? edit : String(entry.description ?? '')}
          onChange={(e) => onEdit(e.target.value)}
          rows={3}
          className="w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-slate-100 focus:border-violet-400/50 focus:outline-none"
        />
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-slate-400">
          <dt>URL</dt>
          <dd className="truncate text-slate-300">{String(entry.url ?? '')}</dd>
          <dt>Tech</dt>
          <dd className="text-slate-300">{(entry.tech as string[])?.join(', ') || '—'}</dd>
          <dt>Highlights</dt>
          <dd className="text-slate-300">{(entry.highlights as string[])?.length ?? 0}</dd>
        </dl>
      </div>
    );
  }

  if (isListChange(change)) {
    const items = Array.isArray(edit) ? edit : (change.after as unknown[]).map((i) => typeof i === 'string' ? i : JSON.stringify(i));
    return (
      <ul className="space-y-1.5">
        {items.map((item, index) => (
          <li key={index} className="flex gap-2">
            <span aria-hidden className="mt-2 h-1 w-1 flex-shrink-0 rounded-full bg-emerald-400" />
            <input
              value={item}
              onChange={(e) => {
                const next = [...items];
                next[index] = e.target.value;
                onEdit(next);
              }}
              className="w-full rounded border border-white/10 bg-slate-900/60 px-2 py-1 text-sm text-slate-100 focus:border-violet-400/50 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => onEdit(items.filter((_, i) => i !== index))}
              className="rounded px-2 text-xs text-slate-500 hover:text-rose-300"
              aria-label={`Remove item ${index + 1}`}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="space-y-2">
      {change.before !== undefined && (
        <p className="rounded-lg border border-white/5 bg-rose-500/5 px-3 py-2 text-sm text-slate-400 line-through decoration-rose-400/40">
          {String(change.before)}
        </p>
      )}
      <textarea
        value={typeof edit === 'string' ? edit : String(change.after)}
        onChange={(e) => onEdit(e.target.value)}
        rows={3}
        className="w-full rounded-lg border border-emerald-400/20 bg-emerald-500/5 px-3 py-2 text-sm text-slate-100 focus:border-violet-400/50 focus:outline-none"
      />
    </div>
  );
}

export default function ReviewBoard({ initialPending, initialRejections }: Props) {
  const router = useRouter();
  const [pending, setPending] = useState(initialPending);
  const [rejections, setRejections] = useState(initialRejections);
  const [edits, setEdits] = useState<EditMap>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRejected, setShowRejected] = useState(false);

  const changes = useMemo(() => pending?.changes ?? [], [pending]);

  async function decide(action: 'approve' | 'reject' | 'unreject', ids: string[]) {
    setBusy(ids.join(',') || action);
    setError(null);

    try {
      const response = await fetch('/api/admin/proposal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          ids,
          // Only the edits for the changes being acted on, so a half-typed edit
          // elsewhere on the page cannot ride along with an unrelated approval.
          edits: action === 'approve'
            ? Object.fromEntries(ids.filter((id) => id in edits).map((id) => [id, edits[id]]))
            : undefined,
        }),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(payload.error ?? 'Something went wrong');
        return;
      }

      setPending(payload.pending ?? null);
      setRejections(payload.rejections ?? []);
      setEdits((current) => {
        const next = { ...current };
        for (const id of ids) delete next[id];
        return next;
      });
      // The public page reads `data/` server-side; refresh so an approval is
      // reflected rather than sitting behind the router cache.
      router.refresh();
    } catch {
      setError('Network error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <header className="mb-6">
        <h2 className="text-lg font-semibold text-white">Pending profile updates</h2>
        <p className="mt-1 text-sm text-slate-400">
          {pending
            ? `${changes.length} change${changes.length === 1 ? '' : 's'} from the run at ${new Date(pending.generatedAt).toLocaleString()}`
            : 'Nothing pending — the profile matches every source.'}
        </p>
      </header>

      {error && (
        <p role="alert" className="mb-6 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {error}
        </p>
      )}

      {changes.length > 0 && (
        <div className="mb-6 flex gap-2">
          <button
            onClick={() => decide('approve', changes.map((c) => c.id))}
            disabled={busy !== null}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
          >
            Approve all
          </button>
          <button
            onClick={() => decide('reject', changes.map((c) => c.id))}
            disabled={busy !== null}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-40"
          >
            Reject all
          </button>
        </div>
      )}

      <ul className="space-y-4">
        {changes.map((change) => (
          <li key={change.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-white">{describeTarget(change)}</p>
                <p className="mt-0.5 text-xs text-slate-400">{change.reason}</p>
              </div>
              <span className="flex-shrink-0 rounded-full border border-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
                {change.source}
              </span>
            </div>

            <ChangeBody
              change={change}
              edit={edits[change.id]}
              onEdit={(value) => setEdits((current) => ({ ...current, [change.id]: value }))}
            />

            <div className="mt-3 flex gap-2">
              <button
                onClick={() => decide('approve', [change.id])}
                disabled={busy !== null}
                className="rounded-lg bg-emerald-600/90 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                {edits[change.id] !== undefined ? 'Approve edited' : 'Approve'}
              </button>
              <button
                onClick={() => decide('reject', [change.id])}
                disabled={busy !== null}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-40"
              >
                Reject
              </button>
              {edits[change.id] !== undefined && (
                <button
                  onClick={() =>
                    setEdits((current) => {
                      const next = { ...current };
                      delete next[change.id];
                      return next;
                    })
                  }
                  className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:text-slate-300"
                >
                  Undo edit
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {rejections.length > 0 && (
        <section className="mt-10 border-t border-white/10 pt-6">
          <button
            onClick={() => setShowRejected((v) => !v)}
            className="text-sm text-slate-400 hover:text-slate-200"
            aria-expanded={showRejected}
          >
            {showRejected ? '▾' : '▸'} {rejections.length} previously rejected
          </button>
          <p className="mt-1 text-xs text-slate-500">
            These stay suppressed on every future run until un-rejected.
          </p>

          {showRejected && (
            <ul className="mt-4 space-y-2">
              {rejections.map((rejection) => (
                <li
                  key={rejection.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-white/5 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-slate-300">{rejection.summary}</p>
                    <p className="text-xs text-slate-500">
                      {new Date(rejection.rejectedAt).toLocaleDateString()}
                    </p>
                  </div>
                  <button
                    onClick={() => decide('unreject', [rejection.id])}
                    disabled={busy !== null}
                    className="flex-shrink-0 rounded-lg border border-white/10 px-2.5 py-1 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-40"
                  >
                    Un-reject
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <p className="mt-10 text-xs text-slate-500">
        Approving writes to <code className="text-slate-400">data/</code> and the assistant picks it
        up on the next question. The explore cards import their JSON at build time, so those still
        need a rebuild.
      </p>
    </div>
  );
}
