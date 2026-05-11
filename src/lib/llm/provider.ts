import type { LLMProvider } from '@/types';

export type ProviderType = 'ollama' | 'openai';

export function createLLMProvider(type: ProviderType): LLMProvider {
  if (type === 'openai') {
    const { OpenAIProvider } = require('./openai');
    return new OpenAIProvider();
  }
  const { OllamaProvider } = require('./ollama');
  return new OllamaProvider();
}

export function getDefaultProvider(): LLMProvider {
  const providerType = (process.env.LLM_PROVIDER as ProviderType) || 'ollama';
  return createLLMProvider(providerType);
}
