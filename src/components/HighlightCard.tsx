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
 * Clickable summary card.  Renders as a <button> for full keyboard semantics.
 * Opens a DetailsDialog managed by the parent.
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
      className="group flex w-full flex-col gap-3 rounded-xl border border-slate-400/15 bg-slate-900/70 p-4 text-left transition-all hover:-translate-y-0.5 hover:border-violet-400/35 hover:bg-slate-900 hover:shadow-lg hover:shadow-violet-950/25"
    >
      {/* Icon + badge row */}
      <div className="flex w-full items-start justify-between gap-2">
        <span
          aria-hidden="true"
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500/15 to-sky-500/15 text-lg ring-1 ring-inset ring-slate-400/15"
        >
          {icon}
        </span>
        {badge && (
          <span className="rounded-full border border-violet-400/25 bg-violet-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-300">
            {badge}
          </span>
        )}
      </div>

      {/* Text content */}
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold text-slate-100 leading-tight">{title}</h3>
        {subtitle && (
          <p className="mt-0.5 text-xs font-medium text-violet-300/80">{subtitle}</p>
        )}
        {description && (
          <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-slate-400">
            {description}
          </p>
        )}
      </div>

      {/* CTA */}
      <span
        className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 transition-colors group-hover:text-violet-300"
        aria-hidden="true"
      >
        View details
        <svg className="h-3 w-3 transition-transform group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </span>
    </button>
  );
}
