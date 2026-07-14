import type { Env } from './types';

export type ActivationEnvironment = 'staging' | 'production';
export type ActivationComponent =
  | 'database'
  | 'web'
  | 'worker'
  | 'storage'
  | 'ai_provider'
  | 'publishing_provider'
  | 'billing_provider'
  | 'webhooks';
export type ActivationStatus = 'pending' | 'passed' | 'failed' | 'waived';

export type ActivationEvidence = {
  component: ActivationComponent;
  status: ActivationStatus;
  checked_at: string;
  expires_at?: string | null;
  summary?: string;
};

const COMMON_COMPONENTS: ActivationComponent[] = [
  'database',
  'web',
  'worker',
  'storage',
  'ai_provider',
  'publishing_provider',
  'billing_provider',
  'webhooks',
];

export function requiredActivationComponents(_environment: ActivationEnvironment) {
  return [...COMMON_COMPONENTS];
}

export function evidenceIsCurrent(evidence: ActivationEvidence, now = new Date()) {
  if (!['passed', 'waived'].includes(evidence.status)) return false;
  if (!evidence.expires_at) return true;
  const expiry = new Date(evidence.expires_at).getTime();
  return Number.isFinite(expiry) && expiry > now.getTime();
}

export function evaluateActivation(
  environment: ActivationEnvironment,
  evidence: ActivationEvidence[],
  now = new Date(),
) {
  const required = requiredActivationComponents(environment);
  const latest = new Map<ActivationComponent, ActivationEvidence>();
  for (const item of evidence) {
    if (!required.includes(item.component)) continue;
    const existing = latest.get(item.component);
    if (!existing || new Date(item.checked_at).getTime() > new Date(existing.checked_at).getTime()) latest.set(item.component, item);
  }
  const components = required.map((component) => {
    const item = latest.get(component);
    return {
      component,
      status: item?.status ?? 'pending' as ActivationStatus,
      current: item ? evidenceIsCurrent(item, now) : false,
      summary: item?.summary ?? 'No activation evidence recorded.',
      checked_at: item?.checked_at ?? null,
      expires_at: item?.expires_at ?? null,
    };
  });
  return {
    environment,
    required: required.length,
    passed: components.filter((item) => item.current).length,
    failed: components.filter((item) => item.status === 'failed').length,
    ready: components.every((item) => item.current),
    components,
  };
}

function configured(value: string | undefined) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validHttpsUrl(value: string | undefined) {
  if (!configured(value)) return false;
  try {
    return new URL(value!).protocol === 'https:';
  } catch {
    return false;
  }
}

export function activationConfiguration(env: Env, environment: ActivationEnvironment) {
  const checks = [
    { key: 'SUPABASE_URL', ok: validHttpsUrl(env.SUPABASE_URL), message: 'Supabase project URL must use HTTPS.' },
    { key: 'SUPABASE_ANON_KEY', ok: configured(env.SUPABASE_ANON_KEY), message: 'Supabase anonymous key is required.' },
    { key: 'SUPABASE_SERVICE_ROLE_KEY', ok: configured(env.SUPABASE_SERVICE_ROLE_KEY), message: 'Supabase service role key is required.' },
    { key: 'WEB_ORIGIN', ok: validHttpsUrl(env.WEB_ORIGIN), message: 'Web origin must use HTTPS.' },
    { key: 'PUBLIC_API_ORIGIN', ok: validHttpsUrl(env.PUBLIC_API_ORIGIN), message: 'Public API origin must use HTTPS.' },
    { key: 'ANTHROPIC_API_KEY', ok: configured(env.ANTHROPIC_API_KEY), message: 'AI provider key is required.' },
    { key: 'TOKEN_ENCRYPTION_KEY', ok: configured(env.TOKEN_ENCRYPTION_KEY), message: 'Token encryption key is required.' },
    { key: 'CRON_SECRET', ok: configured(env.CRON_SECRET), message: 'Cron secret is required.' },
    { key: 'META_APP_ID', ok: configured(env.META_APP_ID), message: 'Meta app ID is required.' },
    { key: 'META_APP_SECRET', ok: configured(env.META_APP_SECRET), message: 'Meta app secret is required.' },
    { key: 'META_REDIRECT_URI', ok: validHttpsUrl(env.META_REDIRECT_URI), message: 'Meta redirect URI must use HTTPS.' },
    { key: 'META_WEBHOOK_VERIFY_TOKEN', ok: configured(env.META_WEBHOOK_VERIFY_TOKEN), message: 'Meta webhook verification token is required.' },
    { key: 'STRIPE_SECRET_KEY', ok: configured(env.STRIPE_SECRET_KEY), message: 'Stripe secret key is required.' },
    { key: 'STRIPE_WEBHOOK_SECRET', ok: configured(env.STRIPE_WEBHOOK_SECRET), message: 'Stripe webhook secret is required.' },
    { key: 'STRIPE_SUCCESS_URL', ok: validHttpsUrl(env.STRIPE_SUCCESS_URL), message: 'Stripe success URL must use HTTPS.' },
    { key: 'STRIPE_CANCEL_URL', ok: validHttpsUrl(env.STRIPE_CANCEL_URL), message: 'Stripe cancel URL must use HTTPS.' },
  ];
  if (environment === 'production') {
    checks.push(
      { key: 'PUBLISHING_PROVIDER_MODE', ok: env.PUBLISHING_PROVIDER_MODE === 'meta', message: 'Production publishing must use Meta.' },
      { key: 'BILLING_PROVIDER_MODE', ok: env.BILLING_PROVIDER_MODE === 'stripe', message: 'Production billing must use Stripe.' },
    );
  }
  return checks.map((check) => ({ ...check, status: check.ok ? 'passed' as const : 'failed' as const }));
}

export function activationConfigurationReady(env: Env, environment: ActivationEnvironment) {
  return activationConfiguration(env, environment).every((check) => check.ok);
}

export function stripeModeMatchesEnvironment(secretKey: string | undefined, environment: ActivationEnvironment) {
  if (!secretKey) return false;
  return environment === 'production' ? secretKey.startsWith('sk_live_') : secretKey.startsWith('sk_test_');
}

export function activationExpiry(minutes: number, now = new Date()) {
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}
