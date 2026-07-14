import { describe, expect, it } from 'vitest';
import { evaluateBetaGate, inviteExpiresAt, rateLimitPolicy, sanitizeBetaContext } from '../src/beta';

const now = new Date('2026-07-14T00:00:00Z');
const suites = ['auth', 'rls', 'publishing', 'billing', 'data_rights', 'reliability', 'security'];
const passingRuns = suites.map((suite) => ({
  suite,
  status: 'passed',
  completed_at: '2026-07-13T23:00:00Z',
  expires_at: '2026-07-15T00:00:00Z',
}));

describe('Phase 9 beta and security safeguards', () => {
  it('blocks beta when a required QA suite is missing', () => {
    const result = evaluateBetaGate({ activationActive: true, qaRuns: passingRuns.slice(1), openFindings: [], openIncidents: [], programStatus: 'active' }, now);
    expect(result.ready).toBe(false);
    expect(result.qa_passed).toBe(6);
  });

  it('passes only with current QA, active infrastructure and no blockers', () => {
    const result = evaluateBetaGate({ activationActive: true, qaRuns: passingRuns, openFindings: [], openIncidents: [], programStatus: 'recruiting' }, now);
    expect(result.ready).toBe(true);
    expect(result.qa_passed).toBe(result.qa_required);
  });

  it('rejects expired QA evidence', () => {
    const expired = passingRuns.map((run) => run.suite === 'security' ? { ...run, expires_at: '2026-07-13T00:00:00Z' } : run);
    expect(evaluateBetaGate({ activationActive: true, qaRuns: expired, openFindings: [], openIncidents: [], programStatus: 'active' }, now).ready).toBe(false);
  });

  it('blocks critical findings and major incidents', () => {
    const base = { activationActive: true, qaRuns: passingRuns, programStatus: 'active' };
    expect(evaluateBetaGate({ ...base, openFindings: [{ severity: 'critical', status: 'open' }], openIncidents: [] }, now).ready).toBe(false);
    expect(evaluateBetaGate({ ...base, openFindings: [], openIncidents: [{ severity: 'sev2', status: 'investigating' }] }, now).ready).toBe(false);
  });

  it('redacts secret-bearing feedback context recursively', () => {
    const sanitized = sanitizeBetaContext({ token: 'abc', nested: { password: 'secret', okay: 'visible' }, authorization: 'Bearer x' }) as Record<string, any>;
    expect(sanitized.token).toBe('[redacted]');
    expect(sanitized.authorization).toBe('[redacted]');
    expect(sanitized.nested.password).toBe('[redacted]');
    expect(sanitized.nested.okay).toBe('visible');
  });

  it('classifies sensitive mutations with tighter rate limits', () => {
    expect(rateLimitPolicy('POST', '/api/v9/beta/invites/accept')?.scope).toBe('identity');
    expect(rateLimitPolicy('POST', '/api/content/generate')?.scope).toBe('generation');
    expect(rateLimitPolicy('POST', '/api/publication/schedule')?.scope).toBe('publishing');
    expect(rateLimitPolicy('GET', '/api/bootstrap')).toBeNull();
  });

  it('bounds invitation expiry between one hour and fourteen days', () => {
    expect(inviteExpiresAt(0, now)).toBe('2026-07-14T01:00:00.000Z');
    expect(inviteExpiresAt(1000, now)).toBe('2026-07-28T00:00:00.000Z');
  });
});
