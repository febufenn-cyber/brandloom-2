import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceClient } from './db';
import {
  buildOptimizationInsights,
  evaluateExperiment,
  normalizeMetrics,
  opportunityScore,
  type ExperimentObservation,
  type OptimizationSample,
  type PerformanceMetrics,
} from './optimization';
import type { Env } from './types';

type Row = Record<string, any>;

type PerformanceImportRow = Partial<PerformanceMetrics> & {
  content_item_id: string;
  publication_job_id?: string | null;
  platform_account_id?: string | null;
  source_event_id?: string | null;
  provider_media_id?: string;
  window_start: string;
  window_end: string;
  observed_at?: string;
  custom_metrics?: Record<string, unknown>;
  is_final?: boolean;
};

export type PerformanceImport = {
  source: 'manual' | 'csv' | 'meta' | 'api' | 'system';
  external_batch_id?: string | null;
  period_start?: string | null;
  period_end?: string | null;
  rows: PerformanceImportRow[];
};

const toNumber = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const today = () => new Date().toISOString().slice(0, 10);

async function brandWorkspace(supabase: SupabaseClient, brandId: string) {
  const { data, error } = await supabase.from('brands').select('id,workspace_id,name').eq('id', brandId).single();
  if (error) throw error;
  return data as Row;
}

async function latestPerformanceSamples(supabase: SupabaseClient, brandId: string, windowStart?: string) {
  let snapshotQuery = supabase.from('content_performance_snapshots').select('*').eq('brand_id', brandId).order('observed_at', { ascending: false });
  if (windowStart) snapshotQuery = snapshotQuery.gte('window_end', windowStart);
  const { data: snapshots, error } = await snapshotQuery.limit(2000);
  if (error) throw error;

  const latest = new Map<string, Row>();
  for (const snapshot of (snapshots ?? []) as Row[]) if (!latest.has(snapshot.content_item_id)) latest.set(snapshot.content_item_id, snapshot);
  const contentIds = [...latest.keys()];
  if (!contentIds.length) return { samples: [] as OptimizationSample[], snapshots: [] as Row[] };

  const [contentResult, featureResult] = await Promise.all([
    supabase.from('content_items').select('id,scheduled_date,format,pillar,product_id,hook,cta').in('id', contentIds),
    supabase.from('content_features').select('*').in('content_item_id', contentIds),
  ]);
  if (contentResult.error) throw contentResult.error;
  if (featureResult.error) throw featureResult.error;

  const contents = new Map(((contentResult.data ?? []) as Row[]).map((item) => [item.id, item]));
  const features = new Map(((featureResult.data ?? []) as Row[]).map((item) => [item.content_item_id, item]));
  const samples: OptimizationSample[] = [];

  for (const [contentId, snapshot] of latest) {
    const content = contents.get(contentId);
    if (!content) continue;
    const feature = features.get(contentId) ?? {};
    samples.push({
      contentId,
      scheduledDate: String(content.scheduled_date ?? ''),
      format: String(content.format ?? ''),
      pillar: String(content.pillar ?? ''),
      productId: content.product_id as string | null,
      hookType: String(feature.hook_type || content.hook || ''),
      ctaType: String(feature.cta_type || content.cta || ''),
      emotionalAngle: String(feature.emotional_angle ?? ''),
      metrics: normalizeMetrics({
        impressions: toNumber(snapshot.impressions),
        reach: toNumber(snapshot.reach),
        likes: toNumber(snapshot.likes),
        comments: toNumber(snapshot.comments),
        saves: toNumber(snapshot.saves),
        shares: toNumber(snapshot.shares),
        clicks: toNumber(snapshot.clicks),
        profile_visits: toNumber(snapshot.profile_visits),
        follows: toNumber(snapshot.follows),
        video_views: toNumber(snapshot.video_views),
        watch_time_seconds: toNumber(snapshot.watch_time_seconds),
      }),
    });
  }
  return { samples, snapshots: [...latest.values()] };
}

export async function importPerformance(
  supabase: SupabaseClient,
  brandId: string,
  userId: string,
  input: PerformanceImport,
) {
  const brand = await brandWorkspace(supabase, brandId);
  if (input.external_batch_id) {
    const existing = await supabase.from('metric_import_batches').select('*')
      .eq('brand_id', brandId).eq('source', input.source).eq('external_batch_id', input.external_batch_id).maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) return { batch: existing.data, idempotent_replay: true };
  }

  const { data: batch, error: batchError } = await supabase.from('metric_import_batches').insert({
    workspace_id: brand.workspace_id,
    brand_id: brandId,
    source: input.source,
    external_batch_id: input.external_batch_id ?? null,
    period_start: input.period_start ?? null,
    period_end: input.period_end ?? null,
    rows_received: input.rows.length,
    initiated_by: userId,
  }).select('*').single();
  if (batchError) throw batchError;

  const contentIds = [...new Set(input.rows.map((row) => row.content_item_id))];
  const contentResult = await supabase.from('content_items').select('id').eq('brand_id', brandId).in('id', contentIds);
  if (contentResult.error) throw contentResult.error;
  const allowed = new Set(((contentResult.data ?? []) as Row[]).map((row) => row.id as string));

  const sourceIds = input.rows.map((row) => row.source_event_id).filter((value): value is string => Boolean(value));
  const duplicateIds = new Set<string>();
  if (sourceIds.length) {
    const duplicateResult = await supabase.from('content_performance_snapshots').select('source_event_id')
      .eq('brand_id', brandId).eq('source', input.source).in('source_event_id', sourceIds);
    if (duplicateResult.error) throw duplicateResult.error;
    for (const row of (duplicateResult.data ?? []) as Row[]) if (row.source_event_id) duplicateIds.add(row.source_event_id as string);
  }

  const rejectionSummary: Array<{ row: number; reason: string }> = [];
  const rows = input.rows.flatMap((row, index) => {
    if (!allowed.has(row.content_item_id)) {
      rejectionSummary.push({ row: index, reason: 'Content item does not belong to this brand.' });
      return [];
    }
    if (row.source_event_id && duplicateIds.has(row.source_event_id)) {
      rejectionSummary.push({ row: index, reason: 'Duplicate source event.' });
      return [];
    }
    const metrics = normalizeMetrics(row);
    return [{
      workspace_id: brand.workspace_id,
      brand_id: brandId,
      content_item_id: row.content_item_id,
      publication_job_id: row.publication_job_id ?? null,
      platform_account_id: row.platform_account_id ?? null,
      import_batch_id: batch.id,
      source: input.source,
      source_event_id: row.source_event_id ?? null,
      provider_media_id: row.provider_media_id ?? '',
      window_start: row.window_start,
      window_end: row.window_end,
      observed_at: row.observed_at ?? new Date().toISOString(),
      ...metrics,
      custom_metrics: row.custom_metrics ?? {},
      is_final: row.is_final ?? false,
    }];
  });

  let insertError: unknown = null;
  if (rows.length) {
    const result = await supabase.from('content_performance_snapshots').insert(rows);
    insertError = result.error;
  }
  if (insertError) {
    await supabase.from('metric_import_batches').update({ status: 'failed', rows_rejected: input.rows.length, rejection_summary: [{ reason: String((insertError as Error).message ?? insertError) }], completed_at: new Date().toISOString() }).eq('id', batch.id);
    throw insertError;
  }

  const accepted = rows.length;
  const rejected = input.rows.length - accepted;
  const status = rejected === 0 ? 'completed' : accepted === 0 ? 'failed' : 'partial';
  const { data: completed, error: completionError } = await supabase.from('metric_import_batches').update({
    status,
    rows_accepted: accepted,
    rows_rejected: rejected,
    rejection_summary: rejectionSummary,
    completed_at: new Date().toISOString(),
  }).eq('id', batch.id).select('*').single();
  if (completionError) throw completionError;
  return { batch: completed, idempotent_replay: false };
}

export async function createOptimizationReview(
  supabase: SupabaseClient,
  brandId: string,
  userId: string,
  windowDays = 60,
) {
  const brand = await brandWorkspace(supabase, brandId);
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - windowDays * 86_400_000);
  const { samples } = await latestPerformanceSamples(supabase, brandId, windowStart.toISOString());
  const insights = buildOptimizationInsights(samples);

  const { data: review, error } = await supabase.from('optimization_reviews').insert({
    workspace_id: brand.workspace_id,
    brand_id: brandId,
    window_start: windowStart.toISOString().slice(0, 10),
    window_end: windowEnd.toISOString().slice(0, 10),
    summary: insights.summary,
    baseline: { window_days: windowDays, sample_size: samples.length },
    performance: { aggregate: insights.aggregate, segments: insights.segments, top_content: insights.top_content },
    diagnostics: { correlation_only: true, attribution_ceiling: 'medium', generated_recommendations: insights.recommendations.length, fatigue_signals: insights.fatigue.length },
    generated_by: userId,
  }).select('*').single();
  if (error) throw error;

  const recommendationRows = insights.recommendations.map((item) => ({
    workspace_id: brand.workspace_id,
    brand_id: brandId,
    review_id: review.id,
    recommendation_type: item.type,
    statement: item.statement,
    rationale: item.rationale,
    proposed_action: item.proposedAction,
    scope: item.scope,
    confidence: item.confidence,
    attribution_confidence: item.attributionConfidence,
    sample_size: item.sampleSize,
    evidence_summary: item.evidenceSummary,
    valid_until: new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10),
  }));
  const recResult = recommendationRows.length
    ? await supabase.from('optimization_recommendations').insert(recommendationRows).select('*')
    : { data: [], error: null };
  if (recResult.error) throw recResult.error;

  for (const recommendation of (recResult.data ?? []) as Row[]) {
    await supabase.from('recommendation_evidence').insert({
      brand_id: brandId,
      recommendation_id: recommendation.id,
      evidence_type: recommendation.recommendation_type === 'fatigue' ? 'fatigue' : 'comparison',
      payload: recommendation.evidence_summary,
      weight: recommendation.confidence,
    });
  }

  const fatigueRows: Row[] = [];
  for (const item of insights.fatigue) {
    const existing = await supabase.from('fatigue_signals').select('id').eq('brand_id', brandId)
      .eq('signal_type', item.signalType).eq('signal_key', item.signalKey).in('status', ['open', 'acknowledged']).maybeSingle();
    if (existing.error) throw existing.error;
    const payload = {
      workspace_id: brand.workspace_id,
      brand_id: brandId,
      review_id: review.id,
      signal_type: item.signalType,
      signal_key: item.signalKey,
      score: item.score,
      recent_count: item.recentCount,
      baseline_count: item.baselineCount,
      performance_change: item.performanceChange,
      evidence: item.evidence,
      status: 'open',
      detected_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 45 * 86_400_000).toISOString(),
    };
    const result = existing.data
      ? await supabase.from('fatigue_signals').update(payload).eq('id', existing.data.id).select('*').single()
      : await supabase.from('fatigue_signals').insert(payload).select('*').single();
    if (result.error) throw result.error;
    fatigueRows.push(result.data as Row);
  }

  return { review, recommendations: recResult.data ?? [], fatigue: fatigueRows, insights };
}

export async function optimizationDashboard(supabase: SupabaseClient, brandId: string) {
  const [brand, latestReview, recommendations, fatigue, opportunities, experiments, assignments, imports] = await Promise.all([
    brandWorkspace(supabase, brandId),
    supabase.from('optimization_reviews').select('*').eq('brand_id', brandId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('optimization_recommendations').select('*').eq('brand_id', brandId).order('created_at', { ascending: false }).limit(100),
    supabase.from('fatigue_signals').select('*').eq('brand_id', brandId).order('score', { ascending: false }).limit(50),
    supabase.from('opportunity_signals').select('*').eq('brand_id', brandId).order('created_at', { ascending: false }).limit(50),
    supabase.from('brand_experiments').select('*').eq('brand_id', brandId).order('created_at', { ascending: false }).limit(50),
    supabase.from('experiment_assignments').select('*').eq('brand_id', brandId).order('assigned_at', { ascending: false }).limit(200),
    supabase.from('metric_import_batches').select('*').eq('brand_id', brandId).order('created_at', { ascending: false }).limit(20),
  ]);
  for (const result of [latestReview, recommendations, fatigue, opportunities, experiments, assignments, imports]) if (result.error) throw result.error;
  const performance = await latestPerformanceSamples(supabase, brandId);
  const insights = buildOptimizationInsights(performance.samples);
  return {
    brand,
    latest_review: latestReview.data,
    recommendations: recommendations.data ?? [],
    fatigue: fatigue.data ?? [],
    opportunities: ((opportunities.data ?? []) as Row[]).map((item) => ({ ...item, opportunity_score: opportunityScore({ relevance: toNumber(item.relevance_score), confidence: toNumber(item.confidence), validUntil: item.valid_until as string | null }) })),
    experiments: experiments.data ?? [],
    assignments: assignments.data ?? [],
    imports: imports.data ?? [],
    current_performance: insights,
  };
}

export async function evaluateBrandExperiment(supabase: SupabaseClient, experimentId: string, userId: string, complete = false) {
  const experimentResult = await supabase.from('brand_experiments').select('*').eq('id', experimentId).single();
  if (experimentResult.error) throw experimentResult.error;
  const experiment = experimentResult.data as Row;
  const assignmentResult = await supabase.from('experiment_assignments').select('*').eq('experiment_id', experimentId).neq('status', 'excluded');
  if (assignmentResult.error) throw assignmentResult.error;
  const assignments = (assignmentResult.data ?? []) as Row[];
  const contentIds = assignments.map((item) => item.content_item_id as string);
  const snapshotResult = contentIds.length
    ? await supabase.from('content_performance_snapshots').select('*').in('content_item_id', contentIds).order('observed_at', { ascending: false })
    : { data: [], error: null };
  if (snapshotResult.error) throw snapshotResult.error;
  const latest = new Map<string, Row>();
  for (const snapshot of (snapshotResult.data ?? []) as Row[]) if (!latest.has(snapshot.content_item_id)) latest.set(snapshot.content_item_id, snapshot);
  const observations: ExperimentObservation[] = assignments.flatMap((assignment) => {
    const snapshot = latest.get(assignment.content_item_id as string);
    if (!snapshot) return [];
    return [{
      variantKey: String(assignment.variant_key),
      contentId: String(assignment.content_item_id),
      metrics: normalizeMetrics(snapshot as Partial<PerformanceMetrics>),
    }];
  });
  const evaluation = evaluateExperiment(observations, Number(experiment.min_sample_size ?? 10));
  const updates: Row = {
    result: { ...evaluation, evaluated_at: new Date().toISOString(), observations: observations.length },
    decision: evaluation.status === 'winner' ? 'winner' : evaluation.status === 'inconclusive' ? 'inconclusive' : 'undecided',
    decision_reason: evaluation.reason,
  };
  if (complete && evaluation.status !== 'insufficient') {
    updates.status = 'completed';
    updates.completed_at = new Date().toISOString();
  }
  const updated = await supabase.from('brand_experiments').update(updates).eq('id', experimentId).select('*').single();
  if (updated.error) throw updated.error;

  let recommendation: Row | null = null;
  if (evaluation.status === 'winner' && evaluation.winner) {
    const existing = await supabase.from('optimization_recommendations').select('*')
      .eq('experiment_id', experimentId).eq('recommendation_type', 'experiment').in('status', ['proposed', 'approved', 'active']).maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) recommendation = existing.data as Row;
    else {
      const brand = await brandWorkspace(supabase, experiment.brand_id as string);
      const created = await supabase.from('optimization_recommendations').insert({
        workspace_id: brand.workspace_id,
        brand_id: experiment.brand_id,
        experiment_id: experimentId,
        recommendation_type: 'experiment',
        statement: `Adopt experiment variant “${evaluation.winner}” for the next controlled cycle.`,
        rationale: evaluation.reason,
        proposed_action: { action: 'adopt_experiment_variant', variant_key: evaluation.winner, experiment_id: experimentId },
        scope: {},
        confidence: evaluation.confidence,
        attribution_confidence: 'high',
        sample_size: observations.length,
        evidence_summary: evaluation,
        valid_until: new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10),
        created_by: 'experiment',
      }).select('*').single();
      if (created.error) throw created.error;
      recommendation = created.data as Row;
      await supabase.from('recommendation_evidence').insert({
        brand_id: experiment.brand_id,
        recommendation_id: recommendation.id,
        experiment_id: experimentId,
        evidence_type: 'experiment',
        payload: evaluation,
        weight: evaluation.confidence,
      });
    }
  }
  return { experiment: updated.data, evaluation, recommendation, evaluated_by: userId };
}

export async function optimizationHousekeeping(env: Env) {
  const service = createServiceClient(env);
  const currentDate = today();
  const recResult = await service.from('optimization_recommendations').select('id,memory_item_id')
    .in('status', ['proposed', 'approved', 'active', 'paused']).lt('valid_until', currentDate);
  if (recResult.error) throw recResult.error;
  const recommendations = (recResult.data ?? []) as Row[];
  if (recommendations.length) {
    await service.from('optimization_recommendations').update({ status: 'expired' }).in('id', recommendations.map((item) => item.id));
    const memoryIds = recommendations.map((item) => item.memory_item_id).filter((value): value is string => Boolean(value));
    if (memoryIds.length) await service.from('memory_items').update({ status: 'expired' }).in('id', memoryIds);
  }
  await service.from('fatigue_signals').update({ status: 'expired' }).in('status', ['open', 'acknowledged']).lt('expires_at', new Date().toISOString());
  await service.from('opportunity_signals').update({ status: 'expired' }).in('status', ['new', 'accepted']).lt('valid_until', currentDate);
  return { expired_recommendations: recommendations.length };
}
