import type { Env } from './types';

export type AccessState = 'full' | 'grace' | 'read_only' | 'closed';
export type BillingStatus = 'trialing' | 'active' | 'incomplete' | 'incomplete_expired' | 'past_due' | 'unpaid' | 'paused' | 'canceled';

export const PLAN_CATALOG = [
  { code: 'solo', name: 'Solo', description: 'For one founder or small business.', monthly_amount: 1900, currency: 'usd', features: ['Brand memory', 'Approvals', 'Automatic publishing'], limits: { brands: 1, members: 2, monthly_generation_units: 300, connected_accounts: 1 } },
  { code: 'growth', name: 'Growth', description: 'For active small-business marketing teams.', monthly_amount: 5900, currency: 'usd', features: ['Everything in Solo', 'Client review links', 'Priority support'], limits: { brands: 3, members: 8, monthly_generation_units: 1200, connected_accounts: 5 } },
  { code: 'agency', name: 'Agency', description: 'For consultants and multi-client teams.', monthly_amount: 14900, currency: 'usd', features: ['Everything in Growth', 'Agency reporting', 'Multi-client scale'], limits: { brands: 15, members: 30, monthly_generation_units: 5000, connected_accounts: 25 } },
] as const;

export function billingAccessState(status: BillingStatus, graceEndsAt?: string | null, now = new Date()): AccessState {
  if (status === 'trialing' || status === 'active') return 'full';
  if (status === 'past_due' && graceEndsAt && new Date(graceEndsAt) > now) return 'grace';
  if (['past_due', 'unpaid', 'paused', 'incomplete', 'incomplete_expired', 'canceled'].includes(status)) return 'read_only';
  return 'closed';
}

export function periodKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

export function usagePercent(used: number, limit: number, credits = 0) {
  if (limit < 0) return 0;
  const capacity = Math.max(limit + credits, 1);
  return Math.min(100, Math.max(0, Math.round((used / capacity) * 100)));
}

export type GenerationCharge = { usageType: 'generation_units'; units: number; label: string };

const generationRules: Array<{ method: string; pattern: RegExp; charge: GenerationCharge }> = [
  { method: 'POST', pattern: /^\/api\/brands\/[^/]+\/constitution\/generate$/, charge: { usageType: 'generation_units', units: 8, label: 'Brand Constitution' } },
  { method: 'POST', pattern: /^\/api\/(?:v2\/)?weekly-plans\/[^/]+\/strategy\/generate$/, charge: { usageType: 'generation_units', units: 5, label: 'Weekly strategy' } },
  { method: 'POST', pattern: /^\/api\/(?:v2\/)?weekly-plans\/[^/]+\/posts\/generate$/, charge: { usageType: 'generation_units', units: 10, label: 'Weekly post set' } },
  { method: 'POST', pattern: /^\/api\/(?:v2\/)?content-items\/[^/]+\/regenerate$/, charge: { usageType: 'generation_units', units: 1, label: 'Selective regeneration' } },
  { method: 'POST', pattern: /^\/api\/v2\/brands\/[^/]+\/weekly-learning-review$/, charge: { usageType: 'generation_units', units: 3, label: 'Learning review' } },
  { method: 'POST', pattern: /^\/api\/v3\/campaigns\/[^/]+\/brief\/generate$/, charge: { usageType: 'generation_units', units: 4, label: 'Campaign brief' } },
];

export function generationChargeForRequest(method: string, path: string): GenerationCharge | null {
  const normalizedMethod = method.toUpperCase();
  return generationRules.find((rule) => rule.method === normalizedMethod && rule.pattern.test(path))?.charge ?? null;
}

export function parseStripeSignature(header: string): { timestamp: number; signatures: string[] } {
  const values = header.split(',').map((item) => item.trim().split('='));
  const timestamp = values.find(([key]) => key === 't')?.[1];
  const signatures = values
    .filter(([key]) => key === 'v1')
    .map(([, value]) => value)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  return { timestamp: timestamp ? Number(timestamp) : NaN, signatures };
}

function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

export async function verifyStripeWebhook(body: string, header: string, secret: string, toleranceSeconds = 300, now = Date.now()) {
  const { timestamp, signatures } = parseStripeSignature(header);
  if (!Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(Math.floor(now / 1000) - timestamp) > toleranceSeconds) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  const expected = hex(digest);
  return signatures.some((signature) => constantTimeEqual(signature, expected));
}

export async function sha256(value: string) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

export function commercialMode(env: Env) {
  return env.BILLING_PROVIDER_MODE ?? 'mock';
}
