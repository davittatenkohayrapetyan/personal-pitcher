'use client';

import { useEffect, useRef } from 'react';
import type { QAEntry } from '@/types';

interface QATimelineProps {
  entries: QAEntry[];
}

const INTENT_LABELS: Record<string, { label: string; color: string }> = {
  background: { label: 'Career', color: 'bg-blue-500/20 text-blue-300 border-blue-500/30' },
  projects: { label: 'Projects', color: 'bg-green-500/20 text-green-300 border-green-500/30' },
  community: { label: 'Community', color: 'bg-purple-500/20 text-purple-300 border-purple-500/30' },
  hobbies: { label: 'Hobbies', color: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
  contact: { label: 'Contact', color: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30' },
  general: { label: 'General', color: 'bg-slate-500/20 text-slate-300 border-slate-500/30' },
  off_topic: { label: 'Off Topic', color: 'bg-red-500/20 text-red-300 border-red-500/30' },
};

function TypingIndicator() {
  return (
    <div className="flex gap-1 items-center px-1">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="w-2 h-2 rounded-full bg-slate-400 animate-bounce"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </div>
  );
}

export default function QATimeline({ entries }: QATimelineProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries]);

  if (entries.length === 0) {
    return (
      <div className="text-center py-12">
        <div className="text-5xl mb-4">💬</div>
        <p className="text-slate-400 text-lg">No questions yet.</p>
        <p className="text-slate-500 text-sm mt-1">Ask Davit&apos;s AI assistant something above!</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {entries.map((entry) => {
        const isLoading = entry.answer === '...';
        const intentInfo = entry.intent ? INTENT_LABELS[entry.intent] : null;

        return (
          <div key={entry.id} className="group">
            {/* Question */}
            <div className="flex justify-end mb-3">
              <div className="max-w-[85%] md:max-w-[70%]">
                <div className="bg-blue-600 text-white rounded-2xl rounded-tr-md px-4 py-3 shadow-lg">
                  <p className="text-sm leading-relaxed">{entry.question}</p>
                </div>
                <p className="text-xs text-slate-500 text-right mt-1 px-1">
                  {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            </div>

            {/* Answer */}
            <div className="flex justify-start">
              <div className="max-w-[85%] md:max-w-[70%]">
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-purple-600 flex items-center justify-center text-xs font-bold text-white shadow">
                    DH
                  </div>
                  <div className="flex-1">
                    <div className="bg-slate-800 border border-slate-700 text-slate-200 rounded-2xl rounded-tl-md px-4 py-3 shadow-lg">
                      {isLoading ? (
                        <TypingIndicator />
                      ) : (
                        <p className="text-sm leading-relaxed whitespace-pre-wrap">{entry.answer}</p>
                      )}
                    </div>
                    {intentInfo && !isLoading && (
                      <span className={`inline-block mt-1.5 text-xs px-2 py-0.5 rounded-full border ${intentInfo.color}`}>
                        {intentInfo.label}
                      </span>
                    )}
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
