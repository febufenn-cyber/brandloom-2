import { createServiceClient } from './db';
import {
  activationConfiguration,
  activationExpiry,
  evaluateActivation,
  stripeModeMatchesEnvironment,
  type ActivationComponent,
  type ActivationEnvironment,
  type ActivationEvidence,
  type ActivationStatus,
} from './activation';
import { requirePlatformOperator } from './reliabilityService';
import type { Env } from './types';

type ServiceClient = ReturnType<typeof createServiceClient>;
type CheckDraft = {
  component: ActivationComponent;
  status: ActivationStatus;
  summary: string;
  evidence: Record<string, unknown>;
  expiresAt?: string | null;
};

function safeError(reason: unknown) {
  return reason instanceof Error ? reason.message.slice(0, 500) : String(reason).slice(0, 500);
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function activationFingerprint(env: Env, environment: ActivationEnvironment) {
  return sha256(JSON.stringify({
    environment,
    web_origin: env.WEB_ORIGIN ?? '',
    api_origin: env.PUBLIC_API_ORIGIN ?? '',
    publishing_mode: env.PUBLISHING_PROVIDER_MODE ?? 'mock',
    billing_mode: env.BILLING_PROVIDER_MODE ?? 'mock',
    meta_app_id: env.META_APP_ID ?? '',
    meta_redirect_uri: env.META_REDIRECT_URI ?? '',
    stripe_api_version: env.STRIPE_API_VERSION ?? '',
    anthropic_model: env.ANTHROPIC_MODEL ?? '',
    migration: env.EXPECTED_MIGRATION_VERSION ?? '',
  }));
}

async function httpProbe(url: string | undefined, label: string): Promise<CheckDraft> {
  if (!url) return { component: label === 'web' ? 'web' : 'worker', status: 'failed', summary: `${label} URL is not configured.`, evidence: {} };
  const started = Date.now();
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': 'Brandloom-Activation-Probe/1.0' } });
    return {
      component: label === 'web' ? 'web' : 'worker',
      status: response.ok ? 'passed' : 'failed',
      summary: response.ok ? `${label} endpoint responded successfully.` : `${label} endpoint returned HTTP ${response.status}.`,
      evidence: { status: response.status, latency_ms: Date.now() - started, final_origin: new URL(response.url || url).origin },
      expiresAt: activationExpiry(15),
    };
  } catch (reason) {
    return { component: label === 'web' ? 'web' : 'worker', status: 'failed', summary: `${label} endpoint could not be reached.`, evidence: { latency_ms: Date.now() - started, safe_error: safeError(reason) }, expiresAt: activationExpiry(15) };
  }
}

async function databaseProbe(service: ServiceClient, environment: ActivationEnvironment): Promise<CheckDraft> {
  const started = Date.now();
  const { data, error } = await service.from('deployment_environments').select('name,active_release_id').eq('name', environment).maybeSingle();
  return {
    component: 'database',
    status: error || !data ? 'failed' : 'passed',
    summary: error || !data ? 'Deployment database query failed.' : 'Deployment database and environment record are reachable.',
    evidence: { latency_ms: Date.now() - started, environment_found: Boolean(data), active_release_id: data?.active_release_id ?? null, safe_error: error?.message ?? null },
    expiresAt: activationExpiry(15),
  };
}

async function storageProbe(service: ServiceClient): Promise<CheckDraft> {
  const started = Date.now();
  try {
    const { data, error } = await service.storage.listBuckets();
    if (error) throw error;
    const names = (data ?? []).map((bucket) => bucket.name);
    const required = ['brand-assets'];
    const missing = required.filter((name) => !names.includes(name));
    return {
      component: 'storage',
      status: missing.length ? 'failed' : 'passed',
      summary: missing.length ? `Required storage buckets are missing: ${missing.join(', ')}.` : 'Required private storage buckets are available.',
      evidence: { latency_ms: Date.now() - started, required, available_count: names.length, missing },
      expiresAt: activationExpiry(60),
    };
  } catch (reason) {
    return { component: 'storage', status: 'failed', summary: 'Storage service could not be verified.', evidence: { latency_ms: Date.now() - started, safe_error: safeError(reason) }, expiresAt: activationExpiry(15) };
  }
}

async function aiProbe(env: Env): Promise<CheckDraft> {
  if (!env.ANTHROPIC_API_KEY) return { component: 'ai_provider', status: 'failed', summary: 'Anthropic API key is not configured.', evidence: {} };
  const started = Date.now();
  try {
    const response = await fetch(`${(env.ANTHROPIC_API_BASE ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/models?limit=1`, {
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': env.ANTHROPIC_API_VERSION ?? '2023-06-01' },
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    return {
      component: 'ai_provider',
      status: response.ok ? 'passed' : 'failed',
      summary: response.ok ? 'Anthropic credentials can list available models.' : `Anthropic credential verification failed with HTTP ${response.status}.`,
      evidence: { latency_ms: Date.now() - started, status: response.status, has_models: Array.isArray(payload.data), request_id: response.headers.get('request-id') },
      expiresAt: activationExpiry(60),
    };
  } catch (reason) {
    return { component: 'ai_provider', status: 'failed', summary: 'Anthropic could not be reached.', evidence: { latency_ms: Date.now() - started, safe_error: safeError(reason) }, expiresAt: activationExpiry(15) };
  }
}

async function stripeProbe(env: Env, environment: ActivationEnvironment): Promise<CheckDraft> {
  if (env.BILLING_PROVIDER_MODE !== 'stripe' || !env.STRIPE_SECRET_KEY) return { component: 'billing_provider', status: 'failed', summary: 'Stripe billing mode and credentials are required.', evidence: { mode: env.BILLING_PROVIDER_MODE ?? 'mock' } };
  if (!stripeModeMatchesEnvironment(env.STRIPE_SECRET_KEY, environment)) return { component: 'billing_provider', status: 'failed', summary: `Stripe key mode does not match ${environment}.`, evidence: { expected: environment === 'production' ? 'live' : 'test' } };
  const started = Date.now();
  try {
    const response = await fetch(`${env.STRIPE_API_BASE ?? 'https://api.stripe.com'}/v1/account`, {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, ...(env.STRIPE_API_VERSION ? { 'Stripe-Version': env.STRIPE_API_VERSION } : {}) },
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    const modeMatches = environment === 'production' ? payload.livemode === true : payload.livemode === false;
    const ready = response.ok && modeMatches && Boolean(payload.id);
    return {
      component: 'billing_provider', status: ready ? 'passed' : 'failed',
      summary: ready ? 'Stripe account credentials and environment mode were verified.' : 'Stripe account verification or mode validation failed.',
      evidence: { latency_ms: Date.now() - started, status: response.status, account_id: typeof payload.id === 'string' ? payload.id : null, livemode: payload.livemode ?? null, charges_enabled: payload.charges_enabled ?? null, details_submitted: payload.details_submitted ?? null },
      expiresAt: activationExpiry(60),
    };
  } catch (reason) {
    return { component: 'billing_provider', status: 'failed', summary: 'Stripe could not be reached.', evidence: { latency_ms: Date.now() - started, safe_error: safeError(reason) }, expiresAt: activationExpiry(15) };
  }
}

async function publishingProbe(service: ServiceClient, env: Env): Promise<CheckDraft> {
  const configured = env.PUBLISHING_PROVIDER_MODE === 'meta' && Boolean(env.META_APP_ID && env.META_APP_SECRET && env.META_REDIRECT_URI && env.META_WEBHOOK_VERIFY_TOKEN);
  if (!configured) return { component: 'publishing_provider', status: 'failed', summary: 'Meta publishing configuration is incomplete or mock mode is active.', evidence: { mode: env.PUBLISHING_PROVIDER_MODE ?? 'mock' } };
  const { data, error } = await service.from('platform_connections').select('id,status,last_validated_at').in('status', ['connected', 'healthy']).order('last_validated_at', { ascending: false }).limit(20);
  const connections = data ?? [];
  const healthy = connections.some((connection) => connection.status === 'healthy' && connection.last_validated_at);
  return {
    component: 'publishing_provider',
    status: !error && healthy ? 'passed' : 'failed',
    summary: !error && healthy ? 'At least one recently validated Meta connection is healthy.' : 'No healthy validated Meta publishing connection is available.',
    evidence: { healthy_connections: connections.filter((connection) => connection.status === 'healthy').length, candidate_connections: connections.length, safe_error: error?.message ?? null },
    expiresAt: activationExpiry(60),
  };
}

function webhookProbe(env: Env): CheckDraft {
  const apiOrigin = env.PUBLIC_API_ORIGIN ?? '';
  const ready = apiOrigin.startsWith('https://') && Boolean(env.META_WEBHOOK_VERIFY_TOKEN && env.META_APP_SECRET && env.STRIPE_WEBHOOK_SECRET);
  return {
    component: 'webhooks', status: ready ? 'passed' : 'failed',
    summary: ready ? 'Webhook origins and verification secrets are configured.' : 'Webhook origin or verification secrets are incomplete.',
    evidence: { meta_path: `${apiOrigin}/webhooks/meta`, stripe_path: `${apiOrigin}/webhooks/stripe`, https: apiOrigin.startsWith('https://') },
    expiresAt: activationExpiry(24 * 60),
  };
}

async function recordChecks(service: ServiceClient, environment: ActivationEnvironment, runId: string, userId: string, checks: CheckDraft[]) {
  const rows = checks.map((check) => ({
    environment,
    activation_run_id: runId,
    component: check.component,
    status: check.status,
    summary: check.summary,
    evidence: check.evidence,
    checked_by: userId,
    checked_at: new Date().toISOString(),
    expires_at: check.expiresAt ?? null,
  }));
  const { data, error } = await service.from('provider_activation_checks').insert(rows).select('*');
  if (error) throw error;
  return data ?? [];
}

export async function activationDashboard(env: Env, userId: string) {
  const { service, admin } = await requirePlatformOperator(env, userId, true);
  const [profiles, checks, runs] = await Promise.all([
    service.from('provider_activation_profiles').select('*').order('environment'),
    service.from('provider_activation_checks').select('*').order('checked_at', { ascending: false }).limit(240),
    service.from('deployment_verification_runs').select('*').order('started_at', { ascending: false }).limit(50),
  ]);
  for (const result of [profiles, checks, runs]) if (result.error) throw result.error;
  const evidence = (checks.data ?? []) as ActivationEvidence[];
  return {
    admin,
    profiles: profiles.data ?? [],
    checks: evidence,
    runs: runs.data ?? [],
    staging: evaluateActivation('staging', evidence.filter((item: any) => item.environment === 'staging')),
    production: evaluateActivation('production', evidence.filter((item: any) => item.environment === 'production')),
    configuration: {
      staging: activationConfiguration(env, 'staging'),
      production: activationConfiguration(env, 'production'),
    },
  };
}

export async function runActivationVerification(env: Env, environment: ActivationEnvironment, userId: string, source: 'operator' | 'workflow' | 'scheduled' = 'operator') {
  const { service } = await requirePlatformOperator(env, userId);
  const releaseResult = await service.from('deployment_environments').select('active_release_id').eq('name', environment).single();
  if (releaseResult.error) throw releaseResult.error;
  const { data: run, error: runError } = await service.from('deployment_verification_runs').insert({
    environment,
    release_id: releaseResult.data.active_release_id,
    status: 'running',
    source,
    commit_sha: env.COMMIT_SHA ?? '',
    started_by: userId,
  }).select('*').single();
  if (runError) throw runError;

  try {
    const apiUrl = env.PUBLIC_API_ORIGIN ? `${env.PUBLIC_API_ORIGIN.replace(/\/$/, '')}/health/ready` : undefined;
    const checks = await Promise.all([
      databaseProbe(service, environment),
      httpProbe(env.WEB_ORIGIN, 'web'),
      httpProbe(apiUrl, 'worker'),
      storageProbe(service),
      aiProbe(env),
      publishingProbe(service, env),
      stripeProbe(env, environment),
      Promise.resolve(webhookProbe(env)),
    ]);
    const recorded = await recordChecks(service, environment, run.id, userId, checks);
    const readiness = evaluateActivation(environment, recorded as ActivationEvidence[]);
    const fingerprint = await activationFingerprint(env, environment);
    const { error: profileError } = await service.from('provider_activation_profiles').upsert({
      environment,
      status: readiness.ready ? 'ready' : 'blocked',
      release_id: releaseResult.data.active_release_id,
      configuration_fingerprint: fingerprint,
      last_checked_at: new Date().toISOString(),
      metadata: { readiness },
    }, { onConflict: 'environment' });
    if (profileError) throw profileError;
    await service.from('deployment_verification_runs').update({
      status: readiness.ready ? 'passed' : 'failed', result: readiness,
      artifact_checksum: fingerprint, completed_at: new Date().toISOString(),
    }).eq('id', run.id);
    return { run_id: run.id, fingerprint, readiness, checks: recorded };
  } catch (reason) {
    await service.from('deployment_verification_runs').update({ status: 'failed', safe_error: safeError(reason), completed_at: new Date().toISOString() }).eq('id', run.id);
    throw reason;
  }
}

export async function activateEnvironment(env: Env, environment: ActivationEnvironment, userId: string, confirmation: string) {
  if (confirmation !== `ACTIVATE ${environment.toUpperCase()}`) throw new Error(`Type ACTIVATE ${environment.toUpperCase()} to confirm.`);
  const { service } = await requirePlatformOperator(env, userId);
  const fingerprint = await activationFingerprint(env, environment);
  const { data, error } = await service.rpc('activate_provider_environment', {
    p_environment: environment,
    p_actor: userId,
    p_configuration_fingerprint: fingerprint,
    p_metadata: { provider_modes: { publishing: env.PUBLISHING_PROVIDER_MODE ?? 'mock', billing: env.BILLING_PROVIDER_MODE ?? 'mock' } },
  });
  if (error) throw error;
  return data;
}
