export type PerformanceMetrics = {
  impressions: number;
  reach: number;
  likes: number;
  comments: number;
  saves: number;
  shares: number;
  clicks: number;
  profile_visits: number;
  follows: number;
  video_views: number;
  watch_time_seconds: number;
};

export type OptimizationSample = {
  contentId: string;
  scheduledDate: string;
  format: string;
  pillar: string;
  productId?: string | null;
  hookType: string;
  ctaType: string;
  emotionalAngle?: string;
  metrics: PerformanceMetrics;
};

export type RecommendationDraft = {
  type: 'content_mix' | 'hook' | 'cta' | 'format' | 'timing' | 'audience' | 'product' | 'campaign' | 'fatigue' | 'experiment' | 'measurement';
  statement: string;
  rationale: string;
  proposedAction: Record<string, unknown>;
  scope: Record<string, unknown>;
  confidence: number;
  attributionConfidence: 'low' | 'medium' | 'high';
  sampleSize: number;
  evidenceSummary: Record<string, unknown>;
};

export type FatigueDraft = {
  signalType: 'hook' | 'cta' | 'pillar' | 'format' | 'product' | 'audience';
  signalKey: string;
  score: number;
  recentCount: number;
  baselineCount: number;
  performanceChange: number;
  evidence: Record<string, unknown>;
};

type SegmentStats = {
  key: string;
  sampleSize: number;
  averageScore: number;
  totalReach: number;
  contentIds: string[];
};

const finite = (value: unknown) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const rounded = (value: number, digits = 4) => Number(value.toFixed(digits));

export function normalizeMetrics(input: Partial<PerformanceMetrics>): PerformanceMetrics {
  return {
    impressions: finite(input.impressions), reach: finite(input.reach), likes: finite(input.likes),
    comments: finite(input.comments), saves: finite(input.saves), shares: finite(input.shares),
    clicks: finite(input.clicks), profile_visits: finite(input.profile_visits), follows: finite(input.follows),
    video_views: finite(input.video_views), watch_time_seconds: finite(input.watch_time_seconds),
  };
}

export function safeRate(numerator: number, denominator: number) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return numerator / denominator;
}

export function performanceRates(metrics: PerformanceMetrics) {
  const denominator = Math.max(metrics.reach, metrics.impressions, 1);
  const engagement = metrics.likes + metrics.comments + metrics.saves + metrics.shares;
  return {
    engagement_rate: rounded(safeRate(engagement, denominator)),
    save_rate: rounded(safeRate(metrics.saves, denominator)),
    share_rate: rounded(safeRate(metrics.shares, denominator)),
    comment_rate: rounded(safeRate(metrics.comments, denominator)),
    click_rate: rounded(safeRate(metrics.clicks, denominator)),
    follow_rate: rounded(safeRate(metrics.follows, denominator)),
    profile_visit_rate: rounded(safeRate(metrics.profile_visits, denominator)),
    view_rate: rounded(safeRate(metrics.video_views, Math.max(metrics.impressions, 1))),
    average_watch_seconds: rounded(safeRate(metrics.watch_time_seconds, Math.max(metrics.video_views, 1)), 2),
  };
}

export function performanceScore(metrics: PerformanceMetrics) {
  const rates = performanceRates(metrics);
  return rounded(
    rates.engagement_rate * 0.18 + rates.save_rate * 1.5 + rates.share_rate * 1.8 +
    rates.comment_rate * 0.8 + rates.click_rate * 1.4 + rates.follow_rate * 2.2 +
    rates.profile_visit_rate * 0.6,
    6,
  );
}

export function confidenceForSample(sampleSize: number, relativeEffect = 0, randomized = false) {
  const sizeComponent = Math.min(Math.max(sampleSize, 0) / 40, 1) * 0.42;
  const effectComponent = Math.min(Math.abs(relativeEffect), 1) * 0.18;
  const designComponent = randomized ? 0.18 : 0;
  return rounded(Math.min(randomized ? 0.95 : 0.78, 0.18 + sizeComponent + effectComponent + designComponent), 3);
}

export function attributionLabel(sampleSize: number, randomized = false): 'low' | 'medium' | 'high' {
  if (randomized && sampleSize >= 20) return 'high';
  return sampleSize >= 8 ? 'medium' : 'low';
}

function groupStats(samples: OptimizationSample[], selector: (sample: OptimizationSample) => string | null | undefined) {
  const groups = new Map<string, OptimizationSample[]>();
  for (const sample of samples) {
    const key = (selector(sample) ?? '').trim();
    if (key) groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  return [...groups.entries()].map(([key, values]): SegmentStats => ({
    key,
    sampleSize: values.length,
    averageScore: rounded(values.reduce((sum, item) => sum + performanceScore(item.metrics), 0) / Math.max(values.length, 1), 6),
    totalReach: values.reduce((sum, item) => sum + item.metrics.reach, 0),
    contentIds: values.map((item) => item.contentId),
  })).sort((a, b) => b.averageScore - a.averageScore);
}

function aggregateMetrics(samples: OptimizationSample[]) {
  const total = samples.reduce((result, sample) => {
    for (const key of Object.keys(result) as Array<keyof PerformanceMetrics>) result[key] += sample.metrics[key];
    return result;
  }, normalizeMetrics({}));
  const scores = samples.map((sample) => performanceScore(sample.metrics));
  return {
    sample_size: samples.length,
    metrics: total,
    rates: performanceRates(total),
    average_score: rounded(scores.reduce((sum, value) => sum + value, 0) / Math.max(scores.length, 1), 6),
  };
}

function segmentRecommendation(
  samples: OptimizationSample[],
  label: 'hook' | 'cta' | 'format' | 'content_mix',
  selector: (sample: OptimizationSample) => string | null | undefined,
): RecommendationDraft | null {
  const groups = groupStats(samples, selector).filter((group) => group.sampleSize >= 3);
  const best = groups[0];
  const runnerUp = groups[1];
  if (!best || !runnerUp) return null;
  const overall = aggregateMetrics(samples).average_score;
  const comparison = Math.max(runnerUp.averageScore, overall, 0.000001);
  const lift = (best.averageScore - comparison) / comparison;
  if (lift < 0.12) return null;
  const display = label === 'content_mix' ? 'pillar' : label;
  return {
    type: label,
    statement: `Test more ${display} executions using “${best.key}” while preserving variety.`,
    rationale: `This segment scored ${Math.round(lift * 100)}% above the nearest qualified comparison across ${best.sampleSize} measured posts. This is correlation, not proof of causation.`,
    proposedAction: { action: 'increase_test_share', dimension: display, value: best.key, recommended_share_change: 0.15 },
    scope: {},
    confidence: confidenceForSample(best.sampleSize, lift, false),
    attributionConfidence: attributionLabel(best.sampleSize),
    sampleSize: best.sampleSize,
    evidenceSummary: { lift: rounded(lift), best, runner_up: runnerUp, qualified_groups: groups },
  };
}

function detectFatigueFor(
  samples: OptimizationSample[],
  signalType: FatigueDraft['signalType'],
  selector: (sample: OptimizationSample) => string | null | undefined,
): FatigueDraft[] {
  const groups = groupStats(samples, selector);
  const overall = aggregateMetrics(samples).average_score;
  const total = Math.max(samples.length, 1);
  return groups.flatMap((group) => {
    const share = group.sampleSize / total;
    if (group.sampleSize < 3 || share < 0.42) return [];
    const change = overall > 0 ? (group.averageScore - overall) / overall : 0;
    const score = rounded(Math.min(1, Math.min(1, share / 0.7) * 0.65 + Math.min(1, Math.max(0, -change)) * 0.35), 4);
    if (score < 0.48) return [];
    return [{
      signalType, signalKey: group.key, score, recentCount: group.sampleSize,
      baselineCount: total - group.sampleSize, performanceChange: rounded(change),
      evidence: { share: rounded(share), average_score: group.averageScore, overall_score: overall, content_ids: group.contentIds },
    }];
  });
}

export function buildOptimizationInsights(samples: OptimizationSample[]) {
  const aggregate = aggregateMetrics(samples);
  const recommendations: RecommendationDraft[] = [];
  const fatigue: FatigueDraft[] = [];

  if (samples.length < 6) {
    recommendations.push({
      type: 'measurement',
      statement: 'Collect a larger, consistently measured content sample before changing strategy.',
      rationale: `Only ${samples.length} content items have usable performance snapshots. Small samples are highly sensitive to timing, audience and platform noise.`,
      proposedAction: { action: 'collect_measurement', target_sample_size: 12, required_fields: ['reach', 'saves', 'shares', 'clicks'] },
      scope: {}, confidence: 0.95, attributionConfidence: 'low', sampleSize: samples.length,
      evidenceSummary: { current_sample_size: samples.length, minimum_recommended: 12 },
    });
  } else {
    const candidates = [
      segmentRecommendation(samples, 'hook', (sample) => sample.hookType),
      segmentRecommendation(samples, 'cta', (sample) => sample.ctaType),
      segmentRecommendation(samples, 'format', (sample) => sample.format),
      segmentRecommendation(samples, 'content_mix', (sample) => sample.pillar),
    ].filter((item): item is RecommendationDraft => item !== null);
    recommendations.push(...candidates.slice(0, 4));
  }

  fatigue.push(
    ...detectFatigueFor(samples, 'hook', (sample) => sample.hookType),
    ...detectFatigueFor(samples, 'cta', (sample) => sample.ctaType),
    ...detectFatigueFor(samples, 'pillar', (sample) => sample.pillar),
    ...detectFatigueFor(samples, 'format', (sample) => sample.format),
    ...detectFatigueFor(samples, 'product', (sample) => sample.productId ?? ''),
  );

  for (const signal of fatigue.slice(0, 5)) recommendations.push({
    type: 'fatigue',
    statement: `Reduce near-term repetition of ${signal.signalType} “${signal.signalKey}” and test a distinct alternative.`,
    rationale: `It appears in ${signal.recentCount} of ${samples.length} measured posts. The fatigue score is ${Math.round(signal.score * 100)}%.`,
    proposedAction: { action: 'reduce_repetition', dimension: signal.signalType, value: signal.signalKey, cooling_posts: 4 },
    scope: {}, confidence: rounded(Math.min(0.78, 0.4 + signal.score * 0.35), 3),
    attributionConfidence: attributionLabel(signal.recentCount), sampleSize: signal.recentCount,
    evidenceSummary: signal.evidence,
  });

  const topContent = [...samples].sort((a, b) => performanceScore(b.metrics) - performanceScore(a.metrics)).slice(0, 5)
    .map((sample) => ({ content_id: sample.contentId, score: performanceScore(sample.metrics), rates: performanceRates(sample.metrics) }));
  return {
    summary: samples.length ? `${samples.length} measured content items produced ${recommendations.length} cautious recommendations and ${fatigue.length} fatigue signals.` : 'No usable performance observations are available yet.',
    aggregate,
    segments: {
      hooks: groupStats(samples, (sample) => sample.hookType), ctas: groupStats(samples, (sample) => sample.ctaType),
      formats: groupStats(samples, (sample) => sample.format), pillars: groupStats(samples, (sample) => sample.pillar),
      products: groupStats(samples, (sample) => sample.productId ?? ''),
    },
    top_content: topContent,
    recommendations,
    fatigue,
  };
}

export type ExperimentObservation = { variantKey: string; contentId: string; metrics: PerformanceMetrics };

export function evaluateExperiment(observations: ExperimentObservation[], minSampleSize: number) {
  const groups = new Map<string, ExperimentObservation[]>();
  for (const observation of observations) groups.set(observation.variantKey, [...(groups.get(observation.variantKey) ?? []), observation]);
  const variants = [...groups.entries()].map(([key, values]) => ({
    key, sample_size: values.length,
    average_score: rounded(values.reduce((sum, value) => sum + performanceScore(value.metrics), 0) / Math.max(values.length, 1), 6),
    total_reach: values.reduce((sum, value) => sum + value.metrics.reach, 0),
    content_ids: values.map((value) => value.contentId),
  })).sort((a, b) => b.average_score - a.average_score);

  const winner = variants[0];
  const runnerUp = variants[1];
  if (!winner || !runnerUp || variants.some((variant) => variant.sample_size < minSampleSize)) return {
    status: 'insufficient' as const, winner: null, confidence: 0, lift: 0, variants,
    reason: `Every variant needs at least ${minSampleSize} measured assignments.`,
  };

  const lift = (winner.average_score - runnerUp.average_score) / Math.max(runnerUp.average_score, 0.000001);
  const totalSample = variants.reduce((sum, variant) => sum + variant.sample_size, 0);
  const confidence = confidenceForSample(totalSample, lift, true);
  const meaningful = lift >= 0.1 && confidence >= 0.7;
  return {
    status: meaningful ? 'winner' as const : 'inconclusive' as const,
    winner: meaningful ? winner.key : null,
    confidence, lift: rounded(lift), variants,
    reason: meaningful ? `${winner.key} leads by ${Math.round(lift * 100)}% at modeled confidence ${Math.round(confidence * 100)}%.` : 'The measured difference is not yet strong enough to select a winner.',
  };
}

export function opportunityScore(input: { relevance: number; confidence: number; validUntil?: string | null; now?: Date }) {
  const now = input.now ?? new Date();
  let urgency = 0.65;
  if (input.validUntil) {
    const days = (new Date(input.validUntil).getTime() - now.getTime()) / 86_400_000;
    urgency = days <= 0 ? 0 : days <= 7 ? 1 : days <= 30 ? 0.85 : 0.65;
  }
  return rounded(Math.max(0, Math.min(1, input.relevance * 0.45 + input.confidence * 0.35 + urgency * 0.20)), 3);
}
