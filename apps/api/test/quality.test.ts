import { describe, expect, it } from 'vitest';
import { validateDraft } from '../src/quality';
import { calculateReadiness } from '../src/readiness';

describe('validateDraft', () => {
  it('flags unsupported claims and generic phrases', () => {
    const flags = validateDraft({
      hook: 'Unlock the power of breakfast',
      caption: 'Clinically proven to cure fatigue.',
      factsUsed: ['Clinically proven to cure fatigue'],
      approvedFacts: ['Made with roasted grains'],
      prohibitedPhrases: ['cure'],
    });
    expect(flags.map((flag) => flag.code)).toEqual(expect.arrayContaining(['ai_cliche', 'prohibited_phrase', 'unsupported_claim']));
  });
});

describe('calculateReadiness', () => {
  it('makes missing brand signal visible', () => {
    const result = calculateReadiness({ brand: { description: '', category: '', location: '' }, products: [], audiences: [] });
    expect(result.score).toBe(0);
    expect(result.missing).toContain('At least one product');
  });
});
