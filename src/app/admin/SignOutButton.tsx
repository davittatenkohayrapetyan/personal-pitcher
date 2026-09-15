'use client';

import { useRouter } from 'next/navigation';

/**
 * Sign out, lifted out of `ReviewBoard` when `/admin` grew a second tab.
 *
 * It is page chrome, not part of either queue: leaving it inside one tab would
 * have meant it vanished when the other was selected. Its own client component
 * so the page itself can stay a server component and keep reading both stores
 * on the server.
 */
export default function SignOutButton() {
  const router = useRouter();

  return (
    <button
      onClick={async () => {
        await fetch('/api/admin/login', { method: 'DELETE' });
        router.push('/login');
      }}
      className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5"
    >
      Sign out
    </button>
  );
}
