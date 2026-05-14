'use client';

import { useRef, useState } from 'react';
import Image from 'next/image';
import type { QAEntry } from '@/types';
import SuggestedQuestions from './SuggestedQuestions';
import QATimeline from './QATimeline';

const SUGGESTED_QUESTIONS = [
  'What projects has Davit built?',
  "What is Davit's tech stack?",
  "Tell me about Davit's community work",
  "What are Davit's hobbies?",
  'How can I contact Davit?',
] as const;

/**
 * Primary AI assistant panel — the page's main CTA.
 * Renders suggested questions, a question input, and the live Q&A history.
 */
export default function AssistantPanel() {
  const [entries, setEntries] = useState<QAEntry[]>([]);
  const [question, setQuestion] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const upsertEntry = (entry: QAEntry) => {
    setEntries((prev) => {
      const i = prev.findIndex((e) => e.id === entry.id);
      if (i >= 0) {
        const next = [...prev];
        next[i] = entry;
        return next;
      }
      return [...prev, entry];
    });
  };

  const handleSubmit = async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed || isLoading) return;

    setError('');
    setIsLoading(true);

    const optimistic: QAEntry = {
      id: crypto.randomUUID(),
      question: trimmed,
      answer: '...',
      timestamp: new Date(),
    };
    upsertEntry(optimistic);

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to get answer');
      upsertEntry({ ...optimistic, answer: data.answer, intent: data.intent });
      setQuestion('');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Something went wrong';
      setError(message);
      upsertEntry({ ...optimistic, answer: `Error: ${message}` });
    } finally {
      setIsLoading(false);
      inputRef.current?.focus();
    }
  };

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
            <div className="relative h-8 w-8 flex-shrink-0 overflow-hidden rounded-xl shadow">
              <Image src="/photos/avatar.png" alt="Davo" fill className="object-cover" />
            </div>
            <h2 id="assistant-heading" className="text-lg font-semibold text-white">
              Ask Davo
            </h2>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            Davit&apos;s AI buddy for professional background, projects, and community work.
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
                  <div className="relative h-8 w-8 flex-shrink-0 overflow-hidden rounded-full shadow">
                    <Image src="/photos/avatar.png" alt="Davo" fill className="object-cover" />
                  </div>
                  <div className="rounded-2xl rounded-tl-md border border-slate-700 bg-slate-800 px-4 py-3 text-slate-200 shadow-lg">
                    <p className="text-sm leading-relaxed">
                      Hi, I&apos;m Davo — Davit&apos;s AI buddy. Ask me about his engineering background, projects, community work, or creative side.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <QATimeline entries={entries} />
        )}
      </div>

      {/* Composer — pinned at the bottom of the panel */}
      <div className="border-t border-slate-400/10 bg-slate-950/60 px-6 py-6">
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
            className="block w-full resize-none rounded-2xl bg-transparent px-4 py-3 pr-16 text-sm leading-relaxed text-white placeholder-slate-500 focus:outline-none"
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
          Enter to send · Shift+Enter for new line · Rate limited to 10 req/min
        </p>
      </div>
    </section>
  );
}
