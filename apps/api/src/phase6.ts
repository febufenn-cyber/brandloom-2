import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { commercialMode } from './commercial';
import {
  createOptimizationReview,
  evaluateBrandExperiment,
  importPerformance,
  optimizationDashboard,
} from './optimizationService';
import type { Env, Variables } from './types';

const phase6 = new Hono<{ Bindings: Env; Variables: Variables }>();
type Row = Record<string, any>;

async function body<Schema extends z.ZodTypeAny>(c: Context, schema: Schema): Promise<z.output<Schema>> {
  return schema.parse(await c.req.json()) as z.output<Schema>;
}

async function brandAccess(c: Context, brandId: string) {
  const supabase = c.get('supabase');
  const brandResult = await supabase.from('brands').select('id,workspace_id,name').eq('id', brandId).single();
  if (brandResult.error) throw brandResult.error;
  const workspaceId = brandResult.data.workspace_id as string;
  const roleResult = await supabase.rpc('workspace_role', { p_workspace_id: workspaceId });
  if (roleResult.error) throw roleResult.error;
  if (!roleResult.data) throw new Error('Brand access is required.');
  const entitlementResult = await supabase.from('entitlement_snapshots').select('*').eq('workspace_id', workspaceId).order('version', { ascending: false }).limit(1).maybeSingle();
  if (entitlementResult.error) throw entitlementResult.error;
  return { brand: brandResult.data as Row, workspaceId, role: String(roleResult.data), entitlement: entitlementResult.data as Row | null };
}

function canEdit(role: string) {
  return ['owner', 'admin', 'editor'].includes(role);
}

function canReview(role: string) {
  return ['owner', 'admin', 'editor', 'reviewer', 'approver'].includes(role);
}

async function requireEdit(c: Context, brandId: string) {
  const access = await brandAccess(c, brandId);
  if (!canEdit(access.role)) throw new Error('Editor permission is required.');
  return access;
}

async function requireReview(c: Context, brandId: string) {
  const access = await brandAccess(c, brandId);
  if (!canReview(access.role)) throw new Error('Reviewer permission is required.');
  return access;
}

function hasOptimizationFeature(c: Context, access: Awaited<ReturnType<typeof brandAccess>>) {
  if (commercialMode(c.env) === 'mock') return true;
  const features = (access.entitlement?.features ?? {}) as Record<string, unknown>;
  return features.intelligent_optimization === true || ['growth', 'agency'].includes(String(access.entitlement?.plan_code ?? ''));
}

function requireOptimizationFeature(c: Context, access: Awaited<ReturnType<typeof brandAccess>>) {
  if (!hasOptimizationFeature(c, access)) throw new Error('Intelligent optimization requires the Growth or Agency plan.');
}

const metricRowSchema = z.object({
  content_item_id: z.string().uuid(),
  publication_job_id: z.string().uuid().nullable().optional(),
  platform_account_id: z.string().uuid().nullable().optional(),
  source_event_id: z.string().min(1).max(300).nullable().optional(),
  provider_media_id: z.string().max(300).default(''),
  window_start: z.string().datetime(),
  window_end: z.string().datetime(),
  observed_at: z.string().datetime().optional(),
  impressions: z.number().nonnegative().default(0),
  reach: z.number().nonnegative().default(0),
  likes: z.number().nonnegative().default(0),
  comments: z.number().nonnegative().default(0),
  saves: z.number().nonnegative().default(0),
  shares: z.number().nonnegative().default(0),
  clicks: z.number().nonnegative().default(0),
  profile_visits: z.number().nonnegative().default(0),
  follows: z.number().nonnegative().default(0),
  video_views: z.number().nonnegative().default(0),
  watch_time_seconds: z.number().nonnegative().default(0),
  custom_metrics: z.record(z.unknown()).default({}),
  is_final: z.boolean().default(false),
}).refine((value) => new Date(value.window_end) >= new Date(value.window_start), { message: 'window_end must not precede window_start.' });

phase6.get('/v6/brands/:brandId/dashboard', async (c) => {
  const access = await brandAccess(c, c.req.param('brandId'));
  const dashboard = await optimizationDashboard(c.get('supabase'), c.req.param('brandId'));
  return c.json({ ...dashboard, role: access.role, optimization_enabled: hasOptimizationFeature(c, access) });
});

phase6.post('/v6/brands/:brandId/performance/import', async (c) => {
  const brandId = c.req.param('brandId');
  await requireEdit(c, brandId);
  const input = await body(c, z.object({
    source: z.enum(['manual', 'csv', 'meta', 'api', 'system']),
    external_batch_id: z.string().min(1).max(300).nullable().optional(),
    period_start: z.string().date().nullable().optional(),
    period_end: z.string().date().nullable().optional(),
    rows: z.array(metricRowSchema).min(1).max(500),
  }));
  const result = await importPerformance(c.get('supabase'), brandId, c.get('user').id, input);
  return c.json(result, result.idempotent_replay ? 200 : 201);
});

phase6.post('/v6/brands/:brandId/reviews', async (c) => {
  const brandId = c.req.param('brandId');
  const access = await requireReview(c, brandId);
  requireOptimizationFeature(c, access);
  const input = await body(c, z.object({ window_days: z.number().int().min(14).max(365).default(60) }));
  const result = await createOptimizationReview(c.get('supabase'), brandId, c.get('user').id, input.window_days);
  await c.get('supabase').from('activity_events').insert({
    workspace_id: access.workspaceId,
    brand_id: brandId,
    actor_id: c.get('user').id,
    event_type: 'optimization_review_generated',
    entity_type: 'optimization_review',
    entity_id: result.review.id,
    metadata: { recommendations: result.recommendations.length, fatigue_signals: result.fatigue.length, window_days: input.window_days },
  });
  return c.json(result, 201);
});

phase6.get('/v6/recommendations/:recommendationId/evidence', async (c) => {
  const supabase = c.get('supabase');
  const recommendationResult = await supabase.from('optimization_recommendations').select('*').eq('id', c.req.param('recommendationId')).single();
  if (recommendationResult.error) throw recommendationResult.error;
  const evidenceResult = await supabase.from('recommendation_evidence').select('*').eq('recommendation_id', c.req.param('recommendationId')).order('created_at');
  if (evidenceResult.error) throw evidenceResult.error;
  const decisionsResult = await supabase.from('optimization_decisions').select('*').eq('recommendation_id', c.req.param('recommendationId')).order('created_at', { ascending: false });
  if (decisionsResult.error) throw decisionsResult.error;
  return c.json({ recommendation: recommendationResult.data, evidence: evidenceResult.data ?? [], decisions: decisionsResult.data ?? [] });
});

phase6.post('/v6/recommendations/:recommendationId/approve', async (c) => {
  const input = await body(c, z.object({ note: z.string().max(2000).default('') }));
  const supabase = c.get('supabase');
  const recResult = await supabase.from('optimization_recommendations').select('brand_id').eq('id', c.req.param('recommendationId')).single();
  if (recResult.error) throw recResult.error;
  await requireReview(c, recResult.data.brand_id);
  const result = await supabase.rpc('approve_optimization_recommendation', { p_recommendation_id: c.req.param('recommendationId'), p_note: input.note });
  if (result.error) throw result.error;
  return c.json({ recommendation_id: c.req.param('recommendationId'), memory_item_id: result.data, status: 'approved' });
});

phase6.post('/v6/recommendations/:recommendationId/decision', async (c) => {
  const input = await body(c, z.object({ decision: z.enum(['reject', 'pause', 'reactivate', 'expire', 'supersede']), note: z.string().max(2000).default('') }));
  const supabase = c.get('supabase');
  const recResult = await supabase.from('optimization_recommendations').select('brand_id').eq('id', c.req.param('recommendationId')).single();
  if (recResult.error) throw recResult.error;
  await requireReview(c, recResult.data.brand_id);
  const result = await supabase.rpc('decide_optimization_recommendation', { p_recommendation_id: c.req.param('recommendationId'), p_decision: input.decision, p_note: input.note });
  if (result.error) throw result.error;
  return c.json({ recommendation_id: c.req.param('recommendationId'), status: result.data });
});

const variantSchema = z.object({
  key: z.string().min(1).max(80),
  name: z.string().min(1).max(160),
  instructions: z.string().max(2000).default(''),
});

phase6.post('/v6/brands/:brandId/experiments', async (c) => {
  const brandId = c.req.param('brandId');
  const access = await requireReview(c, brandId);
  requireOptimizationFeature(c, access);
  const input = await body(c, z.object({
    name: z.string().min(3).max(180),
    hypothesis: z.string().min(10).max(3000),
    experiment_type: z.enum(['content', 'timing', 'format', 'audience', 'offer', 'workflow']).default('content'),
    variants: z.array(variantSchema).min(2).max(6).refine((variants) => new Set(variants.map((variant) => variant.key)).size === variants.length, { message: 'Variant keys must be unique.' }),
    primary_metric: z.string().min(2).max(120).default('engagement_rate'),
    guardrail_metrics: z.array(z.string().min(1).max(120)).max(12).default([]),
    min_sample_size: z.number().int().min(2).max(1000).default(10),
    confidence_threshold: z.number().min(0.5).max(0.99).default(0.7),
    attribution_window_days: z.number().int().min(1).max(90).default(7),
    start_date: z.string().date().nullable().optional(),
    end_date: z.string().date().nullable().optional(),
  }));
  const result = await c.get('supabase').from('brand_experiments').insert({
    brand_id: brandId,
    name: input.name,
    hypothesis: input.hypothesis,
    experiment_type: input.experiment_type,
    variants: input.variants,
    primary_metric: input.primary_metric,
    success_metric: input.primary_metric,
    guardrail_metrics: input.guardrail_metrics,
    min_sample_size: input.min_sample_size,
    confidence_threshold: input.confidence_threshold,
    attribution_window_days: input.attribution_window_days,
    start_date: input.start_date ?? null,
    end_date: input.end_date ?? null,
    design: { randomized_assignment_required: true, one_variant_per_content: true, correlation_claims_prohibited: true },
    status: 'proposed',
  }).select('*').single();
  if (result.error) throw result.error;
  return c.json(result.data, 201);
});

phase6.post('/v6/experiments/:experimentId/activate', async (c) => {
  const supabase = c.get('supabase');
  const experiment = await supabase.from('brand_experiments').select('*').eq('id', c.req.param('experimentId')).single();
  if (experiment.error) throw experiment.error;
  await requireReview(c, experiment.data.brand_id);
  const result = await supabase.from('brand_experiments').update({
    status: 'active', approved_by: c.get('user').id, approved_at: new Date().toISOString(),
    start_date: experiment.data.start_date ?? new Date().toISOString().slice(0, 10),
  }).eq('id', experiment.data.id).eq('status', 'proposed').select('*').single();
  if (result.error) throw result.error;
  return c.json(result.data);
});

phase6.post('/v6/experiments/:experimentId/assignments', async (c) => {
  const supabase = c.get('supabase');
  const experiment = await supabase.from('brand_experiments').select('*').eq('id', c.req.param('experimentId')).single();
  if (experiment.error) throw experiment.error;
  await requireEdit(c, experiment.data.brand_id);
  if (experiment.data.status !== 'active') return c.json({ error: 'Experiment must be active before assignment.' }, 409);
  const input = await body(c, z.object({ content_item_id: z.string().uuid(), variant_key: z.string().min(1).max(80) }));
  const result = await supabase.from('experiment_assignments').insert({
    brand_id: experiment.data.brand_id,
    experiment_id: experiment.data.id,
    content_item_id: input.content_item_id,
    variant_key: input.variant_key,
    assigned_by: c.get('user').id,
  }).select('*').single();
  if (result.error) throw result.error;
  return c.json(result.data, 201);
});

phase6.post('/v6/experiments/:experimentId/evaluate', async (c) => {
  const supabase = c.get('supabase');
  const experiment = await supabase.from('brand_experiments').select('brand_id').eq('id', c.req.param('experimentId')).single();
  if (experiment.error) throw experiment.error;
  await requireReview(c, experiment.data.brand_id);
  const input = await body(c, z.object({ complete: z.boolean().default(false) }));
  return c.json(await evaluateBrandExperiment(supabase, c.req.param('experimentId'), c.get('user').id, input.complete));
});

phase6.post('/v6/brands/:brandId/opportunities', async (c) => {
  const brandId = c.req.param('brandId');
  const access = await requireEdit(c, brandId);
  const input = await body(c, z.object({
    source: z.enum(['manual', 'calendar', 'performance', 'seasonal', 'customer', 'research']).default('manual'),
    signal_type: z.enum(['event', 'trend', 'product', 'audience', 'campaign', 'retention']),
    title: z.string().min(3).max(240),
    description: z.string().max(5000).default(''),
    source_reference: z.string().max(1000).default(''),
    relevance_score: z.number().min(0).max(1).default(0.5),
    confidence: z.number().min(0).max(1).default(0.5),
    valid_from: z.string().date().nullable().optional(),
    valid_until: z.string().date().nullable().optional(),
  }));
  const result = await c.get('supabase').from('opportunity_signals').insert({
    workspace_id: access.workspaceId,
    brand_id: brandId,
    ...input,
    valid_from: input.valid_from ?? null,
    valid_until: input.valid_until ?? null,
    created_by: c.get('user').id,
  }).select('*').single();
  if (result.error) throw result.error;
  return c.json(result.data, 201);
});

phase6.post('/v6/opportunities/:opportunityId/decision', async (c) => {
  const supabase = c.get('supabase');
  const opportunity = await supabase.from('opportunity_signals').select('*').eq('id', c.req.param('opportunityId')).single();
  if (opportunity.error) throw opportunity.error;
  await requireEdit(c, opportunity.data.brand_id);
  const input = await body(c, z.object({ status: z.enum(['accepted', 'rejected']) }));
  const result = await supabase.from('opportunity_signals').update({ status: input.status }).eq('id', opportunity.data.id).select('*').single();
  if (result.error) throw result.error;
  return c.json(result.data);
});

phase6.post('/v6/opportunities/:opportunityId/convert', async (c) => {
  const supabase = c.get('supabase');
  const opportunity = await supabase.from('opportunity_signals').select('*').eq('id', c.req.param('opportunityId')).single();
  if (opportunity.error) throw opportunity.error;
  await requireEdit(c, opportunity.data.brand_id);
  const input = await body(c, z.object({ name: z.string().min(3).max(180).optional(), start_date: z.string().date(), end_date: z.string().date() }));
  const campaign = await supabase.from('campaigns').insert({
    brand_id: opportunity.data.brand_id,
    name: input.name ?? opportunity.data.title,
    objective: opportunity.data.description,
    start_date: input.start_date,
    end_date: input.end_date,
    key_message: opportunity.data.title,
    campaign_facts: [{ source: 'opportunity_signal', opportunity_id: opportunity.data.id, description: opportunity.data.description, confidence: opportunity.data.confidence }],
    restrictions: ['Opportunity-derived campaign requires normal fact, asset and approval checks.'],
    owner_id: c.get('user').id,
    status: 'draft',
  }).select('*').single();
  if (campaign.error) throw campaign.error;
  const updated = await supabase.from('opportunity_signals').update({ status: 'converted', converted_campaign_id: campaign.data.id }).eq('id', opportunity.data.id).select('*').single();
  if (updated.error) throw updated.error;
  return c.json({ opportunity: updated.data, campaign: campaign.data }, 201);
});

phase6.post('/v6/fatigue/:signalId/status', async (c) => {
  const supabase = c.get('supabase');
  const signal = await supabase.from('fatigue_signals').select('*').eq('id', c.req.param('signalId')).single();
  if (signal.error) throw signal.error;
  await requireEdit(c, signal.data.brand_id);
  const input = await body(c, z.object({ status: z.enum(['acknowledged', 'resolved']) }));
  const payload: Row = { status: input.status };
  if (input.status === 'resolved') {
    payload.resolved_by = c.get('user').id;
    payload.resolved_at = new Date().toISOString();
  }
  const result = await supabase.from('fatigue_signals').update(payload).eq('id', signal.data.id).select('*').single();
  if (result.error) throw result.error;
  return c.json(result.data);
});

export default phase6;
