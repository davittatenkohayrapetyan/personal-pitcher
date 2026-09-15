'use client';

import { useEffect, useRef } from 'react';
import DavoAvatar from './DavoAvatar';
import type { QAEntry } from '@/types';
import Markdown from './Markdown';
import PipelineTrace from './PipelineTrace';
import WaitingIndicator from './WaitingIndicator';

interface QATimelineProps {
  entries: QAEntry[];
  /**
   * True while any request is in flight. Every avatar in the thread pulses on
   * it, not just the answer currently being written — the orbs read as one
   * assistant thinking, rather than one live avatar beside a row of dead ones.
   */
  answering: boolean;
}

const INTENT_LABELS: Record<string, { label: string; color: string }> = {
  background: { label: 'Career', color: 'bg-blue-500/20 text-blue-300 border-blue-500/30' },
  projects: { label: 'Projects', color: 'bg-green-500/20 text-green-300 border-green-500/30' },
  community: { label: 'Community', color: 'bg-purple-500/20 text-purple-300 border-purple-500/30' },
  hobbies: { label: 'Hobbies', color: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
  music: { label: 'Music', color: 'bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/30' },
  contact: { label: 'Contact', color: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30' },
  general: { label: 'General', color: 'bg-slate-500/20 text-slate-300 border-slate-500/30' },
  off_topic: { label: 'Off Topic', color: 'bg-red-500/20 text-red-300 border-red-500/30' },
};

export default function QATimeline({ entries, answering }: QATimelineProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Depend on the token count of the last entry so the view keeps pace with a
  // streaming answer instead of only scrolling once it finishes.
  const lastEntry = entries[entries.length - 1];
  const streamProgress = lastEntry ? lastEntry.answer.length : 0;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [entries.length, streamProgress]);

  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="space-y-6">
      {entries.map((entry) => {
        // Waiting on the first token: steps may already be arriving.
        const awaitingFirstToken = Boolean(entry.streaming) && entry.answer === '';
        const intentInfo = entry.intent ? INTENT_LABELS[entry.intent] : null;

        return (
          <div key={entry.id} className="group">
            {/* Question */}
            <div className="mb-3 flex justify-end">
              <div className="max-w-[85%] md:max-w-[70%]">
                <div className="rounded-2xl rounded-tr-md bg-blue-600 px-4 py-3 text-white shadow-lg">
                  <p className="text-sm leading-relaxed break-words">{entry.question}</p>
                </div>
                <p className="mt-1 px-1 text-right text-xs text-slate-500">
                  {new Date(entry.timestamp).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
              </div>
            </div>

            {/* Answer */}
            <div className="flex justify-start">
              <div className="max-w-[85%] md:max-w-[70%]">
                <div className="flex items-start gap-3">
                  {/* Nothing else in the answer bubble names the speaker. */}
                  <DavoAvatar
                    className="h-8 w-8 flex-shrink-0 rounded-full"
                    thinking={answering}
                  />
                  <div className="min-w-0 flex-1">
                    <div
                      className="rounded-2xl rounded-tl-md border border-slate-700 bg-slate-800 px-4 py-3 text-slate-200 shadow-lg"
                      aria-live={entry.streaming ? 'polite' : undefined}
                    >
                      {awaitingFirstToken ? (
                        <WaitingIndicator
                          steps={entry.steps ?? []}
                          startedAt={entry.timestamp}
                        />
                      ) : (
                        <>
                          <Markdown>{entry.answer}</Markdown>
                          {entry.streaming && (
                            <span className="streaming-caret text-violet-300" aria-hidden="true">
                              ▍
                            </span>
                          )}
                        </>
                      )}
                      {entry.error && (
                        <p role="alert" className="mt-2 text-xs text-red-400">
                          {entry.error}
                        </p>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {intentInfo && !entry.streaming && (
                        <span
                          className={`mt-1.5 inline-block rounded-full border px-2 py-0.5 text-xs ${intentInfo.color}`}
                        >
                          {intentInfo.label}
                        </span>
                      )}
                      <PipelineTrace
                        steps={entry.steps ?? []}
                        durationMs={entry.durationMs}
                        modelsUsed={entry.modelsUsed}
                        live={entry.streaming}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
