import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { activateEnvironment, activationDashboard, runActivationVerification } from './activationService';
import { requirePlatformOperator } from './reliabilityService';
import type { Env, Variables } from './types';

const phase8 = new Hono<{ Bindings: Env; Variables: Variables }>();
const environmentSchema = z.enum(['staging', 'production']);
const componentSchema = z.enum(['database', 'web', 'worker', 'storage', 'ai_provider', 'publishing_provider', 'billing_provider', 'webhooks']);

async function body<Schema extends z.ZodTypeAny>(c: Context, schema: Schema): Promise<z.output<Schema>> {
  return schema.parse(await c.req.json()) as z.output<Schema>;
}

phase8.get('/v8/platform/activation', async (c) => c.json(await activationDashboard(c.env, c.get('user').id)));

phase8.post('/v8/platform/activation/:environment/verify', async (c) => {
  const environment = environmentSchema.parse(c.req.param('environment'));
  return c.json(await runActivationVerification(c.env, environment, c.get('user').id));
});

phase8.post('/v8/platform/activation/:environment/activate', async (c) => {
  const environment = environmentSchema.parse(c.req.param('environment'));
  const input = await body(c, z.object({ confirmation: z.string().min(1) }));
  return c.json(await activateEnvironment(c.env, environment, c.get('user').id, input.confirmation));
});

phase8.post('/v8/platform/activation/:environment/evidence', async (c) => {
  const environment = environmentSchema.parse(c.req.param('environment'));
  const { service, admin } = await requirePlatformOperator(c.env, c.get('user').id);
  const input = await body(c, z.object({
    component: componentSchema,
    status: z.enum(['pending', 'passed', 'failed', 'waived']),
    summary: z.string().min(3).max(2000),
    evidence: z.record(z.unknown()).default({}),
    expires_at: z.string().datetime().nullable().optional(),
  }));
  if (input.status === 'waived' && admin.role !== 'super_admin') return c.json({ error: 'Only a super administrator can waive activation evidence.' }, 403);
  const runId = crypto.randomUUID();
  const { data, error } = await service.from('provider_activation_checks').insert({
    environment,
    activation_run_id: runId,
    component: input.component,
    status: input.status,
    summary: input.summary,
    evidence: { ...input.evidence, manual: true },
    checked_by: c.get('user').id,
    checked_at: new Date().toISOString(),
    expires_at: input.expires_at ?? null,
  }).select('*').single();
  if (error) throw error;
  await service.from('operational_audit_events').insert({
    environment,
    actor_id: c.get('user').id,
    action: `provider_activation.evidence.${input.status}`,
    entity_type: 'provider_activation_check',
    entity_id: data.id,
    metadata: { component: input.component, summary: input.summary },
  });
  return c.json(data, 201);
});

export default phase8;
