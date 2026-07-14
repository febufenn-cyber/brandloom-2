-- Brandloom Phase 10: enforce launch access at the Supabase Auth boundary

create or replace function public.enforce_brandloom_signup_gate()
returns trigger
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_registration_open boolean := false;
  v_invite_hash text;
  v_invite_valid boolean := false;
begin
  select registration_open into v_registration_open
  from public.public_access_controls where environment = 'production';

  v_invite_hash := nullif(new.raw_user_meta_data->>'beta_invite_token_hash', '');
  if v_invite_hash is not null then
    select exists(
      select 1 from public.beta_invites
      where token_hash = v_invite_hash and status = 'pending' and expires_at > now()
    ) into v_invite_valid;
  end if;

  if not coalesce(v_registration_open, false) and not v_invite_valid then
    raise exception 'Public registration is not open. Join the waitlist or use a valid beta invitation.' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists brandloom_signup_gate on auth.users;
create trigger brandloom_signup_gate
before insert on auth.users
for each row execute function public.enforce_brandloom_signup_gate();

revoke all on function public.enforce_brandloom_signup_gate() from public, anon, authenticated;
