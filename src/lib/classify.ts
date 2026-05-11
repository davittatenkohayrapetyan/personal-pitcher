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

export function classifyIntent(question: string): Intent {
  const lower = question.toLowerCase();

  const isDavitRelated = DAVIT_KEYWORDS.some((kw) => lower.includes(kw));
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

export function isOffTopic(intent: Intent): boolean {
  return intent === 'off_topic';
}
