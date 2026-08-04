-- 0100_maintenance_edit_foundation.sql
-- Phase 30D: Admin editing of a single future maintenance/blocked-court
-- reservation row.
--
-- Locked product decision (Phase 30D audit): maintenance blocks have no
-- durable group identity in the current schema. create_maintenance_blocks
-- (0024/0026) inserts one independent reservations row per court in a
-- single call, with no shared group_id/batch_id/parent row of any kind —
-- and the audit trail cannot reconstruct which rows belonged to one
-- creation call either (its own target_id is the club id). This migration
-- does not add a group identity, does not infer one from matching
-- timestamps/notes/created_by, and does not change create_maintenance_block
-- or create_maintenance_blocks. Editing one maintenance block on one court
-- edits exactly that one reservations row. Adding another court remains
-- Create Maintenance Block; removing a court remains cancelling that row
-- via the existing admin_cancel_reservation RPC (unchanged).
--
-- Adds exactly one new mutation RPC: public.update_maintenance_block.
-- Modeled directly on update_member_reservation (0097) for the auth/
-- eligibility/concurrency shape, but scoped to reason='maintenance' rows
-- and with no notification dispatch (maintenance blocks have no
-- participant/customer to notify) and no operating-hours/closed-date
-- check (create_maintenance_block(s) never validated operating hours —
-- maintenance work is expected to happen off-hours — and this edit path
-- must not become stricter than creation).
--
-- Does not modify migrations 0097–0099. Does not touch event, lesson,
-- program, or personal-booking (member_booking) behavior in any way.
-- Apply in Supabase SQL Editor (cloud only).

-- ═══════════════════════════════════════════════════════════════════════════
-- update_maintenance_block
-- ═══════════════════════════════════════════════════════════════════════════
-- Admin-only. Edits court/time/notes/visibility on a single, still-future,
-- confirmed maintenance reservation row in place.
--
-- Authorization: membership-native (current_user_club_id() /
-- current_user_role()), not profiles.club_id/profiles.role directly —
-- matching update_event and update_member_reservation. p_expected_club_id
-- is compared against current_user_club_id() for stale-tab defense, same
-- as every other Phase 30 edit RPC.
--
-- Eligibility: reason='maintenance', status='confirmed', starts_at > now().
-- Any other state (wrong reason/status, already started, unknown/wrong-club
-- row) is rejected before any mutation. Optimistic concurrency via
-- p_expected_updated_at compared against the row's current updated_at.
--
-- Editable: court_id, starts_at, ends_at, notes, show_notes_to_members.
-- Never touched: owner_user_id, created_by, reason, status, event_id,
-- cancellation_at/cancelled_by/cancellation_kind, or any other column.
--
-- No operating-hours/closed-date validation (parity with creation). The
-- existing GiST exclusion constraint on reservations remains the sole
-- conflict authority and raises 23P01 on a genuine overlap, rolling back
-- the whole call.
--
-- True no-op (every field resubmitted identical to current values):
-- returns successfully, updated_at unchanged, no audit row written.
--
-- A real change performs exactly one UPDATE and writes exactly one
-- audit_log row (action='update_maintenance_block', target_type=
-- 'reservation', target_id=p_reservation_id) with changed_fields plus
-- structured before/after values for court_id/starts_at/ends_at/notes/
-- show_notes_to_members. No notification is ever created.
--
-- Error codes: not_authenticated, stale_club_context, insufficient_role,
-- reservation_not_found, reservation_not_editable,
-- cannot_edit_started_reservation, stale_edit_conflict, invalid_duration,
-- cannot_edit_to_past, invalid_court, plus Postgres 23P01 on a genuine
-- court conflict.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.update_maintenance_block(
  p_reservation_id         uuid,
  p_expected_club_id       uuid,
  p_expected_updated_at    timestamptz,
  p_court_id               uuid,
  p_starts_at              timestamptz,
  p_ends_at                timestamptz,
  p_notes                  text    default null,
  p_show_notes_to_members  boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id         uuid;
  v_role            text;
  v_before          reservations%rowtype;
  v_after           reservations%rowtype;
  v_court           courts%rowtype;
  v_changed_fields  text[] := '{}';
begin
  -- Membership-native auth capture, admin-only.
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;

  -- Lock the target reservation, scoped to this club.
  select * into v_before
    from reservations
    where id = p_reservation_id and club_id = v_club_id
    for update;
  if not found then raise exception 'reservation_not_found'; end if;

  -- Eligibility.
  if v_before.reason <> 'maintenance' then raise exception 'reservation_not_editable'; end if;
  if v_before.status <> 'confirmed'   then raise exception 'reservation_not_editable'; end if;
  if v_before.starts_at <= now()      then raise exception 'cannot_edit_started_reservation'; end if;

  -- Optimistic concurrency.
  if v_before.updated_at is distinct from p_expected_updated_at then
    raise exception 'stale_edit_conflict';
  end if;

  -- Defensive shape guards.
  if p_starts_at is null or p_ends_at is null then raise exception 'invalid_duration'; end if;
  if p_ends_at <= p_starts_at then raise exception 'invalid_duration'; end if;
  if p_starts_at <= now() then raise exception 'cannot_edit_to_past'; end if;

  -- Court validation: must be active and belong to this club.
  select * into v_court
    from courts
    where id = p_court_id and club_id = v_club_id and is_active = true;
  if not found then raise exception 'invalid_court'; end if;

  -- changed_fields.
  if p_court_id is distinct from v_before.court_id then
    v_changed_fields := array_append(v_changed_fields, 'court_id');
  end if;
  if p_starts_at is distinct from v_before.starts_at then
    v_changed_fields := array_append(v_changed_fields, 'starts_at');
  end if;
  if p_ends_at is distinct from v_before.ends_at then
    v_changed_fields := array_append(v_changed_fields, 'ends_at');
  end if;
  if p_notes is distinct from v_before.notes then
    v_changed_fields := array_append(v_changed_fields, 'notes');
  end if;
  if p_show_notes_to_members is distinct from v_before.show_notes_to_members then
    v_changed_fields := array_append(v_changed_fields, 'show_notes_to_members');
  end if;

  -- True no-op: nothing changed. No UPDATE, no audit row.
  if array_length(v_changed_fields, 1) is null then
    return jsonb_build_object(
      'reservation',    to_jsonb(v_before),
      'changed_fields', to_jsonb(v_changed_fields)
    );
  end if;

  -- Single in-place UPDATE. The GiST exclusion constraint on reservations
  -- is the sole conflict authority here — a genuine overlap on the target
  -- court/time raises 23P01 and rolls back this entire call.
  update reservations set
    court_id   = p_court_id,
    starts_at  = p_starts_at,
    ends_at    = p_ends_at,
    notes      = p_notes,
    show_notes_to_members = p_show_notes_to_members,
    updated_at = now()
  where id = p_reservation_id
  returning * into v_after;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id,
    auth.uid(),
    'update_maintenance_block',
    'reservation',
    p_reservation_id,
    jsonb_build_object(
      'changed_fields', v_changed_fields,
      'before', jsonb_build_object(
        'court_id',               v_before.court_id,
        'starts_at',              v_before.starts_at,
        'ends_at',                v_before.ends_at,
        'notes',                  v_before.notes,
        'show_notes_to_members',  v_before.show_notes_to_members
      ),
      'after', jsonb_build_object(
        'court_id',               v_after.court_id,
        'starts_at',              v_after.starts_at,
        'ends_at',                v_after.ends_at,
        'notes',                  v_after.notes,
        'show_notes_to_members',  v_after.show_notes_to_members
      )
    )
  );

  return jsonb_build_object(
    'reservation',    to_jsonb(v_after),
    'changed_fields', to_jsonb(v_changed_fields)
  );
end;
$$;

revoke execute on function public.update_maintenance_block(
  uuid, uuid, timestamptz, uuid, timestamptz, timestamptz, text, boolean
) from public, anon;
grant  execute on function public.update_maintenance_block(
  uuid, uuid, timestamptz, uuid, timestamptz, timestamptz, text, boolean
) to authenticated;
