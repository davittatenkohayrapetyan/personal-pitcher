import { OpenAIProvider } from './llm/openai';
import { OllamaProvider } from './llm/ollama';
import { LLMError, isTransientError } from './llm/errors';
import { allowRequest, onSuccess, onFailure } from './llm/circuitBreaker';

export type Intent =
  | 'background'
  | 'projects'
  | 'community'
  | 'hobbies'
  | 'music'
  | 'contact'
  | 'general'
  | 'off_topic';

const INTENT_PATTERNS: Record<Intent, RegExp[]> = {
  background: [
    /\b(experience|work|career|job|education|degree|study|university|skill|tech stack|background|history|company|role|position)\b/i,
  ],
  projects: [
    /\b(project|build|built|create|develop|code|github|open.?source|repo|side.?project|portfolio)\b/i,
  ],
  community: [
    /\b(talk|speak|conference|meetup|mentor|volunteer|community|write|article|blog|contribution|open.?source)\b/i,
  ],
  hobbies: [
    /\b(hobby|hobbies|interest|fun|chess|hiking|photo|read|book|coffee|outside|personal|weekend|free.?time|language)\b/i,
  ],
  music: [
    /\b(music|musical|song|songs|track|tracks|album|albums|ep|eps|single|singles|release|releases|spotify|producer|produce|producing|shepard|electronic|piano|dj|beat|beats|discography|artist)\b/i,
  ],
  contact: [
    /\b(contact|email|reach|linkedin|github|social|hire|available|opportunity)\b/i,
  ],
  general: [
    /\b(who|what|tell|about|davit|hayrapetyan)\b/i,
  ],
  off_topic: [],
};

const DAVIT_KEYWORDS = [
  'davit', 'hayrapetyan', 'you', 'your', 'he', 'his', 'him',
  'experience', 'background', 'project', 'skill', 'work', 'career',
  'hobby', 'community', 'talk', 'mentor', 'contact', 'linkedin',
  'github', 'education', 'degree',
  'shepard', 'music', 'song', 'album', 'spotify', 'producer',
];

const DAVIT_KEYWORD_REGEXES = DAVIT_KEYWORDS.map((kw) => new RegExp(`\\b${kw}\\b`, 'i'));

export function classifyIntent(question: string): Intent {
  const isDavitRelated = DAVIT_KEYWORD_REGEXES.some((re) => re.test(question));
  if (!isDavitRelated) {
    return 'off_topic';
  }

  for (const [intent, patterns] of Object.entries(INTENT_PATTERNS) as [Intent, RegExp[]][]) {
    if (intent === 'off_topic') continue;
    if (patterns.some((p) => p.test(question))) {
      return intent;
    }
  }

  return 'general';
}

const VALID_INTENTS = new Set<Intent>([
  'background', 'projects', 'community', 'hobbies', 'music', 'contact', 'general', 'off_topic',
]);

const INTENT_CLASSIFICATION_PROMPT = `You are an intent classifier. Given a user question, classify it into exactly one of these intents:
- background: questions about work experience, career, education, skills, tech stack
- projects: questions about projects, code, GitHub repos, things built
- community: questions about talks, conferences, mentoring, volunteering, blog posts
- hobbies: questions about personal interests, hobbies, free time activities
- music: questions about Davit's music career, his artist alias Shepard D, songs, albums, EPs, singles, Spotify, electronic music production
- contact: questions about how to reach or hire Davit
- general: general questions about who Davit is
- off_topic: anything unrelated to Davit Hayrapetyan

Respond with ONLY the single intent word, nothing else.`;

function parseIntent(raw: string | undefined | null): Intent | null {
  if (!raw) return null;
  const token = raw.trim().toLowerCase().split(/\s+/)[0];
  return VALID_INTENTS.has(token as Intent) ? (token as Intent) : null;
}

function getOpenAIModelName(): string {
  return process.env.OPENAI_MODEL || 'gpt-4o-mini';
}

function getOllamaModelName(): string {
  return process.env.OLLAMA_MODEL || 'llama3';
}

export interface ClassifyResult {
  intent: Intent;
  /** `openai:<model>`, `ollama:<model>`, or `regex`. */
  classifier: string;
  /** Workflow steps for request logging. */
  steps: string[];
}

/**
 * Classify the user question using the same fallback chain as answer
 * generation: OpenAI → Ollama → regex. The OpenAI circuit breaker is shared
 * with the answer-generation orchestrator so a flaky OpenAI is not hit twice
 * per request.
 */
export async function classifyIntentWithLLM(question: string): Promise<ClassifyResult> {
  const steps: string[] = [];
  const openaiConfigured = Boolean(process.env.OPENAI_API_KEY);

  // ─── Tier 1: OpenAI ───────────────────────────────────────────────────
  if (openaiConfigured && allowRequest()) {
    steps.push('classifier_openai_attempt');
    try {
      const openai = new OpenAIProvider();
      const raw = await openai.generate(question, INTENT_CLASSIFICATION_PROMPT);
      onSuccess();
      const parsed = parseIntent(raw);
      if (parsed) {
        steps.push('classifier_openai_success');
        return { intent: parsed, classifier: `openai:${getOpenAIModelName()}`, steps };
      }
      steps.push('classifier_openai_invalid_response');
    } catch (error) {
      const transient = isTransientError(error);
      console.warn(
        JSON.stringify({
          event: 'classifier_openai_failure',
          transient,
          countedByBreaker: transient,
          error:
            error instanceof LLMError
              ? {
                  name: error.name,
                  category: error.category,
                  statusCode: error.statusCode,
                  message: error.message,
                }
              : String(error),
          ts: new Date().toISOString(),
        }),
      );
      steps.push(
        transient
          ? 'classifier_openai_failure_transient'
          : 'classifier_openai_failure_non_transient',
      );
      if (transient) {
        onFailure();
      }
    }
  } else if (openaiConfigured) {
    steps.push('classifier_circuit_open_skip_openai');
  } else {
    steps.push('classifier_openai_not_configured');
  }

  // ─── Tier 2: Ollama ───────────────────────────────────────────────────
  steps.push('classifier_ollama_attempt');
  try {
    const ollama = new OllamaProvider();
    const raw = await ollama.generate(question, INTENT_CLASSIFICATION_PROMPT);
    const parsed = parseIntent(raw);
    if (parsed) {
      steps.push('classifier_ollama_success');
      return { intent: parsed, classifier: `ollama:${getOllamaModelName()}`, steps };
    }
    steps.push('classifier_ollama_invalid_response');
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'classifier_ollama_failure',
        error:
          error instanceof LLMError
            ? {
                name: error.name,
                category: error.category,
                statusCode: error.statusCode,
                message: error.message,
              }
            : String(error),
        ts: new Date().toISOString(),
      }),
    );
    steps.push('classifier_ollama_failure');
  }

  // ─── Tier 3: Regex fallback ───────────────────────────────────────────
  steps.push('classifier_regex_fallback');
  return { intent: classifyIntent(question), classifier: 'regex', steps };
}

export function isOffTopic(intent: Intent): boolean {
  return intent === 'off_topic';
}
