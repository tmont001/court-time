-- 0115_program_enrollment_identity.sql
-- Phase 33D2b: Programs (whole-program enrollment) Member Identity Parity.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- SCOPE
-- ═══════════════════════════════════════════════════════════════════════════
-- Extends the durable Member identity model (roster_members.id = permanent
-- club-scoped identity; claimed_by nullable link to an auth account) —
-- already live for Reservations (0108/0110), Lessons (0111/0112), and
-- Events (0113/0114) — into Programs. Scope is deliberately narrow: only
-- enrollment_model = 'program' (whole-program enrollment, backed by the
-- program_enrollments table) needs this work. per_session and admin_managed
-- programs generate ordinary events with no program_enrollments involvement
-- at all — self-service join/leave and staff roster management for those
-- already run entirely through the Events RPCs, already fully correct as of
-- 0113/0114. This migration does not touch generated-event self-service
-- (join_event/leave_event/etc.), programs/program_schedule_rules/
-- program_rule_courts, create_program/update_program/preview_program_sessions,
-- or any of the four lifecycle RPCs (cancel_program/complete_program/
-- archive_program/unarchive_program) — none of them have any per-Member
-- identity logic to correct.
--
-- Locked architecture (restated, unchanged):
--   - roster_members.id = permanent club-scoped Member business identity.
--   - program_enrollments.roster_member_id (new) = durable Member
--     attribution, NOT NULL after a fail-closed backfill. Every
--     program_enrollments row represents a genuine club Member — there is
--     no Guest concept in Programs and this migration does not create one.
--   - program_enrollments.profile_id (existing) = optional, historical,
--     point-in-time compatibility field. Relaxed to nullable. Never
--     rewritten merely because the underlying roster identity is later
--     claimed — only an explicit reactivation (rejoin, staff re-add) may
--     refresh it, exactly mirroring the event_participants precedent.
--
-- Live-definition provenance for every function this migration modifies —
-- confirmed via direct grep across the full migration history (no function
-- below has more than one prior CREATE OR REPLACE beyond what's cited):
--   join_program, leave_program, accept_program_waitlist_offer,
--   decline_program_waitlist_offer, _expire_stale_program_offers (untouched),
--   _advance_program_waitlist_offer (untouched), _program_is_enrollable
--   (untouched)                                    0091_whole_program_enrollment.sql
--   _materialize_program_member_into_future_events  0091, superseded by
--                                                    0113_staff_managed_events_identity.sql
--   generate_program_sessions                       0088→0089→0091, superseded
--                                                    by 0113 (this migration's
--                                                    base is the 0113 body)
--   add_program_member, remove_program_member,
--   get_program_roster                              0092_program_roster_management.sql
--   get_program_eligible_members (untouched)         0093_program_roster_member_lookup.sql
--   current_user_roster_member_id() (reused, not
--     modified)                                      0110_reservation_claim_continuity.sql
--
-- ═══════════════════════════════════════════════════════════════════════════
-- FOUND-lifetime discipline (the exact 0113 bug class — see 0114's own
-- header for the full incident writeup)
-- ═══════════════════════════════════════════════════════════════════════════
-- Every function below with a reactivation branch (UPDATE-vs-INSERT decided
-- by whether an existing row was found) captures FOUND into a stable
-- v_existing_found boolean IMMEDIATELY after its own `SELECT ... FOR UPDATE`
-- — before any later SQL statement (capacity aggregates, _expire_stale_
-- program_offers, _advance_program_waitlist_offer calls, all of which issue
-- their own SELECT/UPDATE/INSERT and would otherwise silently overwrite a
-- bare FOUND) — and uses only that boolean, never a later bare FOUND, to
-- decide the write. Every such function additionally guards its write with
-- a fail-closed `if v_result.id is null then raise exception ...` check
-- before any audit/materialization side effect, carrying 0114's write-
-- safety discipline forward. join_program, add_program_member, and the new
-- add_program_roster_member are the three functions with a genuine
-- reactivation branch (mirroring admin_add_member/join_event/admin_add_
-- roster_participant from 0113/0114). leave_program, remove_program_member,
-- remove_program_roster_member, accept_program_waitlist_offer, decline_
-- program_waitlist_offer, and force_confirm_program_roster_member each only
-- ever UPDATE a row they just located by its own primary key (id) — no
-- branch, no reactivation, no FOUND-lifetime risk at all.
--
-- Why the existing `INSERT ... ON CONFLICT (program_id, profile_id) DO
-- UPDATE` pattern (used throughout the pre-0115 bodies of join_program/
-- add_program_member, safely, because profile_id was the sole non-null
-- uniquely-constrained identity column) can no longer be used: this
-- migration adds a SECOND unique constraint, (program_id, roster_member_id)
-- — an `ON CONFLICT (program_id, profile_id)` clause cannot detect a
-- conflict against that second index (e.g. a pre-claim, staff-added row
-- with profile_id NULL sharing the same roster_member_id as a fresh
-- self-service join attempt), which would raise an unhandled 23505 instead
-- of gracefully reactivating. This is the identical hazard 0113's own
-- migration header documented for event_participants — the fix here is the
-- identical FOR-UPDATE-then-branch replacement, applied for the same
-- reason.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- DROP + CREATE vs CREATE OR REPLACE — exact handling
-- ═══════════════════════════════════════════════════════════════════════════
-- CREATE OR REPLACE FUNCTION cannot change a function's argument types,
-- their count, or — for a RETURNS TABLE function — its output column list;
-- it also cannot rename an argument if doing so would be observable to a
-- caller using named-argument syntax, but for a plain positional call (every
-- caller in this codebase, always) an argument's declared *name* is not
-- part of a function's identity/signature the way its position and type
-- are — however, since both affected internal helpers are genuinely being
-- given a new semantic meaning for their second parameter (a roster_member_id
-- is not merely a renamed profile_id; every caller must change what value it
-- passes), they are handled with an explicit DROP FUNCTION + CREATE FUNCTION
-- pair below, not CREATE OR REPLACE, to make the semantic break impossible
-- to apply partially or silently. Both are internal-only (revoked from
-- public/anon/authenticated in their prior definition) — grants are
-- re-examined and reissued identically after recreation, not assumed:
--   _materialize_program_member_into_future_events(uuid, uuid, uuid) —
--     prior grants: none (fully revoked from public, anon, authenticated in
--     0113). Restored identically after DROP+CREATE below.
--   _cancel_program_member_future_participation(uuid, uuid, uuid) —
--     prior grants: none (fully revoked from public, anon, authenticated in
--     0091). Restored identically after DROP+CREATE below.
-- get_program_roster(uuid) requires DROP + CREATE for a different reason:
-- its RETURNS TABLE output column list gains roster_member_id — adding an
-- output column is one of the specific changes CREATE OR REPLACE FUNCTION
-- is documented to reject outright (confirmed by 0057's own precedent doing
-- the identical thing for get_event_roster). Its INPUT signature, uuid, is
-- unchanged — only PostgreSQL's function *identity* (input types) survives
-- unchanged; its return type does not. Prior grants (0092): revoke from
-- public, anon; grant to authenticated. Restored identically below.
--
-- Ordering within this one transaction: schema changes first (columns must
-- exist before any function body referencing them can be created), then the
-- two internal helpers (DROP+CREATE), then every function that calls them
-- (join_program, leave_program, accept_program_waitlist_offer, add_program_
-- member, remove_program_member, generate_program_sessions, and the four
-- new roster RPCs), then get_program_roster (DROP+CREATE, depends on
-- nothing else here), then the RLS policy widening. Because the entire file
-- runs inside one begin/commit transaction, none of this ordering is
-- required for correctness — PL/pgSQL function bodies are opaque text at
-- CREATE time and are not validated against callee existence until actually
-- invoked, and nothing here is callable by any external session until
-- COMMIT — but the ordering below still follows dependency order for
-- reviewability: by the time any function that CALLS a helper is created,
-- that helper already has its final, correct definition in the same file.
-- There is no transient window, inside or outside this transaction, where a
-- caller could reach an unresolved or half-migrated helper.
--
-- decline_program_waitlist_offer is included below specifically because the
-- prior architecture draft omitted it in error: after a no-account
-- enrollee's account is claimed, they must be able to decline the SAME
-- pre-claim offered enrollment through the ordinary self-service path, not
-- only leave_program/accept_program_waitlist_offer.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- No Guest representation
-- ═══════════════════════════════════════════════════════════════════════════
-- program_enrollments has never had, and does not gain here, any Guest
-- concept — every row is a Member (claimed or not). This migration creates
-- no new table, no new status value, no event_guests-equivalent.
--
-- Apply in Supabase SQL Editor (cloud only). NOT applied by this checkpoint.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- A. SCHEMA — program_enrollments.roster_member_id NOT NULL, profile_id
--    relaxed
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.program_enrollments
  add column if not exists roster_member_id uuid references public.roster_members(id);

comment on column public.program_enrollments.roster_member_id is
  'Phase 33D2b: durable Member attribution — the roster_members.id this '
  'enrollment is/was for, regardless of whether that identity is '
  'authenticated. NOT NULL: every program_enrollments row represents a '
  'real club Member (there is no Guest concept in Programs) — every write '
  'path either resolves one or fails closed, never writes null.';

comment on column public.program_enrollments.profile_id is
  'OPTIONAL, HISTORICAL, POINT-IN-TIME compatibility field — populated at '
  'row creation/reactivation when the roster identity happens to be '
  'claimed. NOT a live reflection of current account state: never '
  'rewritten merely because the underlying roster identity is later '
  'claimed (that would be a history rewrite) — only an explicit '
  'reactivation action (rejoin, staff re-add) may refresh it. To resolve '
  'the CURRENT authenticated account for an enrollment row, read '
  'roster_members.claimed_by via roster_member_id instead.';

-- ── Fail-closed backfill guard ──────────────────────────────────────────────
-- Independently re-derives the exact predicate
-- verify_phase33d2b_preflight.sql checks — this migration does not trust
-- that preflight script alone; it re-proves safety for itself before
-- writing anything.
do $$
declare
  v_unresolved int;
begin
  select count(*) into v_unresolved
    from public.program_enrollments pe
    join public.programs pr on pr.id = pe.program_id
   where pe.profile_id is not null
     and not exists (
       select 1 from public.roster_members rm
        where rm.claimed_by = pe.profile_id
          and rm.club_id    = pr.club_id
     );

  if v_unresolved > 0 then
    raise exception
      'phase33d2b_unresolved_program_enrollment_identities: % program_enrollments row(s) cannot resolve exactly one roster identity via (roster_members.claimed_by = program_enrollments.profile_id AND roster_members.club_id = programs.club_id). Run supabase/scripts/verify_phase33d2b_preflight.sql for per-row detail. Resolve manually (do not fabricate a roster identity), then re-run this migration.',
      v_unresolved;
  end if;
end $$;

update public.program_enrollments pe
   set roster_member_id = rm.id
  from public.roster_members rm, public.programs pr
 where pr.id             = pe.program_id
   and rm.claimed_by      = pe.profile_id
   and rm.club_id          = pr.club_id
   and pe.roster_member_id is null;

-- Guard already proved every row resolves — safe to enforce immediately.
alter table public.program_enrollments
  alter column roster_member_id set not null;

alter table public.program_enrollments
  alter column profile_id drop not null;

-- ── Fail-closed collision guard ─────────────────────────────────────────────
-- Independently re-derives and checks the exact predicate verify_
-- phase33d2b_preflight.sql's query 5 already checks externally — this
-- migration does not trust that preflight script alone, matching every
-- other fail-closed guard in this file's own discipline (see section A's
-- unresolved-identity guard above). Structurally this collision should be
-- unreachable — program_enrollments' pre-existing unique(program_id,
-- profile_id) plus roster_members_club_claimed_by_uniq (one claimed_by per
-- club) together guarantee no two rows for the same program can ever
-- resolve the same roster_member_id — but this guard proves that
-- empirically, immediately after the backfill populated roster_member_id
-- on every row and before the UNIQUE constraint below would otherwise be
-- the first thing to surface the problem (as a raw, less diagnostic
-- constraint-violation error). Never deletes, merges, or fabricates any
-- enrollment or identity — a collision here raises, and the entire
-- migration transaction rolls back for manual investigation.
do $$
declare
  v_collision_groups int;
begin
  select count(*) into v_collision_groups
    from (
      select program_id, roster_member_id
        from public.program_enrollments
       group by program_id, roster_member_id
      having count(*) > 1
    ) c;

  if v_collision_groups > 0 then
    raise exception
      'phase33d2b_program_enrollment_identity_collision: % (program_id, roster_member_id) group(s) would collide after backfill. Run supabase/scripts/verify_phase33d2b_preflight.sql (query 5) for per-group detail. Do not delete, merge, or fabricate any enrollment or identity — investigate manually, then re-run this migration.',
      v_collision_groups;
  end if;
end $$;

-- Second durable uniqueness guard, alongside the existing
-- unique(program_id, profile_id) (retained unchanged below it — NULL
-- profile_id values never collide with each other or with a real one).
-- A plain (non-partial) unique constraint suffices here, unlike
-- event_participants_event_roster_uniq's partial-index shape: because
-- roster_member_id is NOT NULL, every row already satisfies "IS NOT NULL",
-- making a partial predicate vacuous.
alter table public.program_enrollments
  add constraint program_enrollments_roster_member_id_uniq unique (program_id, roster_member_id);

create index program_enrollments_roster_member_id_idx
  on public.program_enrollments (roster_member_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- B. _materialize_program_member_into_future_events — DROP + CREATE
--    (second parameter's semantic meaning changes: p_profile_id ->
--    p_roster_member_id). roster_member_id is now the sole required,
--    authoritative input; the current claimed_by is resolved fresh, only to
--    populate the optional profile_id compatibility column on each written
--    row. Internal-only — grants restored identically to their prior state
--    (none) after recreation.
-- ═══════════════════════════════════════════════════════════════════════════
drop function if exists public._materialize_program_member_into_future_events(uuid, uuid, uuid);

create function public._materialize_program_member_into_future_events(
  p_program_id       uuid,
  p_roster_member_id uuid,
  p_club_id          uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current_member_id uuid;
  v_event    record;
  v_existing public.event_participants%rowtype;
  v_existing_found boolean;
  v_result   public.event_participants%rowtype;
begin
  -- Phase 33D2b: resolve the CURRENT account fresh, only to populate the
  -- optional profile_id column — roster_member_id (the caller's own,
  -- already-validated program_enrollments.roster_member_id) is the sole
  -- authoritative identity driving this materialization. Still-unclaimed:
  -- v_current_member_id stays null, and every write below correctly
  -- carries roster_member_id populated / profile_id null.
  select claimed_by into v_current_member_id
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = p_club_id;

  for v_event in
    select e.id
      from public.events e
     where e.program_id  = p_program_id
       and e.club_id      = p_club_id
       and e.status        = 'scheduled'
       and e.archived_at  is null
       and e.starts_at    >= now()
  loop
    -- Phase 33D2b hotfix-in-advance: capture FOUND immediately — no
    -- intervening SQL statement runs before the branch below reads it,
    -- but the boolean is captured explicitly regardless, matching the
    -- 0114 discipline throughout every reactivation writer in this file.
    select * into v_existing
      from public.event_participants
     where event_id = v_event.id
       and (
         roster_member_id = p_roster_member_id
         or (v_current_member_id is not null and profile_id = v_current_member_id)
       )
     for update;
    v_existing_found := found;

    v_result := null;

    if v_existing_found then
      if v_existing.status <> 'confirmed' then
        update public.event_participants
           set status           = 'confirmed',
               profile_id       = v_current_member_id,
               roster_member_id = p_roster_member_id,
               updated_at       = now()
         where id = v_existing.id
        returning * into v_result;
      else
        v_result := v_existing;
      end if;
    else
      insert into public.event_participants (event_id, profile_id, roster_member_id, role, status)
      values (v_event.id, v_current_member_id, p_roster_member_id, 'participant', 'confirmed')
      returning * into v_result;
    end if;

    if v_result.id is null then
      raise exception 'event_participant_write_failed';
    end if;
  end loop;
end;
$$;

revoke execute on function public._materialize_program_member_into_future_events(uuid, uuid, uuid) from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- C. _cancel_program_member_future_participation — DROP + CREATE (second
--    parameter's semantic meaning changes: p_profile_id -> p_roster_
--    member_id). Now targets event_participants by its own durable
--    roster_member_id rather than profile_id — the more correct match on
--    its own terms, not merely an addition, since every row materialized
--    by section B above (or by generate_program_sessions, section E) always
--    carries roster_member_id. This is what makes pre-claim and post-claim
--    leave/removal hit the identical materialized rows. Internal-only —
--    grants restored identically to their prior state (none).
-- ═══════════════════════════════════════════════════════════════════════════
drop function if exists public._cancel_program_member_future_participation(uuid, uuid, uuid);

create function public._cancel_program_member_future_participation(
  p_program_id       uuid,
  p_roster_member_id uuid,
  p_club_id          uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.event_participants ep
    set status           = 'cancelled',
        offer_expires_at = null,
        updated_at       = now()
  from public.events e
  where ep.event_id          = e.id
    and e.program_id          = p_program_id
    and e.club_id              = p_club_id
    and e.status                = 'scheduled'
    and e.archived_at          is null
    and e.starts_at            >= now()
    and ep.roster_member_id    = p_roster_member_id
    and ep.status               = 'confirmed';
end;
$$;

revoke execute on function public._cancel_program_member_future_participation(uuid, uuid, uuid) from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- D. join_program — CREATE OR REPLACE (same 1-argument signature).
--    Reactivation now uses FOR UPDATE + v_existing_found instead of
--    INSERT ... ON CONFLICT (program_id, profile_id) — see migration
--    header for why. Live source: 0091.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.join_program(p_program_id uuid)
returns public.program_enrollments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

  -- Phase 33D2b: resolve the caller's own durable roster identity once,
  -- fail closed — mirrors join_event's identical guard (0113/0114).
  v_roster_member_id := public.current_user_roster_member_id();
  if v_roster_member_id is null then
    raise exception 'phase33d2_unresolved_member_identity';
  end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id
    for update;
  if not found then raise exception 'program_not_found'; end if;

  if v_program.enrollment_model <> 'program' then
    raise exception 'program_not_whole_enrollment';
  end if;

  if not public._program_is_enrollable(v_program) then
    raise exception 'program_not_enrollable';
  end if;

  -- Idempotent fast path for an already-enrolled member — no state
  -- change, no audit entry, matching the pre-0115 body's own precedent.
  -- Phase 33D2b: matched via profile_id OR roster_member_id, so a claimed
  -- Member whose pre-claim enrollment was staff-added is recognized here
  -- too.
  select * into v_existing
    from public.program_enrollments
    where program_id = p_program_id
      and (profile_id = auth.uid() or roster_member_id = v_roster_member_id);
  if found and v_existing.status = 'enrolled' then
    return v_existing;
  end if;

  perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);
  perform public._advance_program_waitlist_offer(p_program_id, v_club_id, v_program.title);

  -- Re-read after expiry/promotion may have changed this caller's own row.
  -- Phase 33D2b hotfix-in-advance: FOR UPDATE + immediate FOUND capture —
  -- the capacity aggregate below issues its own SELECT INTO and would
  -- otherwise silently overwrite a bare FOUND before the write branch
  -- reads it (the exact 0113 bug class).
  select * into v_existing
    from public.program_enrollments
    where program_id = p_program_id
      and (profile_id = auth.uid() or roster_member_id = v_roster_member_id)
    for update;
  v_existing_found := found;

  if v_existing_found and v_existing.status in ('waitlisted', 'offered') then
    raise exception 'already_enrolled';
  end if;

  select count(*) into v_count
    from public.program_enrollments
    where program_id = p_program_id
      and status     in ('enrolled', 'offered');

  -- Queue-bypass guard: unchanged from the pre-0115 body — a brand-new
  -- caller must never enroll ahead of anyone already waitlisted, even if
  -- raw capacity looks open.
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
           profile_id       = auth.uid(),
           roster_member_id = v_roster_member_id,
           offer_expires_at = null,
           waitlisted_at    = case when v_new_status = 'waitlisted' then now() else null end,
           updated_at       = now()
     where id = v_existing.id
    returning * into v_result;
  else
    insert into public.program_enrollments (program_id, profile_id, roster_member_id, status, waitlisted_at)
    values (
      p_program_id, auth.uid(), v_roster_member_id, v_new_status,
      case when v_new_status = 'waitlisted' then now() else null end
    )
    returning * into v_result;
  end if;

  -- Phase 33D2b hotfix-in-advance: fail closed before any success side
  -- effect or return.
  if v_result.id is null then
    raise exception 'program_enrollment_write_failed';
  end if;

  if v_new_status = 'enrolled' then
    perform public._materialize_program_member_into_future_events(p_program_id, v_roster_member_id, v_club_id);
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'join_program', 'program', p_program_id,
    jsonb_build_object('status', v_result.status, 'actor_role', v_role)
  );

  return v_result;
end;
$$;

revoke execute on function public.join_program(uuid) from public, anon;
grant  execute on function public.join_program(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- E. leave_program — CREATE OR REPLACE (same 1-argument signature). No
--    reactivation branch (single UPDATE by primary key once located) — no
--    FOUND-lifetime risk. Live source: 0091.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.leave_program(p_program_id uuid)
returns public.program_enrollments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_roster_member_id uuid;
  v_program public.programs%rowtype;
  v_old     public.program_enrollments%rowtype;
  v_result  public.program_enrollments%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  v_roster_member_id := public.current_user_roster_member_id();
  if v_roster_member_id is null then
    raise exception 'phase33d2_unresolved_member_identity';
  end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id
    for update;
  if not found then raise exception 'program_not_found'; end if;

  if v_program.enrollment_model <> 'program' then
    raise exception 'program_not_whole_enrollment';
  end if;

  -- Phase 33D2b: matched via profile_id OR the caller's own current
  -- roster identity — a claimed Member whose pre-claim enrollment was
  -- staff-added (profile_id null) is recognized here too.
  select * into v_old
    from public.program_enrollments
    where program_id = p_program_id
      and (profile_id = auth.uid() or roster_member_id = v_roster_member_id)
      and status     in ('enrolled', 'waitlisted', 'offered');
  if not found then raise exception 'enrollment_not_found'; end if;

  update public.program_enrollments
    set status           = 'cancelled',
        offer_expires_at = null,
        waitlisted_at    = null,
        updated_at       = now()
    where id = v_old.id
  returning * into v_result;

  if v_old.status in ('enrolled', 'offered') then
    if v_old.status = 'enrolled' then
      perform public._cancel_program_member_future_participation(p_program_id, v_roster_member_id, v_club_id);
    else
      insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
      values (
        v_club_id, auth.uid(), 'leave_program_offered_spot', 'program', p_program_id,
        jsonb_build_object('program_title', v_program.title)
      );
    end if;

    perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);
    perform public._advance_program_waitlist_offer(p_program_id, v_club_id, v_program.title);
  end if;
  -- v_old.status = 'waitlisted': no capacity was freed, no promotion needed.

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'leave_program', 'program', p_program_id,
    jsonb_build_object('previous_status', v_old.status, 'actor_role', v_role)
  );

  return v_result;
end;
$$;

revoke execute on function public.leave_program(uuid) from public, anon;
grant  execute on function public.leave_program(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- F. accept_program_waitlist_offer — CREATE OR REPLACE (same signature).
--    No reactivation branch. Live source: 0091.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.accept_program_waitlist_offer(p_program_id uuid)
returns public.program_enrollments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_roster_member_id uuid;
  v_program public.programs%rowtype;
  v_my_row  public.program_enrollments%rowtype;
  v_result  public.program_enrollments%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  v_roster_member_id := public.current_user_roster_member_id();
  if v_roster_member_id is null then
    raise exception 'phase33d2_unresolved_member_identity';
  end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id
    for update;
  if not found then raise exception 'program_not_found'; end if;

  if v_program.enrollment_model <> 'program' then
    raise exception 'program_not_whole_enrollment';
  end if;

  if not public._program_is_enrollable(v_program) then
    raise exception 'program_not_enrollable';
  end if;

  -- Phase 33D2b: matched via profile_id OR the caller's own current
  -- roster identity.
  select * into v_my_row
    from public.program_enrollments
    where program_id = p_program_id
      and (profile_id = auth.uid() or roster_member_id = v_roster_member_id)
      and status     = 'offered';
  if not found then raise exception 'offer_not_found'; end if;

  if v_my_row.offer_expires_at <= now() then raise exception 'offer_expired'; end if;

  update public.program_enrollments
    set status           = 'enrolled',
        offer_expires_at = null,
        updated_at       = now()
    where id = v_my_row.id
  returning * into v_result;

  perform public._materialize_program_member_into_future_events(p_program_id, v_roster_member_id, v_club_id);

  -- Defensive cleanup, mirroring the pre-0115 body: the capacity check
  -- inside _advance_program_waitlist_offer prevents a spurious promotion
  -- here since enrolled+offered count is unchanged by an accept.
  perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'accept_program_waitlist_offer', 'program', p_program_id,
    jsonb_build_object('program_title', v_program.title, 'actor_role', v_role)
  );

  return v_result;
end;
$$;

revoke execute on function public.accept_program_waitlist_offer(uuid) from public, anon;
grant  execute on function public.accept_program_waitlist_offer(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- G. decline_program_waitlist_offer — CREATE OR REPLACE (same signature).
--    Correction: the prior architecture draft omitted this function in
--    error. After a no-account enrollee's account is claimed, they must be
--    able to decline the SAME pre-claim offered enrollment — the identical
--    durable-self lookup principle as leave_program/accept_program_
--    waitlist_offer, applied here too. No reactivation branch. Live
--    source: 0091.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.decline_program_waitlist_offer(p_program_id uuid)
returns public.program_enrollments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_roster_member_id uuid;
  v_program public.programs%rowtype;
  v_my_row  public.program_enrollments%rowtype;
  v_result  public.program_enrollments%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  v_roster_member_id := public.current_user_roster_member_id();
  if v_roster_member_id is null then
    raise exception 'phase33d2_unresolved_member_identity';
  end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id
    for update;
  if not found then raise exception 'program_not_found'; end if;

  if v_program.enrollment_model <> 'program' then
    raise exception 'program_not_whole_enrollment';
  end if;

  -- Declining an already-expired offer is valid cleanup, matching the
  -- pre-0115 body — the status filter alone (not offer_expires_at) gates
  -- eligibility here. Phase 33D2b: matched via profile_id OR the caller's
  -- own current roster identity.
  select * into v_my_row
    from public.program_enrollments
    where program_id = p_program_id
      and (profile_id = auth.uid() or roster_member_id = v_roster_member_id)
      and status     = 'offered';
  if not found then raise exception 'offer_not_found'; end if;

  update public.program_enrollments
    set status           = 'cancelled',
        offer_expires_at = null,
        waitlisted_at    = null,
        updated_at       = now()
    where id = v_my_row.id
  returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'decline_program_waitlist_offer', 'program', p_program_id,
    jsonb_build_object('program_title', v_program.title, 'actor_role', v_role)
  );

  perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);
  perform public._advance_program_waitlist_offer(p_program_id, v_club_id, v_program.title);

  return v_result;
end;
$$;

revoke execute on function public.decline_program_waitlist_offer(uuid) from public, anon;
grant  execute on function public.decline_program_waitlist_offer(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- H. add_program_member — CREATE OR REPLACE. External profile-based
--    signature preserved exactly for deployed compatibility. Internally
--    resolves the target's same-club roster_member_id and becomes the
--    reactivation writer this function always needed. Live source: 0092.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.add_program_member(
  p_program_id uuid,
  p_profile_id uuid
)
returns public.program_enrollments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

  if v_role not in ('admin', 'pro') then
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
             updated_at       = now()
       where id = v_existing.id
      returning * into v_result;
    else
      insert into public.program_enrollments (program_id, profile_id, roster_member_id, status, waitlisted_at)
      values (
        p_program_id, p_profile_id, v_roster_member_id, v_new_status,
        case when v_new_status = 'waitlisted' then now() else null end
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
$$;

revoke execute on function public.add_program_member(uuid, uuid) from public, anon;
grant  execute on function public.add_program_member(uuid, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- I. remove_program_member — CREATE OR REPLACE. External profile-based
--    signature preserved. Cancellation propagation now uses the target's
--    own row's durable roster_member_id. Live source: 0092.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.remove_program_member(
  p_program_id uuid,
  p_profile_id uuid
)
returns public.program_enrollments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_program public.programs%rowtype;
  v_roster_member_id uuid;
  v_old     public.program_enrollments%rowtype;
  v_result  public.program_enrollments%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  if v_role not in ('admin', 'pro') then
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

  -- Phase 33D2b: resolve the target's roster identity for matching below.
  -- Deliberately NOT fail-closed here — unchanged from the pre-0115 body's
  -- own precedent of placing no membership-eligibility gate on removal
  -- (0092 header): a target whose account/roster identity has since
  -- become unresolvable for any reason must still be removable from a
  -- program roster they are still enrolled in.
  select id into v_roster_member_id
    from public.roster_members
   where club_id    = v_club_id
     and claimed_by = p_profile_id;

  select * into v_old
    from public.program_enrollments
    where program_id = p_program_id
      and (
        profile_id = p_profile_id
        or (v_roster_member_id is not null and roster_member_id = v_roster_member_id)
      )
      and status in ('enrolled', 'waitlisted', 'offered');
  if not found then raise exception 'enrollment_not_found'; end if;

  update public.program_enrollments
    set status           = 'cancelled',
        offer_expires_at = null,
        waitlisted_at    = null,
        updated_at       = now()
    where id = v_old.id
  returning * into v_result;

  if v_old.status = 'enrolled' then
    -- Phase 33D2b: propagate by the row's own durable roster_member_id
    -- (guaranteed NOT NULL), not the separately-resolved variable above —
    -- strictly more correct/durable.
    perform public._cancel_program_member_future_participation(p_program_id, v_old.roster_member_id, v_club_id);
  end if;

  if v_old.status in ('enrolled', 'offered') then
    perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);
    perform public._advance_program_waitlist_offer(p_program_id, v_club_id, v_program.title);
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'remove_program_member', 'program', p_program_id,
    jsonb_build_object(
      'target_profile_id', p_profile_id,
      'previous_status',   v_old.status,
      'actor_role',        v_role
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.remove_program_member(uuid, uuid) from public, anon;
grant  execute on function public.remove_program_member(uuid, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- J. add_program_roster_member — NEW. Staff-initiated equivalent of
--    add_program_member, targeting a roster identity (claimed or
--    no-account) instead of a profiles.id. Mirrors add_program_member's
--    exact logic and no-op/audit rules.
-- ═══════════════════════════════════════════════════════════════════════════
create function public.add_program_roster_member(
  p_program_id       uuid,
  p_expected_club_id uuid,
  p_roster_member_id uuid
)
returns public.program_enrollments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  if v_role not in ('admin', 'pro') then raise exception 'insufficient_role'; end if;

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
             updated_at       = now()
       where id = v_existing.id
      returning * into v_result;
    else
      insert into public.program_enrollments (program_id, profile_id, roster_member_id, status, waitlisted_at)
      values (
        p_program_id, v_roster.claimed_by, p_roster_member_id, v_new_status,
        case when v_new_status = 'waitlisted' then now() else null end
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
$$;

revoke execute on function public.add_program_roster_member(uuid, uuid, uuid) from public, anon;
grant  execute on function public.add_program_roster_member(uuid, uuid, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- K. remove_program_roster_member — NEW. Staff-initiated equivalent of
--    remove_program_member, targeting a roster identity directly (works
--    regardless of claim status).
-- ═══════════════════════════════════════════════════════════════════════════
create function public.remove_program_roster_member(
  p_program_id       uuid,
  p_expected_club_id uuid,
  p_roster_member_id uuid
)
returns public.program_enrollments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_program public.programs%rowtype;
  v_old     public.program_enrollments%rowtype;
  v_result  public.program_enrollments%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role not in ('admin', 'pro') then raise exception 'insufficient_role'; end if;

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

  select * into v_old
    from public.program_enrollments
    where program_id       = p_program_id
      and roster_member_id = p_roster_member_id
      and status            in ('enrolled', 'waitlisted', 'offered');
  if not found then raise exception 'enrollment_not_found'; end if;

  update public.program_enrollments
    set status           = 'cancelled',
        offer_expires_at = null,
        waitlisted_at    = null,
        updated_at       = now()
    where id = v_old.id
  returning * into v_result;

  if v_old.status = 'enrolled' then
    perform public._cancel_program_member_future_participation(p_program_id, p_roster_member_id, v_club_id);
  end if;

  if v_old.status in ('enrolled', 'offered') then
    perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);
    perform public._advance_program_waitlist_offer(p_program_id, v_club_id, v_program.title);
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'remove_program_roster_member', 'program', p_program_id,
    jsonb_build_object(
      'roster_member_id', p_roster_member_id,
      'previous_status',  v_old.status,
      'actor_role',       v_role
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.remove_program_roster_member(uuid, uuid, uuid) from public, anon;
grant  execute on function public.remove_program_roster_member(uuid, uuid, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- L. force_confirm_program_roster_member — NEW capability. Closes the
--    genuine staff-managed lifecycle gap: a no-account enrollee can be
--    legitimately waitlisted -> offered, but has no session to call
--    accept_program_waitlist_offer, and add_program_member/add_program_
--    roster_member deliberately no-op on an already-offered target (to
--    avoid silently disturbing an in-flight offer). Without this, an
--    offered no-account enrollment could only ever time out via
--    _expire_stale_program_offers, cycling to the next waitlisted person
--    with no way for staff to actually seat them. Reuses the existing
--    enrolled/waitlisted/offered/cancelled vocabulary — no new state.
--    Because this capability does not exist today for ANY enrollee
--    (claimed or not — add_program_member was never a force-confirm), one
--    roster-identity-keyed RPC covers both; there is no prior profile-
--    based version to preserve compatibility with.
-- ═══════════════════════════════════════════════════════════════════════════
create function public.force_confirm_program_roster_member(
  p_program_id       uuid,
  p_expected_club_id uuid,
  p_roster_member_id uuid
)
returns public.program_enrollments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id      uuid;
  v_role         text;
  v_program      public.programs%rowtype;
  v_old          public.program_enrollments%rowtype;
  v_result       public.program_enrollments%rowtype;
  v_occupied     int;
  v_was_over_cap boolean;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role not in ('admin', 'pro') then raise exception 'insufficient_role'; end if;

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

  select * into v_old
    from public.program_enrollments
    where program_id       = p_program_id
      and roster_member_id = p_roster_member_id
      and status            in ('waitlisted', 'offered');
  if not found then raise exception 'enrollment_not_found'; end if;

  select count(*) into v_occupied
    from public.program_enrollments
    where program_id = p_program_id
      and status     in ('enrolled', 'offered');
  v_was_over_cap := v_occupied >= v_program.default_capacity;

  update public.program_enrollments
    set status           = 'enrolled',
        offer_expires_at = null,
        waitlisted_at    = null,
        updated_at       = now()
    where id = v_old.id
  returning * into v_result;

  if v_result.id is null then
    raise exception 'program_enrollment_write_failed';
  end if;

  perform public._materialize_program_member_into_future_events(p_program_id, p_roster_member_id, v_club_id);

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'force_confirm_program_roster_member', 'program', p_program_id,
    jsonb_build_object(
      'roster_member_id',  p_roster_member_id,
      'previous_status',   v_old.status,
      'was_over_capacity', v_was_over_cap
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.force_confirm_program_roster_member(uuid, uuid, uuid) from public, anon;
grant  execute on function public.force_confirm_program_roster_member(uuid, uuid, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- M. get_program_eligible_roster_members — NEW read-only RPC. Deliberately
--    NOT a broadening of get_roster_members() (hard admin-only) — mirrors
--    get_program_eligible_members's (0093) own authorization shape exactly
--    (admin any same-club program, pro only their own), so a pro managing
--    their own program's roster can use this too.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.get_program_eligible_roster_members(p_program_id uuid)
returns table (
  roster_member_id uuid,
  first_name       text,
  last_name        text,
  display_name     text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_program public.programs%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  if v_role not in ('admin', 'pro') then
    raise exception 'insufficient_role';
  end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id;
  if not found then raise exception 'program_not_found'; end if;

  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_program.enrollment_model <> 'program' then
    raise exception 'program_not_whole_enrollment';
  end if;

  return query
    select
      rm.id,
      rm.first_name,
      rm.last_name,
      coalesce(nullif(trim(concat_ws(' ', rm.first_name, rm.last_name)), ''), 'Unknown')::text as display_name
    from public.roster_members rm
    where rm.club_id    = v_club_id
      and rm.claimed_by is null
      and not exists (
        select 1 from public.program_enrollments pe
        where pe.program_id       = p_program_id
          and pe.roster_member_id = rm.id
          and pe.status           in ('enrolled', 'offered', 'waitlisted')
      )
    order by rm.last_name asc nulls last, rm.first_name asc nulls last, rm.id asc;
end;
$$;

revoke execute on function public.get_program_eligible_roster_members(uuid) from public, anon;
grant  execute on function public.get_program_eligible_roster_members(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- N. generate_program_sessions — CREATE OR REPLACE (same 3-argument
--    signature). Only the whole-program materialization block changes:
--    sources roster_member_id (now NOT NULL — structurally guaranteed
--    present) instead of profile_id, resolving claimed_by fresh via join
--    for the profile_id column. The prior fail-closed pre-check
--    (v_unresolved_members) is removed — it is now structurally
--    unreachable given the NOT NULL constraint, and its old predicate
--    (matching by profile_id) would be actively WRONG post-migration,
--    since it would treat a legitimate no-account enrolled row (profile_id
--    null) as "unresolved". Every other line is unchanged from the live
--    0113 body — same locking, same validation, same batch/conflict
--    checks, same event/reservation insert shape, same audit shape. Live
--    source: 0088→0089→0091, superseded by 0113.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.generate_program_sessions(
  p_program_id    uuid,
  p_from_date     date default null,
  p_through_date  date default null
)
returns table (
  inserted_count int,
  skipped_count  int,
  event_ids      uuid[]
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role not in ('admin', 'pro') then raise exception 'insufficient_role'; end if;

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

  for v_rec in
    select distinct rule_id, occurrence_date, start_time, duration_minutes, capacity_override
    from pg27b2_candidates
    order by occurrence_date, start_time
  loop
    v_starts_at := (v_rec.occurrence_date + v_rec.start_time) at time zone v_tz;
    v_ends_at   := v_starts_at + (v_rec.duration_minutes || ' minutes')::interval;
    v_capacity  := coalesce(v_rec.capacity_override, v_program.default_capacity);

    select count(*) into v_court_count
      from public.program_rule_courts
      where program_schedule_rule_id = v_rec.rule_id;

    v_member_joinable := (v_program.enrollment_model = 'per_session');

    insert into public.events (
      club_id, event_type_id, title, description,
      starts_at, ends_at, capacity, court_count, status, created_by,
      member_joinable, program_id, program_schedule_rule_id,
      program_occurrence_date, is_program_exception
    ) values (
      v_club_id, v_program.event_type_id, v_program.title, v_program.description,
      v_starts_at, v_ends_at, v_capacity, v_court_count, 'scheduled', v_program.created_by,
      v_member_joinable, v_program.id, v_rec.rule_id,
      v_rec.occurrence_date, false
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

    -- Phase 33D2b: sources roster_member_id (NOT NULL — structurally
    -- guaranteed present for every 'enrolled' row) as the authoritative
    -- identity, resolving claimed_by fresh via join for the profile_id
    -- column. Safe exemption from the FOR-UPDATE-then-branch pattern is
    -- unchanged from the 0113 reasoning: this insert only ever targets an
    -- events row this same function just created in the same transaction,
    -- which cannot already have any event_participants row.
    if v_program.enrollment_model = 'program' then
      insert into public.event_participants (event_id, profile_id, roster_member_id, role, status)
      select v_new_event.id, rm.claimed_by, pe.roster_member_id, 'participant', 'confirmed'
      from public.program_enrollments pe
      join public.roster_members rm
        on rm.id = pe.roster_member_id
      where pe.program_id = v_program.id
        and pe.status     = 'enrolled'
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
$$;

revoke execute on function public.generate_program_sessions(uuid, date, date) from public, anon;
grant  execute on function public.generate_program_sessions(uuid, date, date) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- O. get_program_roster — DROP + CREATE (RETURNS TABLE output column list
--    gains roster_member_id — CREATE OR REPLACE cannot add an output
--    column, matching the exact 0057 precedent for get_event_roster).
--    Input signature (uuid) is unchanged. Display name falls back to
--    roster_members when profile_id is null. Live source: 0092.
-- ═══════════════════════════════════════════════════════════════════════════
drop function if exists public.get_program_roster(uuid);

create function public.get_program_roster(p_program_id uuid)
returns table (
  enrollment_id     uuid,
  program_id        uuid,
  profile_id        uuid,
  roster_member_id  uuid,
  first_name        text,
  last_name         text,
  email             text,
  status            text,
  waitlisted_at     timestamptz,
  offer_expires_at  timestamptz,
  created_at        timestamptz,
  updated_at        timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_program public.programs%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  if v_role not in ('admin', 'pro') then
    raise exception 'insufficient_role';
  end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id;
  if not found then raise exception 'program_not_found'; end if;

  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_program.enrollment_model <> 'program' then
    raise exception 'program_not_whole_enrollment';
  end if;

  return query
    select
      pe.id,
      pe.program_id,
      pe.profile_id,
      pe.roster_member_id,
      coalesce(p.first_name, rm.first_name),
      coalesce(p.last_name, rm.last_name),
      case when v_role = 'admin' then u.email::text else null end,
      pe.status,
      pe.waitlisted_at,
      pe.offer_expires_at,
      pe.created_at,
      pe.updated_at
    from public.program_enrollments pe
    left join public.profiles p on p.id = pe.profile_id
    left join public.roster_members rm on rm.id = pe.roster_member_id
    left join auth.users u on u.id = pe.profile_id
    where pe.program_id = p_program_id
    order by
      case pe.status
        when 'enrolled'   then 1
        when 'offered'    then 2
        when 'waitlisted' then 3
        when 'cancelled'  then 4
      end,
      case when pe.status = 'waitlisted' then pe.waitlisted_at else pe.created_at end asc,
      pe.id asc;
end;
$$;

revoke execute on function public.get_program_roster(uuid) from public, anon;
grant  execute on function public.get_program_roster(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- P. RLS — claim continuity for the member-facing SELECT policy
-- ═══════════════════════════════════════════════════════════════════════════
-- Widened from profile_id = auth.uid() to also recognize the caller's own
-- current roster identity — current_user_roster_member_id() (0110) already
-- scopes to the caller's own active club, and the outer exists() clause
-- already constrains pr.club_id = current_user_club_id(), so a roster
-- identity from a different club can never match a program row already
-- filtered to the caller's own club. No cross-club exposure introduced.
-- Admin/pro branches unchanged.
drop policy if exists "program_enrollments_select" on public.program_enrollments;

create policy "program_enrollments_select"
  on public.program_enrollments for select
  using (
    exists (
      select 1 from public.programs pr
      where pr.id = program_enrollments.program_id
        and pr.club_id = public.current_user_club_id()
        and (
          program_enrollments.profile_id = auth.uid()
          or program_enrollments.roster_member_id = public.current_user_roster_member_id()
          or public.current_user_role() = 'admin'
          or (public.current_user_role() = 'pro' and pr.created_by = auth.uid())
        )
    )
  );

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration is created
-- in this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Drop the four new RPCs (no other object depends on them):
--    `drop function if exists public.get_program_eligible_roster_members(uuid);`
--    `drop function if exists public.force_confirm_program_roster_member(uuid, uuid, uuid);`
--    `drop function if exists public.remove_program_roster_member(uuid, uuid, uuid);`
--    `drop function if exists public.add_program_roster_member(uuid, uuid, uuid);`
--
-- 2. Restore join_program, leave_program, accept_program_waitlist_offer,
--    decline_program_waitlist_offer, add_program_member, remove_program_
--    member, and generate_program_sessions to their pre-0115 bodies (see
--    the "Live-definition provenance" list in this migration's header for
--    each one's exact source migration) via CREATE OR REPLACE FUNCTION —
--    every one of these kept its exact pre-0115 signature throughout this
--    migration, so every restoration is a direct CREATE OR REPLACE, never
--    a DROP.
--
-- 3. Restore the two internal helpers and get_program_roster to their
--    pre-0115 definitions via DROP FUNCTION + CREATE FUNCTION (their
--    signatures changed in this migration, so a plain CREATE OR REPLACE
--    cannot restore them either):
--    `drop function if exists public._materialize_program_member_into_future_events(uuid, uuid, uuid);`
--    -- re-run the 0113 body (see 0113_staff_managed_events_identity.sql, section G's first function) verbatim.
--    `drop function if exists public._cancel_program_member_future_participation(uuid, uuid, uuid);`
--    -- re-run the 0091 body verbatim.
--    `drop function if exists public.get_program_roster(uuid);`
--    -- re-run the 0092 body verbatim.
--
-- 4. Restore the pre-0115 RLS policy:
--    `drop policy if exists "program_enrollments_select" on public.program_enrollments;`
--    -- re-run the 0087 policy body verbatim.
--
-- 5. Only after steps 1-4, relax the schema if the rollback requires it:
--    `alter table public.program_enrollments drop constraint if exists program_enrollments_roster_member_id_uniq;`
--    `drop index if exists public.program_enrollments_roster_member_id_idx;`
--    `alter table public.program_enrollments alter column roster_member_id drop not null;`
--    and, if truly required: `update public.program_enrollments set roster_member_id = null;`
--
-- 6. profile_id cannot safely return to NOT NULL once any legitimate
--    no-account enrollment exists: `alter table public.program_enrollments
--    alter column profile_id set not null;` will FAIL if any row has a
--    null profile_id — expected and correct, matching every prior Phase 33
--    precedent. Do not force it through by deleting rows or inventing a
--    profile_id.
--
-- 7. Drop the new column only when safe — i.e., only after step 5 (or
--    after confirming no row still depends on it) and only if step 6's
--    NOT NULL restoration is not itself being abandoned for the reason
--    above: `alter table public.program_enrollments drop column if exists roster_member_id;`
