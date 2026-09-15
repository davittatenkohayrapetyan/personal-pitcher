/**
 * In-process request metrics for the public system panel.
 *
 * Deliberately tiny and deliberately in-memory: it matches the existing
 * circuit breaker and rate limiter, which are also per-process. Nothing here
 * is authoritative — `logs/` is. This exists so the site can show a visitor
 * that the pipeline is real and running.
 */

const MAX_SAMPLES = 200;

interface Metrics {
  total: number;
  failures: number;
  /** Ring buffer of recent durations, newest last. */
  durationsMs: number[];
  lastAnsweredAt: string | null;
  byProvider: Record<string, number>;
}

const metrics: Metrics = {
  total: 0,
  failures: 0,
  durationsMs: [],
  lastAnsweredAt: null,
  byProvider: {},
};

export function recordRequest(input: {
  durationMs: number;
  success: boolean;
  modelsUsed: string[];
}): void {
  metrics.total += 1;
  if (!input.success) {
    metrics.failures += 1;
  }

  metrics.durationsMs.push(input.durationMs);
  if (metrics.durationsMs.length > MAX_SAMPLES) {
    metrics.durationsMs.shift();
  }

  metrics.lastAnsweredAt = new Date().toISOString();

  for (const model of input.modelsUsed) {
    // `openai:gpt-4o-mini` → `openai`. The vendor is public; the model name is
    // reported separately from config, never derived from a secret.
    const vendor = model.split(':')[0];
    metrics.byProvider[vendor] = (metrics.byProvider[vendor] ?? 0) + 1;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

export function getMetrics() {
  const sorted = [...metrics.durationsMs].sort((a, b) => a - b);
  return {
    requestsServed: metrics.total,
    failures: metrics.failures,
    p50Ms: Math.round(percentile(sorted, 50)),
    p95Ms: Math.round(percentile(sorted, 95)),
    lastAnsweredAt: metrics.lastAnsweredAt,
    byProvider: { ...metrics.byProvider },
  };
}
