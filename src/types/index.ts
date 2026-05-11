export interface QAEntry {
  id: string;
  question: string;
  answer: string;
  timestamp: Date;
  intent?: string;
}

export interface AskRequest {
  question: string;
}

export interface AskResponse {
  answer: string;
  intent?: string;
  sources?: string[];
}

export interface LLMProvider {
  generate(prompt: string, systemPrompt?: string): Promise<string>;
}

export interface ProfileContext {
  bio: string;
  projects: string;
  community: string;
  hobbies: string;
}
