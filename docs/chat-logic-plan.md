# Chat Logic Revisit — Context, Multi-Topic Retrieval, and Cost Guardrails

**Date:** 2026-09-10
**Baseline:** current working tree (uncommitted Phase 1–3 UI work already in place)
**Status:** implemented, verified, and deployed 2026-09-10.

---

## 1. The four things raised, and what's actually true

| # | Raised as | What the code actually does |
|---|---|---|
| 1 | "does not preserve context for session" | Confirmed. `POST /api/ask` is fully stateless — `route.ts` builds a prompt from nothing but the current question and one retrieved section. A follow-up like "what about his PhD?" has no idea what "his" refers to. |
| 2 | "in a single question it only seems to find single file" | Confirmed. `retrieveContext(intent)` in `src/lib/retrieval.ts` switches on **one** classified `Intent` and returns **one** section (`bio` + at most one of projects/community/hobbies/music). A question spanning two topics ("his projects and his music") only gets whichever section the classifier picked. |
| 3 | "model... maybe more advanced" | `OPENAI_MODEL` defaults to `gpt-4o-mini`, already configurable. |
| 4 | "ratelimiter and also limit to 3 questions... final answer... LinkedIn" | A per-IP rate limiter already exists (`src/lib/rateLimit.ts`, 10 req/min) but nothing caps *total* on-topic questions, and nothing ever points a visitor at LinkedIn. |

## 2. Resolving the tension in #3

A public, unauthenticated endpoint with an upgraded model is a direct move *against* "stay on the safe side so nobody maliciously uses all my AI credits" — a stronger model multiplies the cost of every abusive request, and cost-per-request is the one lever this specific ask is trying to shrink, not grow.

The quota in item #4 changes that calculus, though: once total on-topic questions are hard-capped per IP per day, the worst case per IP becomes bounded regardless of model price. The remaining risk — IP rotation across many distinct addresses — exists today at `gpt-4o-mini` prices too; a model upgrade doesn't change that risk's shape, only its per-request cost.

**Resolution:** leave the *default* at `gpt-4o-mini` — I won't unilaterally raise Davit's real API spend — but note in `.env.example` that the quota now makes a stronger model a safer choice than before, as a one-line config change he can make himself. The actual quality lever this plan pulls is #1 and #2: better context beats a bigger model at zero marginal risk.

## 3. Design

### 3.1 Multi-section retrieval (fixes #2)

`classify.ts` already has per-intent keyword regexes (`INTENT_PATTERNS`) used for the regex-fallback classifier. Reuse them for retrieval instead of duplicating keyword logic:

- Export `INTENT_PATTERNS` and add `matchAllIntents(question): Intent[]` — runs every non-`off_topic`/`general` pattern against the raw question, returns every intent that matched (not just one).
- `retrieveContext(intent, question)` changes signature: union the classified `intent` with `matchAllIntents(question)`, dedupe, drop `contact` (already folded into `bio`). If the union has more than 3 sections (or `intent` is already `general`), fall back to the existing "everything" bundle rather than trying to bound an ever-growing union — `general` is already the deliberately-unbounded case.
- The set of sections actually used is pushed onto `ctx.steps` as `sections:projects+music` so it shows up in the pipeline trace already built for this UI — directly reinforces "transparent AI pipeline" rather than adding an invisible change.

### 3.2 Session context (fixes #1)

- New `src/lib/session.ts`: in-memory `Map<sessionId, { ip, turns, expiresAt }>`, same TTL-sweep shape as `rateLimit.ts`. Keeps the **last 3** turns only — this is LLM context, not UI history (the browser already keeps the full visible transcript in React state).
- The session is bound to the IP that created it; a `sessionId` replayed from a different IP is treated as unknown rather than trusted. `sessionId` is a client-generated `crypto.randomUUID()` stored in `sessionStorage` (clears on tab close) — it is a UX convenience, **not** a security boundary. The security boundary stays IP-based, same as the rate limiter and the new quota below, so guessing or rotating a `sessionId` cannot bypass the question cap.
- Client (`AssistantPanel.tsx`) generates/persists the id once and sends it with every request; `askStream.ts` and the JSON path both carry it in the request body.
- Server folds the last 3 turns into the prompt as a "Conversation so far" block ahead of the retrieved context, so pronouns and follow-ups resolve. The retrieved context block remains the stated source of truth for facts — history is explicitly scoped to disambiguation, not treated as ground truth, so a wrong answer earlier in the conversation can't get treated as fact and compound.
- A turn is appended to the session only after generation succeeds, using the raw model answer (without the LinkedIn CTA suffix from 3.3, so the CTA text never leaks into a future prompt as "context").

### 3.3 Question quota + LinkedIn CTA (fixes #4)

- New `src/lib/questionQuota.ts`, same Map-with-TTL shape as `rateLimit.ts`. Config: `QUESTION_QUOTA_MAX` (default 3), `QUESTION_QUOTA_WINDOW_MS` (default 24h). Keyed by IP — the same trust boundary as the rate limiter, deliberately not by `sessionId`.
- `consumeQuota(ip)` returns `{ allowed, isFinal, count, max, resetAt }`. Only questions that reach generation consume it — off-topic questions are still free (classification-only, no generation cost, matching the existing off-topic short-circuit).
- **4th+ on-topic question in the window:** short-circuited before context retrieval or any LLM generation call — same shape as the existing off-topic branch, fixed message pointing to LinkedIn, zero generation cost.
- **3rd (final allowed) question:** proceeds normally, but a fixed, code-appended suffix is added after the model's own answer — not model-generated, so it's guaranteed to appear with the correct link every time rather than relying on the model to remember it's the last turn. Applied identically on the buffered JSON path and as trailing `token` events on the SSE path, before the terminal `meta` event.
- Both response shapes gain `questionsRemaining` so the UI can show the count *before* the visitor hits the wall, not just explain it after.
- Both new outcomes get workflow steps (`question_quota_exceeded`, `question_quota_final`) — added to the route's `PUBLIC_STEPS` allowlist and given friendly labels in `PipelineTrace`, consistent with how every other fallback/outcome in this pipeline is already surfaced.
- `LINKEDIN_URL` is pulled into a shared `src/lib/constants.ts` rather than re-typed as a literal in the route — `ProfileHero.tsx` and `AppShell.tsx` already hardcode the same URL twice; point them at the constant too so the three can't drift.

### 3.4 Client UX

- `AssistantPanel` tracks `questionsRemaining` from the last `meta` event and shows a small note near the composer ("2 of 3 free questions left today"). When it hits 0, the composer and suggested questions disable and a compact LinkedIn banner replaces them — belt-and-suspenders with the server-side block, so a visitor sees the wall coming instead of firing a request that gets rejected.

## 4. Non-goals

- No true multi-label classifier rewrite — reusing the existing regex table for a keyword union is lower-risk and sufficient for a profile-QA site of this size.
- No persistent (cross-restart) session or quota store. Same limitation as the existing rate limiter and circuit breaker: process-local, documented, acceptable for a single-instance deployment.
- No login/auth. IP remains the only available trust boundary; VPN/NAT sharing and IP rotation are accepted residual risks, unchanged from the existing rate limiter's threat model.

## 5. Verification plan

1. `npx tsc --noEmit` and `npm run build`.
2. Manual multi-topic drill: ask a question spanning two sections (e.g. "what are Davit's projects and what music does he make?") and confirm `ctx.steps` shows both sections retrieved.
3. Manual session drill: ask "What was Davit's most complex project?" then "What tech did he use for it?" in the same browser session and confirm the second answer resolves "it" correctly; confirm a fresh `sessionId` (new tab) does not see the first tab's history.
4. Quota drill: 3 on-topic questions from one IP succeed, the 3rd carries the LinkedIn suffix, the 4th is blocked pre-generation (verify via `workflowSteps` that no `llm_generate`/`openai_attempt` step appears on the 4th).
5. Confirm off-topic questions do not consume the quota (ask 3 off-topic + 1 on-topic from a fresh IP-equivalent and confirm the on-topic one still succeeds as question 1 of 3).
6. Re-run the existing fallback drills in `.claude/skills/verify/SKILL.md` to confirm nothing in the provider chain regressed.

---

## 6. Verification record — 2026-09-10

All of the following were run against the changed code, not inferred.

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run build` | clean; routes unchanged (`/`, `/api/ask`, `/api/system`) |
| Multi-section retrieval | "projects and music" question → `sections:projects+music` in `workflowSteps`; answer addressed both topics |
| Session context | turn 2 ("what tech did he use for it?") correctly resolved "it" to the project named in turn 1; a fresh `sessionId` on the same IP could not |
| Quota — happy path | Q1/Q2 answer normally; Q3 carries the LinkedIn CTA and `question_quota_final`; Q4 blocked with `question_quota_exceeded` as the last step — **no** `retrieve_context`/`llm_generate`/`openai_attempt` after it |
| Quota — streaming | identical behavior confirmed over SSE: CTA as a trailing `token` event on Q3, blocked `token`+`meta` with `questionsRemaining:0` on Q4, no generation steps |
| Quota — off-topic exemption | 2 off-topic questions from a fresh IP, then the first on-topic question still reports `2 of 3` remaining |
| Regression — OpenAI unreachable | `openai_failure_transient → fallback_to_ollama → ollama_success` unchanged |
| Regression — breaker opens | opened after threshold; subsequent request shows `circuit_open_skip_openai` unchanged |
| Regression — total failure | both providers dead → regex classifier, 500, `llm_generate_failed` unchanged |
| `docker compose up -d --build` | container healthy; quota verified live against the deployed container |

### Bug found and fixed during verification

`isPublicStep()` in `route.ts` allowlisted the `intent:` prefix for the SSE stream but not the new `sections:` prefix — the multi-section retrieval step was correctly written to the log but silently dropped before reaching the browser, so `PipelineTrace`'s handling for it (already built) was unreachable dead code end-to-end. Fixed by extending `isPublicStep` to also allow `sections:`, and reconfirmed via a live SSE request that the step now arrives client-side.

### Not done

- No persistent (cross-restart) session or quota store — same accepted limitation as the existing rate limiter and circuit breaker, documented in `session.ts`/`questionQuota.ts`.
- Model tier left at `gpt-4o-mini` by default; `.env.example` documents that the new quota makes a stronger model a safer choice than before, as Davit's own one-line config call.
