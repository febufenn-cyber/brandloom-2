import type { Env } from './types';

export type DeploymentEnvironment = 'local' | 'staging' | 'production';
export type GateKey =
  | 'migration_verified'
  | 'secrets_verified'
  | 'database_health'
  | 'provider_readiness'
  | 'backup_restore_verified'
  | 'rollback_ready'
  | 'observability_ready'
  | 'security_review';
export type GateStatus = 'pending' | 'passed' | 'failed' | 'waived';

export const ALL_RELEASE_GATES: GateKey[] = [
  'migration_verified',
  'secrets_verified',
  'database_health',
  'provider_readiness',
  'backup_restore_verified',
  'rollback_ready',
  'observability_ready',
  'security_review',
];

export function requiredReleaseGates(environment: DeploymentEnvironment): GateKey[] {
  if (environment === 'production') return [...ALL_RELEASE_GATES];
  if (environment === 'staging') return [
    'migration_verified',
    'secrets_verified',
    'database_health',
    'provider_readiness',
    'rollback_ready',
    'observability_ready',
  ];
  return ['migration_verified', 'secrets_verified', 'database_health'];
}

export type ReleaseGate = {
  gate_key: GateKey;
  status: GateStatus;
  expires_at?: string | null;
  summary?: string;
};

export function gateIsCurrent(gate: ReleaseGate, now = new Date()) {
  if (!['passed', 'waived'].includes(gate.status)) return false;
  if (!gate.expires_at) return true;
  return new Date(gate.expires_at).getTime() > now.getTime();
}

export function evaluateReleaseReadiness(
  environment: DeploymentEnvironment,
  gates: ReleaseGate[],
  now = new Date(),
) {
  const required = requiredReleaseGates(environment);
  const byKey = new Map(gates.map((gate) => [gate.gate_key, gate]));
  const results = required.map((gateKey) => {
    const gate = byKey.get(gateKey);
    const current = gate ? gateIsCurrent(gate, now) : false;
    return {
      gate_key: gateKey,
      status: gate?.status ?? 'pending',
      current,
      expired: Boolean(gate?.expires_at && new Date(gate.expires_at).getTime() <= now.getTime()),
      summary: gate?.summary ?? '',
    };
  });
  return {
    environment,
    required: required.length,
    passed: results.filter((item) => item.current).length,
    failed: results.filter((item) => item.status === 'failed').length,
    pending: results.filter((item) => !item.current && item.status !== 'failed').length,
    ready: results.every((item) => item.current),
    gates: results,
  };
}

export type RuntimeConfigCheck = {
  key: string;
  status: 'passed' | 'failed' | 'warning';
  message: string;
};

function configured(value: string | undefined) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateRuntimeConfig(env: Env): RuntimeConfigCheck[] {
  const environment = env.DEPLOYMENT_ENVIRONMENT ?? 'local';
  const checks: RuntimeConfigCheck[] = [];
  const requireValue = (key: string, value: string | undefined) => {
    checks.push({ key, status: configured(value) ? 'passed' : 'failed', message: configured(value) ? 'Configured.' : 'Missing required configuration.' });
  };

  requireValue('SUPABASE_URL', env.SUPABASE_URL);
  requireValue('SUPABASE_ANON_KEY', env.SUPABASE_ANON_KEY);
  requireValue('SUPABASE_SERVICE_ROLE_KEY', env.SUPABASE_SERVICE_ROLE_KEY);
  requireValue('WEB_ORIGIN', env.WEB_ORIGIN);
  requireValue('APP_VERSION', env.APP_VERSION);
  requireValue('COMMIT_SHA', env.COMMIT_SHA);
  requireValue('EXPECTED_MIGRATION_VERSION', env.EXPECTED_MIGRATION_VERSION);

  if (environment !== 'local') {
    requireValue('CRON_SECRET', env.CRON_SECRET);
    requireValue('TOKEN_ENCRYPTION_KEY', env.TOKEN_ENCRYPTION_KEY);
    requireValue('ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY);
    requireValue('ANTHROPIC_MODEL', env.ANTHROPIC_MODEL);
  }

  if (environment === 'production') {
    const publishingReady = env.PUBLISHING_PROVIDER_MODE === 'meta';
    const billingReady = env.BILLING_PROVIDER_MODE === 'stripe';
    checks.push({ key: 'PUBLISHING_PROVIDER_MODE', status: publishingReady ? 'passed' : 'failed', message: publishingReady ? 'Meta publishing is selected.' : 'Production must not use the mock publishing provider.' });
    checks.push({ key: 'BILLING_PROVIDER_MODE', status: billingReady ? 'passed' : 'failed', message: billingReady ? 'Stripe billing is selected.' : 'Production must not use mock billing.' });
    requireValue('META_APP_ID', env.META_APP_ID);
    requireValue('META_APP_SECRET', env.META_APP_SECRET);
    requireValue('META_WEBHOOK_VERIFY_TOKEN', env.META_WEBHOOK_VERIFY_TOKEN);
    requireValue('STRIPE_SECRET_KEY', env.STRIPE_SECRET_KEY);
    requireValue('STRIPE_WEBHOOK_SECRET', env.STRIPE_WEBHOOK_SECRET);
  } else {
    checks.push({ key: 'PROVIDER_MODE', status: 'warning', message: 'Mock providers are acceptable outside production, but provider capability tests are still required before promotion.' });
  }

  return checks;
}

export function runtimeConfigReady(env: Env) {
  return validateRuntimeConfig(env).every((check) => check.status !== 'failed');
}

export type RequestRisk = 'read' | 'write' | 'generation' | 'publishing' | 'control_plane';

export function classifyRequestRisk(method: string, path: string): RequestRisk {
  const normalized = method.toUpperCase();
  if (path.startsWith('/api/v7/platform/')) return 'control_plane';
  if (normalized === 'GET' || normalized === 'HEAD' || normalized === 'OPTIONS') return 'read';
  if (/\/(generate|regenerate)(?:\/|$)/.test(path) || path.includes('/brief/generate')) return 'generation';
  if (path.includes('/publication') || path.includes('/publishing') || path.includes('/schedule')) return 'publishing';
  return 'write';
}

export function controlReason(input: {
  maintenance_mode?: boolean;
  writes_paused?: boolean;
  generation_paused?: boolean;
  publishing_paused?: boolean;
  reason?: string;
}, risk: RequestRisk) {
  if (risk === 'read' || risk === 'control_plane') return null;
  if (input.maintenance_mode) return input.reason || 'The environment is in maintenance mode.';
  if (input.writes_paused) return input.reason || 'Writes are temporarily paused.';
  if (risk === 'generation' && input.generation_paused) return input.reason || 'AI generation is temporarily paused.';
  if (risk === 'publishing' && input.publishing_paused) return input.reason || 'Publishing is temporarily paused.';
  return null;
}

export function incidentControlPreset(severity: 'sev1' | 'sev2' | 'sev3' | 'sev4') {
  if (severity === 'sev1') return { maintenance_mode: true, writes_paused: true, generation_paused: true, publishing_paused: true };
  if (severity === 'sev2') return { maintenance_mode: false, writes_paused: false, generation_paused: true, publishing_paused: true };
  if (severity === 'sev3') return { maintenance_mode: false, writes_paused: false, generation_paused: false, publishing_paused: true };
  return { maintenance_mode: false, writes_paused: false, generation_paused: false, publishing_paused: false };
}
