import { describe, expect, it } from 'vitest';
import {
  classifyRequestRisk,
  controlReason,
  evaluateReleaseReadiness,
  incidentControlPreset,
  requiredReleaseGates,
  validateRuntimeConfig,
  type ReleaseGate,
} from '../src/reliability';
import type { Env } from '../src/types';

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
    ANTHROPIC_API_KEY: 'ai-key',
    ANTHROPIC_MODEL: 'model',
    WEB_ORIGIN: 'https://brandloom.example',
    TOKEN_ENCRYPTION_KEY: 'token-key',
    CRON_SECRET: 'cron-secret',
    APP_VERSION: '7.0.0',
    COMMIT_SHA: 'abcdef1234567890',
    EXPECTED_MIGRATION_VERSION: '0015',
    DEPLOYMENT_ENVIRONMENT: 'staging',
    ...overrides,
  };
}

function passedGate(gateKey: ReleaseGate['gate_key']): ReleaseGate {
  return { gate_key: gateKey, status: 'passed', expires_at: '2026-08-01T00:00:00.000Z' };
}

describe('Phase 7 release safeguards', () => {
  it('requires every production gate before release promotion', () => {
    const gates = requiredReleaseGates('production').map(passedGate);
    const result = evaluateReleaseReadiness('production', gates, new Date('2026-07-13T00:00:00Z'));
    expect(result.required).toBe(8);
    expect(result.ready).toBe(true);
  });

  it('invalidates expired evidence even when it previously passed', () => {
    const gates = requiredReleaseGates('production').map(passedGate);
    const databaseGate = gates.find((gate) => gate.gate_key === 'database_health');
    expect(databaseGate).toBeDefined();
    if (!databaseGate) throw new Error('database gate missing');
    databaseGate.expires_at = '2026-07-01T00:00:00.000Z';
    const result = evaluateReleaseReadiness('production', gates, new Date('2026-07-13T00:00:00Z'));
    expect(result.ready).toBe(false);
    expect(result.pending).toBeGreaterThan(0);
  });

  it('rejects mock providers in production configuration', () => {
    const checks = validateRuntimeConfig(baseEnv({
      DEPLOYMENT_ENVIRONMENT: 'production',
      PUBLISHING_PROVIDER_MODE: 'mock',
      BILLING_PROVIDER_MODE: 'mock',
      META_APP_ID: 'id',
      META_APP_SECRET: 'secret',
      META_WEBHOOK_VERIFY_TOKEN: 'verify',
      STRIPE_SECRET_KEY: 'stripe',
      STRIPE_WEBHOOK_SECRET: 'webhook',
    }));
    expect(checks.find((check) => check.key === 'PUBLISHING_PROVIDER_MODE')?.status).toBe('failed');
    expect(checks.find((check) => check.key === 'BILLING_PROVIDER_MODE')?.status).toBe('failed');
  });

  it('classifies risky routes before applying environment controls', () => {
    expect(classifyRequestRisk('POST', '/api/v2/weekly-plans/abc/strategy/generate')).toBe('generation');
    expect(classifyRequestRisk('POST', '/api/v4/publications/abc/schedule')).toBe('publishing');
    expect(classifyRequestRisk('PATCH', '/api/v7/platform/environments/production/controls')).toBe('control_plane');
    expect(classifyRequestRisk('GET', '/api/bootstrap')).toBe('read');
  });

  it('pauses only the operation classes selected by the control plane', () => {
    const controls = { generation_paused: true, publishing_paused: false, reason: 'AI provider incident.' };
    expect(controlReason(controls, 'generation')).toBe('AI provider incident.');
    expect(controlReason(controls, 'publishing')).toBeNull();
    expect(controlReason(controls, 'read')).toBeNull();
  });

  it('uses a full circuit breaker for severity one incidents', () => {
    expect(incidentControlPreset('sev1')).toEqual({
      maintenance_mode: true,
      writes_paused: true,
      generation_paused: true,
      publishing_paused: true,
    });
    expect(incidentControlPreset('sev4').maintenance_mode).toBe(false);
  });
});
