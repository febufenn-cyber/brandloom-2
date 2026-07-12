type BrandBundle = {
  brand: Record<string, unknown>;
  profile?: Record<string, unknown> | null;
  products: Array<Record<string, unknown>>;
  audiences: Array<Record<string, unknown>>;
};

export function calculateReadiness(bundle: BrandBundle) {
  const checks = [
    ['Business description', Boolean(String(bundle.brand.description ?? '').trim()), 12],
    ['Category', Boolean(String(bundle.brand.category ?? '').trim()), 6],
    ['Location', Boolean(String(bundle.brand.location ?? '').trim()), 4],
    ['At least one product', bundle.products.length > 0, 15],
    ['Product facts', bundle.products.some((p) => Array.isArray(p.approved_facts) && p.approved_facts.length >= 2), 12],
    ['Primary audience', bundle.audiences.some((a) => a.is_primary === true), 12],
    ['Audience objections', bundle.audiences.some((a) => Array.isArray(a.objections) && a.objections.length > 0), 8],
    ['Tone calibration', Object.keys((bundle.profile?.tone_attributes as object | undefined) ?? {}).length >= 3, 10],
    ['Preferred phrases', Array.isArray(bundle.profile?.preferred_phrases) && bundle.profile.preferred_phrases.length > 0, 6],
    ['Prohibited phrases', Array.isArray(bundle.profile?.prohibited_phrases) && bundle.profile.prohibited_phrases.length > 0, 7],
    ['Positive examples', Array.isArray(bundle.profile?.positive_examples) && bundle.profile.positive_examples.length > 0, 4],
    ['Negative examples', Array.isArray(bundle.profile?.negative_examples) && bundle.profile.negative_examples.length > 0, 4],
  ] as const;

  const score = checks.reduce((sum, [, complete, weight]) => sum + (complete ? weight : 0), 0);
  return {
    score,
    strengths: checks.filter(([, complete]) => complete).map(([label]) => label),
    missing: checks.filter(([, complete]) => !complete).map(([label]) => label),
  };
}
