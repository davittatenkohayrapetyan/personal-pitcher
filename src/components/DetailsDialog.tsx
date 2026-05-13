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
      className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-slate-950/80 p-0 backdrop-blur-sm sm:items-center sm:p-4"
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
        className="relative flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl border border-white/10 bg-slate-900 shadow-2xl shadow-black/40 sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-white/5 px-5 py-4 sm:px-6">
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
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="scrollbar-thin flex-1 overflow-y-auto px-5 py-5 sm:px-6 sm:py-6">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
