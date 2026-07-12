import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { z } from 'zod';
import { generateStructured } from './ai';
import { createUserClient, loadBrandBundle } from './db';
import { validateDraft } from './quality';
import { calculateReadiness } from './readiness';
import {
  audienceInputSchema,
  brandConstitutionSchema,
  brandInputSchema,
  brandPatchSchema,
  contentPatchSchema,
  feedbackInputSchema,
  generatedPostsSchema,
  productInputSchema,
  regenerateInputSchema,
  voiceProfileInputSchema,
  weeklyPlanInputSchema,
  weeklyStrategySchema,
} from './schemas';
import type { Env, Variables } from './types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use('*', logger());
app.use('*', cors({
  origin: (origin, c) => {
    const allowed = c.env.WEB_ORIGIN ?? 'http://localhost:5173';
    return !origin || origin === allowed ? allowed : '';
  },
  allowHeaders: ['Authorization', 'Content-Type'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

app.get('/health', (c) => c.json({ ok: true, service: 'brandloom-api' }));

app.use('/api/*', async (c, next) => {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) return c.json({ error: 'Authentication required.' }, 401);
  const token = header.slice(7);
  const supabase = createUserClient(c.env, token);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return c.json({ error: 'Invalid or expired session.' }, 401);
  c.set('token', token);
  c.set('user', data.user);
  c.set('supabase', supabase);
  await next();
});

async function jsonBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await c.req.json());
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
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
  await supabase.from('generation_runs').insert({
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
  });
}

app.get('/api/bootstrap', async (c) => {
  const supabase = c.get('supabase');
  const { data: brand, error } = await supabase.from('brands').select('*').order('created_at').limit(1).maybeSingle();
  if (error) throw error;
  if (!brand) return c.json({ user: c.get('user'), brand: null });
  const bundle = await loadBrandBundle(supabase as ReturnType<typeof createUserClient>, brand.id);
  const { data: plans, error: planError } = await supabase.from('weekly_plans').select('*').eq('brand_id', brand.id).order('week_start', { ascending: false }).limit(8);
  if (planError) throw planError;
  return c.json({ user: c.get('user'), ...bundle, plans: plans ?? [], readiness: calculateReadiness(bundle) });
});

app.post('/api/brands', async (c) => {
  const input = await jsonBody(c, brandInputSchema);
  const supabase = c.get('supabase');
  const { data, error } = await supabase.rpc('create_brand_workspace', { p_brand: input });
  if (error) throw error;
  const bundle = await loadBrandBundle(supabase as ReturnType<typeof createUserClient>, data as string);
  return c.json({ ...bundle, readiness: calculateReadiness(bundle) }, 201);
});

app.get('/api/brands/:brandId', async (c) => {
  const bundle = await loadBrandBundle(c.get('supabase') as ReturnType<typeof createUserClient>, c.req.param('brandId'));
  return c.json({ ...bundle, readiness: calculateReadiness(bundle) });
});

app.patch('/api/brands/:brandId', async (c) => {
  const input = await jsonBody(c, brandPatchSchema);
  const { data, error } = await c.get('supabase').from('brands').update(input).eq('id', c.req.param('brandId')).select('*').single();
  if (error) throw error;
  return c.json(data);
});

app.put('/api/brands/:brandId/voice-profile', async (c) => {
  const input = await jsonBody(c, voiceProfileInputSchema);
  const { data: existing, error: existingError } = await c.get('supabase')
    .from('brand_voice_profiles').select('version').eq('brand_id', c.req.param('brandId')).maybeSingle();
  if (existingError) throw existingError;
  const { data, error } = await c.get('supabase').from('brand_voice_profiles').upsert({
    brand_id: c.req.param('brandId'),
    ...input,
    version: (existing?.version ?? 0) + 1,
  }, { onConflict: 'brand_id' }).select('*').single();
  if (error) throw error;
  return c.json(data);
});

app.get('/api/brands/:brandId/readiness', async (c) => {
  const bundle = await loadBrandBundle(c.get('supabase') as ReturnType<typeof createUserClient>, c.req.param('brandId'));
  return c.json(calculateReadiness(bundle));
});

app.post('/api/brands/:brandId/products', async (c) => {
  const input = await jsonBody(c, productInputSchema);
  const { data, error } = await c.get('supabase').from('products').insert({ brand_id: c.req.param('brandId'), ...input }).select('*').single();
  if (error) throw error;
  return c.json(data, 201);
});

app.patch('/api/products/:productId', async (c) => {
  const input = await jsonBody(c, productInputSchema.partial());
  const { data, error } = await c.get('supabase').from('products').update(input).eq('id', c.req.param('productId')).select('*').single();
  if (error) throw error;
  return c.json(data);
});

app.delete('/api/products/:productId', async (c) => {
  const { error } = await c.get('supabase').from('products').delete().eq('id', c.req.param('productId'));
  if (error) throw error;
  return c.body(null, 204);
});

app.post('/api/brands/:brandId/audiences', async (c) => {
  const input = await jsonBody(c, audienceInputSchema);
  const supabase = c.get('supabase');
  if (input.is_primary) await supabase.from('audiences').update({ is_primary: false }).eq('brand_id', c.req.param('brandId'));
  const { data, error } = await supabase.from('audiences').insert({ brand_id: c.req.param('brandId'), ...input }).select('*').single();
  if (error) throw error;
  return c.json(data, 201);
});

app.patch('/api/audiences/:audienceId', async (c) => {
  const input = await jsonBody(c, audienceInputSchema.partial());
  const supabase = c.get('supabase');
  if (input.is_primary) {
    const { data: current, error: currentError } = await supabase.from('audiences').select('brand_id').eq('id', c.req.param('audienceId')).single();
    if (currentError) throw currentError;
    await supabase.from('audiences').update({ is_primary: false }).eq('brand_id', current.brand_id);
  }
  const { data, error } = await supabase.from('audiences').update(input).eq('id', c.req.param('audienceId')).select('*').single();
  if (error) throw error;
  return c.json(data);
});

app.delete('/api/audiences/:audienceId', async (c) => {
  const { error } = await c.get('supabase').from('audiences').delete().eq('id', c.req.param('audienceId'));
  if (error) throw error;
  return c.body(null, 204);
});

app.post('/api/brands/:brandId/constitution/generate', async (c) => {
  const brandId = c.req.param('brandId');
  const supabase = c.get('supabase');
  const bundle = await loadBrandBundle(supabase as ReturnType<typeof createUserClient>, brandId);
  const startedAt = Date.now();
  const promptVersion = 'constitution-v1';
  const system = `You are Brandloom's brand strategist. Convert confirmed business information into a practical Brand Constitution.
Use only facts present in the input. Missing information belongs in confidence_notes, never as an invented assertion.
The JSON must have: purpose, positioning, audience_summary, voice {should_sound_like, should_not_sound_like, dimensions}, language_rules, preferred_phrases, prohibited_patterns, approved_claims, prohibited_claims, content_pillars [{name,purpose}], confidence_notes.`;
  try {
    const result = await generateStructured(c.env, brandConstitutionSchema, system, bundle);
    const previous = bundle.profile ?? {};
    const { data, error } = await supabase.from('brand_voice_profiles').upsert({
      brand_id: brandId,
      tone_attributes: previous.tone_attributes ?? {},
      preferred_phrases: unique([...(previous.preferred_phrases ?? []), ...result.data.preferred_phrases]),
      prohibited_phrases: unique([...(previous.prohibited_phrases ?? []), ...result.data.prohibited_patterns]),
      style_rules: previous.style_rules ?? {},
      approved_claims: unique([...(previous.approved_claims ?? []), ...result.data.approved_claims]),
      prohibited_claims: unique([...(previous.prohibited_claims ?? []), ...result.data.prohibited_claims]),
      positive_examples: previous.positive_examples ?? [],
      negative_examples: previous.negative_examples ?? [],
      constitution: result.data,
      version: (previous.version ?? 0) + 1,
    }, { onConflict: 'brand_id' }).select('*').single();
    if (error) throw error;
    await recordGeneration(supabase, { brandId, taskType: 'brand_constitution', model: c.env.ANTHROPIC_MODEL, promptVersion, startedAt, usage: result.usage, status: 'completed', snapshot: bundle });
    return c.json(data);
  } catch (error) {
    await recordGeneration(supabase, { brandId, taskType: 'brand_constitution', model: c.env.ANTHROPIC_MODEL, promptVersion, startedAt, status: 'failed', error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
});

app.get('/api/brands/:brandId/weekly-plans', async (c) => {
  const { data, error } = await c.get('supabase').from('weekly_plans').select('*').eq('brand_id', c.req.param('brandId')).order('week_start', { ascending: false }).limit(20);
  if (error) throw error;
  return c.json({ plans: data ?? [] });
});

app.post('/api/weekly-plans', async (c) => {
  const input = await jsonBody(c, weeklyPlanInputSchema);
  const { data, error } = await c.get('supabase').from('weekly_plans').insert({ ...input, status: 'setup' }).select('*').single();
  if (error) throw error;
  return c.json(data, 201);
});

app.get('/api/weekly-plans/:planId', async (c) => {
  const supabase = c.get('supabase');
  const { data: plan, error } = await supabase.from('weekly_plans').select('*').eq('id', c.req.param('planId')).single();
  if (error) throw error;
  const { data: items, error: itemError } = await supabase.from('content_items').select('*').eq('weekly_plan_id', plan.id).order('scheduled_date');
  if (itemError) throw itemError;
  return c.json({ plan, items: items ?? [] });
});

app.post('/api/weekly-plans/:planId/strategy/generate', async (c) => {
  const planId = c.req.param('planId');
  const supabase = c.get('supabase');
  const { data: plan, error } = await supabase.from('weekly_plans').select('*').eq('id', planId).single();
  if (error) throw error;
  const bundle = await loadBrandBundle(supabase as ReturnType<typeof createUserClient>, plan.brand_id);
  if (!bundle.profile?.constitution) return c.json({ error: 'Generate and approve a Brand Constitution first.' }, 409);
  const startedAt = Date.now();
  const promptVersion = 'weekly-strategy-v1';
  const payload = { plan, brand: bundle.brand, constitution: bundle.profile.constitution, products: bundle.products, audiences: bundle.audiences };
  const system = `You are Brandloom's weekly campaign strategist. Produce one coherent Instagram plan, not seven unrelated ideas.
Respect posting_days, week_start, important_dates, selected goals and selected products. Balance education, trust, product, community, story and offer content. Never invent product facts.
Return JSON with narrative, rationale, distribution, and days. Each day needs scheduled_date, title, objective, pillar, format (static/carousel/reel/story), topic, cta, and product_id or null.`;
  try {
    const result = await generateStructured(c.env, weeklyStrategySchema, system, payload);
    const validProductIds = new Set(bundle.products.map((product) => product.id));
    const days = result.data.days.map((day) => ({ ...day, product_id: day.product_id && validProductIds.has(day.product_id) ? day.product_id : null }));
    const strategy = { ...result.data, days };
    const { data, error: updateError } = await supabase.from('weekly_plans').update({ strategy, status: 'planned' }).eq('id', planId).select('*').single();
    if (updateError) throw updateError;
    await recordGeneration(supabase, { brandId: plan.brand_id, planId, taskType: 'weekly_strategy', model: c.env.ANTHROPIC_MODEL, promptVersion, startedAt, usage: result.usage, status: 'completed', snapshot: payload });
    return c.json(data);
  } catch (generationError) {
    await recordGeneration(supabase, { brandId: plan.brand_id, planId, taskType: 'weekly_strategy', model: c.env.ANTHROPIC_MODEL, promptVersion, startedAt, status: 'failed', error: generationError instanceof Error ? generationError.message : String(generationError) });
    throw generationError;
  }
});

app.post('/api/weekly-plans/:planId/posts/generate', async (c) => {
  const planId = c.req.param('planId');
  const supabase = c.get('supabase');
  const { data: plan, error } = await supabase.from('weekly_plans').select('*').eq('id', planId).single();
  if (error) throw error;
  if (!plan.strategy) return c.json({ error: 'Generate the weekly strategy first.' }, 409);
  const bundle = await loadBrandBundle(supabase as ReturnType<typeof createUserClient>, plan.brand_id);
  const startedAt = Date.now();
  const promptVersion = 'weekly-posts-v1';
  const payload = { plan, brand: bundle.brand, constitution: bundle.profile?.constitution, voice_profile: bundle.profile, products: bundle.products, audiences: bundle.audiences };
  const system = `You are Brandloom's Instagram writer. Draft every item in the approved strategy while preserving one weekly narrative.
Use only approved facts. Put every factual statement you used in facts_used. Do not create prices, offers, ingredients, certifications, testimonials, medical claims or availability.
Avoid generic AI language. Return JSON {items:[...]}; each item needs scheduled_date, title, objective, pillar, platform="instagram", format, hook, caption, cta, visual_brief, hashtags, product_id or null, and facts_used.`;
  try {
    const result = await generateStructured(c.env, generatedPostsSchema, system, payload);
    const approvedFacts = unique([
      ...(bundle.profile?.approved_claims ?? []),
      ...bundle.products.flatMap((product) => product.approved_facts ?? []),
    ]);
    const prohibitedPhrases = unique([
      ...(bundle.profile?.prohibited_phrases ?? []),
      ...(bundle.profile?.prohibited_claims ?? []),
      ...bundle.products.flatMap((product) => product.restricted_claims ?? []),
    ]);
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
      quality_flags: validateDraft({
        hook: item.hook,
        caption: item.caption,
        factsUsed: item.facts_used,
        approvedFacts,
        prohibitedPhrases,
        otherHooks: hooks.filter((_, hookIndex) => hookIndex !== index),
      }),
      status: 'draft',
      generation_metadata: { model: c.env.ANTHROPIC_MODEL, prompt_version: promptVersion },
    }));
    await supabase.from('content_items').delete().eq('weekly_plan_id', planId).eq('status', 'draft');
    const { data: items, error: insertError } = await supabase.from('content_items').insert(rows).select('*');
    if (insertError) throw insertError;
    if (items?.length) {
      const { error: versionError } = await supabase.from('content_versions').insert(items.map((item) => ({
        content_item_id: item.id,
        version_number: 1,
        source: 'generation',
        snapshot: item,
      })));
      if (versionError) throw versionError;
    }
    await supabase.from('weekly_plans').update({ status: 'drafted' }).eq('id', planId);
    await recordGeneration(supabase, { brandId: plan.brand_id, planId, taskType: 'weekly_posts', model: c.env.ANTHROPIC_MODEL, promptVersion, startedAt, usage: result.usage, status: 'completed', snapshot: payload });
    return c.json({ items: items ?? [] });
  } catch (generationError) {
    await recordGeneration(supabase, { brandId: plan.brand_id, planId, taskType: 'weekly_posts', model: c.env.ANTHROPIC_MODEL, promptVersion, startedAt, status: 'failed', error: generationError instanceof Error ? generationError.message : String(generationError) });
    throw generationError;
  }
});

app.patch('/api/content-items/:contentId', async (c) => {
  const input = await jsonBody(c, contentPatchSchema);
  const supabase = c.get('supabase');
  const { data: before, error: beforeError } = await supabase.from('content_items').select('*').eq('id', c.req.param('contentId')).single();
  if (beforeError) throw beforeError;
  const { data, error } = await supabase.from('content_items').update(input).eq('id', before.id).select('*').single();
  if (error) throw error;
  const { data: latest } = await supabase.from('content_versions').select('version_number').eq('content_item_id', before.id).order('version_number', { ascending: false }).limit(1).maybeSingle();
  await supabase.from('content_versions').insert({ content_item_id: before.id, version_number: (latest?.version_number ?? 0) + 1, source: 'user_edit', snapshot: data, previous_snapshot: before });
  return c.json(data);
});

app.post('/api/content-items/:contentId/regenerate', async (c) => {
  const input = await jsonBody(c, regenerateInputSchema);
  const supabase = c.get('supabase');
  const { data: item, error } = await supabase.from('content_items').select('*, weekly_plans(*)').eq('id', c.req.param('contentId')).single();
  if (error) throw error;
  const bundle = await loadBrandBundle(supabase as ReturnType<typeof createUserClient>, item.brand_id);
  const fieldSchema = z.object({
    title: z.string().optional(), hook: z.string().optional(), caption: z.string().optional(),
    cta: z.string().optional(), visual_brief: z.string().optional(), hashtags: z.array(z.string()).optional(),
    facts_used: z.array(z.string()).default(item.facts_used ?? []),
  });
  const system = `Rewrite only the requested fields of one Instagram content item. Preserve approved facts, strategy and brand voice. Return JSON containing the requested fields plus facts_used. Never invent facts.`;
  const result = await generateStructured(c.env, fieldSchema, system, { fields: input.fields, instruction: input.instruction, item, brand: bundle });
  const patch = Object.fromEntries(input.fields.filter((field) => result.data[field] !== undefined).map((field) => [field, result.data[field]]));
  const approvedFacts = unique([...(bundle.profile?.approved_claims ?? []), ...bundle.products.flatMap((product) => product.approved_facts ?? [])]);
  const prohibitedPhrases = unique([...(bundle.profile?.prohibited_phrases ?? []), ...(bundle.profile?.prohibited_claims ?? [])]);
  const nextItem = { ...item, ...patch, facts_used: result.data.facts_used };
  const qualityFlags = validateDraft({ hook: nextItem.hook, caption: nextItem.caption, factsUsed: nextItem.facts_used, approvedFacts, prohibitedPhrases });
  const { data, error: updateError } = await supabase.from('content_items').update({ ...patch, facts_used: result.data.facts_used, quality_flags: qualityFlags }).eq('id', item.id).select('*').single();
  if (updateError) throw updateError;
  const { data: latest } = await supabase.from('content_versions').select('version_number').eq('content_item_id', item.id).order('version_number', { ascending: false }).limit(1).maybeSingle();
  await supabase.from('content_versions').insert({ content_item_id: item.id, version_number: (latest?.version_number ?? 0) + 1, source: 'regeneration', snapshot: data, previous_snapshot: item });
  return c.json(data);
});

app.post('/api/content-items/:contentId/feedback', async (c) => {
  const input = await jsonBody(c, feedbackInputSchema);
  const supabase = c.get('supabase');
  const { data: item, error: itemError } = await supabase.from('content_items').select('*').eq('id', c.req.param('contentId')).single();
  if (itemError) throw itemError;
  const { data, error } = await supabase.from('feedback_events').insert({ content_item_id: item.id, brand_id: item.brand_id, ...input, content_snapshot: item }).select('*').single();
  if (error) throw error;
  if (input.feedback_type === 'strong_example') {
    await supabase.from('content_examples').insert({ brand_id: item.brand_id, type: 'approved', content: item.caption, feedback: input.comment, source: 'content_feedback' });
  }
  return c.json(data, 201);
});

app.onError((error, c) => {
  console.error(error);
  if (error instanceof z.ZodError) return c.json({ error: 'Invalid request.', issues: error.issues }, 400);
  const message = error instanceof Error ? error.message : 'Unexpected server error.';
  return c.json({ error: message }, 500);
});

export default app;
