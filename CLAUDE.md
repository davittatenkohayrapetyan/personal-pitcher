# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Routing — what to use for which task

| Task | Use |
|---|---|
| Add or extend a profile content section (new `data/` file, new `Intent`, new explore card) | `add-content-section` skill |
| Verify any change before calling it done | `verify` skill |
| Changed `src/lib/llm/**`, `classify.ts`, or `api/ask/route.ts` | `pipeline-reviewer` agent, then `verify` |
| Changed `src/components/**` or `page.tsx` | `ui-checker` agent |
| "Where is X / what references Y" | `Explore` agent |
| Design a multi-file change before writing it | `Plan` agent |
| Touching Next.js routing, rendering, caching, or config | Read `node_modules/next/dist/docs/` **first** — see `AGENTS.md` |

Skills load into the current context (cheap, keeps working state); agents get a fresh context window (isolates, but re-derives everything). Prefer a skill unless the work is context-heavy or genuinely self-contained.

## Project

Personal Pitcher — a personal AI pitch site for Davit Hayrapetyan (Next.js 16 App Router, React 19, TypeScript, Tailwind v4). Visitors ask questions; answers are generated from curated profile data in `data/`, using a four-tier LLM fallback chain: a large model on a Mac on the home LAN → OpenAI → a local Ollama → a regex classifier. See `README.md` for the full environment variable reference, API shape, and circuit breaker state table; `.env.example` lists every variable with its default.

## Commands

- `npm install` — install dependencies
- `npm run dev` — start the dev server (http://localhost:3000)
- `npm run build` — production build (`output: 'standalone'` in `next.config.ts`)
- `npm run start` — run the production build
- No lint or test scripts/config exist in this repo (no ESLint config, no test framework configured). Don't assume `npm run lint` or `npm test` work — verify changes by running the dev server.
- `docker compose up -d` — runs the app in Docker on port **3333**. The whole `.env` is injected via `env_file`, so every tier is configured as it is on the host; `environment:` then overrides only `OLLAMA_BASE_URL` (tier 2), because `localhost` inside a container means the container. Tier 0's `MAC_OLLAMA_BASE_URL` is a LAN address and needs no rewriting.
- `docker compose up -d --build` — required after any source change: the image is a `standalone` build, so `restart` alone re-runs the *old* bundle. Env-only changes do just need a `restart`.
- Local dev with the fallback path requires Ollama running with the model pulled (`ollama pull llama3`, or whatever `OLLAMA_MODEL` is set to). Set `OPENAI_API_KEY` in `.env.local` to exercise the primary path. To exercise tier 0, point `MAC_OLLAMA_BASE_URL` at a machine running Ollama with `OLLAMA_HOST=0.0.0.0`; unset it to remove the tier entirely.

## Provider strategy (Mac → OpenAI → Ollama fallback)

The central cross-cutting concern in this codebase. Two independent call sites walk the same chain and **share both process-local circuit breakers** (`src/lib/llm/circuitBreaker.ts`), so whichever tier classification knocks out stays knocked out for generation a moment later:
- `src/app/api/ask/route.ts` — answer generation, via `getDefaultProvider()` (`src/lib/llm/provider.ts`).
- `src/lib/classify.ts` — intent classification, which additionally falls back to a final tier: a regex-based classifier (`classifyIntent`) if every LLM fails or returns an unparseable intent.

The tiers, in order:

| Tier | Provider | Breaker | Skipped when |
|---|---|---|---|
| 0 | Mac Ollama, `gemma4:26b` on the home LAN | `macBreaker` (`MAC_CB_*`) | `MAC_OLLAMA_BASE_URL` unset, breaker open, or the probe says the Mac isn't home |
| 1 | OpenAI | `openaiBreaker` (`CB_*`) | `OPENAI_API_KEY` unset or breaker open |
| 2 | Local Ollama | none | never — this is the last generator |
| 3 | Regex classifier | none | classification only, not generation |

- `src/lib/llm/macOllama.ts` — tier 0. **Read this first when touching the chain**; it explains why the tier is built around being routinely absent. `openMacTier()` is the single gate both call sites use: it checks configuration, asks `macBreaker`, then runs a short reachability probe, returning either a ready provider or a skip reason that doubles as a workflow step.
- `src/lib/llm/orchestrator.ts` (`FallbackOrchestrator`) — walks tiers 0→2. `generateWithMeta()` returns which models were used and a `steps` trail for logging; `generate()` is a thin wrapper for the plain `LLMProvider` interface. In `generateStream()` the fallback rule applies *only before the first token* — once a tier has emitted text, a later failure ends the stream with an `error` event rather than restarting on the next tier mid-sentence.
- `src/lib/llm/errors.ts` — `LLMError` + `isTransientError()` decide whether a failure counts toward the OpenAI breaker (network/timeout/quota/5xx = transient; 4xx = not). Non-transient errors still fall back, they just don't trip the breaker.
- `src/lib/llm/circuitBreaker.ts` — `createCircuitBreaker(name, envPrefix, defaults)` builds an independent in-memory `closed → open → half_open` state machine; the module exports one per guarded tier. The bare `allowRequest`/`onSuccess`/`onFailure`/`getState` exports stay bound to `openaiBreaker`. State is per-process — not shared across instances in a multi-instance deployment.
- `src/lib/llm/openai.ts` / `ollama.ts` — thin adapters implementing `LLMProvider` (`src/types/index.ts`). `OllamaProvider` takes per-instance options (`baseUrl`/`model`/`timeoutMs`/`label`) so tiers 0 and 2 are the same class pointed at different hosts.

**Two breakers, not one.** The Mac is expected to be unreachable much of the time — a laptop sleeps, and it leaves the house. That must not consume OpenAI's failure budget, and a flaky OpenAI must not stop us using the Mac once it's back. `macBreaker` is correspondingly twitchier (2 failures) and cools down far longer (5 min vs 60s), because nothing about "the Mac went to the office" resolves on a one-minute timescale.

**Why tier 0 probes before it calls.** An absent host doesn't refuse the connection — it silently drops the SYN, and `fetch` then sits through the OS TCP retry schedule (~20s+) before failing. Without the probe in `OllamaProvider.isReachable()`, putting a frequently-absent machine first in the chain would add ~20s to every request made while it's away. The probe turns that into a sub-second skip, and the breaker then elides even the probe. If you ever make tier 0 non-optional or remove the probe, this is the thing that breaks.

**Warm vs cold (`isMacLikelyWarm`).** Ollama evicts an idle model after `MAC_OLLAMA_KEEP_ALIVE` (default `-1`, i.e. never), so tier 0 has two very different latencies: a cold load of tens of seconds, and warm generation. `macOllama.ts` timestamps each successful tier-0 call via `noteMacSuccess()` — which callers use *instead of* `macBreaker.onSuccess()`, so breaker state and warmth cannot drift apart — and infers residency from it. `/api/system` publishes it as `chain[0].warm`; the same value is sent to Ollama as `keep_alive` and parsed for the heuristic, so the two cannot drift; `WaitingIndicator` uses it to choose between its `mac` (cold) and `mac-warm` copy, because telling a visitor you are "warming up the model" when it is already loaded is simply false. Inferred, not measured, on purpose: polling the Mac's `/api/ps` on every status poll would add LAN chatter, and on a sleeping laptop that traffic is exactly what wakes it. Being wrong only makes the waiting copy less apt, never breaks a request.

## Request pipeline (`POST /api/ask`)

`src/app/api/ask/route.ts` splits in two. `POST` handles only what must return a real HTTP status — IP rate limit (`src/lib/rateLimit.ts`, in-memory `Map`, `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS`, bursts) and JSON/length validation (400/429). Everything after that lives in **`runPipeline()`, a single async generator** that both transports consume: the SSE path pipes it out, the buffered JSON path drains it and reassembles the tokens. One implementation, not two.

Inside the generator, in order: intent classification (`classifyIntentWithLLM`) → off-topic short-circuit → **question quota** (`src/lib/questionQuota.ts`, `QUESTION_QUOTA_MAX`/`QUESTION_QUOTA_WINDOW_MS`, sustained per-IP cap, separate from the rate limiter) → context retrieval (`retrieveContext`, see below) → LLM generation via `FallbackOrchestrator.generateWithMeta` / `.generateStream`. Every step is appended to a `steps: string[]` workflow trail carried through to the structured log line and (filtered through `PUBLIC_STEPS`) streamed to the browser — that trail, not inline comments, is the source of truth for how a given request actually resolved.

Two per-IP guardrails exist for different threats: the rate limiter stops a burst; the quota stops sustained use across a whole day. Both are IP-keyed — the only trust boundary available without login. On the quota's final allowed question, a fixed (non-model-generated) LinkedIn CTA is appended to the answer; beyond it, further on-topic questions are declined before any LLM call, so abuse past the cap costs nothing. Off-topic questions never consume the quota.

**Two things about `runPipeline` are load-bearing:**

- **It yields `request_received` / `rate_limit_passed` / `classify_intent` *before* awaiting the classifier.** Previously the route awaited classification and only then returned a response, so nothing at all reached the browser for the first 5.8s of a warm request (longer cold) and the pipeline graph appeared half-built. If you ever move work back above the first `yield`, that silence returns.
- **Logging and notification live in its `finally` block.** Every exit — off-topic, quota-exceeded, success, total failure, and a client that disconnects mid-stream — reports exactly once by construction. The old code called `logRequestOutcome` + `notifyPushover` separately on each of five branches, which is precisely where a double-send or a dropped one would hide. Do not move them back into the branches.

`FallbackOrchestrator.generateWithMeta()` is no longer called by the route (the generator uses `generateStream()` for both transports); it stays as part of the `LLMProvider` surface.

Runtime is pinned via `export const runtime = 'nodejs'` — the winston file-rotating logger needs `fs`, which isn't available on the Edge runtime.

### Conversation memory

`src/lib/session.ts` keeps the last 3 turns per `sessionId` (client-generated UUID, sent in the request body, stored in `sessionStorage` so it clears on tab close) so follow-up questions ("what about his PhD?") resolve. It is folded into the prompt as a "conversation so far" block, explicitly scoped to disambiguation — the retrieved context block remains the stated source of truth for facts, so an earlier wrong answer can't get treated as ground truth and compound. **`sessionId` is never a trust boundary** — a session is bound to the IP that created it and a replay from another IP is treated as unknown; the quota above is what actually limits cost, and it doesn't care what `sessionId` says.

## Content / retrieval layer

Profile content lives in `data/` (`profile.md`, `projects.json`, `community.json`, `hobbies.json`, `music.json`, `site.json`) and is loaded once and cached in-process:
- `src/lib/profile/loader.ts` reads and formats each data file into a `ProfileContext` — plain formatted strings, not embeddings. This is intent-keyed routing, not vector search.
- `src/lib/retrieval.ts` caches the loaded `ProfileContext`. `retrieveContext(intent, question)` unions the classified `intent` with every intent `classify.ts`'s `matchAllIntents(question)` finds keyword evidence for, so a question spanning two topics ("his projects and his music") pulls both sections instead of just whichever one classification happened to pick. More than 3 matched sections (or `intent === 'general'`) falls back to the existing "everything" bundle rather than growing the union further.
- `src/lib/classify.ts` defines the `Intent` union, the regex fallback (`INTENT_PATTERNS`, exported for `matchAllIntents` reuse; `DAVIT_KEYWORDS`), and the LLM classification prompt.

**The off-topic guard.** A small local model will confidently route "What is Barbie?" to `hobbies` — it matches the *subject* to a category instead of asking who the question is about. That is not cosmetic: `off_topic` short-circuits before retrieval, so a wrong label turns a free decline into a full generation call and spends one of the visitor's quota. `guardOffTopic` cross-checks any LLM-assigned intent against `DAVIT_KEYWORDS` and downgrades to `off_topic` when the question mentions nothing recognisable. It only ever downgrades, never promotes.

It is **skipped once a session has history** (`ClassifyOptions.hasHistory`, passed from the route). Follow-ups are legitimately keyword-free — "what else?", "tell me more" — and it is the prior turns that make them on-topic; applying the guard to them would break exactly the conversational flow `session.ts` exists to support. The classification prompt also carries few-shot examples for this case; the guard is the backstop for when the model ignores them.

**Adding a new content section** (e.g. the in-progress `music` section) touches all of: a new `data/*.json` file → a field on `ProfileContext` (`src/types/index.ts`) → formatting logic in `loader.ts` → an entry in `SECTION_BLOCKS` in `retrieval.ts` → an intent + keywords in `classify.ts` → usually a new card component under `src/components/cards/`. Use the `add-content-section` skill; it lists the four edits in `classify.ts` that fail *silently* if missed.

### The `site` section — the site describing itself

`data/site.json` + the `site` intent make the assistant able to answer "tell me about this website" / "how does this work". Without it those questions were classified `off_topic` and met the canned redirect, which read badly given the site is itself part of Davit's portfolio.

Two things about this section are different from the others and should stay that way:

- **`site` is first in `INTENT_PATTERNS`, and its patterns are deliberately narrow.** Order matters because the regex tier and `matchAllIntents` both take the first match, and "how does this site's architecture work?" contains *architecture*, which `background` would otherwise claim. The patterns require an explicit reference to *this* site so that "does Davit know circuit breakers?" stays a skills question rather than being captured by a site that happens to use circuit breakers.
- **Describing the architecture must never become disclosing the infrastructure.** The `SYSTEM_PROMPT` has an "Infrastructure secrets — never disclose" block covering credentials, IP addresses, hostnames, ports, file paths and env values, and it holds against "I am the admin"-style framing. The same boundary is restated inside `site.json`'s `privacy_note`, which the loader appends to the retrieved context — deliberate belt-and-braces, so the rule travels with the content that invites the question rather than living only in the system prompt. One tier runs on a machine in Davit's home, so network details are a physical privacy matter, not just an operational one. Describe tiers by role and published model name; nothing more specific.

## Frontend

App Router, single page (`src/app/page.tsx`) composed of `AppShell` + `ProfileHero`/`StatsGrid` + `AssistantPanel` (the chat UI, client component, primary CTA) + a grid of `src/components/cards/*` "explore" cards. `AssistantPanel` calls `POST /api/ask` directly via `fetch`; no client-side state management beyond local `useState`.

### The pipeline graph (`PipelineTrace.tsx`)

Renders the **whole** pipeline under every answer — all four stages, every tier — with the path actually taken highlighted, rather than listing only the steps that fired. The distinction that makes the fallback chain legible is `not-reached` vs `ok`: a dimmed OpenAI node shows it sat idle *because* the Mac answered, which a flat list of fired steps cannot express. A colour key renders beneath, listing only the states that trace actually used.

`deriveGraph(steps, live)` is exported and pure, and every node state is derived from the `steps` array the server already streams — **no server changes, and nothing decorative**: if a node is green, that step really succeeded. When adding a workflow step, add it to the relevant `TierSteps` entry or it will silently render as `not-reached`.

### The waiting state (`WaitingIndicator.tsx`)

Shown between "question sent" and "first token back" — a gap that is genuinely long when tier 0 is cold (measured: steps land at ~1.7s, first token at ~15s). It rotates copy on elapsed-time thresholds and runs a live clock.

**Its phrases are derived from the real workflow steps (`deriveMode`), not played on a fixed reel.** This is the same rule `PipelineTrace` and `SystemStatusCard` follow: these surfaces are worth something because they report what actually happened. A loader that announced "warming up Davit's Mac" while OpenAI was quietly answering would be the one dishonest thing on the page. If you add copy, keep it true for the mode it sits under — `mac-away` in particular exists so an absent Mac is stated, not papered over.

Two details that look incidental but aren't:
- Steps cannot arrive until classification finishes, because the route awaits `classifyIntentWithLLM` before opening the SSE stream. `WaitingIndicator` therefore seeds its opening mode from `/api/system` (which tier is live) and lets real steps override it the moment they land. Restructure the route to stream during classification and this hint becomes redundant.
- The clock is `aria-hidden`. The bubble around it is `aria-live="polite"`, so a value updating ten times a second would flood a screen reader continuously; the phrase text is what gets announced, at a readable cadence.

## Observability

- `src/lib/logger.ts` — winston, JSON lines to stdout + daily-rotated files in `LOG_DIR` (default `./logs`, gitignored). One `request_completed` event per request carries the full `workflowSteps` trail.
- `src/lib/pushover.ts` — optional, fire-and-forget, active only when `PUSHOVER_USER_KEY`/`PUSHOVER_API_TOKEN` are set. Failures are logged and swallowed, never surfaced to the caller. Two message kinds:
  - **Per-Q&A** (`formatIterationMessage`) — fires on every answered question and carries the question, **the answer that was given**, the tiers that served it, and the duration. Sent at priority `-1` on success so it doesn't buzz, `1` on failure. Message parts are budgeted against Pushover's 1024-char limit so the answer is what gets trimmed, never the tier metadata.
  - **Alerts** (`sendAlert`) — exceptional pipeline events only: a breaker opening or recovering, a stream dying mid-answer, every tier failing at once.

**Alerts are throttled, and that is load-bearing.** `sendAlert` drops repeats of the same `kind` within `PUSHOVER_ALERT_MIN_INTERVAL_MS` (default 1h), and `breakerAlerts` in `circuitBreaker.ts` only notifies on `closed → open` and `* → closed`. Both guards exist for the same reason: a tier that stays down goes `open → half_open → open` on *every* cooldown cycle, so alerting on raw transitions would push a notification every `MAC_CB_COOLDOWN_MS` for as long as the Mac is away. If you add a new alert, give it a `kind` that is stable across repeats of the same underlying condition, or it will bypass the throttle.

Note that per-Q&A pushes send answer text off-box to Pushover. That's intentional, but it's the one place generated content leaves the host.

## Scheduled profile refresh (`src/lib/refresh/`)

`npm run refresh:profile` pulls from GitHub, Spotify and Apple Music and proposes updates to `data/`. Design and source-by-source feasibility (including why LinkedIn and Instagram are *not* here) live in `docs/profile-refresh-plan.md`. Flags: `--apply`, `--no-model`, `--sources=github`.

**The model never fetches and never supplies facts.** Typed adapters hit the APIs and copy fields verbatim; the models only turn structured facts into prose in the profile's voice. A hallucinated job title in `data/` is not a bad log line — `data/` is the source of truth for every answer the site gives, so it is DAVO telling a recruiter something untrue.

### Two model calls, and why the split is the point

This is the load-bearing design decision. A single model asked to both read a README and edit the profile would be holding attacker-influenced text and write intent in the same context.

- **Stage A (`extract.ts`)** is the only code that ever sees untrusted source text. No tools, no network of its own, no knowledge of the profile — a pure text-to-struct function behind an Ollama JSON schema. The worst a successful injection achieves here is hostile *strings* in four known fields.
- **The sanitiser (`sanitize.ts`)** then checks those four fields exhaustively. That exhaustiveness is only possible because the shape is narrow: bounded strings and bounded arrays of bounded strings, no free-form field, nowhere nested to hide a payload.
- **Stage B (`edit.ts`)** diffs against `data/` and proposes minimal edits. Its entire view of the outside world is stage A output that the sanitiser cleared. It may only touch `description`, `tech` and `highlights` — never `name`, `url` or `category`, which are identity and taxonomy.

**Why any of this is needed.** Everything in `data/` is concatenated into the prompt beside `SYSTEM_PROMPT` on every visitor question, including its "Infrastructure secrets — never disclose" block. Until this feature `data/` was entirely hand-written, so third-party text had no route into that prompt at all. This job opens one.

**`sanitize.ts` is pure and the rules are not decorative.** Verified behaviour: injection or infra content in `summary` fails the whole record; ungrounded `tech` entries are dropped individually (every technology must appear somewhere in the source, which is the hallucination guard); non-allowlisted URLs drop the item; zero-width and bidi characters are normalised away *before* pattern matching. A regex list is not a security boundary and won't stop a novel phrasing — its real job is to make a hijacked stage A **loud** rather than silent. The backstop that actually holds is that nothing merges into `data/` without a human reading the diff.

Watch for `[].every() === true` if you touch the list filters — that exact bug silently discarded every valid list item during development while reporting zero violations.

### The review workflow (`/login` -> `/admin`)

A daily scheduled run writes **one** pending proposal and sends a Pushover notification carrying a link to it. `src/lib/refresh/store.ts` holds the rules:

- **`data/proposals/pending.json` is overwritten every run.** Nothing queues. A proposal is only meaningful against the `data/` it was diffed from, so seven days away would otherwise produce seven overlapping and mutually contradictory diffs. Missing a notification costs nothing — the same gap is re-derived tomorrow against current `data/`.
- **Rejections persist, and that is not a contradiction.** The pending proposal is *derived* and free to discard; a rejection is a *decision* and the only input the job cannot re-derive from the sources. Without it, "reject" would be indistinguishable from "ignore" and the same change would return daily. Keyed by content fingerprint (`target|path|op|after`, deliberately excluding the model-written `reason`, which varies run to run for an identical edit and would otherwise expire every rejection after a day). Un-rejecting is available in the UI.
- **Hand-edited values are re-sanitised** in `api/admin/proposal`. Not because the admin is suspected, but because it is the one path where arbitrary text reaches `data/` without passing the refresh pipeline — and `data/` is concatenated into the answer prompt. A failed edit aborts the whole batch rather than applying half of it.
- **Approving calls `invalidateProfileCache()`** (`src/lib/retrieval.ts`). The assistant caches the parsed profile per process; without the invalidation an approval would change the files and nothing a visitor could observe. This reaches the assistant only — `src/components/cards/*` import their JSON statically, so the explore cards still need a rebuild. The UI says so on screen rather than pretending otherwise.

**Auth** (`src/lib/admin/auth.ts`): one password from `ADMIN_PASSWORD`, never in source, compared in constant time over SHA-256 digests (hashing first is what makes `timingSafeEqual` usable — it needs equal-length buffers, and a naive length guard leaks the length). Session is a signed httpOnly SameSite=Strict cookie holding only an expiry; no server-side session table, so nothing to leak, but also nothing to revoke before expiry — restarting without `ADMIN_SESSION_SECRET` rotates the key and kills every session. Login attempts are throttled per IP *separately* from `/api/ask`, because a shared limiter would let ordinary question traffic spend the budget meant to stop password guessing. `/login` and `/admin` are `noindex` + disallowed in `robots.ts`; that is hygiene, not security — the password is the boundary.

**`docker-compose.yml` bind-mounts `./data:/app/data`.** This is what makes the whole review flow possible. The image still bakes a copy so the container runs standalone, but a baked copy is effectively read-only: approvals would write to a layer the next `--build` discards, and the host's scheduled job would write proposals the container could never see.

### Other things that are deliberate

- **Music never touches a model.** A release is a title, a year and a URL; `diffMusic` is a pure function. Stage A is skipped for records with an empty `untrusted` block. The sanitiser still runs, because a title is a third-party string even when it is one of Davit's own.
- **Proposals, not writes.** The job never edits `data/` on its own; it writes a pending proposal and notifies. Approval happens in `/admin` (or `--apply` from the CLI, which is the blunt version). Either way nothing is committed — review the result in `git diff data/`.
- **SoundCloud is oEmbed-only by default.** The keyless public oEmbed endpoint gives the profile, avatar and numeric user id; the track list needs `SOUNDCLOUD_CLIENT_ID`, and SoundCloud closed developer registration years ago. The artist page's `__sc_hydration` blob would yield a full track list today with no credentials — but that is scraping, and declining it for LinkedIn and Instagram and then doing it for the easy platform would make the earlier reasoning a rationalisation rather than a rule.
- **`data/sources/*.raw.json` is committed, `data/proposals/` is gitignored.** The snapshot is what answers "did the source change or did the model?" about a later odd proposal.
- **The job reuses `openMacTier()`**, so it inherits the reachability probe, the warm/cold accounting and the breaker policy rather than reimplementing them. It does **not** share the website's breaker *state*: `macBreaker` is module-level and therefore per-process, and the scheduled jobs are `tsx` processes on the Windows host while the site runs in a container. Same code, two sets of counters. That matters in one visible way — `breakerAlerts('mac', 0)` is wired to the breaker instance, so a batch run that opens its own copy sends a Pushover alert worded as though the site's tier 0 were down, and `pushover.ts`'s throttle is per-process too and cannot dedupe it. It does **not** fall back to OpenAI by default (`REFRESH_ALLOW_PAID_FALLBACK`): the chain exists so a *visitor* never waits on a sleeping laptop, and a batch job has no visitor. It also never uses tier 2 — `llama3` is a fine last resort for a streaming sentence, not for editing someone's professional profile.
- **Both stages default to `MAC_OLLAMA_MODEL`.** Naming a different model makes Ollama evict the resident one, so the next visitor pays a cold start — a cost that lands on the website, not in this job's logs.
- **Scheduled daily at 23:00 Asia/Yerevan** via Windows Task Scheduler (`Personal Pitcher profile refresh`), invoking `scripts/refresh-profile.cmd`. The wrapper exists because a scheduled task starts in `System32` and `config.ts` resolves `data/` from `process.cwd()`, and because Task Scheduler records an exit code and nothing else — the transcript lands in `logs/scheduled-refresh.log`. Exit `1` means a source genuinely failed; a config skip (Mac asleep, no GitHub token, rate limit spent) exits `0`.
- **Timestamps split by audience: structured logs UTC, human messages local** (`src/lib/time.ts`, `DISPLAY_TIMEZONE`, default `Asia/Yerevan`). Logs are correlated across machines and read by tooling; a notification is read by one person on a phone deciding whether this happened just now or overnight. An IANA zone name rather than `+04:00`, because a fixed offset encodes an assumption a government could invalidate and would fail invisibly. `docker-compose.yml` also sets `TZ` so log files roll at local midnight, and the Dockerfile installs `tzdata` — Node honours `TZ` through its own ICU data, but Alpine's `date` does not, and a shell that reports UTC misleads anyone debugging by four hours.
- **GitHub costs ~20 requests/run unauthenticated, ~39 with a token.** The per-repo `languages` call is skipped without `GITHUB_TOKEN`, falling back to the `language` field already in the list response — because the unauthenticated ceiling is 60/hour and 39 means one run fits and a second in the same hour does not.
- **Pushover follows the observability rules above**: stable `kind`s (`profile_refresh_failed`, `profile_refresh_proposal`) so the throttle works, and a run with nothing to propose sends nothing. A weekly "no changes" push gets muted, and a muted channel is not a monitor.
- `OllamaProvider` gained optional `format` and `options`, spread into the request body only when set, so tiers 0 and 2 are untouched. `openMacTier()`/`createMacProvider()` take optional overrides for the same reason.

## Scheduled job outreach (`src/lib/outreach/`)

`npm run outreach` finds roles workable from Yerevan and — from phase 3 — scores
and drafts applications for them. Design, phase table and per-phase definition
of done live in `docs/job-outreach-plan.md`. **Phases 0 to 4 are built**: the
typed preference loader, all nine source adapters (Workday, Pinpoint,
Greenhouse, Lever, Ashby, Remotive, RemoteOK, Arbeitnow, Himalayas), the
deterministic geo filter, `seen.json` dedupe, the budgeted run loop, stage A
extraction, the outreach sanitiser, stage B scoring, the review queue in
`data/outreach/pending.json`, and the `/admin` outreach tab with its three
decisions and the applied ledger behind them. No drafting, no browser and no
sending code exists yet — `approve_send` writes a `dryRun` ledger row and
refuses outright if `OUTREACH_DRY_RUN` is off. Flags: `--explain`, `--source=`, `--company=`, `--max=`, `--deadline=`,
`--no-model`, `--no-cache`, `--geo-fixtures`, `--posting-fixtures`,
`--policy-fixtures`, `--source-fixtures`.

- **`private/job-preferences.md` must never reach the visitor prompt.** Salary
  floor, seniority thresholds and views on current employment live outside
  `data/` precisely because everything in `data/` is concatenated into the
  prompt beside `SYSTEM_PROMPT` on every visitor question. `loader.ts` reads an
  explicit list of filenames and must stay explicit; section 9 of the `verify`
  skill greps for the ways that breaks. `data/outreach/companies.json` is
  committed and non-secret, but stays out of the loader for the same reason —
  the site has no reason to tell a visitor which employers are being watched.
- **The Yerevan override in `geo.ts` is checked before every exclusion rule.**
  A posting that names Armenia passes even when it also carries US-only
  boilerplate. A false pass costs one line in a report a human reads anyway; a
  false drop costs an opportunity nobody learns about. The first draft of the
  plan had this the other way round and would have discarded the best match it
  had found.
- **`seen.json` is permanent, which is the opposite of the refresh job's
  `pending.json`.** A profile proposal is derived and re-derivable; a job
  posting is an external event with its own lifetime, and missing one costs
  something real.
- **Workday sits behind Akamai bot management.** One request at a time
  process-wide, at least 2s apart, server-side `searchText` filtering rather
  than paging, and a 403 stops the run rather than triggering a retry. The
  User-Agent names the bot and carries a contact URL — tested against the live
  endpoint, not assumed.
- **The run is bounded by a wall-clock deadline, not a duration** (`budget.ts`).
  Task Scheduler catches up a missed 08:00 start, so a run beginning at 08:40
  must still be over before the working day rather than getting a full hour.
  Five queue-worthy postings or `OUTREACH_MAX_POSTINGS_PER_RUN` also end it, and
  `stoppedBy` names which — `deadline` every morning for a week means the watch
  list has gone quiet, `matches` before 08:20 means the filters are too loose.
- **The source cursor rotates, and it advances past a unit even when the run
  stopped inside one.** A unit is a whole board fetched from the top, with no
  offset to resume from, so a cursor pointing back at a half-read board re-reads
  the same rows, stops on the same matches and never reaches the sources
  behind it. That was observed, not theorised. The postings left behind stay
  `deferred` in `seen.json` and still count as unfinished work when the rotation
  comes round again.
- **Only aggregator GETs are cached** (`cache.ts`, `data/outreach/cache/`). Never
  a Workday POST — replaying a request to an endpoint whose whole purpose is
  watching request behaviour is meaningless to it and dishonest of us — and
  never a posting detail fetched for stage A. The cache is what lets the 07:00
  discovery run hand its feed reads to the 08:00 opportunity run; a cold or
  broken cache is one extra HTTP call, never a failed run.
- **Two model calls, and the split is the same one the refresh job makes.**
  Stage A (`extract.ts`) is the only code that reads posting text: no tools, no
  network, no knowledge of Davit, behind a fourteen-field JSON schema. The
  sanitiser (`outreach/sanitize.ts`) then checks that shape exhaustively, which
  is only possible because it is narrow. Stage B (`score.ts`) sees the sanitised
  struct and the typed preferences, never a posting. A posting that tells the
  extractor to redirect the application reaches a stage that cannot send mail,
  and its output reaches a stage that never sees the instruction.
- **`outreach/sanitize.ts` is built from `checkField` and `filterUngrounded`,
  and deliberately does not use `sanitizeExtracted` or `URL_ALLOWLIST`.** The
  first is bound to the refresh job's `ExtractedFacts`; the second allowlists
  GitHub and Spotify, because it answers "may this link appear on Davit's public
  site?" rather than "is this apply address on the posting's own domain?".
  Fatality is decided by *exclusion* — a named list of structural rules is
  non-fatal and everything else fails the whole record — so a new injection
  pattern upstream becomes fatal here automatically.
- **The §7 local-Yerevan override is code, never prompt wording.** `score.ts`
  applies it after the model answers, along with the seniority thresholds
  `preferences.ts` parses and a narrow "clearly below the published band" check.
  A rule this categorical must not depend on a model honouring it, and the same
  goes for "nothing below Senior" — handed over as prose it survives only as long
  as the model feels like it, and the failure is silent. `--policy-fixtures`
  exercises all of them with no model, because the override only fires when a
  model *has* said `draft`, which a fortnight of real mornings might not
  produce.
- **A run with no model still produces a queue.** Postings arrive `unscored`,
  `seen.json` keeps them `deferred`, and the next run that finds a model scores
  them and replaces the placeholder. Six unscored links with real titles beat an
  empty morning.
- **The three decisions on a card mean three different things to the stores**,
  and that is why they are three buttons rather than one dismiss. *Approve &
  send* writes the ledger and consumes both the daily cap and the per-company
  cooldown. *Not interested* writes `rejected.json` keyed by `dedupeHash` and
  touches neither — a rejection is not an application, and letting it spend the
  cooldown would mean saying no to one bad role at NVIDIA blocked a good one for
  a month. *Already applied* writes the ledger with `channel: 'manual'` and
  sends nothing at all, because from the recipient's side it was an application.
  A single "dismiss" would get one of them wrong in each direction.
- **`mark_applied` returns before anything that could send.** It is the one
  action that writes the ledger without a transmission, so `send.ts` must be
  imported inside `approve_send` when phase 6 lands — never at the top of
  `api/admin/outreach/route.ts`, where this branch could fall through into it.
- **`applied.json` is the most important file the system owns** (`ledger.ts`).
  Never pruned, backed up to `.bak` *before* every write, and gitignored — which
  means it lives in exactly one place on one machine and is the one file here
  worth including in whatever backs up `data/`. Losing `seen.json` costs a day
  of duplicate noise; losing this means re-applying to everyone ever contacted.
- **Every adapter exports its normaliser separately from its fetch**, and
  `npm run outreach -- --source-fixtures` runs all nine over real captured
  responses in `data/outreach/fixtures/`. This is the closest thing to a unit
  test the adapters have, and it exists for a bug the type checker cannot see:
  an adapter written from a board's documentation rather than its output
  compiles, maps `row.title` on a board whose title field is called `text`
  (Lever's is), and finds nothing while reporting no errors.

## Deployment

`Dockerfile` is a 3-stage build using Next's `output: 'standalone'`; it copies `data/` into the image (content is baked in at build time, not mounted) and exposes `/app/logs` as a volume.
