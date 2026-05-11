# Personal Pitcher 🎯

A personal AI pitch website for Davit Hayrapetyan. Visitors can ask questions about Davit's professional background, projects, community contributions, and personal interests — powered by a local LLM via Ollama.

## Features

- 🎨 **Clean portfolio UI** — Hero section, photo cards, and Q&A timeline
- 🤖 **AI-powered answers** — Uses Ollama (local) or OpenAI (fallback)
- 🛡️ **Request validation** — Input length, type checks
- ⏱️ **IP-based rate limiting** — 10 requests per minute per IP
- 🧠 **Intent classification** — Routes questions to relevant profile sections
- 📚 **RAG-style retrieval** — Pulls context from curated markdown/JSON profile files
- 🚧 **Guardrails** — Only answers questions about Davit Hayrapetyan

## Quick Start

### Prerequisites
- Node.js 20+
- [Ollama](https://ollama.ai) installed and running with `llama3` model

### Local Development

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env.local

# Pull the LLM model (requires Ollama)
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

### Using OpenAI Instead

Set in `.env.local`:
```
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-your-key
OPENAI_MODEL=gpt-4o-mini
```

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
- `500` — LLM error

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
│   │   ├── provider.ts       # Provider factory
│   │   ├── ollama.ts         # Ollama implementation
│   │   └── openai.ts         # OpenAI implementation
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
