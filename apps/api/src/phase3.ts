import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { generateStructured } from './ai';
import { loadBrandBundle } from './db';
import { compileMemoryContext, type MemoryItem } from './memory';
import {
  calculateOperationalReadiness, campaignHealth, canTransition, checksum,
  defaultChecklist, validateReschedule, type WorkflowStatus,
} from './operations';
import {
  approvalDecisionSchema, approvalInputSchema, assetAttachSchema, assetInputSchema,
  campaignBriefSchema, campaignInputSchema, campaignPatchSchema, checklistPatchSchema,
  commentInputSchema, contentCreateSchema, deliverableSchema, exportInputSchema,
  invitationInputSchema, memberPatchSchema, operationPatchSchema, taskInputSchema,
  taskPatchSchema, threadInputSchema,
} from './phase3Schemas';
import type { Env, Variables } from './types';

const phase3 = new Hono<{ Bindings: Env; Variables: Variables }>();

type Supabase = Variables['supabase'];

async function body<Schema extends z.ZodTypeAny>(c: Context, schema: Schema): Promise<z.output<Schema>> {
  return schema.parse(await c.req.json()) as z.output<Schema>;
}

function monday(date: string) {
  const value = new Date(`${date}T12:00:00Z`);
  const day = value.getUTCDay();
  value.setUTCDate(value.getUTCDate() - day + (day === 0 ? -6 : 1));
  return value.toISOString().slice(0, 10);
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function safeName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').slice(0, 120);
}

async function workspaceForBrand(supabase: Supabase, brandId: string) {
  const { data, error } = await supabase.from('brands').select('workspace_id').eq('id', brandId).single();
  if (error) throw error;
  return data.workspace_id as string;
}

async function activity(supabase: Supabase, input: {
  brandId: string; actorId: string; eventType: string; entityType: string; entityId?: string | null; metadata?: unknown;
}) {
  const workspaceId = await workspaceForBrand(supabase, input.brandId);
  const { error } = await supabase.from('activity_events').insert({
    workspace_id: workspaceId,
    brand_id: input.brandId,
    actor_id: input.actorId,
    event_type: input.eventType,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    metadata: input.metadata ?? {},
  });
  if (error) throw error;
}

async function notify(supabase: Supabase, input: {
  brandId: string; userId: string; type: string; entityType: string; entityId?: string | null; message: string;
}) {
  const workspaceId = await workspaceForBrand(supabase, input.brandId);
  const { error } = await supabase.from('notifications').insert({
    workspace_id: workspaceId,
    user_id: input.userId,
    notification_type: input.type,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    message: input.message,
  });
  if (error) throw error;
}

async function ensureWeeklyPlan(supabase: Supabase, brandId: string, date: string) {
  const weekStart = monday(date);
  const { data: existing, error: existingError } = await supabase.from('weekly_plans')
    .select('*').eq('brand_id', brandId).eq('week_start', weekStart).maybeSingle();
  if (existingError) throw existingError;
  if (existing) return existing;
  const { data, error } = await supabase.from('weekly_plans').insert({
    brand_id: brandId,
    week_start: weekStart,
    primary_goal: 'awareness',
    campaign_context: 'Created from Phase 3 campaign operations.',
    featured_product_ids: [],
    important_dates: [],
    posting_days: 7,
    language_mode: 'English',
    status: 'setup',
  }).select('*').single();
  if (error) throw error;
  return data;
}

async function latestVersion(supabase: Supabase, contentId: string) {
  const { data, error } = await supabase.from('content_versions')
    .select('*').eq('content_item_id', contentId)
    .order('version_number', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Content has no version history.');
  return data;
}

async function ensureChecklist(supabase: Supabase, content: Record<string, unknown>) {
  const contentId = String(content.id);
  const { data: existing, error } = await supabase.from('content_checklist_items')
    .select('*').eq('content_item_id', contentId).order('position');
  if (error) throw error;
  if (existing?.length) return existing;
  const rows = defaultChecklist(content.format as 'static' | 'carousel' | 'reel' | 'story')
    .map((item) => ({ content_item_id: contentId, ...item }));
  const { data, error: insertError } = await supabase.from('content_checklist_items').insert(rows).select('*');
  if (insertError) throw insertError;
  return data ?? [];
}

async function contentReadiness(supabase: Supabase, contentId: string) {
  const { data: content, error } = await supabase.from('content_items').select('*').eq('id', contentId).single();
  if (error) throw error;
  const checklist = await ensureChecklist(supabase, content);
  const [assetResult, approvalResult, taskResult, threadResult] = await Promise.all([
    supabase.from('content_assets').select('*').eq('content_item_id', contentId).eq('required', true),
    supabase.from('approval_requests').select('*').eq('content_item_id', contentId),
    supabase.from('tasks').select('*').eq('content_item_id', contentId),
    supabase.from('comment_threads').select('*').eq('content_item_id', contentId),
  ]);
  for (const result of [assetResult, approvalResult, taskResult, threadResult]) if (result.error) throw result.error;
  const requiredChecklist = checklist.filter((item) => item.required);
  const assetRequirements = requiredChecklist.filter((item) => item.category === 'assets');
  const currentApprovals = (approvalResult.data ?? []).filter((item) => item.material_revision === content.material_revision && item.required);
  const qualityErrors = Array.isArray(content.quality_flags)
    ? content.quality_flags.filter((flag: { severity?: string }) => flag.severity === 'error').length
    : 0;
  const readiness = calculateOperationalReadiness({
    format: content.format,
    hook: content.hook,
    caption: content.caption,
    cta: content.cta,
    visualBrief: content.visual_brief,
    qualityErrors,
    requiredAssets: assetRequirements.length,
    attachedRequiredAssets: (assetResult.data ?? []).length,
    requiredChecklist: requiredChecklist.length,
    completedChecklist: requiredChecklist.filter((item) => item.completed).length,
    requiredApprovals: currentApprovals.length,
    approvedApprovals: currentApprovals.filter((item) => item.status === 'approved').length,
    staleApprovals: (approvalResult.data ?? []).filter((item) => item.status === 'stale').length,
    blockingTasks: (taskResult.data ?? []).filter((item) => item.blocks_completion && !['done', 'cancelled'].includes(item.status)).length,
    blockingThreads: (threadResult.data ?? []).filter((item) => item.blocks_approval && item.status !== 'resolved').length,
  });
  return {
    content,
    readiness,
    checklist,
    assets: assetResult.data ?? [],
    approvals: approvalResult.data ?? [],
    tasks: taskResult.data ?? [],
    threads: threadResult.data ?? [],
  };
}

phase3.get('/v3/brands/:brandId/operations', async (c) => {
  const brandId = c.req.param('brandId');
  const supabase = c.get('supabase');
  const workspaceId = await workspaceForBrand(supabase, brandId);
  const [campaigns, content, tasks, assets, approvals, members, activityResult] = await Promise.all([
    supabase.from('campaigns').select('*').eq('brand_id', brandId).order('start_date', { ascending: false }),
    supabase.from('content_items').select('*').eq('brand_id', brandId).order('scheduled_date'),
    supabase.from('tasks').select('*').eq('brand_id', brandId).order('due_at'),
    supabase.from('assets').select('*').eq('brand_id', brandId).order('created_at', { ascending: false }).limit(30),
    supabase.from('approval_requests').select('*, content_items(title, brand_id)').eq('approver_id', c.get('user').id).order('requested_at', { ascending: false }),
    supabase.from('workspace_members').select('*').eq('workspace_id', workspaceId).order('created_at'),
    supabase.from('activity_events').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(40),
  ]);
  for (const result of [campaigns, content, tasks, assets, approvals, members, activityResult]) if (result.error) throw result.error;
  const campaignRows = campaigns.data ?? [];
  const deliverableResult = campaignRows.length
    ? await supabase.from('campaign_deliverables').select('*').in('campaign_id', campaignRows.map((item) => item.id))
    : { data: [], error: null };
  if (deliverableResult.error) throw deliverableResult.error;
  const health = Object.fromEntries(campaignRows.map((campaign) => [campaign.id, campaignHealth({
    deliverables: (deliverableResult.data ?? []).filter((item) => item.campaign_id === campaign.id),
    tasks: (tasks.data ?? []).filter((item) => item.campaign_id === campaign.id),
  })]));
  return c.json({
    campaigns: campaignRows,
    campaign_health: health,
    deliverables: deliverableResult.data ?? [],
    content: content.data ?? [],
    tasks: tasks.data ?? [],
    assets: assets.data ?? [],
    approvals: approvals.data ?? [],
    members: members.data ?? [],
    activity: activityResult.data ?? [],
  });
});

phase3.get('/v3/brands/:brandId/campaigns', async (c) => {
  const { data, error } = await c.get('supabase').from('campaigns').select('*')
    .eq('brand_id', c.req.param('brandId')).order('start_date', { ascending: false });
  if (error) throw error;
  return c.json({ campaigns: data ?? [] });
});

phase3.post('/v3/brands/:brandId/campaigns', async (c) => {
  const input = await body(c, campaignInputSchema);
  const brandId = c.req.param('brandId');
  const supabase = c.get('supabase');
  const user = c.get('user');
  const { data, error } = await supabase.from('campaigns').insert({ brand_id: brandId, ...input }).select('*').single();
  if (error) throw error;
  if (input.campaign_facts.length) {
    const { error: memoryError } = await supabase.from('memory_items').insert(input.campaign_facts.map((fact) => ({
      brand_id: brandId,
      memory_type: 'temporary_context',
      statement: fact.statement,
      scope: { campaign_id: data.id },
      durability: 'temporary',
      confidence: 1,
      status: 'confirmed',
      origin: 'explicit',
      evidence_count: 1,
      valid_from: input.start_date,
      valid_until: fact.valid_until ?? input.end_date,
      confirmed_by: user.id,
      confirmed_at: new Date().toISOString(),
    })));
    if (memoryError) throw memoryError;
  }
  await activity(supabase, { brandId, actorId: user.id, eventType: 'campaign.created', entityType: 'campaign', entityId: data.id, metadata: { name: data.name } });
  return c.json(data, 201);
});

phase3.get('/v3/campaigns/:campaignId', async (c) => {
  const supabase = c.get('supabase');
  const campaignId = c.req.param('campaignId');
  const { data: campaign, error } = await supabase.from('campaigns').select('*').eq('id', campaignId).single();
  if (error) throw error;
  const [deliverables, content, tasks, assets] = await Promise.all([
    supabase.from('campaign_deliverables').select('*').eq('campaign_id', campaignId).order('due_date'),
    supabase.from('content_items').select('*').eq('campaign_id', campaignId).order('scheduled_date'),
    supabase.from('tasks').select('*').eq('campaign_id', campaignId).order('due_at'),
    supabase.from('assets').select('*').eq('campaign_id', campaignId).order('created_at', { ascending: false }),
  ]);
  for (const result of [deliverables, content, tasks, assets]) if (result.error) throw result.error;
  return c.json({
    campaign,
    deliverables: deliverables.data ?? [],
    content: content.data ?? [],
    tasks: tasks.data ?? [],
    assets: assets.data ?? [],
    health: campaignHealth({ deliverables: deliverables.data ?? [], tasks: tasks.data ?? [] }),
  });
});

phase3.patch('/v3/campaigns/:campaignId', async (c) => {
  const input = await body(c, campaignPatchSchema);
  const supabase = c.get('supabase');
  const { data, error } = await supabase.from('campaigns').update(input).eq('id', c.req.param('campaignId')).select('*').single();
  if (error) throw error;
  await activity(supabase, { brandId: data.brand_id, actorId: c.get('user').id, eventType: 'campaign.updated', entityType: 'campaign', entityId: data.id, metadata: input });
  return c.json(data);
});

phase3.post('/v3/campaigns/:campaignId/brief/generate', async (c) => {
  const supabase = c.get('supabase');
  const campaignId = c.req.param('campaignId');
  const { data: campaign, error } = await supabase.from('campaigns').select('*').eq('id', campaignId).single();
  if (error) throw error;
  const bundle = await loadBrandBundle(supabase as never, campaign.brand_id);
  const { data: memories, error: memoryError } = await supabase.from('memory_items').select('*').eq('brand_id', campaign.brand_id);
  if (memoryError) throw memoryError;
  const memoryContext = compileMemoryContext((memories ?? []) as MemoryItem[], {
    task: 'strategy', productIds: campaign.product_ids, audienceIds: campaign.audience_ids,
    platform: 'instagram', limit: 12,
  });
  const system = `You are Brandloom's campaign operations strategist. Convert confirmed campaign inputs into an executable campaign brief.
Do not invent offers, prices, availability, capabilities or product claims. Respect team capacity. Return objective, audience_summary, key_message, content_pillars, risks, deliverable_targets and operational_notes.`;
  const result = await generateStructured(c.env, campaignBriefSchema, system, { campaign, brand: bundle, memories: memoryContext.items });
  const { data, error: updateError } = await supabase.from('campaigns').update({
    objective: result.data.objective,
    key_message: result.data.key_message,
    deliverable_targets: result.data.deliverable_targets,
    restrictions: [...new Set([...(campaign.restrictions ?? []), ...result.data.risks])],
    capacity: { ...(campaign.capacity ?? {}), operational_notes: result.data.operational_notes, content_pillars: result.data.content_pillars, audience_summary: result.data.audience_summary },
  }).eq('id', campaignId).select('*').single();
  if (updateError) throw updateError;
  await activity(supabase, { brandId: campaign.brand_id, actorId: c.get('user').id, eventType: 'campaign.brief_generated', entityType: 'campaign', entityId: campaignId, metadata: { memory_ids: memoryContext.ids } });
  return c.json({ campaign: data, brief: result.data, memory_ids: memoryContext.ids });
});

phase3.post('/v3/campaigns/:campaignId/deliverables', async (c) => {
  const input = await body(c, z.object({ deliverables: z.array(deliverableSchema).min(1).max(50) }));
  const supabase = c.get('supabase');
  const { data: campaign, error } = await supabase.from('campaigns').select('brand_id').eq('id', c.req.param('campaignId')).single();
  if (error) throw error;
  const { data, error: insertError } = await supabase.from('campaign_deliverables').insert(input.deliverables.map((item) => ({ campaign_id: c.req.param('campaignId'), ...item }))).select('*');
  if (insertError) throw insertError;
  await activity(supabase, { brandId: campaign.brand_id, actorId: c.get('user').id, eventType: 'campaign.deliverables_added', entityType: 'campaign', entityId: c.req.param('campaignId'), metadata: { count: data?.length ?? 0 } });
  return c.json({ deliverables: data ?? [] }, 201);
});

phase3.post('/v3/campaigns/:campaignId/content', async (c) => {
  const input = await body(c, contentCreateSchema);
  const supabase = c.get('supabase');
  const user = c.get('user');
  const { data: campaign, error } = await supabase.from('campaigns').select('*').eq('id', c.req.param('campaignId')).single();
  if (error) throw error;
  const weeklyPlan = await ensureWeeklyPlan(supabase, campaign.brand_id, input.scheduled_date);
  const { data: content, error: contentError } = await supabase.from('content_items').insert({
    weekly_plan_id: weeklyPlan.id,
    brand_id: campaign.brand_id,
    campaign_id: campaign.id,
    product_id: input.product_id ?? null,
    owner_id: input.owner_id ?? user.id,
    scheduled_date: input.scheduled_date,
    platform: 'instagram',
    format: input.format,
    pillar: input.pillar,
    objective: input.objective || campaign.objective,
    title: input.title,
    hook: input.hook,
    caption: input.caption,
    cta: input.cta,
    visual_brief: input.visual_brief,
    hashtags: input.hashtags,
    facts_used: [],
    quality_flags: [],
    status: 'draft',
    workflow_status: input.hook && input.caption ? 'internal_review' : 'drafting',
    generation_metadata: { source: 'phase3_campaign' },
  }).select('*').single();
  if (contentError) throw contentError;
  const { data: version, error: versionError } = await supabase.from('content_versions').insert({
    content_item_id: content.id,
    version_number: 1,
    source: 'user_edit',
    snapshot: content,
  }).select('*').single();
  if (versionError) throw versionError;
  const { error: structureError } = await supabase.from('content_structures').insert({
    content_item_id: content.id,
    brand_id: campaign.brand_id,
    structure_type: input.format,
    structure: input.structure,
  });
  if (structureError) throw structureError;
  await ensureChecklist(supabase, content);
  const { error: deliverableError } = await supabase.from('campaign_deliverables').insert({
    campaign_id: campaign.id,
    content_item_id: content.id,
    deliverable_type: input.format,
    title: input.title,
    required: true,
    due_date: input.scheduled_date,
    status: 'in_progress',
  });
  if (deliverableError) throw deliverableError;
  await activity(supabase, { brandId: campaign.brand_id, actorId: user.id, eventType: 'content.created', entityType: 'content_item', entityId: content.id, metadata: { campaign_id: campaign.id, version_id: version.id } });
  return c.json(await contentReadiness(supabase, content.id), 201);
});

phase3.get('/v3/content-items/:contentId/operations', async (c) => c.json(await contentReadiness(c.get('supabase'), c.req.param('contentId'))));

phase3.patch('/v3/content-items/:contentId/operations', async (c) => {
  const input = await body(c, operationPatchSchema);
  const supabase = c.get('supabase');
  const contentId = c.req.param('contentId');
  const { data: current, error } = await supabase.from('content_items').select('*').eq('id', contentId).single();
  if (error) throw error;
  if (input.workflow_status && !canTransition(current.workflow_status as WorkflowStatus, input.workflow_status)) {
    return c.json({ error: `Cannot move content from ${current.workflow_status} to ${input.workflow_status}.` }, 409);
  }
  let campaign: Record<string, unknown> | null = null;
  const campaignId = input.campaign_id === undefined ? current.campaign_id : input.campaign_id;
  if (campaignId) {
    const result = await supabase.from('campaigns').select('*').eq('id', campaignId).single();
    if (result.error) throw result.error;
    campaign = result.data;
  }
  const warnings = input.scheduled_date ? validateReschedule({
    oldDate: current.scheduled_date,
    newDate: input.scheduled_date,
    campaignStart: campaign?.start_date as string | null | undefined,
    campaignEnd: campaign?.end_date as string | null | undefined,
    offerValidUntil: (campaign?.offer_details as { valid_until?: string } | undefined)?.valid_until,
    cta: current.cta,
  }) : [];
  if (warnings.length && !input.acknowledge_warnings) return c.json({ error: 'Rescheduling needs review.', warnings }, 409);
  if (input.workflow_status === 'ready_to_publish') {
    const detail = await contentReadiness(supabase, contentId);
    if (!detail.readiness.ready_to_publish) return c.json({ error: 'Content is not operationally ready.', readiness: detail.readiness }, 409);
  }
  const { acknowledge_warnings: _ack, ...patch } = input;
  const update = { ...patch, ...(input.workflow_status === 'completed' ? { completed_at: new Date().toISOString() } : {}) };
  const { data, error: updateError } = await supabase.from('content_items').update(update).eq('id', contentId).select('*').single();
  if (updateError) throw updateError;
  await activity(supabase, { brandId: data.brand_id, actorId: c.get('user').id, eventType: 'content.workflow_updated', entityType: 'content_item', entityId: contentId, metadata: { patch: update, warnings } });
  return c.json({ ...(await contentReadiness(supabase, contentId)), warnings });
});

phase3.post('/v3/brands/:brandId/tasks', async (c) => {
  const input = await body(c, taskInputSchema);
  const supabase = c.get('supabase');
  const { data, error } = await supabase.from('tasks').insert({ brand_id: c.req.param('brandId'), created_by: c.get('user').id, ...input }).select('*').single();
  if (error) throw error;
  if (data.owner_id && data.owner_id !== c.get('user').id) await notify(supabase, { brandId: data.brand_id, userId: data.owner_id, type: 'task_assigned', entityType: 'task', entityId: data.id, message: `You were assigned: ${data.title}` });
  await activity(supabase, { brandId: data.brand_id, actorId: c.get('user').id, eventType: 'task.created', entityType: 'task', entityId: data.id, metadata: { title: data.title } });
  return c.json(data, 201);
});

phase3.patch('/v3/tasks/:taskId', async (c) => {
  const input = await body(c, taskPatchSchema);
  const update = { ...input, ...(input.status === 'done' ? { completed_at: new Date().toISOString() } : {}) };
  const { data, error } = await c.get('supabase').from('tasks').update(update).eq('id', c.req.param('taskId')).select('*').single();
  if (error) throw error;
  await activity(c.get('supabase'), { brandId: data.brand_id, actorId: c.get('user').id, eventType: 'task.updated', entityType: 'task', entityId: data.id, metadata: update });
  return c.json(data);
});

phase3.post('/v3/tasks/:taskId/dependencies', async (c) => {
  const input = await body(c, z.object({ depends_on_task_id: z.string().uuid() }));
  const { data, error } = await c.get('supabase').from('task_dependencies').insert({ task_id: c.req.param('taskId'), depends_on_task_id: input.depends_on_task_id }).select('*').single();
  if (error) throw error;
  return c.json(data, 201);
});

phase3.post('/v3/brands/:brandId/assets/upload-url', async (c) => {
  const input = await body(c, assetInputSchema);
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'audio/mpeg', 'application/pdf'];
  if (!allowed.includes(input.mime_type)) return c.json({ error: 'Unsupported asset type.' }, 415);
  const supabase = c.get('supabase');
  const brandId = c.req.param('brandId');
  const path = `${brandId}/${crypto.randomUUID()}-${safeName(input.name)}`;
  const signed = await supabase.storage.from('brand-assets').createSignedUploadUrl(path);
  if (signed.error) throw signed.error;
  const orientation = input.width && input.height ? (input.width === input.height ? 'square' : input.width > input.height ? 'landscape' : 'portrait') : 'unknown';
  const { data, error } = await supabase.from('assets').insert({
    brand_id: brandId,
    ...input,
    storage_bucket: 'brand-assets',
    storage_path: path,
    orientation,
    uploaded_by: c.get('user').id,
  }).select('*').single();
  if (error) throw error;
  await activity(supabase, { brandId, actorId: c.get('user').id, eventType: 'asset.upload_requested', entityType: 'asset', entityId: data.id, metadata: { path, mime_type: input.mime_type } });
  return c.json({ asset: data, upload: signed.data }, 201);
});

phase3.patch('/v3/assets/:assetId', async (c) => {
  const input = await body(c, assetInputSchema.partial().extend({ approved: z.boolean().optional() }));
  const update = { ...input, ...(input.approved ? { approved_by: c.get('user').id } : {}) };
  const { data, error } = await c.get('supabase').from('assets').update(update).eq('id', c.req.param('assetId')).select('*').single();
  if (error) throw error;
  return c.json(data);
});

phase3.post('/v3/content-items/:contentId/assets', async (c) => {
  const input = await body(c, assetAttachSchema);
  const { data, error } = await c.get('supabase').from('content_assets').insert({ content_item_id: c.req.param('contentId'), ...input }).select('*').single();
  if (error) throw error;
  return c.json({ attachment: data, readiness: (await contentReadiness(c.get('supabase'), c.req.param('contentId'))).readiness }, 201);
});

phase3.get('/v3/content-items/:contentId/checklist', async (c) => {
  const { data: content, error } = await c.get('supabase').from('content_items').select('*').eq('id', c.req.param('contentId')).single();
  if (error) throw error;
  return c.json({ checklist: await ensureChecklist(c.get('supabase'), content) });
});

phase3.patch('/v3/checklist-items/:itemId', async (c) => {
  const input = await body(c, checklistPatchSchema);
  const update = { completed: input.completed, completed_by: input.completed ? c.get('user').id : null, completed_at: input.completed ? new Date().toISOString() : null };
  const { data, error } = await c.get('supabase').from('content_checklist_items').update(update).eq('id', c.req.param('itemId')).select('*').single();
  if (error) throw error;
  return c.json(data);
});

phase3.post('/v3/content-items/:contentId/approval-requests', async (c) => {
  const input = await body(c, approvalInputSchema);
  const supabase = c.get('supabase');
  const contentId = c.req.param('contentId');
  const { data: content, error } = await supabase.from('content_items').select('*').eq('id', contentId).single();
  if (error) throw error;
  const version = await latestVersion(supabase, contentId);
  const { data, error: insertError } = await supabase.from('approval_requests').insert({
    content_item_id: contentId,
    content_version_id: version.id,
    material_revision: content.material_revision,
    requested_by: c.get('user').id,
    ...input,
  }).select('*').single();
  if (insertError) throw insertError;
  await supabase.from('content_items').update({ workflow_status: 'ready_for_approval' }).eq('id', contentId);
  await notify(supabase, { brandId: content.brand_id, userId: input.approver_id, type: 'approval_requested', entityType: 'approval_request', entityId: data.id, message: `Approval requested for ${content.title}` });
  await activity(supabase, { brandId: content.brand_id, actorId: c.get('user').id, eventType: 'approval.requested', entityType: 'approval_request', entityId: data.id, metadata: { content_id: contentId, version_id: version.id } });
  return c.json(data, 201);
});

phase3.post('/v3/approval-requests/:requestId/decision', async (c) => {
  const input = await body(c, approvalDecisionSchema);
  const supabase = c.get('supabase');
  const { data: request, error } = await supabase.from('approval_requests').select('*, content_items(*)').eq('id', c.req.param('requestId')).single();
  if (error) throw error;
  if (request.status === 'stale') return c.json({ error: 'This approval belongs to an older content version.' }, 409);
  const status = input.decision;
  const { data, error: updateError } = await supabase.from('approval_requests').update({ status, decision_comment: input.comment, decided_at: new Date().toISOString() }).eq('id', request.id).select('*').single();
  if (updateError) throw updateError;
  const content = request.content_items;
  if (status === 'changes_requested') {
    await supabase.from('content_items').update({ workflow_status: 'changes_requested' }).eq('id', content.id);
    await supabase.from('tasks').insert({ brand_id: content.brand_id, campaign_id: content.campaign_id, content_item_id: content.id, title: `Resolve approval feedback: ${content.title}`, description: input.comment, task_type: 'review', owner_id: content.owner_id, status: 'todo', blocks_completion: true, created_by: c.get('user').id });
  } else {
    const { data: remaining, error: remainingError } = await supabase.from('approval_requests').select('*').eq('content_item_id', content.id).eq('material_revision', content.material_revision).eq('required', true);
    if (remainingError) throw remainingError;
    if ((remaining ?? []).every((item) => item.id === request.id || item.status === 'approved')) await supabase.from('content_items').update({ workflow_status: 'approved' }).eq('id', content.id);
  }
  if (request.requested_by) await notify(supabase, { brandId: content.brand_id, userId: request.requested_by, type: `approval_${status}`, entityType: 'approval_request', entityId: request.id, message: `${content.title}: ${status.replace('_', ' ')}` });
  await activity(supabase, { brandId: content.brand_id, actorId: c.get('user').id, eventType: `approval.${status}`, entityType: 'approval_request', entityId: request.id, metadata: { comment: input.comment } });
  return c.json(data);
});

phase3.post('/v3/content-items/:contentId/threads', async (c) => {
  const input = await body(c, threadInputSchema);
  const supabase = c.get('supabase');
  const contentId = c.req.param('contentId');
  const version = await latestVersion(supabase, contentId);
  const { data: thread, error } = await supabase.from('comment_threads').insert({
    content_item_id: contentId,
    content_version_id: version.id,
    field: input.field,
    change_type: input.change_type ?? null,
    blocks_approval: input.blocks_approval,
    created_by: c.get('user').id,
  }).select('*').single();
  if (error) throw error;
  const { data: comment, error: commentError } = await supabase.from('comments').insert({ thread_id: thread.id, author_id: c.get('user').id, body: input.body }).select('*').single();
  if (commentError) throw commentError;
  if (input.blocks_approval) await supabase.from('content_items').update({ workflow_status: 'changes_requested' }).eq('id', contentId);
  return c.json({ thread, comments: [comment] }, 201);
});

phase3.post('/v3/threads/:threadId/comments', async (c) => {
  const input = await body(c, commentInputSchema);
  const { data, error } = await c.get('supabase').from('comments').insert({ thread_id: c.req.param('threadId'), author_id: c.get('user').id, body: input.body }).select('*').single();
  if (error) throw error;
  return c.json(data, 201);
});

phase3.post('/v3/threads/:threadId/resolve', async (c) => {
  const { data, error } = await c.get('supabase').from('comment_threads').update({ status: 'resolved', resolved_by: c.get('user').id, resolved_at: new Date().toISOString() }).eq('id', c.req.param('threadId')).select('*').single();
  if (error) throw error;
  return c.json(data);
});

phase3.post('/v3/workspaces/:workspaceId/invitations', async (c) => {
  const input = await body(c, invitationInputSchema);
  const token = randomToken();
  const tokenHash = await sha256(token);
  const expiresAt = new Date(Date.now() + input.expires_in_days * 86_400_000).toISOString();
  const { data, error } = await c.get('supabase').from('workspace_invitations').insert({
    workspace_id: c.req.param('workspaceId'),
    email: input.email.toLowerCase(),
    role: input.role,
    token_hash: tokenHash,
    invited_by: c.get('user').id,
    expires_at: expiresAt,
  }).select('id, workspace_id, email, role, status, expires_at').single();
  if (error) throw error;
  return c.json({ invitation: data, token }, 201);
});

phase3.post('/v3/invitations/accept', async (c) => {
  const input = await body(c, z.object({ token: z.string().min(32).max(256) }));
  const { data, error } = await c.get('supabase').rpc('accept_workspace_invitation', { p_token: input.token });
  if (error) throw error;
  return c.json({ workspace_id: data });
});

phase3.patch('/v3/workspace-members/:memberId', async (c) => {
  const input = await body(c, memberPatchSchema);
  const { data, error } = await c.get('supabase').from('workspace_members').update(input).eq('id', c.req.param('memberId')).select('*').single();
  if (error) throw error;
  return c.json(data);
});

phase3.get('/v3/notifications', async (c) => {
  const { data, error } = await c.get('supabase').from('notifications').select('*').eq('user_id', c.get('user').id).order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  return c.json({ notifications: data ?? [] });
});

phase3.post('/v3/notifications/:notificationId/read', async (c) => {
  const { data, error } = await c.get('supabase').from('notifications').update({ read_at: new Date().toISOString() }).eq('id', c.req.param('notificationId')).select('*').single();
  if (error) throw error;
  return c.json(data);
});

phase3.post('/v3/content-items/:contentId/export', async (c) => {
  const input = await body(c, exportInputSchema);
  const supabase = c.get('supabase');
  const detail = await contentReadiness(supabase, c.req.param('contentId'));
  if (!['approved', 'ready_to_publish', 'completed'].includes(detail.content.workflow_status)) return c.json({ error: 'Only approved content can be exported for publishing handoff.' }, 409);
  const version = await latestVersion(supabase, detail.content.id);
  const payload = {
    content: detail.content,
    version_id: version.id,
    assets: detail.assets,
    checklist: detail.checklist,
    approvals: detail.approvals.filter((item) => item.material_revision === detail.content.material_revision),
    readiness: detail.readiness,
    generated_at: new Date().toISOString(),
  };
  const valueChecksum = await checksum(payload);
  const { data, error } = await supabase.from('export_packages').insert({
    brand_id: detail.content.brand_id,
    campaign_id: input.campaign_id ?? detail.content.campaign_id,
    content_item_id: detail.content.id,
    content_version_id: version.id,
    export_format: input.export_format,
    payload,
    checksum: valueChecksum,
    created_by: c.get('user').id,
  }).select('*').single();
  if (error) throw error;
  await activity(supabase, { brandId: detail.content.brand_id, actorId: c.get('user').id, eventType: 'content.exported', entityType: 'export_package', entityId: data.id, metadata: { format: input.export_format, checksum: valueChecksum } });
  return c.json(data, 201);
});

phase3.post('/v3/campaigns/:campaignId/export', async (c) => {
  const input = await body(c, exportInputSchema);
  const supabase = c.get('supabase');
  const { data: campaign, error } = await supabase.from('campaigns').select('*').eq('id', c.req.param('campaignId')).single();
  if (error) throw error;
  const [content, deliverables, tasks, assets] = await Promise.all([
    supabase.from('content_items').select('*').eq('campaign_id', campaign.id).in('workflow_status', ['approved', 'ready_to_publish', 'completed']).order('scheduled_date'),
    supabase.from('campaign_deliverables').select('*').eq('campaign_id', campaign.id),
    supabase.from('tasks').select('*').eq('campaign_id', campaign.id),
    supabase.from('assets').select('*').eq('campaign_id', campaign.id),
  ]);
  for (const result of [content, deliverables, tasks, assets]) if (result.error) throw result.error;
  const payload = { campaign, content: content.data ?? [], deliverables: deliverables.data ?? [], tasks: tasks.data ?? [], assets: assets.data ?? [], generated_at: new Date().toISOString() };
  const valueChecksum = await checksum(payload);
  const { data, error: exportError } = await supabase.from('export_packages').insert({
    brand_id: campaign.brand_id,
    campaign_id: campaign.id,
    export_format: input.export_format === 'copy_package' ? 'campaign_bundle' : input.export_format,
    payload,
    checksum: valueChecksum,
    created_by: c.get('user').id,
  }).select('*').single();
  if (exportError) throw exportError;
  return c.json(data, 201);
});

export default phase3;
