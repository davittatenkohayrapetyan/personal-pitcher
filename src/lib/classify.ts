export type Intent =
  | 'background'
  | 'projects'
  | 'community'
  | 'hobbies'
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
  'background', 'projects', 'community', 'hobbies', 'contact', 'general', 'off_topic',
]);

const INTENT_CLASSIFICATION_PROMPT = `You are an intent classifier. Given a user question, classify it into exactly one of these intents:
- background: questions about work experience, career, education, skills, tech stack
- projects: questions about projects, code, GitHub repos, things built
- community: questions about talks, conferences, mentoring, volunteering, blog posts
- hobbies: questions about personal interests, hobbies, free time activities
- contact: questions about how to reach or hire Davit
- general: general questions about who Davit is
- off_topic: anything unrelated to Davit Hayrapetyan

Respond with ONLY the single intent word, nothing else.`;

export async function classifyIntentWithLLM(question: string): Promise<Intent> {
  try {
    const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2',
        messages: [
          { role: 'system', content: INTENT_CLASSIFICATION_PROMPT },
          { role: 'user', content: question },
        ],
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama responded with ${response.status}`);
    }

    const data = await response.json();
    const raw = (data.message?.content as string | undefined)?.trim().toLowerCase();

    if (raw && VALID_INTENTS.has(raw as Intent)) {
      return raw as Intent;
    }
  } catch {
    // fall through to regex fallback
  }

  return classifyIntent(question);
}

export function isOffTopic(intent: Intent): boolean {
  return intent === 'off_topic';
}
