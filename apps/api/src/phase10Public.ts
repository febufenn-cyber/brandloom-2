import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { assignExperiment, joinWaitlist, publicLaunchStatus, recordAcquisitionEvent } from './growthService';
import { createServiceClient } from './db';
import type { Env, Variables } from './types';

const publicGrowth = new Hono<{ Bindings: Env; Variables: Variables }>();

async function body<Schema extends z.ZodTypeAny>(c: Context, schema: Schema): Promise<z.output<Schema>> {
  return schema.parse(await c.req.json()) as z.output<Schema>;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

publicGrowth.get('/public/v10/status', async (c) => c.json(await publicLaunchStatus(c.env)));

publicGrowth.post('/public/v10/beta-invite', async (c) => {
  const input = await body(c, z.object({ token: z.string().min(32).max(500) }));
  const service = createServiceClient(c.env);
  const tokenHash = await sha256(input.token);
  const invite = await service.from('beta_invites').select('id,program_id,status,expires_at').eq('token_hash', tokenHash).maybeSingle();
  if (invite.error) throw invite.error;
  if (!invite.data || invite.data.status !== 'pending' || new Date(invite.data.expires_at) <= new Date()) return c.json({ valid: false }, 404);
  const program = await service.from('beta_programs').select('name,consent_version,status').eq('id', invite.data.program_id).single();
  if (program.error) throw program.error;
  const valid = ['recruiting','active'].includes(program.data.status);
  return c.json({ valid, program_name: program.data.name, consent_version: program.data.consent_version, expires_at: invite.data.expires_at, status: invite.data.status });
});

publicGrowth.post('/public/v10/waitlist', async (c) => {
  const input = await body(c, z.object({
    email: z.string().email().max(320),
    consent_version: z.string().min(1).max(80),
    source: z.string().max(120).optional(),
    medium: z.string().max(120).optional(),
    campaign: z.string().max(120).optional(),
    referral_code: z.string().max(20).optional(),
    metadata: z.unknown().optional(),
  }));
  const expectedConsent = c.env.WAITLIST_CONSENT_VERSION;
  if (!expectedConsent && (c.env.DEPLOYMENT_ENVIRONMENT ?? 'local') === 'production') return c.json({ error: 'Waitlist consent configuration is unavailable.' }, 503);
  if (expectedConsent && input.consent_version !== expectedConsent) return c.json({ error: 'The waitlist terms changed. Reload and accept the current version.' }, 409);
  return c.json(await joinWaitlist(c.env, {
    email: input.email,
    consentVersion: input.consent_version,
    source: input.source,
    medium: input.medium,
    campaign: input.campaign,
    referralCode: input.referral_code,
    metadata: input.metadata,
  }), 201);
});

publicGrowth.post('/public/v10/events', async (c) => {
  const input = await body(c, z.object({
    event_key: z.string().min(12).max(240),
    event_type: z.enum(['landing_view','signup_started']),
    anonymous_id: z.string().min(8).max(240),
    source: z.string().max(120).optional(),
    medium: z.string().max(120).optional(),
    campaign: z.string().max(120).optional(),
    content: z.string().max(120).optional(),
    referral_code: z.string().max(20).optional(),
    properties: z.unknown().optional(),
    occurred_at: z.string().datetime().optional(),
  }));
  const data = await recordAcquisitionEvent(createServiceClient(c.env), {
    eventKey: input.event_key,
    eventType: input.event_type,
    anonymousId: input.anonymous_id,
    source: input.source,
    medium: input.medium,
    campaign: input.campaign,
    content: input.content,
    referralCode: input.referral_code,
    properties: input.properties,
    occurredAt: input.occurred_at,
  });
  return c.json({ accepted: true, id: data?.id ?? null }, 202);
});

publicGrowth.post('/public/v10/experiments/:experimentKey/assignment', async (c) => {
  const input = await body(c, z.object({ subject_id: z.string().min(8).max(240) }));
  return c.json(await assignExperiment(c.env, c.req.param('experimentKey'), input.subject_id));
});

export default publicGrowth;
