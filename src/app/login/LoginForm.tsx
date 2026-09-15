'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginForm() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      if (response.ok) {
        // `refresh()` before navigating so the server component re-evaluates the
        // cookie it just received; without it the admin page can render its
        // signed-out state once before correcting itself.
        router.refresh();
        router.push('/admin');
        return;
      }

      const payload = await response.json().catch(() => ({}));
      setError(payload.error ?? 'Sign in failed');
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
      setPassword('');
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <label htmlFor="password" className="sr-only">
        Password
      </label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        autoFocus
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
        className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-violet-400/50 focus:outline-none"
      />

      {error && (
        <p role="alert" className="text-sm text-rose-300">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || !password}
        className="w-full rounded-lg bg-violet-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
