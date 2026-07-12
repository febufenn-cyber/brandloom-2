import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { generateStructured } from './ai';
import { createUserClient, loadBrandBundle } from './db';
import { buildRepetitionReport, compileMemoryContext, mergeCandidate, type MemoryItem } from './memory';
import { validateDraft } from './quality';
import { contentPatchSchema, generatedPostsSchema, weeklyStrategySchema } from './schemas';
import type { Env, Variables } from './types';

const phase2 = new Hono<{ Bindings: Env; Variables: Variables }>();

const memoryTypeSchema = z.enum([
  'voice_preference', 'selling_style', 'factual_rule', 'compliance_restriction',
  'product_lesson', 'audience_lesson', 'campaign_lesson', 'temporary_context',
  'repetition_warning', 'strategic_suggestion',
]);

const memoryScopeSchema = z.object({
  product_id: z.string().uuid().nullable().optional(),
  audience_id: z.string().uuid().nullable().optional(),
  platform: z.string().max(80).nullable().optional(),
  language_mode: z.string().max(80).nullable().optional(),
  campaign_id: z.string().uuid().nullable().optional(),
}).default({});

const memoryInputSchema = z.object({
  memory_type: memoryTypeSchema,
  statement: z.string().min(3).max(2000),
  structured_value: z.record(z.unknown()).default({}),
  scope: memoryScopeSchema,
  durability: z.enum(['permanent', 'stable', 'temporary', 'experiment']).default('stable'),
  valid_from: z.string().date().nullable().optional(),
  valid_until: z.string().date().nullable().optional(),
});

const memoryPatchSchema = memoryInputSchema.partial().extend({
  confidence: z.number().min(0).max(1).optional(),
  status: z.enum(['candidate', 'suggested', 'confirmed', 'active', 'paused', 'contradicted', 'superseded', 'expired', 'rejected']).optional(),
});

const decisionSchema = z.object({
  note: z.string().max(2000).default(''),
  scope: memoryScopeSchema.optional(),
  valid_until: z.string().date().nullable().optional(),
});

const regenerateSchema = z.object({
  fields: z.array(z.enum(['title', 'hook', 'caption', 'cta', 'visual_brief', 'hashtags'])).min(1).max(6),
  instruction: z.string().max(1200).default(''),
});

const editAnalysisSchema = z.object({
  meaningful: z.boolean(),
  summary: z.string(),
  removed_patterns: z.array(z.string()).max(20),
  added_concepts: z.array(z.string()).max(20),
  tone_changes: z.record(z.number().min(-1).max(1)),
  candidate_memories: z.array(z.object({
    memory_type: memoryTypeSchema,
    statement: z.string().min(3).max(2000),
    scope: memoryScopeSchema,
    durability: z.enum(['permanent', 'stable', 'temporary', 'experiment']),
    confidence: z.number().min(0.05).max(0.85),
    rationale: z.string(),
  })).max(8),
});

const learningReviewSchema = z.object({
  summary: z.string(),
  observations: z.array(z.object({ signal: z.string(), evidence: z.string(), importance: z.enum(['low', 'medium', 'high']) })).max(20),
  candidate_memories: z.array(z.object({
    memory_type: memoryTypeSchema,
    statement: z.string().min(3).max(2000),
    scope: memoryScopeSchema,
    durability: z.enum(['permanent', 'stable', 'temporary', 'experiment']),
    confidence: z.number().min(0.05).max(0.85),
    rationale: z.string(),
  })).max(10),
  retire_suggestions: z.array(z.object({ memory_id: z.string().uuid().nullable(), statement: z.string(), reason: z.string() })).max(10),
  experiment_suggestions: z.array(z.object({ hypothesis: z.string(), variants: z.array(z.string()).min(2).max(5), success_metric: z.string() })).max(6),
});

const experimentInputSchema = z.object({
  hypothesis: z.string().min(5).max(2000),
  variants: z.array(z.string().min(1).max(1000)).min(2).max(6),
  success_metric: z.string().max(300).default('accepted_without_major_rewrite'),
  start_date: z.string().date().nullable().optional(),
  end_date: z.string().date().nullable().optional(),
  status: z.enum(['proposed', 'active', 'completed', 'cancelled']).default('proposed'),
});

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await c.req.json());
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

async function loadMemoryRows(supabase: Variables['supabase'], brandId: string) {
  const { data, error } = await supabase.from('memory_items').select('*').eq('brand_id', brandId).order('confidence', { ascending: false });
  if (error) throw error;
  return (data ?? []) as MemoryItem[];
}

async function loadRecentContent(supabase: Variables['supabase'], brandId: string, limit = 50) {
  const { data, error } = await supabase.from('content_items')
    .select('id, hook, cta, pillar, product_id, scheduled_date')
    .eq('brand_id', brandId)
    .order('scheduled_date', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

async function recordGeneration(
  supabase: Variables['supabase'],
  input: {
    brandId: string;
    planId?: string;
    taskType: string;
    model: string;
    promptVersion: string;
    startedAt: number;
    usage?: { input_tokens: number; output_tokens: number };
    status: 'completed' | 'failed';
    error?: string;
    snapshot?: unknown;
  },
) {
  const { data, error } = await supabase.from('generation_runs').insert({
    brand_id: input.brandId,
    weekly_plan_id: input.planId ?? null,
    task_type: input.taskType,
    model: input.model,
    prompt_version: input.promptVersion,
    latency_ms: Date.now() - input.startedAt,
    input_tokens: input.usage?.input_tokens ?? 0,
    output_tokens: input.usage?.output_tokens ?? 0,
    status: input.status,
    error_message: input.error ?? '',
    input_snapshot: input.snapshot ?? {},
  }).select('id').single();
  if (error) throw error;
  return data.id as string;
}

async function recordRetrieval(
  supabase: Variables['supabase'],
  input: { brandId: string; runId: string; taskType: string; memoryIds: string[]; reason: string },
) {
  const { error } = await supabase.from('memory_retrieval_logs').insert({
    brand_id: input.brandId,
    generation_run_id: input.runId,
    task_type: input.taskType,
    memory_item_ids: input.memoryIds,
    retrieval_reason: input.reason,
    scores: {},
    context_size: input.memoryIds.length,
  });
  if (error) throw error;
}

async function saveCandidate(
  supabase: Variables['supabase'],
  input: {
    brandId: string;
    candidate: z.infer<typeof editAnalysisSchema>['candidate_memories'][number];
    sourceType: 'content_edit' | 'weekly_review';
    sourceId: string;
    beforeText?: string;
    afterText?: string;
    analysis?: unknown;
  },
) {
  const { data: existing, error: existingError } = await supabase.from('memory_items')
    .select('*')
    .eq('brand_id', input.brandId)
    .eq('memory_type', input.candidate.memory_type)
    .eq('statement', input.candidate.statement)
    .limit(1)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing?.status === 'rejected') return existing;

  let memory: Record<string, unknown>;
  if (existing) {
    const merged = mergeCandidate(existing as MemoryItem, 1, input.candidate.confidence);
    const { data, error } = await supabase.from('memory_items').update({
      ...merged,
      scope: Object.keys(input.candidate.scope).length ? input.candidate.scope : existing.scope,
      durability: input.candidate.durability,
    }).eq('id', existing.id).select('*').single();
    if (error) throw error;
    memory = data;
  } else {
    const { data, error } = await supabase.from('memory_items').insert({
      brand_id: input.brandId,
      memory_type: input.candidate.memory_type,
      statement: input.candidate.statement,
      scope: input.candidate.scope,
      durability: input.candidate.durability,
      confidence: input.candidate.confidence,
      status: 'candidate',
      origin: input.sourceType === 'content_edit' ? 'edit_analysis' : 'weekly_review',
      evidence_count: 1,
    }).select('*').single();
    if (error) throw error;
    memory = data;
  }

  const { error: evidenceError } = await supabase.from('memory_evidence').insert({
    brand_id: input.brandId,
    memory_item_id: memory.id,
    source_type: input.sourceType,
    source_id: input.sourceId,
    before_text: input.beforeText ?? '',
    after_text: input.afterText ?? '',
    analysis: { candidate: input.candidate, context: input.analysis ?? {} },
    weight: input.candidate.confidence,
  });
  if (evidenceError) throw evidenceError;
  return memory;
}

async function analyseEdit(
  env: Env,
  supabase: Variables['supabase'],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  versionId: string,
) {
  const fields = ['title', 'hook', 'caption', 'cta', 'visual_brief'];
  const changed = fields.some((field) => String(before[field] ?? '') !== String(after[field] ?? ''));
  if (!changed) return null;

  const system = `You analyse an editor's before/after changes to marketing content. Identify durable preferences cautiously.
One edit is evidence, not a permanent rule. Do not infer factual business information from wording changes.
Candidate confidence must remain at or below 0.55 for a single edit unless the edit explicitly removes a safety/compliance violation.
Return JSON with meaningful, summary, removed_patterns, added_concepts, tone_changes, and candidate_memories.`;
  const result = await generateStructured(env, editAnalysisSchema, system, { before, after });
  const { data: analysis, error } = await supabase.from('edit_analyses').insert({
    brand_id: after.brand_id,
    content_item_id: after.id,
    content_version_id: versionId,
    meaningful: result.data.meaningful,
    summary: result.data.summary,
    removed_patterns: result.data.removed_patterns,
    added_concepts: result.data.added_concepts,
    tone_changes: result.data.tone_changes,
    candidate_memories: result.data.candidate_memories,
    model: env.ANTHROPIC_MODEL,
    prompt_version: 'edit-analysis-v1',
  }).select('*').single();
  if (error) throw error;

  if (result.data.meaningful) {
    for (const candidate of result.data.candidate_memories) {
      await saveCandidate(supabase, {
        brandId: String(after.brand_id),
        candidate,
        sourceType: 'content_edit',
        sourceId: String(after.id),
        beforeText: JSON.stringify(before),
        afterText: JSON.stringify(after),
        analysis,
      });
    }
  }
  return analysis;
}

phase2.get('/v2/brands/:brandId/memories', async (c) => {
  const supabase = c.get('supabase');
  const status = c.req.query('status');
  let query = supabase.from('memory_items').select('*, memory_evidence(count)').eq('brand_id', c.req.param('brandId'));
  if (status) query = query.eq('status', status);
  const { data, error } = await query.order('confidence', { ascending: false }).order('updated_at', { ascending: false });
  if (error) throw error;
  return c.json({ memories: data ?? [] });
});

phase2.get('/v2/brands/:brandId/learning-inbox', async (c) => {
  const { data, error } = await c.get('supabase').from('memory_items')
    .select('*, memory_evidence(*)')
    .eq('brand_id', c.req.param('brandId'))
    .in('status', ['candidate', 'suggested', 'contradicted'])
    .order('confidence', { ascending: false });
  if (error) throw error;
  return c.json({ memories: data ?? [] });
});

phase2.post('/v2/brands/:brandId/memories', async (c) => {
  const input = await body(c, memoryInputSchema);
  const user = c.get('user');
  const supabase = c.get('supabase');
  const { data, error } = await supabase.from('memory_items').insert({
    brand_id: c.req.param('brandId'),
    ...input,
    confidence: 1,
    status: 'confirmed',
    origin: 'explicit',
    evidence_count: 1,
    confirmed_by: user.id,
    confirmed_at: new Date().toISOString(),
  }).select('*').single();
  if (error) throw error;
  await supabase.from('memory_evidence').insert({
    brand_id: c.req.param('brandId'),
    memory_item_id: data.id,
    source_type: 'explicit_instruction',
    before_text: '',
    after_text: input.statement,
    analysis: { explicit: true },
    weight: 1,
  });
  return c.json(data, 201);
});

phase2.patch('/v2/memories/:memoryId', async (c) => {
  const input = await body(c, memoryPatchSchema);
  const { data, error } = await c.get('supabase').from('memory_items').update(input).eq('id', c.req.param('memoryId')).select('*').single();
  if (error) throw error;
  return c.json(data);
});

phase2.delete('/v2/memories/:memoryId', async (c) => {
  const { error } = await c.get('supabase').from('memory_items').delete().eq('id', c.req.param('memoryId'));
  if (error) throw error;
  return c.body(null, 204);
});

async function decideMemory(c: Context, decision: 'confirm' | 'reject' | 'pause' | 'reactivate') {
  const input = await body(c, decisionSchema);
  const supabase = c.get('supabase');
  const { data: before, error: beforeError } = await supabase.from('memory_items').select('*').eq('id', c.req.param('memoryId')).single();
  if (beforeError) throw beforeError;
  const status = decision === 'confirm' ? 'confirmed' : decision === 'reactivate' ? 'active' : decision === 'pause' ? 'paused' : 'rejected';
  const patch: Record<string, unknown> = { status };
  if (decision === 'confirm' || decision === 'reactivate') {
    patch.confirmed_by = c.get('user').id;
    patch.confirmed_at = new Date().toISOString();
    patch.confidence = Math.max(Number(before.confidence), 0.9);
  }
  if (input.scope) patch.scope = input.scope;
  if (input.valid_until !== undefined) patch.valid_until = input.valid_until;
  const { data, error } = await supabase.from('memory_items').update(patch).eq('id', before.id).select('*').single();
  if (error) throw error;
  await supabase.from('memory_confirmations').insert({
    brand_id: before.brand_id,
    memory_item_id: before.id,
    user_id: c.get('user').id,
    decision,
    note: input.note,
    previous_snapshot: before,
  });
  return c.json(data);
}

phase2.post('/v2/memories/:memoryId/confirm', (c) => decideMemory(c, 'confirm'));
phase2.post('/v2/memories/:memoryId/reject', (c) => decideMemory(c, 'reject'));
phase2.post('/v2/memories/:memoryId/pause', (c) => decideMemory(c, 'pause'));
phase2.post('/v2/memories/:memoryId/reactivate', (c) => decideMemory(c, 'reactivate'));

phase2.patch('/v2/content-items/:contentId', async (c) => {
  const input = await body(c, contentPatchSchema);
  const supabase = c.get('supabase');
  const { data: before, error: beforeError } = await supabase.from('content_items').select('*').eq('id', c.req.param('contentId')).single();
  if (beforeError) throw beforeError;
  const { data: after, error } = await supabase.from('content_items').update(input).eq('id', before.id).select('*').single();
  if (error) throw error;
  const { data: latest } = await supabase.from('content_versions').select('version_number').eq('content_item_id', before.id).order('version_number', { ascending: false }).limit(1).maybeSingle();
  const { data: version, error: versionError } = await supabase.from('content_versions').insert({
    content_item_id: before.id,
    version_number: (latest?.version_number ?? 0) + 1,
    source: 'user_edit',
    snapshot: after,
    previous_snapshot: before,
  }).select('id').single();
  if (versionError) throw versionError;
  c.executionCtx.waitUntil(analyseEdit(c.env, supabase, before, after, version.id).catch((analysisError) => console.error('Edit analysis failed', analysisError)));
  return c.json(after);
});

phase2.post('/v2/content-items/:contentId/analyse-edit', async (c) => {
  const supabase = c.get('supabase');
  const { data: versions, error } = await supabase.from('content_versions')
    .select('*').eq('content_item_id', c.req.param('contentId')).order('version_number', { ascending: false }).limit(2);
  if (error) throw error;
  if (!versions || versions.length < 2) return c.json({ error: 'At least two versions are required.' }, 409);
  const analysis = await analyseEdit(c.env, supabase, versions[1].snapshot, versions[0].snapshot, versions[0].id);
  return c.json({ analysis });
});

phase2.post('/v2/weekly-plans/:planId/strategy/generate', async (c) => {
  const planId = c.req.param('planId');
  const supabase = c.get('supabase');
  const { data: plan, error } = await supabase.from('weekly_plans').select('*').eq('id', planId).single();
  if (error) throw error;
  const bundle = await loadBrandBundle(supabase as ReturnType<typeof createUserClient>, plan.brand_id);
  if (!bundle.profile?.constitution) return c.json({ error: 'Generate and approve a Brand Constitution first.' }, 409);
  const memories = await loadMemoryRows(supabase, plan.brand_id);
  const memoryContext = compileMemoryContext(memories, {
    task: 'strategy',
    productIds: plan.featured_product_ids ?? [],
    platform: 'instagram',
    languageMode: plan.language_mode,
  });
  const repetition = buildRepetitionReport(await loadRecentContent(supabase, plan.brand_id));
  const startedAt = Date.now();
  const promptVersion = 'weekly-strategy-memory-v1';
  const payload = {
    plan,
    brand: bundle.brand,
    constitution: bundle.profile.constitution,
    products: bundle.products,
    audiences: bundle.audiences,
    confirmed_memory: memoryContext.items,
    recent_repetition: repetition.warnings,
  };
  const system = `You are Brandloom's weekly campaign strategist. Produce one coherent Instagram plan, not seven unrelated ideas.
Confirmed memory is evidence-backed and should be followed within its scope. Repetition warnings should create variety, not random novelty.
Never use candidate, rejected, paused or expired memories. Never invent product facts.
Return JSON with narrative, rationale, distribution, and days. Each day needs scheduled_date, title, objective, pillar, format, topic, cta, and product_id or null.`;
  try {
    const result = await generateStructured(c.env, weeklyStrategySchema, system, payload);
    const validProductIds = new Set(bundle.products.map((product) => product.id));
    const strategy = { ...result.data, days: result.data.days.map((day) => ({ ...day, product_id: day.product_id && validProductIds.has(day.product_id) ? day.product_id : null })) };
    const { data, error: updateError } = await supabase.from('weekly_plans').update({ strategy, status: 'planned' }).eq('id', planId).select('*').single();
    if (updateError) throw updateError;
    const runId = await recordGeneration(supabase, { brandId: plan.brand_id, planId, taskType: 'weekly_strategy_memory', model: c.env.ANTHROPIC_MODEL, promptVersion, startedAt, usage: result.usage, status: 'completed', snapshot: payload });
    await recordRetrieval(supabase, { brandId: plan.brand_id, runId, taskType: 'strategy', memoryIds: memoryContext.ids, reason: 'Confirmed, scoped and non-expired memories for weekly planning.' });
    return c.json(data);
  } catch (generationError) {
    await recordGeneration(supabase, { brandId: plan.brand_id, planId, taskType: 'weekly_strategy_memory', model: c.env.ANTHROPIC_MODEL, promptVersion, startedAt, status: 'failed', error: generationError instanceof Error ? generationError.message : String(generationError) });
    throw generationError;
  }
});

phase2.post('/v2/weekly-plans/:planId/posts/generate', async (c) => {
  const planId = c.req.param('planId');
  const supabase = c.get('supabase');
  const { data: plan, error } = await supabase.from('weekly_plans').select('*').eq('id', planId).single();
  if (error) throw error;
  if (!plan.strategy) return c.json({ error: 'Generate the weekly strategy first.' }, 409);
  const bundle = await loadBrandBundle(supabase as ReturnType<typeof createUserClient>, plan.brand_id);
  const memories = await loadMemoryRows(supabase, plan.brand_id);
  const memoryContext = compileMemoryContext(memories, {
    task: 'writing',
    productIds: plan.featured_product_ids ?? [],
    platform: 'instagram',
    languageMode: plan.language_mode,
  });
  const repetition = buildRepetitionReport(await loadRecentContent(supabase, plan.brand_id));
  const startedAt = Date.now();
  const promptVersion = 'weekly-posts-memory-v1';
  const payload = {
    plan,
    brand: bundle.brand,
    constitution: bundle.profile?.constitution,
    voice_profile: bundle.profile,
    products: bundle.products,
    audiences: bundle.audiences,
    confirmed_memory: memoryContext.items,
    recent_repetition: repetition.warnings,
  };
  const system = `You are Brandloom's Instagram writer. Draft every item in the approved strategy while preserving one weekly narrative.
Follow confirmed memory only within its supplied scope. Avoid repetition warnings. Use only approved facts and list every factual statement in facts_used.
Do not invent prices, offers, ingredients, certifications, testimonials, medical claims or availability.
Return JSON {items:[...]}; each item needs scheduled_date, title, objective, pillar, platform="instagram", format, hook, caption, cta, visual_brief, hashtags, product_id or null, and facts_used.`;
  try {
    const result = await generateStructured(c.env, generatedPostsSchema, system, payload);
    const approvedFacts = unique([...(bundle.profile?.approved_claims ?? []), ...bundle.products.flatMap((product) => product.approved_facts ?? [])]);
    const memoryRestrictions = memoryContext.items.filter((item) => ['compliance_restriction', 'factual_rule'].includes(item.type)).map((item) => item.statement);
    const prohibitedPhrases = unique([...(bundle.profile?.prohibited_phrases ?? []), ...(bundle.profile?.prohibited_claims ?? []), ...bundle.products.flatMap((product) => product.restricted_claims ?? []), ...memoryRestrictions]);
    const hooks = result.data.items.map((item) => item.hook);
    const rows = result.data.items.map((item, index) => ({
      weekly_plan_id: planId,
      brand_id: plan.brand_id,
      product_id: item.product_id,
      scheduled_date: item.scheduled_date,
      platform: item.platform,
      format: item.format,
      pillar: item.pillar,
      objective: item.objective,
      title: item.title,
      hook: item.hook,
      caption: item.caption,
      cta: item.cta,
      visual_brief: item.visual_brief,
      hashtags: item.hashtags,
      facts_used: item.facts_used,
      quality_flags: validateDraft({ hook: item.hook, caption: item.caption, factsUsed: item.facts_used, approvedFacts, prohibitedPhrases, otherHooks: hooks.filter((_, hookIndex) => hookIndex !== index) }),
      status: 'draft',
      generation_metadata: { model: c.env.ANTHROPIC_MODEL, prompt_version: promptVersion, memory_item_ids: memoryContext.ids },
    }));
    await supabase.from('content_items').delete().eq('weekly_plan_id', planId).eq('status', 'draft');
    const { data: items, error: insertError } = await supabase.from('content_items').insert(rows).select('*');
    if (insertError) throw insertError;
    if (items?.length) {
      const { error: versionError } = await supabase.from('content_versions').insert(items.map((item) => ({ content_item_id: item.id, version_number: 1, source: 'generation', snapshot: item })));
      if (versionError) throw versionError;
      await supabase.from('content_features').upsert(items.map((item) => ({
        content_item_id: item.id,
        brand_id: item.brand_id,
        hook_type: String(item.hook).includes('?') ? 'question' : 'statement',
        emotional_angle: item.pillar,
        benefits_used: item.facts_used,
        objections_addressed: [],
        cta_type: String(item.cta).toLowerCase().includes('message') ? 'message' : 'action',
        language_mode: plan.language_mode,
        semantic_fingerprint: { hook: String(item.hook).toLowerCase(), cta: String(item.cta).toLowerCase() },
      })), { onConflict: 'content_item_id' });
    }
    await supabase.from('weekly_plans').update({ status: 'drafted' }).eq('id', planId);
    const runId = await recordGeneration(supabase, { brandId: plan.brand_id, planId, taskType: 'weekly_posts_memory', model: c.env.ANTHROPIC_MODEL, promptVersion, startedAt, usage: result.usage, status: 'completed', snapshot: payload });
    await recordRetrieval(supabase, { brandId: plan.brand_id, runId, taskType: 'writing', memoryIds: memoryContext.ids, reason: 'Confirmed memory relevant to the selected products, language and platform.' });
    return c.json({ items: items ?? [] });
  } catch (generationError) {
    await recordGeneration(supabase, { brandId: plan.brand_id, planId, taskType: 'weekly_posts_memory', model: c.env.ANTHROPIC_MODEL, promptVersion, startedAt, status: 'failed', error: generationError instanceof Error ? generationError.message : String(generationError) });
    throw generationError;
  }
});

phase2.post('/v2/content-items/:contentId/regenerate', async (c) => {
  const input = await body(c, regenerateSchema);
  const supabase = c.get('supabase');
  const { data: item, error } = await supabase.from('content_items').select('*, weekly_plans(*)').eq('id', c.req.param('contentId')).single();
  if (error) throw error;
  const bundle = await loadBrandBundle(supabase as ReturnType<typeof createUserClient>, item.brand_id);
  const memories = await loadMemoryRows(supabase, item.brand_id);
  const memoryContext = compileMemoryContext(memories, { task: 'regeneration', productIds: item.product_id ? [item.product_id] : [], platform: 'instagram', languageMode: item.weekly_plans?.language_mode });
  const fieldSchema = z.object({ title: z.string().optional(), hook: z.string().optional(), caption: z.string().optional(), cta: z.string().optional(), visual_brief: z.string().optional(), hashtags: z.array(z.string()).optional(), facts_used: z.array(z.string()).default(item.facts_used ?? []) });
  const result = await generateStructured(c.env, fieldSchema, `Rewrite only the requested fields. Follow confirmed memory within scope, preserve approved facts and never invent facts.`, { fields: input.fields, instruction: input.instruction, item, brand: bundle, confirmed_memory: memoryContext.items });
  const patch = Object.fromEntries(input.fields.filter((field) => result.data[field] !== undefined).map((field) => [field, result.data[field]]));
  const approvedFacts = unique([...(bundle.profile?.approved_claims ?? []), ...bundle.products.flatMap((product) => product.approved_facts ?? [])]);
  const prohibitedPhrases = unique([...(bundle.profile?.prohibited_phrases ?? []), ...(bundle.profile?.prohibited_claims ?? []), ...memoryContext.items.filter((entry) => entry.type === 'compliance_restriction').map((entry) => entry.statement)]);
  const nextItem = { ...item, ...patch, facts_used: result.data.facts_used };
  const qualityFlags = validateDraft({ hook: nextItem.hook, caption: nextItem.caption, factsUsed: nextItem.facts_used, approvedFacts, prohibitedPhrases });
  const { data, error: updateError } = await supabase.from('content_items').update({ ...patch, facts_used: result.data.facts_used, quality_flags: qualityFlags, generation_metadata: { ...item.generation_metadata, memory_item_ids: memoryContext.ids } }).eq('id', item.id).select('*').single();
  if (updateError) throw updateError;
  const { data: latest } = await supabase.from('content_versions').select('version_number').eq('content_item_id', item.id).order('version_number', { ascending: false }).limit(1).maybeSingle();
  await supabase.from('content_versions').insert({ content_item_id: item.id, version_number: (latest?.version_number ?? 0) + 1, source: 'regeneration', snapshot: data, previous_snapshot: item });
  return c.json(data);
});

phase2.get('/v2/brands/:brandId/repetition-report', async (c) => {
  const items = await loadRecentContent(c.get('supabase'), c.req.param('brandId'), 60);
  return c.json(buildRepetitionReport(items));
});

phase2.post('/v2/weekly-plans/:planId/learning-review', async (c) => {
  const planId = c.req.param('planId');
  const supabase = c.get('supabase');
  const { data: plan, error } = await supabase.from('weekly_plans').select('*').eq('id', planId).single();
  if (error) throw error;
  const { data: items, error: itemsError } = await supabase.from('content_items').select('*').eq('weekly_plan_id', planId).order('scheduled_date');
  if (itemsError) throw itemsError;
  const itemIds = (items ?? []).map((item) => item.id);
  const { data: versions, error: versionsError } = itemIds.length ? await supabase.from('content_versions').select('*').in('content_item_id', itemIds).order('created_at') : { data: [], error: null };
  if (versionsError) throw versionsError;
  const { data: feedback, error: feedbackError } = itemIds.length ? await supabase.from('feedback_events').select('*').in('content_item_id', itemIds).order('created_at') : { data: [], error: null };
  if (feedbackError) throw feedbackError;
  const memories = await loadMemoryRows(supabase, plan.brand_id);
  const repetition = buildRepetitionReport(await loadRecentContent(supabase, plan.brand_id));
  const system = `Create an evidence-based weekly learning review. Distinguish a repeated pattern from a one-off edit.
Do not infer factual business claims from copy edits. Candidate memories remain proposals and confidence must reflect evidence.
Return summary, observations, candidate_memories, retire_suggestions and experiment_suggestions.`;
  const result = await generateStructured(c.env, learningReviewSchema, system, { plan, items, versions, feedback, active_memories: memories.filter((memory) => ['confirmed', 'active'].includes(memory.status)), repetition });
  const { data: review, error: reviewError } = await supabase.from('weekly_learning_reviews').upsert({
    brand_id: plan.brand_id,
    weekly_plan_id: planId,
    summary: result.data.summary,
    observations: result.data.observations,
    candidate_memories: result.data.candidate_memories,
    retire_suggestions: result.data.retire_suggestions,
    experiment_suggestions: result.data.experiment_suggestions,
    status: 'ready',
  }, { onConflict: 'weekly_plan_id' }).select('*').single();
  if (reviewError) throw reviewError;
  for (const candidate of result.data.candidate_memories) {
    await saveCandidate(supabase, { brandId: plan.brand_id, candidate, sourceType: 'weekly_review', sourceId: planId, analysis: review });
  }
  return c.json(review);
});

phase2.get('/v2/weekly-plans/:planId/learning-review', async (c) => {
  const { data, error } = await c.get('supabase').from('weekly_learning_reviews').select('*').eq('weekly_plan_id', c.req.param('planId')).maybeSingle();
  if (error) throw error;
  return c.json({ review: data });
});

phase2.get('/v2/brands/:brandId/experiments', async (c) => {
  const { data, error } = await c.get('supabase').from('brand_experiments').select('*').eq('brand_id', c.req.param('brandId')).order('created_at', { ascending: false });
  if (error) throw error;
  return c.json({ experiments: data ?? [] });
});

phase2.post('/v2/brands/:brandId/experiments', async (c) => {
  const input = await body(c, experimentInputSchema);
  const { data, error } = await c.get('supabase').from('brand_experiments').insert({ brand_id: c.req.param('brandId'), ...input }).select('*').single();
  if (error) throw error;
  return c.json(data, 201);
});

phase2.patch('/v2/experiments/:experimentId', async (c) => {
  const input = await body(c, experimentInputSchema.partial());
  const { data, error } = await c.get('supabase').from('brand_experiments').update(input).eq('id', c.req.param('experimentId')).select('*').single();
  if (error) throw error;
  return c.json(data);
});

phase2.post('/v2/brands/:brandId/memory/reset', async (c) => {
  const { data, error } = await c.get('supabase').from('memory_items').update({ status: 'rejected' }).eq('brand_id', c.req.param('brandId')).neq('origin', 'explicit').select('id');
  if (error) throw error;
  return c.json({ reset_count: data?.length ?? 0 });
});

phase2.get('/v2/brands/:brandId/memory/export', async (c) => {
  const supabase = c.get('supabase');
  const brandId = c.req.param('brandId');
  const [{ data: memories, error: memoryError }, { data: reviews, error: reviewError }, { data: experiments, error: experimentError }] = await Promise.all([
    supabase.from('memory_items').select('*, memory_evidence(*)').eq('brand_id', brandId).order('created_at'),
    supabase.from('weekly_learning_reviews').select('*').eq('brand_id', brandId).order('created_at'),
    supabase.from('brand_experiments').select('*').eq('brand_id', brandId).order('created_at'),
  ]);
  if (memoryError) throw memoryError;
  if (reviewError) throw reviewError;
  if (experimentError) throw experimentError;
  return c.json({ exported_at: new Date().toISOString(), brand_id: brandId, memories: memories ?? [], learning_reviews: reviews ?? [], experiments: experiments ?? [] });
});

export default phase2;
