import { describe, expect, it } from 'vitest';
import {
  activationConfiguration,
  evaluateActivation,
  evidenceIsCurrent,
  requiredActivationComponents,
  stripeModeMatchesEnvironment,
  type ActivationEvidence,
} from '../src/activation';
import type { Env } from '../src/types';

const now = new Date('2026-07-14T00:00:00Z');

function evidence(overrides: Partial<ActivationEvidence> = {}): ActivationEvidence {
  return {
    component: 'database',
    status: 'passed',
    checked_at: '2026-07-13T23:59:00Z',
    expires_at: '2026-07-14T00:15:00Z',
    summary: 'ok',
    ...overrides,
  };
}

describe('Phase 8 live activation safeguards', () => {
  it('requires every external activation component', () => {
    expect(requiredActivationComponents('production')).toEqual([
      'database', 'web', 'worker', 'storage', 'ai_provider',
      'publishing_provider', 'billing_provider', 'webhooks',
    ]);
  });

  it('rejects expired evidence', () => {
    expect(evidenceIsCurrent(evidence({ expires_at: '2026-07-13T23:00:00Z' }), now)).toBe(false);
  });

  it('does not activate with missing components', () => {
    const result = evaluateActivation('production', [evidence()], now);
    expect(result.ready).toBe(false);
    expect(result.passed).toBe(1);
  });

  it('activates only when the latest evidence for every component is current', () => {
    const rows = requiredActivationComponents('production').map((component) => evidence({ component }));
    expect(evaluateActivation('production', rows, now).ready).toBe(true);
    rows.push(evidence({ component: 'database', status: 'failed', checked_at: '2026-07-14T00:01:00Z' }));
    expect(evaluateActivation('production', rows, now).ready).toBe(false);
  });

  it('requires real provider modes for production', () => {
    const env = {
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_ANON_KEY: 'anon',
      SUPABASE_SERVICE_ROLE_KEY: 'service',
      ANTHROPIC_API_KEY: 'ai',
      ANTHROPIC_MODEL: 'model',
      WEB_ORIGIN: 'https://app.example.com',
      PUBLIC_API_ORIGIN: 'https://api.example.com',
      TOKEN_ENCRYPTION_KEY: 'key',
      CRON_SECRET: 'cron',
      META_APP_ID: 'meta',
      META_APP_SECRET: 'secret',
      META_REDIRECT_URI: 'https://api.example.com/oauth/meta/callback',
      META_WEBHOOK_VERIFY_TOKEN: 'verify',
      STRIPE_SECRET_KEY: 'sk_live_example',
      STRIPE_WEBHOOK_SECRET: 'whsec_example',
      STRIPE_SUCCESS_URL: 'https://app.example.com/success',
      STRIPE_CANCEL_URL: 'https://app.example.com/cancel',
      PUBLISHING_PROVIDER_MODE: 'mock',
      BILLING_PROVIDER_MODE: 'mock',
    } as Env;
    const checks = activationConfiguration(env, 'production');
    expect(checks.find((check) => check.key === 'PUBLISHING_PROVIDER_MODE')?.status).toBe('failed');
    expect(checks.find((check) => check.key === 'BILLING_PROVIDER_MODE')?.status).toBe('failed');
  });

  it('prevents test Stripe keys from activating production', () => {
    expect(stripeModeMatchesEnvironment('sk_test_123', 'production')).toBe(false);
    expect(stripeModeMatchesEnvironment('sk_test_123', 'staging')).toBe(true);
    expect(stripeModeMatchesEnvironment('sk_live_123', 'production')).toBe(true);
  });
});
