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
 * Opens a DetailsDialog managed by the parent.  Uses h-full so sibling cards
 * in the same grid row share equal height.
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
      className="group flex h-full w-full flex-col gap-4 rounded-2xl border border-slate-400/15 bg-slate-900/70 p-5 text-left transition-all hover:-translate-y-0.5 hover:border-violet-400/35 hover:bg-slate-900 hover:shadow-lg hover:shadow-violet-950/25 sm:p-6"
    >
      {/* Icon + badge row */}
      <div className="flex w-full items-start justify-between gap-2">
        <span
          aria-hidden="true"
          className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500/15 to-sky-500/15 text-xl ring-1 ring-inset ring-slate-400/15"
        >
          {icon}
        </span>
        {badge && (
          <span className="rounded-full border border-violet-400/25 bg-violet-500/10 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-violet-300">
            {badge}
          </span>
        )}
      </div>

      {/* Text content — flex-1 pushes the CTA to the bottom */}
      <div className="min-w-0 flex-1">
        <h3 className="text-base font-semibold leading-tight text-slate-100">{title}</h3>
        {subtitle && (
          <p className="mt-1 text-xs font-medium text-violet-300/80">{subtitle}</p>
        )}
        {description && (
          <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-slate-400">
            {description}
          </p>
        )}
      </div>

      {/* CTA */}
      <span
        className="inline-flex items-center gap-1 text-sm font-medium text-slate-400 transition-colors group-hover:text-violet-300"
        aria-hidden="true"
      >
        View details
        <svg
          className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </span>
    </button>
  );
}
