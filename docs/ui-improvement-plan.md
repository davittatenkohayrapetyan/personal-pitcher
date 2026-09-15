# Personal Pitcher — Deployment Fixes & UI Engagement Plan

**Date:** 2026-09-10
**Baseline commit:** `e63dfc0`
**Status:** Phases 1–3 implemented, verified, and deployed 2026-09-10. Item 3.6 is partially
unblocked and still needs two facts from Davit — see §3.6 and §6.

---

## 1. Why this plan exists

The site is a well-built CV page that *happens* to have a chatbot on it. The goal is the
opposite: an AI system that *happens* to also be a CV. Every change below is judged against
five positioning claims that the current UI does not support:

| Claim to project | Current UI evidence | Gap |
|---|---|---|
| AI-heavy architect | Circuit breaker, 3-tier fallback, intent-routed retrieval all exist in `src/lib/**` — **none are visible** | The most impressive thing about this codebase is invisible |
| Versatile / language-agnostic backend | Hero badge, `SkillsCard`, and `data/` all lead with Java/Kotlin (36 Java vs 3 TS / 5 Go mentions) | Claim has no evidence behind it |
| PhD | Buried three clicks deep inside the Experience dialog | Not in hero, not in stats |
| Strong ownership | Stats read "13+ Years / 9+ Companies Served" — staffing-agency tenure, not ownership | No Problem→Decision→Outcome narrative anywhere |
| Interesting / a good challenge | Suggested questions are all safe ("What are Davit's hobbies?") | Nothing invites a hard conversation |

## 2. Non-goals

- No redesign of the layout grid. The two-column composition and the a11y work are good and stay.
- No new runtime dependencies for streaming — use Web `ReadableStream` per
  `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`, not the `ai` SDK.
- **No invented facts.** Anything presented as biography must trace to `data/`. Where the plan
  needs evidence that does not exist (polyglot work), it stops and flags it rather than fabricating.

---

## Phase 1 — Defects and deployment hygiene

Cheap, contained, and they unblock everything else.

### 1.1 `.env` is baked into the Docker image `[security]`

There is no `.dockerignore`, so `COPY . .` in the builder stage pulls `.env` into the image and
Next inlines it. Proof: `docker-compose.yml` sets `LLM_PROVIDER=ollama`, but a live request
resolved via `openai:gpt-4o-mini`. The key sits in an image layer.

- Add `.dockerignore`: `.env*`, `node_modules`, `.next`, `.git`, `logs`, `docs`.
- Pass secrets at runtime via compose `env_file:`, not at build time.
- **Accept:** the image no longer contains `.env`; the app still reaches OpenAI at runtime.

### 1.2 Logs are lost on every rebuild

`VOLUME ["/app/logs"]` with no compose volume creates an anonymous volume, orphaned on each
`up --build`.

- Add a named volume `pitcher-logs:/app/logs` and a `healthcheck`.
- **Accept:** rebuild twice; the second container still sees the first container's logs.

### 1.3 `* { padding: 3px }` — `src/app/globals.css:5`

A universal padding on every element. It adds ~3px of padding to every element that does not set
its own, and silently competes with Tailwind's `p-*` utilities.

- Delete the `padding` declaration; keep the `box-sizing` / `margin` reset.

**Correction (post-verification):** this was originally filed as the cause of horizontal
clipping at 390px. It was not. The clipping in that screenshot was an artifact of Chrome's
minimum window width on Windows (~512 CSS px), not a layout bug — rendering the page inside a
390px iframe shows it wrapping correctly, both before and after this change. The rule was still
worth deleting on its own merits; it was not fixing an overflow bug.

### 1.4 Answers render markdown as literal text — `src/components/QATimeline.tsx:78`

`whitespace-pre-wrap` on a plain `<p>`, while the system prompt asks for structured sections and
the model returns markdown. A live answer came back containing literal `### Backend Engineering`
and `**Languages**:`. The AI product cannot render its own output.

- Add a small dependency-free renderer (`src/components/Markdown.tsx`) covering what the system
  prompt actually produces: headings, bold, italics, inline code, bullet and numbered lists,
  links, paragraphs. No `dangerouslySetInnerHTML`.
- **Accept:** ask "What is Davit's tech stack?"; headings and bold render as elements.

### 1.5 Default font — `src/app/globals.css:19`

`font-family: Arial, Helvetica`. Every other design decision on the page is deliberate; the
typeface is the browser default.

- `next/font/google`: Inter (sans) + JetBrains Mono (pipeline trace and technical chrome), wired
  as CSS variables in `layout.tsx` and consumed by the Tailwind v4 `@theme` block.
- **Accept:** build succeeds. Note `next/font/google` fetches at build time, so the Docker build
  needs network.

### 1.6 Footer misstates the architecture — `src/components/AppShell.tsx:65`

Says "Powered by a local LLM". It is OpenAI primary with Ollama fallback — the better claim.

---

## Phase 2 — Make the site demo its own architecture

The highest-leverage work. The data already flows through the API; it is discarded before it
reaches the browser.

### 2.1 Stream the answer

6.8s of a bouncing-dot indicator is the single biggest engagement loss.

- `generateStream()` on `OpenAIProvider` / `OllamaProvider` (both stream natively — SSE and
  NDJSON respectively) and on `FallbackOrchestrator`, emitting typed events: `step`, `token`,
  `meta`, `error`.
- **The fallback must survive streaming.** If OpenAI fails *before* the first token, fall back to
  Ollama transparently. If it fails *mid-stream*, do not silently restart from scratch — emit an
  error step. This is the one real hazard in this phase.
- `/api/ask` returns `text/event-stream`; all existing logging, `workflowSteps` and Pushover
  behaviour preserved and fired on stream completion.
- Keep the non-streaming JSON path for `curl` and the verify drill (`Accept: application/json`).
- **Accept:** every drill in `.claude/skills/verify/SKILL.md` §4 still produces the documented
  `workflowSteps`.

### 2.2 Live pipeline trace under each answer

Render the `steps` trail that is already being logged as a collapsible strip:
`classify → intent:projects → retrieve(projects.json) → gpt-4o-mini · 1.2s`.
Steps tick in live as they arrive, before the first token. Fallback steps render amber:
`openai ✗ → circuit open → ollama llama3.2`. A visitor watching a real fallback happen learns
more than any bullet list can tell them.

### 2.3 System status card and `GET /api/system`

A small always-visible panel next to Explore: circuit-breaker state (`getState()` is already
exported and unused), provider chain, model names, requests served, p50 latency.

- Must expose **no** secrets — model names and breaker state only, never keys or base URLs.

---

## Phase 3 — Positioning

### 3.1 Hero — `ProfileHero.tsx`

Lead with `PhD · Staff Engineer · Backend architect who builds AI systems`. Reorder badges so
architecture and AI lead and `Java · Kotlin` sits third. Add a one-line "what I'm looking for"
that names the challenge appetite explicitly.

### 3.2 Stats — `StatsGrid.tsx`

Replace tenure metrics with outcome-shaped ones: `PhD` / `13+ yrs` / a modernization outcome /
`1,254 community members`. Cut "Companies Served" — the weakest tile on the page.

### 3.3 Skills by problem domain — `SkillsCard.tsx`

Restructure around resilience, data-in-motion, observability and AI systems, with languages as an
implementation detail underneath. This is an honest presentation change: it reframes existing
facts without asserting new ones.

### 3.4 Provocative suggested questions — `AssistantPanel.tsx`

Swap the safe six for ones that invite the wanted conversation: "What's the hardest system Davit
has debugged?", "Why hire a Java architect for an AI role?", "What was Davit's PhD on?",
"Convince me Davit isn't just a Java guy." The last two surface the PhD and pre-empt the
pigeonholing. Requires matching `classify.ts` keywords so these route to a real intent instead of
`off_topic`.

### 3.5 Case-study card — new `cards/CaseStudyCard.tsx`

One card, Problem → Constraint → Decision → Outcome, built **only** from facts already in
`data/profile.md`. Every other card is a list; none is a story, and ownership only reads through
story.

### 3.6 Polyglot evidence `[PARTIALLY UNBLOCKED]`

The original assessment — that `data/` contained no non-JVM evidence — was wrong. It was already
there and simply never surfaced: **Synopsys 2015–2020 was five years of C++, QT and Verilog** on
embedded memory testing and repair, silicon production analysis tooling, and performance-sensitive
low-level software. `ExperienceCard.tsx` had been describing that role as "backend systems
engineering at scale", which erased the strongest polyglot evidence in the whole profile.

Shipped as a result:
- An **Engineering Range** section in `data/profile.md`, derived entirely from the existing
  experience entries, so the assistant can answer "is he only a Java guy?" with specifics.
- `ExperienceCard` corrected to name C++ · QT · Verilog and to lead with "five years outside
  the JVM".
- `StatsGrid` claims "4 languages shipped to production" (Java, Kotlin, C++, TypeScript).

**Still needs Davit's input:**
- **PhD thesis topic.** `data/profile.md` records the degree and the year but not the subject, so
  "What was Davit's PhD on?" is unanswerable and was cut from the suggested questions. This is
  the single highest-value missing fact for the positioning.
- **Go / Python evidence.** The Engineering Range section describes these as tooling and
  community use rather than primary production languages, which is as far as the data supports.
  If there is real production work, it should be added to `data/projects.json`.

---

## 4. Verification

Per `.claude/skills/verify/SKILL.md`, this repo has no test suite and no linter.

1. `npx tsc --noEmit` after every phase.
2. `npm run build` for Phase 1.5, the Phase 2 route changes, and any Dockerfile change.
3. Request drill against the container; read `workflowSteps` in the `request_completed` log line.
4. Phase 2 requires the full §4 fallback drill table — a broken fallback is invisible from the UI.
5. Desktop (1440) and mobile (390) screenshots; 390 is the gate for 1.3.
6. `docker compose up -d --build`, then re-run step 3.

## 5. Risks

| Risk | Mitigation |
|---|---|
| Streaming breaks the fallback chain invisibly | Full §4 drill table before calling Phase 2 done; explicit mid-stream error step |
| `next/font/google` needs network at Docker build | Verify the image build end to end, not just `npm run build` |
| Pipeline trace leaks internals | Whitelist step names for the UI; never forward raw errors, base URLs or keys |
| Positioning copy drifts into invented claims | Every biographical assertion traces to `data/`; 3.6 stays blocked rather than guessed |


---

## 6. Verification record — 2026-09-10

All of the following were run against the changed code, not inferred.

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run build` | clean; routes `/`, `/api/ask`, `/api/system` |
| Streaming answer (SSE) | steps → tokens → meta, terminal `[DONE]` |
| Buffered answer (JSON, no `Accept` header) | unchanged shape, still 200 |
| Drill: OpenAI unreachable | `openai_failure_transient → fallback_to_ollama → ollama_attempt → ollama_success` |
| Drill: breaker opens | opened after threshold; `/api/system` flipped the active tier to ollama |
| Drill: breaker open, streaming | `circuit_open_skip_openai → ollama_attempt → ollama_success` |
| Drill: total failure (both providers dead) | regex classifier fired; terminal `error` event; JSON path still 500 |
| Drill: rate limiting | non-429s then 429, respecting requests already spent in the window |
| `workflowSteps` in `logs/` on the streaming path | present and complete |
| Markdown rendering | headings, bold, italic, inline code, bullet + ordered lists, links |
| Pipeline trace | auto-expands on fallback; success green, fallback amber |
| Layout at true 390px viewport | no horizontal clipping |
| Image contains no `.env` and no key in build output | confirmed |
| `docker compose up -d --build` | container healthy; named logs volume created |

### Not done
- **3.6 PhD thesis topic and Go/Python production evidence** — needs Davit; see §3.6.
- **Persistent metrics.** `src/lib/metrics.ts` is per-process and resets on restart, matching the
  existing breaker and rate limiter. Fine for one container; wrong the moment there are two.
