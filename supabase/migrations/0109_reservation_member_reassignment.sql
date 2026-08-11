-- 0109_reservation_member_reassignment.sql
-- Phase 33C2 completion: Admin Reservation Edit — Member Reassignment
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- 33C2 gave staff the ability to CREATE a member_booking reservation for any
-- roster Member (claimed or unclaimed) via admin_create_member_reservation
-- (0108). Manual testing found admin EDIT had no equivalent — update_
-- member_reservation (0097, untouched by 0108) has no way to change which
-- Member a reservation belongs to. This migration closes that gap by
-- extending update_member_reservation only. 0108 itself — its schema,
-- trigger, create_reservation, and admin_create_member_reservation — is
-- NOT modified by this migration.
--
-- Locked architecture, unchanged (restated for this RPC specifically):
--   - roster_member_id remains the durable, permanent Member identity for
--     reason='member_booking' — reassignment changes it to a DIFFERENT
--     permanent identity, it never becomes null and the reservation row/id
--     is never replaced (one UPDATE, exactly as before this migration).
--   - owner_user_id is derived SERVER-SIDE from the newly selected roster
--     row's own claimed_by column — never accepted as a client parameter,
--     matching admin_create_member_reservation's existing precedent
--     exactly. It may become NULL (reassigning to an unclaimed Member) or
--     become non-null (reassigning to a claimed Member).
--   - created_by is NOT in this function's UPDATE SET list, before or
--     after this migration — reassignment never rewrites who originally
--     created the reservation.
--   - 0108's reservations_member_booking_identity_guard trigger is not
--     touched, not bypassed, and remains the final structural safety net:
--     it independently re-validates roster_member_id/owner_user_id/club_id
--     consistency on every UPDATE OF those columns, which this migration's
--     SET list now always includes (see body comments for why that trigger
--     firing on every edit — even a no-reassignment one — is correct and
--     was already true in spirit for 0108's own design).
--
-- ═══════════════════════════════════════════════════════════════════════════
-- NARROW NOTIFICATION INVESTIGATION (done before writing this migration,
-- scope limited to update_member_reservation only, per instruction)
-- ═══════════════════════════════════════════════════════════════════════════
-- Current (0097, unmodified since) behavior: when v_scheduling_changed
-- (court/starts_at/ends_at actually changed), the function unconditionally
-- inserts a 'reservation_rescheduled' notification addressed to
-- v_before.owner_user_id — never gated by user_pref_enabled, never checked
-- for null. This was safe before reassignment existed: owner_user_id could
-- never be reassigned, so v_before.owner_user_id and v_after.owner_user_id
-- were always the same value, and always non-null (0108 predates this
-- migration but a reservation's owner never changed mid-edit until now).
--
-- Two real risks once reassignment exists, both fixed below:
--   1. WRONG RECIPIENT — if a scheduling change and a Member reassignment
--      happen in the same edit call, addressing the notification to
--      v_before.owner_user_id would notify the OLD Member about a booking
--      that is no longer theirs, and the NEW Member (who the booking now
--      actually belongs to) would never be told their court/time changed.
--      Fixed: address the notification to v_after.owner_user_id instead.
--      For every case that is NOT a same-call reassignment, v_after.
--      owner_user_id equals v_before.owner_user_id exactly as before, so
--      this is a no-op change in behavior for the common case.
--   2. NOT-NULL VIOLATION — notifications.user_id is NOT NULL
--      (0009_notifications.sql). If a reassignment (with or without a
--      simultaneous scheduling change) results in v_after.owner_user_id
--      being NULL (reassigned to an unclaimed Member), inserting a
--      notification would either error outright or (if guarded
--      incorrectly) silently address nobody. Fixed: the notification
--      insert now requires v_after.owner_user_id IS NOT NULL in addition
--      to v_scheduling_changed — no notification fires for a no-account
--      Member, matching the established, already-approved principle that
--      communications for no-account Members do not exist yet (deferred
--      to a future checkpoint), not a new rule invented here.
--
-- Explicitly NOT changed: no new notification kind, no new notification
-- path for a reassignment-only edit (no scheduling change) — reassignment
-- alone still triggers no notification at all, exactly matching the
-- existing "only scheduling changes notify" rule. This migration fixes who
-- an existing notification is correctly addressed to; it does not invent a
-- new communications rule, per instruction.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- SCOPE
-- ═══════════════════════════════════════════════════════════════════════════
-- update_member_reservation only. No change to: 0108 (schema, trigger,
-- create_reservation, admin_create_member_reservation), cancel_member_
-- reservation, admin_cancel_reservation, RLS policies, any event/
-- maintenance/lesson/program RPC, My Schedule, reporting, or any
-- communications path beyond the narrow notification-recipient fix above.
--
-- No preflight script accompanies this migration: it makes no assumption
-- about existing data (no backfill, no data-dependent guard, no ALTER
-- TABLE) — it is a pure function addition. A post-migration verification
-- script is provided instead (supabase/scripts/verify_phase33c2b.sql).
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EXPAND, NOT CONTRACT — production deployment compatibility
-- ═══════════════════════════════════════════════════════════════════════════
-- An earlier draft of this migration DROPped the existing 10-argument
-- update_member_reservation before creating the new 11-argument signature.
-- That is unsafe to apply ahead of a coordinated app deploy: the currently
-- deployed production/Vercel application still calls the 10-argument RPC
-- (updateMemberReservationAdmin, pre-33C2-completion build) — dropping it
-- first would break production reservation editing for every request made
-- between this migration's apply time and the new frontend build actually
-- going live.
--
-- Corrected to Court Time's established expand → deploy → contract
-- discipline (the same pattern used for reservations_cancel_own across
-- 0097/0098 — see 0097's own header comment): this migration is EXPAND
-- ONLY. It ADDS the new 11-argument overload (with p_roster_member_id)
-- alongside the existing, untouched 10-argument function — Postgres treats
-- a function with a different argument list as a distinct overload, not a
-- replacement, as long as the old one is never dropped. The legacy
-- 10-argument update_member_reservation is not modified, not dropped, and
-- keeps working exactly as it does today for however long the currently
-- deployed frontend keeps calling it.
--
-- After this migration is applied, exactly TWO update_member_reservation
-- overloads coexist in production:
--   • the legacy 10-argument version (0097's body, byte-for-byte, still
--     reachable by the currently deployed app);
--   • the new 11-argument version (this migration, reachable once the new
--     frontend build — which now always sends p_roster_member_id — is
--     deployed).
--
-- Removing the legacy 10-argument overload is explicitly DEFERRED to a
-- later CONTRACT migration, and only after all three of:
--   1. the new application code (this checkpoint's frontend changes) is
--      deployed to production;
--   2. the production admin edit flow has been verified working end to end
--      against the new 11-argument overload;
--   3. no deployed caller anywhere still invokes the old 10-argument
--      signature (confirmed, not assumed).
-- Do not write that CONTRACT migration as part of this checkpoint.
--
-- Not applied by this checkpoint. Not committed.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- update_member_reservation — NEW 11-argument overload only. The existing
-- 10-argument function (0097) is not referenced, not dropped, and not
-- altered anywhere in this file — it remains exactly as production already
-- has it. p_roster_member_id is required, positioned with the other
-- required params, before the existing defaulted ones (Postgres requires
-- defaulted parameters to be last) — this argument list is what makes
-- Postgres register it as a NEW, separate overload rather than colliding
-- with the existing 10-argument one.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.update_member_reservation(
  p_reservation_id       uuid,
  p_expected_club_id     uuid,
  p_expected_updated_at  timestamptz,
  p_court_id             uuid,
  p_starts_at            timestamptz,
  p_ends_at              timestamptz,
  p_roster_member_id     uuid,
  p_format               text    default null,
  p_player_count         int     default null,
  p_guest_names          text[]  default null,
  p_notes                text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id             uuid;
  v_role                text;
  v_before               reservations%rowtype;
  v_after                reservations%rowtype;
  v_court                courts%rowtype;
  v_tz                   text;
  v_date                 date;
  v_dow                  int;
  v_override             operating_hours_override%rowtype;
  v_hours                operating_hours%rowtype;
  v_scheduling_changed   boolean;
  v_changed_fields       text[] := '{}';
  v_notification_id      uuid;
  -- Phase 33C2 completion: Member-reassignment resolution state.
  v_roster               public.roster_members%rowtype;
  v_member_changed       boolean;
  v_new_owner_id         uuid;
begin
  -- 1-4. Membership-native auth capture, admin-only. Unchanged.
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;

  -- Defensive shape guards. Unchanged.
  if p_court_id is null then raise exception 'invalid_court'; end if;
  if p_starts_at is null or p_ends_at is null then raise exception 'invalid_duration'; end if;

  -- 5-6. Lock the target row, scoped to this club. Unchanged.
  select * into v_before
    from reservations
    where id = p_reservation_id and club_id = v_club_id
    for update;
  if not found then raise exception 'reservation_not_found'; end if;

  -- 7-8. Scope: confirmed member bookings only. Unchanged — this migration
  -- does not relax which reservations are editable.
  if v_before.reason <> 'member_booking' then raise exception 'reservation_not_editable'; end if;
  if v_before.status <> 'confirmed' then raise exception 'reservation_not_editable'; end if;

  -- 9. Existing start must still be in the future. Unchanged.
  if v_before.starts_at <= now() then raise exception 'cannot_edit_started_reservation'; end if;

  -- 10-11. Optimistic concurrency. Unchanged.
  if v_before.updated_at is distinct from p_expected_updated_at then
    raise exception 'stale_edit_conflict';
  end if;

  -- 12-13. Proposed range must be future and well-formed. Unchanged.
  if p_starts_at <= now() then raise exception 'cannot_book_past'; end if;
  if p_ends_at <= p_starts_at then raise exception 'invalid_duration'; end if;

  -- ═══════════════════════════════════════════════════════════════════════
  -- Member reassignment resolution — new in this migration. Mirrors
  -- admin_create_member_reservation's (0108) own pattern exactly: same-club
  -- lookup, owner_user_id derived server-side from the roster row's own
  -- claimed_by, never accepted as a client parameter. Resolved BEFORE any
  -- write, same as 0108's RPCs.
  --
  -- Only touches owner_user_id when the Member actually changes
  -- (v_member_changed) — 0108's own design principle ("a later claim must
  -- not invalidate an existing reservation") applies here too: if the
  -- Member is NOT being reassigned, owner_user_id is left at exactly its
  -- current value, even if that roster identity's claimed_by has since
  -- changed for unrelated reasons (e.g., the Member created an account
  -- after this reservation was booked, but this edit isn't about them).
  -- ═══════════════════════════════════════════════════════════════════════
  if p_roster_member_id is null then
    raise exception 'roster_identity_required';
  end if;

  v_member_changed := p_roster_member_id is distinct from v_before.roster_member_id;

  if v_member_changed then
    select * into v_roster
      from public.roster_members
     where id      = p_roster_member_id
       and club_id = v_club_id;
    if not found then raise exception 'roster_member_not_found'; end if;
    v_new_owner_id := v_roster.claimed_by;
  else
    v_new_owner_id := v_before.owner_user_id;
  end if;

  v_scheduling_changed :=
    p_court_id  is distinct from v_before.court_id
    or p_starts_at is distinct from v_before.starts_at
    or p_ends_at   is distinct from v_before.ends_at;

  -- 14-16, 24. Re-run scheduling validation only when court/start/end
  -- actually change. Unchanged.
  if v_scheduling_changed then
    select * into v_court
      from courts
      where id = p_court_id and club_id = v_club_id and is_active = true;
    if not found then raise exception 'invalid_court'; end if;

    if extract(epoch from (p_ends_at - p_starts_at)) / 60 not in (30, 60, 90, 120) then
      raise exception 'invalid_duration';
    end if;

    select timezone into v_tz from clubs where id = v_club_id;

    v_date := (p_starts_at at time zone v_tz)::date;
    v_dow  := extract(dow from p_starts_at at time zone v_tz)::int;

    select * into v_override
      from operating_hours_override
      where club_id = v_club_id and override_date = v_date;

    if found then
      if v_override.is_closed then
        raise exception 'club_closed_this_day';
      end if;
      if v_override.opens_at is not null and v_override.closes_at is not null then
        if (p_starts_at at time zone v_tz)::time < v_override.opens_at
           or (p_ends_at at time zone v_tz)::time > v_override.closes_at then
          raise exception 'outside_operating_hours';
        end if;
      end if;
    else
      select * into v_hours
        from operating_hours
        where club_id = v_club_id and day_of_week = v_dow;

      if not found or v_hours.is_closed then
        raise exception 'club_closed_this_day';
      end if;

      if (p_starts_at at time zone v_tz)::time < v_hours.opens_at
         or (p_ends_at at time zone v_tz)::time > v_hours.closes_at then
        raise exception 'outside_operating_hours';
      end if;
    end if;
  end if;

  -- 22. Compute the changed-fields list across every editable column.
  -- roster_member_id added (equivalent to v_member_changed, expressed here
  -- for consistency with every other field's own is-distinct check).
  if p_court_id is distinct from v_before.court_id then
    v_changed_fields := array_append(v_changed_fields, 'court_id');
  end if;
  if p_starts_at is distinct from v_before.starts_at then
    v_changed_fields := array_append(v_changed_fields, 'starts_at');
  end if;
  if p_ends_at is distinct from v_before.ends_at then
    v_changed_fields := array_append(v_changed_fields, 'ends_at');
  end if;
  if v_member_changed then
    v_changed_fields := array_append(v_changed_fields, 'roster_member_id');
  end if;
  if p_format is distinct from v_before.format then
    v_changed_fields := array_append(v_changed_fields, 'format');
  end if;
  if p_player_count is distinct from v_before.player_count then
    v_changed_fields := array_append(v_changed_fields, 'player_count');
  end if;
  if p_guest_names is distinct from v_before.guest_names then
    v_changed_fields := array_append(v_changed_fields, 'guest_names');
  end if;
  if p_notes is distinct from v_before.notes then
    v_changed_fields := array_append(v_changed_fields, 'notes');
  end if;

  -- 23. True no-op: nothing changed. No UPDATE, no updated_at bump, no
  -- audit row, no notification. Unchanged in shape; now also correctly
  -- covers "Member unchanged, everything else unchanged."
  if array_length(v_changed_fields, 1) is null then
    return jsonb_build_object(
      'reservation',     to_jsonb(v_before),
      'changed_fields',  to_jsonb(v_changed_fields),
      'notification_id', null
    );
  end if;

  -- 19-21. One genuine UPDATE — reservation id/row is never replaced.
  -- roster_member_id and owner_user_id are now always in this SET list
  -- (idempotently, when v_member_changed is false — v_new_owner_id equals
  -- v_before.owner_user_id in that case, so this is a no-op write for
  -- those two columns). This means 0108's reservations_member_booking_
  -- identity_guard trigger (UPDATE OF ... roster_member_id, owner_user_id
  -- ...) now fires on every edit through this RPC, not only reassignments
  -- — harmless and correct: the values are always self-consistent by
  -- construction (resolved above from the same roster row, or carried
  -- forward unchanged), so the trigger's re-validation always passes: it
  -- is additional, free re-verification, not a new constraint on this RPC.
  -- created_by is still absent from this SET list — never rewritten.
  update reservations set
    court_id          = p_court_id,
    starts_at         = p_starts_at,
    ends_at           = p_ends_at,
    roster_member_id  = p_roster_member_id,
    owner_user_id     = v_new_owner_id,
    format            = p_format,
    player_count      = p_player_count,
    guest_names       = p_guest_names,
    notes             = p_notes,
    updated_at        = now()
  where id = p_reservation_id
  returning * into v_after;

  -- Audit: member_reassigned flag plus roster_member_id/owner_user_id in
  -- both before/after snapshots — records the Member change clearly and
  -- unambiguously, per instruction. The pre-existing top-level
  -- 'owner_user_id' key is left in place (v_before.owner_user_id) for
  -- backward compatibility with anything already reading that key.
  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id,
    auth.uid(),
    'update_member_reservation',
    'reservation',
    p_reservation_id,
    jsonb_build_object(
      'owner_user_id',     v_before.owner_user_id,
      'changed_fields',    v_changed_fields,
      'member_reassigned', v_member_changed,
      'before', jsonb_build_object(
        'court_id',         v_before.court_id,
        'starts_at',        v_before.starts_at,
        'ends_at',          v_before.ends_at,
        'format',           v_before.format,
        'player_count',     v_before.player_count,
        'guest_names',      v_before.guest_names,
        'notes',            v_before.notes,
        'roster_member_id', v_before.roster_member_id,
        'owner_user_id',    v_before.owner_user_id
      ),
      'after', jsonb_build_object(
        'court_id',         v_after.court_id,
        'starts_at',        v_after.starts_at,
        'ends_at',          v_after.ends_at,
        'format',           v_after.format,
        'player_count',     v_after.player_count,
        'guest_names',      v_after.guest_names,
        'notes',            v_after.notes,
        'roster_member_id', v_after.roster_member_id,
        'owner_user_id',    v_after.owner_user_id
      )
    )
  );

  v_notification_id := null;

  -- Mandatory in-app notification — fires exactly when court/date/time
  -- materially changed, exactly as before this migration, PLUS a new
  -- guard: v_after.owner_user_id is not null. See "NARROW NOTIFICATION
  -- INVESTIGATION" above for the full reasoning. Addressed to v_after.
  -- owner_user_id (was v_before.owner_user_id) — a no-op change in value
  -- for every case that isn't a same-call reassignment.
  if v_scheduling_changed and v_after.owner_user_id is not null then
    if v_tz is null then
      select timezone into v_tz from clubs where id = v_club_id;
    end if;

    insert into notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id,
      v_after.owner_user_id,
      'reservation_rescheduled',
      'Your booking was moved to ' || v_court.name || ' on '
        || to_char(v_after.starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM')
        || ' – ' || to_char(v_after.ends_at at time zone v_tz, 'HH12:MI AM') || '.',
      jsonb_build_object('reservation_id', v_after.id, 'court_id', v_after.court_id)
    )
    returning id into v_notification_id;
  end if;

  return jsonb_build_object(
    'reservation',     to_jsonb(v_after),
    'changed_fields',  to_jsonb(v_changed_fields),
    'notification_id', v_notification_id
  );
end;
$$;

revoke execute on function public.update_member_reservation(
  uuid, uuid, timestamptz, uuid, timestamptz, timestamptz, uuid, text, int, text[], text
) from public, anon;
grant  execute on function public.update_member_reservation(
  uuid, uuid, timestamptz, uuid, timestamptz, timestamptz, uuid, text, int, text[], text
) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration is created
-- in this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- This is an EXPAND migration — it only ADDED the new 11-argument overload;
-- the legacy 10-argument update_member_reservation was never touched.
-- Rollback is correspondingly narrow: drop ONLY the new overload —
--   `drop function if exists public.update_member_reservation(uuid, uuid,
--   timestamptz, uuid, timestamptz, timestamptz, uuid, text, int, text[],
--   text);`
-- — using its full 11-type identity so only that exact overload is
-- targeted. Do not touch, drop, or recreate the 10-argument function in a
-- rollback of this migration — it was never part of this migration's
-- change and must be left exactly as production already has it. After
-- this rollback, the currently deployed frontend (still calling the
-- 10-argument signature) is completely unaffected either way — the
-- rollback exists only to remove the option for a newer frontend build to
-- call the 11-argument overload, not to restore any prior state, since
-- none was changed.
--
-- Any reservation that was already reassigned to a different Member via
-- the 11-argument overload while it was live keeps its new roster_
-- member_id/owner_user_id after this rollback — dropping the function does
-- not retroactively undo data it already wrote, matching the same
-- precedent documented in every prior Phase 33 rollback section.
--
-- Removing the legacy 10-argument overload (the eventual CONTRACT step) is
-- explicitly out of scope for this migration and this rollback — see
-- "EXPAND, NOT CONTRACT" in the header above for the three preconditions
-- that must hold before that separate migration is even written.
