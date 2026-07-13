-- Phase 6 review generation is a reviewer action, while raw metric import remains editor-only.

drop policy if exists optimization_reviews_write on public.optimization_reviews;
create policy optimization_reviews_write on public.optimization_reviews for all
  using (public.can_review_brand(brand_id))
  with check (public.can_review_brand(brand_id));

drop policy if exists recommendation_evidence_insert on public.recommendation_evidence;
create policy recommendation_evidence_insert on public.recommendation_evidence for insert
  with check (public.can_review_brand(brand_id));

drop policy if exists fatigue_signals_write on public.fatigue_signals;
create policy fatigue_signals_write on public.fatigue_signals for all
  using (public.can_review_brand(brand_id))
  with check (public.can_review_brand(brand_id));
