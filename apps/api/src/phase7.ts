import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { incidentControlPreset, type DeploymentEnvironment, type GateKey } from './reliability';
import {
  promoteRelease,
  reliabilityDashboard,
  requirePlatformOperator,
  rollbackRelease,
  runAutomatedReleaseChecks,
  validateRelease,
  requiredGateKeys,
} from './reliabilityService';
import type { Env, Variables } from './types';

const phase7 = new Hono<{ Bindings: Env; Variables: Variables }>();

async function body<Schema extends z.ZodTypeAny>(c: Context, schema: Schema): Promise<z.output<Schema>> {
  return schema.parse(await c.req.json()) as z.output<Schema>;
}

const environmentSchema = z.enum(['local', 'staging', 'production']);
const gateKeySchema = z.enum([
  'migration_verified', 'secrets_verified', 'database_health', 'provider_readiness',
  'backup_restore_verified', 'rollback_ready', 'observability_ready', 'security_review',
]);

phase7.get('/v7/platform/reliability', async (c) => c.json(await reliabilityDashboard(c.env, c.get('user').id)));

phase7.post('/v7/platform/releases', async (c) => {
  const { service } = await requirePlatformOperator(c.env, c.get('user').id);
  const input = await body(c, z.object({
    environment: environmentSchema,
    version: z.string().min(1).max(120),
    commit_sha: z.string().regex(/^[a-f0-9]{7,64}$/),
    artifact_checksum: z.string().min(16).max(256),
    migration_version: z.string().regex(/^\d{4}$/),
    release_notes: z.string().max(10_000).default(''),
    metadata: z.record(z.unknown()).default({}),
  }));
  const { data: release, error } = await service.from('system_releases').insert({
    ...input,
    created_by: c.get('user').id,
    status: 'draft',
  }).select('*').single();
  if (error) throw error;
  const gates = requiredGateKeys(input.environment as DeploymentEnvironment).map((gateKey) => ({
    release_id: release.id,
    gate_key: gateKey,
    status: 'pending',
    summary: 'Awaiting release evidence.',
  }));
  if (gates.length) {
    const gateResult = await service.from('release_gate_results').insert(gates);
    if (gateResult.error) throw gateResult.error;
  }
  await service.from('operational_audit_events').insert({
    environment: input.environment,
    actor_id: c.get('user').id,
    action: 'release.created',
    entity_type: 'system_release',
    entity_id: release.id,
    metadata: { version: input.version, commit_sha: input.commit_sha, migration_version: input.migration_version },
  });
  return c.json(release, 201);
});

phase7.post('/v7/platform/releases/:releaseId/checks', async (c) => {
  return c.json(await runAutomatedReleaseChecks(c.env, c.req.param('releaseId'), c.get('user').id));
});

phase7.put('/v7/platform/releases/:releaseId/gates/:gateKey', async (c) => {
  const { service, admin } = await requirePlatformOperator(c.env, c.get('user').id);
  const gateKey = gateKeySchema.parse(c.req.param('gateKey')) as GateKey;
  const input = await body(c, z.object({
    status: z.enum(['pending', 'passed', 'failed', 'waived']),
    summary: z.string().min(3).max(2000),
    evidence: z.record(z.unknown()).default({}),
    expires_at: z.string().datetime().nullable().optional(),
  }));
  if (input.status === 'waived' && admin.role !== 'super_admin') return c.json({ error: 'Only a super administrator may waive a release gate.' }, 403);
  const { data, error } = await service.from('release_gate_results').upsert({
    release_id: c.req.param('releaseId'),
    gate_key: gateKey,
    status: input.status,
    summary: input.summary,
    evidence: { ...input.evidence, manual: true },
    checked_by: c.get('user').id,
    checked_at: new Date().toISOString(),
    expires_at: input.expires_at ?? null,
  }, { onConflict: 'release_id,gate_key' }).select('*').single();
  if (error) throw error;
  await service.from('operational_audit_events').insert({
    actor_id: c.get('user').id,
    action: `release.gate.${input.status}`,
    entity_type: 'release_gate',
    entity_id: data.id,
    metadata: { release_id: c.req.param('releaseId'), gate_key: gateKey, summary: input.summary },
  });
  return c.json(data);
});

phase7.post('/v7/platform/releases/:releaseId/validate', async (c) => {
  return c.json(await validateRelease(c.env, c.req.param('releaseId'), c.get('user').id));
});

phase7.post('/v7/platform/releases/:releaseId/promote', async (c) => {
  const input = await body(c, z.object({
    confirmation: z.literal('PROMOTE'),
    note: z.string().min(3).max(2000),
  }));
  return c.json(await promoteRelease(c.env, c.req.param('releaseId'), c.get('user').id, input.note));
});

phase7.post('/v7/platform/environments/:environment/rollback', async (c) => {
  const environment = environmentSchema.parse(c.req.param('environment')) as DeploymentEnvironment;
  const input = await body(c, z.object({
    target_release_id: z.string().uuid(),
    confirmation: z.literal('ROLLBACK'),
    reason: z.string().min(3).max(2000),
  }));
  return c.json(await rollbackRelease(c.env, environment, input.target_release_id, c.get('user').id, input.reason));
});

phase7.patch('/v7/platform/environments/:environment/controls', async (c) => {
  const environment = environmentSchema.parse(c.req.param('environment'));
  const { service } = await requirePlatformOperator(c.env, c.get('user').id);
  const input = await body(c, z.object({
    maintenance_mode: z.boolean(),
    writes_paused: z.boolean(),
    generation_paused: z.boolean(),
    publishing_paused: z.boolean(),
    reason: z.string().max(2000).default(''),
    incident_id: z.string().uuid().nullable().optional(),
  }));
  const { data, error } = await service.from('environment_controls').upsert({
    environment,
    ...input,
    incident_id: input.incident_id ?? null,
    updated_by: c.get('user').id,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'environment' }).select('*').single();
  if (error) throw error;
  await service.from('operational_audit_events').insert({
    environment,
    actor_id: c.get('user').id,
    action: 'environment.controls_updated',
    entity_type: 'environment_controls',
    metadata: input,
  });
  return c.json(data);
});

phase7.post('/v7/platform/health-checks', async (c) => {
  const { service } = await requirePlatformOperator(c.env, c.get('user').id);
  const input = await body(c, z.object({
    environment: environmentSchema,
    component: z.enum(['api', 'database', 'web', 'storage', 'ai_provider', 'publishing_provider', 'billing_provider', 'scheduler']),
    status: z.enum(['healthy', 'degraded', 'unhealthy', 'unknown']),
    latency_ms: z.number().int().min(0).max(3_600_000).default(0),
    release_id: z.string().uuid().nullable().optional(),
    source: z.string().min(1).max(120).default('manual'),
    details: z.record(z.unknown()).default({}),
    expires_at: z.string().datetime(),
  }));
  const { data, error } = await service.from('service_health_checks').insert({ ...input, release_id: input.release_id ?? null }).select('*').single();
  if (error) throw error;
  return c.json(data, 201);
});

phase7.post('/v7/platform/incidents', async (c) => {
  const { service } = await requirePlatformOperator(c.env, c.get('user').id);
  const input = await body(c, z.object({
    environment: environmentSchema,
    release_id: z.string().uuid().nullable().optional(),
    severity: z.enum(['sev1', 'sev2', 'sev3', 'sev4']),
    title: z.string().min(3).max(240),
    impact: z.string().max(5000).default(''),
    public_message: z.string().max(5000).default(''),
    apply_control_preset: z.boolean().default(true),
  }));
  const incidentKey = `INC-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
  const { data: incident, error } = await service.from('incidents').insert({
    incident_key: incidentKey,
    environment: input.environment,
    release_id: input.release_id ?? null,
    severity: input.severity,
    title: input.title,
    impact: input.impact,
    public_message: input.public_message,
    owner_id: c.get('user').id,
    created_by: c.get('user').id,
  }).select('*').single();
  if (error) throw error;
  await service.from('incident_events').insert({
    incident_id: incident.id,
    event_type: 'note',
    message: `Incident opened: ${input.title}`,
    actor_id: c.get('user').id,
    metadata: { severity: input.severity, impact: input.impact },
  });
  if (input.apply_control_preset) {
    const preset = incidentControlPreset(input.severity);
    await service.from('environment_controls').upsert({
      environment: input.environment,
      ...preset,
      reason: `${incidentKey}: ${input.title}`,
      incident_id: incident.id,
      updated_by: c.get('user').id,
    }, { onConflict: 'environment' });
  }
  await service.from('operational_audit_events').insert({
    environment: input.environment,
    actor_id: c.get('user').id,
    action: 'incident.created',
    entity_type: 'incident',
    entity_id: incident.id,
    metadata: { incident_key: incidentKey, severity: input.severity, control_preset_applied: input.apply_control_preset },
  });
  return c.json(incident, 201);
});

phase7.patch('/v7/platform/incidents/:incidentId', async (c) => {
  const { service } = await requirePlatformOperator(c.env, c.get('user').id);
  const input = await body(c, z.object({
    status: z.enum(['investigating', 'identified', 'monitoring', 'resolved', 'cancelled']).optional(),
    severity: z.enum(['sev1', 'sev2', 'sev3', 'sev4']).optional(),
    impact: z.string().max(5000).optional(),
    public_message: z.string().max(5000).optional(),
    owner_id: z.string().uuid().nullable().optional(),
  }));
  const update: Record<string, unknown> = { ...input };
  if (input.status === 'resolved') update.resolved_at = new Date().toISOString();
  if (input.status && input.status !== 'resolved') update.resolved_at = null;
  const { data, error } = await service.from('incidents').update(update).eq('id', c.req.param('incidentId')).select('*').single();
  if (error) throw error;
  if (input.status) await service.from('incident_events').insert({ incident_id: data.id, event_type: 'status_change', message: `Incident status changed to ${input.status}.`, actor_id: c.get('user').id, metadata: input });
  return c.json(data);
});

phase7.post('/v7/platform/incidents/:incidentId/events', async (c) => {
  const { service } = await requirePlatformOperator(c.env, c.get('user').id);
  const input = await body(c, z.object({
    event_type: z.enum(['note', 'status_change', 'mitigation', 'customer_update', 'root_cause', 'resolution']),
    message: z.string().min(1).max(5000),
    metadata: z.record(z.unknown()).default({}),
  }));
  const { data, error } = await service.from('incident_events').insert({ ...input, incident_id: c.req.param('incidentId'), actor_id: c.get('user').id }).select('*').single();
  if (error) throw error;
  return c.json(data, 201);
});

phase7.post('/v7/platform/restore-drills', async (c) => {
  const { service } = await requirePlatformOperator(c.env, c.get('user').id);
  const input = await body(c, z.object({
    environment: environmentSchema,
    backup_reference_hash: z.string().min(8).max(256),
    restore_target: z.string().min(3).max(500),
    restore_point: z.string().datetime().nullable().optional(),
  }));
  const { data, error } = await service.from('backup_restore_drills').insert({
    ...input,
    restore_point: input.restore_point ?? null,
    status: 'planned',
    conducted_by: c.get('user').id,
  }).select('*').single();
  if (error) throw error;
  return c.json(data, 201);
});

phase7.patch('/v7/platform/restore-drills/:drillId', async (c) => {
  const { service } = await requirePlatformOperator(c.env, c.get('user').id);
  const input = await body(c, z.object({
    status: z.enum(['planned', 'running', 'passed', 'failed', 'cancelled']),
    recovery_point_minutes: z.number().int().min(0).nullable().optional(),
    recovery_time_minutes: z.number().int().min(0).nullable().optional(),
    checksum_verified: z.boolean().default(false),
    evidence: z.record(z.unknown()).default({}),
    failure_reason: z.string().max(5000).default(''),
  }));
  if (input.status === 'passed' && !input.checksum_verified) return c.json({ error: 'A restore drill cannot pass until its checksum is verified.' }, 409);
  const update: Record<string, unknown> = { ...input };
  if (input.status === 'running') update.started_at = new Date().toISOString();
  if (['passed', 'failed', 'cancelled'].includes(input.status)) update.completed_at = new Date().toISOString();
  const { data, error } = await service.from('backup_restore_drills').update(update).eq('id', c.req.param('drillId')).select('*').single();
  if (error) throw error;
  await service.from('operational_audit_events').insert({ environment: data.environment, actor_id: c.get('user').id, action: `restore_drill.${input.status}`, entity_type: 'backup_restore_drill', entity_id: data.id, metadata: input });
  return c.json(data);
});

export default phase7;
