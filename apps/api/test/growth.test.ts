import { describe, expect, it } from 'vitest';
import { assignGrowthVariant, evaluatePublicLaunchGate, funnelRates, sanitizeAttribution, sanitizeGrowthProperties, validReferralCode } from '../src/growth';

const now = new Date('2026-07-14T00:00:00Z');
const checklist = ['product','security','legal','support','operations','billing','publishing','data_rights','communications'].map((category) => ({ category, required: true, status: 'passed', expires_at: '2026-07-15T00:00:00Z' }));

describe('Phase 10 public launch and growth safeguards', () => {
  it('requires every external launch prerequisite', () => {
    const result = evaluatePublicLaunchGate({ activeRelease: true, productionActivation: true, betaGateCurrent: true, restoreDrillCurrent: true, checklist, blockingFindings: 0, blockingIncidents: 0 }, now);
    expect(result.ready).toBe(true);
    expect(result.checklist_passed).toBe(result.checklist_required);
  });

  it('blocks public access on stale checklist evidence or risk', () => {
    const stale = checklist.map((item) => item.category === 'legal' ? { ...item, expires_at: '2026-07-13T00:00:00Z' } : item);
    expect(evaluatePublicLaunchGate({ activeRelease: true, productionActivation: true, betaGateCurrent: true, restoreDrillCurrent: true, checklist: stale, blockingFindings: 0, blockingIncidents: 0 }, now).ready).toBe(false);
    expect(evaluatePublicLaunchGate({ activeRelease: true, productionActivation: true, betaGateCurrent: true, restoreDrillCurrent: true, checklist, blockingFindings: 1, blockingIncidents: 0 }, now).ready).toBe(false);
  });

  it('assigns experiment variants deterministically', () => {
    const variants = [{ key: 'control', weight: 1 }, { key: 'new', weight: 1 }];
    const first = assignGrowthVariant('subject-hash', 'pricing-copy', variants, 100);
    expect(assignGrowthVariant('subject-hash', 'pricing-copy', variants, 100)).toBe(first);
    expect(['control','new']).toContain(first);
  });

  it('excludes subjects outside partial experiment allocation consistently', () => {
    const value = assignGrowthVariant('same-subject', 'test', [{ key: 'a' }, { key: 'b' }], 1);
    expect([null,'a','b']).toContain(value);
    expect(assignGrowthVariant('same-subject', 'test', [{ key: 'a' }, { key: 'b' }], 1)).toBe(value);
  });

  it('removes personal and secret properties from growth events', () => {
    const clean = sanitizeGrowthProperties({ email: 'person@example.com', token: 'secret', plan: 'growth', nested: { phone: '1', step: 2 } }) as Record<string, any>;
    expect(clean.email).toBeUndefined();
    expect(clean.token).toBeUndefined();
    expect(clean.plan).toBe('growth');
    expect(clean.nested.phone).toBeUndefined();
    expect(clean.nested.step).toBe(2);
  });

  it('normalizes attribution and calculates zero-safe funnel rates', () => {
    expect(sanitizeAttribution(' Creator / Launch ')).toBe('creator-launch');
    expect(funnelRates({ landing_views: 100, waitlist_joins: 20, signups: 10, activated_workspaces: 5, first_publishes: 2, paid_workspaces: 1 })).toEqual({ waitlist_rate: .2, signup_rate: .1, activation_rate: .5, first_publish_rate: .4, paid_conversion_rate: .1 });
    expect(funnelRates({ landing_views: 0, waitlist_joins: 0, signups: 0, activated_workspaces: 0, first_publishes: 0, paid_workspaces: 0 }).signup_rate).toBe(0);
  });

  it('accepts only bounded referral codes', () => {
    expect(validReferralCode('ABC23456')).toBe(true);
    expect(validReferralCode('bad-code')).toBe(false);
  });
});
