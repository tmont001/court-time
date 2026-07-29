-- 0094_program_lifecycle.sql
-- Phase 27E: Program Lifecycle and Future-Session Handling.
--
-- Adds four SECURITY DEFINER RPCs completing the programs.status lifecycle
-- that 0087 already declared but never implemented a transition into:
-- cancel_program (active/draft -> cancelled), complete_program
-- (active -> completed), archive_program (cancelled/completed -> archived,
-- using the already-existing programs.archived_at/archived_by columns from
-- 0087), and unarchive_program (the reverse). Does not edit 0087-0093 and
-- is independently reviewable/rollback-able from them. No new table, no
-- schema change — programs.status already allows 'cancelled'/'completed'
-- (0087's own CHECK constraint) and archived_at/archived_by already exist
-- (0087); this migration is the first to actually write those values.
--
-- ─────────────────────────────────────────────────────────────────────────
-- Key design insight, confirmed by direct inspection before writing this
-- migration: no change to any 0087-0093 function is needed to make
-- "cancellation/completion blocks future enrollment and generation" true.
-- join_program and accept_program_waitlist_offer (0091) already gate on
-- _program_is_enrollable, which already returns false for any
-- status <> 'active' (0091). add_program_member (0092) already calls the
-- same helper. generate_program_sessions (0091) already rejects any
-- status not in ('draft', 'active') with program_not_generatable. Simply
-- transitioning programs.status to 'cancelled' or 'completed' here is
-- therefore sufficient on its own — every existing eligibility gate
-- already treats those states as closed. This migration adds no new gate
-- to any existing function and touches no function from 0087-0093.
--
-- Authorization (all four functions): membership-native only
-- (current_user_club_id()/current_user_role()/auth.uid() — never
-- profiles.club_id/role/status/is_lesson_provider), mirroring
-- get_program_roster/add_program_member/remove_program_member (0092)
-- exactly: role checked before the program lookup, admin may act on any
-- same-club program, pro only a program they created, member gets
-- insufficient_role, cross-club/nonexistent program gets
-- program_not_found. Deliberately NOT gated on enrollment_model — unlike
-- the enrollment/roster RPCs, lifecycle applies uniformly to 'program',
-- 'per_session', and 'admin_managed' programs alike (a per_session or
-- admin_managed program still has generated events that need cancelling on
-- program cancellation; it simply never has program_enrollments rows to
-- consider, since those RPCs already prevent that model from ever
-- acquiring any).
--
-- Concurrency: all four acquire the identical
-- `select ... from programs where id = p_program_id for update` lock, at
-- the identical point, that every other Phase 27 program RPC already uses
-- (0091/0092) — so a lifecycle transition and a concurrent
-- join/leave/accept/decline/add/remove/generate call against the same
-- program fully serialize. Whichever commits first is what the other sees:
-- a join that commits before a cancel sees status='active' and proceeds
-- normally (its own materialized rows are then correctly caught by
-- cancel_program's bulk future-event cancellation below); a cancel that
-- commits first flips status, and the concurrent join's own
-- _program_is_enrollable check then correctly rejects it. No advisory lock
-- is introduced. Different programs never block each other.
--
-- Completion model: manual only, via complete_program, deliberately not
-- automatic. Automating this would require either a new CREATE OR REPLACE
-- of generate_program_sessions (touching 0091's function, in spirit if not
-- in the literal file) or a scheduled job/trigger — both a larger surface
-- than "the smallest reliable implementation" calls for. complete_program
-- itself still enforces the eligibility rule (the program's date window
-- has ended, or no scheduled future generated session remains) as a hard
-- guard — an admin/pro cannot complete a program early, they can only
-- formalize a transition that has already become true.
--
-- Cancellation event handling: cancel_program cancels every scheduled,
-- non-archived, future (starts_at >= now()) generated event under the
-- program using the exact same field updates cancel_event itself applies
-- (0063: events.status='cancelled'; reservations in ('pending','confirmed')
-- -> 'cancelled' with cancelled_at/cancelled_by/cancellation_kind='admin';
-- offered event_participants rows -> 'cancelled' with offer_expires_at
-- cleared) — applied set-based across every matching event in one pass
-- rather than one cancel_event call per event. Past events are untouched
-- (starts_at < now() is excluded from the update entirely). program_
-- enrollments is deliberately never touched by cancel_program or
-- complete_program — it remains exactly as it stood at the moment of
-- transition, a historical record of who was enrolled/waitlisted/offered,
-- mirroring cancel_event's own precedent of leaving confirmed/waitlisted
-- event_participants rows untouched (only 'offered' rows are cancelled,
-- there and here).
--
-- Archive/unarchive: no cascading change to schedule rules, enrollments,
-- events, attendance, or audit history — mirrors archive_event/
-- unarchive_event (0060) exactly: a pure timestamp flip, fully reversible,
-- no side effects on any linked row. unarchive_program is implemented
-- (not deferred) because this exact reversible, no-side-effect pattern is
-- already the established, proven-safe convention for archiving in this
-- codebase.
--
-- Stable errors added: program_not_cancellable, program_not_completable,
-- program_not_archivable, already_archived, not_archived (the last two
-- reused verbatim from archive_event/unarchive_event's own vocabulary).
-- not_authenticated, insufficient_role, and program_not_found are reused
-- from the existing Phase 27 vocabulary with no changes.
--
-- No table-level grant change anywhere in this migration — programs,
-- events, reservations, event_participants, and program_enrollments all
-- keep exactly the grants/RLS they already have. No authenticated direct
-- write is added to any of them; every write in this migration happens
-- exclusively inside these four SECURITY DEFINER functions.
--
-- See supabase/scripts/verify_phase27e.sql for the full read-only
-- verification pass, and supabase/scripts/QA_phase27e.md for manual QA
-- steps.
--
-- Apply in Supabase SQL Editor (cloud only). Not applied by this checkpoint.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. cancel_program
-- ═══════════════════════════════════════════════════════════════════════════
-- Error codes: not_authenticated, insufficient_role, program_not_found,
-- program_not_cancellable.

create or replace function public.cancel_program(p_program_id uuid)
returns public.programs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id             uuid;
  v_role                text;
  v_program             public.programs%rowtype;
  v_result              public.programs%rowtype;
  v_cancelled_event_ids uuid[];
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

  -- Only a draft or active program can be cancelled — already-cancelled,
  -- already-completed, and archived programs all raise this same code
  -- (see migration header note on error-code minimalism).
  if v_program.archived_at is not null or v_program.status not in ('draft', 'active') then
    raise exception 'program_not_cancellable';
  end if;

  update public.programs
    set status = 'cancelled', updated_at = now()
    where id = p_program_id
    returning * into v_result;

  -- Bulk-cancel every scheduled, non-archived, future generated event under
  -- this program — same field updates as cancel_event (0063), applied
  -- set-based. Past events (starts_at < now()) are never selected here.
  select array_agg(id) into v_cancelled_event_ids
    from public.events
    where program_id  = p_program_id
      and status       = 'scheduled'
      and archived_at is null
      and starts_at   >= now();

  if v_cancelled_event_ids is not null then
    update public.events
      set status = 'cancelled', updated_at = now()
      where id = any(v_cancelled_event_ids);

    update public.reservations
      set status            = 'cancelled',
          cancelled_at      = now(),
          cancelled_by      = auth.uid(),
          cancellation_kind = 'admin',
          updated_at        = now()
      where event_id = any(v_cancelled_event_ids)
        and status   in ('pending', 'confirmed');

    -- Only 'offered' rows are cancelled, mirroring cancel_event exactly —
    -- confirmed/waitlisted event_participants rows are left as historical
    -- record, matching program_enrollments' own preservation below.
    update public.event_participants
      set status           = 'cancelled',
          offer_expires_at = null,
          updated_at       = now()
      where event_id = any(v_cancelled_event_ids)
        and status   = 'offered';
  end if;
  -- program_enrollments is intentionally never touched here — see
  -- migration header.

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'cancel_program', 'program', p_program_id,
    jsonb_build_object(
      'title',                 v_program.title,
      'previous_status',       v_program.status,
      'cancelled_event_count', coalesce(array_length(v_cancelled_event_ids, 1), 0),
      'actor_role',            v_role
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.cancel_program(uuid) from public, anon;
grant  execute on function public.cancel_program(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. complete_program
-- ═══════════════════════════════════════════════════════════════════════════
-- Manual-only completion (see migration header). Eligible only once the
-- program's date window has ended (club-local "today" past ends_on, same
-- convention as _program_is_enrollable, 0091) or no scheduled future
-- generated session remains — an admin/pro cannot complete a program
-- early. Never touches events, reservations, event_participants, or
-- program_enrollments — completion only formalizes that the program's run
-- is over, it does not clean anything up.
--
-- Error codes: not_authenticated, insufficient_role, program_not_found,
-- program_not_completable.

create or replace function public.complete_program(p_program_id uuid)
returns public.programs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id             uuid;
  v_role                text;
  v_program             public.programs%rowtype;
  v_result              public.programs%rowtype;
  v_tz                  text;
  v_window_ended        boolean;
  v_has_future_sessions boolean;
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

  if v_program.archived_at is not null or v_program.status <> 'active' then
    raise exception 'program_not_completable';
  end if;

  select timezone into v_tz from public.clubs where id = v_club_id;
  v_window_ended := v_program.ends_on < (now() at time zone coalesce(v_tz, 'UTC'))::date;

  select exists (
    select 1 from public.events
    where program_id  = p_program_id
      and status       = 'scheduled'
      and archived_at is null
      and starts_at   >= now()
  ) into v_has_future_sessions;

  if not (v_window_ended or not v_has_future_sessions) then
    raise exception 'program_not_completable';
  end if;

  update public.programs
    set status = 'completed', updated_at = now()
    where id = p_program_id
    returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'complete_program', 'program', p_program_id,
    jsonb_build_object(
      'title',               v_program.title,
      'window_ended',        v_window_ended,
      'had_future_sessions', v_has_future_sessions,
      'actor_role',          v_role
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.complete_program(uuid) from public, anon;
grant  execute on function public.complete_program(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. archive_program
-- ═══════════════════════════════════════════════════════════════════════════
-- Error codes: not_authenticated, insufficient_role, program_not_found,
-- already_archived, program_not_archivable.

create or replace function public.archive_program(p_program_id uuid)
returns public.programs
language plpgsql
security definer
set search_path = public, pg_temp
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

  if v_program.archived_at is not null then
    raise exception 'already_archived';
  end if;

  if v_program.status not in ('cancelled', 'completed') then
    raise exception 'program_not_archivable';
  end if;

  update public.programs
    set archived_at = now(), archived_by = auth.uid(), updated_at = now()
    where id = p_program_id
    returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'archive_program', 'program', p_program_id,
    jsonb_build_object('title', v_program.title, 'status', v_program.status, 'actor_role', v_role)
  );

  return v_result;
end;
$$;

revoke execute on function public.archive_program(uuid) from public, anon;
grant  execute on function public.archive_program(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. unarchive_program
-- ═══════════════════════════════════════════════════════════════════════════
-- Error codes: not_authenticated, insufficient_role, program_not_found,
-- not_archived.

create or replace function public.unarchive_program(p_program_id uuid)
returns public.programs
language plpgsql
security definer
set search_path = public, pg_temp
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

  if v_program.archived_at is null then
    raise exception 'not_archived';
  end if;

  update public.programs
    set archived_at = null, archived_by = null, updated_at = now()
    where id = p_program_id
    returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'unarchive_program', 'program', p_program_id,
    jsonb_build_object('title', v_program.title, 'status', v_program.status, 'actor_role', v_role)
  );

  return v_result;
end;
$$;

revoke execute on function public.unarchive_program(uuid) from public, anon;
grant  execute on function public.unarchive_program(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════════
-- All four functions are new in this migration and depend on nothing this
-- migration itself created (only on already-applied 0087 columns/CHECK
-- vocabulary and 0082's current_user_club_id()/current_user_role()) —
-- dropping them is a clean, complete rollback with no other object
-- depending on them:
--
--   drop function if exists public.unarchive_program(uuid);
--   drop function if exists public.archive_program(uuid);
--   drop function if exists public.complete_program(uuid);
--   drop function if exists public.cancel_program(uuid);
--
-- No schema, grant, or RLS change was made anywhere in this migration, so
-- there is nothing else to reverse. Any programs.status/archived_at value
-- already written by these functions while they existed, and any
-- events/reservations/event_participants row already cancelled by
-- cancel_program, are ordinary data rows unaffected by dropping the
-- functions that produced them.

commit;
