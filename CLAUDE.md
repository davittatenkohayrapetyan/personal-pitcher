# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Project

Personal Pitcher — a personal AI pitch site for Davit Hayrapetyan (Next.js 16 App Router, React 19, TypeScript, Tailwind v4). Visitors ask questions; answers are generated from curated profile data in `data/`, using OpenAI as the primary LLM with automatic fallback to a local Ollama model. See `README.md` for the full environment variable reference, API shape, and circuit breaker state table; `.env.example` lists every variable with its default.

## Commands

- `npm install` — install dependencies
- `npm run dev` — start the dev server (http://localhost:3000)
- `npm run build` — production build (`output: 'standalone'` in `next.config.ts`)
- `npm run start` — run the production build
- No lint or test scripts/config exist in this repo (no ESLint config, no test framework configured). Don't assume `npm run lint` or `npm test` work — verify changes by running the dev server.
- `docker compose up -d` — runs the app in Docker against a host-machine Ollama; `docker-compose.yml` only wires Ollama env vars (`LLM_PROVIDER=ollama`, `OLLAMA_*`), not `OPENAI_API_KEY` — add that to its `environment:` block to test the OpenAI path in Docker.
- Local dev with the fallback path requires Ollama running with the model pulled (`ollama pull llama3`, or whatever `OLLAMA_MODEL` is set to). Set `OPENAI_API_KEY` in `.env.local` to exercise the primary path.

## Provider strategy (OpenAI → Ollama fallback)

The central cross-cutting concern in this codebase. Two independent call sites use the same fallback chain and **share one process-local circuit breaker** (`src/lib/llm/circuitBreaker.ts`), so a struggling OpenAI trips fallback for both:
- `src/app/api/ask/route.ts` — answer generation, via `getDefaultProvider()` (`src/lib/llm/provider.ts`).
- `src/lib/classify.ts` — intent classification, which additionally falls back to a third tier: a regex-based classifier (`classifyIntent`) if both LLMs fail or return an unparseable intent.

- `src/lib/llm/orchestrator.ts` (`FallbackOrchestrator`) — tries OpenAI first when `OPENAI_API_KEY` is set and the breaker allows it (`allowRequest()`), otherwise goes straight to Ollama. `generateWithMeta()` returns which models were used and a `steps` trail for logging; `generate()` is a thin wrapper for the plain `LLMProvider` interface.
- `src/lib/llm/errors.ts` — `LLMError` + `isTransientError()` decide whether a failure counts toward the breaker (network/timeout/quota/5xx = transient; 4xx = not). Non-transient errors still fall back to Ollama, they just don't trip the breaker.
- `src/lib/llm/circuitBreaker.ts` — in-memory `closed → open → half_open` state machine (`CB_FAILURE_THRESHOLD` / `CB_COOLDOWN_MS` / `CB_PROBE_COUNT`). State is per-process — not shared across instances in a multi-instance deployment.
- `src/lib/llm/openai.ts` / `ollama.ts` — thin adapters implementing `LLMProvider` (`src/types/index.ts`).

## Request pipeline (`POST /api/ask`)

`src/app/api/ask/route.ts` runs, in order: IP rate limit (`src/lib/rateLimit.ts`, in-memory `Map`, `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS`) → JSON/length validation → intent classification (`classifyIntentWithLLM`) → off-topic short-circuit → context retrieval (`retrieveContext`, keyed by intent) → LLM generation via `FallbackOrchestrator.generateWithMeta`. Every step is appended to a `steps: string[]` workflow trail carried through to the structured log line — that trail, not inline comments, is the source of truth for how a given request actually resolved.

Runtime is pinned via `export const runtime = 'nodejs'` — the winston file-rotating logger needs `fs`, which isn't available on the Edge runtime.

## Content / retrieval layer

Profile content lives in `data/` (`profile.md`, `projects.json`, `community.json`, `hobbies.json`, `music.json`) and is loaded once and cached in-process:
- `src/lib/profile/loader.ts` reads and formats each data file into a `ProfileContext` — plain formatted strings, not embeddings. This is intent-keyed routing, not vector search.
- `src/lib/retrieval.ts` caches the loaded `ProfileContext` and picks which section(s) go to the LLM based on the classified `Intent`.
- `src/lib/classify.ts` defines the `Intent` union plus both the regex fallback (`INTENT_PATTERNS`, `DAVIT_KEYWORDS`) and the LLM classification prompt.

**Adding a new content section** (e.g. the in-progress `music` section) touches all of: a new `data/*.json` file → a field on `ProfileContext` (`src/types/index.ts`) → formatting logic in `loader.ts` → a case in `retrieveContext()` → an intent + keywords in `classify.ts` → usually a new card component under `src/components/cards/`.

## Frontend

App Router, single page (`src/app/page.tsx`) composed of `AppShell` + `ProfileHero`/`StatsGrid` + `AssistantPanel` (the chat UI, client component, primary CTA) + a grid of `src/components/cards/*` "explore" cards. `AssistantPanel` calls `POST /api/ask` directly via `fetch`; no client-side state management beyond local `useState`.

## Observability

- `src/lib/logger.ts` — winston, JSON lines to stdout + daily-rotated files in `LOG_DIR` (default `./logs`, gitignored). One `request_completed` event per request carries the full `workflowSteps` trail.
- `src/lib/pushover.ts` — optional, fire-and-forget push notification per Q&A, active only when `PUSHOVER_USER_KEY`/`PUSHOVER_API_TOKEN` are set. Failures are logged and swallowed, never surfaced to the caller.

## Deployment

`Dockerfile` is a 3-stage build using Next's `output: 'standalone'`; it copies `data/` into the image (content is baked in at build time, not mounted) and exposes `/app/logs` as a volume.
