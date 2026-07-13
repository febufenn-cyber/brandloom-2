import { describe, expect, it } from 'vitest';
import { billingAccessState, generationChargeForRequest, parseStripeSignature, periodKey, usagePercent, verifyStripeWebhook } from '../src/commercial';

describe('commercial access and metering', () => {
  it('keeps a past-due subscription in grace only before its deadline', () => {
    const now = new Date('2026-07-13T00:00:00Z');
    expect(billingAccessState('past_due', '2026-07-14T00:00:00Z', now)).toBe('grace');
    expect(billingAccessState('past_due', '2026-07-12T00:00:00Z', now)).toBe('read_only');
  });

  it('assigns understandable units to expensive generation operations', () => {
    expect(generationChargeForRequest('POST', '/api/brands/abc/constitution/generate')?.units).toBe(8);
    expect(generationChargeForRequest('POST', '/api/v2/content-items/abc/regenerate')?.units).toBe(1);
    expect(generationChargeForRequest('GET', '/api/brands/abc')).toBeNull();
  });

  it('calculates bounded usage percentages and monthly period keys', () => {
    expect(usagePercent(75, 100)).toBe(75);
    expect(usagePercent(200, 100)).toBe(100);
    expect(periodKey(new Date('2026-07-13T01:00:00Z'))).toBe('2026-07');
  });
});

describe('Stripe webhook verification', () => {
  it('parses multiple v1 signatures', () => {
    expect(parseStripeSignature('t=10,v1=abc,v1=def')).toEqual({ timestamp: 10, signatures: ['abc', 'def'] });
  });

  it('verifies the signed raw body and rejects stale timestamps', async () => {
    const body = '{"id":"evt_1"}';
    const secret = 'whsec_test';
    const timestamp = 1_800_000_000;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
    const signature = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    expect(await verifyStripeWebhook(body, `t=${timestamp},v1=${signature}`, secret, 300, timestamp * 1000)).toBe(true);
    expect(await verifyStripeWebhook(body, `t=${timestamp},v1=${signature}`, secret, 300, (timestamp + 301) * 1000)).toBe(false);
  });
});
