import Anthropic from '@anthropic-ai/sdk';
import type { ZodType } from 'zod';
import type { Env } from './types';

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('Model response did not contain a JSON object.');
  return JSON.parse(candidate.slice(first, last + 1));
}

export async function generateStructured<T>(
  env: Env,
  schema: ZodType<T>,
  system: string,
  payload: unknown,
): Promise<{ data: T; usage: { input_tokens: number; output_tokens: number } }> {
  if (!env.ANTHROPIC_MODEL) throw new Error('ANTHROPIC_MODEL is not configured.');
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const result = await client.messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 6000,
    temperature: 0.35,
    system,
    messages: [{
      role: 'user',
      content: `Return only valid JSON matching the requested structure. Never invent facts. Input:\n${JSON.stringify(payload)}`,
    }],
  });
  const text = result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  const data = schema.parse(extractJson(text));
  return { data, usage: result.usage };
}
