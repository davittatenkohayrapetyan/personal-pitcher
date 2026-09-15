export interface QAEntry {
  id: string;
  question: string;
  answer: string;
  timestamp: Date;
  intent?: string;
  /** Workflow trail streamed from /api/ask, rendered by PipelineTrace. */
  steps?: string[];
  modelsUsed?: string[];
  durationMs?: number;
  /** True while tokens are still arriving for this entry. */
  streaming?: boolean;
  error?: string;
}

export interface AskRequest {
  question: string;
  /** Client-generated id (see `AssistantPanel.tsx`) used only to fold recent
   *  turns into the prompt for follow-up context — never a security boundary,
   *  see `src/lib/session.ts`. */
  sessionId?: string;
}

export interface AskResponse {
  answer: string;
  intent?: string;
  sources?: string[];
  questionsRemaining?: number;
  questionsMax?: number;
}

export interface LLMProvider {
  generate(prompt: string, systemPrompt?: string): Promise<string>;
}

export interface ProfileContext {
  bio: string;
  projects: string;
  community: string;
  hobbies: string;
  music: string;
  /** This website itself — see `data/site.json`. */
  site: string;
}
