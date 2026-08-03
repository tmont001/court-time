-- 0099_event_edit_foundation.sql
-- Phase 30C1: Admin Event Editing (standalone + program-generated sessions),
-- plus an isolated correction to cancel_event's Pro-ownership check.
--
-- Scope, exactly three changes:
--   1. Add notification kind `event_updated` (notifications_kind_check,
--      notification_preferences_kind_check, update_notification_preference
--      allowlist).
--   2. Add the new Admin-only SECURITY DEFINER RPC `update_event`.
--   3. Correct cancel_event's Pro-ownership check (see section C below for
--      the full regression history and the narrow fix).
--
-- No other RPC, table, column, constraint, grant, or RLS policy is touched.
-- create_event, archive_event, unarchive_event, set_event_member_joinable,
-- every roster/waitlist RPC, and every program RPC are all unchanged. This
-- also does not touch cancel_member_reservation, admin_cancel_reservation,
-- reservations RLS policies, or club cancellation-window/grace settings —
-- cancel_event governs club events and their linked reason='event'
-- reservations only, never a Member's personal reason='member_booking'
-- court reservation, which continues to go exclusively through
-- cancel_member_reservation (migration 0097).
--
-- Revision note: this version corrects three review findings against the
-- first draft of this migration — (a) cancel_event's role check is now
-- null-safe and role-exhaustive (a Member, or any other/null role, is
-- always rejected outright, never merely falling through a `<> 'admin'`
-- branch); (b) newly added event-reservation rows now preserve the
-- event's original creator as owner_user_id/created_by instead of the
-- editing Admin; (c) update_event's events UPDATE is split into two
-- branches so the events_check_event_type_active trigger is never fired
-- by an unrelated edit that leaves event_type_id unchanged. See sections
-- C and D below for the exact detail on each.
--
-- Apply in Supabase SQL Editor (cloud only). Not applied by this checkpoint
-- — this file is created for migration review only (Phase 30C1).

-- ═══════════════════════════════════════════════════════════════════════════
-- A. notifications_kind_check — add event_updated
-- ═══════════════════════════════════════════════════════════════════════════
-- Same drop/re-add idiom as every prior kind-expansion migration (0014,
-- 0039, 0048, 0069, 0078, 0097). All 16 currently-allowed kinds preserved
-- verbatim; adds event_updated as the 17th.

alter table public.notifications
  drop constraint if exists notifications_kind_check;

alter table public.notifications
  add constraint notifications_kind_check
  check (kind in (
    'reservation_confirmed',
    'reservation_cancelled_by_admin',
    'reservation_cancelled_by_member',
    'reservation_rescheduled',
    'event_cancelled',
    'event_joined',
    'event_updated',                 -- Phase 30C1: admin edit of an event's schedule/details
    'waitlist_promoted',
    'waitlist_offer',
    'announcement',
    'lesson_request_received',
    'lesson_request_proposed',
    'lesson_request_confirmed',
    'lesson_request_declined',
    'lesson_cancelled',
    'lesson_provider_reassigned',
    'lesson_admin_requested'
  ));

-- ═══════════════════════════════════════════════════════════════════════════
-- B. notification_preferences_kind_check + update_notification_preference
--    allowlist — add event_updated so users can opt out of EMAIL delivery
--    for it. This does not and cannot suppress the in-app row — see
--    update_event below, which never gates the in-app insert behind
--    user_pref_enabled(). Email delivery is gated downstream by
--    sendEmailNotification() (src/lib/email.ts), which already calls
--    user_pref_enabled() for every kind — no email.ts change is required.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.notification_preferences
  drop constraint if exists notification_preferences_kind_check;

alter table public.notification_preferences
  add constraint notification_preferences_kind_check
  check (kind in (
    'reservation_confirmed',
    'reservation_cancelled_by_member',
    'reservation_cancelled_by_admin',
    'reservation_rescheduled',
    'event_joined',
    'event_cancelled',
    'event_updated',
    'waitlist_offer',
    'waitlist_promoted',
    'announcement',
    'lesson_request_received',
    'lesson_request_proposed',
    'lesson_request_confirmed',
    'lesson_request_declined',
    'lesson_cancelled',
    'lesson_provider_reassigned',
    'lesson_admin_requested'
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
  select public.current_user_club_id() into v_club_id;

  if v_club_id is null then raise exception 'not_authenticated'; end if;

  if p_kind not in (
    'reservation_confirmed',
    'reservation_cancelled_by_member',
    'reservation_cancelled_by_admin',
    'reservation_rescheduled',
    'event_joined',
    'event_cancelled',
    'event_updated',
    'waitlist_offer',
    'waitlist_promoted',
    'announcement',
    'lesson_request_received',
    'lesson_request_proposed',
    'lesson_request_confirmed',
    'lesson_request_declined',
    'lesson_cancelled',
    'lesson_provider_reassigned',
    'lesson_admin_requested'
  ) then
    raise exception 'invalid_kind';
  end if;

  insert into public.notification_preferences (user_id, club_id, kind, enabled, updated_at)
  values (auth.uid(), v_club_id, p_kind, p_enabled, now())
  on conflict (user_id, kind) do update
    set enabled    = excluded.enabled,
        updated_at = now();
end;
$$;

revoke execute on function public.update_notification_preference(text, boolean) from public, anon;
grant  execute on function public.update_notification_preference(text, boolean) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- C. update_event
-- ═══════════════════════════════════════════════════════════════════════════
-- Admin-only. Edits a single eligible future event in place — one genuine
-- UPDATE on `events` plus a transactional court-set diff against its linked
-- `reservations` rows (reason='event'). Never cancels and recreates.
--
-- Eligibility: status='scheduled', archived_at is null, starts_at > now() —
-- identical guard shape to the existing set_event_member_joinable RPC.
--
-- Standalone events: title, event_type_id, starts_at, ends_at, court_ids,
-- capacity, description are all editable.
--
-- Program-generated events (program_id is not null): only starts_at,
-- ends_at, court_ids, capacity are editable. Any attempt to change title,
-- event_type_id, or description on a program-linked event is rejected
-- server-side (program_session_field_not_editable) — not merely hidden by
-- the UI. Every successful, non-no-op edit of a program-linked event sets
-- is_program_exception = true. program_id, program_schedule_rule_id, and
-- program_occurrence_date are never present in any UPDATE ... SET list —
-- structurally impossible to change through this RPC. program_occurrence_date
-- is deliberately preserved even when starts_at moves to a different
-- calendar date, per its own column comment (0087): regeneration must keep
-- treating the original slot as filled.
--
-- Court-set diff (not cancel-and-recreate): existing active linked
-- reservations are loaded and locked, compared against the requested
-- court_ids to compute retained / removed / added sets. Retained courts'
-- reservation rows are updated in place (time only, when it changed) and
-- keep their id and notes. Removed courts are soft-cancelled
-- (cancellation_kind='system' — an edit-driven replacement, not a user
-- cancellation). Added courts get fresh rows. The three sets are disjoint
-- by construction (a court cannot appear in more than one), so no statement
-- in this sequence ever targets the same court_id as another — the GiST
-- exclusion constraint (unchanged, still the sole hard conflict authority)
-- can only ever fire here for a genuine external conflict.
--
-- Canonical note preservation: before any reservation mutation, one
-- pre-edit notes value is derived deterministically from the existing
-- active linked reservations (preferring a non-null value; null only when
-- every existing row already has null notes) and applied to every newly
-- added court's row — including during a full court-set replacement, where
-- there are no retained rows to inherit from directly.
--
-- Reservation ownership on added courts: every newly inserted event
-- reservation row uses owner_user_id = created_by = v_before.created_by
-- (the event's original creator), never auth.uid() (the editing Admin) —
-- an Admin editing another Admin's or a Pro's event must not silently
-- reassign ownership of the underlying court bookings. The editing actor
-- is still fully recorded: via audit_log.actor_id for the edit itself, and
-- via cancelled_by = auth.uid() on any removed court's soft-cancelled row
-- (that column correctly identifies who performed the cancellation, not
-- who owns the booking). Retained courts' existing owner_user_id/
-- created_by are never touched by this RPC at all.
--
-- Capacity: rejected if below the current occupied count (confirmed +
-- offered participants with role='participant', plus event_guests —
-- waitlisted rows never count) — capacity_below_participants. No
-- participant, guest, offer, attendance record, or program-enrollment row
-- is ever touched. On a capacity increase, the existing sequential
-- waitlist-offer helpers (expire_stale_offers_for_event then
-- advance_waitlist_offer) are invoked once, exactly as every other capacity-
-- freeing code path already does — advance_waitlist_offer is idempotent, so
-- this can never create a second competing active offer.
--
-- Operating hours / closed dates: deliberately NOT validated here, matching
-- create_event's current behavior exactly (create_event has never checked
-- operating_hours or operating_hours_override — confirmed by inspecting
-- every historical redefinition). Adding such a check here would make
-- editing stricter than creation without being asked to; that parity gap is
-- explicitly out of this checkpoint's scope, documented in
-- docs/QA_phase30c.md rather than silently "fixed" here.
--
-- events_check_event_type_active trigger avoidance: that existing trigger
-- fires on `BEFORE UPDATE OF event_type_id` — which Postgres interprets as
-- "event_type_id appears in this UPDATE's SET list," regardless of whether
-- the assigned value actually differs from the current one. Because
-- update_event otherwise always assigns event_type_id on every call, an
-- edit that changes only, say, capacity on an event whose type has since
-- been deactivated would incorrectly trigger inactive_event_type. To avoid
-- this, the events UPDATE is split into two branches: one that includes
-- event_type_id in the SET list (only when p_event_type_id actually
-- differs from the event's current value, correctly letting the trigger
-- validate the newly selected type), and one that omits the column from
-- the SET list entirely (whenever it is unchanged, so the trigger never
-- fires for an unrelated edit). Both branches are otherwise identical and
-- both return the updated row into v_after.
--
-- Concurrency: p_expected_updated_at compared against events.updated_at
-- (bumped by the existing events_updated_at trigger) — stale_edit_conflict
-- on mismatch. p_expected_club_id compared against current_user_club_id()
-- inside the transaction — stale_club_context on mismatch.
--
-- No-op: if nothing in changed_fields (title/event_type_id/starts_at/
-- ends_at/capacity/description, plus a synthetic court_ids entry whenever
-- the court set changed), return early — no events UPDATE, no reservation
-- mutation, no audit_log row, no notification.
--
-- Notification: event_updated is inserted UNCONDITIONALLY (never wrapped in
-- user_pref_enabled) for every event_participants row with
-- status in ('confirmed','waitlisted','offered') whenever title,
-- event_type_id, starts_at/ends_at, the court set, or capacity changed.
-- A description-only change still writes the audit_log row but sends zero
-- notifications. Guests are never notified (no user_id to notify).
--
-- Returns jsonb: { event, changed_fields, notifications: [{notification_id,
-- user_id}, ...] } — exact recipient pairs, never a bare id array, so the
-- Server Action can dispatch delivery by exact notification_id without a
-- "newest matching kind" re-query even with multiple recipients.
--
-- Error codes: not_authenticated, stale_club_context, insufficient_role,
-- event_not_found, event_cancelled, event_archived, event_started,
-- stale_edit_conflict, program_session_field_not_editable, invalid_title,
-- event_type_not_found, court_required, duplicate_court_in_event,
-- invalid_duration, invalid_capacity, capacity_below_participants,
-- invalid_court, inactive_event_type (from the existing
-- events_check_event_type_active trigger), plus Postgres 23P01 on a
-- genuine court conflict.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.update_event(
  p_event_id             uuid,
  p_expected_club_id     uuid,
  p_expected_updated_at  timestamptz,
  p_title                text,
  p_event_type_id        uuid,
  p_starts_at            timestamptz,
  p_ends_at              timestamptz,
  p_court_ids            uuid[],
  p_capacity             int,
  p_description          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id              uuid;
  v_role                 text;
  v_before                events%rowtype;
  v_after                 events%rowtype;
  v_existing_court_ids    uuid[];
  v_retained_ids          uuid[];
  v_removed_ids           uuid[];
  v_added_ids             uuid[];
  v_court_id              uuid;
  v_dup_count             int;
  v_distinct_count        int;
  v_time_changed          boolean;
  v_court_set_changed     boolean;
  v_occupied              int;
  v_changed_fields        text[] := '{}';
  v_canonical_notes       text;
  v_audit_before          jsonb;
  v_audit_after           jsonb;
  v_notifications         jsonb := '[]'::jsonb;
  v_notify_profile_id     uuid;
  v_new_notification_id   uuid;
  v_exception_transitioned boolean;
begin
  -- Membership-native auth capture, admin-only.
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;

  -- Lock the target event, scoped to this club.
  select * into v_before
    from events
    where id = p_event_id and club_id = v_club_id
    for update;
  if not found then raise exception 'event_not_found'; end if;

  -- Eligibility — identical guard shape to set_event_member_joinable.
  if v_before.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_before.archived_at is not null then raise exception 'event_archived'; end if;
  if v_before.starts_at <= now() then raise exception 'event_started'; end if;

  -- Optimistic concurrency.
  if v_before.updated_at is distinct from p_expected_updated_at then
    raise exception 'stale_edit_conflict';
  end if;

  -- Program-session field restriction — enforced here, not only by the UI
  -- never rendering the controls.
  if v_before.program_id is not null then
    if p_title is distinct from v_before.title
       or p_event_type_id is distinct from v_before.event_type_id
       or p_description is distinct from v_before.description
    then
      raise exception 'program_session_field_not_editable';
    end if;
  end if;

  -- Defensive shape guards (friendlier than the raw NOT NULL violations
  -- these columns would otherwise raise).
  if p_title is null or length(btrim(p_title)) = 0 then raise exception 'invalid_title'; end if;
  if p_event_type_id is null then raise exception 'event_type_not_found'; end if;
  if p_starts_at is null or p_ends_at is null then raise exception 'invalid_duration'; end if;

  if p_court_ids is null or array_length(p_court_ids, 1) is null then
    raise exception 'court_required';
  end if;

  select count(*), count(distinct c) into v_dup_count, v_distinct_count
    from unnest(p_court_ids) as c;
  if v_dup_count <> v_distinct_count then
    raise exception 'duplicate_court_in_event';
  end if;

  if p_ends_at <= p_starts_at then raise exception 'invalid_duration'; end if;
  if p_capacity is null or p_capacity <= 0 then raise exception 'invalid_capacity'; end if;

  -- Capacity floor: confirmed/offered participants (role='participant') + guests.
  -- Same formula every existing roster RPC already uses. Waitlisted rows
  -- never count.
  select
    (select count(*) from event_participants
       where event_id = p_event_id and status in ('confirmed', 'offered') and role = 'participant')
    + (select count(*) from event_guests where event_id = p_event_id)
    into v_occupied;

  if p_capacity < v_occupied then raise exception 'capacity_below_participants'; end if;

  -- Court validation: every requested court must be active and same-club.
  if exists (
    select 1 from unnest(p_court_ids) as t(id)
    where not exists (
      select 1 from courts c
      where c.id = t.id and c.club_id = v_club_id and c.is_active = true
    )
  ) then
    raise exception 'invalid_court';
  end if;

  -- Load and lock the event's existing active linked reservations.
  with locked_res as (
    select * from reservations
    where event_id = p_event_id and reason = 'event' and status in ('pending', 'confirmed')
    for update
  )
  select array_agg(court_id) into v_existing_court_ids from locked_res;
  v_existing_court_ids := coalesce(v_existing_court_ids, '{}');

  -- Canonical pre-edit note: deterministic — prefers a non-null value
  -- (lowest court_id among non-null rows breaks ties), falls back to null
  -- only when every existing active row already has null notes. Computed
  -- from the pre-edit state before any reservation mutation below, so it
  -- is always available (including for a full court-set replacement, where
  -- no row survives to inherit from directly).
  select notes into v_canonical_notes
    from reservations
    where event_id = p_event_id and reason = 'event' and status in ('pending', 'confirmed')
    order by (notes is null), court_id
    limit 1;

  -- Retained / removed / added court sets — disjoint by construction.
  select coalesce(array_agg(c), '{}') into v_retained_ids
    from unnest(v_existing_court_ids) c where c = any(p_court_ids);
  select coalesce(array_agg(c), '{}') into v_removed_ids
    from unnest(v_existing_court_ids) c where not (c = any(p_court_ids));
  select coalesce(array_agg(c), '{}') into v_added_ids
    from unnest(p_court_ids) c where not (c = any(v_existing_court_ids));

  v_time_changed      := p_starts_at is distinct from v_before.starts_at
                          or p_ends_at is distinct from v_before.ends_at;
  v_court_set_changed := array_length(v_removed_ids, 1) is not null
                          or array_length(v_added_ids, 1) is not null;

  -- changed_fields.
  if p_title is distinct from v_before.title then
    v_changed_fields := array_append(v_changed_fields, 'title');
  end if;
  if p_event_type_id is distinct from v_before.event_type_id then
    v_changed_fields := array_append(v_changed_fields, 'event_type_id');
  end if;
  if p_starts_at is distinct from v_before.starts_at then
    v_changed_fields := array_append(v_changed_fields, 'starts_at');
  end if;
  if p_ends_at is distinct from v_before.ends_at then
    v_changed_fields := array_append(v_changed_fields, 'ends_at');
  end if;
  if p_capacity is distinct from v_before.capacity then
    v_changed_fields := array_append(v_changed_fields, 'capacity');
  end if;
  if p_description is distinct from v_before.description then
    v_changed_fields := array_append(v_changed_fields, 'description');
  end if;
  if v_court_set_changed then
    v_changed_fields := array_append(v_changed_fields, 'court_ids');
  end if;

  -- True no-op: nothing changed. No UPDATE, no reservation mutation, no
  -- audit row, no notification.
  if array_length(v_changed_fields, 1) is null then
    return jsonb_build_object(
      'event',          to_jsonb(v_before),
      'changed_fields', to_jsonb(v_changed_fields),
      'notifications',  '[]'::jsonb
    );
  end if;

  -- Retained courts: update time in place only if it changed. id and notes
  -- (and every other column) are left untouched.
  if v_time_changed then
    update reservations
      set starts_at = p_starts_at, ends_at = p_ends_at, updated_at = now()
      where event_id = p_event_id and reason = 'event' and status in ('pending', 'confirmed')
        and court_id = any(v_retained_ids);
  end if;

  -- Removed courts: soft-cancel. cancellation_kind='system' — an edit-driven
  -- replacement, not a user-initiated cancellation.
  update reservations
    set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
        cancellation_kind = 'system', updated_at = now()
    where event_id = p_event_id and reason = 'event' and status in ('pending', 'confirmed')
      and court_id = any(v_removed_ids);

  -- Added courts: fresh rows, carrying the canonical pre-edit note forward.
  -- owner_user_id/created_by = v_before.created_by (the event's original
  -- creator, not the editing Admin) — see the ownership note above.
  foreach v_court_id in array v_added_ids loop
    insert into reservations (
      club_id, court_id, owner_user_id, starts_at, ends_at, status, reason,
      event_id, created_by, notes
    ) values (
      v_club_id, v_court_id, v_before.created_by, p_starts_at, p_ends_at, 'confirmed',
      'event', p_event_id, v_before.created_by, v_canonical_notes
    );
  end loop;

  v_exception_transitioned := (v_before.program_id is not null and v_before.is_program_exception = false);

  -- One genuine UPDATE (one of two branches — see the trigger-avoidance
  -- note above). program_id / program_schedule_rule_id /
  -- program_occurrence_date never appear in either branch's SET list.
  if p_event_type_id is distinct from v_before.event_type_id then
    -- event_type_id is actually changing — include it so the existing
    -- events_check_event_type_active trigger validates the new type.
    update events set
      title                 = p_title,
      event_type_id         = p_event_type_id,
      starts_at             = p_starts_at,
      ends_at               = p_ends_at,
      capacity              = p_capacity,
      description           = p_description,
      court_count           = array_length(p_court_ids, 1),
      is_program_exception  = case when v_before.program_id is not null then true else v_before.is_program_exception end,
      updated_at            = now()
    where id = p_event_id
    returning * into v_after;
  else
    -- event_type_id is unchanged — omit it from the SET list entirely so
    -- the UPDATE OF event_type_id trigger is not fired for an unrelated
    -- edit (e.g. the event's existing type may have since been
    -- deactivated; that must not block this edit).
    update events set
      title                 = p_title,
      starts_at             = p_starts_at,
      ends_at               = p_ends_at,
      capacity              = p_capacity,
      description           = p_description,
      court_count           = array_length(p_court_ids, 1),
      is_program_exception  = case when v_before.program_id is not null then true else v_before.is_program_exception end,
      updated_at            = now()
    where id = p_event_id
    returning * into v_after;
  end if;

  v_audit_before := jsonb_build_object(
    'title', v_before.title, 'event_type_id', v_before.event_type_id,
    'starts_at', v_before.starts_at, 'ends_at', v_before.ends_at,
    'capacity', v_before.capacity, 'description', v_before.description
  );
  v_audit_after := jsonb_build_object(
    'title', v_after.title, 'event_type_id', v_after.event_type_id,
    'starts_at', v_after.starts_at, 'ends_at', v_after.ends_at,
    'capacity', v_after.capacity, 'description', v_after.description
  );

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id,
    auth.uid(),
    'update_event',
    'event',
    p_event_id,
    jsonb_build_object(
      'changed_fields',              v_changed_fields,
      'before',                      v_audit_before,
      'after',                       v_audit_after,
      'program_id',                  v_before.program_id,
      'is_program_exception_set',    v_exception_transitioned,
      'old_court_ids',               to_jsonb(v_existing_court_ids),
      'new_court_ids',               to_jsonb(p_court_ids)
    )
  );

  -- Capacity increase: try to advance the waitlist queue exactly once,
  -- reusing the existing sequential offer helpers. advance_waitlist_offer
  -- is idempotent (no-op if a non-expired offer already exists), so this
  -- can never create a second competing active offer.
  if p_capacity > v_before.capacity then
    perform expire_stale_offers_for_event(p_event_id, v_club_id, v_after.title);
    perform advance_waitlist_offer(p_event_id, v_club_id, v_after.title);
  end if;

  -- Mandatory in-app notification — fires only for material changes
  -- (everything except a description-only edit). Guests are never notified.
  if 'title' = any(v_changed_fields)
     or 'event_type_id' = any(v_changed_fields)
     or 'starts_at' = any(v_changed_fields)
     or 'ends_at' = any(v_changed_fields)
     or 'court_ids' = any(v_changed_fields)
     or 'capacity' = any(v_changed_fields)
  then
    for v_notify_profile_id in
      select profile_id from event_participants
      where event_id = p_event_id and status in ('confirmed', 'waitlisted', 'offered')
    loop
      insert into notifications (club_id, user_id, kind, body, metadata)
      values (
        v_club_id,
        v_notify_profile_id,
        'event_updated',
        '"' || v_after.title || '" was updated — check the calendar for the latest details.',
        jsonb_build_object('event_id', p_event_id)
      )
      returning id into v_new_notification_id;

      v_notifications := v_notifications || jsonb_build_object(
        'notification_id', v_new_notification_id,
        'user_id',          v_notify_profile_id
      );
    end loop;
  end if;

  return jsonb_build_object(
    'event',          to_jsonb(v_after),
    'changed_fields', to_jsonb(v_changed_fields),
    'notifications',  v_notifications
  );
end;
$$;

revoke execute on function public.update_event(
  uuid, uuid, timestamptz, text, uuid, timestamptz, timestamptz, uuid[], int, text
) from public, anon;
grant  execute on function public.update_event(
  uuid, uuid, timestamptz, text, uuid, timestamptz, timestamptz, uuid[], int, text
) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- D. cancel_event — isolated Pro-ownership correction
-- ═══════════════════════════════════════════════════════════════════════════
-- Regression history (verified during the Phase 30C architecture audit):
--   - 0049_waitlist_offer_rpcs.sql: cancel_event's Pro-ownership check was a
--     confirmed-host-participant-row test.
--   - 0058_create_event_no_auto_host.sql: stopped create_event from
--     auto-inserting a host participant row, and — in the SAME migration —
--     correctly replaced cancel_event's ownership check with
--     `events.created_by = auth.uid()`, specifically because it "works
--     regardless of whether a host participant row exists."
--   - 0063_member_rpc_lifecycle_guards.sql: added the event_archived guard,
--     but its own header comment says the body is reproduced "from 0049" —
--     not from 0058 — silently reverting 0058's fix back to the old
--     host-row check. This is cancel_event's current, live definition.
--
-- Net effect today: since create_event has not inserted a host row for any
-- event created after 0058, a Pro who creates an event today has no host
-- row and the current cancel_event's host-row check can never succeed for
-- them — they cannot cancel their own event.
--
-- This correction changes ONLY the ownership-check block, restoring what
-- 0058 originally established and what archive_event, unarchive_event, and
-- set_event_member_joinable all already do correctly today (confirmed by
-- direct comparison): Admin may cancel any eligible same-club event; Pro
-- may cancel only an event where events.created_by = auth.uid(); Member —
-- and any other or null role — is always rejected outright.
--
-- The check is explicitly role-exhaustive and null-safe, not a bare
-- `role <> 'admin'` fallthrough: a Member (or a caller with no resolvable
-- role at all) is rejected in its own guard before created_by is ever
-- consulted. This matters concretely because created_by is historical
-- event metadata, not a live grant of permission — a former Pro who has
-- since been demoted to Member, or whose role otherwise changed, must
-- never be able to cancel an event merely because their auth.uid() still
-- happens to match that event's created_by from before the role change.
-- Only a caller whose CURRENT role is 'pro' ever has created_by consulted
-- at all.
--
-- Every other line is reproduced byte-for-byte from the current (0063)
-- definition: the not_authenticated/event_not_found/event_archived guards,
-- the events status UPDATE, the linked-reservation cancellation UPDATE, the
-- offered-participant cancellation UPDATE, the audit_log insert, the
-- event_cancelled notification insert (recipients and mandatory gating),
-- and the `events` return type. No REVOKE/GRANT statements are added —
-- cancel_event has never had explicit grants in any prior migration (only
-- the default PUBLIC-execute-plus-internal-role-check posture), and that is
-- preserved unchanged here.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function cancel_event(p_event_id uuid)
returns events
language plpgsql security definer as $$
declare
  v_profile profiles%rowtype;
  v_event   events%rowtype;
  v_result  events%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_profile.club_id
      and status  = 'scheduled';
  if not found then raise exception 'event_not_found'; end if;

  -- Phase 21Q-D: reject cancellation of archived events (defense-in-depth).
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  -- Phase 30C1 correction (revised): restored to events.created_by =
  -- auth.uid(), matching 0058's original fix and archive_event/
  -- unarchive_event/set_event_member_joinable's already-correct
  -- convention. Works regardless of whether a host participant row exists
  -- (it never does, since 0058 stopped create_event from inserting one).
  --
  -- Null-safe and role-exhaustive: Member and every other/null role are
  -- rejected outright here, before created_by is ever consulted — a
  -- caller's historical created_by value must never substitute for their
  -- current role (e.g. a former Pro later demoted to Member).
  if v_profile.role is distinct from 'admin' and v_profile.role is distinct from 'pro' then
    raise exception 'insufficient_role';
  end if;

  if v_profile.role = 'pro' and v_event.created_by is distinct from auth.uid() then
    raise exception 'insufficient_role';
  end if;

  update events
    set status = 'cancelled', updated_at = now()
    where id = p_event_id
    returning * into v_result;

  update reservations set
    status            = 'cancelled',
    cancelled_at      = now(),
    cancelled_by      = auth.uid(),
    cancellation_kind = 'admin',
    updated_at        = now()
  where event_id = p_event_id
    and status in ('pending', 'confirmed');

  -- Phase 18A: cancel offered rows and clear offer_expires_at.
  -- Prevents offered members from attempting to accept after event cancellation.
  update event_participants
    set status           = 'cancelled',
        offer_expires_at = null,
        updated_at       = now()
    where event_id = p_event_id
      and status   = 'offered';

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'cancel_event',
    'event',
    p_event_id,
    jsonb_build_object('title', v_event.title, 'starts_at', v_event.starts_at)
  );

  -- Notify confirmed, waitlisted, and offered participants — all lose their spot.
  -- Phase 18A: 'offered' added to the status filter.
  insert into notifications (club_id, user_id, kind, body, metadata)
  select
    v_event.club_id,
    ep.profile_id,
    'event_cancelled',
    '"' || v_event.title || '" has been cancelled.',
    jsonb_build_object('event_id', p_event_id)
  from event_participants ep
  where ep.event_id = p_event_id
    and ep.status   in ('confirmed', 'waitlisted', 'offered');

  return v_result;
end;
$$;
