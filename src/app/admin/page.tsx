import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ADMIN_COOKIE, isValidSessionValue } from '@/lib/admin/auth';
import { readPending as readProposal, readRejections } from '@/lib/refresh/store';
import {
  readPending as readQueue,
  readRejections as readOutreachRejections,
  readSuggestions,
} from '@/lib/outreach/store';
import { readApplied, sentToday } from '@/lib/outreach/ledger';
import { dryRun, maxSendsPerDay } from '@/lib/outreach/config';
import AdminTabs from './AdminTabs';
import SignOutButton from './SignOutButton';
import ReviewBoard from './ReviewBoard';
import OutreachBoard from './OutreachBoard';

export const metadata: Metadata = {
  title: 'Review',
  robots: { index: false, follow: false, nocache: true },
};

/**
 * Never cached, and never statically rendered: both queues are read from disk
 * and change whenever a scheduled job runs or a decision is made.
 *
 * `force-dynamic` is still the right control in Next 16 here — the route
 * segment options `dynamic`, `revalidate` and `fetchCache` are only removed
 * when Cache Components is enabled, and `next.config.ts` does not enable it.
 * Reading `cookies()` below would force dynamic rendering anyway; this states
 * the intent rather than relying on a side effect of the auth check.
 */
export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const store = await cookies();
  if (!isValidSessionValue(store.get(ADMIN_COOKIE)?.value)) {
    redirect('/login');
  }

  // Read on the server so the first paint already has both queues — each board
  // then owns its copy and re-renders from API responses as decisions land.
  const applied = readApplied();
  const queue = readQueue();
  const suggestions = readSuggestions();
  const proposal = readProposal();

  return (
    <main className="mx-auto min-h-dvh max-w-3xl bg-slate-950 px-4 py-10 sm:px-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <h1 className="text-xl font-semibold text-white">Review</h1>
        <SignOutButton />
      </div>

      <AdminTabs
        tabs={[
          {
            id: 'profile',
            label: 'Profile updates',
            count: proposal?.changes.length ?? 0,
            panel: <ReviewBoard initialPending={proposal} initialRejections={readRejections()} />,
          },
          {
            id: 'outreach',
            label: 'Job outreach',
            count: queue.length + suggestions.length,
            panel: (
              <OutreachBoard
                initial={{
                  opportunities: queue,
                  suggestions,
                  applied,
                  rejections: readOutreachRejections(),
                  sentToday: sentToday(applied),
                  capPerDay: maxSendsPerDay(),
                  dryRun: dryRun(),
                }}
              />
            ),
          },
        ]}
      />
    </main>
  );
}
