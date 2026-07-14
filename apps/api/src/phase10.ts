import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { sanitizeGrowthProperties } from './growth';
import { assessPublicLaunch, createReferralCode, growthDashboard, openPublicLaunch, pausePublicLaunch, recordAcquisitionEvent } from './growthService';
import { requirePlatformOperator } from './reliabilityService';
import type { Env, Variables } from './types';

const phase10 = new Hono<{ Bindings: Env; Variables: Variables }>();

async function body<Schema extends z.ZodTypeAny>(c: Context, schema: Schema): Promise<z.output<Schema>> {
  return schema.parse(await c.req.json()) as z.output<Schema>;
}

phase10.get('/v10/platform/growth', async (c) => c.json(await growthDashboard(c.env, c.get('user').id)));

phase10.post('/v10/platform/launch-programs', async (c) => {
  const { service } = await requirePlatformOperator(c.env, c.get('user').id);
  const input = await body(c, z.object({
    code: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
    name: z.string().min(3).max(160),
    launch_version: z.string().min(1).max(120),
    target_at: z.string().datetime().nullable().optional(),
  }));
  const { data: program, error } = await service.from('launch_programs').insert({ ...input, environment: 'production', target_at: input.target_at ?? null, created_by: c.get('user').id }).select('*').single();
  if (error) throw error;
  const defaults = [
    ['product','core_journey','Core onboarding, generation, approval and publishing journey verified'],
    ['security','security_review','Security review and current QA evidence approved'],
    ['legal','legal_pages','Terms, privacy, cancellation and acceptable-use pages published'],
    ['support','support_ready','Support ownership, escalation and response targets staffed'],
    ['operations','incident_ready','Incident, rollback and status communication drill completed'],
    ['billing','billing_ready','Live prices, tax, invoices, cancellation and failed-payment recovery verified'],
    ['publishing','publishing_ready','Meta permissions, account health and test publication verified'],
    ['data_rights','data_rights_ready','Export and deletion flows verified end to end'],
    ['communications','launch_copy','Launch and incident communication approved'],
  ].map(([category,item_key,title]) => ({ launch_program_id: program.id, category, item_key, title, required: true }));
  const checklist = await service.from('launch_checklist_items').insert(defaults);
  if (checklist.error) throw checklist.error;
  return c.json(program, 201);
});

phase10.put('/v10/platform/launch-programs/:programId/checklist/:itemKey', async (c) => {
  const { service, admin } = await requirePlatformOperator(c.env, c.get('user').id);
  const input = await body(c, z.object({
    status: z.enum(['pending','passed','failed','waived']),
    summary: z.string().min(3).max(2000),
    evidence: z.record(z.unknown()).default({}),
    expires_at: z.string().datetime().nullable().optional(),
  }));
  if (input.status === 'waived' && admin.role !== 'super_admin') return c.json({ error: 'Only a super administrator can waive a launch requirement.' }, 403);
  const { data, error } = await service.from('launch_checklist_items').update({
    status: input.status,
    summary: input.summary,
    evidence: sanitizeGrowthProperties(input.evidence),
    checked_by: c.get('user').id,
    checked_at: new Date().toISOString(),
    expires_at: input.expires_at ?? null,
  }).eq('launch_program_id', c.req.param('programId')).eq('item_key', c.req.param('itemKey')).select('*').single();
  if (error) throw error;
  return c.json(data);
});

phase10.post('/v10/platform/launch-programs/:programId/assess', async (c) => c.json(await assessPublicLaunch(c.env, c.get('user').id, c.req.param('programId'))));

phase10.post('/v10/platform/launch-programs/:programId/open', async (c) => {
  const input = await body(c, z.object({ confirmation: z.literal('OPEN PUBLIC ACCESS'), reason: z.string().min(3).max(2000) }));
  return c.json(await openPublicLaunch(c.env, c.get('user').id, c.req.param('programId'), input.confirmation, input.reason));
});

phase10.post('/v10/platform/launch/pause', async (c) => {
  const input = await body(c, z.object({ confirmation: z.literal('PAUSE PUBLIC ACCESS'), reason: z.string().min(3).max(2000) }));
  return c.json(await pausePublicLaunch(c.env, c.get('user').id, input.confirmation, input.reason));
});

phase10.post('/v10/referrals', async (c) => {
  const input = await body(c, z.object({ workspace_id: z.string().uuid(), max_conversions: z.number().int().min(1).max(100000).nullable().optional() }));
  return c.json(await createReferralCode(c.env, c.get('user').id, input.workspace_id, input.max_conversions), 201);
});

phase10.post('/v10/platform/growth-experiments', async (c) => {
  const { service } = await requirePlatformOperator(c.env, c.get('user').id);
  const input = await body(c, z.object({
    experiment_key: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,79}$/),
    name: z.string().min(3).max(200),
    surface: z.enum(['landing','pricing','onboarding','activation','referral','lifecycle']),
    hypothesis: z.string().max(3000).default(''),
    variants: z.array(z.object({ key: z.string().min(1).max(80), weight: z.number().int().min(1).max(1000).default(1) })).min(2).max(8),
    allocation_percent: z.number().int().min(1).max(100).default(100),
    primary_metric: z.string().min(1).max(120),
  }));
  const { data, error } = await service.from('growth_experiments').insert({ ...input, created_by: c.get('user').id }).select('*').single();
  if (error) throw error;
  return c.json(data, 201);
});

phase10.patch('/v10/platform/growth-experiments/:experimentId', async (c) => {
  const { service } = await requirePlatformOperator(c.env, c.get('user').id);
  const input = await body(c, z.object({ status: z.enum(['draft','running','paused','completed','cancelled']), starts_at: z.string().datetime().nullable().optional(), ends_at: z.string().datetime().nullable().optional() }));
  const { data, error } = await service.from('growth_experiments').update(input).eq('id', c.req.param('experimentId')).select('*').single();
  if (error) throw error;
  return c.json(data);
});

phase10.post('/v10/growth/outcomes', async (c) => {
  const input = await body(c, z.object({ assignment_id: z.string().uuid(), metric_key: z.string().min(1).max(120), metric_value: z.number().finite().default(1), event_key: z.string().min(12).max(240), occurred_at: z.string().datetime().optional() }));
  const service = c.get('supabase');
  const { data, error } = await service.from('growth_experiment_outcomes').insert({ ...input, occurred_at: input.occurred_at ?? new Date().toISOString() }).select('*').single();
  if (error) throw error;
  return c.json(data, 201);
});

phase10.post('/v10/events', async (c) => {
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
  const data = await recordAcquisitionEvent(c.get('supabase') as any, {
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

phase10.post('/v10/platform/lifecycle-actions', async (c) => {
  const { service } = await requirePlatformOperator(c.env, c.get('user').id);
  const input = await body(c, z.object({
    workspace_id: z.string().uuid().nullable().optional(),
    user_id: z.string().uuid().nullable().optional(),
    action_type: z.enum(['welcome','activation_help','usage_warning','trial_expiry','publish_recovery','feedback_request','winback']),
    channel: z.enum(['in_app','email']).default('in_app'),
    payload: z.record(z.unknown()).default({}),
    scheduled_for: z.string().datetime().nullable().optional(),
  }));
  const { data, error } = await service.from('lifecycle_actions').insert({ ...input, workspace_id: input.workspace_id ?? null, user_id: input.user_id ?? null, payload: sanitizeGrowthProperties(input.payload), scheduled_for: input.scheduled_for ?? null }).select('*').single();
  if (error) throw error;
  return c.json(data, 201);
});

phase10.patch('/v10/platform/lifecycle-actions/:actionId', async (c) => {
  const { service } = await requirePlatformOperator(c.env, c.get('user').id);
  const input = await body(c, z.object({ status: z.enum(['approved','cancelled']), confirmation: z.string() }));
  if (input.status === 'approved' && input.confirmation !== 'APPROVE LIFECYCLE ACTION') return c.json({ error: 'Type APPROVE LIFECYCLE ACTION to confirm.' }, 409);
  const { data, error } = await service.from('lifecycle_actions').update({ status: input.status, approved_by: c.get('user').id, approved_at: input.status === 'approved' ? new Date().toISOString() : null }).eq('id', c.req.param('actionId')).eq('status', 'proposed').select('*').single();
  if (error) throw error;
  return c.json(data);
});

export default phase10;
