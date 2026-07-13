import { describe, expect, it } from 'vitest';
import {
  buildOptimizationInsights,
  confidenceForSample,
  evaluateExperiment,
  normalizeMetrics,
  opportunityScore,
  performanceRates,
  type OptimizationSample,
} from '../src/optimization';

function sample(index: number, overrides: Partial<OptimizationSample> = {}): OptimizationSample {
  return {
    contentId: `content-${index}`,
    scheduledDate: `2026-06-${String(index + 1).padStart(2, '0')}`,
    format: index % 2 === 0 ? 'carousel' : 'static',
    pillar: index < 6 ? 'education' : 'trust',
    hookType: index < 6 ? 'question' : 'contrarian',
    ctaType: index < 6 ? 'save' : 'comment',
    productId: null,
    metrics: normalizeMetrics({ reach: 1000, likes: 40, comments: 5, saves: index < 6 ? 30 : 5, shares: index < 6 ? 20 : 3, clicks: 10 }),
    ...overrides,
  };
}

describe('Phase 6 optimization safeguards', () => {
  it('normalizes invalid metrics and avoids division by zero', () => {
    const metrics = normalizeMetrics({ reach: -10, likes: Number.NaN, saves: 4 });
    expect(metrics.reach).toBe(0);
    expect(metrics.likes).toBe(0);
    expect(performanceRates(metrics).save_rate).toBe(4);
  });

  it('requests more measurement for a small observational sample', () => {
    const insights = buildOptimizationInsights([sample(0), sample(1), sample(2)]);
    const first = insights.recommendations[0];
    expect(first).toBeDefined();
    expect(first?.type).toBe('measurement');
    expect(first?.attributionConfidence).toBe('low');
  });

  it('caps non-randomized confidence below causal confidence', () => {
    expect(confidenceForSample(1000, 3, false)).toBeLessThanOrEqual(0.78);
    expect(confidenceForSample(1000, 3, true)).toBeGreaterThan(0.78);
  });

  it('detects repeated dimensions without auto-applying them', () => {
    const insights = buildOptimizationInsights(Array.from({ length: 10 }, (_, index) => sample(index)));
    expect(insights.fatigue.some((signal) => signal.signalType === 'pillar' && signal.signalKey === 'education')).toBe(true);
    expect(insights.recommendations.every((recommendation) => recommendation.confidence <= 0.95)).toBe(true);
  });

  it('keeps experiments inconclusive until every variant is powered', () => {
    const observations = [
      { variantKey: 'a', contentId: 'a1', metrics: normalizeMetrics({ reach: 1000, saves: 50 }) },
      { variantKey: 'a', contentId: 'a2', metrics: normalizeMetrics({ reach: 1000, saves: 55 }) },
      { variantKey: 'b', contentId: 'b1', metrics: normalizeMetrics({ reach: 1000, saves: 5 }) },
    ];
    expect(evaluateExperiment(observations, 2).status).toBe('insufficient');
  });

  it('selects a winner only after a powered controlled comparison', () => {
    const observations = [
      ...Array.from({ length: 10 }, (_, index) => ({ variantKey: 'a', contentId: `a${index}`, metrics: normalizeMetrics({ reach: 1000, saves: 70, shares: 25, clicks: 20 }) })),
      ...Array.from({ length: 10 }, (_, index) => ({ variantKey: 'b', contentId: `b${index}`, metrics: normalizeMetrics({ reach: 1000, saves: 8, shares: 3, clicks: 4 }) })),
    ];
    const result = evaluateExperiment(observations, 10);
    expect(result.status).toBe('winner');
    expect(result.winner).toBe('a');
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('reduces expired opportunities to zero urgency', () => {
    const score = opportunityScore({ relevance: 1, confidence: 1, validUntil: '2026-01-01', now: new Date('2026-07-13T00:00:00Z') });
    expect(score).toBe(0.8);
  });
});
