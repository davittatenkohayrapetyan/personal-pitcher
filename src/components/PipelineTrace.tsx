'use client';

import { useState } from 'react';

/**
 * Renders the request's pipeline as a graph, with the path actually taken
 * highlighted.
 *
 * The previous version listed only the steps that *fired*, as a flat row of
 * chips. That showed what happened but never what the pipeline *is*, so a
 * fallback was indistinguishable from normal operation and the colours had no
 * stated meaning. This version always draws every stage and every tier, and
 * colours each node by what became of it — so "OpenAI never ran because the Mac
 * answered" shows up as a dimmed node rather than an absent one.
 *
 * Everything here is derived from the `steps` array the server already streams.
 * Nothing is decorative: if a node is green, that step really succeeded.
 */

export type NodeState =
  | 'ok'
  | 'failed'
  | 'breaker-open'
  | 'away'
  | 'not-reached'
  | 'off'
  | 'pending';

export interface GraphNode {
  key: string;
  label: string;
  tier?: string;
  state: NodeState;
  note?: string;
}

export interface GraphStage {
  key: string;
  title: string;
  nodes: GraphNode[];
  note?: string;
}

/** The steps that mark one tier's outcome, checked in precedence order. */
interface TierSteps {
  attempt: string;
  success: string;
  failures: string[];
  breakerOpen?: string;
  away?: string;
  off?: string;
}

function tierState(steps: string[], t: TierSteps, live: boolean): NodeState {
  if (steps.includes(t.success)) return 'ok';
  if (t.failures.some((f) => steps.includes(f))) return 'failed';
  if (t.breakerOpen && steps.includes(t.breakerOpen)) return 'breaker-open';
  if (t.away && steps.includes(t.away)) return 'away';
  if (t.off && steps.includes(t.off)) return 'off';
  // Attempted with no outcome yet = still in flight. Only meaningful mid-stream;
  // after the stream ends, an attempt with no outcome would be a bug, not a wait.
  if (steps.includes(t.attempt)) return live ? 'pending' : 'not-reached';
  return 'not-reached';
}

interface TierDef {
  key: string;
  label: string;
  tier: string;
  steps: TierSteps;
}

const CLASSIFY_TIERS: TierDef[] = [
  {
    key: 'mac',
    label: 'Mac at home',
    tier: 'tier 0',
    steps: {
      attempt: 'classifier_mac_attempt',
      success: 'classifier_mac_success',
      failures: ['classifier_mac_failure', 'classifier_mac_invalid_response'],
      breakerOpen: 'classifier_mac_circuit_open_skip',
      away: 'classifier_mac_unreachable',
      off: 'classifier_mac_not_configured',
    },
  },
  {
    key: 'openai',
    label: 'OpenAI',
    tier: 'tier 1',
    steps: {
      attempt: 'classifier_openai_attempt',
      success: 'classifier_openai_success',
      failures: [
        'classifier_openai_failure_transient',
        'classifier_openai_failure_non_transient',
        'classifier_openai_invalid_response',
      ],
      breakerOpen: 'classifier_circuit_open_skip_openai',
      off: 'classifier_openai_not_configured',
    },
  },
  {
    key: 'ollama',
    label: 'Local Ollama',
    tier: 'tier 2',
    steps: {
      attempt: 'classifier_ollama_attempt',
      success: 'classifier_ollama_success',
      failures: ['classifier_ollama_failure', 'classifier_ollama_invalid_response'],
    },
  },
];

const GENERATE_TIERS: TierDef[] = [
  {
    key: 'mac',
    label: 'Mac at home',
    tier: 'tier 0',
    steps: {
      attempt: 'mac_attempt',
      success: 'mac_success',
      failures: ['mac_failure', 'mac_stream_interrupted'],
      breakerOpen: 'mac_circuit_open_skip',
      away: 'mac_unreachable',
      off: 'mac_not_configured',
    },
  },
  {
    key: 'openai',
    label: 'OpenAI',
    tier: 'tier 1',
    steps: {
      attempt: 'openai_attempt',
      success: 'openai_success',
      failures: [
        'openai_failure_transient',
        'openai_failure_non_transient',
        'openai_stream_interrupted',
      ],
      breakerOpen: 'circuit_open_skip_openai',
      off: 'openai_not_configured',
    },
  },
  {
    key: 'ollama',
    label: 'Local Ollama',
    tier: 'tier 2',
    steps: {
      attempt: 'ollama_attempt',
      success: 'ollama_success',
      failures: ['ollama_failure'],
    },
  },
];

function findPrefixed(steps: string[], prefix: string): string | undefined {
  return steps.find((s) => s.startsWith(prefix));
}

/**
 * Turns the raw workflow trail into the four-stage graph.
 *
 * Exported and pure so it can be exercised directly — this repo has no test
 * runner, and the logic deciding what a visitor is told needs to be verifiable
 * some other way.
 */
export function deriveGraph(steps: string[], live = false): GraphStage[] {
  const has = (s: string) => steps.includes(s);

  // ── Request checks ───────────────────────────────────────────────────────
  const quotaExceeded = has('question_quota_exceeded');
  const quotaFinal = has('question_quota_final');
  const retrieved = has('retrieve_context');

  const guard: GraphStage = {
    key: 'guard',
    title: 'Request checks',
    nodes: [
      { key: 'received', label: 'Received', state: has('request_received') ? 'ok' : 'not-reached' },
      { key: 'rate', label: 'Rate limit', state: has('rate_limit_passed') ? 'ok' : 'not-reached' },
      {
        key: 'quota',
        label: 'Free-question quota',
        state: quotaExceeded ? 'failed' : retrieved || quotaFinal ? 'ok' : 'not-reached',
        note: quotaExceeded ? 'limit reached' : quotaFinal ? 'last free one' : undefined,
      },
    ],
  };

  // ── Classify ─────────────────────────────────────────────────────────────
  const classify: GraphStage = {
    key: 'classify',
    title: 'Classify intent',
    nodes: [
      ...CLASSIFY_TIERS.map((t) => ({
        key: t.key,
        label: t.label,
        tier: t.tier,
        state: tierState(steps, t.steps, live),
      })),
      {
        key: 'regex',
        label: 'Regex classifier',
        tier: 'tier 3',
        state: (has('classifier_regex_fallback') ? 'ok' : 'not-reached') as NodeState,
      },
    ],
    note: has('classifier_offtopic_guard')
      ? 'The model picked a topic, but the question named nothing about Davit — overruled to off-topic.'
      : undefined,
  };

  // ── Retrieve ─────────────────────────────────────────────────────────────
  const intentStep = findPrefixed(steps, 'intent:');
  const sectionsStep = findPrefixed(steps, 'sections:');
  const offTopic = has('off_topic_short_circuit');

  const retrieve: GraphStage = {
    key: 'retrieve',
    title: 'Retrieve context',
    nodes: [
      {
        key: 'intent',
        label: intentStep ? intentStep.replace('intent:', 'Intent: ') : 'Intent',
        state: intentStep ? 'ok' : 'not-reached',
      },
      {
        key: 'sections',
        label: sectionsStep
          ? sectionsStep.replace('sections:', 'Sections: ')
          : retrieved
            ? 'Sections: whole profile'
            : 'Sections',
        state: retrieved ? 'ok' : 'not-reached',
      },
    ],
    note: offTopic
      ? 'Off topic — answered with a fixed reply, so no profile data was needed.'
      : undefined,
  };

  // ── Generate ─────────────────────────────────────────────────────────────
  const generate: GraphStage = {
    key: 'generate',
    title: 'Generate answer',
    nodes: GENERATE_TIERS.map((t) => ({
      key: t.key,
      label: t.label,
      tier: t.tier,
      state: tierState(steps, t.steps, live),
    })),
    note: offTopic
      ? 'Skipped — no model was called, so an off-topic question costs nothing to refuse.'
      : quotaExceeded
        ? 'Skipped — the free question limit was already reached.'
        : undefined,
  };

  return [guard, classify, retrieve, generate];
}

const STATE_STYLE: Record<NodeState, { dot: string; text: string; badge: string; label: string }> = {
  ok: {
    dot: 'bg-emerald-400',
    text: 'text-emerald-200',
    badge: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300',
    label: 'used',
  },
  failed: {
    dot: 'bg-red-400',
    text: 'text-red-200',
    badge: 'border-red-400/30 bg-red-500/10 text-red-300',
    label: 'failed',
  },
  'breaker-open': {
    dot: 'bg-amber-400',
    text: 'text-amber-200',
    badge: 'border-amber-400/30 bg-amber-500/10 text-amber-300',
    label: 'breaker open',
  },
  away: {
    dot: 'bg-amber-400',
    text: 'text-amber-200',
    badge: 'border-amber-400/30 bg-amber-500/10 text-amber-300',
    label: 'not at home',
  },
  pending: {
    dot: 'animate-pulse bg-violet-400',
    text: 'text-violet-200',
    badge: 'border-violet-400/30 bg-violet-500/10 text-violet-300',
    label: 'running',
  },
  'not-reached': {
    dot: 'bg-slate-700',
    text: 'text-slate-500',
    badge: 'border-white/10 bg-white/[0.03] text-slate-500',
    label: 'not needed',
  },
  off: {
    dot: 'bg-slate-700',
    text: 'text-slate-500',
    badge: 'border-white/10 bg-white/[0.03] text-slate-500',
    label: 'not configured',
  },
};

/** Only the states this trace actually used, so the key never explains absent colours. */
function usedStates(stages: GraphStage[]): NodeState[] {
  const seen = new Set<NodeState>();
  stages.forEach((s) => s.nodes.forEach((n) => seen.add(n.state)));
  return (
    ['ok', 'pending', 'away', 'breaker-open', 'failed', 'not-reached', 'off'] as NodeState[]
  ).filter((s) => seen.has(s));
}

interface PipelineTraceProps {
  steps: string[];
  durationMs?: number;
  modelsUsed?: string[];
  /** Streaming still in flight — keeps the graph expanded and pulsing. */
  live?: boolean;
}

export default function PipelineTrace({
  steps,
  durationMs,
  modelsUsed,
  live,
}: PipelineTraceProps) {
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;

  const stages = deriveGraph(steps, Boolean(live));
  // A fallback, a failure or an open breaker is the interesting moment — show it
  // without making the visitor click. Ordinary runs stay collapsed.
  const notable = stages.some((s) =>
    s.nodes.some((n) => n.state === 'failed' || n.state === 'breaker-open' || n.state === 'away'),
  );
  const expanded = open || Boolean(live) || notable;
  const answeringModel = modelsUsed?.[modelsUsed.length - 1];

  return (
    <div className="mt-2 w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={expanded}
        className="group inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-500 transition-colors hover:text-violet-300"
      >
        <span
          aria-hidden="true"
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            live ? 'animate-pulse bg-violet-400' : 'bg-slate-600'
          }`}
        />
        pipeline
        {answeringModel && !live && <span className="text-slate-600">· {answeringModel}</span>}
        {typeof durationMs === 'number' && !live && (
          <span className="text-slate-600">· {(durationMs / 1000).toFixed(1)}s</span>
        )}
        <svg
          className={`h-3 w-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {expanded && (
        <div className="mt-2 space-y-2">
          {stages.map((stage, stageIndex) => (
            <section
              key={stage.key}
              aria-label={stage.title}
              className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5"
            >
              <h4 className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-400">
                <span className="text-slate-600">{stageIndex + 1}</span>
                {stage.title}
              </h4>

              <ol className="space-y-1">
                {stage.nodes.map((node) => {
                  const style = STATE_STYLE[node.state];
                  return (
                    <li
                      key={node.key}
                      className="flex items-center justify-between gap-2 font-mono text-[11px]"
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span
                          aria-hidden="true"
                          className={`inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full ${style.dot}`}
                        />
                        <span className={`truncate ${style.text}`}>{node.label}</span>
                        {node.tier && (
                          <span className="flex-shrink-0 text-[9px] text-slate-600">
                            {node.tier}
                          </span>
                        )}
                      </span>
                      <span
                        className={`flex-shrink-0 rounded border px-1.5 py-0.5 text-[9px] ${style.badge}`}
                      >
                        {node.note ?? style.label}
                      </span>
                    </li>
                  );
                })}
              </ol>

              {stage.note && (
                <p className="mt-1.5 border-t border-white/5 pt-1.5 text-[10px] leading-relaxed text-slate-500">
                  {stage.note}
                </p>
              )}
            </section>
          ))}

          {/* The key — this is the actual answer to "why are some green and some not". */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-0.5 pt-0.5">
            {usedStates(stages).map((state) => (
              <span
                key={state}
                className="inline-flex items-center gap-1 font-mono text-[9px] text-slate-500"
              >
                <span
                  aria-hidden="true"
                  className={`inline-block h-1.5 w-1.5 rounded-full ${STATE_STYLE[state].dot}`}
                />
                {STATE_STYLE[state].label}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
