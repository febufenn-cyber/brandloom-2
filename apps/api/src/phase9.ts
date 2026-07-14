import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { acceptBetaInvite, assessBetaGate, betaDashboard, createBetaInvite, submitBetaFeedback } from './betaService';
import { sanitizeBetaContext } from './beta';
import { requirePlatformOperator } from './reliabilityService';
import type { Env, Variables } from './types';

const phase9 = new Hono<{ Bindings: Env; Variables: Variables }>();

async function body<Schema extends z.ZodTypeAny>(c: Context, schema: Schema): Promise<z.output<Schema>> {
  return schema.parse(await c.req.json()) as z.output<Schema>;
}

phase9.get('/v9/platform/beta', async (c) => c.json(await betaDashboard(c.env, c.get('user').id)));

phase9.post('/v9/platform/beta/programs', async (c) => {
  const { service } = await requirePlatformOperator(c.env, c.get('user').id);
  const input = await body(c, z.object({
    code: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
    name: z.string().min(3).max(160),
    capacity: z.number().int().min(1).max(10000).default(25),
    consent_version: z.string().min(1).max(80),
    starts_at: z.string().datetime().nullable().optional(),
    ends_at: z.string().datetime().nullable().optional(),
  }));
  const { data, error } = await service.from('beta_programs').insert({ ...input, starts_at: input.starts_at ?? null, ends_at: input.ends_at ?? null, created_by: c.get('user').id }).select('*').single();
  if (error) throw error;
  return c.json(data, 201);
});

phase9.patch('/v9/platform/beta/programs/:programId', async (c) => {
  const { service } = await requirePlatformOperator(c.env, c.get('user').id);
  const input = await body(c, z.object({
    status: z.enum(['draft', 'recruiting', 'active', 'paused', 'completed', 'cancelled']).optional(),
    capacity: z.number().int().min(1).max(10000).optional(),
    starts_at: z.string().datetime().nullable().optional(),
    ends_at: z.string().datetime().nullable().optional(),
  }));
  const { data, error } = await service.from('beta_programs').update(input).eq('id', c.req.param('programId')).select('*').single();
  if (error) throw error;
  return c.json(data);
});

phase9.post('/v9/platform/beta/invites', async (c) => {
  const input = await body(c, z.object({
    program_id: z.string().uuid(),
    email: z.string().email().max(320),
    intended_role: z.enum(['owner', 'admin', 'editor', 'reviewer', 'viewer']).default('owner'),
    expires_in_hours: z.number().int().min(1).max(336).default(72),
  }));
  return c.json(await createBetaInvite(c.env, c.get('user').id, {
    programId: input.program_id,
    email: input.email,
    intendedRole: input.intended_role,
    expiresInHours: input.expires_in_hours,
  }), 201);
});

phase9.post('/v9/beta/invites/accept', async (c) => {
  const input = await body(c, z.object({ token: z.string().min(32).max(500), consent_version: z.string().min(1).max(80), confirmation: z.literal('I ACCEPT') }));
  return c.json(await acceptBetaInvite(c.env, c.get('user').id, input.token, input.consent_version));
});

phase9.post('/v9/beta/feedback', async (c) => {
  const input = await body(c, z.object({
    program_id: z.string().uuid(),
    workspace_id: z.string().uuid().nullable().optional(),
    category: z.enum(['bug', 'quality', 'publishing', 'billing', 'security', 'usability', 'feature', 'other']),
    severity: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
    title: z.string().min(3).max(240),
    description: z.string().max(10000).default(''),
    reproduction: z.string().max(10000).default(''),
    trace_id: z.string().max(160).default(''),
    context: z.unknown().optional(),
  }));
  return c.json(await submitBetaFeedback(c.env, c.get('user').id, {
    programId: input.program_id,
    workspaceId: input.workspace_id,
    category: input.category,
    severity: input.severity,
    title: input.title,
    description: input.description,
    reproduction: input.reproduction,
    traceId: input.trace_id,
    context: input.context,
  }), 201);
});

phase9.patch('/v9/platform/beta/feedback/:feedbackId', async (c) => {
  const { service } = await requirePlatformOperator(c.env, c.get('user').id);
  const input = await body(c, z.object({
    status: z.enum(['new', 'triaged', 'investigating', 'planned', 'resolved', 'closed', 'duplicate']).optional(),
    severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
    assigned_to: z.string().uuid().nullable().optional(),
  }));
  const update = { ...input, assigned_to: input.assigned_to ?? undefined, ...(input.status === 'resolved' ? { resolved_at: new Date().toISOString() } : {}) };
  const { data, error } = await service.from('beta_feedback').update(update).eq('id', c.req.param('feedbackId')).select('*').single();
  if (error) throw error;
  return c.json(data);
});

phase9.post('/v9/platform/qa-runs', async (c) => {
  const { service } = await requirePlatformOperator(c.env, c.get('user').id);
  const input = await body(c, z.object({
    environment: z.enum(['staging', 'production']),
    suite: z.enum(['auth', 'rls', 'generation', 'publishing', 'billing', 'data_rights', 'reliability', 'accessibility', 'performance', 'security']),
    commit_sha: z.string().regex(/^[a-f0-9]{7,64}$/),
    release_id: z.string().uuid().nullable().optional(),
    source: z.enum(['ci', 'manual', 'synthetic', 'beta']).default('manual'),
  }));
  const { data, error } = await service.from('qa_test_runs').insert({ ...input, release_id: input.release_id ?? null, started_by: c.get('user').id }).select('*').single();
  if (error) throw error;
  return c.json(data, 201);
});

phase9.patch('/v9/platform/qa-runs/:runId', async (c) => {
  const { service } = await requirePlatformOperator(c.env, c.get('user').id);
  const input = await body(c, z.object({
    status: z.enum(['passed', 'failed', 'blocked', 'cancelled']),
    cases_total: z.number().int().min(0),
    cases_passed: z.number().int().min(0),
    cases_failed: z.number().int().min(0),
    result: z.record(z.unknown()).default({}),
    safe_error: z.string().max(2000).default(''),
    expires_at: z.string().datetime().nullable().optional(),
  }).refine((value) => value.cases_passed + value.cases_failed <= value.cases_total, 'Case totals are inconsistent.'));
  const { data, error } = await service.from('qa_test_runs').update({ ...input, result: sanitizeBetaContext(input.result), expires_at: input.expires_at ?? null, completed_at: new Date().toISOString() }).eq('id', c.req.param('runId')).eq('status', 'running').select('*').single();
  if (error) throw error;
  return c.json(data);
});

phase9.post('/v9/platform/security-findings', async (c) => {
  const { service } = await requirePlatformOperator(c.env, c.get('user').id);
  const input = await body(c, z.object({
    severity: z.enum(['critical', 'high', 'medium', 'low', 'informational']),
    title: z.string().min(3).max(240),
    description: z.string().max(10000).default(''),
    affected_component: z.string().max(240).default(''),
    evidence: z.record(z.unknown()).default({}),
    remediation: z.string().max(10000).default(''),
    due_at: z.string().datetime().nullable().optional(),
  }));
  const findingKey = `SEC-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
  const { data, error } = await service.from('security_findings').insert({ ...input, finding_key: findingKey, evidence: sanitizeBetaContext(input.evidence), due_at: input.due_at ?? null, created_by: c.get('user').id }).select('*').single();
  if (error) throw error;
  return c.json(data, 201);
});

phase9.patch('/v9/platform/security-findings/:findingId', async (c) => {
  const { service } = await requirePlatformOperator(c.env, c.get('user').id);
  const input = await body(c, z.object({
    status: z.enum(['open', 'triaged', 'in_progress', 'mitigated', 'accepted', 'closed', 'false_positive']).optional(),
    remediation: z.string().max(10000).optional(),
    owner_id: z.string().uuid().nullable().optional(),
  }));
  const closed = input.status && ['mitigated', 'closed', 'false_positive'].includes(input.status);
  const { data, error } = await service.from('security_findings').update({ ...input, owner_id: input.owner_id ?? undefined, ...(closed ? { mitigated_at: new Date().toISOString(), closed_at: input.status === 'closed' ? new Date().toISOString() : null } : {}) }).eq('id', c.req.param('findingId')).select('*').single();
  if (error) throw error;
  return c.json(data);
});

phase9.post('/v9/platform/beta/gate', async (c) => {
  const input = await body(c, z.object({ environment: z.enum(['staging', 'production']), program_id: z.string().uuid() }));
  return c.json(await assessBetaGate(c.env, c.get('user').id, input.environment, input.program_id));
});

export default phase9;
