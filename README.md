# Personal Pitcher 🎯

A personal AI pitch website for Davit Hayrapetyan. Visitors can ask questions about Davit's professional background, projects, community contributions, and personal interests — powered by OpenAI with an automatic Ollama (Llama) fallback.

## Features

- 🎨 **Clean portfolio UI** — Hero section, photo cards, and Q&A timeline
- 🤖 **AI-powered answers** — OpenAI primary with automatic Ollama/Llama fallback
- 🔁 **Circuit breaker** — Automatically skips OpenAI when it is down/overloaded, then probes for recovery
- 🛡️ **Request validation** — Input length, type checks
- ⏱️ **IP-based rate limiting** — 10 requests per minute per IP
- 🧠 **Intent classification** — Routes questions to relevant profile sections
- 📚 **RAG-style retrieval** — Pulls context from curated markdown/JSON profile files
- 🚧 **Guardrails** — Only answers questions about Davit Hayrapetyan

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

When `OPENAI_API_KEY` is present, every request is first sent to OpenAI. If OpenAI fails for any reason, the system automatically falls back to Ollama — no user-visible error. If `OPENAI_API_KEY` is not set, all requests go directly to Ollama.

## LLM Provider Strategy

The system uses an **OpenAI-first, Ollama-fallback** strategy with a circuit breaker:

1. **Primary** — If `OPENAI_API_KEY` is configured and the circuit breaker is closed, OpenAI is called first.
2. **Fallback** — If OpenAI fails (network error, timeout, quota/rate limit, or any server error), the request is transparently retried against Ollama.
3. **Circuit breaker** — After `CB_FAILURE_THRESHOLD` consecutive transient OpenAI failures the breaker opens. While open all requests bypass OpenAI and go straight to Ollama. After `CB_COOLDOWN_MS` milliseconds the breaker enters `half_open` and allows a small number of probe requests through. On a successful probe the breaker closes again.

### Circuit breaker states

| State | Behaviour |
|-------|-----------|
| `closed` | OpenAI is called normally. |
| `open` | OpenAI is skipped; requests go straight to Ollama. |
| `half_open` | A limited number of probe requests are sent to OpenAI to test recovery. |

### Configuration

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | _(unset)_ | When set, OpenAI is the primary provider. |
| `OPENAI_MODEL` | `gpt-4o-mini` | OpenAI model name. |
| `OPENAI_TIMEOUT_MS` | `30000` | Request timeout for OpenAI (ms). |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL (fallback). |
| `OLLAMA_MODEL` | `llama3` | Ollama model name. |
| `CB_FAILURE_THRESHOLD` | `5` | Consecutive transient failures before breaker opens. |
| `CB_COOLDOWN_MS` | `60000` | Cooldown before breaker enters half_open (ms). |
| `CB_PROBE_COUNT` | `1` | Successful probes required to close the breaker. |

### Multi-instance deployments

The circuit breaker state is held **in process memory**. In a multi-instance deployment each instance maintains its own breaker independently. A shared store (e.g. Redis) is not required; each instance will discover OpenAI recovery on its own probe cycle.

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
- `500` — Both OpenAI and Ollama failed to generate an answer

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
│   │   ├── orchestrator.ts   # OpenAI → Ollama fallback logic
│   │   ├── circuitBreaker.ts # In-memory circuit breaker for OpenAI
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

## License

MIT
