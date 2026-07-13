import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { PLAN_CATALOG, commercialMode, periodKey, usagePercent } from './commercial';
import { commercialDashboard, completeMockCheckout, createCheckout, createPortal, createWorkspaceExport } from './commercialService';
import { createServiceClient } from './db';
import type { Env, Variables } from './types';

const phase5 = new Hono<{ Bindings: Env; Variables: Variables }>();

async function body<Schema extends z.ZodTypeAny>(c: Context, schema: Schema): Promise<z.output<Schema>> {
  return schema.parse(await c.req.json()) as z.output<Schema>;
}

async function role(c: Context, workspaceId: string) {
  const { data, error } = await c.get('supabase').rpc('workspace_role', { p_workspace_id: workspaceId });
  if (error) throw error;
  return data as string | null;
}

async function requireAdmin(c: Context, workspaceId: string) {
  const value = await role(c, workspaceId);
  if (!['owner', 'admin'].includes(value ?? '')) throw new Error('Workspace admin permission is required.');
  return value;
}

phase5.get('/v5/billing/plans', (c) => c.json({ plans: PLAN_CATALOG, provider_mode: commercialMode(c.env) }));

phase5.get('/v5/workspaces/:workspaceId/commercial', async (c) => {
  const workspaceId = c.req.param('workspaceId');
  const dashboard = await commercialDashboard(c.get('supabase'), workspaceId);
  const limit = Number(dashboard.entitlement?.limits?.monthly_generation_units ?? 0);
  const used = Number(dashboard.usage_by_type.generation_units ?? 0);
  return c.json({
    ...dashboard,
    plans: PLAN_CATALOG,
    provider_mode: commercialMode(c.env),
    usage_percent: usagePercent(used + dashboard.active_reservations, limit, dashboard.credits),
    role: await role(c, workspaceId),
  });
});

phase5.post('/v5/workspaces/:workspaceId/billing/checkout', async (c) => {
  const workspaceId = c.req.param('workspaceId');
  await requireAdmin(c, workspaceId);
  const input = await body(c, z.object({ plan_code: z.enum(['solo', 'growth', 'agency']) }));
  const result = await createCheckout(c.env, {
    workspaceId,
    planCode: input.plan_code,
    userId: c.get('user').id,
    email: c.get('user').email,
  });
  return c.json(result, 201);
});

phase5.post('/v5/workspaces/:workspaceId/billing/mock/complete', async (c) => {
  if (commercialMode(c.env) !== 'mock') return c.json({ error: 'Mock checkout is disabled.' }, 409);
  const workspaceId = c.req.param('workspaceId');
  await requireAdmin(c, workspaceId);
  const input = await body(c, z.object({ token: z.string().min(20) }));
  return c.json(await completeMockCheckout(c.env, workspaceId, c.get('user').id, input.token));
});

phase5.post('/v5/workspaces/:workspaceId/billing/portal', async (c) => {
  const workspaceId = c.req.param('workspaceId');
  await requireAdmin(c, workspaceId);
  return c.json(await createPortal(c.env, workspaceId));
});

phase5.post('/v5/workspaces/:workspaceId/usage/reserve', async (c) => {
  const workspaceId = c.req.param('workspaceId');
  const input = await body(c, z.object({ brand_id: z.string().uuid().nullable().optional(), quantity: z.number().positive().max(100), request_id: z.string().min(4).max(200) }));
  const { data, error } = await c.get('supabase').rpc('reserve_workspace_usage', {
    p_workspace_id: workspaceId,
    p_user_id: c.get('user').id,
    p_brand_id: input.brand_id ?? null,
    p_usage_type: 'generation_units',
    p_quantity: input.quantity,
    p_request_id: input.request_id,
    p_ttl_seconds: 900,
  });
  if (error) throw error;
  return c.json(Array.isArray(data) ? data[0] : data);
});

phase5.post('/v5/workspaces/:workspaceId/exports', async (c) => {
  const workspaceId = c.req.param('workspaceId');
  await requireAdmin(c, workspaceId);
  const job = await createWorkspaceExport(c.get('supabase'), workspaceId, c.get('user').id);
  return c.json({ id: job.id, status: job.status, checksum: job.checksum, expires_at: job.expires_at }, 201);
});

phase5.get('/v5/export-jobs/:jobId', async (c) => {
  const { data, error } = await c.get('supabase').from('data_export_jobs').select('*').eq('id', c.req.param('jobId')).single();
  if (error) throw error;
  return c.json(data);
});

phase5.post('/v5/workspaces/:workspaceId/deletion-requests', async (c) => {
  const workspaceId = c.req.param('workspaceId');
  await requireAdmin(c, workspaceId);
  const input = await body(c, z.object({ scope: z.enum(['workspace', 'brand']), brand_id: z.string().uuid().nullable().optional(), reason: z.string().max(1000).default('') }));
  if (input.scope === 'brand' && !input.brand_id) return c.json({ error: 'brand_id is required for brand deletion.' }, 400);
  const executeAfter = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const { data, error } = await c.get('supabase').from('deletion_requests').insert({
    workspace_id: workspaceId,
    requested_by: c.get('user').id,
    scope: input.scope,
    brand_id: input.brand_id ?? null,
    reason: input.reason,
    execute_after: executeAfter,
  }).select('*').single();
  if (error) throw error;
  await c.get('supabase').from('workspace_commercial_controls').upsert({
    workspace_id: workspaceId,
    generation_paused: true,
    generation_pause_reason: 'A data deletion request is pending.',
    updated_by: c.get('user').id,
  }, { onConflict: 'workspace_id' });
  return c.json(data, 201);
});

phase5.post('/v5/deletion-requests/:requestId/cancel', async (c) => {
  const supabase = c.get('supabase');
  const { data: request, error } = await supabase.from('deletion_requests').select('*').eq('id', c.req.param('requestId')).single();
  if (error) throw error;
  await requireAdmin(c, request.workspace_id);
  const { data, error: updateError } = await supabase.from('deletion_requests').update({ status: 'canceled', canceled_at: new Date().toISOString() }).eq('id', request.id).eq('status', 'scheduled').select('*').single();
  if (updateError) throw updateError;
  return c.json(data);
});

phase5.patch('/v5/workspaces/:workspaceId/controls', async (c) => {
  const workspaceId = c.req.param('workspaceId');
  await requireAdmin(c, workspaceId);
  const input = await body(c, z.object({ generation_paused: z.boolean(), reason: z.string().max(500).default('') }));
  const { data, error } = await c.get('supabase').from('workspace_commercial_controls').upsert({
    workspace_id: workspaceId,
    generation_paused: input.generation_paused,
    generation_pause_reason: input.reason,
    updated_by: c.get('user').id,
  }, { onConflict: 'workspace_id' }).select('*').single();
  if (error) throw error;
  return c.json(data);
});

phase5.get('/v5/admin/overview', async (c) => {
  const service = createServiceClient(c.env);
  const { data: admin } = await service.from('platform_admins').select('*').eq('user_id', c.get('user').id).maybeSingle();
  if (!admin) return c.json({ error: 'Platform administrator access is required.' }, 403);
  const [subscriptions, workspaces, usage, costs, billingEvents, deletions] = await Promise.all([
    service.from('subscriptions').select('*'),
    service.from('workspaces').select('id,name,created_at'),
    service.from('usage_ledger').select('workspace_id,quantity,period_key,usage_type').eq('period_key', periodKey()),
    service.from('cost_events').select('workspace_id,estimated_cost_micros,created_at').gte('created_at', `${periodKey()}-01T00:00:00Z`),
    service.from('billing_events').select('status,event_type,received_at').order('received_at', { ascending: false }).limit(50),
    service.from('deletion_requests').select('*').in('status', ['scheduled', 'ready', 'failed']),
  ]);
  for (const result of [subscriptions, workspaces, usage, costs, billingEvents, deletions]) if (result.error) throw result.error;
  return c.json({ admin, subscriptions: subscriptions.data ?? [], workspaces: workspaces.data ?? [], usage: usage.data ?? [], costs: costs.data ?? [], billing_events: billingEvents.data ?? [], deletion_requests: deletions.data ?? [] });
});

export default phase5;
