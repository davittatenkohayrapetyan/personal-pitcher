import type { LLMProvider } from '@/types';
import { OllamaProvider } from './ollama';
import { OpenAIProvider } from './openai';
import { FallbackOrchestrator } from './orchestrator';

export type ProviderType = 'ollama' | 'openai';

export function createLLMProvider(type: ProviderType): LLMProvider {
  if (type === 'openai') {
    return new OpenAIProvider();
  }
  return new OllamaProvider();
}

/**
 * Returns the default LLM provider: a FallbackOrchestrator that tries OpenAI
 * first (when OPENAI_API_KEY is set) and falls back to Ollama automatically.
 */
export function getDefaultProvider(): LLMProvider {
  return new FallbackOrchestrator();
}
