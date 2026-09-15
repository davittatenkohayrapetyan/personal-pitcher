'use client';

import { useCallback, useRef, useState } from 'react';
import type { QAEntry } from '@/types';
import { askStream } from '@/lib/askStream';
import { LINKEDIN_URL } from '@/lib/constants';
import SuggestedQuestions from './SuggestedQuestions';
import QATimeline from './QATimeline';
import DavoAvatar from './DavoAvatar';

const SESSION_STORAGE_KEY = 'pp_session_id';

/**
 * A per-tab id, not a login. Generated once and kept in `sessionStorage` (so
 * it clears on tab close) purely so the server can fold the last few turns of
 * *this* conversation into the prompt for follow-up context — see
 * `src/lib/session.ts` for why it is never trusted as a security boundary.
 */
function getOrCreateSessionId(): string {
  if (typeof window === 'undefined') return '';
  const existing = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  window.sessionStorage.setItem(SESSION_STORAGE_KEY, id);
  return id;
}

/**
 * Openers chosen to invite the conversation Davit actually wants: architecture
 * and AI depth, ownership, and the "isn't he just a Java guy?" objection met
 * head-on rather than avoided.
 *
 * Every one of these is answerable from `data/` — a suggested question the
 * assistant has to decline is worse than no suggestion at all.
 */
const SUGGESTED_QUESTIONS = [
  'What is the most complex system Davit has modernized?',
  "Convince me Davit isn't just a Java guy",
  'Why hire a JVM architect for an AI role?',
  'What has Davit owned end to end?',
  'What does Davit want to work on next?',
  'How does this site actually work?',
] as const;

/**
 * Primary AI assistant panel — the page's main CTA.
 *
 * Answers stream token by token over SSE, with the server's workflow trail
 * arriving as `step` events before the first token, so a visitor watches the
 * pipeline resolve (including a live provider fallback) rather than staring at
 * a spinner for six seconds.
 */
export default function AssistantPanel() {
  const [entries, setEntries] = useState<QAEntry[]>([]);
  const [question, setQuestion] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  // Lazy initializer only, never rendered — safe across SSR/hydration (see
  // getOrCreateSessionId's comment).
  const [sessionId] = useState(getOrCreateSessionId);
  const [quota, setQuota] = useState<{ remaining: number; max: number } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const quotaExhausted = quota !== null && quota.remaining <= 0;
  /**
   * Drives the green pulse on the header avatar. Derived from the entries
   * rather than read off `isLoading` so it cannot disagree with the *answer's*
   * avatar in `QATimeline`, which reads `entry.streaming`: the two flags flip in
   * the same `finally`, but one avatar reverting while the other stayed green is
   * exactly the bug this rules out by construction.
   */
  const answering = entries.some((e) => e.streaming);

  const patchEntry = useCallback((id: string, patch: Partial<QAEntry>) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }, []);

  const handleSubmit = useCallback(
    async (q: string) => {
      const trimmed = q.trim();
      if (!trimmed || isLoading || quotaExhausted) return;

      setError('');
      setIsLoading(true);

      const id = crypto.randomUUID();
      setEntries((prev) => [
        ...prev,
        {
          id,
          question: trimmed,
          answer: '',
          timestamp: new Date(),
          steps: [],
          streaming: true,
        },
      ]);
      setQuestion('');

      // Accumulated locally so each token append is one state update, not a
      // read-modify-write against a stale entry.
      let answer = '';
      const steps: string[] = [];
      let failed = false;

      try {
        for await (const event of askStream(trimmed, sessionId)) {
          switch (event.type) {
            case 'step':
              steps.push(event.step);
              patchEntry(id, { steps: [...steps] });
              break;
            case 'token':
              answer += event.token;
              patchEntry(id, { answer });
              break;
            case 'meta':
              patchEntry(id, {
                intent: event.intent,
                modelsUsed: event.modelsUsed,
                durationMs: event.durationMs,
              });
              if (typeof event.questionsRemaining === 'number' && typeof event.questionsMax === 'number') {
                setQuota({ remaining: event.questionsRemaining, max: event.questionsMax });
              }
              break;
            case 'error':
              failed = true;
              setError(event.message);
              patchEntry(id, { error: event.message });
              break;
          }
        }
      } catch (err: unknown) {
        failed = true;
        const message = err instanceof Error ? err.message : 'Something went wrong';
        setError(message);
        patchEntry(id, { error: message });
      } finally {
        patchEntry(id, { streaming: false });
        // An empty answer with no explicit error still needs to say something.
        if (!failed && answer === '') {
          patchEntry(id, { error: 'No answer was returned. Please try again.' });
        }
        setIsLoading(false);
        inputRef.current?.focus();
      }
    },
    [isLoading, quotaExhausted, patchEntry, sessionId],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(question);
    }
  };

  return (
    <section
      aria-labelledby="assistant-heading"
      className="flex flex-col overflow-hidden rounded-3xl border border-violet-400/30 bg-slate-900/90 shadow-2xl shadow-violet-900/20"
    >
      <header className="flex items-start justify-between gap-3 border-b border-slate-400/10 px-6 py-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            {/* The heading beside it already says "Ask DAVO". */}
            <DavoAvatar className="h-8 w-8 flex-shrink-0 rounded-xl" alt="" thinking={answering} />
            <h2 id="assistant-heading" className="text-lg font-semibold text-white">
              Ask DAVO
            </h2>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            <span className="text-slate-300">Davit&apos;s Annoyingly Verbose Oracle.</span>{' '}
            Streaming answers from Davit&apos;s profile data — with the retrieval and
            fallback pipeline shown live under each one.
          </p>
        </div>
        <span
          className="hidden flex-shrink-0 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-emerald-300 sm:inline-flex"
          aria-label="Assistant status: online"
        >
          ● Online
        </span>
      </header>

      {/* Conversation area — tall on desktop so assistant feels like the main product */}
      <div className="scrollbar-thin flex-1 overflow-y-auto px-6 py-6 lg:min-h-[560px] lg:max-h-[620px]">
        {entries.length === 0 ? (
          <div className="flex h-full min-h-[200px] flex-col justify-start py-4">
            <div className="flex justify-start">
              <div className="max-w-[85%]">
                <div className="flex items-start gap-3">
                  {/* The bubble beside it opens with "Hi, I'm DAVO". This is the
                      empty state, so it is never mid-request. */}
                  <DavoAvatar className="h-8 w-8 flex-shrink-0 rounded-full" alt="" />
                  <div className="rounded-2xl rounded-tl-md border border-slate-700 bg-slate-800 px-4 py-3 text-slate-200 shadow-lg">
                    <p className="text-sm leading-relaxed">
                      Hi, I&apos;m DAVO — Davit&apos;s Annoyingly Verbose Oracle. Ask me
                      the hard questions: architecture calls he&apos;s made, what he owned
                      end to end, or why a JVM architect belongs anywhere near an AI team.
                    </p>
                    <p className="mt-2 text-sm leading-relaxed text-slate-400">
                      Every answer shows the pipeline that produced it — intent
                      classification, retrieval, and which model actually replied.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <QATimeline entries={entries} answering={answering} />
        )}
      </div>

      {/* Composer — pinned at the bottom of the panel */}
      <div className="border-t border-slate-400/10 bg-slate-950/60 px-6 py-6">
        {quotaExhausted ? (
          // Same server-side block already fired on the last answer above —
          // this replaces the composer so a visitor sees the wall instead of
          // firing a request that gets rejected anyway.
          <div className="rounded-2xl border border-violet-400/25 bg-violet-500/[0.07] px-4 py-4 text-center">
            <p className="text-sm leading-relaxed text-slate-200">
              That&apos;s the free questions used up for now. I&apos;d genuinely love to
              keep talking —
            </p>
            <a
              href={LINKEDIN_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-2 rounded-xl bg-gradient-to-br from-violet-500 to-sky-500 px-4 py-2 text-sm font-medium text-white shadow-md transition-all hover:from-violet-400 hover:to-sky-400"
            >
              Connect with Davit on LinkedIn
            </a>
          </div>
        ) : (
          <>
            <div className="mb-3">
              <SuggestedQuestions
                questions={SUGGESTED_QUESTIONS}
                onSelect={handleSubmit}
                disabled={isLoading}
              />
            </div>

            <label htmlFor="assistant-input" className="sr-only">
              Ask a question about Davit
            </label>
            <div className="relative rounded-2xl border border-slate-400/15 bg-slate-900 transition-colors focus-within:border-violet-400/60 focus-within:ring-1 focus-within:ring-violet-400/20">
              <textarea
                id="assistant-input"
                ref={inputRef}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask anything about Davit…"
                rows={2}
                maxLength={500}
                disabled={isLoading}
                aria-describedby="assistant-helper"
                className="block w-full resize-none rounded-2xl bg-transparent px-4 py-3 pr-24 text-sm leading-relaxed text-white placeholder-slate-500 focus:outline-none"
              />
              <div className="absolute bottom-2.5 right-2.5 flex items-center gap-2">
                <span className="text-[10px] tabular-nums text-slate-600">{question.length}/500</span>
                <button
                  type="button"
                  onClick={() => handleSubmit(question)}
                  disabled={!question.trim() || isLoading}
                  aria-label="Send question"
                  className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-sky-500 text-white shadow-md transition-all hover:from-violet-400 hover:to-sky-400 disabled:cursor-not-allowed disabled:from-slate-700 disabled:to-slate-700 disabled:text-slate-500"
                >
                  {isLoading ? (
                    <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  ) : (
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12l14-7-7 14-2-5-5-2z" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {error && (
              <p role="alert" className="mt-2 text-xs text-red-400">
                {error}
              </p>
            )}
            <p id="assistant-helper" className="mt-2 pl-1 text-xs text-slate-500">
              {quota && quota.remaining > 0
                ? `${quota.remaining} of ${quota.max} free questions left · `
                : ''}
              Enter to send · Shift+Enter for new line · Rate limited to 10 req/min
            </p>
          </>
        )}
      </div>
    </section>
  );
}
