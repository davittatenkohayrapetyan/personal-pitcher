# Personal Pitcher 🎯

A personal AI pitch website for Davit Hayrapetyan. Visitors can ask questions about Davit's professional background, projects, community contributions, and personal interests — powered by a four-tier LLM fallback chain: a 26B model on a Mac at home, then OpenAI, then a local Llama, then a regex classifier.

## Features

- 🎨 **Clean portfolio UI** — Hero section, photo cards, and Q&A timeline
- 🤖 **AI-powered answers** — a Mac on the home LAN answers for free when it's awake; OpenAI when it isn't
- 🔁 **Two circuit breakers** — Independently skip the Mac tier and OpenAI when either is down, then probe for recovery
- 🛡️ **Request validation** — Input length, type checks
- ⏱️ **IP-based rate limiting** — 10 requests per minute per IP
- 🧠 **Intent classification** — Routes questions to relevant profile sections
- 📚 **RAG-style retrieval** — Pulls context from curated markdown/JSON profile files
- 🚧 **Guardrails** — Only answers questions about Davit Hayrapetyan
- 📝 **JSON request logging** — Every request/response is logged as JSON to a daily-rotated file (`logs/app-YYYY-MM-DD.log`) plus stdout
- 🔄 **Scheduled profile refresh** — A daily job pulls from GitHub, Spotify, Apple Music and SoundCloud, and proposes updates through a two-model pipeline that keeps untrusted source text away from the step that edits the profile
- 🔐 **Hidden review screen** — `/login` → `/admin` to approve, reject or hand-edit each proposed change before it reaches the site
- 📱 **Pushover notifications** — Optional push per Q&A including the answer the model gave, plus throttled alerts for exceptional events (a tier going down or recovering, an answer cut off mid-stream, every tier failing at once)

## Quick Start

### Prerequisites
- Node.js 20+
- [Ollama](https://ollama.ai) installed and running with `llama3` model (used as fallback)

### Local Development

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env.local

# Pull the LLM model (requires Ollama — used as fallback)
ollama pull llama3

# Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Docker Compose (with Ollama)

```bash
docker compose up -d

# Pull the model inside the Ollama container
docker compose exec ollama ollama pull llama3
```

### Using OpenAI (Recommended)

Set in `.env.local`:
```
OPENAI_API_KEY=sk-your-key
OPENAI_MODEL=gpt-4o-mini
```

When `OPENAI_API_KEY` is present, OpenAI handles any request the Mac tier didn't. If OpenAI fails for any reason, the system automatically falls back to the local Ollama — no user-visible error. If `OPENAI_API_KEY` is not set, requests go straight to the local Ollama.

## LLM Provider Strategy

Answers walk a **four-tier fallback chain**, each tier tried only if the ones above it are unavailable:

| Tier | Provider | Guarded by | Skipped when |
|---|---|---|---|
| 0 | **Mac Ollama** — `gemma4:26b` on a Mac on the home LAN | `MAC_CB_*` breaker + reachability probe | `MAC_OLLAMA_BASE_URL` is unset, the breaker is open, or the Mac isn't reachable |
| 1 | **OpenAI** — `gpt-4o-mini` | `CB_*` breaker | `OPENAI_API_KEY` is unset or the breaker is open |
| 2 | **Local Ollama** — `llama3` | — | never; this is the last generator |
| 3 | **Regex classifier** | — | intent classification only, never answer generation |

Tier 0 is **opt-in**: leave `MAC_OLLAMA_BASE_URL` unset and the chain is exactly the OpenAI → Ollama one it was before. When it *is* set, a big local model answers for free whenever that machine happens to be awake and at home, and nobody notices when it isn't.

### Why tier 0 is designed around being absent

A laptop is not a server. It sleeps, and it leaves the house. Two mechanisms keep that from costing anything:

- **A reachability probe before every attempt.** An absent host doesn't refuse the connection — it silently drops the packet, and a plain `fetch` then sits through the OS TCP retry schedule (~20 s) before failing. A short probe (`MAC_OLLAMA_PROBE_TIMEOUT_MS`, default 1.5 s) turns "the Mac isn't home" into a sub-second skip.
- **Its own circuit breaker.** After `MAC_CB_FAILURE_THRESHOLD` misses even the probe is skipped for `MAC_CB_COOLDOWN_MS`.

The two breakers are **independent on purpose**. A Mac that's away all week must not consume OpenAI's failure budget, and a flaky OpenAI must not stop us using the Mac once it's back. The Mac breaker is tuned twitchier (2 failures vs 5) and cools down far longer (5 min vs 60 s), because nothing about "the Mac went to the office" resolves on a one-minute timescale.

A tier-0 failure is never visible to a visitor: it just means OpenAI answers, which is what would have happened anyway.

### Circuit breaker states

Both breakers use the same state machine:

| State | Behaviour |
|-------|-----------|
| `closed` | The guarded provider is called normally. |
| `open` | The guarded provider is skipped; requests fall through to the next tier. |
| `half_open` | A limited number of probe requests are sent to test recovery. |

### Configuration

| Variable | Default | Description |
|---|---|---|
| `MAC_OLLAMA_BASE_URL` | _(unset)_ | When set, enables tier 0. A LAN URL, e.g. `http://192.168.1.50:11434`. |
| `MAC_OLLAMA_MODEL` | `gemma4:26b` | Model to request from the Mac. |
| `MAC_OLLAMA_PROBE_TIMEOUT_MS` | `1500` | Reachability probe timeout. Keep short — this is what makes an absent Mac cheap. |
| `MAC_OLLAMA_TIMEOUT_MS` | `120000` | Generation timeout. A 26B model on a laptop is not fast, especially cold. |
| `MAC_OLLAMA_KEEP_ALIVE` | `-1` | Sent to Ollama as `keep_alive`. `-1` never evicts the model, so visitors don't pay cold loads; costs held memory, not power. Also parsed to infer warmth. |
| `MAC_CB_FAILURE_THRESHOLD` | `2` | Consecutive failures before the Mac breaker opens. |
| `MAC_CB_COOLDOWN_MS` | `300000` | Cooldown before the Mac breaker probes again (ms). |
| `MAC_CB_PROBE_COUNT` | `1` | Successful probes required to close the Mac breaker. |
| `OPENAI_API_KEY` | _(unset)_ | When set, OpenAI is tier 1. |
| `OPENAI_MODEL` | `gpt-4o-mini` | OpenAI model name. |
| `OPENAI_TIMEOUT_MS` | `30000` | Request timeout for OpenAI (ms). |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Local Ollama server URL (tier 2). |
| `OLLAMA_MODEL` | `llama3` | Local Ollama model name. |
| `OLLAMA_TIMEOUT_MS` | `0` | Local Ollama request timeout; `0` means none. |
| `CB_FAILURE_THRESHOLD` | `5` | Consecutive transient failures before the OpenAI breaker opens. |
| `CB_COOLDOWN_MS` | `60000` | Cooldown before the OpenAI breaker enters half_open (ms). |
| `CB_PROBE_COUNT` | `1` | Successful probes required to close the OpenAI breaker. |

### Notifications

Two kinds of Pushover message, both no-ops unless `PUSHOVER_USER_KEY` and `PUSHOVER_API_TOKEN` are set:

| Kind | When | Priority |
|---|---|---|
| Per-Q&A | Every answered question. Includes the question, **the answer that was given**, which tiers served it, and the duration. | `-1` (quiet) on success, `1` on failure |
| `breaker_open_*` | A tier's circuit breaker opens for the first time. | `1` for OpenAI, `0` for the Mac |
| `breaker_closed_*` | A tier recovers. | `0` |
| `stream_interrupted` | A tier died after emitting tokens, so the visitor kept a half-written answer. | `1` |
| `llm_all_tiers_failed` | Every generating tier failed — the visitor saw an error. | `1` |
| `profile_refresh_proposal` | The daily refresh found changes to review. Links straight to `/admin`. | `-1` (quiet) |
| `profile_refresh_failed` | A refresh source genuinely broke. Configuration skips do **not** fire this. | `1` |

Alerts are throttled per kind by `PUSHOVER_ALERT_MIN_INTERVAL_MS` (default 1 hour) and only fire on `closed → open` and `* → closed` transitions. Both matter: a tier that stays down re-enters `half_open` and re-opens on every probe cycle, so without either guard an away laptop would push a notification every `MAC_CB_COOLDOWN_MS` indefinitely.

Including the answer is deliberate. The per-Q&A push is a record of what a visitor was actually told; paired with `LLMs:`, it's also the easiest way to compare how the LAN model and OpenAI answer the same question. Note this means **answers leave the host** — if that's not wanted, unset the Pushover credentials.

| Variable | Default | Description |
|---|---|---|
| `PUSHOVER_USER_KEY` | _(unset)_ | Recipient user/group key. Both this and the token are required. |
| `PUSHOVER_API_TOKEN` | _(unset)_ | Pushover application API token. |
| `PUSHOVER_TIMEOUT_MS` | `5000` | Request timeout; failures are logged and swallowed. |
| `PUSHOVER_ALERT_MIN_INTERVAL_MS` | `3600000` | Minimum gap between two alerts of the same kind. |

### Multi-instance deployments

Breaker state is held **in process memory**. In a multi-instance deployment each instance maintains its own breakers independently. A shared store (e.g. Redis) is not required; each instance will discover recovery on its own probe cycle.

## API Reference

### `POST /api/ask`

**Request:**
```json
{ "question": "What projects has Davit built?" }
```

**Response:**
```json
{
  "answer": "Davit has built several notable projects...",
  "intent": "projects",
  "sources": ["projects"]
}
```

**Error responses:**
- `400` — Missing/invalid question
- `429` — Rate limit exceeded
- `500` — Every generating tier failed to produce an answer

## Architecture

```
src/
├── app/
│   ├── page.tsx              # Main page
│   ├── layout.tsx            # Root layout
│   └── api/ask/route.ts      # POST /api/ask
├── components/
│   ├── HeroSection.tsx       # Hero with name/title/skills
│   ├── PhotoCards.tsx        # Scattered interest cards
│   ├── ChatInput.tsx         # Question input + suggestions
│   └── QATimeline.tsx        # Conversation history
├── lib/
│   ├── llm/
│   │   ├── provider.ts       # Provider factory (returns FallbackOrchestrator)
│   │   ├── orchestrator.ts   # Mac → OpenAI → Ollama fallback logic
│   │   ├── circuitBreaker.ts # In-memory breaker factory (one per guarded tier)
│   │   ├── macOllama.ts      # Tier 0: Mac on the LAN (probe + own breaker)
│   │   ├── errors.ts         # Typed LLMError + transient-error helper
│   │   ├── openai.ts         # OpenAI adapter
│   │   └── ollama.ts         # Ollama adapter
│   ├── profile/loader.ts     # Load profile data files
│   ├── rateLimit.ts          # IP rate limiting
│   ├── classify.ts           # Intent classification
│   └── retrieval.ts          # Context retrieval
└── types/index.ts            # Shared TypeScript types
data/
├── profile.md                # Bio, experience, skills
├── projects.json             # Project details
├── community.json            # Talks, mentoring, writing
└── hobbies.json              # Personal interests
```

## Scheduled Profile Refresh

Keeps `data/` current by pulling from the sources that publish this information anyway, and using the same Mac-hosted model the site runs on to write the updates in the profile's voice.

```bash
npm run refresh:profile                  # fetch, diff, write a proposal
npm run refresh:profile -- --apply       # also write the changes into data/
npm run refresh:profile -- --no-model     # adapters only; no Mac needed
npm run refresh:profile -- --sources=github
```

Output goes to `data/proposals/<timestamp>.md` (readable) and `.json` (machine), plus a raw snapshot per source in `data/sources/`. Nothing touches `data/` without `--apply`, and nothing reaches the live site until you commit and rebuild.

### Sources

| Source | Auth needed | Feeds | Notes |
|---|---|---|---|
| **GitHub** | None (a `public_repo` PAT raises 60 → 5000 req/h) | `projects.json` | Own, non-fork, non-archived repos. All content read from the **default branch** |
| **Apple Music** | **None** | `music.json` | Uses the keyless iTunes Lookup API. The Apple Music API would need a paid developer membership and a signed JWT for the same public release list |
| **Spotify** | Client ID + secret (free app) | `music.json` | Client Credentials — app-level, no user login. Monthly listeners are *not* in the Web API; that figure stays hand-entered |
| **SoundCloud** | None for the profile | `music.json` | Keyless public oEmbed. The **track list** needs `SOUNDCLOUD_CLIENT_ID`, and their developer registration has been closed for years — reading it off the page instead would be the scraping this project declined for LinkedIn |

**LinkedIn and Instagram are deliberately absent.** LinkedIn's self-serve API doesn't expose positions or skills, its terms cap how long you may store what it does expose, and scraping risks the account the site links to as its CTA. Instagram's Basic Display API was shut down in December 2024, and its replacements support Business/Creator accounts only. See `docs/profile-refresh-plan.md` for the full reasoning and the semi-automatic export-file path that *is* workable.

### Two model calls, deliberately separated

The model never fetches anything and is never a source of facts. Adapters copy fields verbatim from the APIs; the models only shape prose.

```
adapters ──▶ stage A ──▶ sanitiser ──▶ stage B ──▶ proposal ──▶ you
 (typed)    reads       programmatic   edits the    (diff)      (review)
            untrusted   checks         profile
            text
```

- **Stage A** is the only thing that ever reads untrusted source text (a README, a repo description). It has no tools, no network of its own and no knowledge of the profile — a pure text-to-struct function behind a JSON schema. The worst a successful injection achieves is hostile *strings* in four known fields.
- **The sanitiser** then checks those fields exhaustively — possible only because the shape is narrow. Injection and infrastructure patterns fail the record; every claimed technology must appear somewhere in the source or it's dropped; URLs must point at an allowlisted host; zero-width and bidi characters are normalised away before matching.
- **Stage B** diffs against `data/` and proposes minimal, mostly additive edits. Its entire view of the outside world is sanitised stage A output. It may only touch `description`, `tech` and `highlights`.

Why bother: everything in `data/` is folded into the prompt beside the system prompt on every visitor question. Until this feature, `data/` was entirely hand-written and third-party text had no route in at all.

The regexes are not the security boundary — they make a hijacked stage A *loud* rather than silent. The boundary is that nothing merges into `data/` without a human reading the diff.

Music skips the models entirely: a release is a title, a year and a URL, so the diff is a pure function.

### Reviewing what it proposes

A run writes **one** pending proposal and, if it contains anything, sends a Pushover notification with a link straight to the review screen.

1. `/login` — hidden (unlinked, `noindex`, disallowed in `robots.txt`), single password from `ADMIN_PASSWORD`.
2. `/admin` — one card per proposed change, showing the current value beside the proposed one. Each can be **approved**, **rejected**, or **edited in place then approved**. Approve-all / reject-all are there for the common case.

Approving writes to `data/` and the assistant picks it up on the very next question. The explore cards import their JSON at build time, so those still need a rebuild — the UI says so rather than pretending otherwise.

**Miss a notification and nothing is lost.** The next run overwrites the pending proposal and re-derives every diff from whatever `data/` looks like then. Nothing queues, so a week away gives you one current proposal rather than seven contradictory ones.

**Rejections are the exception, and they persist.** A pending proposal is derived and free to discard; a rejection is a decision the job cannot re-derive from the sources. Without remembering it, "reject" would mean the same as "ignore" and the change would return every single day. Rejections are listed at the bottom of `/admin` with an un-reject button.

Anything you retype by hand goes through the same sanitiser as model output before it can be applied — that path is the only way arbitrary text reaches `data/` without passing the refresh pipeline, and `data/` is folded into the answer prompt.

> **Deployment note:** `docker-compose.yml` bind-mounts `./data:/app/data`. This is what makes review work at all — without it, approvals would write to an image layer the next `--build` throws away, and the host's scheduled job would write proposals the container could never see.

### Scheduling it

Both stages default to `MAC_OLLAMA_MODEL`. Naming a different model makes Ollama evict the resident one, so the next visitor to the site pays a cold start — a cost that lands on the website rather than in this job's logs.

The job reuses tier 0's reachability probe and circuit breaker, so a run that finds the Mac asleep skips in under a second and reports it. It does **not** fall back to OpenAI unless `REFRESH_ALLOW_PAID_FALLBACK=true`: the fallback chain exists so a *visitor* never waits on a sleeping laptop, and a batch job has no visitor.

**A daily task is already registered on this machine** (Windows Task Scheduler, `Personal Pitcher profile refresh`), running at **23:00 Asia/Yerevan (GMT+4)**. It invokes `scripts/refresh-profile.cmd`, which pins the working directory — a scheduled task otherwise starts in `System32`, and `config.ts` resolves `data/` from `process.cwd()` — and appends a transcript to `logs/scheduled-refresh.log`, because Task Scheduler records an exit code and nothing else.

```powershell
Get-ScheduledTaskInfo    -TaskName 'Personal Pitcher profile refresh'   # last / next run
Start-ScheduledTask      -TaskName 'Personal Pitcher profile refresh'   # run it now
Unregister-ScheduledTask -TaskName 'Personal Pitcher profile refresh' -Confirm:$false
```

To recreate it from scratch:

```powershell
$repo = 'C:\Users\Davit\Projects\personal-pitcher'
Register-ScheduledTask -TaskName 'Personal Pitcher profile refresh' `
  -Action   (New-ScheduledTaskAction -Execute "$repo\scripts\refresh-profile.cmd" -WorkingDirectory $repo) `
  -Trigger  (New-ScheduledTaskTrigger -Daily -At '23:00') `
  -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew)
```

`-StartWhenAvailable` matters: it runs the job at the next opportunity if the machine was off or asleep at 23:00, rather than silently skipping the day. Two limitations worth knowing — the task runs **only while you are logged on** (the alternative means storing an account password), and it does **not wake** a sleeping machine.

### Timezones

Timestamps split by who reads them:

| Surface | Timezone | Why |
|---|---|---|
| Pushover notifications, `data/proposals/latest.md` | `DISPLAY_TIMEZONE` (default `Asia/Yerevan`) | Read by one person on a phone, who wants to know whether this happened just now or overnight |
| Structured JSON logs | UTC | Correlated across machines and read by tooling; a log line in local time lines up with nothing |
| The container's own clock | `TZ` in `docker-compose.yml` | So daily log files roll over at local midnight rather than at 04:00 |

`DISPLAY_TIMEZONE` takes an IANA zone name, not a fixed offset. `+04:00` would encode an assumption a government decision could invalidate, and it would fail in the least visible way available: timestamps quietly an hour out, in notifications nobody cross-checks.

> The image installs `tzdata`. Node honours `TZ` without it — its ICU data is self-contained — but Alpine's `date` does not, so without the package the shell inside the container reports UTC and misleads anyone debugging by four hours.

Exit code is `0` when the run completed (with or without changes) and `1` only when a source actually failed — "the Mac was asleep" is the normal state of a laptop at 23:00, not an error. A missing credential or a spent GitHub rate limit is also a `0` — both are configuration, fixed by editing `.env` rather than by debugging.

## Observability

### Request logging

Every request to `/api/ask` is logged as a single JSON line via [winston](https://github.com/winstonjs/winston) with [winston-daily-rotate-file](https://github.com/winstonjs/winston-daily-rotate-file). Logs go both to stdout and to a rotating file in `LOG_DIR` (default: `./logs`).

- Files rotate daily: `app-YYYY-MM-DD.log` (and `app-error-YYYY-MM-DD.log` for errors only).
- Old files are gzipped and pruned per `LOG_MAX_FILES` (default `14d`); a single file is capped at `LOG_MAX_SIZE` (default `20m`), so no file grows unbounded.
- Each `request_completed` entry includes: `requestId`, `method`, `path`, `ip`, `userAgent`, `startedAt`, `durationMs`, `workflowSteps` (e.g. `rate_limit_passed → classify_intent → intent:projects → retrieve_context → llm_generate → openai_attempt → openai_success`), `status`, `success`, `question`, `intent`, `modelsUsed`, and `errorMessage` for failures.
- All failure paths (rate limit, validation, JSON errors, LLM errors) are logged.

Tunables: `LOG_DIR`, `LOG_LEVEL`, `LOG_MAX_SIZE`, `LOG_MAX_FILES`. In Docker the `/app/logs` directory is exposed as a volume so logs persist across restarts.

### Pushover notifications

Set `PUSHOVER_USER_KEY` and `PUSHOVER_API_TOKEN` to receive a friendly per-iteration push for each Q&A: time, question, success/failure, duration, and the LLMs used. Notifications are sent fire-and-forget — Pushover errors never block the API response.

## License

MIT
