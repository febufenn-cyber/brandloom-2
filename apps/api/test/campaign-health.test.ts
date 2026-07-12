import { describe, expect, it } from 'vitest';
import { campaignHealth } from '../src/operations';

describe('campaign health', () => {
  it('marks blocked or overdue campaigns at risk', () => {
    const result = campaignHealth({
      today: '2026-07-12',
      deliverables: [{ status: 'planned', due_date: '2026-07-10' }],
      tasks: [{ status: 'blocked', due_at: '2026-07-13T10:00:00Z', blocks_completion: true }],
    });
    expect(result.at_risk).toBe(true);
    expect(result.blocked).toBe(1);
    expect(result.overdue).toBe(1);
  });
});
