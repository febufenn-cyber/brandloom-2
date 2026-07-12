-- Phase 3 integrity is enforced below the API so every editor path is safe.

create or replace function public.bump_content_material_revision()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if row(old.title, old.hook, old.caption, old.cta, old.visual_brief, old.scheduled_date,
         old.product_id, old.campaign_id, old.format, old.facts_used, old.hashtags)
     is distinct from
     row(new.title, new.hook, new.caption, new.cta, new.visual_brief, new.scheduled_date,
         new.product_id, new.campaign_id, new.format, new.facts_used, new.hashtags) then
    new.material_revision := old.material_revision + 1;
    if old.workflow_status in ('approved', 'ready_to_publish') and new.workflow_status = old.workflow_status then
      new.workflow_status := 'internal_review';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.stale_old_approvals()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if new.material_revision > old.material_revision then
    update public.approval_requests
    set status = 'stale', decision_comment = 'Content changed after this approval was requested.'
    where content_item_id = new.id
      and material_revision < new.material_revision
      and status in ('pending', 'approved');
  end if;
  return new;
end;
$$;

create trigger content_material_revision_before_update
before update on public.content_items
for each row execute function public.bump_content_material_revision();

create trigger content_approval_staleness_after_update
after update on public.content_items
for each row execute function public.stale_old_approvals();

create policy notifications_workspace_insert on public.notifications
for insert with check (public.can_review_workspace(workspace_id));
