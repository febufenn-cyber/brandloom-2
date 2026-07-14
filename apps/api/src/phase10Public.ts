import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { assignExperiment, joinWaitlist, publicLaunchStatus, recordAcquisitionEvent } from './growthService';
import { createServiceClient } from './db';
import type { Env, Variables } from './types';

const publicGrowth = new Hono<{ Bindings: Env; Variables: Variables }>();

async function body<Schema extends z.ZodTypeAny>(c: Context, schema: Schema): Promise<z.output<Schema>> {
  return schema.parse(await c.req.json()) as z.output<Schema>;
}

publicGrowth.get('/public/v10/status', async (c) => c.json(await publicLaunchStatus(c.env)));

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
