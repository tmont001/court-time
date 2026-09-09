-- 0169_fix_reporting_rpc_runtime_errors.sql
-- Admin IA / Reports cleanup — Checkpoint 2 — Runtime QA fix for the two
-- reporting RPCs the Checkpoint 1 observability logging (reportingDiagnostics.ts)
-- surfaced as failing on /admin/reports.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- CONFIRMED RUNTIME ERRORS (real Admin /admin/reports load, via the new
-- server-side diagnostic logging)
-- ═══════════════════════════════════════════════════════════════════════════
-- [AdminReports] reporting RPC failed: {
--   rpc: 'get_reporting_overview',
--   code: '42804',
--   message: 'structure of query does not match function result type'
-- }
-- [AdminReports] reporting RPC failed: {
--   rpc: 'get_event_program_summary',
--   code: '42702',
--   message: 'column reference "attended_count" is ambiguous'
-- }
-- No diagnostic was emitted for get_court_utilization, get_reservation_
-- summary, get_waitlist_demand, or get_member_engagement_summary — all
-- four are confirmed NOT touched by this migration.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ROOT CAUSE 1 — get_reporting_overview, 42804 (type mismatch)
-- ═══════════════════════════════════════════════════════════════════════════
-- Declared: total_session_enrollment bigint (8th RETURNS TABLE column).
-- Actual expression (sess_totals CTE, effective 0117 body):
--   (select coalesce(sum(confirmed_count), 0) from sess_participants)
--     + (select coalesce(sum(guest_count), 0) from sess_guests)
--     as total_enrollment
-- confirmed_count/guest_count are themselves count(*)-derived columns —
-- already bigint. PostgreSQL's sum() aggregate promotes a bigint input to
-- NUMERIC (unlike sum(int), which stays bigint — see total_capacity two
-- lines above, sum(capacity) where capacity is `int`, correctly bigint,
-- unaffected). So total_enrollment's actual inferred type is numeric,
-- not bigint, and RETURN QUERY's structural match against the declared
-- RETURNS TABLE column raises 42804 the instant the query executes. Every
-- OTHER column in this function's final SELECT was individually type-
-- checked against its declared RETURNS TABLE type during this audit and
-- confirmed to match (bigint columns are either a direct count(*)/count(*)
-- filter, a count(*)+count(*) sum of two already-bigint scalars — which
-- stays bigint, no promotion — or a sum() over an `int`-typed source
-- column; numeric columns are all wrapped in round(), which is numeric
-- regardless of its input's exact type) — this is the ONLY mismatched
-- column in this function.
--
-- FIX: cast the total_enrollment expression to ::bigint at its own CTE
-- definition. The underlying value is always a sum of counts (always a
-- whole number, never fractional) — this cast is lossless and changes no
-- metric semantics, only the wire type.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ROOT CAUSE 2 — get_event_program_summary, 42702 (ambiguous column) —
-- PLUS a second, not-yet-surfaced ambiguity, PLUS six latent 42804-class
-- type mismatches this audit found while tracing every RETURNS TABLE OUT
-- name through the function body (per the explicit instruction to audit
-- every reference, not just the first runtime error)
-- ═══════════════════════════════════════════════════════════════════════════
-- This function's RETURNS TABLE declares attended_count and no_show_count
-- as OUT parameter names — in PL/pgSQL, RETURNS TABLE column names are
-- implicitly declared as variables visible for the entire function body,
-- exactly the mechanism already documented and fixed once in this
-- codebase (see 0160_fix_lesson_checkout_wrapper_column_ambiguity.sql).
--
-- The sess_participants CTE defines its OWN columns named attended_count
-- and no_show_count (from count(*) filter (...)). Defining those aliases
-- is not itself an error. The error fires where they are later referenced
-- BARE (unqualified) inside sess_totals:
--   (select coalesce(sum(attended_count), 0) from sess_participants)
--     + (select coalesce(sum(guest_attended_count), 0) from sess_guests)
--     as attended_total,
--   (select coalesce(sum(no_show_count), 0) from sess_participants)
--     + (select coalesce(sum(guest_no_show_count), 0) from sess_guests)
--     as no_show_total
-- `attended_count` (first bare reference, in program order) is exactly
-- what the runtime log reports. `no_show_count` is the immediate next
-- ambiguous bare reference, not yet surfaced only because Postgres raises
-- on the first ambiguity it hits while planning — fixing attended_count
-- alone would have made the very next Reports load fail on no_show_count
-- instead. Every OTHER reference in this function's body was audited and
-- confirmed already qualified with an explicit table/CTE alias (ep./eg./
-- e./s./st./cs.) — these two are the ONLY bare references in the whole
-- function that collide with a RETURNS TABLE OUT name.
--
-- FIX (same technique as 0160): qualify both references with the CTE's
-- own alias — `sess_participants sp`, then `sp.attended_count` / `sp.
-- no_show_count` — rather than a broad #variable_conflict pragma, and
-- without renaming the public output contract.
--
-- SEPARATE, ADDITIONAL DEFECT found by the same column-by-column audit
-- applied to get_reporting_overview above: fixing the ambiguity alone
-- would let this query plan successfully for the first time — and
-- immediately raise 42804, because the exact same sum(bigint-derived-
-- column) promotion bug from get_reporting_overview also affects THIS
-- function, in six declared-bigint columns whose actual expressions
-- resolve to numeric:
--   confirmed_members  <- sum(confirmed_count)                (bigint->numeric)
--   guests              <- sum(guest_count)                    (bigint->numeric)
--   total_enrollment    <- confirmed_members + guests          (numeric+numeric)
--   attended_count(OUT) <- attended_total = sum(attended_count)
--                          + sum(guest_attended_count)         (numeric+numeric)
--   no_show_count(OUT)  <- no_show_total  = sum(no_show_count)
--                          + sum(guest_no_show_count)          (numeric+numeric)
--   attendance_marked_count <- attended_total + no_show_total  (numeric+numeric)
-- total_capacity (sum over `capacity`, an `int` column) and
-- cancelled_standalone_sessions/cancelled_program_sessions (plain
-- count(*) filter, no sum()) are unaffected, matching the same pattern
-- established in get_reporting_overview. fill_rate_pct/attendance_rate_
-- pct/no_show_rate_pct are unaffected — already wrapped in round(),
-- numeric regardless of their inputs' exact type.
--
-- Leaving these six unfixed would mean this migration trades one runtime
-- error (42702) for another (42804) on the very next /admin/reports load
-- of this same function — exactly the failure mode this checkpoint's own
-- audit instructions warn against. Fixing them is therefore required by,
-- not additional scope beyond, "fix the precise defects in this function."
--
-- FIX: cast confirmed_members/guests/attended_total/no_show_total to
-- ::bigint at their own CTE definitions (same lossless whole-number
-- rationale as get_reporting_overview above). total_enrollment and
-- attendance_marked_count need no separate cast — once their two inputs
-- are each bigint, `bigint + bigint` is bigint with no promotion, so they
-- resolve correctly with no further change.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- SCOPE
-- ═══════════════════════════════════════════════════════════════════════════
-- Both functions are reproduced VERBATIM from their exact effective 0117
-- bodies (0117 itself is NOT edited), with ONLY the specific casts/alias-
-- qualifications documented above changed. Same signature, same RETURNS
-- TABLE column list/order/declared types, same LANGUAGE plpgsql, same
-- STABLE, same SECURITY DEFINER, same `set search_path = public, pg_temp`,
-- same not_authenticated/insufficient_role checks, same current_user_
-- club_id()/current_user_role() tenant derivation, same date/range
-- semantics, same metric definitions, same revoke/grant shape.
--
-- get_court_utilization, get_reservation_summary, get_waitlist_demand,
-- and get_member_engagement_summary are NOT touched — no diagnostic was
-- emitted for any of them, and none is a dependency of either fix above.
-- No payment function, RLS policy, or table schema is touched.
--
-- Apply in Supabase SQL Editor (cloud only). NOT YET APPLIED.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. get_reporting_overview — total_enrollment type-correctness fix only
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
    where eg.status = 'active'
    group by eg.event_id
  ),
  sess_totals as (
    select
      (select count(*) from sess)                                    as sessions_held,
      (select coalesce(sum(capacity), 0) from sess)                  as total_capacity,
      -- Runtime QA fix (0169): cast to ::bigint — sum() over the
      -- already-bigint confirmed_count/guest_count columns promotes to
      -- numeric, which does not structurally match the declared
      -- total_session_enrollment bigint output column (42804). The
      -- summed value is always a whole number; this cast is lossless.
      (
        (select coalesce(sum(confirmed_count), 0) from sess_participants)
        + (select coalesce(sum(guest_count), 0) from sess_guests)
      )::bigint                                                       as total_enrollment
  ),
  members as (
    select count(*) as active_count
    from public.roster_members rm
    where rm.club_id = v_club_id
      and rm.role     = 'member'
      and rm.status   = 'active'
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
-- 2. get_event_program_summary — ambiguous-column fix (attended_count AND
--    no_show_count) plus the type-correctness fix required to avoid
--    immediately re-failing with 42804 once the ambiguity is resolved
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
    select
      eg.event_id,
      count(*) filter (where eg.status = 'active')             as guest_count,
      count(*) filter (where eg.attendance_status = 'attended') as guest_attended_count,
      count(*) filter (where eg.attendance_status = 'no_show')  as guest_no_show_count
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
      -- Runtime QA fix (0169): ::bigint — sum(confirmed_count) promotes
      -- an already-bigint column to numeric, mismatching the declared
      -- confirmed_members bigint output column (42804). Lossless: the
      -- summed value is always a whole number.
      (select coalesce(sum(confirmed_count), 0) from sess_participants)::bigint  as confirmed_members,
      -- Runtime QA fix (0169): same ::bigint fix as confirmed_members,
      -- for the declared guests bigint output column.
      (select coalesce(sum(guest_count), 0)      from sess_guests)::bigint       as guests,
      -- Runtime QA fix (0169): sess_participants qualified as `sp` so
      -- `sp.attended_count`/`sp.no_show_count` are unambiguous — bare
      -- `attended_count`/`no_show_count` collided with this function's
      -- own RETURNS TABLE output variables of the identical names
      -- (42702, column reference is ambiguous; attended_count is the
      -- exact error the runtime log reported, no_show_count is the next
      -- bare reference that would have failed the same way immediately
      -- after). Also cast to ::bigint for the same reason as
      -- confirmed_members/guests above — declared attended_count/
      -- no_show_count are bigint, sum() over a bigint column promotes to
      -- numeric.
      (
        (select coalesce(sum(sp.attended_count), 0) from sess_participants sp)
        + (select coalesce(sum(guest_attended_count), 0) from sess_guests)
      )::bigint                                                                   as attended_total,
      (
        (select coalesce(sum(sp.no_show_count), 0) from sess_participants sp)
        + (select coalesce(sum(guest_no_show_count), 0) from sess_guests)
      )::bigint                                                                   as no_show_total
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

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created)
-- ═══════════════════════════════════════════════════════════════════════════
-- Restores both functions to their exact effective 0117 bodies (the ones
-- that raise 42804/42702 at runtime) — byte-identical to 0117's own text.
-- begin;
--
-- create or replace function public.get_reporting_overview(
--   p_start_date date,
--   p_end_date   date
-- )
-- returns table (
--   gross_utilization_pct         numeric,
--   member_demand_utilization_pct numeric,
--   total_reservations            bigint,
--   cancelled_reservations        bigint,
--   cancellation_rate_pct         numeric,
--   sessions_held                 bigint,
--   total_session_capacity        bigint,
--   total_session_enrollment      bigint,
--   session_fill_rate_pct         numeric,
--   active_member_count           bigint,
--   outstanding_waitlist_count    bigint
-- )
-- language plpgsql
-- stable
-- security definer
-- set search_path = public, pg_temp
-- as $$
-- -- ... (0117's exact body — see
-- -- supabase/migrations/0117_durable_member_guest_lifecycle_and_attendance.sql,
-- -- Section L, first function under "get_reporting_overview: active_member_count
-- -- moves from...")
-- $$;
--
-- create or replace function public.get_event_program_summary(
--   p_start_date date,
--   p_end_date   date
-- )
-- returns table (
--   standalone_sessions_held     bigint,
--   program_sessions_held        bigint,
--   total_sessions_held          bigint,
--   total_capacity                bigint,
--   confirmed_members             bigint,
--   guests                        bigint,
--   total_enrollment              bigint,
--   fill_rate_pct                 numeric,
--   attended_count                bigint,
--   no_show_count                 bigint,
--   attendance_marked_count       bigint,
--   attendance_rate_pct           numeric,
--   no_show_rate_pct              numeric,
--   cancelled_standalone_sessions bigint,
--   cancelled_program_sessions    bigint
-- )
-- language plpgsql
-- stable
-- security definer
-- set search_path = public, pg_temp
-- as $$
-- -- ... (0117's exact body — see
-- -- supabase/migrations/0117_durable_member_guest_lifecycle_and_attendance.sql,
-- -- Section L, "get_event_program_summary: enrollment/fill...")
-- $$;
--
-- commit;
