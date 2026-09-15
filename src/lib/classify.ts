import { OpenAIProvider } from './llm/openai';
import { OllamaProvider } from './llm/ollama';
import { LLMError, isTransientError } from './llm/errors';
import { allowRequest, onSuccess, onFailure } from './llm/circuitBreaker';
import { openMacTier, getMacModelName, logMacFailure, macBreaker, noteMacSuccess } from './llm/macOllama';

export type Intent =
  | 'site'
  | 'background'
  | 'projects'
  | 'community'
  | 'hobbies'
  | 'music'
  | 'contact'
  | 'general'
  | 'off_topic';

// Exported so `retrieval.ts` can reuse the same keyword definitions to detect
// *multiple* relevant sections in one question, instead of re-deriving a
// second, potentially-drifting keyword list for retrieval.
export const INTENT_PATTERNS: Record<Intent, RegExp[]> = {
  // First on purpose. `matchAllIntents` and the regex tier both take the first
  // match, and "how does this site's architecture work?" contains 'architecture',
  // which `background` would otherwise grab. Patterns are kept narrow —
  // deliberately requiring an explicit reference to *this* site — so that
  // "does Davit know circuit breakers?" stays a skills question, not a
  // question about the site that happens to use circuit breakers.
  site: [
    /\b(?:this|the)\s+(?:site|website|web ?page|app|chat|assistant|bot)\b/i,
    /\bpersonal[\s._-]?pitcher\b/i,
    /\bhow\s+(?:does|do|did|was|is)\s+(?:this|it)\b/i,
    /\b(?:who|what|how)\s+(?:built|made|created|designed)\s+(?:this|it)\b/i,
    /\b(?:which|what)\s+(?:llm|model|ai)\s+(?:answers|powers|runs|is behind|are you)\b/i,
    // The assistant's own name. "What does DAVO stand for?" is a question about
    // this site, and `data/site.json` carries the answer.
    /\bdavo\b/i,
  ],
  background: [
    /\b(experience|work|career|job|education|degree|study|university|skill|tech stack|background|history|company|role|position|phd|doctorate|architect|architecture|modernize|modernization|own|owned|ownership|system|systems|jvm|fit)\b/i,
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
  // Role-fit and architecture vocabulary. Without these, questions a recruiter
  // would actually ask ("why hire a JVM architect for an AI role?") contain no
  // recognised keyword, so the regex fallback classifies them as off_topic and
  // the visitor gets the redirect message instead of an answer.
  'hire', 'hiring', 'architect', 'architecture', 'phd', 'doctorate',
  'own', 'owned', 'ownership', 'lead', 'led', 'system', 'systems',
  'modernize', 'modernization', 'role', 'fit', 'jvm', 'stack',
  'ai', 'llm', 'rag', 'agent', 'site', 'website', 'pipeline',
  // Site-question vocabulary. Kept specific rather than adding generic words
  // like 'app' or 'model', which would let genuinely unrelated questions
  // through the off-topic gate.
  'pitcher', 'assistant', 'chatbot', 'openai', 'ollama', 'fallback',
  'breaker', 'streaming', 'built',
  // The assistant's own name, so "what does DAVO stand for?" survives the
  // off-topic gate and reaches the site section that answers it.
  'davo',
  // 'app' and 'model' are generic enough to let some unrelated questions past
  // the gate, but without them "tell me about this app" and "what model answers
  // these questions?" are rejected as off_topic before the site patterns below
  // ever get to match. The trade is worth it: this gate only decides anything
  // in the regex tier (every LLM down), and the cost of a false pass is landing
  // in 'general', where the system prompt declines it anyway.
  'app', 'model', 'models',
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

/** Intents that map to a distinct, addable content section in `retrieval.ts`. */
const SECTION_INTENTS: Intent[] = ['site', 'background', 'projects', 'community', 'hobbies', 'music'];

/**
 * Returns every content-bearing intent whose keywords appear in the question,
 * in a fixed priority order — not just the single winning intent.
 *
 * `classifyIntent`/`classifyIntentWithLLM` pick one *primary* intent to log
 * and label the answer with, which is right for observability but wrong for
 * retrieval: a question like "what are Davit's projects and what music does
 * he make?" is legitimately about two sections at once. `retrieveContext`
 * unions this with the primary intent so both get included.
 */
export function matchAllIntents(question: string): Intent[] {
  return SECTION_INTENTS.filter((intent) =>
    INTENT_PATTERNS[intent].some((pattern) => pattern.test(question)),
  );
}

const VALID_INTENTS = new Set<Intent>([
  'site', 'background', 'projects', 'community', 'hobbies', 'music', 'contact', 'general', 'off_topic',
]);

const INTENT_CLASSIFICATION_PROMPT = `You are an intent classifier. Given a user question, classify it into exactly one of these intents:
- site: questions about this website itself — what Personal Pitcher is, how it was built, its architecture, the AI pipeline behind it, which models answer, how the fallback and circuit breakers work
- background: questions about work experience, career, education, skills, tech stack
- projects: questions about projects, code, GitHub repos, things built
- community: questions about talks, conferences, mentoring, volunteering, blog posts
- hobbies: questions about personal interests, hobbies, free time activities
- music: questions about Davit's music career, his artist alias Shepard D, songs, albums, EPs, singles, Spotify, electronic music production
- contact: questions about how to reach or hire Davit
- general: general questions about who Davit is
- off_topic: anything unrelated to Davit Hayrapetyan and unrelated to this website

Note: this website is Davit's own project, so questions about the site, how it
works, or what powers it are ON topic and should be classified as 'site', never
as 'off_topic'.

Important: this is Davit's personal site, and every visitor is here to evaluate
him. Default to on-topic. A question doesn't need to say "Davit" or "he" by
name to be about him — hiring questions, role-fit questions, "would X be good
at Y", "should I consider X for Z", career or technology opinions asked in the
context of evaluating a candidate, and objections or skepticism about his
background (e.g. "isn't he just a Java guy?") are all implicitly about Davit,
because there is no other candidate this site could be discussing. Classify
these as 'background' (or 'contact' if the question is specifically about
reaching out or hiring him) rather than 'off_topic'.

Reserve off_topic for questions with no personal-fit angle at all: pure trivia,
general knowledge, entertainment, or a subject that has nothing to do with
evaluating or hiring anyone (weather, geography, sports scores, "what is X"
questions about unrelated things).

Examples:
Q: "What is Barbie?" -> off_topic
Q: "Who won the World Cup?" -> off_topic
Q: "What is the best programming language?" -> off_topic (a pure opinion question with no personal-fit angle)
Q: "Recommend me some electronic music" -> off_topic (asking for a recommendation, not asking about Shepard D specifically)
Q: "Why hire a JVM architect for an AI role?" -> background (a role-fit question — the implicit subject is Davit, this site's only candidate)
Q: "Convince me he isn't just a Java guy" -> background
Q: "Would he be a good fit for a startup?" -> background
Q: "What music does Davit make?" -> music
Q: "What does he do for fun?" -> hobbies
Q: "Tell me about this website" -> site
Q: "What are his strongest skills?" -> background
Q: "How can I get in touch?" -> contact

When genuinely unsure between an on-topic intent and off_topic, prefer the
on-topic one — the cost of wrongly declining a real visitor's question is
worse than the cost of answering a borderline one.

Respond with ONLY the single intent word, nothing else.`;

function parseIntent(raw: string | undefined | null): Intent | null {
  if (!raw) return null;
  const token = raw.trim().toLowerCase().split(/\s+/)[0];
  return VALID_INTENTS.has(token as Intent) ? (token as Intent) : null;
}

/** True when the question mentions nothing recognisably about Davit or the site. */
function mentionsSubject(question: string): boolean {
  return DAVIT_KEYWORD_REGEXES.some((re) => re.test(question));
}

/**
 * Sanity-check an LLM's intent against the keyword evidence in the question.
 *
 * A small local model will confidently route "What is Barbie?" to `hobbies` —
 * it pattern-matches the *subject* to a category instead of asking who the
 * question is about. That misroute is not cosmetic: `off_topic` short-circuits
 * before retrieval, so a wrong label turns a free decline into a full
 * generation call and burns one of the visitor's quota.
 *
 * The guard only ever downgrades to `off_topic`, never promotes, and it is
 * skipped once a conversation is under way. Follow-ups are legitimately
 * keyword-free ("what else?", "tell me more"), and the prior turns are what
 * make them on-topic — so applying this to them would break exactly the
 * conversational flow `session.ts` exists to support.
 */
function guardOffTopic(intent: Intent, question: string, hasHistory: boolean): boolean {
  if (hasHistory) return false;
  if (intent === 'off_topic') return false;
  return !mentionsSubject(question);
}

export interface ClassifyOptions {
  /** True when this session already has prior turns — see `guardOffTopic`. */
  hasHistory?: boolean;
}

function getOpenAIModelName(): string {
  return process.env.OPENAI_MODEL || 'gpt-4o-mini';
}

function getOllamaModelName(): string {
  return process.env.OLLAMA_MODEL || 'llama3';
}

export interface ClassifyResult {
  intent: Intent;
  /** `mac-ollama:<model>`, `openai:<model>`, `ollama:<model>`, or `regex`. */
  classifier: string;
  /** Workflow steps for request logging. */
  steps: string[];
}

/**
 * Classify the user question using the same fallback chain as answer
 * generation: Mac Ollama → OpenAI → Ollama → regex. Both circuit breakers are
 * shared with the answer-generation orchestrator, so a flaky OpenAI or an
 * absent Mac is not probed twice per request — whichever tier classification
 * knocks out stays knocked out for generation a moment later.
 *
 * Running classification through the Mac first is also what warms it: the
 * classifier prompt loads gemma4:26b into the Mac's memory, so the
 * much larger generation call that follows skips the cold-load cost.
 */
export async function classifyIntentWithLLM(
  question: string,
  options: ClassifyOptions = {},
): Promise<ClassifyResult> {
  const hasHistory = Boolean(options.hasHistory);
  const steps: string[] = [];
  const openaiConfigured = Boolean(process.env.OPENAI_API_KEY);

  // ─── Tier 0: Mac Ollama ───────────────────────────────────────────────
  const mac = await openMacTier();
  if (mac.ok) {
    steps.push('classifier_mac_attempt');
    try {
      const raw = await mac.provider.generate(question, INTENT_CLASSIFICATION_PROMPT);
      noteMacSuccess();
      const parsed = parseIntent(raw);
      if (parsed) {
        if (guardOffTopic(parsed, question, hasHistory)) {
          steps.push('classifier_offtopic_guard');
          return { intent: 'off_topic', classifier: `mac-ollama:${getMacModelName()}`, steps };
        }
        steps.push('classifier_mac_success');
        return { intent: parsed, classifier: `mac-ollama:${getMacModelName()}`, steps };
      }
      // Reachable and healthy, just off-script — that is not a breaker failure.
      steps.push('classifier_mac_invalid_response');
    } catch (error) {
      macBreaker.onFailure();
      logMacFailure(error);
      steps.push('classifier_mac_failure');
    }
  } else {
    steps.push(`classifier_${mac.reason}`);
  }

  // ─── Tier 1: OpenAI ───────────────────────────────────────────────────
  if (openaiConfigured && allowRequest()) {
    steps.push('classifier_openai_attempt');
    try {
      const openai = new OpenAIProvider();
      const raw = await openai.generate(question, INTENT_CLASSIFICATION_PROMPT);
      onSuccess();
      const parsed = parseIntent(raw);
      if (parsed) {
        if (guardOffTopic(parsed, question, hasHistory)) {
          steps.push('classifier_offtopic_guard');
          return { intent: 'off_topic', classifier: `openai:${getOpenAIModelName()}`, steps };
        }
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
      if (guardOffTopic(parsed, question, hasHistory)) {
        steps.push('classifier_offtopic_guard');
        return { intent: 'off_topic', classifier: `ollama:${getOllamaModelName()}`, steps };
      }
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
