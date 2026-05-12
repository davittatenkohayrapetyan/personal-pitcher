'use client';

import { useState } from 'react';
import HeroSection from '@/components/HeroSection';
import PhotoCards from '@/components/PhotoCards';
import ChatInput from '@/components/ChatInput';
import QATimeline from '@/components/QATimeline';
import type { QAEntry } from '@/types';

export default function Home() {
  const [entries, setEntries] = useState<QAEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const handleAnswer = (entry: QAEntry) => {
    setEntries((prev) => {
      const existingIndex = prev.findIndex((e) => e.id === entry.id);
      if (existingIndex >= 0) {
        const next = [...prev];
        next[existingIndex] = entry;
        return next;
      }
      return [...prev, entry];
    });
  };

  return (
    <main>
      <HeroSection />
      <PhotoCards />

      {/* Ask section */}
      <section id="ask" className="min-h-screen bg-slate-900 py-20 px-4">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">
              Ask Davit&apos;s AI Assistant
            </h2>
            <p className="text-slate-400 text-lg max-w-2xl mx-auto">
              Powered by a local LLM with Davit&apos;s curated profile data. Ask about his career, projects, community work, or personal interests.
            </p>
          </div>

          <ChatInput
            onAnswer={handleAnswer}
            isLoading={isLoading}
            setIsLoading={setIsLoading}
          />

          {entries.length > 0 && (
            <div className="mt-10 border-t border-slate-800 pt-10">
              <h3 className="text-lg font-semibold text-slate-400 mb-6">Conversation</h3>
              <QATimeline entries={entries} />
            </div>
          )}
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-slate-950 py-8 px-4 border-t border-slate-800">
        <div className="max-w-4xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-slate-500 text-sm">
            © 2024 Davit Hayrapetyan · Built with Next.js + Ollama
          </p>
          <div className="flex gap-4">
            <a href="https://github.com/davittatenkohayrapetyan" target="_blank" rel="noopener noreferrer" className="text-slate-500 hover:text-white transition-colors text-sm">GitHub</a>
            <a href="https://linkedin.com/in/davithayrapetyan" target="_blank" rel="noopener noreferrer" className="text-slate-500 hover:text-white transition-colors text-sm">LinkedIn</a>
          </div>
        </div>
      </footer>
    </main>
  );
}
