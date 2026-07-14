import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { createServiceClient } from './db';
import { recordAcquisitionEvent } from './growthService';
import type { Env, Variables } from './types';

const secureGrowth = new Hono<{ Bindings: Env; Variables: Variables }>();

async function body<Schema extends z.ZodTypeAny>(c: Context, schema: Schema): Promise<z.output<Schema>> {
  return schema.parse(await c.req.json()) as z.output<Schema>;
}

secureGrowth.post('/v10/growth/outcomes', async (c) => {
  const input = await body(c, z.object({
    assignment_id: z.string().uuid(),
    metric_key: z.string().min(1).max(120),
    metric_value: z.number().finite().default(1),
    event_key: z.string().min(12).max(240),
    occurred_at: z.string().datetime().optional(),
  }));
  const service = createServiceClient(c.env);
  const assignment = await service.from('growth_experiment_assignments').select('id,experiment_id').eq('id', input.assignment_id).maybeSingle();
  if (assignment.error) throw assignment.error;
  if (!assignment.data) return c.json({ error: 'Experiment assignment was not found.' }, 404);
  const experiment = await service.from('growth_experiments').select('status,primary_metric,ends_at').eq('id', assignment.data.experiment_id).single();
  if (experiment.error) throw experiment.error;
  if (experiment.data.status !== 'running' || (experiment.data.ends_at && new Date(experiment.data.ends_at) <= new Date())) return c.json({ error: 'Experiment is not accepting outcomes.' }, 409);
  if (input.metric_key !== experiment.data.primary_metric) return c.json({ error: 'Outcome metric does not match the experiment primary metric.' }, 409);
  const result = await service.from('growth_experiment_outcomes').insert({ ...input, occurred_at: input.occurred_at ?? new Date().toISOString() }).select('*').single();
  if (result.error) throw result.error;
  return c.json(result.data, 201);
});

secureGrowth.post('/v10/events', async (c) => {
  const input = await body(c, z.object({
    event_key: z.string().min(12).max(240),
    event_type: z.enum(['signup_completed','workspace_created','brand_ready','first_approved_content','first_verified_publish','trial_started','subscription_started','churned']),
    workspace_id: z.string().uuid().nullable().optional(),
    source: z.string().max(120).optional(),
    medium: z.string().max(120).optional(),
    campaign: z.string().max(120).optional(),
    content: z.string().max(120).optional(),
    referral_code: z.string().max(20).optional(),
    properties: z.unknown().optional(),
    occurred_at: z.string().datetime().optional(),
  }));
  const service = createServiceClient(c.env);
  if (input.workspace_id) {
    const member = await service.from('workspace_members').select('id').eq('workspace_id', input.workspace_id).eq('user_id', c.get('user').id).maybeSingle();
    if (member.error) throw member.error;
    if (!member.data) return c.json({ error: 'Workspace access is required.' }, 403);
  }
  const data = await recordAcquisitionEvent(service, {
    eventKey: input.event_key,
    eventType: input.event_type,
    userId: c.get('user').id,
    workspaceId: input.workspace_id,
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

export default secureGrowth;
