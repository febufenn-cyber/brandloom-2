import { z } from 'zod';

export const brandInputSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(2000).default(''),
  category: z.string().max(120).default(''),
  location: z.string().max(160).default(''),
  website_url: z.string().url().or(z.literal('')).default(''),
  primary_language: z.string().min(2).max(80).default('English'),
  secondary_languages: z.array(z.string().max(80)).max(8).default([]),
});

export const brandPatchSchema = brandInputSchema.partial().extend({
  onboarding_complete: z.boolean().optional(),
});

export const productInputSchema = z.object({
  name: z.string().min(2).max(160),
  description: z.string().max(3000).default(''),
  customer_problem: z.string().max(1500).default(''),
  benefits: z.array(z.string().max(500)).max(20).default([]),
  approved_facts: z.array(z.string().max(500)).max(40).default([]),
  restricted_claims: z.array(z.string().max(500)).max(40).default([]),
  price: z.string().max(100).default(''),
  purchase_url: z.string().url().or(z.literal('')).default(''),
  active: z.boolean().default(true),
});

export const audienceInputSchema = z.object({
  name: z.string().min(2).max(160),
  description: z.string().max(2000).default(''),
  pain_points: z.array(z.string().max(500)).max(20).default([]),
  motivations: z.array(z.string().max(500)).max(20).default([]),
  objections: z.array(z.string().max(500)).max(20).default([]),
  language_notes: z.string().max(1500).default(''),
  is_primary: z.boolean().default(false),
});

export const voiceProfileInputSchema = z.object({
  tone_attributes: z.record(z.number().min(0).max(100)).default({}),
  preferred_phrases: z.array(z.string().max(300)).max(100).default([]),
  prohibited_phrases: z.array(z.string().max(300)).max(100).default([]),
  style_rules: z.record(z.unknown()).default({}),
  approved_claims: z.array(z.string().max(500)).max(100).default([]),
  prohibited_claims: z.array(z.string().max(500)).max(100).default([]),
  positive_examples: z.array(z.string().max(3000)).max(20).default([]),
  negative_examples: z.array(z.string().max(3000)).max(20).default([]),
});

export const weeklyPlanInputSchema = z.object({
  brand_id: z.string().uuid(),
  week_start: z.string().date(),
  primary_goal: z.enum(['awareness', 'product', 'sales', 'education', 'trust', 'event', 'leads', 'reengagement']),
  secondary_goal: z.string().max(120).default(''),
  campaign_context: z.string().max(4000).default(''),
  featured_product_ids: z.array(z.string().uuid()).max(10).default([]),
  important_dates: z.array(z.object({ date: z.string().date(), note: z.string().max(500) })).max(20).default([]),
  posting_days: z.number().int().min(1).max(7).default(7),
  language_mode: z.string().max(80).default('English'),
});

export const contentPatchSchema = z.object({
  title: z.string().max(300).optional(),
  hook: z.string().max(1000).optional(),
  caption: z.string().max(12000).optional(),
  cta: z.string().max(1000).optional(),
  visual_brief: z.string().max(4000).optional(),
  hashtags: z.array(z.string().max(100)).max(40).optional(),
  scheduled_date: z.string().date().optional(),
  status: z.enum(['draft', 'approved', 'rejected']).optional(),
});

export const feedbackInputSchema = z.object({
  feedback_type: z.enum([
    'too_generic', 'too_formal', 'too_salesy', 'too_long', 'factually_incorrect',
    'repetitive', 'off_brand', 'wrong_audience', 'unsupported_claim',
    'weak_wording', 'strong_example', 'other',
  ]),
  comment: z.string().max(2000).default(''),
});

export const regenerateInputSchema = z.object({
  fields: z.array(z.enum(['title', 'hook', 'caption', 'cta', 'visual_brief', 'hashtags'])).min(1).max(6),
  instruction: z.string().max(1200).default(''),
});

export const brandConstitutionSchema = z.object({
  purpose: z.string(),
  positioning: z.string(),
  audience_summary: z.string(),
  voice: z.object({
    should_sound_like: z.array(z.string()),
    should_not_sound_like: z.array(z.string()),
    dimensions: z.record(z.string()),
  }),
  language_rules: z.array(z.string()),
  preferred_phrases: z.array(z.string()),
  prohibited_patterns: z.array(z.string()),
  approved_claims: z.array(z.string()),
  prohibited_claims: z.array(z.string()),
  content_pillars: z.array(z.object({ name: z.string(), purpose: z.string() })),
  confidence_notes: z.array(z.string()),
});

export const weeklyStrategySchema = z.object({
  narrative: z.string(),
  rationale: z.string(),
  distribution: z.record(z.number()),
  days: z.array(z.object({
    scheduled_date: z.string().date(),
    title: z.string(),
    objective: z.string(),
    pillar: z.string(),
    format: z.enum(['static', 'carousel', 'reel', 'story']),
    topic: z.string(),
    cta: z.string(),
    product_id: z.string().uuid().nullable(),
  })).min(1).max(7),
});

export const generatedPostsSchema = z.object({
  items: z.array(z.object({
    scheduled_date: z.string().date(),
    title: z.string(),
    objective: z.string(),
    pillar: z.string(),
    platform: z.literal('instagram'),
    format: z.enum(['static', 'carousel', 'reel', 'story']),
    hook: z.string(),
    caption: z.string(),
    cta: z.string(),
    visual_brief: z.string(),
    hashtags: z.array(z.string()),
    product_id: z.string().uuid().nullable(),
    facts_used: z.array(z.string()),
  })).min(1).max(7),
});
