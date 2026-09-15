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
  const [filters, setFilters] = useState<QueueFilters>(NO_FILTERS);
  const [sort, setSort] = useState<SortKey>('fit');

  const now = Date.now();
  const queue = useMemo(
    () =>
      data.opportunities
        .filter((item) => !item.snoozedUntil || Date.parse(item.snoozedUntil) <= now)
        .sort((a, b) => (b.verdict?.fit ?? -1) - (a.verdict?.fit ?? -1)),
    [data.opportunities, now],
  );
  const snoozed = data.opportunities.length - queue.length;
  // What the list actually renders. Kept apart from `queue`, which is what the
  // header and the tab badge count: a filter narrows what you are looking at,
  // not how much is waiting for a decision.
  const visible = useMemo(() => visibleQueue(queue, filters, sort), [queue, filters, sort]);

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
      // A server-sent notice outranks whatever the caller was going to say: it
      // is the one that knows something the browser does not, such as a draft
      // having been written without the preference doc behind it.
      if (typeof result.notice === 'string') setNotice(result.notice);
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

  /**
   * Forgets local edits for one card, so what the server just wrote is what
   * shows.
   *
   * Deleting the key rather than blanking the values, and the difference is the
   * whole thing: `draftFor` falls back to `item.draft` with `??`, which does not
   * treat an empty string as absent. Setting both fields to `''` therefore left
   * a 90-second draft written to `pending.json` and invisible on screen, with
   * Save and Approve both refusing an empty subject underneath it.
   */
  function forgetEdits(id: string) {
    setEdits((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
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
        <>
          {queue.length > 0 && (
            <QueueToolbar
              queue={queue}
              filters={filters}
              setFilters={setFilters}
              sort={sort}
              setSort={setSort}
              shown={visible.length}
            />
          )}
          <QueueView
            queue={visible}
            filtered={visible.length !== queue.length}
            busy={busy}
            draftFor={draftFor}
            setDraft={setDraft}
            forgetEdits={forgetEdits}
            act={act}
            setNotice={setNotice}
          />
        </>
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

type SortKey = 'fit' | 'company' | 'newest' | 'oldest';

interface QueueFilters {
  company: string;
  eligibility: string;
  status: string;
  minFit: number;
  search: string;
}

const NO_FILTERS: QueueFilters = {
  company: 'all',
  eligibility: 'all',
  status: 'all',
  minFit: 0,
  search: '',
};

/**
 * Applies the toolbar, in one place, so the list a person sees and the count
 * above it can never disagree.
 *
 * Filtering is deliberately *not* applied to the tab badge or to the "N to
 * review" line in the header: those answer "how much is waiting?", which a
 * filter does not change. Only this list narrows.
 */
function visibleQueue(queue: QueuedOpportunity[], filters: QueueFilters, sort: SortKey) {
  const needle = filters.search.trim().toLowerCase();

  const filtered = queue.filter((item) => {
    if (filters.company !== 'all' && item.company !== filters.company) return false;
    if (filters.eligibility !== 'all' && item.verdict?.eligibility !== filters.eligibility) return false;
    if (filters.status === 'scored' && !item.verdict) return false;
    if (filters.status === 'unscored' && item.verdict) return false;
    if (filters.status === 'drafted' && !item.draft?.body) return false;
    if (filters.status === 'undrafted' && item.draft?.body) return false;
    // An unscored card has no fit, and a floor is a statement about scores --
    // so a floor above zero hides them rather than treating "no verdict" as
    // zero, which would bury exactly the cards that need a second run.
    if (filters.minFit > 0 && (item.verdict?.fit ?? -1) < filters.minFit) return false;
    if (needle && !`${item.company} ${item.title}`.toLowerCase().includes(needle)) return false;
    return true;
  });

  const byFit = (a: QueuedOpportunity, b: QueuedOpportunity) =>
    (b.verdict?.fit ?? -1) - (a.verdict?.fit ?? -1);

  return [...filtered].sort((a, b) => {
    switch (sort) {
      case 'company':
        // Company first, then best-scoring role within it: the point of
        // grouping by employer is to decide about the employer, and the
        // strongest role is the one that decision hangs on.
        return a.company.localeCompare(b.company) || byFit(a, b);
      case 'newest':
        return Date.parse(b.discoveredAt) - Date.parse(a.discoveredAt);
      case 'oldest':
        return Date.parse(a.discoveredAt) - Date.parse(b.discoveredAt);
      default:
        return byFit(a, b);
    }
  });
}

const SELECT_CLASS =
  'rounded-lg border border-white/10 bg-slate-900/60 px-2 py-1.5 text-xs text-slate-200 focus:border-violet-400/50 focus:outline-none';

function QueueToolbar({
  queue,
  filters,
  setFilters,
  sort,
  setSort,
  shown,
}: {
  queue: QueuedOpportunity[];
  filters: QueueFilters;
  setFilters: (next: QueueFilters) => void;
  sort: SortKey;
  setSort: (next: SortKey) => void;
  shown: number;
}) {
  // Built from the queue rather than from the watch list: a card can come from
  // an aggregator, so the employers in the queue are not the companies being
  // watched, and offering a filter that matches nothing is worse than offering
  // none.
  const companies = useMemo(
    () => [...new Set(queue.map((item) => item.company))].sort((a, b) => a.localeCompare(b)),
    [queue],
  );

  const dirty = shown !== queue.length;
  const set = (patch: Partial<QueueFilters>) => setFilters({ ...filters, ...patch });

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2.5">
      <label className="sr-only" htmlFor="queue-search">
        Search the queue by company or title
      </label>
      <input
        id="queue-search"
        value={filters.search}
        onChange={(event) => set({ search: event.target.value })}
        placeholder="Search company or title"
        className="min-w-[10rem] flex-1 rounded-lg border border-white/10 bg-slate-900/60 px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:border-violet-400/50 focus:outline-none"
      />

      <label className="sr-only" htmlFor="queue-company">
        Filter by company
      </label>
      <select
        id="queue-company"
        value={filters.company}
        onChange={(event) => set({ company: event.target.value })}
        className={SELECT_CLASS}
      >
        <option value="all">All companies</option>
        {companies.map((company) => (
          <option key={company} value={company}>
            {company}
          </option>
        ))}
      </select>

      <label className="sr-only" htmlFor="queue-fit">
        Minimum fit
      </label>
      <select
        id="queue-fit"
        value={filters.minFit}
        onChange={(event) => set({ minFit: Number(event.target.value) })}
        className={SELECT_CLASS}
      >
        <option value={0}>Any fit</option>
        <option value={40}>fit 40+</option>
        <option value={60}>fit 60+</option>
        <option value={80}>fit 80+</option>
      </select>

      <label className="sr-only" htmlFor="queue-eligibility">
        Filter by eligibility
      </label>
      <select
        id="queue-eligibility"
        value={filters.eligibility}
        onChange={(event) => set({ eligibility: event.target.value })}
        className={SELECT_CLASS}
      >
        <option value="all">Any eligibility</option>
        <option value="eligible">eligible</option>
        <option value="needs_check">needs check</option>
        <option value="ineligible">ineligible</option>
      </select>

      <label className="sr-only" htmlFor="queue-status">
        Filter by status
      </label>
      <select
        id="queue-status"
        value={filters.status}
        onChange={(event) => set({ status: event.target.value })}
        className={SELECT_CLASS}
      >
        <option value="all">Any status</option>
        <option value="scored">scored</option>
        <option value="unscored">unscored</option>
        <option value="drafted">has a draft</option>
        <option value="undrafted">no draft yet</option>
      </select>

      <label className="sr-only" htmlFor="queue-sort">
        Sort the queue
      </label>
      <select
        id="queue-sort"
        value={sort}
        onChange={(event) => setSort(event.target.value as SortKey)}
        className={SELECT_CLASS}
      >
        <option value="fit">Best fit first</option>
        <option value="company">By company</option>
        <option value="newest">Newest first</option>
        <option value="oldest">Oldest first</option>
      </select>

      <span className="text-xs text-slate-500" aria-live="polite">
        {dirty ? `${shown} of ${queue.length}` : `${queue.length} card${queue.length === 1 ? '' : 's'}`}
      </span>

      {dirty && (
        <button
          onClick={() => setFilters(NO_FILTERS)}
          className="rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-white/5 hover:text-slate-200"
        >
          Clear
        </button>
      )}
    </div>
  );
}

function QueueView({
  queue,
  filtered,
  busy,
  draftFor,
  setDraft,
  forgetEdits,
  act,
  setNotice,
}: {
  queue: QueuedOpportunity[];
  /** True when the toolbar is hiding cards, so an empty list can say which empty it is. */
  filtered: boolean;
  busy: string | null;
  draftFor: (item: QueuedOpportunity) => { subject: string; body: string };
  setDraft: (id: string, patch: Partial<{ subject: string; body: string }>) => void;
  forgetEdits: (id: string) => void;
  act: (action: string, payload: Record<string, unknown>, key: string) => Promise<boolean>;
  setNotice: (value: string | null) => void;
}) {
  if (queue.length === 0) {
    return (
      <p className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-8 text-center text-sm text-slate-400">
        {filtered
          ? 'No cards match these filters. Clear them to see the rest of the queue.'
          : 'Nothing to review. A quiet morning is the expected state once the filters are right.'}
      </p>
    );
  }

  return (
    <ul className="space-y-4">
      {queue.map((item) => {
        const draft = draftFor(item);
        const drafting = busy === `${item.id}:draft`;
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
                placeholder="No draft yet. Generate one on the Mac, or write it here."
                aria-label={`Message for ${item.title}`}
                className="w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-slate-100 focus:border-violet-400/50 focus:outline-none"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={async () => {
                    const written = await act('generate_draft', { id: item.id }, `${item.id}:draft`);
                    if (written) {
                      // The edit buffer has to be dropped, or the box keeps
                      // showing whatever was in it and the new draft is
                      // invisible until a reload.
                      forgetEdits(item.id);
                      setNotice('Drafted. Read it before you approve it — it is a first attempt, not a send.');
                    }
                  }}
                  disabled={busy !== null || !item.extracted}
                  title={
                    item.extracted
                      ? 'Writes a subject and message on the Mac from your profile and this posting'
                      : 'Nothing to draft from yet — stage A has not read this posting'
                  }
                  className="rounded-lg border border-violet-400/30 px-3 py-1.5 text-xs font-semibold text-violet-200 hover:bg-violet-500/10 disabled:opacity-40"
                >
                  {busy === `${item.id}:draft` ? 'Drafting on the Mac…' : 'Generate draft'}
                </button>
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
                {drafting ? (
                  // Said out loud because it is true and because the button is
                  // disabled for the whole time: a local model on a laptop
                  // takes 45-90 seconds, and a screen that looks stuck for a
                  // minute gets clicked again.
                  <span className="text-xs text-violet-300" aria-live="polite">
                    up to 90 seconds — the model runs on the Mac, not in the cloud
                  </span>
                ) : (
                  item.draft && (
                    <span className="text-xs text-slate-500">
                      saved {formatDate(item.draft.draftedAt)} · {item.draft.model}
                    </span>
                  )
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
        No company suggestions. The 07:00 discovery job proposes one or two on the mornings it
        can verify them, and says nothing on the mornings it cannot — which is the expected
        state once the watch list is healthy.
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
