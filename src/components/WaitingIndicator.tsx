'use client';

import { useEffect, useState } from 'react';

/**
 * The dead-air filler between "question sent" and "first token back".
 *
 * That gap is not small here: tier 0 is a model on a Mac at home, and a cold
 * one takes tens of seconds to load. A bare spinner for that long reads as
 * broken, so this does two things instead — it says what is happening, and it
 * shows a running clock so the wait is visibly progressing rather than hung.
 *
 * The phrases are **derived from the real workflow steps**, not played on a
 * fixed reel. That matters: the rest of this UI (PipelineTrace, SystemStatusCard)
 * earns its keep by reporting what actually happened, and a loader that cheerily
 * announced "warming up Davit's Mac" while OpenAI was quietly answering would be
 * the one dishonest surface on the page. So when the Mac is asleep, this says so.
 *
 * Steps arrive only once classification finishes (the server awaits it before
 * opening the SSE stream), so the first seconds are necessarily `unknown` —
 * those phrases are written to be true regardless of which tier wins.
 */

type Mode = 'unknown' | 'mac' | 'mac-warm' | 'mac-away' | 'cloud' | 'local';

interface Phrase {
  /** Show once elapsed time passes this, until the next one's threshold. */
  after: number;
  text: string;
}

/** Once past the last threshold, cycle the tail so it never looks frozen. */
const TAIL_CYCLE_MS = 7000;

const PHRASES: Record<Mode, Phrase[]> = {
  unknown: [
    { after: 0, text: 'Reading your question…' },
    { after: 1200, text: 'Warming up the AI model…' },
    { after: 4500, text: 'The first model in the chain runs on a Mac at home — give it a second.' },
    { after: 10000, text: 'Thanks for your patience. Saving power means a slower first answer.' },
    { after: 18000, text: 'Still waking things up…' },
  ],
  // Cold: the model is not resident, so the first seconds really are a load.
  mac: [
    { after: 0, text: 'Warming up the AI model on Davit’s Mac…' },
    { after: 4000, text: 'Loading the model into memory — it runs at home, not in a data centre.' },
    { after: 9000, text: 'You might be the first visitor in a while. Cold starts take a moment.' },
    { after: 16000, text: 'Thanks for your patience — Davit’s Mac sleeps to save power.' },
    { after: 24000, text: 'Still thinking. A laptop is doing this, not a GPU farm.' },
    { after: 34000, text: 'Nearly there — this one is running on Davit’s electricity bill.' },
  ],
  // Warm: the model is already loaded and the request is simply slow. Saying
  // "warming up" or "first visitor in a while" here would be untrue, and a
  // visitor who just asked a question one minute ago would notice.
  'mac-warm': [
    { after: 0, text: 'Thinking on Davit’s Mac…' },
    { after: 4000, text: 'The model is already loaded — it just isn’t a data-centre GPU.' },
    { after: 10000, text: 'Still generating. Local hardware takes its time.' },
    { after: 18000, text: 'Thanks for your patience — this one runs at home.' },
    { after: 28000, text: 'Almost there…' },
  ],
  'mac-away': [
    { after: 0, text: 'Davit’s Mac isn’t answering — asleep, or not at home right now.' },
    { after: 2000, text: 'Falling back to the cloud model. This part is quick.' },
    { after: 6000, text: 'Composing an answer…' },
  ],
  cloud: [
    { after: 0, text: 'Thinking…' },
    { after: 2500, text: 'Composing an answer…' },
    { after: 7000, text: 'Taking a little longer than usual…' },
  ],
  local: [
    { after: 0, text: 'Running on the local fallback model…' },
    { after: 5000, text: 'Thanks for your patience — this one is a smaller model.' },
    { after: 14000, text: 'Still generating…' },
  ],
};

const MAC_ABSENT_STEPS = [
  'mac_unreachable',
  'mac_circuit_open_skip',
  'mac_not_configured',
  'classifier_mac_unreachable',
  'classifier_mac_circuit_open_skip',
  'classifier_mac_not_configured',
];

/**
 * Precedence is deliberate. "The Mac is away" outranks "OpenAI is running"
 * even though both are true by then, because *why* the cloud is answering is
 * the interesting half — and it's the half that explains the wait.
 */
export function deriveMode(steps: string[]): Mode {
  if (steps.includes('mac_attempt')) return 'mac';
  if (MAC_ABSENT_STEPS.some((s) => steps.includes(s))) return 'mac-away';
  if (steps.includes('classifier_mac_attempt')) return 'mac';
  if (steps.includes('openai_attempt') || steps.includes('classifier_openai_attempt')) {
    return 'cloud';
  }
  if (steps.includes('ollama_attempt') || steps.includes('classifier_ollama_attempt')) {
    return 'local';
  }
  return 'unknown';
}

export function pickPhrase(phrases: Phrase[], elapsedMs: number): string {
  let index = 0;
  for (let i = 0; i < phrases.length; i += 1) {
    if (elapsedMs >= phrases[i].after) index = i;
    else break;
  }

  const last = phrases[phrases.length - 1];
  const beyondLast = elapsedMs - last.after;
  if (index === phrases.length - 1 && phrases.length >= 3 && beyondLast > TAIL_CYCLE_MS) {
    // Reuse the final few lines rather than inventing filler for a wait this
    // long — by now the clock is the thing carrying the "still alive" signal.
    const tail = phrases.slice(Math.max(1, phrases.length - 3));
    const step = Math.floor(beyondLast / TAIL_CYCLE_MS) % tail.length;
    return tail[step].text;
  }

  return phrases[index].text;
}

function formatElapsed(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${mins}m ${String(rest).padStart(2, '0')}s`;
}

interface WaitingIndicatorProps {
  steps: string[];
  /** When the question was sent — the clock counts up from here. */
  startedAt: Date | string;
}

export default function WaitingIndicator({ steps, startedAt }: WaitingIndicatorProps) {
  const startMs = new Date(startedAt).getTime();
  const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - startMs));
  const [hintedMode, setHintedMode] = useState<Mode | null>(null);

  useEffect(() => {
    // 100ms keeps the tenths digit moving smoothly without being a render hog.
    const timer = setInterval(() => {
      setElapsedMs(Math.max(0, Date.now() - startMs));
    }, 100);
    return () => clearInterval(timer);
  }, [startMs]);

  /**
   * Ask the server which tier is currently front of the chain.
   *
   * Without this the longest wait would get the vaguest copy. The server
   * classifies intent *before* it opens the SSE stream, so no steps reach us
   * until that finishes — and on a cold start the classifier call is precisely
   * the one paying the model-load cost. That leaves the slowest 20-odd seconds
   * with nothing to report.
   *
   * `/api/system` already publishes which tier is live, so one cheap call
   * alongside the question gives an accurate opening line. It is only a hint:
   * the moment real steps arrive they override it, so a Mac that fell asleep
   * since the last health poll self-corrects to "isn't answering" rather than
   * lying for the rest of the wait.
   */
  useEffect(() => {
    let cancelled = false;
    fetch('/api/system', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data?.chain) return;
        const active = data.chain.find((t: { active: boolean }) => t.active);
        // `warm` says the tier-0 model is probably still resident, so this wait
        // is generation rather than a model load. It changes what is honest to
        // say, not just the wording.
        if (active?.vendor === 'mac') setHintedMode(active.warm ? 'mac-warm' : 'mac');
        else if (active?.vendor === 'openai') setHintedMode('cloud');
        else if (active?.vendor === 'ollama') setHintedMode('local');
      })
      .catch(() => {
        // Status unavailable just means we keep the tier-agnostic copy.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const derived = deriveMode(steps);
  // Real steps always win on *which tier* is serving. They cannot tell warm from
  // cold, though — no step carries that — so when the steps confirm the Mac and
  // the hint said the model was already resident, keep the warm wording.
  let mode: Mode;
  if (derived === 'unknown') mode = hintedMode ?? 'unknown';
  else if (derived === 'mac' && hintedMode === 'mac-warm') mode = 'mac-warm';
  else mode = derived;

  const phrase = pickPhrase(PHRASES[mode], elapsedMs);

  return (
    <div className="flex items-center gap-3 py-0.5">
      <div className="flex items-center gap-1" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-2 w-2 animate-bounce rounded-full bg-slate-400"
            style={{ animationDelay: `${i * 150}ms` }}
          />
        ))}
      </div>

      {/* The parent bubble is aria-live="polite", so this text is announced as
          it changes — a readable cadence, since phrases turn over in seconds.
          The clock is aria-hidden precisely because it must not be: at 10
          updates a second it would flood a screen reader continuously. */}
      <p className="min-w-0 flex-1 text-sm leading-relaxed text-slate-400">{phrase}</p>

      <span
        aria-hidden="true"
        className="flex-shrink-0 font-mono text-xs tabular-nums text-slate-500"
      >
        {formatElapsed(elapsedMs)}
      </span>
    </div>
  );
}
