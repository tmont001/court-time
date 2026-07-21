-- 0071_fix_phase23_return_table_ambiguity.sql
--
-- Hotfix: qualify every unqualified "id" reference inside RETURNS TABLE
-- function bodies where the output column name shadows the table column.
-- PostgreSQL raises 42702 (ambiguous column) at runtime whenever a
-- RETURNS TABLE output variable shares a name with an unaliased column
-- reference in the body.  All six functions below had the pattern:
--
--   from public.profiles where id = auth.uid()
--
-- where "id" is both the first RETURNS TABLE output column and the
-- primary-key column of public.profiles.  Fix: alias the table and
-- qualify every reference.
--
-- Signatures, return types, SECURITY DEFINER, search_path, and
-- REVOKE/GRANT are unchanged.  No DROP FUNCTION used.

-- ── get_club_pros ─────────────────────────────────────────────────────────────

create or replace function public.get_club_pros()
returns table (
  id                 uuid,
  first_name         text,
  last_name          text,
  role               text,
  is_lesson_provider boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
begin
  select * into v_profile from public.profiles p where p.id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  return query
    select p.id, p.first_name, p.last_name, p.role, p.is_lesson_provider
      from public.profiles p
     where p.club_id            = v_profile.club_id
       and p.status             = 'active'
       and p.id                 <> auth.uid()
       and p.role               in ('pro', 'admin')
       and p.is_lesson_provider = true
     order by p.last_name nulls last, p.first_name nulls last;
end;
$$;

revoke execute on function public.get_club_pros() from public, anon;
grant  execute on function public.get_club_pros() to authenticated;


-- ── get_lesson_types ──────────────────────────────────────────────────────────

create or replace function public.get_lesson_types()
returns table (
  id                uuid,
  name              text,
  description       text,
  allowed_durations int[],
  max_participants  int,
  rate_amount       numeric,
  rate_currency     text,
  rate_notes        text,
  is_active         boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select p.club_id into v_club_id from public.profiles p where p.id = auth.uid();
  if v_club_id is null then raise exception 'no_club'; end if;

  return query
    select lt.id, lt.name, lt.description, lt.allowed_durations,
           lt.max_participants, lt.rate_amount, lt.rate_currency, lt.rate_notes, lt.is_active
      from public.lesson_types lt
     where lt.club_id  = v_club_id
       and lt.is_active = true
     order by lt.name;
end;
$$;

revoke execute on function public.get_lesson_types() from public, anon;
grant  execute on function public.get_lesson_types() to authenticated;


-- ── get_pro_availability_windows ──────────────────────────────────────────────

create or replace function public.get_pro_availability_windows(
  p_pro_id uuid default null
)
returns table (
  id          uuid,
  pro_id      uuid,
  day_of_week int,
  start_time  time,
  end_time    time,
  is_active   boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
begin
  select * into v_profile from public.profiles p where p.id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  return query
    select w.id, w.pro_id, w.day_of_week, w.start_time, w.end_time, w.is_active
      from public.pro_availability_windows w
     where w.club_id = v_profile.club_id
       and (p_pro_id is null or w.pro_id = p_pro_id)
     order by w.pro_id, w.day_of_week, w.start_time;
end;
$$;

revoke execute on function public.get_pro_availability_windows(uuid) from public, anon;
grant  execute on function public.get_pro_availability_windows(uuid) to authenticated;


-- ── get_pro_blackouts ─────────────────────────────────────────────────────────

create or replace function public.get_pro_blackouts(
  p_pro_id    uuid  default null,
  p_from_date date  default null,
  p_to_date   date  default null
)
returns table (
  id            uuid,
  pro_id        uuid,
  blackout_date date,
  reason        text,
  created_at    timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
begin
  select * into v_profile from public.profiles p where p.id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  return query
    select b.id, b.pro_id, b.blackout_date, b.reason, b.created_at
      from public.pro_blackout_dates b
     where b.club_id       = v_profile.club_id
       and (p_pro_id    is null or b.pro_id       = p_pro_id)
       and (p_from_date is null or b.blackout_date >= p_from_date)
       and (p_to_date   is null or b.blackout_date <= p_to_date)
     order by b.blackout_date;
end;
$$;

revoke execute on function public.get_pro_blackouts(uuid, date, date) from public, anon;
grant  execute on function public.get_pro_blackouts(uuid, date, date) to authenticated;


-- ── get_my_lesson_requests ────────────────────────────────────────────────────

create or replace function public.get_my_lesson_requests()
returns table (
  id                    uuid,
  pro_id                uuid,
  pro_first_name        text,
  pro_last_name         text,
  preferred_court_id    uuid,
  preferred_court_name  text,
  duration_minutes      int,
  member_note           text,
  preferred_windows     jsonb,
  proposed_starts_at    timestamptz,
  proposed_ends_at      timestamptz,
  proposed_court_id     uuid,
  proposed_court_name   text,
  status                text,
  decline_reason        text,
  cancellation_reason   text,
  linked_reservation_id uuid,
  created_at            timestamptz,
  updated_at            timestamptz,
  confirmed_at          timestamptz,
  lesson_type_id        uuid,
  lesson_type_name      text,
  lesson_outcome        text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
begin
  select * into v_profile from public.profiles p where p.id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  return query
    select
      lr.id,
      lr.pro_id,
      pro.first_name  as pro_first_name,
      pro.last_name   as pro_last_name,
      lr.preferred_court_id,
      pc.name         as preferred_court_name,
      lr.duration_minutes,
      lr.member_note,
      lr.preferred_windows,
      lr.proposed_starts_at,
      lr.proposed_ends_at,
      lr.proposed_court_id,
      xc.name         as proposed_court_name,
      lr.status,
      lr.decline_reason,
      lr.cancellation_reason,
      lr.linked_reservation_id,
      lr.created_at,
      lr.updated_at,
      lr.confirmed_at,
      lr.lesson_type_id,
      lt.name         as lesson_type_name,
      lr.lesson_outcome
    from public.lesson_requests lr
    join public.profiles pro on pro.id = lr.pro_id
    left join public.courts pc on pc.id = lr.preferred_court_id
    left join public.courts xc on xc.id = lr.proposed_court_id
    left join public.lesson_types lt on lt.id = lr.lesson_type_id
   where lr.member_id = auth.uid()
     and lr.club_id   = v_profile.club_id
   order by lr.created_at desc;
end;
$$;

revoke execute on function public.get_my_lesson_requests() from public, anon;
grant  execute on function public.get_my_lesson_requests() to authenticated;


-- ── get_pro_lesson_requests ───────────────────────────────────────────────────

create or replace function public.get_pro_lesson_requests(
  p_pro_filter uuid default null,
  p_status     text default null
)
returns table (
  id                    uuid,
  member_id             uuid,
  member_first_name     text,
  member_last_name      text,
  pro_id                uuid,
  pro_first_name        text,
  pro_last_name         text,
  preferred_court_id    uuid,
  preferred_court_name  text,
  duration_minutes      int,
  member_note           text,
  preferred_windows     jsonb,
  proposed_starts_at    timestamptz,
  proposed_ends_at      timestamptz,
  proposed_court_id     uuid,
  proposed_court_name   text,
  status                text,
  decline_reason        text,
  cancellation_reason   text,
  last_actor_role       text,
  linked_reservation_id uuid,
  created_at            timestamptz,
  updated_at            timestamptz,
  confirmed_at          timestamptz,
  lesson_type_id        uuid,
  lesson_type_name      text,
  lesson_outcome        text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
begin
  select * into v_profile from public.profiles p where p.id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;
  if v_profile.role not in ('pro', 'admin') then raise exception 'insufficient_role'; end if;

  if v_profile.role = 'pro' and p_pro_filter is not null and p_pro_filter <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  return query
    select
      lr.id,
      lr.member_id,
      mem.first_name  as member_first_name,
      mem.last_name   as member_last_name,
      lr.pro_id,
      pro.first_name  as pro_first_name,
      pro.last_name   as pro_last_name,
      lr.preferred_court_id,
      pc.name         as preferred_court_name,
      lr.duration_minutes,
      lr.member_note,
      lr.preferred_windows,
      lr.proposed_starts_at,
      lr.proposed_ends_at,
      lr.proposed_court_id,
      xc.name         as proposed_court_name,
      lr.status,
      lr.decline_reason,
      lr.cancellation_reason,
      lr.last_actor_role,
      lr.linked_reservation_id,
      lr.created_at,
      lr.updated_at,
      lr.confirmed_at,
      lr.lesson_type_id,
      lt.name         as lesson_type_name,
      lr.lesson_outcome
    from public.lesson_requests lr
    join public.profiles mem on mem.id = lr.member_id
    join public.profiles pro on pro.id = lr.pro_id
    left join public.courts pc on pc.id = lr.preferred_court_id
    left join public.courts xc on xc.id = lr.proposed_court_id
    left join public.lesson_types lt on lt.id = lr.lesson_type_id
   where lr.club_id = v_profile.club_id
     and (
       (v_profile.role = 'pro'   and lr.pro_id = auth.uid())
       or
       (v_profile.role = 'admin' and (p_pro_filter is null or lr.pro_id = p_pro_filter))
     )
     and (p_status is null or lr.status = p_status)
   order by
     case lr.status
       when 'pending'   then 0
       when 'proposed'  then 1
       when 'confirmed' then 2
       else 3
     end,
     lr.created_at desc;
end;
$$;

revoke execute on function public.get_pro_lesson_requests(uuid, text) from public, anon;
grant  execute on function public.get_pro_lesson_requests(uuid, text) to authenticated;
