'use client';

import type { ReactNode } from 'react';

interface HighlightCardProps {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  description?: string;
  badge?: string;
  onClick: () => void;
  ariaLabel?: string;
}

/**
 * Compact, clickable summary card. Renders as a button so it has full
 * keyboard focus semantics. Opens a DetailsDialog managed by the parent.
 */
export default function HighlightCard({
  icon,
  title,
  subtitle,
  description,
  badge,
  onClick,
  ariaLabel,
}: HighlightCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel ?? `Open details for ${title}`}
      aria-haspopup="dialog"
      className="group flex w-full flex-col items-start gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-left transition-all hover:-translate-y-0.5 hover:border-violet-400/40 hover:bg-white/[0.06] hover:shadow-lg hover:shadow-violet-900/20"
    >
      <div className="flex w-full items-center justify-between gap-2">
        <span
          aria-hidden="true"
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500/20 to-blue-500/20 text-lg ring-1 ring-inset ring-white/10"
        >
          {icon}
        </span>
        {badge && (
          <span className="rounded-full border border-violet-400/30 bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-200">
            {badge}
          </span>
        )}
      </div>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        {subtitle && <p className="mt-0.5 text-xs text-violet-300">{subtitle}</p>}
        {description && (
          <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-slate-400">{description}</p>
        )}
      </div>
      <span
        className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-slate-400 transition-colors group-hover:text-violet-300"
        aria-hidden="true"
      >
        View details
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </span>
    </button>
  );
}
