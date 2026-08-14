-- 0116_program_waitlist_lifecycle_correctness.sql
-- Phase 33E1: Program Waitlist Lifecycle Correctness.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- SCOPE
-- ═══════════════════════════════════════════════════════════════════════════
-- Narrowly scoped to the proven Program waitlist lifecycle regression only.
-- Reporting identity parity (get_member_engagement_summary, get_reporting_
-- overview) is explicitly OUT OF SCOPE for this migration — moved to 33E2,
-- where durable Member lifecycle semantics (what "active Member" means for
-- roster_members, which today has no active/archived/removed lifecycle
-- column at all) must be decided FIRST, so a single report never mixes an
-- account-only definition of "Member" (the current active_member_snapshot_
-- count / active_member_count) with a roster-based one (the activity
-- metrics) in the same result. Neither reporting function is touched by
-- this migration.
--
-- Two internal helpers, both still on their original 0091 bodies (confirmed
-- via grep as the only CREATE OR REPLACE for either function across all 115
-- prior migrations; 0115 only ever calls them, never redefines them) select
-- and update program_enrollments through profile_id, which 0115 made
-- nullable. A no-account waitlisted/offered enrollee's profile_id is NULL,
-- so `WHERE profile_id = NULL` matches zero rows — silently. The row never
-- transitions. Confirmed live in production via runtime QA (capacity=1,
-- claimed enrolled + no-account waitlisted, remove claimed -> no-account
-- remained waitlisted instead of promoting).
--
-- This is NOT the 0113/0114 FOUND-lifetime bug class — there is no
-- reactivation branch in either function, no bare FOUND reused after
-- intervening SQL. It is a distinct defect: matching/updating by a column
-- that can legitimately be null. Fixed here by re-keying both functions to
-- the enrollment row's own durable id, the identical template 0113 already
-- proved for advance_waitlist_offer/expire_stale_offers_for_event (Events).
--
-- Also closes the Program waitlist_offer notification gap: _advance_
-- program_waitlist_offer has never inserted a notification (0091
-- explicitly deferred this; still true today for every enrollee, claimed
-- or not). Aligned with the live Events equivalent (advance_waitlist_
-- offer, 0102/0113): when an enrollment transitions to 'offered' and the
-- resolved current account (roster_members.claimed_by) is not null, insert
-- the existing 'waitlist_offer' notification kind (already in notifications.
-- kind's CHECK constraint since 0048) — still unclaimed: the status
-- transition applies regardless, notification is safely skipped, never
-- notifications.user_id = NULL. No new notification kind.
--
-- Notification metadata includes 'triggered_by' (auth.uid()) alongside
-- program_id/offer_expires_at, even though email/SMS dispatch is NOT wired
-- up in this migration — this keeps the notification immediately compatible
-- with the existing get_waitlist_delivery_context (0102, unmodified), which
-- already authorizes cross-user dispatch via metadata->>'triggered_by' (one
-- Member's action promoting a different Member), avoiding an otherwise-
-- unnecessary future migration solely to add this key.
--
-- Digital delivery (threading notification_id through every self-service/
-- staff Program RPC's return contract and adding frontend dispatch calls,
-- mirroring Events' Phase 31C evolution) remains out of scope here — see
-- the implementation report. The notification row itself is immediately
-- visible in-app (NotificationSheet reads any row matching user_id =
-- auth.uid(), no dispatch plumbing required for that).
--
-- No schema change. Both functions are body-only CREATE OR REPLACE — no
-- signature changed, so no DROP FUNCTION is required (every parameter's
-- name and meaning is unchanged, only internal logic changed).
--
-- Apply in Supabase SQL Editor (cloud only). NOT applied by this checkpoint.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- _advance_program_waitlist_offer — CREATE OR REPLACE (same 3-argument
-- signature). Live source: 0091 (untouched since).
-- ═══════════════════════════════════════════════════════════════════════════
-- Fix: FIFO selection and the promotion UPDATE now key off the enrollment
-- row's own durable id (never profile_id, which may be null) — the
-- identical template 0113 already proved for advance_waitlist_offer
-- (Events). A get diagnostics check after the UPDATE guards against ever
-- reporting a promotion that silently affected zero rows.
--
-- Concurrency: unchanged from 0091 — this function still acquires no lock
-- of its own. Every one of its callers (join_program, leave_program,
-- accept_program_waitlist_offer, decline_program_waitlist_offer,
-- add_program_member, remove_program_member, add_program_roster_member,
-- remove_program_roster_member, generate_program_sessions) already
-- acquires `select ... from programs where id = p_program_id for update`
-- as its own first statement before ever calling this helper (0091/0092/
-- 0115) — that pre-existing programs-row lock is what already serializes
-- every concurrent call into this function against the same program; nothing
-- here needs its own additional lock.
--
-- New: inserts the existing 'waitlist_offer' notification kind for the
-- CURRENT resolved account (roster_members.claimed_by), resolved fresh —
-- never the historical/possibly-null profile_id — only after the
-- promotion UPDATE is confirmed to have actually affected the row. Still-
-- unclaimed: skipped, never notifications.user_id = NULL. No preference
-- gate (user_pref_enabled) — matches waitlist_offer's existing "mandatory
-- in-app" treatment in the Events domain exactly. Metadata includes
-- triggered_by (auth.uid()) for future dispatch-authorization compatibility
-- — see migration header.

create or replace function public._advance_program_waitlist_offer(
  p_program_id    uuid,
  p_club_id       uuid,
  p_program_title text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_next_id               uuid;
  v_next_roster_member_id uuid;
  v_current_member_id     uuid;
  v_offer_window_hours    int;
  v_offer_expires_at      timestamptz;
  v_slot_count            int;
  v_capacity              int;
  v_rows_updated          int;
  v_tz                    text;
  v_expires_label         text;
  v_notification_id       uuid;
begin
  -- Idempotency guard: if a non-expired offered row already exists, do nothing.
  if exists (
    select 1 from public.program_enrollments
    where program_id       = p_program_id
      and status           = 'offered'
      and offer_expires_at > now()
  ) then
    return null;
  end if;

  -- Capacity guard: only offer if there is actually a free slot. Offered
  -- rows count the same as enrolled against capacity.
  select count(*) into v_slot_count
    from public.program_enrollments
    where program_id = p_program_id
      and status     in ('enrolled', 'offered');

  select default_capacity into v_capacity from public.programs where id = p_program_id;

  if v_slot_count >= coalesce(v_capacity, 0) then
    return null;
  end if;

  -- Find the oldest waitlisted enrollment (FIFO order by waitlisted_at —
  -- the queue-position timestamp, not created_at; unchanged from 0091).
  -- Phase 33E1: selects the row's own durable id + roster_member_id —
  -- never profile_id, which may be null for a no-account enrollee.
  select id, roster_member_id into v_next_id, v_next_roster_member_id
    from public.program_enrollments
    where program_id = p_program_id
      and status     = 'waitlisted'
    order by waitlisted_at asc, id asc
    limit 1;

  if not found then
    return null;
  end if;

  select waitlist_offer_window_hours into v_offer_window_hours
    from public.club_settings
    where club_id = p_club_id;

  -- Defensive fallback: default 2 hours if settings row is missing.
  if not found then
    v_offer_window_hours := 2;
  end if;

  v_offer_expires_at := now() + (v_offer_window_hours || ' hours')::interval;

  -- Phase 33E1: targets the row by its own id — the fix.
  update public.program_enrollments
    set status           = 'offered',
        offer_expires_at = v_offer_expires_at,
        waitlisted_at    = null,
        updated_at       = now()
    where id = v_next_id;

  -- Phase 33E1: fail closed — never report a successful promotion if the
  -- UPDATE silently affected zero rows.
  get diagnostics v_rows_updated = row_count;
  if v_rows_updated = 0 then
    raise exception 'program_enrollment_write_failed';
  end if;

  -- Phase 33E1: resolve the CURRENT account fresh via roster_members.
  -- claimed_by, only after the promotion is confirmed. Still-unclaimed:
  -- the status transition above already applied; notification is safely
  -- skipped (digital communication for a no-account Member is 33E3
  -- scope).
  select claimed_by into v_current_member_id
    from public.roster_members
   where id = v_next_roster_member_id;

  if v_current_member_id is not null then
    select timezone into v_tz from public.clubs where id = p_club_id;
    v_expires_label := to_char(
      v_offer_expires_at at time zone coalesce(v_tz, 'UTC'),
      'Mon DD "at" HH12:MI AM'
    );

    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      p_club_id,
      v_current_member_id,
      'waitlist_offer',
      'A spot opened in "' || p_program_title || '"! Accept by ' || v_expires_label || '.',
      jsonb_build_object(
        'program_id',        p_program_id,
        'offer_expires_at',  v_offer_expires_at,
        'triggered_by',      auth.uid()
      )
    )
    returning id into v_notification_id;
  end if;

  return v_current_member_id;
end;
$$;

revoke execute on function public._advance_program_waitlist_offer(uuid, uuid, text) from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- _expire_stale_program_offers — CREATE OR REPLACE (same 3-argument
-- signature). Live source: 0091 (untouched since).
-- ═══════════════════════════════════════════════════════════════════════════
-- Fix: per-row expiry now targets the enrollment row's own durable id
-- (never profile_id) — same defect class and same fix shape as the
-- function above. A get diagnostics check guards each per-row UPDATE.
-- audit_log metadata gains roster_member_id alongside the existing
-- profile_id key for a complete audit trail on a no-account expiry.

create or replace function public._expire_stale_program_offers(
  p_program_id    uuid,
  p_club_id       uuid,
  p_program_title text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row           record;
  v_expired_count int := 0;
  v_rows_updated  int;
begin
  -- Phase 33E1: selects the row's own durable id alongside profile_id/
  -- roster_member_id (kept for audit metadata, never used as a mutation key).
  for v_row in
    select id, profile_id, roster_member_id
      from public.program_enrollments
      where program_id        = p_program_id
        and status            = 'offered'
        and offer_expires_at  < now()
  loop
    update public.program_enrollments
      set status           = 'cancelled',
          offer_expires_at = null,
          updated_at       = now()
      where id = v_row.id;

    -- Phase 33E1: fail closed — never silently skip a genuinely stale row.
    get diagnostics v_rows_updated = row_count;
    if v_rows_updated = 0 then
      raise exception 'program_enrollment_write_failed';
    end if;

    insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
    values (
      p_club_id,
      auth.uid(),
      'program_waitlist_offer_expired',
      'program',
      p_program_id,
      jsonb_build_object(
        'profile_id',       v_row.profile_id,
        'roster_member_id', v_row.roster_member_id,
        'program_title',    p_program_title
      )
    );

    v_expired_count := v_expired_count + 1;
  end loop;

  if v_expired_count > 0 then
    perform public._advance_program_waitlist_offer(p_program_id, p_club_id, p_program_title);
  end if;
end;
$$;

revoke execute on function public._expire_stale_program_offers(uuid, uuid, text) from public, anon, authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration is created
-- in this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- Both functions kept their exact pre-0116 signatures and return shapes
-- throughout this migration, so restoration is a direct CREATE OR REPLACE
-- FUNCTION, never a DROP:
--
--   -- re-run the 0091 bodies of _advance_program_waitlist_offer and
--   -- _expire_stale_program_offers verbatim (see
--   -- 0091_whole_program_enrollment.sql).
--
-- No schema was changed by this migration, so there is nothing else to
-- reverse. No notifications row inserted by the corrected _advance_
-- program_waitlist_offer while it existed is affected by rolling back —
-- those are ordinary data rows, unrelated to which function body is
-- currently active.
