'use client';

import { useEffect, useState } from 'react';

/**
 * Live view of the site's own LLM pipeline.
 *
 * Nothing here is decorative — every value is read from `/api/system`, which
 * reports the real circuit-breaker state and the real request metrics of the
 * process serving the page. If OpenAI starts failing while a visitor is on the
 * site, they watch the breaker open here.
 *
 * There are two independent breakers, shown per tier rather than as one global
 * badge: the Mac tier is expected to be absent much of the time, and collapsing
 * that into a single "the pipeline is unhealthy" light would misreport a system
 * that is doing exactly what it was designed to do.
 */

type BreakerState = 'closed' | 'open' | 'half_open';

interface ChainTier {
  tier: string;
  vendor: string;
  model: string;
  configured: boolean;
  active: boolean;
  breaker: BreakerState | null;
}

interface SystemStatus {
  breakers: { mac: BreakerState; openai: BreakerState };
  chain: ChainTier[];
  metrics: {
    requestsServed: number;
    p50Ms: number;
    p95Ms: number;
  };
}

const BREAKER_STYLE: Record<BreakerState, { label: string; className: string }> = {
  closed: {
    label: 'closed',
    className: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300',
  },
  half_open: {
    label: 'half-open',
    className: 'border-amber-400/30 bg-amber-500/10 text-amber-300',
  },
  open: {
    label: 'open',
    className: 'border-red-400/30 bg-red-500/10 text-red-300',
  },
};

function tierLabel(tier: ChainTier): string {
  if (!tier.configured) return 'not configured';
  if (tier.active) return 'active';
  return 'standby';
}

export default function SystemStatusCard() {
  const [status, setStatus] = useState<SystemStatus | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch('/api/system', { cache: 'no-store' });
        if (!res.ok) return;
        const data: SystemStatus = await res.json();
        if (!cancelled) setStatus(data);
      } catch {
        // A status panel that cannot reach the server should stay quiet rather
        // than shout an error over the actual content.
      }
    };

    load();
    const timer = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <section
      aria-labelledby="system-heading"
      className="rounded-2xl border border-slate-400/15 bg-slate-900/70 p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3
          id="system-heading"
          className="font-mono text-xs uppercase tracking-widest text-slate-400"
        >
          This site&apos;s pipeline
        </h3>
        {status && (
          <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-0.5 font-mono text-[10px] text-slate-400">
            2 breakers
          </span>
        )}
      </div>

      <p className="mt-2 text-sm leading-relaxed text-slate-400">
        Answers run through a four-tier fallback chain. It starts on a 26B model on a
        Mac at home — free, but only when that machine is awake and on the network —
        then falls through to OpenAI, a local Llama, and finally a regex classifier.
        Each of the first two tiers has its own circuit breaker. This panel reads the
        real state of the process serving you.
      </p>

      <ol className="mt-4 space-y-1.5">
        {(status?.chain ?? []).map((tier) => (
          <li
            key={tier.vendor}
            className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 font-mono text-[11px] ${
              tier.active
                ? 'border-violet-400/30 bg-violet-500/10 text-violet-200'
                : 'border-white/10 bg-white/[0.03] text-slate-500'
            }`}
          >
            <span className="truncate">
              {tier.vendor}
              <span className="text-slate-500"> · {tier.model}</span>
            </span>
            <span className="flex flex-shrink-0 items-center gap-1.5">
              {tier.breaker && (
                <span
                  title={`circuit breaker: ${tier.breaker}`}
                  className={`rounded border px-1.5 py-0.5 text-[9px] ${BREAKER_STYLE[tier.breaker].className}`}
                >
                  {BREAKER_STYLE[tier.breaker].label}
                </span>
              )}
              <span className="text-[10px] uppercase tracking-wide">{tierLabel(tier)}</span>
            </span>
          </li>
        ))}
        {!status && (
          <li className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-[11px] text-slate-500">
            reading status…
          </li>
        )}
      </ol>

      {status && status.metrics.requestsServed > 0 && (
        <dl className="mt-4 grid grid-cols-3 gap-2 border-t border-white/10 pt-3">
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-wide text-slate-500">asked</dt>
            <dd className="text-sm font-semibold tabular-nums text-slate-200">
              {status.metrics.requestsServed}
            </dd>
          </div>
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-wide text-slate-500">p50</dt>
            <dd className="text-sm font-semibold tabular-nums text-slate-200">
              {(status.metrics.p50Ms / 1000).toFixed(1)}s
            </dd>
          </div>
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-wide text-slate-500">p95</dt>
            <dd className="text-sm font-semibold tabular-nums text-slate-200">
              {(status.metrics.p95Ms / 1000).toFixed(1)}s
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}
