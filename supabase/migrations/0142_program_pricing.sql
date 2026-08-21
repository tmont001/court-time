-- 0142_program_pricing.sql
-- Phase 34B — Admin-Controlled Pricing Foundation, part 4 of 4.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- One column, programs.price_amount_cents, whose meaning depends on
-- enrollment_model:
--   'program'     — price = the entire series. program_enrollments
--                   snapshots this once, at first enrollment (or
--                   reactivation after a prior cancel). Generated Event
--                   sessions and their auto-materialized event_participants
--                   rows stay UNPRICED at the event level — the series was
--                   already priced once at the enrollment level; pricing
--                   it again per generated session would double-charge.
--   'per_session' — price = PER generated session. generate_program_sessions
--                   copies the program's CURRENT price onto every newly-
--                   generated events.price_amount_cents; already-generated
--                   sessions are never repriced by a later program price
--                   change. Participants then snapshot the Event's price
--                   normally via join_event/admin_add_roster_participant
--                   (0141) — no change needed here beyond the copy at
--                   generation time.
--   'admin_managed' — price is optional, operational information only; no
--                   enrollment RPC ever snapshots against it (nothing
--                   self-enrolls), so no RPC change is needed for this
--                   case beyond allowing the value to be set.
--
-- create_program and update_program are DELIBERATELY left untouched by
-- this migration — both are Staff/Pro/Admin-shared (0137), and pricing
-- must stay Admin-exclusive. A Staff/Pro-created program's price simply
-- starts NULL (no inheritable "type default" exists for Programs the way
-- event_types provides one for Events); Admin configures it afterward via
-- the new, separate, Admin-only set_program_price.
--
-- Every RPC body below is copied verbatim from the already-Production-
-- verified 0137 bodies, or from the Production pg_get_functiondef output
-- supplied directly by the operator this checkpoint (join_program) — not
-- reconstructed. The ONLY change to each is the price-snapshot logic
-- described in its own inline comment.
--
-- Historical rows remain NULL — no backfill. Production preflight (this
-- checkpoint) confirmed 10 programs, 12 program_enrollments, neither
-- touched by this migration's ALTER TABLE statements beyond adding the
-- new nullable columns.
--
-- FINAL PRE-APPLY CORRECTION: this migration also CREATE OR REPLACEs
-- update_club_pricing(text, integer) (originally defined in 0139) — see
-- that function's own inline comment below for the full rationale. In
-- short: 0139's version lacked a fixed search_path (now added), and could
-- not yet enforce a currency-lock guard because the lesson/event/program
-- pricing columns it needs to check didn't exist until this migration.
-- club_settings.currency changes are now blocked once any >0 price has
-- been configured or recorded anywhere in the club; NULL/0-only pricing
-- and same-currency rate edits remain fully allowed.
--
-- Does not modify 0131-0141 otherwise. Not applied by this checkpoint.
-- Apply in Supabase SQL Editor (cloud only).
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ─────────────────────────────────────────────────────────────────────────
-- Schema
-- ─────────────────────────────────────────────────────────────────────────

alter table public.programs
  add column price_amount_cents integer null;

alter table public.programs
  add constraint programs_price_amount_cents_nonneg
    check (price_amount_cents is null or price_amount_cents >= 0);

alter table public.program_enrollments
  add column price_amount_cents integer null;

alter table public.program_enrollments
  add constraint program_enrollments_price_amount_cents_nonneg
    check (price_amount_cents is null or price_amount_cents >= 0);

-- ─────────────────────────────────────────────────────────────────────────
-- set_program_price — new, Admin-only. Mirrors create_program/
-- update_program's modern auth style (current_user_club_id/
-- current_user_role). Changes only programs.price_amount_cents; existing
-- program_enrollments and already-generated Events' price_amount_cents
-- are never rewritten. Future enrollments/generated sessions use the new
-- price.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.set_program_price(
  p_program_id uuid,
  p_price_amount_cents integer
)
returns programs
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_program public.programs%rowtype;
  v_result  public.programs%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role <> 'admin' then raise exception 'insufficient_role'; end if;

  select * into v_program from public.programs where id = p_program_id and club_id = v_club_id;
  if not found then raise exception 'program_not_found'; end if;

  if p_price_amount_cents is not null and p_price_amount_cents < 0 then
    raise exception 'invalid_price';
  end if;

  update public.programs
  set price_amount_cents = p_price_amount_cents, updated_at = now()
  where id = p_program_id
  returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'set_program_price', 'program', p_program_id,
    jsonb_build_object('price_amount_cents', p_price_amount_cents)
  );

  return v_result;
end;
$$;

revoke execute on function public.set_program_price(uuid, integer) from public, anon;
grant  execute on function public.set_program_price(uuid, integer) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- generate_program_sessions — 0137 body + per_session price copy onto
-- each newly-generated Event. 'program' and 'admin_managed' generated
-- sessions stay unpriced at the event level (see this migration's header).
-- The already-existing 'program'-model event_participants auto-
-- materialization insert (below the events insert) is untouched — it has
-- no price_amount_cents in its column list, so those rows are implicitly
-- NULL, matching "the series was already priced once at enrollment."
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.generate_program_sessions(p_program_id uuid, p_from_date date DEFAULT NULL::date, p_through_date date DEFAULT NULL::date)
 RETURNS TABLE(inserted_count integer, skipped_count integer, event_ids uuid[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id            uuid;
  v_role               text;
  v_program            public.programs%rowtype;
  v_tz                 text;
  v_from               date;
  v_through            date;
  v_total_count        int;
  v_new_count          int;
  v_conflict_res_id    uuid;
  v_conflict_court_id  uuid;
  v_conflict_date      date;
  v_conflict_rule_a    uuid;
  v_conflict_rule_b    uuid;
  v_rec                record;
  v_starts_at          timestamptz;
  v_ends_at            timestamptz;
  v_capacity           int;
  v_court_count        int;
  v_member_joinable    boolean;
  v_new_event          public.events%rowtype;
  v_court_rec          record;
  v_inserted_ids       uuid[] := '{}';
  v_inserted_count     int    := 0;
  -- Phase 34B: per_session programs copy the program's CURRENT price onto
  -- every newly-generated session; 'program'/'admin_managed' sessions stay
  -- unpriced at the event level (see this migration's header comment).
  -- Computed once — fixed for the whole call, not per-iteration.
  v_session_price_amount_cents integer;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role not in ('admin', 'pro', 'staff') then raise exception 'insufficient_role'; end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id
    for update;
  if not found then raise exception 'program_not_found'; end if;

  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_program.archived_at is not null then raise exception 'program_archived'; end if;
  if v_program.status not in ('draft', 'active') then raise exception 'program_not_generatable'; end if;

  perform public._validate_program_definition(p_program_id, v_club_id, v_program.event_type_id);

  v_from    := greatest(coalesce(p_from_date, v_program.starts_on), v_program.starts_on);
  v_through := least(coalesce(p_through_date, v_program.ends_on), v_program.ends_on);

  if v_through < v_from then raise exception 'invalid_date_range'; end if;
  if (v_through - v_from) > 182 then raise exception 'range_too_long'; end if;

  select timezone into v_tz from public.clubs where id = v_club_id;

  select count(*) into v_total_count
  from public.program_schedule_rules psr
  cross join generate_series(v_from::timestamp, v_through::timestamp, interval '1 day') as d
  where psr.program_id = p_program_id
    and extract(dow from d)::int = psr.day_of_week;

  drop table if exists pg27b2_candidates;

  create temporary table pg27b2_candidates (
    rule_id            uuid,
    occurrence_date    date,
    start_time         time,
    duration_minutes   int,
    capacity_override  int,
    court_id           uuid
  ) on commit drop;

  insert into pg27b2_candidates (rule_id, occurrence_date, start_time, duration_minutes, capacity_override, court_id)
  select psr.id, d::date, psr.start_time, psr.duration_minutes, psr.capacity_override, prc.court_id
  from public.program_schedule_rules psr
  cross join generate_series(v_from::timestamp, v_through::timestamp, interval '1 day') as d
  join public.program_rule_courts prc on prc.program_schedule_rule_id = psr.id
  where psr.program_id = p_program_id
    and extract(dow from d)::int = psr.day_of_week
    and not exists (
      select 1 from public.events e
      where e.program_schedule_rule_id = psr.id
        and e.program_occurrence_date  = d::date
    );

  select count(distinct (rule_id, occurrence_date)) into v_new_count from pg27b2_candidates;

  if v_new_count = 0 then
    insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
    values (
      v_club_id, auth.uid(), 'generate_program_sessions', 'program', p_program_id,
      jsonb_build_object(
        'inserted_count',   0,
        'skipped_count',    v_total_count,
        'from',             v_from,
        'through',          v_through,
        'program_owner_id', v_program.created_by,
        'generated_by_id',  auth.uid()
      )
    );
    return query select 0, v_total_count, '{}'::uuid[];
    return;
  end if;

  if v_new_count > 200 then
    raise exception 'too_many_occurrences';
  end if;

  select a.court_id, a.occurrence_date, a.rule_id, b.rule_id
    into v_conflict_court_id, v_conflict_date, v_conflict_rule_a, v_conflict_rule_b
  from pg27b2_candidates a
  join pg27b2_candidates b
    on a.court_id = b.court_id
   and a.occurrence_date = b.occurrence_date
   and a.rule_id < b.rule_id
   and a.start_time < (b.start_time + (b.duration_minutes || ' minutes')::interval)::time
   and b.start_time < (a.start_time + (a.duration_minutes || ' minutes')::interval)::time
  limit 1;

  if v_conflict_court_id is not null then
    raise exception 'court_conflict'
      using detail = format(
        'batch_self_conflict court_id=%s occurrence_date=%s rule_a=%s rule_b=%s',
        v_conflict_court_id, v_conflict_date, v_conflict_rule_a, v_conflict_rule_b
      );
  end if;

  select r.id, c.court_id, c.occurrence_date
    into v_conflict_res_id, v_conflict_court_id, v_conflict_date
  from pg27b2_candidates c
  join public.reservations r
    on r.court_id = c.court_id
   and r.status in ('pending', 'confirmed')
   and tstzrange(r.starts_at, r.ends_at, '[)')
       && tstzrange(
            (c.occurrence_date + c.start_time) at time zone v_tz,
            ((c.occurrence_date + c.start_time) at time zone v_tz) + (c.duration_minutes || ' minutes')::interval,
            '[)'
          )
  limit 1;

  if v_conflict_res_id is not null then
    raise exception 'court_conflict'
      using detail = format(
        'existing_reservation court_id=%s occurrence_date=%s reservation_id=%s',
        v_conflict_court_id, v_conflict_date, v_conflict_res_id
      );
  end if;

  v_session_price_amount_cents := case
    when v_program.enrollment_model = 'per_session' then v_program.price_amount_cents
    else null
  end;

  for v_rec in
    select distinct rule_id, occurrence_date, start_time, duration_minutes, capacity_override
    from pg27b2_candidates
    order by occurrence_date, start_time
  loop
    v_starts_at := (v_rec.occurrence_date + v_rec.start_time) at time zone v_tz;
    v_ends_at   := v_starts_at + (v_rec.duration_minutes || ' minutes')::interval;
    v_capacity  := coalesce(v_rec.capacity_override, v_program.default_capacity);

    if v_program.enrollment_model = 'program' and v_capacity < v_program.default_capacity then
      raise exception 'capacity_override_below_program_capacity';
    end if;

    select count(*) into v_court_count
      from public.program_rule_courts
      where program_schedule_rule_id = v_rec.rule_id;

    v_member_joinable := (v_program.enrollment_model = 'per_session');

    insert into public.events (
      club_id, event_type_id, title, description,
      starts_at, ends_at, capacity, court_count, status, created_by,
      member_joinable, program_id, program_schedule_rule_id,
      program_occurrence_date, is_program_exception,
      price_amount_cents
    ) values (
      v_club_id, v_program.event_type_id, v_program.title, v_program.description,
      v_starts_at, v_ends_at, v_capacity, v_court_count, 'scheduled', v_program.created_by,
      v_member_joinable, v_program.id, v_rec.rule_id,
      v_rec.occurrence_date, false,
      v_session_price_amount_cents
    )
    returning * into v_new_event;

    for v_court_rec in
      select court_id from public.program_rule_courts where program_schedule_rule_id = v_rec.rule_id
    loop
      insert into public.reservations (
        club_id, court_id, owner_user_id,
        starts_at, ends_at, status, reason, event_id, created_by
      ) values (
        v_club_id, v_court_rec.court_id, v_program.created_by,
        v_starts_at, v_ends_at, 'confirmed', 'event', v_new_event.id, v_program.created_by
      );
    end loop;

    if v_program.enrollment_model = 'program' then
      insert into public.event_participants (event_id, profile_id, roster_member_id, role, status)
      select v_new_event.id, rm.claimed_by, pe.roster_member_id, 'participant', 'confirmed'
      from public.program_enrollments pe
      join public.roster_members rm
        on rm.id = pe.roster_member_id
      where pe.program_id = v_program.id
        and pe.status     = 'enrolled'
      order by pe.roster_member_id
      on conflict (event_id, profile_id) do nothing;
    end if;

    v_inserted_ids   := v_inserted_ids || v_new_event.id;
    v_inserted_count := v_inserted_count + 1;
  end loop;

  if v_program.status = 'draft' then
    update public.programs set status = 'active', updated_at = now() where id = v_program.id;
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'generate_program_sessions', 'program', p_program_id,
    jsonb_build_object(
      'inserted_count',   v_inserted_count,
      'skipped_count',    v_total_count - v_new_count,
      'from',             v_from,
      'through',          v_through,
      'event_ids',        to_jsonb(v_inserted_ids),
      'program_owner_id', v_program.created_by,
      'generated_by_id',  auth.uid()
    )
  );

  return query select v_inserted_count, (v_total_count - v_new_count), v_inserted_ids;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- add_program_member — 0137 body + enrollment price snapshot. Only the
-- "else" branch (fresh insert or reactivation of a previously-cancelled
-- row) is touched — the "already enrolled"/"already waitlisted/offered"
-- branches return the existing row unchanged (no-op), which already
-- preserves its snapshot correctly with no code change needed.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.add_program_member(p_program_id uuid, p_profile_id uuid)
 RETURNS program_enrollments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id       uuid;
  v_role          text;
  v_program       public.programs%rowtype;
  v_target_status text;
  v_roster_member_id uuid;
  v_existing      public.program_enrollments%rowtype;
  v_existing_found boolean;
  v_count         int;
  v_new_status    text;
  v_result        public.program_enrollments%rowtype;
  v_no_op         boolean := false;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  if v_role not in ('admin', 'pro', 'staff') then
    raise exception 'insufficient_role';
  end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id
    for update;
  if not found then raise exception 'program_not_found'; end if;

  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_program.enrollment_model <> 'program' then
    raise exception 'program_not_whole_enrollment';
  end if;

  if not public._program_is_enrollable(v_program) then
    raise exception 'program_not_enrollable';
  end if;

  -- Target membership: club_memberships is the sole source of truth here
  -- (unchanged from the pre-0115 body).
  select status into v_target_status
    from public.club_memberships
    where user_id    = p_profile_id
      and club_id    = v_club_id
      and removed_at is null;
  if not found then raise exception 'target_member_not_found'; end if;
  if v_target_status <> 'active' then raise exception 'target_member_inactive'; end if;

  -- Phase 33D2b: resolve the target's durable roster identity, fail
  -- closed — every account holder resolves one by construction (33B1
  -- backfill guarantee), matching admin_add_member's identical guard.
  select id into v_roster_member_id
    from public.roster_members
   where club_id    = v_club_id
     and claimed_by = p_profile_id;
  if not found then
    raise exception 'phase33d2_unresolved_member_identity';
  end if;

  -- Read the target's existing row FIRST, before any other side effect —
  -- required ordering, unchanged from the pre-0115 body. Phase 33D2b
  -- hotfix-in-advance: FOR UPDATE + immediate FOUND capture. Matched via
  -- profile_id OR roster_member_id, so a prior no-account enrollment for
  -- this same target (now claimed) is correctly recognized as the same
  -- durable enrollment.
  select * into v_existing
    from public.program_enrollments
    where program_id = p_program_id
      and (profile_id = p_profile_id or roster_member_id = v_roster_member_id)
    for update;
  v_existing_found := found;

  if v_existing_found and v_existing.status = 'enrolled' then
    -- Idempotent fast path — no expire/advance run, matching join_program's
    -- own identical fast path exactly.
    v_result := v_existing;
    v_no_op  := true;
  elsif v_existing_found and v_existing.status in ('waitlisted', 'offered') then
    -- Returned exactly unchanged — no expire/advance call is made in this
    -- branch (unchanged from the pre-0115 body's own documented rule).
    v_result := v_existing;
    v_no_op  := true;
  else
    perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);
    perform public._advance_program_waitlist_offer(p_program_id, v_club_id, v_program.title);

    select count(*) into v_count
      from public.program_enrollments
      where program_id = p_program_id
        and status     in ('enrolled', 'offered');

    if v_count >= v_program.default_capacity or exists (
      select 1 from public.program_enrollments
      where program_id = p_program_id and status = 'waitlisted'
    ) then
      v_new_status := 'waitlisted';
    else
      v_new_status := 'enrolled';
    end if;

    if v_existing_found then
      update public.program_enrollments
         set status           = v_new_status,
             profile_id       = p_profile_id,
             roster_member_id = v_roster_member_id,
             offer_expires_at = null,
             waitlisted_at    = case when v_new_status = 'waitlisted' then now() else null end,
             -- Phase 34B: reactivating a previously-cancelled enrollment is
             -- a fresh commitment — re-snapshot the program's current price.
             price_amount_cents = v_program.price_amount_cents,
             updated_at       = now()
       where id = v_existing.id
      returning * into v_result;
    else
      insert into public.program_enrollments (program_id, profile_id, roster_member_id, status, waitlisted_at, price_amount_cents)
      values (
        p_program_id, p_profile_id, v_roster_member_id, v_new_status,
        case when v_new_status = 'waitlisted' then now() else null end,
        v_program.price_amount_cents
      )
      returning * into v_result;
    end if;

    if v_result.id is null then
      raise exception 'program_enrollment_write_failed';
    end if;
  end if;

  if v_result.status = 'enrolled' then
    perform public._materialize_program_member_into_future_events(p_program_id, v_roster_member_id, v_club_id);
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'add_program_member', 'program', p_program_id,
    jsonb_build_object(
      'target_profile_id', p_profile_id,
      'roster_member_id',  v_roster_member_id,
      'final_status',      v_result.status,
      'no_op',             v_no_op,
      'actor_role',        v_role
    )
  );

  return v_result;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- add_program_roster_member — 0137 body + identical enrollment price
-- snapshot logic.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.add_program_roster_member(p_program_id uuid, p_expected_club_id uuid, p_roster_member_id uuid)
 RETURNS program_enrollments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id    uuid;
  v_role       text;
  v_program    public.programs%rowtype;
  v_roster     public.roster_members%rowtype;
  v_existing   public.program_enrollments%rowtype;
  v_existing_found boolean;
  v_count      int;
  v_new_status text;
  v_result     public.program_enrollments%rowtype;
  v_no_op      boolean := false;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role not in ('admin', 'pro', 'staff') then raise exception 'insufficient_role'; end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id
    for update;
  if not found then raise exception 'program_not_found'; end if;

  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_program.enrollment_model <> 'program' then
    raise exception 'program_not_whole_enrollment';
  end if;

  if not public._program_is_enrollable(v_program) then
    raise exception 'program_not_enrollable';
  end if;

  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_club_id;
  if not found then raise exception 'roster_member_not_found'; end if;

  select * into v_existing
    from public.program_enrollments
    where program_id = p_program_id
      and (
        roster_member_id = p_roster_member_id
        or (v_roster.claimed_by is not null and profile_id = v_roster.claimed_by)
      )
    for update;
  v_existing_found := found;

  if v_existing_found and v_existing.status = 'enrolled' then
    v_result := v_existing;
    v_no_op  := true;
  elsif v_existing_found and v_existing.status in ('waitlisted', 'offered') then
    v_result := v_existing;
    v_no_op  := true;
  else
    perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);
    perform public._advance_program_waitlist_offer(p_program_id, v_club_id, v_program.title);

    select count(*) into v_count
      from public.program_enrollments
      where program_id = p_program_id
        and status     in ('enrolled', 'offered');

    if v_count >= v_program.default_capacity or exists (
      select 1 from public.program_enrollments
      where program_id = p_program_id and status = 'waitlisted'
    ) then
      v_new_status := 'waitlisted';
    elsif not public._program_candidate_fits_future_sessions(p_program_id, p_roster_member_id) then
      v_new_status := 'waitlisted';
    else
      v_new_status := 'enrolled';
    end if;

    if v_existing_found then
      update public.program_enrollments
         set status           = v_new_status,
             profile_id       = v_roster.claimed_by,
             roster_member_id = p_roster_member_id,
             offer_expires_at = null,
             waitlisted_at    = case when v_new_status = 'waitlisted' then now() else null end,
             -- Phase 34B: reactivating a previously-cancelled enrollment is
             -- a fresh commitment — re-snapshot the program's current price.
             price_amount_cents = v_program.price_amount_cents,
             updated_at       = now()
       where id = v_existing.id
      returning * into v_result;
    else
      insert into public.program_enrollments (program_id, profile_id, roster_member_id, status, waitlisted_at, price_amount_cents)
      values (
        p_program_id, v_roster.claimed_by, p_roster_member_id, v_new_status,
        case when v_new_status = 'waitlisted' then now() else null end,
        v_program.price_amount_cents
      )
      returning * into v_result;
    end if;

    if v_result.id is null then
      raise exception 'program_enrollment_write_failed';
    end if;
  end if;

  if v_result.status = 'enrolled' then
    perform public._materialize_program_member_into_future_events(p_program_id, p_roster_member_id, v_club_id);
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'add_program_roster_member', 'program', p_program_id,
    jsonb_build_object(
      'roster_member_id', p_roster_member_id,
      'member_id',        v_roster.claimed_by,
      'member_claimed',   v_roster.claimed_by is not null,
      'final_status',     v_result.status,
      'no_op',             v_no_op,
      'actor_role',        v_role
    )
  );

  return v_result;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- join_program — verbatim Production body + identical enrollment price
-- snapshot logic. The reachable update/insert branch here is always a
-- fresh or reactivated commitment: the 'enrolled' case returns early
-- unchanged, and 'waitlisted'/'offered' raises already_enrolled, before
-- this point.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.join_program(p_program_id uuid)
 RETURNS program_enrollments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id  uuid;
  v_role     text;
  v_roster_member_id uuid;
  v_program  public.programs%rowtype;
  v_existing public.program_enrollments%rowtype;
  v_existing_found boolean;
  v_count    int;
  v_new_status text;
  v_result   public.program_enrollments%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  -- Phase 34A3: restated as an explicit admin/pro allowlist rather than a
  -- member-exclusion — see this section's header above.
  if v_role not in ('admin', 'pro') and not public.current_club_has_capability('member_self_service') then
    raise exception 'capability_not_available';
  end if;

  v_roster_member_id := public.current_user_roster_member_id();
  if v_roster_member_id is null then raise exception 'phase33d2_unresolved_member_identity'; end if;

  select * into v_program from public.programs
    where id = p_program_id and club_id = v_club_id for update;
  if not found then raise exception 'program_not_found'; end if;
  if v_program.enrollment_model <> 'program' then raise exception 'program_not_whole_enrollment'; end if;
  if not public._program_is_enrollable(v_program) then raise exception 'program_not_enrollable'; end if;

  select * into v_existing from public.program_enrollments
    where program_id = p_program_id and (profile_id = auth.uid() or roster_member_id = v_roster_member_id);
  if found and v_existing.status = 'enrolled' then return v_existing; end if;

  perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);
  perform public._advance_program_waitlist_offer(p_program_id, v_club_id, v_program.title);

  select * into v_existing from public.program_enrollments
    where program_id = p_program_id and (profile_id = auth.uid() or roster_member_id = v_roster_member_id)
    for update;
  v_existing_found := found;

  if v_existing_found and v_existing.status in ('waitlisted', 'offered') then
    raise exception 'already_enrolled';
  end if;

  select count(*) into v_count from public.program_enrollments
    where program_id = p_program_id and status in ('enrolled', 'offered');

  if v_count >= v_program.default_capacity or exists (
    select 1 from public.program_enrollments where program_id = p_program_id and status = 'waitlisted'
  ) then
    v_new_status := 'waitlisted';
  elsif not public._program_candidate_fits_future_sessions(p_program_id, v_roster_member_id) then
    v_new_status := 'waitlisted';
  else
    v_new_status := 'enrolled';
  end if;

  if v_existing_found then
    update public.program_enrollments
       set status = v_new_status, profile_id = auth.uid(), roster_member_id = v_roster_member_id,
           offer_expires_at = null,
           waitlisted_at = case when v_new_status = 'waitlisted' then now() else null end,
           -- Phase 34B: reactivating a previously-cancelled enrollment is a
           -- fresh commitment — re-snapshot the program's current price.
           price_amount_cents = v_program.price_amount_cents,
           updated_at = now()
     where id = v_existing.id
    returning * into v_result;
  else
    insert into public.program_enrollments (program_id, profile_id, roster_member_id, status, waitlisted_at, price_amount_cents)
    values (p_program_id, auth.uid(), v_roster_member_id, v_new_status,
      case when v_new_status = 'waitlisted' then now() else null end,
      v_program.price_amount_cents)
    returning * into v_result;
  end if;

  if v_result.id is null then raise exception 'program_enrollment_write_failed'; end if;

  if v_new_status = 'enrolled' then
    perform public._materialize_program_member_into_future_events(p_program_id, v_roster_member_id, v_club_id);
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (v_club_id, auth.uid(), 'join_program', 'program', p_program_id,
    jsonb_build_object('status', v_result.status, 'actor_role', v_role));

  return v_result;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- update_club_pricing — FINAL PRE-APPLY CORRECTION (Phase 34B).
--
-- CREATE OR REPLACE, same (text, integer) signature as 0139's original —
-- no DROP needed, no overload risk. Reapplies the exact 0139 auth/validation
-- behavior verbatim, adds a fixed search_path (0139's version omitted it —
-- fixed there for the two brand-new functions only, not for any legacy
-- function), and adds the currency-lock guard now that the complete 34B
-- schema exists to check against (0139 alone predates lesson/event/program
-- pricing columns, so the full guard could only be expressed here).
--
-- Locked rule: club_settings.currency is the one club-wide unit every price
-- snapshot is implicitly denominated in. Changing it after a positive
-- (>0) price has ever been configured or recorded would silently
-- reinterpret those existing cents under a different currency without
-- converting them — e.g. a historical $50.00 reservation would render as
-- CAD 50.00 after a USD->CAD switch. NULL (unconfigured) and 0 (Free) never
-- block a change; only a genuine >0 amount does. Switching currency while
-- every price is still NULL/0, or updating the default court rate without
-- changing currency, both remain fully allowed.
--
-- Checked, same-club-scoped, only when p_currency actually differs from
-- the club's current currency:
--   Configuration: club_settings.default_court_hourly_rate_cents,
--     courts.hourly_rate_cents, lesson_types.unit_price_amount_cents
--     (FINAL LESSON PRICING REFINEMENT: lesson_types' configured-money
--     column, previously price_amount_cents),
--     event_types.default_price_amount_cents, events.price_amount_cents,
--     programs.price_amount_cents.
--   Historical snapshots: reservations.hourly_rate_cents,
--     reservations.price_amount_cents, lesson_requests.unit_price_amount_cents
--     OR lesson_requests.price_amount_cents (a Lesson snapshots both its
--     configured unit rate and its calculated total — either being
--     positive locks currency), event_participants.price_amount_cents
--     (joined via event_id -> events.club_id — event_participants has no
--     club_id column of its own), event_guests.price_amount_cents (same
--     join pattern), program_enrollments.price_amount_cents (joined via
--     program_id -> programs.club_id — program_enrollments has no club_id
--     column of its own).
-- No amount is ever rewritten or converted by this function, regardless of
-- outcome — it either lets the plain currency column change through, or it
-- doesn't.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.update_club_pricing(
  p_currency text,
  p_default_court_hourly_rate_cents integer
)
returns club_settings
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_profile  profiles%rowtype;
  v_settings club_settings%rowtype;
  v_currency text;
  v_positive_pricing_exists boolean;
  v_result   club_settings%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  select * into v_settings from club_settings where club_id = v_profile.club_id;

  if p_currency is null or btrim(p_currency) = '' then raise exception 'currency_required'; end if;
  v_currency := upper(btrim(p_currency));
  if v_currency !~ '^[A-Z]{3}$' then raise exception 'invalid_currency'; end if;

  if p_default_court_hourly_rate_cents is not null and p_default_court_hourly_rate_cents < 0 then
    raise exception 'invalid_rate';
  end if;

  if v_currency is distinct from v_settings.currency then
    select exists (
      select 1 from club_settings where club_id = v_profile.club_id and default_court_hourly_rate_cents > 0
      union all
      select 1 from courts where club_id = v_profile.club_id and hourly_rate_cents > 0
      union all
      select 1 from lesson_types where club_id = v_profile.club_id and unit_price_amount_cents > 0
      union all
      select 1 from event_types where club_id = v_profile.club_id and default_price_amount_cents > 0
      union all
      select 1 from events where club_id = v_profile.club_id and price_amount_cents > 0
      union all
      select 1 from programs where club_id = v_profile.club_id and price_amount_cents > 0
      union all
      select 1 from reservations
        where club_id = v_profile.club_id
          and (hourly_rate_cents > 0 or price_amount_cents > 0)
      union all
      select 1 from lesson_requests
        where club_id = v_profile.club_id
          and (unit_price_amount_cents > 0 or price_amount_cents > 0)
      union all
      select 1 from event_participants ep
        join events e on e.id = ep.event_id
        where e.club_id = v_profile.club_id and ep.price_amount_cents > 0
      union all
      select 1 from event_guests eg
        join events e on e.id = eg.event_id
        where e.club_id = v_profile.club_id and eg.price_amount_cents > 0
      union all
      select 1 from program_enrollments pe
        join programs p on p.id = pe.program_id
        where p.club_id = v_profile.club_id and pe.price_amount_cents > 0
    ) into v_positive_pricing_exists;

    if v_positive_pricing_exists then
      raise exception 'currency_locked_by_pricing';
    end if;
  end if;

  update club_settings set
    currency                        = v_currency,
    default_court_hourly_rate_cents = p_default_court_hourly_rate_cents,
    updated_at                      = now()
  where club_id = v_profile.club_id
  returning * into v_result;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'update_club_pricing',
    'club_settings',
    v_result.club_id,
    jsonb_build_object(
      'currency', v_currency,
      'default_court_hourly_rate_cents', p_default_court_hourly_rate_cents
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.update_club_pricing(text, integer) from public, anon;
grant  execute on function public.update_club_pricing(text, integer) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- Drop set_program_price(uuid, integer) (new, safe to drop outright).
-- Restore generate_program_sessions, add_program_member,
-- add_program_roster_member, and join_program by re-querying their live
-- Production definitions immediately before rolling back. Restore
-- update_club_pricing(text, integer) to its 0139 body (drops the
-- currency-lock guard and the search_path fix added by this migration's
-- final correction — reapply both by hand if rolling back 0142 alone while
-- keeping 0139-0141). Drop the new columns/constraints on programs and
-- program_enrollments. create_program and update_program were never
-- touched by this migration. No other function, table, or policy is
-- touched by this migration.
