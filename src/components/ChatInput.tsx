'use client';

import { useState, useRef } from 'react';
import type { QAEntry } from '@/types';

interface ChatInputProps {
  onAnswer: (entry: QAEntry) => void;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
}

const SUGGESTED_QUESTIONS = [
  "What projects has Davit built?",
  "What is Davit's tech stack?",
  "Tell me about Davit's community work",
  "What are Davit's hobbies?",
  "How can I contact Davit?",
];

export default function ChatInput({ onAnswer, isLoading, setIsLoading }: ChatInputProps) {
  const [question, setQuestion] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed || isLoading) return;

    setError('');
    setIsLoading(true);

    const optimisticEntry: QAEntry = {
      id: crypto.randomUUID(),
      question: trimmed,
      answer: '',
      timestamp: new Date(),
    };

    onAnswer({ ...optimisticEntry, answer: '...' });

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: trimmed }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to get answer');
      }

      onAnswer({ ...optimisticEntry, answer: data.answer, intent: data.intent });
      setQuestion('');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Something went wrong';
      setError(message);
      onAnswer({ ...optimisticEntry, answer: `Error: ${message}` });
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
    <div className="w-full max-w-3xl mx-auto">
      {/* Suggested questions */}
      <div className="flex flex-wrap gap-2 mb-4">
        {SUGGESTED_QUESTIONS.map((sq) => (
          <button
            key={sq}
            onClick={() => handleSubmit(sq)}
            disabled={isLoading}
            className="px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-full border border-slate-600 hover:border-slate-500 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {sq}
          </button>
        ))}
      </div>

      {/* Input area */}
      <div className="relative bg-slate-800 rounded-2xl border border-slate-700 focus-within:border-blue-500 transition-colors shadow-xl">
        <textarea
          ref={inputRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask anything about Davit..."
          rows={2}
          maxLength={500}
          disabled={isLoading}
          className="w-full bg-transparent text-white placeholder-slate-500 px-5 py-4 pr-16 resize-none rounded-2xl focus:outline-none text-base leading-relaxed"
        />
        <div className="absolute right-3 bottom-3 flex items-center gap-2">
          <span className="text-xs text-slate-600">{question.length}/500</span>
          <button
            onClick={() => handleSubmit(question)}
            disabled={!question.trim() || isLoading}
            className="p-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-xl transition-all disabled:cursor-not-allowed"
            aria-label="Send question"
          >
            {isLoading ? (
              <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {error && (
        <p className="mt-2 text-red-400 text-sm px-1">{error}</p>
      )}

      <p className="mt-2 text-xs text-slate-500 text-center">
        Press Enter to send · Shift+Enter for new line · Rate limited to 10 requests/min
      </p>
    </div>
  );
}
