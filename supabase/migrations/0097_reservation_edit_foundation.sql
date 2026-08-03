-- 0097_reservation_edit_foundation.sql
-- Phase 30B1: Admin Reservation Editing and RPC-Backed Owner Cancellation.
--
-- Expand-deploy-contract, Phase 1 of 2 (expand). This migration is purely
-- additive and safe to apply while the currently-deployed production
-- application is still live:
--   - adds one new notification kind (reservation_rescheduled);
--   - adds two new SECURITY DEFINER RPCs (update_member_reservation,
--     cancel_member_reservation);
--   - does NOT drop or weaken reservations_cancel_own (the RLS policy that
--     backs the currently-deployed app's raw client UPDATE for member
--     self-cancel) — that policy is removed only in a later migration
--     (0098), after the Phase 30B1 application has deployed and passed a
--     bake period. See the Phase 30B corrected plan for the full
--     expand-deploy-contract rationale and deployment sequence.
--   - does NOT touch create_reservation, admin_cancel_reservation,
--     notify_reservation_cancelled_by_member, or any event/maintenance/
--     lesson/program RPC. notify_reservation_cancelled_by_member is left
--     in place for compatibility; the new application no longer calls it
--     directly (its notification body/semantics are ported inline into
--     cancel_member_reservation below).
--
-- Scope: reservations with reason = 'member_booking', status = 'confirmed',
-- starts_at in the future only. Event, maintenance-block, lesson, and
-- program editing are explicitly out of scope for this checkpoint.
--
-- Apply in Supabase SQL Editor (cloud only). Not applied by this checkpoint
-- — this file is created for migration review only.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. notifications_kind_check — add reservation_rescheduled
-- ═══════════════════════════════════════════════════════════════════════════
-- Same drop/re-add idiom as every prior kind-expansion migration (0014,
-- 0039, 0048, 0069, 0078). Every currently-allowed kind is preserved
-- verbatim, including the two newer lesson-admin kinds added in 0078
-- (lesson_provider_reassigned, lesson_admin_requested).

alter table public.notifications
  drop constraint if exists notifications_kind_check;

alter table public.notifications
  add constraint notifications_kind_check
  check (kind in (
    'reservation_confirmed',
    'reservation_cancelled_by_admin',
    'reservation_cancelled_by_member',
    'reservation_rescheduled',       -- Phase 30B1: material court/date/time edit
    'event_cancelled',
    'event_joined',
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
-- 2. notification_preferences_kind_check + update_notification_preference
--    allowlist — add reservation_rescheduled so users can opt out of EMAIL
--    delivery for it. This does not and cannot suppress the in-app row —
--    see update_member_reservation below, which never gates the in-app
--    insert behind user_pref_enabled(). Email delivery is gated downstream
--    by sendEmailNotification() (src/lib/email.ts), which already calls
--    user_pref_enabled() for every kind, mandatory or configurable alike —
--    no email.ts change is required for this to take effect.
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
  -- Phase 30B1 correction: resolve the caller's CURRENT active-club
  -- membership via current_user_club_id() rather than the legacy
  -- profiles.club_id lookup. current_user_club_id() is null both when
  -- auth.uid() is null (no session) and when the caller has no valid
  -- active, non-removed club membership — a single null check below
  -- correctly covers both required not_authenticated cases.
  select public.current_user_club_id() into v_club_id;

  if v_club_id is null then raise exception 'not_authenticated'; end if;

  if p_kind not in (
    'reservation_confirmed',
    'reservation_cancelled_by_member',
    'reservation_cancelled_by_admin',
    'reservation_rescheduled',
    'event_joined',
    'event_cancelled',
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
-- 3. update_member_reservation
-- ═══════════════════════════════════════════════════════════════════════════
-- Admin-only. Edits a single confirmed member_booking reservation in place —
-- one genuine UPDATE, never cancel-and-recreate. Scoped strictly to
-- reason = 'member_booking', status = 'confirmed', and both the existing and
-- proposed starts_at in the future.
--
-- Court/operating-hours/duration validation is a direct copy of the
-- currently-effective create_reservation logic (migration 0059 — confirmed
-- the last redefinition; no later migration touches it): date-specific
-- operating_hours_override checked first, weekly operating_hours as
-- fallback, active-same-club court requirement, and the 30/60/90/120-minute
-- duration whitelist. The member-only booking-window check from
-- create_reservation is intentionally NOT reproduced here — this RPC is
-- admin-only, and create_reservation itself only ever applies that check
-- for role = 'member'.
--
-- This re-validation only runs when court_id/starts_at/ends_at actually
-- change (v_scheduling_changed) — a notes/format/player_count/guest_names-
-- only edit is never rejected because club hours changed after the original
-- booking, and never re-runs the duration whitelist against an unmodified
-- time range.
--
-- The existing GiST exclusion constraint on reservations remains the sole
-- hard overlap authority — this function performs a genuine single-row
-- UPDATE (not delete+reinsert), so the constraint evaluates the edited row
-- only against every OTHER live row, never against its own prior state.
-- A conflict surfaces as Postgres error 23P01, mapped client-side.
--
-- No shared "_check_scheduling_conflict"-style helper is introduced here —
-- the operating-hours/override logic is duplicated inline, matching
-- create_reservation's own logic exactly, per the approved Phase 30B plan's
-- explicit instruction to keep this checkpoint local and defer extraction
-- until a second domain (events) needs the identical logic.
--
-- Preserves unconditionally: id, club_id, owner_user_id, created_by,
-- created_at, reason, status, and every cancellation_* column — none of
-- these appear in the UPDATE SET list, so they are structurally impossible
-- to change through this RPC.
--
-- Audit: one audit_log row per successful edit, with changed_fields and a
-- structured before/after diff of every editable column.
--
-- Notification: reservation_rescheduled is inserted UNCONDITIONALLY
-- (never wrapped in user_pref_enabled) whenever court_id, starts_at, or
-- ends_at changes — the in-app record can never be suppressed by
-- preference. No notification fires for notes/format/player_count/
-- guest_names-only changes, and none fires for a true no-op submission
-- (nothing changed at all — the function returns early before the UPDATE,
-- the audit insert, and the notification insert).
--
-- Returns jsonb: { reservation, changed_fields, notification_id }.
-- notification_id is null whenever no material notification was created
-- (no-op submission, or a non-material-only edit).
--
-- Error codes: not_authenticated, stale_club_context, insufficient_role,
-- reservation_not_found, reservation_not_editable,
-- cannot_edit_started_reservation, stale_edit_conflict, cannot_book_past,
-- invalid_duration, invalid_court, club_closed_this_day,
-- outside_operating_hours, plus Postgres 23P01 on a genuine court conflict.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.update_member_reservation(
  p_reservation_id       uuid,
  p_expected_club_id     uuid,
  p_expected_updated_at  timestamptz,
  p_court_id             uuid,
  p_starts_at            timestamptz,
  p_ends_at              timestamptz,
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
begin
  -- 1-4. Membership-native auth capture, admin-only.
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  -- Null-safe: v_club_id is already guaranteed non-null above (v_role comes
  -- from the same _current_user_active_membership() row), but IS DISTINCT
  -- FROM is used defensively rather than <>, which would silently fail to
  -- raise for a null v_role (NULL <> 'admin' evaluates to NULL, not TRUE).
  if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;

  -- Defensive shape guards — these parameters have no default and the table
  -- columns they map to are NOT NULL, but an explicit SQL null is still a
  -- distinct possible call shape from PostgREST.
  if p_court_id is null then raise exception 'invalid_court'; end if;
  if p_starts_at is null or p_ends_at is null then raise exception 'invalid_duration'; end if;

  -- 5-6. Lock the target row, scoped to this club.
  select * into v_before
    from reservations
    where id = p_reservation_id and club_id = v_club_id
    for update;
  if not found then raise exception 'reservation_not_found'; end if;

  -- 7-8. Scope: confirmed member bookings only.
  if v_before.reason <> 'member_booking' then raise exception 'reservation_not_editable'; end if;
  if v_before.status <> 'confirmed' then raise exception 'reservation_not_editable'; end if;

  -- 9. Existing start must still be in the future.
  if v_before.starts_at <= now() then raise exception 'cannot_edit_started_reservation'; end if;

  -- 10-11. Optimistic concurrency.
  if v_before.updated_at is distinct from p_expected_updated_at then
    raise exception 'stale_edit_conflict';
  end if;

  -- 12-13. Proposed range must be future and well-formed.
  if p_starts_at <= now() then raise exception 'cannot_book_past'; end if;
  if p_ends_at <= p_starts_at then raise exception 'invalid_duration'; end if;

  v_scheduling_changed :=
    p_court_id  is distinct from v_before.court_id
    or p_starts_at is distinct from v_before.starts_at
    or p_ends_at   is distinct from v_before.ends_at;

  -- 14-16, 24. Re-run scheduling validation only when court/start/end
  -- actually change, so a notes-only edit is never rejected because club
  -- hours changed after the original booking.
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
      -- An override exists for this date — it takes priority over weekly hours.
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
      -- No override for this date — apply normal weekly operating_hours.
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
  if p_court_id is distinct from v_before.court_id then
    v_changed_fields := array_append(v_changed_fields, 'court_id');
  end if;
  if p_starts_at is distinct from v_before.starts_at then
    v_changed_fields := array_append(v_changed_fields, 'starts_at');
  end if;
  if p_ends_at is distinct from v_before.ends_at then
    v_changed_fields := array_append(v_changed_fields, 'ends_at');
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
  -- audit row, no notification.
  if array_length(v_changed_fields, 1) is null then
    return jsonb_build_object(
      'reservation',     to_jsonb(v_before),
      'changed_fields',  to_jsonb(v_changed_fields),
      'notification_id', null
    );
  end if;

  -- 19-21. One genuine UPDATE — every non-editable column is absent from
  -- this SET list and therefore structurally preserved.
  update reservations set
    court_id     = p_court_id,
    starts_at    = p_starts_at,
    ends_at      = p_ends_at,
    format       = p_format,
    player_count = p_player_count,
    guest_names  = p_guest_names,
    notes        = p_notes,
    updated_at   = now()
  where id = p_reservation_id
  returning * into v_after;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id,
    auth.uid(),
    'update_member_reservation',
    'reservation',
    p_reservation_id,
    jsonb_build_object(
      'owner_user_id',  v_before.owner_user_id,
      'changed_fields', v_changed_fields,
      'before', jsonb_build_object(
        'court_id',     v_before.court_id,
        'starts_at',    v_before.starts_at,
        'ends_at',      v_before.ends_at,
        'format',       v_before.format,
        'player_count', v_before.player_count,
        'guest_names',  v_before.guest_names,
        'notes',        v_before.notes
      ),
      'after', jsonb_build_object(
        'court_id',     v_after.court_id,
        'starts_at',    v_after.starts_at,
        'ends_at',      v_after.ends_at,
        'format',       v_after.format,
        'player_count', v_after.player_count,
        'guest_names',  v_after.guest_names,
        'notes',        v_after.notes
      )
    )
  );

  v_notification_id := null;

  -- Mandatory in-app notification — fires exactly when court/date/time
  -- materially changed (v_scheduling_changed already captures exactly this
  -- condition). Never gated by user_pref_enabled: the in-app row can never
  -- be suppressed by preference. Email delivery is separately preference-
  -- gated downstream by sendEmailNotification() (src/lib/email.ts), which
  -- already calls user_pref_enabled() for every kind.
  if v_scheduling_changed then
    if v_tz is null then
      select timezone into v_tz from clubs where id = v_club_id;
    end if;

    insert into notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id,
      v_before.owner_user_id,
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
  uuid, uuid, timestamptz, uuid, timestamptz, timestamptz, text, int, text[], text
) from public, anon;
grant  execute on function public.update_member_reservation(
  uuid, uuid, timestamptz, uuid, timestamptz, timestamptz, text, int, text[], text
) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. cancel_member_reservation
-- ═══════════════════════════════════════════════════════════════════════════
-- Active Member or Pro self-cancellation of their own confirmed
-- member_booking reservation. Admin is explicitly rejected
-- (insufficient_role) — admin cancellation, including of an admin's own
-- booking, remains exclusively through admin_cancel_reservation (unchanged
-- by this migration). This is a deliberate consolidation: today an admin's
-- own booking is cancelled through two inconsistent paths depending on
-- which screen they're on (calendar's admin-mode branch always uses
-- admin_cancel_reservation; my-schedule's separate action lets an admin
-- fall into the same window-bypass branch as everyone else). Phase 30B1
-- makes this consistent everywhere.
--
-- Window/grace rule is a direct port of the logic currently duplicated in
-- TypeScript in both src/app/(app)/calendar/actions.ts (cancelMemberReservation)
-- and src/app/(app)/my-schedule/page.tsx (cancelReservation): cancellation
-- is allowed when the booking starts outside cancellation_window_hours, OR
-- when it was created within cancellation_grace_minutes — otherwise
-- cancellation_window_closed.
--
-- No p_expected_updated_at parameter: unlike update_member_reservation,
-- cancellation has exactly one valid target transition
-- (status='confirmed' -> 'cancelled'), and the FOR UPDATE row lock plus the
-- status='confirmed' precondition already prevent a lost update — a second
-- concurrent cancel attempt simply finds status no longer 'confirmed' and
-- fails with reservation_not_editable.
--
-- Notification: preserves the existing reservation_cancelled_by_member
-- semantics exactly (same kind, same user_pref_enabled preference gating,
-- same body shape) — ported inline from notify_reservation_cancelled_by_member
-- (0040/0043), which is left in the database unchanged for compatibility
-- but is no longer called by the new application code.
--
-- Returns jsonb: { reservation, notification_id }. notification_id is null
-- when the owner has this preference disabled.
--
-- Error codes: not_authenticated, stale_club_context, insufficient_role,
-- reservation_not_found, reservation_not_editable, cancellation_window_closed.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.cancel_member_reservation(
  p_reservation_id   uuid,
  p_expected_club_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id                     uuid;
  v_role                        text;
  v_before                      reservations%rowtype;
  v_after                       reservations%rowtype;
  v_cancellation_window_hours   integer;
  v_cancellation_grace_minutes  integer;
  v_tz               text;
  v_outside_window   boolean;
  v_within_grace     boolean;
  v_notification_id  uuid;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  -- Null-safe: NULL NOT IN ('member','pro') evaluates to NULL (not TRUE),
  -- which would silently fail to raise for a null v_role — reject null
  -- explicitly rather than relying on NOT IN alone.
  if v_role is null or v_role not in ('member', 'pro') then
    raise exception 'insufficient_role';
  end if;

  select * into v_before
    from reservations
    where id = p_reservation_id
      and club_id = v_club_id
      and owner_user_id = auth.uid()
    for update;
  if not found then raise exception 'reservation_not_found'; end if;

  if v_before.reason <> 'member_booking' then raise exception 'reservation_not_editable'; end if;
  if v_before.status <> 'confirmed' then raise exception 'reservation_not_editable'; end if;

  -- Correction: resolve deterministic, non-null fallback variables rather
  -- than coalescing at the point of use — the prior form tested
  -- coalesce(v_settings.cancellation_grace_minutes, 5) for "is grace
  -- enabled" but then built the interval directly from
  -- v_settings.cancellation_grace_minutes (unwrapped), so a missing
  -- club_settings row (v_settings entirely null) would produce a null
  -- interval and make the whole `and` expression evaluate to NULL —
  -- neither TRUE nor FALSE — which is falsy in the `if not ... and not
  -- ...` guard below and would incorrectly fail OPEN (silently permit a
  -- cancellation that should have been blocked, since `not NULL` is NULL,
  -- and `if NULL then` never executes). Resolving both settings into
  -- explicit non-null variables up front — defaulting to 24h/5min only
  -- when no club_settings row exists at all — closes that gap.
  select cancellation_window_hours, cancellation_grace_minutes
    into v_cancellation_window_hours, v_cancellation_grace_minutes
    from club_settings
    where club_id = v_club_id;

  if not found then
    v_cancellation_window_hours  := 24;
    v_cancellation_grace_minutes := 5;
  else
    v_cancellation_window_hours  := coalesce(v_cancellation_window_hours, 24);
    v_cancellation_grace_minutes := coalesce(v_cancellation_grace_minutes, 5);
  end if;

  v_outside_window := (v_before.starts_at - now())
    >= make_interval(hours => v_cancellation_window_hours);
  v_within_grace := v_cancellation_grace_minutes > 0
    and (now() - v_before.created_at)
        < make_interval(mins => v_cancellation_grace_minutes);

  if not v_outside_window and not v_within_grace then
    raise exception 'cancellation_window_closed';
  end if;

  update reservations set
    status             = 'cancelled',
    cancelled_at       = now(),
    cancelled_by       = auth.uid(),
    cancellation_kind  = 'member',
    updated_at         = now()
  where id = p_reservation_id
  returning * into v_after;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id,
    auth.uid(),
    'cancel_member_reservation',
    'reservation',
    p_reservation_id,
    jsonb_build_object(
      'court_id',      v_before.court_id,
      'owner_user_id', v_before.owner_user_id,
      'starts_at',     v_before.starts_at,
      'reason',        v_before.reason
    )
  );

  select timezone into v_tz from clubs where id = v_club_id;

  v_notification_id := null;

  -- Preserved exactly from notify_reservation_cancelled_by_member (0040/0043):
  -- same kind, same preference gating, same body shape.
  if user_pref_enabled(auth.uid(), 'reservation_cancelled_by_member') then
    insert into notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id,
      auth.uid(),
      'reservation_cancelled_by_member',
      'Your reservation on '
        || to_char(v_before.starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM')
        || ' was cancelled.',
      jsonb_build_object('reservation_id', p_reservation_id)
    )
    returning id into v_notification_id;
  end if;

  return jsonb_build_object(
    'reservation',     to_jsonb(v_after),
    'notification_id', v_notification_id
  );
end;
$$;

revoke execute on function public.cancel_member_reservation(uuid, uuid) from public, anon;
grant  execute on function public.cancel_member_reservation(uuid, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════════
-- Safe to roll back at any point before the Phase 30B1 application code is
-- deployed and exercised in production. Both RPCs are brand-new functions
-- with no other object depending on them, and the two CHECK-constraint
-- expansions only add a value — dropping them requires restating the prior
-- (15-value) list:
--
--   drop function if exists public.update_member_reservation(
--     uuid, uuid, timestamptz, uuid, timestamptz, timestamptz, text, int, text[], text
--   );
--   drop function if exists public.cancel_member_reservation(uuid, uuid);
--
--   alter table public.notifications drop constraint if exists notifications_kind_check;
--   alter table public.notifications add constraint notifications_kind_check
--     check (kind in (
--       'reservation_confirmed', 'reservation_cancelled_by_admin',
--       'reservation_cancelled_by_member', 'event_cancelled', 'event_joined',
--       'waitlist_promoted', 'waitlist_offer', 'announcement',
--       'lesson_request_received', 'lesson_request_proposed',
--       'lesson_request_confirmed', 'lesson_request_declined', 'lesson_cancelled',
--       'lesson_provider_reassigned', 'lesson_admin_requested'
--     ));
--
--   alter table public.notification_preferences drop constraint if exists notification_preferences_kind_check;
--   alter table public.notification_preferences add constraint notification_preferences_kind_check
--     check (kind in (
--       'reservation_confirmed', 'reservation_cancelled_by_member',
--       'reservation_cancelled_by_admin', 'event_joined', 'event_cancelled',
--       'waitlist_offer', 'waitlist_promoted', 'announcement',
--       'lesson_request_received', 'lesson_request_proposed',
--       'lesson_request_confirmed', 'lesson_request_declined', 'lesson_cancelled',
--       'lesson_provider_reassigned', 'lesson_admin_requested'
--     ));
--
--   -- update_notification_preference: re-apply the 0078 body (15-value
--   -- allowlist, no reservation_rescheduled).
--
-- This does not undo any reservation row already edited/cancelled by these
-- RPCs while they existed, nor any notification/audit row already written —
-- those are ordinary data rows, not schema, and are unaffected by rolling
-- back the functions/constraints above. reservations_cancel_own is
-- untouched by this migration in either direction.
