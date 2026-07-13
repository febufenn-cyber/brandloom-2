import { createServiceClient } from './db';
import {
  evaluateReleaseReadiness,
  requiredReleaseGates,
  runtimeConfigReady,
  validateRuntimeConfig,
  type DeploymentEnvironment,
  type GateKey,
  type GateStatus,
} from './reliability';
import type { Env } from './types';

type Row = Record<string, any>;
type ServiceClient = ReturnType<typeof createServiceClient>;

const nowIso = () => new Date().toISOString();
const addMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const addDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

export async function requirePlatformOperator(env: Env, userId: string, readOnly = false) {
  const service = createServiceClient(env);
  const { data, error } = await service.from('platform_admins').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  const allowed = readOnly
    ? ['support', 'billing', 'operations', 'super_admin']
    : ['operations', 'super_admin'];
  if (!data || !allowed.includes(String(data.role))) throw new Error(readOnly ? 'Platform administrator access is required.' : 'Platform operations access is required.');
  return { service, admin: data as Row };
}

async function audit(service: ServiceClient, input: {
  environment?: string | null;
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  traceId?: string;
  metadata?: Record<string, unknown>;
}) {
  const { error } = await service.from('operational_audit_events').insert({
    environment: input.environment ?? null,
    actor_id: input.actorId ?? null,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    trace_id: input.traceId ?? '',
    metadata: input.metadata ?? {},
  });
  if (error) throw error;
}

export async function publicReadiness(env: Env) {
  const started = Date.now();
  const environment = env.DEPLOYMENT_ENVIRONMENT ?? 'local';
  const checks = validateRuntimeConfig(env);
  let database: { status: 'healthy' | 'unhealthy'; latency_ms: number; message: string };
  let control: Row | null = null;
  let activeRelease: Row | null = null;

  try {
    const service = createServiceClient(env);
    const [environmentResult, controlResult] = await Promise.all([
      service.from('deployment_environments').select('name,active_release_id').eq('name', environment).maybeSingle(),
      service.from('environment_controls').select('*').eq('environment', environment).maybeSingle(),
    ]);
    if (environmentResult.error) throw environmentResult.error;
    if (controlResult.error) throw controlResult.error;
    control = controlResult.data as Row | null;
    if (environmentResult.data?.active_release_id) {
      const releaseResult = await service.from('system_releases').select('id,version,commit_sha,migration_version,status,promoted_at').eq('id', environmentResult.data.active_release_id).maybeSingle();
      if (releaseResult.error) throw releaseResult.error;
      activeRelease = releaseResult.data as Row | null;
    }
    database = { status: 'healthy', latency_ms: Date.now() - started, message: 'Control-plane database query succeeded.' };
  } catch (reason) {
    database = { status: 'unhealthy', latency_ms: Date.now() - started, message: reason instanceof Error ? reason.message : String(reason) };
  }

  const configured = runtimeConfigReady(env);
  const releaseReady = environment === 'local' || Boolean(activeRelease?.status === 'active');
  const controlsReady = !control?.maintenance_mode;
  const ready = configured && database.status === 'healthy' && releaseReady && controlsReady;
  return {
    ok: ready,
    service: 'brandloom-api',
    environment,
    version: env.APP_VERSION ?? 'unconfigured',
    commit_sha: env.COMMIT_SHA ?? 'unconfigured',
    expected_migration_version: env.EXPECTED_MIGRATION_VERSION ?? 'unconfigured',
    provider_modes: {
      publishing: env.PUBLISHING_PROVIDER_MODE ?? 'mock',
      billing: env.BILLING_PROVIDER_MODE ?? 'mock',
    },
    database,
    active_release: activeRelease,
    maintenance_mode: Boolean(control?.maintenance_mode),
    configuration: checks,
  };
}

export async function reliabilityDashboard(env: Env, userId: string) {
  const { service, admin } = await requirePlatformOperator(env, userId, true);
  const [environments, releases, gates, controls, health, incidents, incidentEvents, drills, transitions, auditEvents] = await Promise.all([
    service.from('deployment_environments').select('*').order('name'),
    service.from('system_releases').select('*').order('created_at', { ascending: false }).limit(60),
    service.from('release_gate_results').select('*').order('updated_at', { ascending: false }).limit(300),
    service.from('environment_controls').select('*').order('environment'),
    service.from('service_health_checks').select('*').order('checked_at', { ascending: false }).limit(120),
    service.from('incidents').select('*').order('started_at', { ascending: false }).limit(50),
    service.from('incident_events').select('*').order('created_at', { ascending: false }).limit(200),
    service.from('backup_restore_drills').select('*').order('created_at', { ascending: false }).limit(50),
    service.from('release_transitions').select('*').order('created_at', { ascending: false }).limit(100),
    service.from('operational_audit_events').select('*').order('created_at', { ascending: false }).limit(150),
  ]);
  for (const result of [environments, releases, gates, controls, health, incidents, incidentEvents, drills, transitions, auditEvents]) if (result.error) throw result.error;

  const releaseRows = (releases.data ?? []) as Row[];
  const gateRows = (gates.data ?? []) as Row[];
  const releasesWithReadiness = releaseRows.map((release) => ({
    ...release,
    readiness: evaluateReleaseReadiness(
      release.environment as DeploymentEnvironment,
      gateRows.filter((gate) => gate.release_id === release.id),
    ),
  }));

  return {
    admin,
    runtime: await publicReadiness(env),
    environments: environments.data ?? [],
    releases: releasesWithReadiness,
    gates: gateRows,
    controls: controls.data ?? [],
    health: health.data ?? [],
    incidents: incidents.data ?? [],
    incident_events: incidentEvents.data ?? [],
    restore_drills: drills.data ?? [],
    transitions: transitions.data ?? [],
    audit_events: auditEvents.data ?? [],
  };
}

async function upsertGate(service: ServiceClient, input: {
  releaseId: string;
  gateKey: GateKey;
  status: GateStatus;
  summary: string;
  evidence: Record<string, unknown>;
  actorId: string;
  expiresAt?: string | null;
}) {
  const { data, error } = await service.from('release_gate_results').upsert({
    release_id: input.releaseId,
    gate_key: input.gateKey,
    status: input.status,
    summary: input.summary,
    evidence: input.evidence,
    checked_by: input.actorId,
    checked_at: nowIso(),
    expires_at: input.expiresAt ?? null,
  }, { onConflict: 'release_id,gate_key' }).select('*').single();
  if (error) throw error;
  return data as Row;
}

export async function runAutomatedReleaseChecks(env: Env, releaseId: string, userId: string) {
  const { service } = await requirePlatformOperator(env, userId);
  const { data: release, error: releaseError } = await service.from('system_releases').select('*').eq('id', releaseId).single();
  if (releaseError) throw releaseError;
  const environment = release.environment as DeploymentEnvironment;
  await service.from('system_releases').update({ status: 'checking' }).eq('id', releaseId).in('status', ['draft', 'checking', 'failed']);

  const configChecks = validateRuntimeConfig({ ...env, DEPLOYMENT_ENVIRONMENT: environment });
  const configFailures = configChecks.filter((check) => check.status === 'failed');
  const migrationMatches = env.EXPECTED_MIGRATION_VERSION === release.migration_version;
  const providerReady = environment !== 'production' || (env.PUBLISHING_PROVIDER_MODE === 'meta' && env.BILLING_PROVIDER_MODE === 'stripe');

  const databaseStarted = Date.now();
  const databaseResult = await service.from('deployment_environments').select('name,active_release_id').eq('name', environment).single();
  const databaseHealthy = !databaseResult.error;
  const activeReleaseId = databaseResult.data?.active_release_id as string | null | undefined;

  const drillResult = await service.from('backup_restore_drills').select('*')
    .eq('environment', environment).eq('status', 'passed').eq('checksum_verified', true)
    .order('completed_at', { ascending: false }).limit(1).maybeSingle();
  if (drillResult.error) throw drillResult.error;
  const recentDrill = drillResult.data as Row | null;
  const drillCurrent = Boolean(recentDrill?.completed_at && new Date(recentDrill.completed_at).getTime() > Date.now() - 30 * 86_400_000);

  const healthResult = await service.from('service_health_checks').select('*')
    .eq('environment', environment).gt('expires_at', nowIso()).order('checked_at', { ascending: false });
  if (healthResult.error) throw healthResult.error;
  const latestHealth = new Map<string, Row>();
  for (const row of (healthResult.data ?? []) as Row[]) if (!latestHealth.has(String(row.component))) latestHealth.set(String(row.component), row);
  const requiredComponents = environment === 'production' ? ['api', 'database', 'web', 'scheduler'] : ['api', 'database', 'scheduler'];
  const observabilityReady = requiredComponents.every((component) => latestHealth.get(component)?.status === 'healthy');
  const rollbackReady = environment === 'local' || Boolean(activeReleaseId || release.metadata?.rollback_plan_confirmed);
  const securityReviewed = environment !== 'production' || Boolean(release.metadata?.security_reviewed);

  const results = await Promise.all([
    upsertGate(service, { releaseId, gateKey: 'migration_verified', status: migrationMatches ? 'passed' : 'failed', summary: migrationMatches ? `Migration ${release.migration_version} matches the configured target.` : 'Configured and release migration versions differ.', evidence: { expected: env.EXPECTED_MIGRATION_VERSION ?? null, release: release.migration_version }, actorId: userId }),
    upsertGate(service, { releaseId, gateKey: 'secrets_verified', status: configFailures.length ? 'failed' : 'passed', summary: configFailures.length ? `${configFailures.length} required configuration values are missing or unsafe.` : 'Required runtime configuration is present.', evidence: { checks: configChecks }, actorId: userId, expiresAt: addDays(1) }),
    upsertGate(service, { releaseId, gateKey: 'database_health', status: databaseHealthy ? 'passed' : 'failed', summary: databaseHealthy ? 'Control-plane database query succeeded.' : 'Control-plane database query failed.', evidence: { latency_ms: Date.now() - databaseStarted, error: databaseResult.error?.message ?? null }, actorId: userId, expiresAt: addMinutes(15) }),
    upsertGate(service, { releaseId, gateKey: 'provider_readiness', status: providerReady ? 'passed' : 'failed', summary: providerReady ? 'Provider modes are valid for this environment.' : 'Production still uses one or more mock providers.', evidence: { publishing: env.PUBLISHING_PROVIDER_MODE ?? 'mock', billing: env.BILLING_PROVIDER_MODE ?? 'mock' }, actorId: userId, expiresAt: addDays(1) }),
    upsertGate(service, { releaseId, gateKey: 'backup_restore_verified', status: drillCurrent ? 'passed' : 'pending', summary: drillCurrent ? 'A checksum-verified restore drill passed within 30 days.' : 'No current successful restore drill is recorded.', evidence: { drill_id: recentDrill?.id ?? null, completed_at: recentDrill?.completed_at ?? null }, actorId: userId, expiresAt: recentDrill?.completed_at ? new Date(new Date(recentDrill.completed_at).getTime() + 30 * 86_400_000).toISOString() : null }),
    upsertGate(service, { releaseId, gateKey: 'rollback_ready', status: rollbackReady ? 'passed' : 'pending', summary: rollbackReady ? 'A prior active release or an explicit rollback plan is available.' : 'Record and verify a rollback plan before promotion.', evidence: { active_release_id: activeReleaseId ?? null, rollback_plan_confirmed: Boolean(release.metadata?.rollback_plan_confirmed) }, actorId: userId, expiresAt: addDays(1) }),
    upsertGate(service, { releaseId, gateKey: 'observability_ready', status: observabilityReady ? 'passed' : 'pending', summary: observabilityReady ? 'Required components have current healthy checks.' : 'One or more required component checks are missing, stale or unhealthy.', evidence: { required_components: requiredComponents, latest: Object.fromEntries(latestHealth) }, actorId: userId, expiresAt: addMinutes(15) }),
    upsertGate(service, { releaseId, gateKey: 'security_review', status: securityReviewed ? 'passed' : 'pending', summary: securityReviewed ? 'Security review is recorded for this release.' : 'Production security review must be explicitly recorded.', evidence: { security_reviewed: Boolean(release.metadata?.security_reviewed) }, actorId: userId }),
  ]);

  const readiness = evaluateReleaseReadiness(environment, results);
  await audit(service, { environment, actorId: userId, action: 'release.checks_run', entityType: 'system_release', entityId: releaseId, metadata: { readiness } });
  return { release, results, readiness };
}

export async function validateRelease(env: Env, releaseId: string, userId: string) {
  const { service } = await requirePlatformOperator(env, userId);
  const { data, error } = await service.rpc('validate_system_release', { p_release_id: releaseId, p_actor: userId });
  if (error) throw error;
  return data;
}

export async function promoteRelease(env: Env, releaseId: string, userId: string, note: string) {
  const { service } = await requirePlatformOperator(env, userId);
  const { data, error } = await service.rpc('promote_system_release', { p_release_id: releaseId, p_actor: userId, p_note: note });
  if (error) throw error;
  return { release_id: data };
}

export async function rollbackRelease(env: Env, environment: DeploymentEnvironment, targetReleaseId: string, userId: string, reason: string) {
  const { service } = await requirePlatformOperator(env, userId);
  const { data, error } = await service.rpc('rollback_environment_release', {
    p_environment: environment,
    p_target_release_id: targetReleaseId,
    p_actor: userId,
    p_reason: reason,
  });
  if (error) throw error;
  return { release_id: data };
}

export async function reliabilityHousekeeping(env: Env) {
  const environment = env.DEPLOYMENT_ENVIRONMENT ?? 'local';
  const service = createServiceClient(env);
  const latestResult = await service.from('service_health_checks').select('checked_at')
    .eq('environment', environment).eq('component', 'scheduler').order('checked_at', { ascending: false }).limit(1).maybeSingle();
  if (latestResult.error) throw latestResult.error;
  if (latestResult.data?.checked_at && new Date(latestResult.data.checked_at).getTime() > Date.now() - 5 * 60_000) return { recorded: false };

  const started = Date.now();
  const databaseResult = await service.from('deployment_environments').select('active_release_id').eq('name', environment).maybeSingle();
  const healthy = !databaseResult.error;
  const rows = [
    { environment, component: 'scheduler', status: 'healthy', latency_ms: 0, release_id: databaseResult.data?.active_release_id ?? null, source: 'cron', details: { cadence: 'five_minutes' }, expires_at: addMinutes(10) },
    { environment, component: 'database', status: healthy ? 'healthy' : 'unhealthy', latency_ms: Date.now() - started, release_id: databaseResult.data?.active_release_id ?? null, source: 'cron', details: { error: databaseResult.error?.message ?? null }, expires_at: addMinutes(10) },
    { environment, component: 'api', status: healthy ? 'healthy' : 'degraded', latency_ms: Date.now() - started, release_id: databaseResult.data?.active_release_id ?? null, source: 'cron', details: { version: env.APP_VERSION ?? null, commit_sha: env.COMMIT_SHA ?? null }, expires_at: addMinutes(10) },
  ];
  const { error } = await service.from('service_health_checks').insert(rows);
  if (error) throw error;
  return { recorded: true, components: rows.map((row) => row.component) };
}

export function requiredGateKeys(environment: DeploymentEnvironment) {
  return requiredReleaseGates(environment);
}
