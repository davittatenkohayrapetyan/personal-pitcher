'use client';

import { useState, type ReactNode } from 'react';

/**
 * The shell above the two review boards.
 *
 * `/admin` rendered `ReviewBoard` directly until the outreach queue arrived.
 * The tab state lives in `useState` rather than in the URL deliberately: a
 * search param would pull `useSearchParams` into a client component and with it
 * a Suspense boundary requirement, which is a lot of machinery for a control
 * with two positions that one person uses over coffee.
 *
 * Both panels stay mounted. Switching tabs must not throw away a half-typed
 * draft in the other one — the editing is the part that costs a human
 * something, and losing it to a misclick is exactly the kind of small betrayal
 * that stops someone using a tool.
 */

export interface TabDefinition {
  id: string;
  label: string;
  /** Rendered as a chip. Omitted rather than shown as zero when there is nothing. */
  count?: number;
  panel: ReactNode;
}

export default function AdminTabs({ tabs }: { tabs: TabDefinition[] }) {
  const [active, setActive] = useState(tabs[0]?.id);

  /**
   * Arrow keys move between tabs, and only the selected one is in the tab order.
   *
   * Opting into `role="tablist"` opts into the expectations that come with it:
   * a screen-reader user who has been told this is a tab list will reach for
   * Left/Right, and `Tab` should move *past* the group rather than through it.
   * Buttons are keyboard-operable for free; this is the part that is not free.
   */
  function onKeyDown(event: React.KeyboardEvent, index: number) {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (delta === 0) return;

    event.preventDefault();
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    setActive(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label="Review queues"
        className="mb-8 flex gap-1 border-b border-white/10"
      >
        {tabs.map((tab, index) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onKeyDown={(event) => onKeyDown(event, index)}
              onClick={() => setActive(tab.id)}
              className={`-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm transition-colors ${
                selected
                  ? 'border-violet-400 text-white'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.label}
              {tab.count !== undefined && tab.count > 0 && (
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                    selected ? 'bg-violet-500/30 text-violet-100' : 'bg-white/10 text-slate-300'
                  }`}
                >
                  {tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`panel-${tab.id}`}
          aria-labelledby={`tab-${tab.id}`}
          // Focusable so that `Tab` out of the tablist lands in the panel it
          // selected, which is where the content the user just chose lives.
          tabIndex={tab.id === active ? 0 : -1}
          hidden={tab.id !== active}
        >
          {tab.panel}
        </div>
      ))}
    </div>
  );
}
