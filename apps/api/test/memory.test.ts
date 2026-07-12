import { describe, expect, it } from 'vitest';
import { buildRepetitionReport, candidateConfidence, compileMemoryContext, isMemoryActive, type MemoryItem } from '../src/memory';

const memory = (overrides: Partial<MemoryItem> = {}): MemoryItem => ({
  id: crypto.randomUUID(),
  brand_id: crypto.randomUUID(),
  memory_type: 'voice_preference',
  statement: 'Prefer warm, understated language.',
  durability: 'stable',
  confidence: 0.8,
  status: 'confirmed',
  origin: 'explicit',
  evidence_count: 1,
  scope: {},
  ...overrides,
});

describe('memory activation', () => {
  it('excludes expired and unconfirmed memories', () => {
    expect(isMemoryActive(memory({ valid_until: '2020-01-01' }), new Date('2026-07-12'))).toBe(false);
    expect(isMemoryActive(memory({ status: 'candidate' }), new Date('2026-07-12'))).toBe(false);
    expect(isMemoryActive(memory(), new Date('2026-07-12'))).toBe(true);
  });

  it('respects product scope and prioritises compliance', () => {
    const productId = crypto.randomUUID();
    const context = compileMemoryContext([
      memory({ id: 'voice', scope: { product_id: productId } }),
      memory({ id: 'other', scope: { product_id: crypto.randomUUID() } }),
      memory({ id: 'safety', memory_type: 'compliance_restriction', statement: 'Never make disease-cure claims.' }),
    ], { task: 'writing', productIds: [productId], platform: 'instagram', now: new Date('2026-07-12') });
    expect(context.ids).toEqual(['safety', 'voice']);
  });
});

describe('confidence and repetition', () => {
  it('does not treat one edit as a permanent rule', () => {
    expect(candidateConfidence({ evidenceCount: 1 })).toBeLessThan(0.5);
    expect(candidateConfidence({ evidenceCount: 5, observedAcrossWeeks: true })).toBeGreaterThan(0.7);
    expect(candidateConfidence({ evidenceCount: 1, explicit: true })).toBe(1);
  });

  it('detects overused hooks and calls to action', () => {
    const report = buildRepetitionReport([
      { id: '1', hook: 'A familiar breakfast', cta: 'Message us to order', pillar: 'product' },
      { id: '2', hook: 'A familiar breakfast', cta: 'Message us to order', pillar: 'product' },
      { id: '3', hook: 'Behind the recipe', cta: 'Message us to order', pillar: 'product' },
    ]);
    expect(report.warnings.map((warning) => warning.type)).toEqual(expect.arrayContaining(['hook', 'cta', 'pillar']));
  });
});
