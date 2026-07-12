export type WorkflowStatus =
  | 'idea' | 'planned' | 'drafting' | 'internal_review' | 'changes_requested'
  | 'ready_for_approval' | 'approved' | 'ready_to_publish' | 'completed'
  | 'blocked' | 'cancelled' | 'expired';

const transitions: Record<WorkflowStatus, WorkflowStatus[]> = {
  idea: ['planned', 'cancelled'],
  planned: ['drafting', 'blocked', 'cancelled'],
  drafting: ['internal_review', 'blocked', 'cancelled'],
  internal_review: ['changes_requested', 'ready_for_approval', 'blocked', 'cancelled'],
  changes_requested: ['drafting', 'internal_review', 'blocked', 'cancelled'],
  ready_for_approval: ['approved', 'changes_requested', 'blocked', 'cancelled'],
  approved: ['ready_to_publish', 'changes_requested', 'expired', 'cancelled'],
  ready_to_publish: ['completed', 'changes_requested', 'expired', 'cancelled'],
  completed: [],
  blocked: ['planned', 'drafting', 'internal_review', 'changes_requested', 'ready_for_approval', 'cancelled'],
  cancelled: ['planned'],
  expired: ['planned', 'cancelled'],
};

export function canTransition(from: WorkflowStatus, to: WorkflowStatus) {
  return from === to || transitions[from].includes(to);
}

export const materialFields = new Set([
  'title', 'hook', 'caption', 'cta', 'visual_brief', 'scheduled_date', 'product_id',
  'campaign_id', 'format', 'facts_used', 'hashtags',
]);

export function materialChanges(before: Record<string, unknown>, after: Record<string, unknown>) {
  return [...materialFields].filter((field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null));
}

export type ReadinessInput = {
  format: 'static' | 'carousel' | 'reel' | 'story';
  hook?: string | null;
  caption?: string | null;
  cta?: string | null;
  visualBrief?: string | null;
  qualityErrors?: number;
  requiredAssets?: number;
  attachedRequiredAssets?: number;
  requiredChecklist?: number;
  completedChecklist?: number;
  requiredApprovals?: number;
  approvedApprovals?: number;
  staleApprovals?: number;
  blockingTasks?: number;
  blockingThreads?: number;
};

export function calculateOperationalReadiness(input: ReadinessInput) {
  const copyChecks = [input.hook, input.caption, input.cta, input.visualBrief].filter((value) => Boolean(value?.trim()));
  const copy = Math.round((copyChecks.length / 4) * 100);
  const assets = input.requiredAssets
    ? Math.round(Math.min(input.attachedRequiredAssets ?? 0, input.requiredAssets) / input.requiredAssets * 100)
    : 100;
  const checklist = input.requiredChecklist
    ? Math.round(Math.min(input.completedChecklist ?? 0, input.requiredChecklist) / input.requiredChecklist * 100)
    : 100;
  const approvals = input.requiredApprovals
    ? Math.round(Math.min(input.approvedApprovals ?? 0, input.requiredApprovals) / input.requiredApprovals * 100)
    : 0;
  const blockers = (input.blockingTasks ?? 0) + (input.blockingThreads ?? 0) + (input.qualityErrors ?? 0) + (input.staleApprovals ?? 0);
  const overall = blockers > 0
    ? Math.min(79, Math.round(copy * 0.30 + assets * 0.25 + checklist * 0.20 + approvals * 0.25))
    : Math.round(copy * 0.30 + assets * 0.25 + checklist * 0.20 + approvals * 0.25);
  return {
    overall,
    dimensions: { copy, assets, checklist, approvals },
    blockers,
    ready_to_publish: overall === 100 && blockers === 0,
  };
}

export function defaultChecklist(format: ReadinessInput['format']) {
  const shared = [
    ['Hook complete', 'copy'], ['Caption complete', 'copy'], ['CTA complete', 'copy'],
    ['Product facts verified', 'facts'], ['Final approval complete', 'approval'],
  ] as const;
  const byFormat: Record<ReadinessInput['format'], ReadonlyArray<readonly [string, string]>> = {
    static: [['Primary image attached', 'assets'], ['Alt text ready', 'publishing']],
    carousel: [['Cover headline ready', 'copy'], ['All slide copy ready', 'copy'], ['Final carousel attached', 'assets'], ['CTA slide ready', 'copy']],
    reel: [['Script ready', 'copy'], ['Shot list ready', 'assets'], ['Cover image attached', 'assets'], ['Final video attached', 'assets'], ['On-screen text checked', 'copy']],
    story: [['Frame sequence ready', 'copy'], ['Story assets attached', 'assets'], ['Sticker or link instruction ready', 'publishing']],
  };
  return [...shared, ...byFormat[format]].map(([label, category], position) => ({ label, category, required: true, position }));
}

export type ScheduleContext = {
  oldDate?: string | null;
  newDate: string;
  campaignStart?: string | null;
  campaignEnd?: string | null;
  offerValidUntil?: string | null;
  cta?: string | null;
};

export function validateReschedule(input: ScheduleContext) {
  const warnings: string[] = [];
  if (input.campaignStart && input.newDate < input.campaignStart) warnings.push('New date is before the campaign starts.');
  if (input.campaignEnd && input.newDate > input.campaignEnd) warnings.push('New date is after the campaign ends.');
  if (input.offerValidUntil && input.newDate > input.offerValidUntil) warnings.push('The campaign offer expires before the new date.');
  if (input.oldDate && input.oldDate !== input.newDate && /today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|before|until/i.test(input.cta ?? '')) {
    warnings.push('The CTA contains time-sensitive wording and needs review after rescheduling.');
  }
  return warnings;
}

export function campaignHealth(input: {
  deliverables: Array<{ status: string; due_date?: string | null }>;
  tasks: Array<{ status: string; due_at?: string | null; blocks_completion?: boolean }>;
  today?: string;
}) {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const required = input.deliverables.length;
  const complete = input.deliverables.filter((item) => ['approved', 'ready', 'completed'].includes(item.status)).length;
  const blocked = input.deliverables.filter((item) => item.status === 'blocked').length + input.tasks.filter((task) => task.status === 'blocked').length;
  const overdue = input.tasks.filter((task) => task.status !== 'done' && task.due_at && task.due_at.slice(0, 10) < today).length
    + input.deliverables.filter((item) => !['completed', 'cancelled'].includes(item.status) && item.due_date && item.due_date < today).length;
  return {
    completion: required ? Math.round(complete / required * 100) : 0,
    blocked,
    overdue,
    at_risk: blocked > 0 || overdue > 0,
  };
}

export async function checksum(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
