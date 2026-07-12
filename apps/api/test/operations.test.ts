import { describe, expect, it } from 'vitest';
import { calculateOperationalReadiness, canTransition, defaultChecklist, materialChanges, validateReschedule } from '../src/operations';

describe('workflow state machine', () => {
  it('allows review changes but blocks impossible jumps', () => {
    expect(canTransition('internal_review', 'changes_requested')).toBe(true);
    expect(canTransition('drafting', 'completed')).toBe(false);
  });
});

describe('approval integrity', () => {
  it('recognises material copy changes', () => {
    expect(materialChanges({ caption: 'Old', status: 'draft' }, { caption: 'New', status: 'approved' })).toEqual(['caption']);
  });
});

describe('operational readiness', () => {
  it('cannot be ready while a blocking task remains', () => {
    const result = calculateOperationalReadiness({
      format: 'static', hook: 'Hook', caption: 'Caption', cta: 'Order', visualBrief: 'Photo',
      requiredAssets: 1, attachedRequiredAssets: 1, requiredChecklist: 2, completedChecklist: 2,
      requiredApprovals: 1, approvedApprovals: 1, blockingTasks: 1,
    });
    expect(result.ready_to_publish).toBe(false);
    expect(result.overall).toBeLessThan(100);
  });

  it('creates format-specific checklists', () => {
    expect(defaultChecklist('reel').some((item) => item.label === 'Final video attached')).toBe(true);
  });
});

describe('rescheduling', () => {
  it('warns when an offer expires before the new date', () => {
    expect(validateReschedule({ newDate: '2026-08-10', offerValidUntil: '2026-08-01' })).toContain('The campaign offer expires before the new date.');
  });
});
