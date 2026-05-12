import type { LLMProvider } from '@/types';
import { OllamaProvider } from './ollama';
import { OpenAIProvider } from './openai';

export type ProviderType = 'ollama' | 'openai';

export function createLLMProvider(type: ProviderType): LLMProvider {
  if (type === 'openai') {
    return new OpenAIProvider();
  }
  return new OllamaProvider();
}

export function getDefaultProvider(): LLMProvider {
  const providerType = (process.env.LLM_PROVIDER as ProviderType) || 'ollama';
  return createLLMProvider(providerType);
}
