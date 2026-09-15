'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  AppliedApplication,
  CompanySuggestion,
  OutreachRejection,
  QueuedOpportunity,
} from '@/lib/outreach/types';

/**
 * The outreach review surface: a queue, the company suggestions, and what has
 * already gone out.
 *
 * ## The card's reading order is the design
 *
 * §8 fixes it, and every item on it earns its place:
 *
 *  1. **Company, title and the posting link** — first, because the link is the
 *     only element on the card that is not a model's opinion. Everything below
 *     it is what the machine believes; this is what is true.
 *  2. **Eligibility with its quoted evidence, and the fit score with reasons.**
 *  3. **Flags as chips**, not buried in prose, because they are what a person
 *     scans for.
 *  4. **Key facts** — stack, seniority, engagement, location, compensation — or
 *     "not stated". Never guessed.
 *  5. **The message**, editable in place. Editing is the common case.
 *  6. **The three decisions**, together and equally weighted.
 *
 * ## Why three buttons and not a dismiss
 *
 * "Not interested" and "Already applied" are opposite instructions to the rest
 * of the system: the first suppresses the role and is *not* an application, so
 * it must not consume the per-company cooldown; the second says it is in the
 * history and feeds the duplicate guard exactly as a send does. A single
 * "dismiss" would get one of them wrong in each direction. `Snooze` is
 * deliberately not among the three, because postponing is not a decision and
 * should not feel like one.
 */

interface Snapshot {
  opportunities: QueuedOpportunity[];
  suggestions: CompanySuggestion[];
  applied: AppliedApplication[];
  rejections: OutreachRejection[];
  sentToday: number;
  capPerDay: number;
  dryRun: boolean;
}

type View = 'queue' | 'companies' | 'applied';
type Edits = Record<string, { subject: string; body: string }>;

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
}

function Chip({ children, tone = 'slate' }: { children: React.ReactNode; tone?: string }) {
  const tones: Record<string, string> = {
    slate: 'border-white/10 text-slate-300',
    amber: 'border-amber-400/30 bg-amber-500/10 text-amber-200',
    emerald: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200',
    rose: 'border-rose-400/30 bg-rose-500/10 text-rose-200',
    violet: 'border-violet-400/30 bg-violet-500/10 text-violet-200',
  };
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${tones[tone]}`}>
      {children}
    </span>
  );
}

const ELIGIBILITY_TONE: Record<string, string> = {
  eligible: 'emerald',
  needs_check: 'amber',
  ineligible: 'rose',
};

function KeyFacts({ item }: { item: QueuedOpportunity }) {
  const extracted = item.extracted;
  if (!extracted) return null;

  // "Not stated" is written out rather than left blank. A blank cell reads as a
  // bug; the words are the honest answer, and they are also the reason a
  // `salary_required` flag exists (§5).
  const rows: [string, string][] = [
    ['Stack', extracted.stack.join(', ') || 'not stated'],
    ['Seniority', extracted.seniority],
    ['Engagement', extracted.engagement],
    ['Work mode', extracted.workMode],
    ['Office', extracted.officeLocation || 'not stated'],
    ['Geo', extracted.geoRestriction || 'not stated'],
    ['Timezone', extracted.timezoneRequirement || 'not stated'],
    ['Compensation', extracted.compensation || 'not stated'],
    ['Apply via', extracted.applyTarget || extracted.applyMethod],
  ];

  return (
    <dl className="mt-3 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-slate-400">{label}</dt>
          <dd className={value === 'not stated' ? 'text-slate-400 italic' : 'text-slate-300'}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default function OutreachBoard({ initial }: { initial: Snapshot }) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [view, setView] = useState<View>('queue');
  const [edits, setEdits] = useState<Edits>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showRejected, setShowRejected] = useState(false);

  const now = Date.now();
  const queue = useMemo(
    () =>
      data.opportunities
        .filter((item) => !item.snoozedUntil || Date.parse(item.snoozedUntil) <= now)
        .sort((a, b) => (b.verdict?.fit ?? -1) - (a.verdict?.fit ?? -1)),
    [data.opportunities, now],
  );
  const snoozed = data.opportunities.length - queue.length;

  async function act(action: string, payload: Record<string, unknown>, key: string) {
    setBusy(key);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch('/api/admin/outreach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...payload }),
      });
      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(result.error ?? 'Something went wrong');
        return false;
      }

      setData(result);
      router.refresh();
      return true;
    } catch {
      setError('Network error');
      return false;
    } finally {
      setBusy(null);
    }
  }

  function draftFor(item: QueuedOpportunity) {
    return (
      edits[item.id] ?? {
        subject: item.draft?.subject ?? '',
        body: item.draft?.body ?? '',
      }
    );
  }

  function setDraft(id: string, patch: Partial<{ subject: string; body: string }>) {
    setEdits((current) => ({
      ...current,
      [id]: { ...(current[id] ?? { subject: '', body: '' }), ...patch },
    }));
  }

  const views: { id: View; label: string; count: number }[] = [
    { id: 'queue', label: 'Queue', count: queue.length },
    { id: 'companies', label: 'Company suggestions', count: data.suggestions.length },
    { id: 'applied', label: 'Applied', count: data.applied.length },
  ];

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Job outreach</h2>
          <p className="mt-1 text-sm text-slate-400">
            {queue.length} to review
            {snoozed > 0 && ` · ${snoozed} snoozed`}
            {/*
              "sent" is the wrong word while nothing is being sent, and it sat
              forty pixels under a banner saying so. The count is real — dry-run
              approvals do consume the daily cap, deliberately — but what they
              consume it as is an approval.
            */}
            {` · ${data.sentToday}/${data.capPerDay} ${data.dryRun ? 'approved' : 'sent'} today`}
          </p>
        </div>
        {data.dryRun && (
          // Stated on screen, not just in a log. Approving writes the ledger and
          // stops; a reviewer who thinks a message went out when it did not is
          // the worst possible state for this screen to leave someone in.
          <p className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200">
            Dry run — approving records the decision and sends nothing
          </p>
        )}
      </header>

      <div className="mb-6 flex gap-2">
        {views.map((entry) => (
          <button
            key={entry.id}
            onClick={() => setView(entry.id)}
            aria-pressed={view === entry.id}
            className={`rounded-lg px-3 py-1.5 text-xs transition-colors ${
              view === entry.id
                ? 'bg-white/10 text-white'
                : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
            }`}
          >
            {entry.label}
            {entry.count > 0 && <span className="ml-1.5 text-slate-500">{entry.count}</span>}
          </button>
        ))}
      </div>

      {error && (
        <p
          role="alert"
          className="mb-6 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
        >
          {error}
        </p>
      )}
      {notice && (
        <p className="mb-6 rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
          {notice}
        </p>
      )}

      {view === 'queue' && (
        <QueueView
          queue={queue}
          busy={busy}
          draftFor={draftFor}
          setDraft={setDraft}
          act={act}
          setNotice={setNotice}
        />
      )}

      {view === 'companies' && <CompaniesView suggestions={data.suggestions} busy={busy} act={act} />}

      {view === 'applied' && <AppliedView applied={data.applied} />}

      {view === 'queue' && data.rejections.length > 0 && (
        <section className="mt-10 border-t border-white/10 pt-6">
          <button
            onClick={() => setShowRejected((value) => !value)}
            className="text-sm text-slate-400 hover:text-slate-200"
            aria-expanded={showRejected}
          >
            {showRejected ? '▾' : '▸'} {data.rejections.length} previously rejected
          </button>
          <p className="mt-1 text-xs text-slate-400">
            These stay suppressed on every future run until un-rejected. Rejecting is not an
            application: it never touches the ledger or the per-company cooldown.
          </p>

          {showRejected && (
            <ul className="mt-4 space-y-2">
              {data.rejections.map((rejection) => (
                <li
                  key={rejection.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-white/5 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-slate-300">{rejection.summary}</p>
                    <p className="text-xs text-slate-400">
                      {rejection.kind} · {formatDate(rejection.rejectedAt)}
                    </p>
                  </div>
                  <button
                    onClick={() => act('unreject', { id: rejection.id }, rejection.id)}
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
    </div>
  );
}

function QueueView({
  queue,
  busy,
  draftFor,
  setDraft,
  act,
  setNotice,
}: {
  queue: QueuedOpportunity[];
  busy: string | null;
  draftFor: (item: QueuedOpportunity) => { subject: string; body: string };
  setDraft: (id: string, patch: Partial<{ subject: string; body: string }>) => void;
  act: (action: string, payload: Record<string, unknown>, key: string) => Promise<boolean>;
  setNotice: (value: string | null) => void;
}) {
  if (queue.length === 0) {
    return (
      <p className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-8 text-center text-sm text-slate-400">
        Nothing to review. A quiet morning is the expected state once the filters are right.
      </p>
    );
  }

  return (
    <ul className="space-y-4">
      {queue.map((item) => {
        const draft = draftFor(item);
        const verdict = item.verdict;

        return (
          <li key={item.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            {/* 1. The link first — the only thing here that is not an opinion. */}
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-white">
                  {item.company} · {item.title}
                </p>
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-0.5 block truncate text-xs text-violet-300 hover:text-violet-200 hover:underline"
                >
                  {item.url}
                </a>
              </div>
              <Chip>{item.source}</Chip>
            </div>

            {/* 2 and 3. The verdict, its evidence, and the flags as chips. */}
            {verdict ? (
              <div className="mb-3 space-y-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Chip tone={ELIGIBILITY_TONE[verdict.eligibility] ?? 'slate'}>
                    {verdict.eligibility.replace('_', ' ')}
                  </Chip>
                  <Chip tone={verdict.recommendation === 'draft' ? 'emerald' : 'violet'}>
                    {verdict.recommendation.replace('_', ' ')}
                  </Chip>
                  <Chip>fit {verdict.fit}</Chip>
                  {verdict.flags.map((flag) => (
                    <Chip key={flag} tone="amber">
                      {flag.replace(/_/g, ' ')}
                    </Chip>
                  ))}
                </div>

                {verdict.eligibilityEvidence && (
                  <blockquote className="border-l-2 border-white/10 pl-3 text-xs italic text-slate-400">
                    “{verdict.eligibilityEvidence}”
                  </blockquote>
                )}

                {verdict.reasons.length > 0 && (
                  <ul className="space-y-1 text-xs text-slate-400">
                    {verdict.reasons.map((reason, index) => (
                      <li key={index} className="flex gap-2">
                        <span aria-hidden className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-slate-600" />
                        {reason}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <p className="mb-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-xs text-slate-400">
                Unscored — no model was available when this was found. The next run that finds one
                will score it.
              </p>
            )}

            {/* 4. Key facts, or "not stated". Never guessed. */}
            <KeyFacts item={item} />

            {/* 5. The message. Editing is the common case, not the exception. */}
            <div className="mt-4 space-y-2">
              <input
                value={draft.subject}
                onChange={(event) => setDraft(item.id, { subject: event.target.value })}
                placeholder="Subject"
                aria-label={`Subject for ${item.title}`}
                className="w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-slate-100 focus:border-violet-400/50 focus:outline-none"
              />
              <textarea
                value={draft.body}
                onChange={(event) => setDraft(item.id, { body: event.target.value })}
                rows={5}
                placeholder="No draft yet — stage C arrives in phase 6. Write the message here."
                aria-label={`Message for ${item.title}`}
                className="w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-slate-100 focus:border-violet-400/50 focus:outline-none"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={async () => {
                    const saved = await act('save_draft', { id: item.id, edits: draft }, item.id);
                    if (saved) setNotice('Draft saved, paragraphs and all.');
                  }}
                  disabled={busy !== null}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-40"
                >
                  Save draft
                </button>
                {item.draft && (
                  <span className="text-xs text-slate-500">
                    saved {formatDate(item.draft.draftedAt)} · {item.draft.model}
                  </span>
                )}
              </div>
            </div>

            {/* 6. The three decisions, together and equally weighted. */}
            <div className="mt-4 flex flex-wrap gap-2 border-t border-white/5 pt-3">
              <button
                onClick={() => act('approve_send', { id: item.id, edits: draft }, item.id)}
                disabled={busy !== null}
                className="rounded-lg bg-emerald-600/90 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                Approve &amp; send
              </button>
              <button
                onClick={() => act('reject', { id: item.id }, item.id)}
                disabled={busy !== null}
                className="rounded-lg border border-rose-400/30 px-3 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-500/10 disabled:opacity-40"
              >
                Not interested
              </button>
              <button
                onClick={() => act('mark_applied', { id: item.id }, item.id)}
                disabled={busy !== null}
                className="rounded-lg border border-sky-400/30 px-3 py-1.5 text-xs font-semibold text-sky-200 hover:bg-sky-500/10 disabled:opacity-40"
              >
                Already applied
              </button>

              <span className="flex-1" />

              {item.status === 'awaiting_form' ? (
                <button
                  onClick={() => act('confirm_submitted', { id: item.id }, item.id)}
                  disabled={busy !== null}
                  className="rounded-lg border border-emerald-400/30 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-500/10 disabled:opacity-40"
                >
                  I submitted this
                </button>
              ) : (
                <button
                  onClick={async () => {
                    const done = await act('prepare_form', { id: item.id }, item.id);
                    if (done) {
                      setNotice(`Run on the host:  npm run outreach:form -- --id=${item.id}`);
                    }
                  }}
                  disabled={busy !== null}
                  className="rounded-lg px-3 py-1.5 text-xs text-slate-400 hover:bg-white/5 hover:text-slate-200 disabled:opacity-40"
                >
                  Prepare form
                </button>
              )}
              <button
                onClick={() => act('snooze', { id: item.id, days: 7 }, item.id)}
                disabled={busy !== null}
                className="rounded-lg px-3 py-1.5 text-xs text-slate-400 hover:bg-white/5 hover:text-slate-200 disabled:opacity-40"
              >
                Snooze 7d
              </button>
            </div>

            {item.status === 'awaiting_form' && (
              <p className="mt-2 text-xs text-amber-200/80">
                Awaiting a form submission. It is not counted as applied until you confirm.
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function CompaniesView({
  suggestions,
  busy,
  act,
}: {
  suggestions: CompanySuggestion[];
  busy: string | null;
  act: (action: string, payload: Record<string, unknown>, key: string) => Promise<boolean>;
}) {
  if (suggestions.length === 0) {
    return (
      <p className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-8 text-center text-sm text-slate-400">
        No company suggestions. The 07:00 discovery job that produces them arrives in phase 5.
      </p>
    );
  }

  return (
    <ul className="space-y-4">
      {suggestions.map((suggestion) => (
        <li key={suggestion.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <div className="mb-2 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-white">{suggestion.name}</p>
              <a
                href={suggestion.careersUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-0.5 block truncate text-xs text-violet-300 hover:underline"
              >
                {suggestion.careersUrl}
              </a>
            </div>
            <Chip>{suggestion.ats}</Chip>
          </div>

          {/* Shown in full, because the endpoint is the thing that was verified. */}
          <p className="mb-2 break-all rounded-lg border border-white/5 bg-slate-900/60 px-3 py-2 font-mono text-[11px] text-slate-400">
            {suggestion.endpoint}
          </p>
          <p className="mb-3 text-xs text-slate-400">
            {suggestion.postingCount} posting(s) returned · {suggestion.eligibleCount} pass the
            Yerevan filter today
          </p>

          <p className="mb-3 text-sm text-slate-300">{suggestion.why}</p>

          {suggestion.evidence.length > 0 && (
            <ul className="mb-3 space-y-1">
              {suggestion.evidence.map((entry) => (
                <li key={entry.url} className="truncate text-xs">
                  <a
                    href={entry.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-violet-300 hover:underline"
                  >
                    {entry.title}
                  </a>
                </li>
              ))}
            </ul>
          )}

          {suggestion.displaces && (
            <p className="mb-3 text-xs text-amber-200">
              The watch list is at its cap — adding this displaces {suggestion.displaces}.
            </p>
          )}

          <div className="flex gap-2 border-t border-white/5 pt-3">
            <button
              onClick={() => act('company_add', { id: suggestion.id }, suggestion.id)}
              disabled={busy !== null}
              className="rounded-lg bg-emerald-600/90 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
            >
              Add to watch list
            </button>
            <button
              onClick={() => act('company_reject', { id: suggestion.id }, suggestion.id)}
              disabled={busy !== null}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-40"
            >
              Reject
            </button>
          </div>
          <p className="mt-2 text-xs text-slate-400">
            Adding appends to <code className="text-slate-400">data/outreach/companies.json</code>,
            which is committed — the change shows up in <code className="text-slate-400">git diff</code>.
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * What went out, when, through which channel, and what was said.
 *
 * §8.1's last line: this is the answer to "what did we tell them?" a month later
 * when someone replies. It is also the list that makes the `manual` channel
 * visible — a row Davit recorded himself and a row the system sent must never
 * look alike.
 */
function AppliedView({ applied }: { applied: AppliedApplication[] }) {
  if (applied.length === 0) {
    return (
      <p className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-8 text-center text-sm text-slate-400">
        Nothing in the ledger yet. Seeding it with everything applied to in the last six months is
        part of phase 6 — nothing automatic can know about those.
      </p>
    );
  }

  const ordered = [...applied].sort((a, b) => Date.parse(b.appliedAt) - Date.parse(a.appliedAt));

  return (
    <ul className="space-y-3">
      {ordered.map((entry, index) => (
        <li
          key={`${entry.dedupeHash}-${index}`}
          className="rounded-xl border border-white/10 bg-white/[0.03] p-4"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-white">
                {entry.company} · {entry.title}
              </p>
              {entry.url && (
                <a
                  href={entry.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-0.5 block truncate text-xs text-violet-300 hover:underline"
                >
                  {entry.url}
                </a>
              )}
            </div>
            <div className="flex flex-shrink-0 flex-col items-end gap-1">
              <Chip tone={entry.channel === 'manual' ? 'slate' : 'emerald'}>{entry.channel}</Chip>
              {entry.dryRun && <Chip tone="amber">dry run</Chip>}
            </div>
          </div>

          <p className="mt-1 text-xs text-slate-400">{formatDate(entry.appliedAt)}</p>

          {entry.body && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-slate-400 hover:text-slate-200">
                {/* Nothing reached that address on a dry run, so the disclosure
                    must not claim it did. */}
                {entry.dryRun ? 'What would have been sent' : 'What was sent'}
              </summary>
              <p className="mt-2 text-xs text-slate-400">
                <span className="text-slate-400">{entry.dryRun ? 'Would go to:' : 'To:'}</span>{' '}
                {entry.to || '—'}
                <br />
                <span className="text-slate-400">Subject:</span> {entry.subject}
              </p>
              <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-white/5 bg-slate-900/60 p-3 text-xs text-slate-300">
                {entry.body}
              </pre>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}
