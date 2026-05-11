import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/rateLimit';
import { classifyIntent, isOffTopic } from '@/lib/classify';
import { retrieveContext } from '@/lib/retrieval';
import { getDefaultProvider } from '@/lib/llm/provider';
import type { AskRequest, AskResponse } from '@/types';

const SYSTEM_PROMPT = `You are a personal AI assistant for Davit Hayrapetyan. Your role is to answer questions about Davit's professional background, projects, community contributions, and personal interests.

Guidelines:
- Answer only questions about Davit Hayrapetyan
- Be concise, friendly, and professional
- Use the provided context to give accurate answers
- If you don't have specific information, say so honestly
- Do not make up information not present in the context
- Refer to Davit in the third person or use "he/him" pronouns`;

function getClientIP(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return request.headers.get('x-real-ip') || 'unknown';
}

export async function POST(request: NextRequest): Promise<NextResponse<AskResponse | { error: string }>> {
  const ip = getClientIP(request);
  const rateLimit = checkRateLimit(ip);

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please wait before asking another question.' },
      {
        status: 429,
        headers: {
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.ceil(rateLimit.resetAt / 1000)),
        },
      }
    );
  }

  let body: AskRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON in request body.' }, { status: 400 });
  }

  const { question } = body;

  if (!question || typeof question !== 'string') {
    return NextResponse.json({ error: 'A "question" string field is required.' }, { status: 400 });
  }

  const trimmedQuestion = question.trim();
  if (trimmedQuestion.length === 0) {
    return NextResponse.json({ error: 'Question cannot be empty.' }, { status: 400 });
  }

  if (trimmedQuestion.length > 500) {
    return NextResponse.json({ error: 'Question must be 500 characters or fewer.' }, { status: 400 });
  }

  const intent = classifyIntent(trimmedQuestion);

  if (isOffTopic(intent)) {
    return NextResponse.json(
      {
        answer: "I can only answer questions about Davit Hayrapetyan — his background, projects, community work, and hobbies. Try asking something like 'What projects has Davit built?' or 'What are his hobbies?'",
        intent,
      },
      { status: 200 }
    );
  }

  const context = retrieveContext(intent);

  const prompt = `Context about Davit Hayrapetyan:
${context}

Question: ${trimmedQuestion}

Please answer the question based on the context provided above.`;

  try {
    const provider = getDefaultProvider();
    const answer = await provider.generate(prompt, SYSTEM_PROMPT);
    return NextResponse.json({ answer, intent, sources: [intent] });
  } catch (error) {
    console.error('LLM generation error:', error);
    return NextResponse.json(
      { error: 'Failed to generate an answer. Please try again.' },
      { status: 500 }
    );
  }
}
