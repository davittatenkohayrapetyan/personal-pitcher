import Link from 'next/link';
import type { ReactNode } from 'react';

interface AppShellProps {
  children: ReactNode;
}

/**
 * Outer page chrome: navy/slate background with subtle violet glow,
 * sticky compact header, and a centered max-w-7xl content container.
 */
export default function AppShell({ children }: AppShellProps) {
  return (
    <div className="relative min-h-screen w-full overflow-x-hidden bg-slate-950 text-slate-100">
      {/* Ambient background accents — fixed, behind everything, never cause overflow */}
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute -top-32 -left-32 h-[28rem] w-[28rem] rounded-full bg-violet-700/15 blur-3xl" />
        <div className="absolute top-1/3 -right-32 h-[26rem] w-[26rem] rounded-full bg-blue-700/15 blur-3xl" />
        <div className="absolute bottom-0 left-1/3 h-[22rem] w-[22rem] rounded-full bg-indigo-800/10 blur-3xl" />
      </div>

      <header className="sticky top-0 z-30 border-b border-white/5 bg-slate-950/70 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
          <Link
            href="/"
            className="flex items-center gap-2 text-sm font-semibold tracking-tight text-white"
            aria-label="Davit Hayrapetyan — home"
          >
            <span
              aria-hidden="true"
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-blue-500 text-xs font-bold text-white shadow-lg shadow-violet-900/30"
            >
              DH
            </span>
            <span>Davit Hayrapetyan</span>
          </Link>
          <nav aria-label="External links" className="flex items-center gap-1 sm:gap-2">
            <a
              href="https://github.com/davittatenkohayrapetyan"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md px-2 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-white/5 hover:text-white sm:px-3 sm:text-sm"
            >
              GitHub
            </a>
            <a
              href="https://linkedin.com/in/davithayrapetyan"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md px-2 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-white/5 hover:text-white sm:px-3 sm:text-sm"
            >
              LinkedIn
            </a>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10">
        {children}
      </main>

      <footer className="border-t border-white/5 bg-slate-950/60">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-2 px-4 py-6 text-xs text-slate-500 sm:flex-row sm:px-6 lg:px-8">
          <p>© {new Date().getFullYear()} Davit Hayrapetyan · Yerevan, Armenia</p>
          <p className="text-slate-600">Built with Next.js · Powered by a local LLM</p>
        </div>
      </footer>
    </div>
  );
}
