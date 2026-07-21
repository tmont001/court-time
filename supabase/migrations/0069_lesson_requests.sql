-- 0069_lesson_requests.sql
-- Phase 23: Pro Lesson and Booking Requests
--
-- Introduces a complete lesson-request lifecycle allowing members to request
-- private lessons or hitting time with a club pro. A request is not a confirmed
-- booking until a pro (or admin) explicitly confirms it, at which point an
-- atomic transaction creates a verified court reservation.
--
-- Changes in this migration
-- ─────────────────────────
-- 1. Expand reservations.reason CHECK to include 'pro_lesson'.
-- 2. Expand notifications.kind CHECK to include 5 lesson lifecycle kinds.
-- 3. Create lesson_requests table with full lifecycle support.
-- 4. RLS on lesson_requests (SELECT: member/pro/admin scoped; all mutations via RPCs).
-- 5. Security-definer RPCs (all: REVOKE from public/anon, GRANT to authenticated):
--      get_club_pros()
--      submit_lesson_request()
--      withdraw_lesson_request()
--      propose_lesson_time()
--      pro_confirm_lesson_request()
--      accept_lesson_proposal()
--      decline_lesson_proposal()
--      decline_lesson_request()
--      cancel_lesson()
--      get_my_lesson_requests()
--      get_pro_lesson_requests()
--
-- Security model
-- ──────────────
-- All mutations route through SECURITY DEFINER RPCs. Club identity and actor
-- role are derived from auth.uid() — never trusted from caller parameters.
-- Cross-club reads are impossible: every query filters club_id = current_user_club_id().
-- Row locks (SELECT … FOR UPDATE) on lesson_requests prevent duplicate confirmation.
-- Court conflicts are prevented atomically by the GiST EXCLUDE constraint on
-- reservations (already in place from migration 0003).
--
-- Safe to re-apply: CREATE OR REPLACE functions; DROP CONSTRAINT IF EXISTS before
-- adding; CREATE TABLE IF NOT EXISTS; DROP POLICY IF EXISTS before CREATE POLICY;
-- DROP TRIGGER IF EXISTS before CREATE TRIGGER. Do not apply to a database where
-- the migration has already run without reviewing constraint names first.
-- Apply in Supabase SQL Editor (cloud only).


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Expand reservations.reason to include 'pro_lesson'
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.reservations
  drop constraint if exists reservations_reason_check;

alter table public.reservations
  add constraint reservations_reason_check
  check (reason in ('member_booking', 'maintenance', 'admin_block', 'event', 'pro_lesson'));


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Expand notifications.kind to include lesson lifecycle kinds
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.notifications
  drop constraint if exists notifications_kind_check;

alter table public.notifications
  add constraint notifications_kind_check
  check (kind in (
    'reservation_confirmed',
    'reservation_cancelled_by_admin',
    'reservation_cancelled_by_member',
    'event_cancelled',
    'event_joined',
    'waitlist_promoted',
    'waitlist_offer',
    'announcement',
    'lesson_request_received',
    'lesson_request_proposed',
    'lesson_request_confirmed',
    'lesson_request_declined',
    'lesson_cancelled'
  ));


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. lesson_requests table
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.lesson_requests (
  id                    uuid        primary key default gen_random_uuid(),
  club_id               uuid        not null references public.clubs(id) on delete cascade,
  member_id             uuid        not null references public.profiles(id),
  pro_id                uuid        not null references public.profiles(id),

  -- Member preferences (optional court; required duration)
  preferred_court_id    uuid        references public.courts(id),
  duration_minutes      int         not null
                                      check (duration_minutes >= 30 and duration_minutes % 15 = 0),
  member_note           text,
  -- Structured preferred windows: [{date, start_time, end_time}] or free text
  preferred_windows     jsonb,

  -- Time proposed by pro (required when status = 'proposed' or 'confirmed')
  proposed_starts_at    timestamptz,
  proposed_ends_at      timestamptz,
  proposed_court_id     uuid        references public.courts(id),

  -- Lifecycle
  status                text        not null default 'pending'
                                      check (status in (
                                        'pending',
                                        'proposed',
                                        'confirmed',
                                        'declined',
                                        'withdrawn',
                                        'cancelled'
                                      )),
  decline_reason        text,
  cancellation_reason   text,

  -- Actor tracking
  last_actor_id         uuid        references public.profiles(id),
  last_actor_role       text        check (last_actor_role in ('member', 'pro', 'admin')),

  -- Link to the resulting reservation (set at confirmation)
  linked_reservation_id uuid        references public.reservations(id),

  -- Timestamps
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  confirmed_at          timestamptz,
  declined_at           timestamptz,
  cancelled_at          timestamptz,
  cancelled_by          uuid        references public.profiles(id),

  -- Cross-field constraints
  constraint lesson_request_proposed_needs_time check (
    status not in ('proposed', 'confirmed')
    or (proposed_starts_at is not null and proposed_ends_at is not null)
  ),
  constraint lesson_request_confirmed_needs_reservation check (
    status <> 'confirmed' or linked_reservation_id is not null
  ),
  constraint lesson_request_proposed_time_order check (
    proposed_starts_at is null or proposed_ends_at > proposed_starts_at
  ),
  constraint lesson_request_not_self check (
    member_id <> pro_id
  )
);

create index if not exists lesson_requests_member_idx  on public.lesson_requests (member_id);
create index if not exists lesson_requests_pro_idx     on public.lesson_requests (pro_id);
create index if not exists lesson_requests_club_idx    on public.lesson_requests (club_id);
create index if not exists lesson_requests_status_idx  on public.lesson_requests (status);
create index if not exists lesson_requests_created_idx on public.lesson_requests (created_at desc);

drop trigger if exists lesson_requests_updated_at on public.lesson_requests;
create trigger lesson_requests_updated_at
  before update on public.lesson_requests
  for each row execute function trigger_set_updated_at();


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. RLS on lesson_requests
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.lesson_requests enable row level security;

-- SELECT: member sees own requests; pro sees requests assigned to them;
-- admin sees all requests in their club. Multiple permissive SELECT policies
-- combine with OR, so any matching policy grants access.

drop policy if exists "lesson_requests_select_member" on public.lesson_requests;
create policy "lesson_requests_select_member"
  on public.lesson_requests for select
  using (
    member_id = auth.uid()
    and club_id = current_user_club_id()
  );

drop policy if exists "lesson_requests_select_pro" on public.lesson_requests;
create policy "lesson_requests_select_pro"
  on public.lesson_requests for select
  using (
    pro_id = auth.uid()
    and club_id = current_user_club_id()
  );

drop policy if exists "lesson_requests_select_admin" on public.lesson_requests;
create policy "lesson_requests_select_admin"
  on public.lesson_requests for select
  using (
    club_id = current_user_club_id()
    and (select role from public.profiles where id = auth.uid()) = 'admin'
  );

-- No direct INSERT/UPDATE/DELETE — all mutations go through SECURITY DEFINER RPCs.


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. RPCs
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Helper: check operating hours for a given timestamptz range ─────────────
-- Used internally by confirm RPCs. Returns true when the range is within
-- the club's operating hours on that day (checking override table first).
-- Not exposed publicly.

create or replace function public._lesson_check_operating_hours(
  p_club_id   uuid,
  p_starts_at timestamptz,
  p_ends_at   timestamptz,
  p_tz        text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_local_date date;
  v_override   operating_hours_override%rowtype;
  v_hours      operating_hours%rowtype;
  v_is_closed  bool;
  v_opens_at   time;
  v_closes_at  time;
  v_dow        int;
begin
  v_local_date := (p_starts_at at time zone p_tz)::date;

  -- Override table takes precedence over weekly defaults
  select * into v_override
    from public.operating_hours_override
   where club_id       = p_club_id
     and override_date = v_local_date;

  if found then
    v_is_closed := v_override.is_closed;
    v_opens_at  := v_override.opens_at;
    v_closes_at := v_override.closes_at;
  else
    v_dow := extract(dow from p_starts_at at time zone p_tz)::int;
    select * into v_hours
      from public.operating_hours
     where club_id     = p_club_id
       and day_of_week = v_dow;
    if not found then raise exception 'operating_hours_not_configured'; end if;
    v_is_closed := v_hours.is_closed;
    v_opens_at  := v_hours.opens_at;
    v_closes_at := v_hours.closes_at;
  end if;

  if v_is_closed then raise exception 'club_closed_this_day'; end if;

  if (p_starts_at at time zone p_tz)::time < v_opens_at
     or (p_ends_at at time zone p_tz)::time > v_closes_at then
    raise exception 'outside_operating_hours';
  end if;
end;
$$;

revoke execute on function public._lesson_check_operating_hours(uuid, timestamptz, timestamptz, text) from public, anon;


-- ── Helper: check pro availability for a given timestamptz range ────────────
-- Raises if the pro has any overlapping confirmed/pending reservation or
-- is a confirmed/offered participant in an overlapping event.

create or replace function public._lesson_check_pro_availability(
  p_pro_id    uuid,
  p_starts_at timestamptz,
  p_ends_at   timestamptz,
  p_exclude_request_id uuid default null  -- exclude the linked reservation of this request
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_conflict int;
  v_range    tstzrange;
begin
  v_range := tstzrange(p_starts_at, p_ends_at, '[)');

  -- Check overlapping court reservations owned by the pro
  select count(*) into v_conflict
    from public.reservations r
   where r.owner_user_id = p_pro_id
     and r.status        in ('pending', 'confirmed')
     and tstzrange(r.starts_at, r.ends_at, '[)') && v_range
     -- Allow the pro's own linked lesson reservation when re-confirming
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
end;
$$;

revoke execute on function public._lesson_check_pro_availability(uuid, timestamptz, timestamptz, uuid) from public, anon;


-- ── Helper: check member availability for a given timestamptz range ──────────
-- Raises if the member has any overlapping confirmed reservation, event
-- participation, or confirmed lesson during the proposed window.

create or replace function public._lesson_check_member_availability(
  p_member_id uuid,
  p_starts_at timestamptz,
  p_ends_at   timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_conflict int;
  v_range    tstzrange;
begin
  v_range := tstzrange(p_starts_at, p_ends_at, '[)');

  -- Check overlapping court reservations owned by the member
  select count(*) into v_conflict
    from public.reservations r
   where r.owner_user_id = p_member_id
     and r.status        in ('pending', 'confirmed')
     and tstzrange(r.starts_at, r.ends_at, '[)') && v_range;
  if v_conflict > 0 then raise exception 'member_has_conflict'; end if;

  -- Check overlapping event participation
  select count(*) into v_conflict
    from public.event_participants ep
    join public.reservations       er on er.event_id  = ep.event_id
                                     and er.status     in ('pending', 'confirmed')
                                     and tstzrange(er.starts_at, er.ends_at, '[)') && v_range
   where ep.profile_id = p_member_id
     and ep.status     in ('confirmed', 'offered');
  if v_conflict > 0 then raise exception 'member_has_event_conflict'; end if;

  -- Check overlapping confirmed lessons the member is party to
  select count(*) into v_conflict
    from public.lesson_requests lr
   where lr.member_id           = p_member_id
     and lr.status              = 'confirmed'
     and tstzrange(lr.proposed_starts_at, lr.proposed_ends_at, '[)') && v_range;
  if v_conflict > 0 then raise exception 'member_has_lesson_conflict'; end if;
end;
$$;

revoke execute on function public._lesson_check_member_availability(uuid, timestamptz, timestamptz) from public, anon;


-- ────────────────────────────────────────────────────────────────────────────
-- get_club_pros
-- Returns active pros and admins in the caller's club, excluding the caller.
-- Used by member to pick a pro when submitting a request.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.get_club_pros()
returns table (
  id         uuid,
  first_name text,
  last_name  text,
  role       text
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
    select p.id, p.first_name, p.last_name, p.role
      from public.profiles p
     where p.club_id = v_profile.club_id
       and p.status  = 'active'
       and p.id      <> auth.uid()
       and p.role    in ('pro', 'admin')
     order by p.last_name nulls last, p.first_name nulls last;
end;
$$;

revoke execute on function public.get_club_pros() from public, anon;
grant  execute on function public.get_club_pros() to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- submit_lesson_request
-- Member submits a new lesson request. Status starts as 'pending'.
-- No court or time is reserved at this point.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.submit_lesson_request(
  p_pro_id              uuid,
  p_duration_minutes    int,
  p_preferred_court_id  uuid   default null,
  p_member_note         text   default null,
  p_preferred_windows   jsonb  default null
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

  -- Validate pro: active, same club, role pro or admin
  select * into v_pro
    from public.profiles
   where id      = p_pro_id
     and club_id = v_profile.club_id
     and status  = 'active'
     and role    in ('pro', 'admin');
  if not found then raise exception 'pro_not_found'; end if;

  -- Cannot request from yourself
  if p_pro_id = auth.uid() then raise exception 'cannot_request_yourself'; end if;

  -- Duration must be >= 30 min and in 15-min increments
  if p_duration_minutes < 30 or p_duration_minutes % 15 <> 0 then
    raise exception 'invalid_duration';
  end if;

  -- Validate preferred court if supplied
  if p_preferred_court_id is not null then
    if not exists (
      select 1 from public.courts
       where id = p_preferred_court_id
         and club_id   = v_profile.club_id
         and is_active = true
    ) then
      raise exception 'court_not_found';
    end if;
  end if;

  insert into public.lesson_requests (
    club_id, member_id, pro_id,
    preferred_court_id, duration_minutes, member_note, preferred_windows,
    status, last_actor_id, last_actor_role
  ) values (
    v_profile.club_id, auth.uid(), p_pro_id,
    p_preferred_court_id, p_duration_minutes, p_member_note, p_preferred_windows,
    'pending', auth.uid(), 'member'
  ) returning * into v_result;

  -- Notify the pro
  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    p_pro_id,
    'lesson_request_received',
    trim(coalesce(v_profile.first_name, '') || ' ' || coalesce(v_profile.last_name, '')) ||
      ' requested a ' || p_duration_minutes || '-minute lesson.',
    jsonb_build_object('request_id', v_result.id, 'member_id', auth.uid())
  );

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'submit_lesson_request', 'lesson_request', v_result.id,
    jsonb_build_object('pro_id', p_pro_id, 'duration_minutes', p_duration_minutes)
  );

  return v_result;
end;
$$;

revoke execute on function public.submit_lesson_request(uuid, int, uuid, text, jsonb) from public, anon;
grant  execute on function public.submit_lesson_request(uuid, int, uuid, text, jsonb) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- withdraw_lesson_request
-- Member withdraws their own pending or proposed request.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.withdraw_lesson_request(
  p_request_id uuid
)
returns public.lesson_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_request public.lesson_requests%rowtype;
  v_result  public.lesson_requests%rowtype;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  -- Fetch and lock the request
  select * into v_request
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_profile.club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  -- Only the member who submitted can withdraw
  if v_request.member_id <> auth.uid() then raise exception 'not_your_request'; end if;

  -- Only pending or proposed requests can be withdrawn
  if v_request.status not in ('pending', 'proposed') then
    raise exception 'invalid_status_for_withdraw';
  end if;

  update public.lesson_requests
     set status         = 'withdrawn',
         last_actor_id  = auth.uid(),
         last_actor_role = 'member',
         updated_at     = now()
   where id = p_request_id
  returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'withdraw_lesson_request', 'lesson_request', p_request_id,
    jsonb_build_object('previous_status', v_request.status)
  );

  return v_result;
end;
$$;

revoke execute on function public.withdraw_lesson_request(uuid) from public, anon;
grant  execute on function public.withdraw_lesson_request(uuid) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- propose_lesson_time
-- Pro (or admin) proposes a specific date/time requiring member acceptance.
-- Can be called on pending requests or to re-propose on already-proposed requests.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.propose_lesson_time(
  p_request_id   uuid,
  p_starts_at    timestamptz,
  p_ends_at      timestamptz,
  p_court_id     uuid   default null
)
returns public.lesson_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_request public.lesson_requests%rowtype;
  v_result  public.lesson_requests%rowtype;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;
  if v_profile.role not in ('pro', 'admin') then raise exception 'insufficient_role'; end if;

  -- Fetch and lock
  select * into v_request
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_profile.club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  -- Pros may only manage their own requests
  if v_profile.role = 'pro' and v_request.pro_id <> auth.uid() then
    raise exception 'not_assigned_pro';
  end if;

  if v_request.status not in ('pending', 'proposed') then
    raise exception 'invalid_status_for_propose';
  end if;

  if p_starts_at <= now() then raise exception 'cannot_propose_past_time'; end if;
  if p_ends_at   <= p_starts_at then raise exception 'invalid_duration'; end if;

  -- Duration must match what was requested
  if round(extract(epoch from (p_ends_at - p_starts_at)) / 60)::int <> v_request.duration_minutes then
    raise exception 'duration_mismatch';
  end if;

  -- Validate court if supplied
  if p_court_id is not null then
    if not exists (
      select 1 from public.courts
       where id = p_court_id
         and club_id   = v_profile.club_id
         and is_active = true
    ) then
      raise exception 'court_not_found';
    end if;
  end if;

  update public.lesson_requests
     set status             = 'proposed',
         proposed_starts_at = p_starts_at,
         proposed_ends_at   = p_ends_at,
         proposed_court_id  = p_court_id,
         last_actor_id      = auth.uid(),
         last_actor_role    = v_profile.role,
         updated_at         = now()
   where id = p_request_id
  returning * into v_result;

  -- Notify the member
  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    v_request.member_id,
    'lesson_request_proposed',
    trim(coalesce(v_profile.first_name, '') || ' ' || coalesce(v_profile.last_name, '')) ||
      ' proposed a time for your lesson. Please review and respond.',
    jsonb_build_object('request_id', p_request_id)
  );

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'propose_lesson_time', 'lesson_request', p_request_id,
    jsonb_build_object(
      'proposed_starts_at', p_starts_at,
      'proposed_ends_at',   p_ends_at,
      'court_id',           p_court_id
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.propose_lesson_time(uuid, timestamptz, timestamptz, uuid) from public, anon;
grant  execute on function public.propose_lesson_time(uuid, timestamptz, timestamptz, uuid) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- accept_lesson_proposal
-- Member accepts the time proposed by the pro. Atomically confirms the
-- request and creates the court reservation. Same availability and operating-
-- hours checks as pro_confirm_lesson_request.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.accept_lesson_proposal(
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_request public.lesson_requests%rowtype;
  v_pro     public.profiles%rowtype;
  v_member  public.profiles%rowtype;
  v_tz      text;
  v_res_id  uuid;
  v_time_label text;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  -- Fetch and row-lock
  select * into v_request
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_profile.club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  -- Only the member who submitted can accept
  if v_request.member_id <> auth.uid() then raise exception 'not_your_request'; end if;

  -- Must be in 'proposed' status
  if v_request.status <> 'proposed' then raise exception 'invalid_status_for_accept'; end if;

  -- proposed_starts_at / proposed_ends_at must be populated (enforced by constraint but guard anyway)
  if v_request.proposed_starts_at is null or v_request.proposed_ends_at is null then
    raise exception 'proposed_time_missing';
  end if;

  -- Proposed time must still be in the future
  if v_request.proposed_starts_at <= now() then raise exception 'proposed_time_in_past'; end if;

  -- Court required
  if v_request.proposed_court_id is null then raise exception 'proposed_court_missing'; end if;

  -- Operating hours check
  select timezone into v_tz from public.clubs where id = v_profile.club_id;
  perform public._lesson_check_operating_hours(
    v_profile.club_id,
    v_request.proposed_starts_at,
    v_request.proposed_ends_at,
    v_tz
  );

  -- Pro availability check
  perform public._lesson_check_pro_availability(
    v_request.pro_id,
    v_request.proposed_starts_at,
    v_request.proposed_ends_at,
    null
  );

  -- Member availability check (caller is the member accepting)
  perform public._lesson_check_member_availability(
    auth.uid(),
    v_request.proposed_starts_at,
    v_request.proposed_ends_at
  );

  -- Fetch names for notifications
  select * into v_pro    from public.profiles where id = v_request.pro_id;
  select * into v_member from public.profiles where id = auth.uid();

  -- Create the reservation (GiST EXCLUDE handles court conflicts atomically)
  insert into public.reservations (
    club_id, court_id, owner_user_id,
    starts_at, ends_at, status, reason,
    notes, show_notes_to_members, created_by
  ) values (
    v_profile.club_id,
    v_request.proposed_court_id,
    v_request.pro_id,
    v_request.proposed_starts_at,
    v_request.proposed_ends_at,
    'confirmed',
    'pro_lesson',
    'Pro lesson with ' || trim(coalesce(v_member.first_name, '') || ' ' || coalesce(v_member.last_name, '')),
    false,
    auth.uid()
  ) returning id into v_res_id;

  -- Update the request
  update public.lesson_requests
     set status               = 'confirmed',
         linked_reservation_id = v_res_id,
         confirmed_at         = now(),
         last_actor_id        = auth.uid(),
         last_actor_role      = 'member',
         updated_at           = now()
   where id = p_request_id;

  v_time_label := to_char(v_request.proposed_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM');

  -- Notify member
  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'lesson_request_confirmed',
    'Your lesson with ' ||
      trim(coalesce(v_pro.first_name, '') || ' ' || coalesce(v_pro.last_name, '')) ||
      ' is confirmed for ' || v_time_label || '.',
    jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id)
  );

  -- Notify pro
  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    v_request.pro_id,
    'lesson_request_confirmed',
    'Lesson with ' ||
      trim(coalesce(v_member.first_name, '') || ' ' || coalesce(v_member.last_name, '')) ||
      ' confirmed for ' || v_time_label || '.',
    jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id)
  );

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'accept_lesson_proposal', 'lesson_request', p_request_id,
    jsonb_build_object('reservation_id', v_res_id)
  );

  return jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id);
end;
$$;

revoke execute on function public.accept_lesson_proposal(uuid) from public, anon;
grant  execute on function public.accept_lesson_proposal(uuid) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- decline_lesson_proposal
-- Member declines the pro's proposed time. Returns status to 'pending' so
-- the pro may propose a different time or confirm directly.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.decline_lesson_proposal(
  p_request_id uuid
)
returns public.lesson_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_request public.lesson_requests%rowtype;
  v_result  public.lesson_requests%rowtype;
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

  if v_request.member_id <> auth.uid() then raise exception 'not_your_request'; end if;
  if v_request.status <> 'proposed' then raise exception 'invalid_status_for_decline_proposal'; end if;

  update public.lesson_requests
     set status              = 'pending',
         proposed_starts_at  = null,
         proposed_ends_at    = null,
         proposed_court_id   = null,
         last_actor_id       = auth.uid(),
         last_actor_role     = 'member',
         updated_at          = now()
   where id = p_request_id
  returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'decline_lesson_proposal', 'lesson_request', p_request_id,
    jsonb_build_object('previous_proposed_starts_at', v_request.proposed_starts_at)
  );

  return v_result;
end;
$$;

revoke execute on function public.decline_lesson_proposal(uuid) from public, anon;
grant  execute on function public.decline_lesson_proposal(uuid) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- decline_lesson_request
-- Pro (or admin) declines the entire request (not just a proposed time).
-- Moves status to 'declined'. Cannot be undone by the pro; the member may
-- submit a new request if they wish.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.decline_lesson_request(
  p_request_id uuid,
  p_reason     text default null
)
returns public.lesson_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_request public.lesson_requests%rowtype;
  v_result  public.lesson_requests%rowtype;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;
  if v_profile.role not in ('pro', 'admin') then raise exception 'insufficient_role'; end if;

  select * into v_request
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_profile.club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  if v_profile.role = 'pro' and v_request.pro_id <> auth.uid() then
    raise exception 'not_assigned_pro';
  end if;

  if v_request.status not in ('pending', 'proposed') then
    raise exception 'invalid_status_for_decline';
  end if;

  update public.lesson_requests
     set status          = 'declined',
         decline_reason  = p_reason,
         declined_at     = now(),
         last_actor_id   = auth.uid(),
         last_actor_role = v_profile.role,
         updated_at      = now()
   where id = p_request_id
  returning * into v_result;

  -- Notify the member
  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    v_request.member_id,
    'lesson_request_declined',
    trim(coalesce(v_profile.first_name, '') || ' ' || coalesce(v_profile.last_name, '')) ||
      ' is unable to take your lesson request.' ||
      case when p_reason is not null and btrim(p_reason) <> ''
           then ' Reason: ' || btrim(p_reason)
           else ''
      end,
    jsonb_build_object('request_id', p_request_id)
  );

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'decline_lesson_request', 'lesson_request', p_request_id,
    jsonb_build_object('reason', p_reason)
  );

  return v_result;
end;
$$;

revoke execute on function public.decline_lesson_request(uuid, text) from public, anon;
grant  execute on function public.decline_lesson_request(uuid, text) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- cancel_lesson
-- Cancels a confirmed lesson. Updates both lesson_request (cancelled) and
-- the linked reservation (cancelled) in the same transaction. Any club
-- member who is party to the lesson (member, pro, or admin) may cancel.
-- ────────────────────────────────────────────────────────────────────────────

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

  update public.lesson_requests
     set status              = 'cancelled',
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


-- ────────────────────────────────────────────────────────────────────────────
-- get_my_lesson_requests
-- Returns all lesson requests for the currently authenticated member, ordered
-- by most recent first. Accessible to any role (member sees own requests,
-- pro sees their own submitted requests — rare but allowed).
-- ────────────────────────────────────────────────────────────────────────────

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
  confirmed_at          timestamptz
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
      lr.confirmed_at
    from public.lesson_requests lr
    join public.profiles pro on pro.id = lr.pro_id
    left join public.courts pc on pc.id = lr.preferred_court_id
    left join public.courts xc on xc.id = lr.proposed_court_id
   where lr.member_id = auth.uid()
     and lr.club_id   = v_profile.club_id
   order by lr.created_at desc;
end;
$$;

revoke execute on function public.get_my_lesson_requests() from public, anon;
grant  execute on function public.get_my_lesson_requests() to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- get_pro_lesson_requests
-- Returns lesson requests assigned to the caller (must be pro or admin).
-- Admins calling this see all requests in the club (for the admin lessons view).
-- Pros calling this see only their own assigned requests.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.get_pro_lesson_requests(
  p_pro_filter uuid default null,  -- admin-only: filter by a specific pro
  p_status     text default null   -- filter by status (null = all active)
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
  confirmed_at          timestamptz
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

  -- Pros can only see their own requests; pro_filter is admin-only
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
      lr.confirmed_at
    from public.lesson_requests lr
    join public.profiles mem on mem.id = lr.member_id
    join public.profiles pro on pro.id = lr.pro_id
    left join public.courts pc on pc.id = lr.preferred_court_id
    left join public.courts xc on xc.id = lr.proposed_court_id
   where lr.club_id = v_profile.club_id
     and (
       -- Pros see only their own; admins see all (or filtered by pro)
       (v_profile.role = 'pro'   and lr.pro_id = auth.uid())
       or
       (v_profile.role = 'admin' and (p_pro_filter is null or lr.pro_id = p_pro_filter))
     )
     and (p_status is null or lr.status = p_status)
   order by
     -- Active requests first, then historical
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


-- ────────────────────────────────────────────────────────────────────────────
-- get_lesson_notification_id
-- Security-definer lookup for cross-user email dispatch. Returns the most
-- recent notification {id, body} for a (request_id, user_id, kind) triple.
--
-- Called from server actions when the acting user (e.g. a pro) needs to send
-- an email to the other party (e.g. a member) but cannot SELECT that user's
-- notification row due to the `user_id = auth.uid()` RLS policy on notifications.
--
-- Authorization: caller must be authenticated; caller and target must share
-- a club; caller is either the target or has role admin/pro.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.get_lesson_notification_id(
  p_request_id uuid,
  p_user_id    uuid,
  p_kind       text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller_id       uuid := auth.uid();
  v_caller_club_id  uuid;
  v_caller_role     text;
  v_target_club_id  uuid;
  v_notif_id        uuid;
  v_notif_body      text;
begin
  if v_caller_id is null then return null; end if;

  select club_id, role into v_caller_club_id, v_caller_role
    from public.profiles where id = v_caller_id;
  if v_caller_club_id is null then return null; end if;

  select club_id into v_target_club_id
    from public.profiles where id = p_user_id;

  -- Caller and target must share a club
  if v_caller_club_id is distinct from v_target_club_id then return null; end if;

  -- Caller must be the target or have elevated role
  if v_caller_id <> p_user_id and v_caller_role not in ('admin', 'pro') then
    return null;
  end if;

  select id, body into v_notif_id, v_notif_body
    from public.notifications
   where user_id  = p_user_id
     and kind     = p_kind
     and (metadata->>'request_id')::uuid = p_request_id
   order by created_at desc
   limit 1;

  if v_notif_id is null then return null; end if;

  return jsonb_build_object('id', v_notif_id, 'body', v_notif_body);
end;
$$;

revoke execute on function public.get_lesson_notification_id(uuid, uuid, text) from public, anon;
grant  execute on function public.get_lesson_notification_id(uuid, uuid, text) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- get_lesson_recipient_email
-- Returns the email address of a lesson-request party when the caller is the
-- OTHER party or a same-club admin. This bypasses the admin/pro restriction in
-- get_user_email_for_notification so that a member can trigger transactional
-- email to the assigned pro (e.g. after accepting a proposal).
--
-- Authorization: caller and target must share a club; target must be either the
-- member_id or pro_id on the lesson request; caller must be the other party or
-- a same-club admin. Returning the recipient's email address to a same-club
-- party is safe because it is used only for server-side Resend delivery; the
-- email address is never surfaced to client components.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.get_lesson_recipient_email(
  p_request_id uuid,
  p_user_id    uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller_id      uuid := auth.uid();
  v_caller_club_id uuid;
  v_caller_role    text;
  v_target_club_id uuid;
  v_request        public.lesson_requests%rowtype;
begin
  if v_caller_id is null then return null; end if;

  select club_id, role into v_caller_club_id, v_caller_role
    from public.profiles where id = v_caller_id;
  if v_caller_club_id is null then return null; end if;

  select club_id into v_target_club_id
    from public.profiles where id = p_user_id;

  -- Caller and target must share the same club
  if v_caller_club_id is distinct from v_target_club_id then return null; end if;

  -- Fetch the lesson request (same club)
  select * into v_request
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_caller_club_id;
  if not found then return null; end if;

  -- Target must be a party to the lesson
  if p_user_id not in (v_request.member_id, v_request.pro_id) then
    return null;
  end if;

  -- Caller must be the other party, or a same-club admin
  -- (allows: member→pro, pro→member, admin→either)
  if v_caller_id <> v_request.member_id
     and v_caller_id <> v_request.pro_id
     and v_caller_role <> 'admin'
  then
    return null;
  end if;

  return (select email from auth.users where id = p_user_id);
end;
$$;

revoke execute on function public.get_lesson_recipient_email(uuid, uuid) from public, anon;
grant  execute on function public.get_lesson_recipient_email(uuid, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Expand notification_preferences to cover lesson kinds
--    (migration 0055 constrained kind to 8 values; add 5 lesson kinds here)
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.notification_preferences
  drop constraint if exists notification_preferences_kind_check;

alter table public.notification_preferences
  add constraint notification_preferences_kind_check
  check (kind in (
    'reservation_confirmed',
    'reservation_cancelled_by_member',
    'reservation_cancelled_by_admin',
    'event_joined',
    'event_cancelled',
    'waitlist_offer',
    'waitlist_promoted',
    'announcement',
    'lesson_request_received',
    'lesson_request_proposed',
    'lesson_request_confirmed',
    'lesson_request_declined',
    'lesson_cancelled'
  ));

create or replace function public.update_notification_preference(
  p_kind    text,
  p_enabled boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  if p_kind not in (
    'reservation_confirmed',
    'reservation_cancelled_by_member',
    'reservation_cancelled_by_admin',
    'event_joined',
    'event_cancelled',
    'waitlist_offer',
    'waitlist_promoted',
    'announcement',
    'lesson_request_received',
    'lesson_request_proposed',
    'lesson_request_confirmed',
    'lesson_request_declined',
    'lesson_cancelled'
  ) then
    raise exception 'invalid_kind';
  end if;

  select club_id into v_club_id from public.profiles where id = auth.uid();

  insert into public.notification_preferences (user_id, club_id, kind, enabled, updated_at)
  values (auth.uid(), v_club_id, p_kind, p_enabled, now())
  on conflict (user_id, kind) do update
    set enabled    = excluded.enabled,
        updated_at = now();
end;
$$;

revoke execute on function public.update_notification_preference(text, boolean) from public, anon;
grant  execute on function public.update_notification_preference(text, boolean) to authenticated;
