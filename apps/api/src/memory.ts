export type MemoryStatus =
  | 'observation' | 'candidate' | 'suggested' | 'confirmed' | 'active' | 'paused'
  | 'contradicted' | 'superseded' | 'expired' | 'rejected';

export type MemoryScope = {
  product_id?: string | null;
  audience_id?: string | null;
  platform?: string | null;
  language_mode?: string | null;
  campaign_id?: string | null;
};

export type MemoryItem = {
  id: string;
  brand_id: string;
  memory_type: string;
  statement: string;
  structured_value?: Record<string, unknown> | null;
  scope?: MemoryScope | null;
  durability: 'permanent' | 'stable' | 'temporary' | 'experiment';
  confidence: number;
  status: MemoryStatus;
  origin: 'explicit' | 'edit_analysis' | 'weekly_review' | 'system' | 'import';
  evidence_count: number;
  valid_from?: string | null;
  valid_until?: string | null;
  last_observed_at?: string | null;
};

export type RetrievalOptions = {
  task: 'constitution' | 'strategy' | 'writing' | 'validation' | 'regeneration';
  productIds?: string[];
  audienceIds?: string[];
  platform?: string;
  languageMode?: string;
  now?: Date;
  limit?: number;
};

const priority: Record<string, number> = {
  compliance_restriction: 100,
  factual_rule: 95,
  temporary_context: 85,
  voice_preference: 80,
  selling_style: 78,
  product_lesson: 75,
  audience_lesson: 72,
  campaign_lesson: 66,
  repetition_warning: 60,
  strategic_suggestion: 55,
};

function dateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function isMemoryActive(memory: MemoryItem, now = new Date()) {
  if (!['confirmed', 'active'].includes(memory.status)) return false;
  const today = dateOnly(now);
  if (memory.valid_from && memory.valid_from > today) return false;
  if (memory.valid_until && memory.valid_until < today) return false;
  return true;
}

export function scopeMatches(scope: MemoryScope | null | undefined, options: RetrievalOptions) {
  const value = scope ?? {};
  if (value.product_id && !(options.productIds ?? []).includes(value.product_id)) return false;
  if (value.audience_id && !(options.audienceIds ?? []).includes(value.audience_id)) return false;
  if (value.platform && options.platform && value.platform !== options.platform) return false;
  if (value.language_mode && options.languageMode && value.language_mode !== options.languageMode) return false;
  return true;
}

export function compileMemoryContext(memories: MemoryItem[], options: RetrievalOptions) {
  const active = memories
    .filter((memory) => isMemoryActive(memory, options.now))
    .filter((memory) => scopeMatches(memory.scope, options))
    .sort((a, b) => {
      const aScore = (priority[a.memory_type] ?? 40) + a.confidence * 10;
      const bScore = (priority[b.memory_type] ?? 40) + b.confidence * 10;
      return bScore - aScore;
    })
    .slice(0, options.limit ?? (options.task === 'writing' ? 14 : 10));

  return {
    ids: active.map((memory) => memory.id),
    items: active.map((memory) => ({
      id: memory.id,
      type: memory.memory_type,
      statement: memory.statement,
      confidence: memory.confidence,
      scope: memory.scope ?? {},
      durability: memory.durability,
    })),
    prompt: active.length
      ? active.map((memory, index) => `${index + 1}. [${memory.memory_type}] ${memory.statement}`).join('\n')
      : 'No confirmed memory rules are active for this task.',
  };
}

export function candidateConfidence(input: {
  evidenceCount: number;
  explicit?: boolean;
  observedAcrossWeeks?: boolean;
  contradictions?: number;
  ageDays?: number;
}) {
  if (input.explicit) return 1;
  let confidence = 0.30 + Math.min(input.evidenceCount, 6) * 0.08;
  if (input.observedAcrossWeeks) confidence += 0.10;
  confidence -= Math.min(input.contradictions ?? 0, 3) * 0.15;
  if ((input.ageDays ?? 0) > 90) confidence -= 0.10;
  return Math.max(0.05, Math.min(0.95, Number(confidence.toFixed(3))));
}

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export type RecentContent = {
  id: string;
  hook?: string | null;
  cta?: string | null;
  pillar?: string | null;
  product_id?: string | null;
  scheduled_date?: string | null;
};

export function buildRepetitionReport(items: RecentContent[]) {
  const hooks = new Map<string, number>();
  const ctas = new Map<string, number>();
  const pillars = new Map<string, number>();
  const warnings: Array<{ type: string; message: string; count: number; evidence: string }> = [];

  for (const item of items) {
    const hook = normalize(item.hook ?? '');
    const cta = normalize(item.cta ?? '');
    const pillar = normalize(item.pillar ?? '');
    if (hook) hooks.set(hook, (hooks.get(hook) ?? 0) + 1);
    if (cta) ctas.set(cta, (ctas.get(cta) ?? 0) + 1);
    if (pillar) pillars.set(pillar, (pillars.get(pillar) ?? 0) + 1);
  }

  for (const [hook, count] of hooks) {
    if (count >= 2) warnings.push({ type: 'hook', message: `A hook has been reused ${count} times.`, count, evidence: hook });
  }
  for (const [cta, count] of ctas) {
    if (count >= 3) warnings.push({ type: 'cta', message: `A call to action has been reused ${count} times.`, count, evidence: cta });
  }
  const total = Math.max(items.length, 1);
  for (const [pillar, count] of pillars) {
    if (count / total >= 0.5 && count >= 3) warnings.push({ type: 'pillar', message: `${pillar} dominates ${count} of ${items.length} recent posts.`, count, evidence: pillar });
  }

  return {
    sampled_posts: items.length,
    warnings: warnings.sort((a, b) => b.count - a.count),
    hook_frequency: Object.fromEntries(hooks),
    cta_frequency: Object.fromEntries(ctas),
    pillar_frequency: Object.fromEntries(pillars),
  };
}

export function mergeCandidate(existing: MemoryItem | null, evidenceCount: number, proposedConfidence: number) {
  const nextEvidence = (existing?.evidence_count ?? 0) + Math.max(evidenceCount, 1);
  const confidence = Math.max(
    existing?.confidence ?? 0,
    proposedConfidence,
    candidateConfidence({ evidenceCount: nextEvidence }),
  );
  return {
    confidence: Number(Math.min(confidence, 0.95).toFixed(3)),
    evidence_count: nextEvidence,
    status: existing?.status === 'confirmed' || existing?.status === 'active' ? existing.status : 'candidate',
    last_observed_at: new Date().toISOString(),
  };
}
