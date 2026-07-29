-- 0095_reporting_foundation.sql
-- Phase 28A: Reporting Foundation.
--
-- Adds the club-local date-range helper, two private aggregation helpers,
-- and two admin-only, read-only reporting RPCs:
--   - get_reporting_overview(p_start_date, p_end_date)
--   - get_court_utilization(p_start_date, p_end_date)
--
-- No new tables. No RLS changes. No direct authenticated write grants.
-- Adds exactly one index: reservations (club_id, starts_at).
--
-- Every exposed RPC derives club/role exclusively through
-- current_user_club_id()/current_user_role() (membership-native, Phase 26+
-- convention) — never through profiles.club_id/role/status/
-- is_lesson_provider. Every RPC here is SECURITY DEFINER, STABLE, and
-- read-only; none accepts a client-supplied club id.
--
-- Apply in Supabase SQL Editor (cloud only).

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Index — reservations (club_id, starts_at)
--    The only index this checkpoint needs. reservations previously had no
--    btree index at all beyond the GiST exclude constraint (which is scoped
--    to active pending/confirmed rows only and cannot serve a club+date-range
--    scan across cancelled rows for cancellation-rate reporting).
-- ═══════════════════════════════════════════════════════════════════════════

create index if not exists reservations_club_starts_at_idx
  on public.reservations (club_id, starts_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. club_local_bounds — internal date-range helper
--
-- Converts an inclusive club-local calendar-date range into the equivalent
-- UTC tstzrange: [local midnight on p_start_date, local midnight on the day
-- AFTER p_end_date). DST-safe — uses the same
-- "(date::timestamp) at time zone v_tz" idiom already established for
-- local-to-UTC conversion in generate_program_sessions (0088), which relies
-- on Postgres's own tzdata-backed conversion rather than a fixed offset.
--
-- Internal only: revoked from PUBLIC, anon, AND authenticated. Callable only
-- by the reporting RPCs in this migration, which are SECURITY DEFINER and
-- therefore execute (and call this helper) as the owning role regardless of
-- these revokes — the same pattern already used for
-- _current_user_active_membership() in 0082.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.club_local_bounds(
  p_club_id    uuid,
  p_start_date date,
  p_end_date   date
)
returns tstzrange
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz text;
begin
  if p_start_date is null or p_end_date is null then
    raise exception 'invalid_date_range';
  end if;

  if p_end_date < p_start_date then
    raise exception 'invalid_date_range';
  end if;

  -- Inclusive day count = (p_end_date - p_start_date) + 1; reject > 366.
  if (p_end_date - p_start_date) > 365 then
    raise exception 'date_range_too_large';
  end if;

  select timezone into v_tz from public.clubs where id = p_club_id;
  if v_tz is null then
    raise exception 'invalid_date_range';
  end if;

  return tstzrange(
    (p_start_date::timestamp)       at time zone v_tz,
    ((p_end_date + 1)::timestamp)   at time zone v_tz,
    '[)'
  );
end;
$$;

revoke execute on function public.club_local_bounds(uuid, date, date)
  from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. _reporting_daily_open_hours — private helper
--
-- Sums per-day club-wide open hours across an inclusive club-local date
-- range, applying the same override-precedence rule create_reservation
-- enforces at booking time (0047):
--   1. A matching override with is_closed=true            → 0 hours.
--   2. A matching override with is_closed=false AND both
--      opens_at and closes_at set                         → override duration.
--   3. Otherwise (no matching override, OR a matching
--      override that is open but has no replacement hours)
--      → fall back to the weekly operating_hours row for
--        that day_of_week, if it exists and is not closed.
--   4. Otherwise                                           → 0 hours.
-- An "open override without replacement hours" is a malformed row that the
-- write-time RPC (upsert_operating_hours_override, 0045) never produces —
-- it requires both opens_at/closes_at whenever is_closed=false — but branch
-- 3 still falls through to weekly hours for it rather than zeroing, per the
-- Calendar's own precedence contract (CalendarShell.tsx).
--
-- Operating hours are club-wide, not per-court (there is no per-court
-- override table), so this single sum applies equally to every active
-- court — get_court_utilization multiplies it by 1 per court row, and
-- get_reporting_overview multiplies it by the active-court count.
--
-- v1 limitation (documented, not solved here): this always uses the
-- CURRENT is_active courts snapshot and CURRENT operating-hours/override
-- configuration, not each court's historical activation state or each
-- date's hours as they stood at the time. A report over a past range in
-- which a court was added/deactivated, or hours were changed, mid-range
-- will not reflect that history.
--
-- Local-date generation is timezone-independent: offsets are generated as
-- plain integers (0..(p_end_date - p_start_date)) and added directly to
-- p_start_date (date + int = date), never via a
-- timestamp/timestamptz generate_series overload.
--
-- Internal only: revoked from PUBLIC, anon, AND authenticated.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public._reporting_daily_open_hours(
  p_club_id    uuid,
  p_start_date date,
  p_end_date   date
)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with days as (
    select (p_start_date + day_offset) as local_date
    from generate_series(0, (p_end_date - p_start_date)) as day_offset
  )
  select coalesce(sum(
    case
      when ov.club_id is not null and ov.is_closed then 0::numeric
      when ov.club_id is not null
           and ov.opens_at is not null and ov.closes_at is not null
        then extract(epoch from (ov.closes_at - ov.opens_at)) / 3600.0
      when oh.club_id is not null and not oh.is_closed
        then extract(epoch from (oh.closes_at - oh.opens_at)) / 3600.0
      else 0::numeric
    end
  ), 0)
  from days
  left join public.operating_hours_override ov
    on ov.club_id = p_club_id and ov.override_date = days.local_date
  left join public.operating_hours oh
    on oh.club_id = p_club_id and oh.day_of_week = extract(dow from days.local_date)::int
$$;

revoke execute on function public._reporting_daily_open_hours(uuid, date, date)
  from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. _reporting_reserved_hours — private helper
--
-- One row per active (pending/confirmed) reservation overlapping p_range on
-- a CURRENTLY ACTIVE court, with its duration clipped to the intersection
-- of the reservation interval and p_range. Cancelled reservations never
-- appear here, and neither do reservations on a court that is currently
-- inactive — a court must belong to p_club_id AND have is_active=true.
-- This is what makes get_reporting_overview's reserved-hours totals exactly
-- equal the sum of get_court_utilization's per-court rows: both draw from
-- this same active-court-filtered set. Shared by both exposed RPCs so
-- overlap/clipping/status-filter/active-court logic can never diverge
-- between the overview and per-court numbers.
--
-- v1 rule (matches _reporting_daily_open_hours): historical reports use the
-- CURRENT active-court configuration. A reservation on a court that has
-- since been deactivated is excluded entirely, even if the reservation
-- itself falls inside the report range and was valid when it was made.
--
-- Internal only: revoked from PUBLIC, anon, AND authenticated.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public._reporting_reserved_hours(
  p_club_id uuid,
  p_range   tstzrange
)
returns table (
  court_id uuid,
  reason   text,
  hours    numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    r.court_id,
    r.reason,
    extract(epoch from (
      least(r.ends_at, upper(p_range)) - greatest(r.starts_at, lower(p_range))
    )) / 3600.0 as hours
  from public.reservations r
  join public.courts c
    on c.id = r.court_id
   and c.club_id = p_club_id
   and c.is_active = true
  where r.club_id = p_club_id
    and r.status in ('pending', 'confirmed')
    and r.starts_at < upper(p_range)
    and r.ends_at   > lower(p_range)
$$;

revoke execute on function public._reporting_reserved_hours(uuid, tstzrange)
  from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. get_reporting_overview — exposed RPC
--
-- Single-row club-wide KPI summary for an inclusive club-local date range.
-- Admin-only. Scoped exclusively via current_user_club_id()/
-- current_user_role() — never accepts a client-supplied club id.
--
-- Member-demand reasons are exactly the three reservation reasons that
-- represent real member/pro demand for court time: 'member_booking',
-- 'event', 'pro_lesson'. 'maintenance' and 'admin_block' occupy a court but
-- are not demand — excluded from the member-demand cut, included in gross.
--
-- outstanding_waitlist_count is a genuinely OUTSTANDING snapshot, not a
-- historical tally — independent of p_start_date/p_end_date, it counts only
-- entries that could still resolve into a spot right now:
--   Event waitlist/offer entries count only when the event itself is still
--   live (status='scheduled', archived_at is null, starts_at > now()) —
--   a waitlisted/offered row on a past, cancelled, or archived event is
--   already moot and is excluded.
--   Program waitlist/offer entries count only when the program is a live
--   whole-program enrollment target (enrollment_model='program',
--   status='active', archived_at is null, ends_on on or after the
--   club-local current date) — cancelled/completed/archived programs, and
--   programs whose enrollment window has already ended, are excluded.
-- Both branches still require offer_expires_at > now() for status='offered'
-- rows — an expired offer is not outstanding regardless of the event/
-- program's own state.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.get_reporting_overview(
  p_start_date date,
  p_end_date   date
)
returns table (
  gross_utilization_pct         numeric,
  member_demand_utilization_pct numeric,
  total_reservations            bigint,
  cancelled_reservations        bigint,
  cancellation_rate_pct         numeric,
  sessions_held                 bigint,
  total_session_capacity        bigint,
  total_session_enrollment      bigint,
  session_fill_rate_pct         numeric,
  active_member_count           bigint,
  outstanding_waitlist_count    bigint
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
  v_available_hours numeric;
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

  v_range := public.club_local_bounds(v_club_id, p_start_date, p_end_date);

  v_available_hours :=
    public._reporting_daily_open_hours(v_club_id, p_start_date, p_end_date)
    * (select count(*) from public.courts where club_id = v_club_id and is_active = true);

  -- Club-local "today" for the outstanding-waitlist program-window check.
  -- Derived from clubs.timezone, never the database session timezone.
  select timezone into v_tz from public.clubs where id = v_club_id;
  v_today := (now() at time zone v_tz)::date;

  return query
  with reserved as (
    select * from public._reporting_reserved_hours(v_club_id, v_range)
  ),
  reserved_totals as (
    select
      coalesce(sum(hours), 0) as gross_hours,
      coalesce(sum(hours) filter (where reason in ('member_booking', 'event', 'pro_lesson')), 0) as member_hours
    from reserved
  ),
  res_counts as (
    select
      count(*) filter (where r.status in ('pending', 'confirmed', 'cancelled')) as total_res,
      count(*) filter (where r.status = 'cancelled')                            as cancelled_res
    from public.reservations r
    where r.club_id = v_club_id
      and r.starts_at >= lower(v_range)
      and r.starts_at <  upper(v_range)
  ),
  sess as (
    select e.id, e.capacity
    from public.events e
    where e.club_id = v_club_id
      and e.starts_at >= lower(v_range)
      and e.starts_at <  upper(v_range)
      and e.starts_at <= now()
      and e.status = 'scheduled'
  ),
  sess_participants as (
    select ep.event_id, count(*) as confirmed_count
    from public.event_participants ep
    join sess s on s.id = ep.event_id
    where ep.status = 'confirmed'
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
      (select count(*) from sess)                                    as sessions_held,
      (select coalesce(sum(capacity), 0) from sess)                  as total_capacity,
      (select coalesce(sum(confirmed_count), 0) from sess_participants)
        + (select coalesce(sum(guest_count), 0) from sess_guests)    as total_enrollment
  ),
  members as (
    select count(*) as active_count
    from public.club_memberships
    where club_id    = v_club_id
      and status      = 'active'
      and removed_at is null
      and role        = 'member'
  ),
  waitlist as (
    select
      (
        select count(*)
        from public.event_participants ep
        join public.events e on e.id = ep.event_id
        where e.club_id      = v_club_id
          and e.status       = 'scheduled'
          and e.archived_at is null
          and e.starts_at    > now()
          and (
            ep.status = 'waitlisted'
            or (ep.status = 'offered' and ep.offer_expires_at > now())
          )
      )
      +
      (
        select count(*)
        from public.program_enrollments pe
        join public.programs p on p.id = pe.program_id
        where p.club_id          = v_club_id
          and p.enrollment_model = 'program'
          and p.status           = 'active'
          and p.archived_at is null
          and p.ends_on          >= v_today
          and (
            pe.status = 'waitlisted'
            or (pe.status = 'offered' and pe.offer_expires_at > now())
          )
      ) as outstanding_count
  )
  select
    case when v_available_hours = 0 then 0
         else round(100.0 * rt.gross_hours / v_available_hours, 2) end,
    case when v_available_hours = 0 then 0
         else round(100.0 * rt.member_hours / v_available_hours, 2) end,
    rc.total_res,
    rc.cancelled_res,
    case when rc.total_res = 0 then 0
         else round(100.0 * rc.cancelled_res / rc.total_res, 2) end,
    st.sessions_held,
    st.total_capacity,
    st.total_enrollment,
    case when st.total_capacity = 0 then 0
         else round(100.0 * st.total_enrollment / st.total_capacity, 2) end,
    m.active_count,
    w.outstanding_count
  from reserved_totals rt, res_counts rc, sess_totals st, members m, waitlist w;
end;
$$;

revoke execute on function public.get_reporting_overview(date, date)
  from public, anon;
grant execute on function public.get_reporting_overview(date, date)
  to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. get_court_utilization — exposed RPC
--
-- One row per currently active same-club court. Same date/override/
-- clipping/status/reason rules as get_reporting_overview (shared via the
-- two private helpers above). Admin-only, club-scoped only via
-- current_user_club_id()/current_user_role().
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.get_court_utilization(
  p_start_date date,
  p_end_date   date
)
returns table (
  court_id                       uuid,
  court_name                     text,
  available_hours                numeric,
  gross_reserved_hours           numeric,
  member_demand_reserved_hours   numeric,
  gross_utilization_pct          numeric,
  member_demand_utilization_pct  numeric
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
  v_daily_hours numeric;
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

  v_daily_hours := public._reporting_daily_open_hours(v_club_id, p_start_date, p_end_date);

  return query
  with reserved as (
    select * from public._reporting_reserved_hours(v_club_id, v_range)
  ),
  by_court as (
    select
      reserved.court_id,
      sum(reserved.hours) as gross_hours,
      sum(reserved.hours) filter (where reserved.reason in ('member_booking', 'event', 'pro_lesson')) as member_hours
    from reserved
    group by reserved.court_id
  )
  select
    c.id,
    c.name,
    v_daily_hours,
    coalesce(bc.gross_hours, 0),
    coalesce(bc.member_hours, 0),
    case when v_daily_hours = 0 then 0
         else round(100.0 * coalesce(bc.gross_hours, 0) / v_daily_hours, 2) end,
    case when v_daily_hours = 0 then 0
         else round(100.0 * coalesce(bc.member_hours, 0) / v_daily_hours, 2) end
  from public.courts c
  left join by_court bc on bc.court_id = c.id
  where c.club_id = v_club_id
    and c.is_active = true
  order by c.display_order asc, c.id asc;
end;
$$;

revoke execute on function public.get_court_utilization(date, date)
  from public, anon;
grant execute on function public.get_court_utilization(date, date)
  to authenticated;

commit;
