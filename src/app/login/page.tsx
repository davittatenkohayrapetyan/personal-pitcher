import type { Metadata } from 'next';
import LoginForm from './LoginForm';

/**
 * The hidden admin entrance.
 *
 * "Hidden" here means unlinked and unindexed, not secret — the URL is guessable
 * and should be assumed known. The password is what protects the route; this
 * metadata only keeps the page out of search results, so that a search for
 * Davit's name never surfaces a login box next to his portfolio.
 */
export const metadata: Metadata = {
  title: 'Sign in',
  robots: { index: false, follow: false, nocache: true },
};

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-950 px-4 py-10">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-lg font-semibold text-white">Sign in</h1>
        <p className="mb-6 text-sm text-slate-400">
          Review pending profile updates.
        </p>
        <LoginForm />
      </div>
    </main>
  );
}
