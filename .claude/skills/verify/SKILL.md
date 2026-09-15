---
name: verify
description: Verify a change in this repo, which has no test suite and no linter. Use before reporting any change complete, and whenever touching the LLM provider chain, the /api/ask route, or rate limiting. Covers type checking, the manual request drill, and how to force each fallback branch.
---

# Verifying a change

There is no test framework and no ESLint config here. `npm test` and `npm run lint` do not exist. Verification is type checking plus driving the real request path.

## 1. Type check (always)

```bash
npx tsc --noEmit
```

Fast, catches most regressions in the loader/retrieval/types chain. Never report a change complete without it.

## 2. Build (before anything deployment-shaped)

```bash
npm run build
```

Only needed when touching `next.config.ts`, the Dockerfile, or route/rendering-level Next.js behavior. Note `output: 'standalone'` and that `data/` is **copied into the image at build time** — content changes require a rebuild, not a restart.

## 3. Exercise the real path

```bash
npm run dev
curl -s -X POST http://localhost:3000/api/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"What projects has Davit built?"}'
```

Then read the last `request_completed` line in `logs/app-$(date +%F).log`. **`workflowSteps` is the only place the resolution path is visible** — the HTTP response looks identical whether OpenAI or Ollama answered.

Expected shape on the happy path:
`rate_limit_passed → classify_intent → classifier_openai_attempt → classifier_openai_success → intent:projects → retrieve_context → llm_generate → openai_attempt → openai_success`

## 4. Fallback drills

Any change under `src/lib/llm/**` or to `classify.ts` needs these, because a broken fallback is invisible from the UI — the site keeps answering, just always from the wrong provider.

| Drill | Setup | Expect in `workflowSteps` |
|---|---|---|
| No OpenAI | unset `OPENAI_API_KEY` | `openai_not_configured` → `ollama_attempt` → `ollama_success` |
| OpenAI rejects | `OPENAI_API_KEY=sk-invalid` | `openai_failure_non_transient` → `fallback_to_ollama` → `ollama_success`; answer still 200 |
| OpenAI unreachable | `OPENAI_BASE_URL=http://127.0.0.1:9` | `openai_failure_transient` → `fallback_to_ollama` |
| Breaker opens | unreachable base URL, then `CB_FAILURE_THRESHOLD` (default 5) requests | `circuit_open_skip_openai` on the next request |
| Breaker recovers | wait `CB_COOLDOWN_MS` (default 60000), restore a good key | `openai_attempt` → `openai_success` |
| Total failure | no OpenAI **and** Ollama stopped | 500, `llm_generate_failed`, and the user-facing generic error |

**A 401 will not open the breaker.** `isTransientError` counts only network/timeout/quota/5xx; a bad key is a non-transient `http` 401, so it falls back every time without ever tripping. If you are trying to test the breaker, use an unreachable URL, not a bad key.

## 5. Rate limiting

```bash
for i in $(seq 1 11); do curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  http://localhost:3000/api/ask -H 'Content-Type: application/json' \
  -d '{"question":"hi Davit"}'; done
```

Expect ten non-429s then a 429. The store is an in-process `Map` keyed by IP, so it resets on dev-server restart.

## 6. Question quota (separate from rate limiting)

Rate limiting caps a burst; the quota (`src/lib/questionQuota.ts`) caps total on-topic questions per IP within `QUESTION_QUOTA_WINDOW_MS` (default 3 per 24h) — this is the actual cost guardrail. Wait a beat between requests below or the rate limiter (10/min) will 429 first.

```bash
for i in 1 2 3 4; do curl -s -X POST http://localhost:3000/api/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"What projects has Davit built?"}' | head -c 200; echo; done
```

Expect: questions 1–2 answer normally; question 3's answer ends with the LinkedIn CTA and `workflowSteps` contains `question_quota_final`; question 4 is answered with the quota-exceeded message **and `workflowSteps` contains no `retrieve_context`/`llm_generate`/`openai_attempt`** — that's the point, a blocked question must not reach the LLM. Off-topic questions ("what's the weather") must not consume the quota — interleave one and confirm the on-topic count doesn't advance.

`QUESTION_QUOTA_MAX=100` in the environment is the fast way to get the rest of the suite back to normal without waiting out the window.

## 7. Session context (multi-turn)

`sessionId` is generated client-side and is not exercised by a bare `curl`, so drive it explicitly:

```bash
SID=$(node -e "console.log(crypto.randomUUID())")
curl -s -X POST http://localhost:3000/api/ask -H 'Content-Type: application/json' \
  -d "{\"question\":\"What was Davit's most complex project?\",\"sessionId\":\"$SID\"}" | head -c 300; echo
curl -s -X POST http://localhost:3000/api/ask -H 'Content-Type: application/json' \
  -d "{\"question\":\"What tech did he use for it?\",\"sessionId\":\"$SID\"}" | head -c 300; echo
```

The second answer should resolve "it" as the project named in the first answer, not ask for clarification. Repeat the second request with a **different** random `sessionId` and confirm it can't resolve "it" — a session must not leak across ids.

## 8. Multi-section retrieval

A question naming two topics should pull both sections, not just the one the classifier picked as primary:

```bash
curl -s -X POST http://localhost:3000/api/ask -H 'Content-Type: application/json' \
  -d '{"question":"What are Davit'"'"'s projects and what music does he make?"}' | head -c 400
```

Check the matching `request_completed` log line for a `sections:` step (e.g. `sections:projects+music`) in `workflowSteps`, and confirm the answer actually addresses both halves of the question.

## 9. Private data isolation (run on every change, not just outreach ones)

The job outreach feature keeps Davit's salary floor, seniority thresholds and
views on his current employment in `private/job-preferences.md` — gitignored,
and outside `data/` on purpose. Everything in `data/` is concatenated into the
prompt beside `SYSTEM_PROMPT` on every visitor question, so the same file kept
there would be answered honestly to the first visitor who asked what salary he
wants.

Two greps hold that line. Both must print nothing:

```bash
grep -rn "private" src/lib/profile/ src/lib/retrieval.ts
grep -rn "outreach\|companies.json" src/lib/profile/ src/lib/retrieval.ts
```

The second covers `data/outreach/companies.json`, which is committed and not
secret — but the site still has no reason to tell a visitor which employers DAVO
is watching.

The other half of the guard is a convention the greps cannot see:
**`src/lib/profile/loader.ts` reads an explicit list of filenames and must stay
explicit.** A directory scan over `data/` would pull in any future file without
anyone deciding to, which is precisely how the preference doc would end up in a
visitor's answer.

## 10. Scheduled job drills (no server, no model, no network)

The outreach jobs have no test framework either, but they do have five
pure-function drills over saved responses. They need nothing running — not the
dev server, not the Mac — so run whichever ones the change touched, and all five
before calling a phase done:

```bash
npm run outreach -- --geo-fixtures            # 15 cases, the Yerevan filter
npm run outreach -- --posting-fixtures        # 8 cases, incl. the injection one
npm run outreach -- --policy-fixtures         # 10 cases, the categorical rules
npm run outreach -- --source-fixtures         # 9 adapters over real responses
npm run outreach:companies -- --detect-fixtures  # 12 careers-page shapes
```

Each prints `N/N passed` and exits 1 on any mismatch. They exist for bugs the
type checker cannot see: an adapter written from a board's documentation rather
than its output, a geo rule that drops the one role worth having, a detector
that works on two ATS boards and fails on the third.

Two live-ish checks, both safe to run repeatedly:

```bash
npm run outreach -- --no-model --explain      # adapters, geo filter, budget loop
npm run outreach:companies -- --no-feeds      # candidates.txt, nothing else
```

## 11. UI changes

Delegate to the `ui-checker` agent rather than eyeballing the diff — it boots the server, asks a real question in a browser, and checks desktop and mobile.

## Reporting

Say which of these you actually ran. If you could not run the request drill (no Ollama installed, no API key), say so explicitly rather than implying the path was verified — an unexercised fallback is the exact bug class this repo is prone to.
