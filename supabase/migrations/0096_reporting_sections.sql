-- 0096_reporting_sections.sql
-- Phase 28B: Operational Reporting Sections.
--
-- Adds four admin-only, read-only reporting RPCs, extending the foundation
-- laid in 0095_reporting_foundation.sql:
--   - get_reservation_summary(p_start_date, p_end_date)
--   - get_event_program_summary(p_start_date, p_end_date)
--   - get_waitlist_demand(p_start_date, p_end_date)
--   - get_member_engagement_summary(p_start_date, p_end_date)
--
-- Every RPC here reuses 0095's club_local_bounds() for date validation and
-- club-local range conversion, and follows the exact same authorization
-- shape: SECURITY DEFINER, STABLE, search_path = public, pg_temp, scope
-- derived only from current_user_club_id()/current_user_role(), no
-- p_club_id parameter, not_authenticated / insufficient_role guards,
-- EXECUTE revoked from PUBLIC/anon and granted only to authenticated.
--
-- No new tables. No RLS changes. No direct authenticated write grants.
-- Adds exactly one index: event_guests (event_id) — justified by
-- get_event_program_summary's join, which is otherwise unindexed (the only
-- existing event_guests index is a partial one scoped to roster-linked
-- guests, not usable for a plain event_id join).
--
-- Apply in Supabase SQL Editor (cloud only).

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Index — event_guests (event_id)
--    get_event_program_summary joins event_guests to a small set of "held"
--    event ids. The only existing event_guests index
--    (event_guests_roster_member_uniq, 0057) is partial — scoped to
--    roster_member_id IS NOT NULL — and cannot serve a plain event_id
--    lookup for guests added without a roster link.
-- ═══════════════════════════════════════════════════════════════════════════

create index if not exists event_guests_event_id_idx
  on public.event_guests (event_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. get_reservation_summary — exposed RPC
--
-- Reservation status/reason breakdown plus a zero-filled daily series, for
-- an inclusive club-local date range. Admin-only, club-scoped only via
-- current_user_club_id()/current_user_role().
--
-- Reservation counts (both the scalar breakdown and the daily series) use
-- starts_at within the report range — deliberately NOT court-active-
-- filtered like 0095's utilization RPCs, because this section reports
-- booking ACTIVITY (how much demand occurred), not court-hours capacity; a
-- reservation on a since-deactivated court is still real historical
-- booking activity and stays counted here.
--
-- daily_series is returned as a bounded jsonb array (max 366 elements, one
-- per day in the range — never a raw per-reservation row set), each
-- element shaped {local_date, total_count, cancelled_count}. Every date in
-- the range appears, including zero-count days. Chronological order is
-- guaranteed by an explicit ORDER BY inside jsonb_agg itself — a CTE's own
-- ORDER BY (see the `series` CTE below) is not preserved by an aggregate
-- reading from it, so that ordering alone would not be reliable.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.get_reservation_summary(
  p_start_date date,
  p_end_date   date
)
returns table (
  total_reservations      bigint,
  pending_reservations    bigint,
  confirmed_reservations  bigint,
  cancelled_reservations  bigint,
  cancellation_rate_pct   numeric,
  member_booking_count    bigint,
  event_count             bigint,
  pro_lesson_count        bigint,
  maintenance_count       bigint,
  admin_block_count       bigint,
  daily_series            jsonb
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_range   tstzrange;
  v_tz      text;
begin
  v_club_id := public.current_user_club_id();
  v_role    := public.current_user_role();

  if v_club_id is null then
    raise exception 'not_authenticated';
  end if;

  if v_role <> 'admin' then
    raise exception 'insufficient_role';
  end if;

  v_range := public.club_local_bounds(v_club_id, p_start_date, p_end_date);

  select timezone into v_tz from public.clubs where id = v_club_id;

  return query
  with res as (
    select r.status, r.reason, r.starts_at
    from public.reservations r
    where r.club_id = v_club_id
      and r.starts_at >= lower(v_range)
      and r.starts_at <  upper(v_range)
  ),
  res_agg as (
    select
      count(*)                                            as total_res,
      count(*) filter (where status = 'pending')           as pending_res,
      count(*) filter (where status = 'confirmed')         as confirmed_res,
      count(*) filter (where status = 'cancelled')         as cancelled_res,
      count(*) filter (where reason = 'member_booking')    as member_booking_ct,
      count(*) filter (where reason = 'event')             as event_ct,
      count(*) filter (where reason = 'pro_lesson')        as pro_lesson_ct,
      count(*) filter (where reason = 'maintenance')       as maintenance_ct,
      count(*) filter (where reason = 'admin_block')       as admin_block_ct
    from res
  ),
  days as (
    select (p_start_date + day_offset) as local_date
    from generate_series(0, (p_end_date - p_start_date)) as day_offset
  ),
  res_by_day as (
    select
      (res.starts_at at time zone v_tz)::date as local_date,
      count(*)                                          as total_count,
      count(*) filter (where res.status = 'cancelled')  as cancelled_count
    from res
    group by (res.starts_at at time zone v_tz)::date
  ),
  series as (
    select
      d.local_date,
      coalesce(rbd.total_count, 0)     as total_count,
      coalesce(rbd.cancelled_count, 0) as cancelled_count
    from days d
    left join res_by_day rbd on rbd.local_date = d.local_date
    order by d.local_date
  )
  select
    ra.total_res,
    ra.pending_res,
    ra.confirmed_res,
    ra.cancelled_res,
    case when ra.total_res = 0 then 0
         else round(100.0 * ra.cancelled_res / ra.total_res, 2) end,
    ra.member_booking_ct,
    ra.event_ct,
    ra.pro_lesson_ct,
    ra.maintenance_ct,
    ra.admin_block_ct,
    (
      select coalesce(jsonb_agg(jsonb_build_object(
        'local_date',      s.local_date,
        'total_count',     s.total_count,
        'cancelled_count', s.cancelled_count
      ) order by s.local_date), '[]'::jsonb)
      from series s
    )
  from res_agg ra;
end;
$$;

revoke execute on function public.get_reservation_summary(date, date)
  from public, anon;
grant execute on function public.get_reservation_summary(date, date)
  to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. get_event_program_summary — exposed RPC
--
-- Standalone vs. generated-program session breakdown, enrollment/fill, and
-- attendance, for an inclusive club-local date range. Admin-only.
--
-- A "program session" is an events row with program_id IS NOT NULL (Phase
-- 27's locked design — there is no separate session table). A "standalone
-- session" is an events row with program_id IS NULL.
--
-- Held sessions match 0095's sessions_held rule exactly: starts_at inside
-- the range, starts_at <= now(), status='scheduled'. Archived historical
-- events remain included (archiving is a visibility concept, not a data
-- exclusion). cancelled_standalone_sessions/cancelled_program_sessions are
-- a SEPARATE count — events with status='cancelled' whose starts_at falls
-- in range — since a cancelled event can never satisfy status='scheduled'.
--
-- Attendance rates use only CONFIRMED event_participants whose
-- attendance_status is 'attended' or 'no_show' — waitlisted/offered/
-- cancelled participants and guests (attendance is never tracked for
-- guests) are excluded from both the numerator and denominator. Lesson
-- outcomes (lesson_requests.lesson_outcome) are a separate vocabulary and
-- are never read or combined here.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.get_event_program_summary(
  p_start_date date,
  p_end_date   date
)
returns table (
  standalone_sessions_held     bigint,
  program_sessions_held        bigint,
  total_sessions_held          bigint,
  total_capacity                bigint,
  confirmed_members             bigint,
  guests                        bigint,
  total_enrollment              bigint,
  fill_rate_pct                 numeric,
  attended_count                bigint,
  no_show_count                 bigint,
  attendance_marked_count       bigint,
  attendance_rate_pct           numeric,
  no_show_rate_pct              numeric,
  cancelled_standalone_sessions bigint,
  cancelled_program_sessions    bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_range   tstzrange;
begin
  v_club_id := public.current_user_club_id();
  v_role    := public.current_user_role();

  if v_club_id is null then
    raise exception 'not_authenticated';
  end if;

  if v_role <> 'admin' then
    raise exception 'insufficient_role';
  end if;

  v_range := public.club_local_bounds(v_club_id, p_start_date, p_end_date);

  return query
  with sess as (
    select e.id, e.program_id, e.capacity
    from public.events e
    where e.club_id = v_club_id
      and e.starts_at >= lower(v_range)
      and e.starts_at <  upper(v_range)
      and e.starts_at <= now()
      and e.status = 'scheduled'
  ),
  sess_participants as (
    select
      ep.event_id,
      count(*) filter (where ep.status = 'confirmed')                                    as confirmed_count,
      count(*) filter (where ep.status = 'confirmed' and ep.attendance_status = 'attended') as attended_count,
      count(*) filter (where ep.status = 'confirmed' and ep.attendance_status = 'no_show')  as no_show_count
    from public.event_participants ep
    join sess s on s.id = ep.event_id
    group by ep.event_id
  ),
  sess_guests as (
    select eg.event_id, count(*) as guest_count
    from public.event_guests eg
    join sess s on s.id = eg.event_id
    group by eg.event_id
  ),
  sess_totals as (
    select
      (select count(*) filter (where program_id is null)     from sess) as standalone_held,
      (select count(*) filter (where program_id is not null) from sess) as program_held,
      (select count(*)                                        from sess) as total_held,
      (select coalesce(sum(capacity), 0)                      from sess) as total_capacity,
      (select coalesce(sum(confirmed_count), 0) from sess_participants)  as confirmed_members,
      (select coalesce(sum(guest_count), 0)      from sess_guests)       as guests,
      (select coalesce(sum(attended_count), 0)  from sess_participants)  as attended_total,
      (select coalesce(sum(no_show_count), 0)   from sess_participants)  as no_show_total
  ),
  cancelled_sess as (
    select
      count(*) filter (where e.program_id is null)     as cancelled_standalone,
      count(*) filter (where e.program_id is not null) as cancelled_program
    from public.events e
    where e.club_id = v_club_id
      and e.status = 'cancelled'
      and e.starts_at >= lower(v_range)
      and e.starts_at <  upper(v_range)
  )
  select
    st.standalone_held,
    st.program_held,
    st.total_held,
    st.total_capacity,
    st.confirmed_members,
    st.guests,
    (st.confirmed_members + st.guests) as total_enrollment,
    case when st.total_capacity = 0 then 0
         else round(100.0 * (st.confirmed_members + st.guests) / st.total_capacity, 2) end,
    st.attended_total,
    st.no_show_total,
    (st.attended_total + st.no_show_total) as attendance_marked_count,
    case when (st.attended_total + st.no_show_total) = 0 then 0
         else round(100.0 * st.attended_total / (st.attended_total + st.no_show_total), 2) end,
    case when (st.attended_total + st.no_show_total) = 0 then 0
         else round(100.0 * st.no_show_total  / (st.attended_total + st.no_show_total), 2) end,
    cs.cancelled_standalone,
    cs.cancelled_program
  from sess_totals st, cancelled_sess cs;
end;
$$;

revoke execute on function public.get_event_program_summary(date, date)
  from public, anon;
grant execute on function public.get_event_program_summary(date, date)
  to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. get_waitlist_demand — exposed RPC
--
-- Current actionable waitlist/offer snapshot, split by event vs. program
-- and by waitlisted vs. live-offer. Admin-only.
--
-- No reliable historical status-transition record exists anywhere in the
-- schema (event_participants/program_enrollments store only current
-- status, not a change history) — so this RPC makes NO claim about
-- historical offers made/accepted/declined/expired. Every field is a live
-- snapshot as of the call, using exactly the same actionable-filtering
-- contract 0095 established for outstanding_waitlist_count: an event
-- entry counts only when its event is future, scheduled, and non-archived;
-- a program entry counts only when its program is an active, non-archived,
-- non-ended whole-program (enrollment_model='program') offering; an
-- 'offered' row in either counts only while offer_expires_at > now().
--
-- p_start_date/p_end_date are still required and validated (via
-- club_local_bounds, for a stable error contract identical to every other
-- reporting RPC) but are NOT used to filter any returned field — every
-- number here is intentionally independent of the selected range, and the
-- frontend must label it as a current snapshot, not a range total.
--
-- Returns counts only — no member names, emails, profile ids, or raw
-- enrollment/participant rows.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.get_waitlist_demand(
  p_start_date date,
  p_end_date   date
)
returns table (
  event_waitlisted_entries    bigint,
  event_live_offer_entries    bigint,
  program_waitlisted_entries  bigint,
  program_live_offer_entries  bigint,
  total_outstanding_entries   bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_tz      text;
  v_today   date;
begin
  v_club_id := public.current_user_club_id();
  v_role    := public.current_user_role();

  if v_club_id is null then
    raise exception 'not_authenticated';
  end if;

  if v_role <> 'admin' then
    raise exception 'insufficient_role';
  end if;

  -- Validated for a signature/error contract consistent with the other
  -- reporting RPCs; the resulting range is intentionally not used below.
  perform public.club_local_bounds(v_club_id, p_start_date, p_end_date);

  select timezone into v_tz from public.clubs where id = v_club_id;
  v_today := (now() at time zone v_tz)::date;

  return query
  with event_wl as (
    select
      count(*) filter (where ep.status = 'waitlisted')                                as waitlisted,
      count(*) filter (where ep.status = 'offered' and ep.offer_expires_at > now())    as live_offers
    from public.event_participants ep
    join public.events e on e.id = ep.event_id
    where e.club_id      = v_club_id
      and e.status       = 'scheduled'
      and e.archived_at is null
      and e.starts_at    > now()
  ),
  program_wl as (
    select
      count(*) filter (where pe.status = 'waitlisted')                                 as waitlisted,
      count(*) filter (where pe.status = 'offered' and pe.offer_expires_at > now())     as live_offers
    from public.program_enrollments pe
    join public.programs p on p.id = pe.program_id
    where p.club_id          = v_club_id
      and p.enrollment_model = 'program'
      and p.status           = 'active'
      and p.archived_at is null
      and p.ends_on          >= v_today
  )
  select
    ew.waitlisted,
    ew.live_offers,
    pw.waitlisted,
    pw.live_offers,
    (ew.waitlisted + ew.live_offers + pw.waitlisted + pw.live_offers)
  from event_wl ew, program_wl pw;
end;
$$;

revoke execute on function public.get_waitlist_demand(date, date)
  from public, anon;
grant execute on function public.get_waitlist_demand(date, date)
  to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. get_member_engagement_summary — exposed RPC
--
-- Distinct-member activity counts for an inclusive club-local date range.
-- Admin-only. Every "members_with_*" field and engaged_member_count counts
-- DISTINCT members, never rows — a member with three reservations in range
-- still contributes 1 to members_with_reservations.
--
-- Every source is joined against club_memberships (role='member',
-- status='active', removed_at is null) so admins, pros, inactive/
-- suspended/removed members, and unclaimed roster_members (which have no
-- club_memberships row at all) are structurally excluded — not by a
-- separate filter, but because they can never satisfy that join.
--
-- engaged_member_count is the SQL UNION (not UNION ALL) of the three
-- per-source profile-id sets, so a member active in more than one source
-- is counted once, not once per source.
--
-- members_with_program_enrollment counts only WHOLE-PROGRAM enrollment
-- (programs.enrollment_model = 'program') — an 'enrolled' program_enrollments
-- row attached to a per_session or admin_managed program does not qualify,
-- per the locked metric definition. No additional program status/archive/
-- lifecycle filter is applied here.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.get_member_engagement_summary(
  p_start_date date,
  p_end_date   date
)
returns table (
  active_member_snapshot_count     bigint,
  engaged_member_count             bigint,
  members_with_reservations        bigint,
  members_with_event_participation bigint,
  members_with_program_enrollment  bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_range   tstzrange;
begin
  v_club_id := public.current_user_club_id();
  v_role    := public.current_user_role();

  if v_club_id is null then
    raise exception 'not_authenticated';
  end if;

  if v_role <> 'admin' then
    raise exception 'insufficient_role';
  end if;

  v_range := public.club_local_bounds(v_club_id, p_start_date, p_end_date);

  return query
  with active_members as (
    select count(*) as active_count
    from public.club_memberships
    where club_id    = v_club_id
      and status      = 'active'
      and removed_at is null
      and role        = 'member'
  ),
  reservation_members as (
    select distinct r.owner_user_id as profile_id
    from public.reservations r
    join public.club_memberships cm
      on cm.user_id = r.owner_user_id
     and cm.club_id = v_club_id
     and cm.role = 'member'
     and cm.status = 'active'
     and cm.removed_at is null
    where r.club_id = v_club_id
      and r.status in ('pending', 'confirmed')
      and r.starts_at >= lower(v_range)
      and r.starts_at <  upper(v_range)
  ),
  event_members as (
    select distinct ep.profile_id
    from public.event_participants ep
    join public.events e on e.id = ep.event_id
    join public.club_memberships cm
      on cm.user_id = ep.profile_id
     and cm.club_id = v_club_id
     and cm.role = 'member'
     and cm.status = 'active'
     and cm.removed_at is null
    where e.club_id = v_club_id
      and ep.status = 'confirmed'
      and e.starts_at >= lower(v_range)
      and e.starts_at <  upper(v_range)
  ),
  program_members as (
    select distinct pe.profile_id
    from public.program_enrollments pe
    join public.programs p on p.id = pe.program_id
    join public.club_memberships cm
      on cm.user_id = pe.profile_id
     and cm.club_id = v_club_id
     and cm.role = 'member'
     and cm.status = 'active'
     and cm.removed_at is null
    where p.club_id = v_club_id
      and p.enrollment_model = 'program'
      and pe.status = 'enrolled'
      and p.starts_on <= p_end_date
      and p.ends_on   >= p_start_date
  ),
  engaged as (
    select profile_id from reservation_members
    union
    select profile_id from event_members
    union
    select profile_id from program_members
  )
  select
    am.active_count,
    (select count(*) from engaged),
    (select count(*) from reservation_members),
    (select count(*) from event_members),
    (select count(*) from program_members)
  from active_members am;
end;
$$;

revoke execute on function public.get_member_engagement_summary(date, date)
  from public, anon;
grant execute on function public.get_member_engagement_summary(date, date)
  to authenticated;

commit;
