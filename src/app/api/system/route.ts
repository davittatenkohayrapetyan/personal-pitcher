import { NextResponse } from 'next/server';
import { openaiBreaker, macBreaker } from '@/lib/llm/circuitBreaker';
import { isMacTierConfigured, getMacModelName, isMacLikelyWarm } from '@/lib/llm/macOllama';
import { getMetrics } from '@/lib/metrics';

// Same reasoning as /api/ask: the breakers and metrics are process-local state,
// so this must not be prerendered or cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Public system status, consumed by the SystemStatusCard and by the compose
 * healthcheck.
 *
 * Exposes state and model *names* only. No API keys, no base URLs, no request
 * contents — a visitor can see that the fallback chain exists and what state it
 * is in, and nothing more. The Mac tier is deliberately reported as a generic
 * "mac" vendor: that it exists is the interesting part, where it lives is not
 * something a visitor needs (or should get).
 */
export function GET() {
  const openai = openaiBreaker.getState();
  const mac = macBreaker.getState();
  const openaiConfigured = Boolean(process.env.OPENAI_API_KEY);
  const macConfigured = isMacTierConfigured();

  // Exactly one tier is "active" — the first one that would actually be tried
  // for the next request. Anything configured but not first is standby.
  const macActive = macConfigured && mac !== 'open';
  const openaiActive = !macActive && openaiConfigured && openai !== 'open';

  return NextResponse.json(
    {
      status: 'ok',
      // Retained as the OpenAI breaker for backwards compatibility; per-tier
      // state now lives on each chain entry and in `breakers`.
      breaker: openai,
      breakers: { mac, openai },
      chain: [
        {
          tier: 'local',
          vendor: 'mac',
          model: getMacModelName(),
          configured: macConfigured,
          active: macActive,
          breaker: mac,
          // Inferred from when the tier last answered, not measured — see
          // `isMacLikelyWarm`. The chat UI uses it to avoid telling a visitor
          // it is "warming up the model" when the model is already loaded and
          // the request is simply slow.
          warm: macActive && isMacLikelyWarm(),
        },
        {
          tier: 'primary',
          vendor: 'openai',
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          configured: openaiConfigured,
          // A closed or half-open breaker means OpenAI is still being tried.
          active: openaiActive,
          breaker: openai,
        },
        {
          tier: 'fallback',
          vendor: 'ollama',
          model: process.env.OLLAMA_MODEL || 'llama3',
          configured: true,
          active: !macActive && !openaiActive,
          breaker: null,
        },
        {
          tier: 'last resort',
          vendor: 'regex',
          model: 'intent classifier',
          configured: true,
          active: false,
          breaker: null,
        },
      ],
      metrics: getMetrics(),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
