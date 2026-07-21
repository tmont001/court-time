-- 0070_lesson_competitive_foundation.sql
-- Phase 23 (Part 2): Competitive Lesson Foundation
--
-- Builds on migration 0069 (lesson_requests core lifecycle) by adding the
-- structural elements needed for a competitive lesson booking product:
--
-- 1. is_lesson_provider flag on profiles (explicit pro designation)
-- 2. lesson_types table (private, semi-private, hitting session, custom)
-- 3. lesson_type_id nullable FK on lesson_requests
-- 4. lesson_outcome column on lesson_requests (completed / no-show / cancelled)
-- 5. pro_availability_windows (recurring weekly; informational, not hard-enforced)
-- 6. pro_blackout_dates (specific off-days; enforced in confirm/accept RPCs)
-- 7. Security-definer RPCs for all new structures
-- 8. Updated _lesson_check_pro_availability to honor blackout dates
-- 9. Updated submit_lesson_request to accept optional lesson_type_id
-- 10. Updated get_my_lesson_requests / get_pro_lesson_requests to include type name
--
-- Not included: payment, packages, memberships, payroll, commissions,
-- recurring subscriptions, POS, public guest booking, native apps.
--
-- Safe to re-apply: CREATE OR REPLACE functions; CREATE TABLE IF NOT EXISTS;
-- ADD COLUMN IF NOT EXISTS; DROP CONSTRAINT IF EXISTS before ADD CONSTRAINT.
-- Apply in Supabase SQL Editor after migration 0069.


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Explicit lesson-provider designation on profiles
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.profiles
  add column if not exists is_lesson_provider boolean not null default false;

-- Backfill: existing active pros become providers; admins remain false
-- unless an admin deliberately enables themselves in a future management UI.
update public.profiles
   set is_lesson_provider = true
 where role   = 'pro'
   and status = 'active'
   and is_lesson_provider = false;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. lesson_types — configurable lesson formats per club
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.lesson_types (
  id                 uuid          primary key default gen_random_uuid(),
  club_id            uuid          not null references public.clubs(id) on delete cascade,
  name               text          not null,
  description        text,
  -- Allowed durations in minutes (e.g. {30,45,60,90}); null = any valid multiple
  allowed_durations  int[],
  -- Maximum participants: 1 = private, 2 = semi-private, etc.
  max_participants   int           not null default 1 check (max_participants >= 1),
  -- Optional informational rate
  rate_amount        numeric(10,2),
  rate_currency      text          not null default 'USD',
  rate_notes         text,
  -- Lifecycle
  is_active          boolean       not null default true,
  created_at         timestamptz   not null default now(),
  updated_at         timestamptz   not null default now(),
  constraint lesson_type_name_nonempty check (char_length(trim(name)) > 0),
  constraint lesson_type_name_length   check (char_length(name) <= 100)
);

create index if not exists lesson_types_club_idx on public.lesson_types (club_id) where is_active;

drop trigger if exists lesson_types_updated_at on public.lesson_types;
create trigger lesson_types_updated_at
  before update on public.lesson_types
  for each row execute function trigger_set_updated_at();

alter table public.lesson_types enable row level security;

drop policy if exists "lesson_types_select_club" on public.lesson_types;
create policy "lesson_types_select_club"
  on public.lesson_types for select
  using (club_id = current_user_club_id());


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Add lesson_type_id and lesson_outcome to lesson_requests
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.lesson_requests
  add column if not exists lesson_type_id uuid references public.lesson_types(id),
  add column if not exists lesson_outcome text;

alter table public.lesson_requests
  drop constraint if exists lesson_requests_outcome_check;

alter table public.lesson_requests
  add constraint lesson_requests_outcome_check
  check (lesson_outcome in ('completed', 'member_no_show', 'pro_no_show', 'cancelled'));


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. pro_availability_windows — recurring weekly schedule (informational)
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.pro_availability_windows (
  id           uuid        primary key default gen_random_uuid(),
  club_id      uuid        not null references public.clubs(id) on delete cascade,
  pro_id       uuid        not null references public.profiles(id) on delete cascade,
  -- 0 = Sunday ... 6 = Saturday (matches extract(dow ...))
  day_of_week  int         not null check (day_of_week between 0 and 6),
  start_time   time        not null,
  end_time     time        not null,
  is_active    boolean     not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint pro_availability_time_order check (end_time > start_time),
  unique (pro_id, day_of_week, start_time)
);

create index if not exists pro_availability_pro_idx  on public.pro_availability_windows (pro_id);
create index if not exists pro_availability_club_idx on public.pro_availability_windows (club_id);

drop trigger if exists pro_availability_windows_updated_at on public.pro_availability_windows;
create trigger pro_availability_windows_updated_at
  before update on public.pro_availability_windows
  for each row execute function trigger_set_updated_at();

alter table public.pro_availability_windows enable row level security;

drop policy if exists "pro_availability_select_club" on public.pro_availability_windows;
create policy "pro_availability_select_club"
  on public.pro_availability_windows for select
  using (club_id = current_user_club_id());


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. pro_blackout_dates — specific off-days (enforced in confirm/accept RPCs)
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.pro_blackout_dates (
  id             uuid        primary key default gen_random_uuid(),
  club_id        uuid        not null references public.clubs(id) on delete cascade,
  pro_id         uuid        not null references public.profiles(id) on delete cascade,
  blackout_date  date        not null,
  reason         text,
  created_at     timestamptz not null default now(),
  unique (pro_id, blackout_date)
);

create index if not exists pro_blackout_pro_idx  on public.pro_blackout_dates (pro_id);
create index if not exists pro_blackout_club_idx on public.pro_blackout_dates (club_id);

alter table public.pro_blackout_dates enable row level security;

drop policy if exists "pro_blackout_select_club" on public.pro_blackout_dates;
create policy "pro_blackout_select_club"
  on public.pro_blackout_dates for select
  using (club_id = current_user_club_id());


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. RPCs
-- ═══════════════════════════════════════════════════════════════════════════

-- ── get_club_pros: respect is_lesson_provider flag ──────────────────────────
-- Replaces the Phase 23 version to filter out pros who have been marked as
-- non-providers. Default is true (all pros are providers until opt-out).

drop function if exists public.get_club_pros();

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
  select * into v_profile from public.profiles where id = auth.uid();
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


-- ── get_lesson_types: returns active types for the caller's club ─────────────

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
  select club_id into v_club_id from public.profiles where id = auth.uid();
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


-- ── upsert_lesson_type: admin creates or updates a lesson type ───────────────

create or replace function public.upsert_lesson_type(
  p_id                uuid    default null,
  p_name              text    default null,
  p_description       text    default null,
  p_allowed_durations int[]   default null,
  p_max_participants  int     default 1,
  p_rate_amount       numeric default null,
  p_rate_currency     text    default 'USD',
  p_rate_notes        text    default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_result  uuid;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  if p_name is null or btrim(p_name) = '' then raise exception 'name_required'; end if;
  if char_length(p_name) > 100 then raise exception 'name_too_long'; end if;

  -- Validate allowed_durations: non-empty when provided; each value must be a
  -- positive multiple of 15 (consistent with the lesson_requests.duration_minutes check).
  if p_allowed_durations is not null then
    if array_length(p_allowed_durations, 1) = 0 then
      raise exception 'allowed_durations_empty';
    end if;
    if exists (
      select 1 from unnest(p_allowed_durations) d(v)
       where v <= 0 or v % 15 <> 0
    ) then
      raise exception 'allowed_durations_invalid';
    end if;
  end if;

  -- Rate must be positive when supplied
  if p_rate_amount is not null and p_rate_amount <= 0 then
    raise exception 'rate_amount_invalid';
  end if;

  -- max_participants: the CHECK constraint enforces >= 1, also guard here
  if p_max_participants < 1 then raise exception 'max_participants_invalid'; end if;

  if p_id is not null then
    -- Update existing
    update public.lesson_types
       set name              = btrim(p_name),
           description       = p_description,
           allowed_durations = p_allowed_durations,
           max_participants  = p_max_participants,
           rate_amount       = p_rate_amount,
           rate_currency     = coalesce(p_rate_currency, 'USD'),
           rate_notes        = p_rate_notes,
           updated_at        = now()
     where id      = p_id
       and club_id = v_profile.club_id
    returning id into v_result;

    if not found then raise exception 'lesson_type_not_found'; end if;
  else
    insert into public.lesson_types (
      club_id, name, description, allowed_durations,
      max_participants, rate_amount, rate_currency, rate_notes
    ) values (
      v_profile.club_id,
      btrim(p_name),
      p_description,
      p_allowed_durations,
      p_max_participants,
      p_rate_amount,
      coalesce(p_rate_currency, 'USD'),
      p_rate_notes
    ) returning id into v_result;
  end if;

  return v_result;
end;
$$;

revoke execute on function public.upsert_lesson_type(uuid, text, text, int[], int, numeric, text, text) from public, anon;
grant  execute on function public.upsert_lesson_type(uuid, text, text, int[], int, numeric, text, text) to authenticated;


-- ── archive_lesson_type: admin soft-deletes a lesson type ───────────────────

create or replace function public.archive_lesson_type(p_type_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  update public.lesson_types
     set is_active  = false,
         updated_at = now()
   where id      = p_type_id
     and club_id = v_profile.club_id;

  if not found then raise exception 'lesson_type_not_found'; end if;
end;
$$;

revoke execute on function public.archive_lesson_type(uuid) from public, anon;
grant  execute on function public.archive_lesson_type(uuid) to authenticated;


-- ── submit_lesson_request: updated to accept optional lesson_type_id ─────────
-- Replaces the Phase 23 version. Added: p_lesson_type_id parameter.

create or replace function public.submit_lesson_request(
  p_pro_id              uuid,
  p_duration_minutes    int,
  p_preferred_court_id  uuid    default null,
  p_member_note         text    default null,
  p_preferred_windows   jsonb   default null,
  p_lesson_type_id      uuid    default null
)
returns public.lesson_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_pro     public.profiles%rowtype;
  v_result  public.lesson_requests%rowtype;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;
  if v_profile.status <> 'active' then raise exception 'account_inactive'; end if;

  -- Validate pro
  select * into v_pro
    from public.profiles
   where id      = p_pro_id
     and club_id = v_profile.club_id
     and status  = 'active'
     and role    in ('pro', 'admin')
     and is_lesson_provider = true;
  if not found then raise exception 'pro_not_found'; end if;

  if p_pro_id = auth.uid() then raise exception 'cannot_request_yourself'; end if;

  -- Duration: positive multiple of 15 minutes, minimum 30
  if p_duration_minutes < 30 or p_duration_minutes % 15 <> 0 then
    raise exception 'invalid_duration';
  end if;

  -- Input length validation
  if length(p_member_note) > 500 then raise exception 'note_too_long'; end if;

  -- Validate optional preferred court
  if p_preferred_court_id is not null and not exists (
    select 1 from public.courts
     where id       = p_preferred_court_id
       and club_id  = v_profile.club_id
       and is_active = true
  ) then
    raise exception 'court_not_found';
  end if;

  -- Validate optional lesson type (active, same club)
  if p_lesson_type_id is not null then
    if not exists (
      select 1 from public.lesson_types
       where id       = p_lesson_type_id
         and club_id  = v_profile.club_id
         and is_active = true
    ) then
      raise exception 'lesson_type_not_found';
    end if;

    -- Enforce that requested duration is among the type's allowed durations (when set)
    if exists (
      select 1 from public.lesson_types lt
       where lt.id            = p_lesson_type_id
         and lt.allowed_durations is not null
         and array_length(lt.allowed_durations, 1) > 0
         and not (p_duration_minutes = any(lt.allowed_durations))
    ) then
      raise exception 'duration_not_allowed_for_type';
    end if;
  end if;

  insert into public.lesson_requests (
    club_id, member_id, pro_id,
    preferred_court_id, duration_minutes,
    member_note, preferred_windows, status,
    lesson_type_id,
    last_actor_id, last_actor_role
  ) values (
    v_profile.club_id,
    auth.uid(),
    p_pro_id,
    p_preferred_court_id,
    p_duration_minutes,
    btrim(coalesce(p_member_note, '')),
    p_preferred_windows,
    'pending',
    p_lesson_type_id,
    auth.uid(), 'member'
  ) returning * into v_result;

  -- Create a dismissible notification for the pro
  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    p_pro_id,
    'lesson_request_received',
    trim(coalesce(v_profile.first_name, '') || ' ' || coalesce(v_profile.last_name, '')) ||
      ' has requested a ' || p_duration_minutes || '-minute lesson.',
    jsonb_build_object('request_id', v_result.id)
  );

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'submit_lesson_request', 'lesson_request', v_result.id,
    jsonb_build_object('pro_id', p_pro_id, 'duration_minutes', p_duration_minutes)
  );

  return v_result;
end;
$$;

revoke execute on function public.submit_lesson_request(uuid, int, uuid, text, jsonb, uuid) from public, anon;
grant  execute on function public.submit_lesson_request(uuid, int, uuid, text, jsonb, uuid) to authenticated;

-- Drop the old 5-parameter signature to eliminate the ambiguous overload.
-- PostgREST selects functions by argument count; leaving both signatures
-- registered causes an unresolvable overload error at runtime even though
-- PostgreSQL itself handles it correctly.
drop function if exists public.submit_lesson_request(uuid, int, uuid, text, jsonb);


-- ── cancel_lesson: updated to set lesson_outcome = 'cancelled' atomically ─────
-- Replaces the Phase 23 version. The lesson_outcome column was added in this
-- migration, so the 0069 version cannot reference it.

create or replace function public.cancel_lesson(
  p_request_id uuid,
  p_reason     text default null
)
returns public.lesson_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile      public.profiles%rowtype;
  v_request      public.lesson_requests%rowtype;
  v_actor_role   text;
  v_result       public.lesson_requests%rowtype;
  v_member       public.profiles%rowtype;
  v_pro          public.profiles%rowtype;
  v_window_hours int;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  select * into v_request
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_profile.club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  -- Authorisation: member of the lesson, the pro, or an admin
  if v_request.member_id <> auth.uid()
     and v_request.pro_id    <> auth.uid()
     and v_profile.role      <> 'admin' then
    raise exception 'not_authorised_to_cancel';
  end if;

  if v_request.status <> 'confirmed' then
    raise exception 'invalid_status_for_cancel';
  end if;

  -- Block cancellation of already-started or past lessons by non-admins
  if v_request.proposed_starts_at <= now() and v_profile.role <> 'admin' then
    raise exception 'lesson_already_started';
  end if;

  -- Derive actor role for audit / notification context
  v_actor_role := case
    when v_profile.role = 'admin' then 'admin'
    when auth.uid() = v_request.pro_id then 'pro'
    else 'member'
  end;

  -- Honor the club's cancellation window for member-initiated cancellations
  if v_actor_role = 'member' then
    select coalesce(cs.cancellation_window_hours, 24) into v_window_hours
      from public.club_settings cs
     where cs.club_id = v_profile.club_id;
    if (extract(epoch from (v_request.proposed_starts_at - now())) / 3600) < v_window_hours then
      raise exception 'within_cancellation_window';
    end if;
  end if;

  -- Cancel the linked reservation.
  -- cancellation_kind only allows 'member'|'admin'|'system'; map 'pro' → 'admin'.
  if v_request.linked_reservation_id is not null then
    update public.reservations
       set status            = 'cancelled',
           cancelled_at      = now(),
           cancelled_by      = auth.uid(),
           cancellation_kind = case when v_actor_role = 'member' then 'member' else 'admin' end
     where id = v_request.linked_reservation_id;
  end if;

  -- Update the request; set lesson_outcome = 'cancelled' so status and outcome
  -- remain consistent (outcome is never left null for a cancelled lesson).
  update public.lesson_requests
     set status              = 'cancelled',
         lesson_outcome      = 'cancelled',
         cancellation_reason = p_reason,
         cancelled_at        = now(),
         cancelled_by        = auth.uid(),
         last_actor_id       = auth.uid(),
         last_actor_role     = v_actor_role,
         updated_at          = now()
   where id = p_request_id
  returning * into v_result;

  -- Fetch names for notification bodies
  select * into v_member from public.profiles where id = v_request.member_id;
  select * into v_pro    from public.profiles where id = v_request.pro_id;

  -- Notify both parties (skip actor — they already know)
  if auth.uid() <> v_request.member_id then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_profile.club_id,
      v_request.member_id,
      'lesson_cancelled',
      'Your lesson with ' ||
        trim(coalesce(v_pro.first_name, '') || ' ' || coalesce(v_pro.last_name, '')) ||
        ' has been cancelled.' ||
        case when p_reason is not null and btrim(p_reason) <> ''
             then ' Reason: ' || btrim(p_reason)
             else ''
        end,
      jsonb_build_object('request_id', p_request_id)
    );
  end if;

  if auth.uid() <> v_request.pro_id then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_profile.club_id,
      v_request.pro_id,
      'lesson_cancelled',
      'Lesson with ' ||
        trim(coalesce(v_member.first_name, '') || ' ' || coalesce(v_member.last_name, '')) ||
        ' has been cancelled.' ||
        case when p_reason is not null and btrim(p_reason) <> ''
             then ' Reason: ' || btrim(p_reason)
             else ''
        end,
      jsonb_build_object('request_id', p_request_id)
    );
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'cancel_lesson', 'lesson_request', p_request_id,
    jsonb_build_object('reason', p_reason, 'reservation_id', v_request.linked_reservation_id)
  );

  return v_result;
end;
$$;

revoke execute on function public.cancel_lesson(uuid, text) from public, anon;
grant  execute on function public.cancel_lesson(uuid, text) to authenticated;


-- ── mark_lesson_outcome: pro/admin records the outcome after a lesson ─────────

create or replace function public.mark_lesson_outcome(
  p_request_id uuid,
  p_outcome    text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_request public.lesson_requests%rowtype;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  -- 'cancelled' is not a valid input: cancellation is done via cancel_lesson only.
  if p_outcome not in ('completed', 'member_no_show', 'pro_no_show') then
    raise exception 'invalid_outcome';
  end if;

  select * into v_request
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_profile.club_id;
  if not found then raise exception 'request_not_found'; end if;

  if v_request.status <> 'confirmed' then
    raise exception 'invalid_status_for_outcome';
  end if;

  -- The assigned pro or any same-club admin (regardless of is_lesson_provider) may record.
  if v_request.pro_id <> auth.uid() and v_profile.role <> 'admin' then
    raise exception 'insufficient_role';
  end if;

  -- Lesson must be in the past (or starting within 15 minutes)
  if v_request.proposed_starts_at > now() + interval '15 minutes' then
    raise exception 'lesson_not_yet_started';
  end if;

  update public.lesson_requests
     set lesson_outcome  = p_outcome,
         updated_at      = now()
   where id = p_request_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'mark_lesson_outcome', 'lesson_request', p_request_id,
    jsonb_build_object('outcome', p_outcome)
  );
end;
$$;

revoke execute on function public.mark_lesson_outcome(uuid, text) from public, anon;
grant  execute on function public.mark_lesson_outcome(uuid, text) to authenticated;


-- ── get_pro_availability_windows ─────────────────────────────────────────────

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
  select * into v_profile from public.profiles where id = auth.uid();
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


-- ── upsert_pro_availability_window ───────────────────────────────────────────

create or replace function public.upsert_pro_availability_window(
  p_day_of_week  int,
  p_start_time   time,
  p_end_time     time,
  p_pro_id       uuid    default null,
  p_window_id    uuid    default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile  public.profiles%rowtype;
  v_pro_id   uuid;
  v_result   uuid;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  -- Pros manage their own windows; admins can manage any same-club pro's windows
  if v_profile.role = 'admin' then
    v_pro_id := coalesce(p_pro_id, auth.uid());
  elsif v_profile.role = 'pro' then
    v_pro_id := auth.uid();
    if p_pro_id is not null and p_pro_id <> auth.uid() then
      raise exception 'insufficient_role';
    end if;
  else
    raise exception 'insufficient_role';
  end if;

  -- Validate target: active pro/admin lesson provider in the same club
  if not exists (
    select 1 from public.profiles p
     where p.id                 = v_pro_id
       and p.club_id            = v_profile.club_id
       and p.status             = 'active'
       and p.role               in ('pro', 'admin')
       and p.is_lesson_provider = true
  ) then
    raise exception 'pro_not_found';
  end if;

  -- Overlapping windows for the same pro on the same day are deliberately
  -- allowed: they are informational only and not hard-enforced at confirm time.

  if p_day_of_week not between 0 and 6 then raise exception 'invalid_day_of_week'; end if;
  if p_end_time <= p_start_time then raise exception 'invalid_time_range'; end if;

  if p_window_id is not null then
    update public.pro_availability_windows
       set day_of_week = p_day_of_week,
           start_time  = p_start_time,
           end_time    = p_end_time,
           is_active   = true,
           updated_at  = now()
     where id      = p_window_id
       and pro_id  = v_pro_id
       and club_id = v_profile.club_id
    returning id into v_result;
    if not found then raise exception 'window_not_found'; end if;
  else
    insert into public.pro_availability_windows (club_id, pro_id, day_of_week, start_time, end_time)
    values (v_profile.club_id, v_pro_id, p_day_of_week, p_start_time, p_end_time)
    on conflict (pro_id, day_of_week, start_time)
    do update set end_time  = excluded.end_time,
                  is_active = true,
                  updated_at = now()
    returning id into v_result;
  end if;

  return v_result;
end;
$$;

revoke execute on function public.upsert_pro_availability_window(int, time, time, uuid, uuid) from public, anon;
grant  execute on function public.upsert_pro_availability_window(int, time, time, uuid, uuid) to authenticated;


-- ── delete_pro_availability_window ───────────────────────────────────────────

create or replace function public.delete_pro_availability_window(p_window_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role not in ('pro', 'admin') then raise exception 'insufficient_role'; end if;

  delete from public.pro_availability_windows
   where id      = p_window_id
     and club_id = v_profile.club_id
     and (pro_id = auth.uid() or v_profile.role = 'admin');

  if not found then raise exception 'window_not_found'; end if;
end;
$$;

revoke execute on function public.delete_pro_availability_window(uuid) from public, anon;
grant  execute on function public.delete_pro_availability_window(uuid) to authenticated;


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
  select * into v_profile from public.profiles where id = auth.uid();
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


-- ── upsert_pro_blackout ───────────────────────────────────────────────────────

create or replace function public.upsert_pro_blackout(
  p_blackout_date date,
  p_reason        text    default null,
  p_pro_id        uuid    default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile  public.profiles%rowtype;
  v_pro_id   uuid;
  v_result   uuid;
  v_club_tz  text;
  v_today    date;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  if v_profile.role = 'admin' then
    v_pro_id := coalesce(p_pro_id, auth.uid());
  elsif v_profile.role = 'pro' then
    v_pro_id := auth.uid();
    if p_pro_id is not null and p_pro_id <> auth.uid() then
      raise exception 'insufficient_role';
    end if;
  else
    raise exception 'insufficient_role';
  end if;

  -- Validate target: active pro/admin lesson provider in the same club
  if not exists (
    select 1 from public.profiles p
     where p.id                 = v_pro_id
       and p.club_id            = v_profile.club_id
       and p.status             = 'active'
       and p.role               in ('pro', 'admin')
       and p.is_lesson_provider = true
  ) then
    raise exception 'pro_not_found';
  end if;

  -- Text length validation
  if length(p_reason) > 300 then raise exception 'reason_too_long'; end if;

  -- Use the club's local timezone to determine "today" — avoids rejecting
  -- dates that are still in the future in the club's timezone even if UTC has
  -- already ticked past midnight.
  select coalesce(c.timezone, 'UTC') into v_club_tz
    from public.clubs c where c.id = v_profile.club_id;
  v_today := (now() at time zone v_club_tz)::date;

  if p_blackout_date < v_today then raise exception 'blackout_date_in_past'; end if;

  insert into public.pro_blackout_dates (club_id, pro_id, blackout_date, reason)
  values (v_profile.club_id, v_pro_id, p_blackout_date, p_reason)
  on conflict (pro_id, blackout_date)
  do update set reason = excluded.reason
  returning id into v_result;

  return v_result;
end;
$$;

revoke execute on function public.upsert_pro_blackout(date, text, uuid) from public, anon;
grant  execute on function public.upsert_pro_blackout(date, text, uuid) to authenticated;


-- ── delete_pro_blackout ───────────────────────────────────────────────────────

create or replace function public.delete_pro_blackout(p_blackout_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role not in ('pro', 'admin') then raise exception 'insufficient_role'; end if;

  delete from public.pro_blackout_dates
   where id      = p_blackout_id
     and club_id = v_profile.club_id
     and (pro_id = auth.uid() or v_profile.role = 'admin');

  if not found then raise exception 'blackout_not_found'; end if;
end;
$$;

revoke execute on function public.delete_pro_blackout(uuid) from public, anon;
grant  execute on function public.delete_pro_blackout(uuid) to authenticated;


-- ── _lesson_check_pro_availability: add blackout date enforcement ─────────────
-- Replaces the Phase 23 version to also block bookings on pro blackout dates.

create or replace function public._lesson_check_pro_availability(
  p_pro_id    uuid,
  p_starts_at timestamptz,
  p_ends_at   timestamptz,
  p_exclude_request_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_conflict   int;
  v_range      tstzrange;
  v_club_id    uuid;
  v_tz         text;
  v_local_date date;
begin
  v_range := tstzrange(p_starts_at, p_ends_at, '[)');

  -- Check overlapping court reservations owned by the pro
  select count(*) into v_conflict
    from public.reservations r
   where r.owner_user_id = p_pro_id
     and r.status        in ('pending', 'confirmed')
     and tstzrange(r.starts_at, r.ends_at, '[)') && v_range
     and (p_exclude_request_id is null
          or r.id not in (
            select linked_reservation_id from public.lesson_requests
             where id = p_exclude_request_id
               and linked_reservation_id is not null
          ));

  if v_conflict > 0 then raise exception 'pro_has_conflict'; end if;

  -- Check overlapping event participation (host or confirmed participant)
  select count(*) into v_conflict
    from public.event_participants ep
    join public.reservations       er on er.event_id  = ep.event_id
                                     and er.status     in ('pending', 'confirmed')
                                     and tstzrange(er.starts_at, er.ends_at, '[)') && v_range
   where ep.profile_id = p_pro_id
     and ep.status     in ('confirmed', 'offered');

  if v_conflict > 0 then raise exception 'pro_has_event_conflict'; end if;

  -- Also catch event creators who may not have an event_participants row
  select count(*) into v_conflict
    from public.events e
    join public.reservations er on er.event_id  = e.id
                               and er.status     in ('pending', 'confirmed')
                               and tstzrange(er.starts_at, er.ends_at, '[)') && v_range
   where e.created_by = p_pro_id
     and e.status     = 'scheduled'
     and not exists (
       select 1 from public.event_participants ep2
        where ep2.event_id   = e.id
          and ep2.profile_id = p_pro_id
     );

  if v_conflict > 0 then raise exception 'pro_has_event_conflict'; end if;

  -- Check pro blackout dates
  select p.club_id into v_club_id
    from public.profiles p where p.id = p_pro_id;

  select timezone into v_tz from public.clubs where id = v_club_id;

  v_local_date := (p_starts_at at time zone v_tz)::date;

  if exists (
    select 1 from public.pro_blackout_dates b
     where b.pro_id       = p_pro_id
       and b.blackout_date = v_local_date
  ) then
    raise exception 'pro_on_blackout';
  end if;
end;
$$;

revoke execute on function public._lesson_check_pro_availability(uuid, timestamptz, timestamptz, uuid) from public, anon;


-- ── get_my_lesson_requests: include lesson_type_name ─────────────────────────

drop function if exists public.get_my_lesson_requests();

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
  select * into v_profile from public.profiles where id = auth.uid();
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


-- ── get_pro_lesson_requests: include lesson_type_name ────────────────────────

drop function if exists public.get_pro_lesson_requests(uuid, text);

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
  select * into v_profile from public.profiles where id = auth.uid();
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
