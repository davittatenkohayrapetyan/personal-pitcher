'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface DetailsDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
}

const FOCUSABLE_SELECTOR =
  'a[href], area[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), iframe, object, embed, [tabindex="0"], [contenteditable]';

/**
 * Accessible modal dialog rendered into document.body via a portal.
 * - role="dialog", aria-modal, aria-labelledby + aria-describedby
 * - Closes on ESC and backdrop click
 * - Locks body scroll while open
 * - Height capped against the backdrop, so the header stays on screen on mobile
 * - Traps focus inside the dialog and restores focus on close
 */
export default function DetailsDialog({
  open,
  onClose,
  title,
  description,
  children,
}: DetailsDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Focus the first focusable element in the dialog (or the dialog itself)
    const focusFirst = () => {
      const node = dialogRef.current;
      if (!node) return;
      const focusables = node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      (focusables[0] ?? node).focus();
    };
    // Defer to next tick so portal content is mounted
    const t = window.setTimeout(focusFirst, 0);

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        const node = dialogRef.current;
        if (!node) return;
        const focusables = Array.from(
          node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        ).filter((el) => !el.hasAttribute('disabled'));
        if (focusables.length === 0) {
          e.preventDefault();
          node.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKey);

    return () => {
      window.clearTimeout(t);
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = previousOverflow;
      previouslyFocused.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center overflow-hidden bg-slate-950/80 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        /* Capped as a percentage of the backdrop, never in `vh`. On mobile `vh`
           is the *large* viewport (toolbars retracted) while this fixed backdrop
           is only as tall as the visible one, so a vh-based cap made the panel
           taller than its container — and with `items-end` the excess overflows
           off the *top*, taking the close button with it and out of reach.
           A percentage resolves against the backdrop itself, so it cannot. */
        className="relative flex max-h-[92%] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl border border-slate-400/15 bg-slate-900 shadow-2xl shadow-black/40 sm:max-h-full sm:rounded-2xl"
      >
        <div className="flex flex-shrink-0 items-start justify-between gap-3 border-b border-slate-400/10 px-6 py-5 sm:gap-4 sm:px-8">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold text-white sm:text-xl">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="mt-1 text-sm text-slate-400">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-slate-400/15 bg-slate-800/50 text-slate-300 transition-colors hover:bg-slate-700/50 hover:text-white sm:h-9 sm:w-9"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="scrollbar-thin flex-1 overflow-y-auto overscroll-contain px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-6 sm:px-8 sm:pb-8 sm:pt-8">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
