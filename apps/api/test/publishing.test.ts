import { describe, expect, it } from 'vitest';
import { preflightPublication, publicationIdempotencyKey, retryDecision } from '../src/publishing';

const valid = {
  connectionHealthy: true,
  publishingEnabled: true,
  publishingPaused: false,
  contentWorkflowStatus: 'ready_to_publish',
  currentMaterialRevision: 3,
  versionMaterialRevision: 3,
  requiredApprovals: 1,
  approvedCurrentApprovals: 1,
  staleApprovals: 0,
  qualityErrors: 0,
  blockingTasks: 0,
  blockingThreads: 0,
  campaignStatus: 'active',
  campaignEnd: '2026-08-31',
  offerValidUntil: '2026-08-31',
  assets: [{ role:'primary',position:0,mimeType:'image/jpeg',approved:true,rightsStatus:'owned',sizeBytes:1200 }],
  format: 'static' as const,
  scheduledFor: '2026-07-20T12:00:00.000Z',
  now: new Date('2026-07-12T12:00:00.000Z'),
  capabilities: { image_post:true },
};

describe('publication preflight', () => {
  it('accepts a current approved snapshot', () => {
    expect(preflightPublication(valid).eligible).toBe(true);
  });

  it('blocks stale approval and expired campaign facts', () => {
    const result = preflightPublication({ ...valid, staleApprovals:1, offerValidUntil:'2026-07-15' });
    expect(result.eligible).toBe(false);
    expect(result.errors.map((issue) => issue.code)).toEqual(expect.arrayContaining(['STALE_APPROVAL','OFFER_EXPIRED']));
  });

  it('blocks unapproved asset rights', () => {
    const result = preflightPublication({ ...valid, assets:[{...valid.assets[0]!,rightsStatus:'unknown'}] });
    expect(result.errors.some((issue)=>issue.code==='ASSET_RIGHTS')).toBe(true);
  });
});

describe('idempotency and retry', () => {
  it('produces the same key for the same frozen publication', async () => {
    const input = {workspaceId:'w',accountId:'a',contentVersionId:'v',materialRevision:2,scheduledFor:'2026-07-20T12:00:00Z'};
    expect(await publicationIdempotencyKey(input)).toBe(await publicationIdempotencyKey(input));
  });

  it('does not retry permanent authorization failures', () => {
    expect(retryDecision('authorization',1).retryable).toBe(false);
    expect(retryDecision('transient',1).retryable).toBe(true);
  });
});
