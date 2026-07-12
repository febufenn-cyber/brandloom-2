import { z } from 'zod';

const campaignBaseSchema = z.object({
  name: z.string().min(2).max(180),
  objective: z.string().max(3000).default(''),
  audience_ids: z.array(z.string().uuid()).max(20).default([]),
  product_ids: z.array(z.string().uuid()).max(20).default([]),
  start_date: z.string().date(),
  end_date: z.string().date(),
  key_message: z.string().max(3000).default(''),
  offer_details: z.record(z.unknown()).default({}),
  campaign_facts: z.array(z.object({ statement: z.string().min(2).max(1000), valid_until: z.string().date().nullable().optional() })).max(50).default([]),
  restrictions: z.array(z.string().max(500)).max(50).default([]),
  deliverable_targets: z.record(z.number().int().min(0).max(100)).default({}),
  capacity: z.record(z.unknown()).default({}),
  owner_id: z.string().uuid().nullable().optional(),
  status: z.enum(['draft', 'planned', 'active', 'at_risk', 'completed', 'cancelled', 'archived']).default('planned'),
});

export const campaignInputSchema = campaignBaseSchema.refine((value) => value.end_date >= value.start_date, { message: 'Campaign end date must not precede its start date.' });
export const campaignPatchSchema = campaignBaseSchema.partial();

export const deliverableSchema = z.object({
  title: z.string().min(2).max(240),
  deliverable_type: z.enum(['static', 'carousel', 'reel', 'story', 'other']),
  required: z.boolean().default(true),
  due_date: z.string().date().nullable().optional(),
  content_item_id: z.string().uuid().nullable().optional(),
});

export const contentCreateSchema = z.object({
  title: z.string().min(2).max(300),
  scheduled_date: z.string().date(),
  format: z.enum(['static', 'carousel', 'reel', 'story']),
  product_id: z.string().uuid().nullable().optional(),
  owner_id: z.string().uuid().nullable().optional(),
  pillar: z.string().max(160).default('campaign'),
  objective: z.string().max(1000).default(''),
  hook: z.string().max(1000).default(''),
  caption: z.string().max(12000).default(''),
  cta: z.string().max(1000).default(''),
  visual_brief: z.string().max(4000).default(''),
  hashtags: z.array(z.string().max(100)).max(40).default([]),
  structure: z.record(z.unknown()).default({}),
});

export const operationPatchSchema = z.object({
  workflow_status: z.enum([
    'idea', 'planned', 'drafting', 'internal_review', 'changes_requested',
    'ready_for_approval', 'approved', 'ready_to_publish', 'completed',
    'blocked', 'cancelled', 'expired',
  ]).optional(),
  scheduled_date: z.string().date().optional(),
  due_at: z.string().datetime().nullable().optional(),
  owner_id: z.string().uuid().nullable().optional(),
  campaign_id: z.string().uuid().nullable().optional(),
  external_publish_note: z.string().max(3000).optional(),
  acknowledge_warnings: z.boolean().default(false),
});

export const taskInputSchema = z.object({
  campaign_id: z.string().uuid().nullable().optional(),
  content_item_id: z.string().uuid().nullable().optional(),
  title: z.string().min(2).max(240),
  description: z.string().max(3000).default(''),
  task_type: z.enum(['general', 'copy', 'fact_check', 'offer_confirmation', 'asset', 'design', 'recording', 'review', 'approval', 'export', 'publishing_handoff']).default('general'),
  owner_id: z.string().uuid().nullable().optional(),
  due_at: z.string().datetime().nullable().optional(),
  status: z.enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled']).default('todo'),
  blocks_completion: z.boolean().default(false),
});

export const taskPatchSchema = taskInputSchema.partial();

export const assetInputSchema = z.object({
  name: z.string().min(1).max(240),
  asset_type: z.enum(['image', 'video', 'audio', 'logo', 'document', 'reference']),
  mime_type: z.string().max(160),
  size_bytes: z.number().int().min(0).max(52_428_800),
  product_id: z.string().uuid().nullable().optional(),
  campaign_id: z.string().uuid().nullable().optional(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  duration_seconds: z.number().nonnegative().nullable().optional(),
  tags: z.array(z.string().max(80)).max(30).default([]),
  rights_status: z.enum(['owned', 'licensed', 'restricted', 'expired', 'unknown']).default('unknown'),
  expires_at: z.string().date().nullable().optional(),
});

export const assetAttachSchema = z.object({
  asset_id: z.string().uuid(),
  role: z.enum(['primary', 'cover', 'slide', 'thumbnail', 'reference', 'audio', 'attachment']).default('primary'),
  required: z.boolean().default(true),
  position: z.number().int().min(0).default(0),
});

export const checklistPatchSchema = z.object({ completed: z.boolean() });

export const approvalInputSchema = z.object({
  approver_id: z.string().uuid(),
  approval_type: z.enum(['marketing', 'product_facts', 'compliance', 'founder', 'client', 'final']).default('final'),
  required: z.boolean().default(true),
  step_number: z.number().int().min(1).max(20).default(1),
});

export const approvalDecisionSchema = z.object({ decision: z.enum(['approved', 'changes_requested']), comment: z.string().max(3000).default('') });

export const threadInputSchema = z.object({
  field: z.enum(['general', 'title', 'hook', 'caption', 'cta', 'visual_brief', 'asset', 'strategy']).default('general'),
  change_type: z.enum(['copy', 'fact', 'tone', 'visual', 'offer', 'audience', 'compliance', 'schedule']).nullable().optional(),
  blocks_approval: z.boolean().default(false),
  body: z.string().min(1).max(5000),
});

export const commentInputSchema = z.object({ body: z.string().min(1).max(5000) });

export const invitationInputSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'editor', 'reviewer', 'approver', 'viewer']),
  expires_in_days: z.number().int().min(1).max(30).default(7),
});

export const memberPatchSchema = z.object({
  role: z.enum(['admin', 'editor', 'reviewer', 'approver', 'viewer']).optional(),
  status: z.enum(['accepted', 'suspended']).optional(),
});

export const exportInputSchema = z.object({
  export_format: z.enum(['json', 'csv', 'copy_package', 'campaign_bundle']).default('copy_package'),
  campaign_id: z.string().uuid().nullable().optional(),
});

export const campaignBriefSchema = z.object({
  objective: z.string(),
  audience_summary: z.string(),
  key_message: z.string(),
  content_pillars: z.array(z.object({ name: z.string(), purpose: z.string() })).min(2).max(8),
  risks: z.array(z.string()).max(20),
  deliverable_targets: z.record(z.number().int().min(0).max(50)),
  operational_notes: z.array(z.string()).max(20),
});
