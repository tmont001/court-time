-- 0136_staff_event_operational_authorization.sql
-- Phase 34A completion — Events, part A.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Staff is a generic front-desk operator (admin+staff, "isOperator" in
-- src/lib/auth/roles.ts / current_user_is_operator() in SQL) — the same
-- concept already given Members/Roster, Reservations, and Lessons
-- authority in 0131-0135. This migration extends it to Events. Every body
-- below is copied verbatim from the Production pg_get_functiondef output
-- supplied directly by the operator (2026-08-20) — not reconstructed from
-- migration history. The ONLY change per function is the caller
-- role-allowlist widening described in its own header comment; every
-- validation, locking, capacity, waitlist, conflict, notification, and
-- audit invariant is reproduced byte-for-byte.
--
-- Pro's existing behavior is preserved exactly everywhere it appears:
--   - Functions with no Pro-ownership restriction (create_event,
--     get_event_roster, get_event_eligible_members, admin_add_guest,
--     admin_add_roster_participant, admin_remove_guest,
--     admin_remove_participant, admin_remove_roster_participant,
--     admin_force_confirm(_roster_participant), admin_offer_spot
--     (_roster_participant), admin_expire_offer(_roster_participant),
--     mark_attendance_roster_participant, mark_attendance_guest): Pro's
--     existing unrestricted access is untouched; Staff is simply added to
--     the same allowlist, alongside Admin — Staff never inherits any
--     Pro-specific scoping because there isn't any here to inherit.
--   - Functions WITH a Pro-ownership restriction (cancel_event,
--     set_event_member_joinable, archive_event, unarchive_event): the
--     ownership check is a separate, second `if v_profile.role = 'pro'
--     and v_event.created_by <> auth.uid() then ...` guard that only ever
--     fires when the caller's role literally equals 'pro'. Widening the
--     FIRST (allowlist) check to admit 'staff' does not change this
--     second check's condition at all — it structurally can never
--     evaluate true for a Staff caller, so Staff receives the same
--     unrestricted (non-owner-scoped) access Admin already has, exactly
--     as required ("Staff is generic operator and should not inherit
--     Pro creator-only scoping").
--
-- Classification of the full Production inventory supplied for this
-- checkpoint (see the completion report for the full trace):
--   - update_event was ALREADY admin-only (no Pro path at all) —
--     widened to admin+staff; Pro's absence from this function is
--     unchanged.
--   - mark_attendance (the profile_id-keyed variant) needs NO change: its
--     existing gate is `if v_actor.role = 'member' then raise exception
--     ...` — an EXCLUSION, not an allowlist — so a Staff caller already
--     passes today with no ownership restriction (the Pro-ownership check
--     inside only fires `if v_actor.role = 'pro'`). Confirmed live (called
--     from EventRosterSheet.tsx for claimed-Member attendance) and left
--     completely untouched — not reproduced in this migration at all, to
--     keep the delta to exactly what's required.
--   - admin_add_member and admin_add_roster_member_to_event are DEAD:
--     defined in src/app/(app)/admin/events/actions.ts but never imported
--     or called from any component (grep-verified against the full
--     src/ tree). The live "Add Member" path is exclusively
--     admin_add_roster_participant (called from EventRosterSheet.tsx).
--     Left untouched per "do not widen dead/unused compatibility
--     functions merely because they exist."
--
-- No DROP anywhere in this migration: every CREATE OR REPLACE targets the
-- exact live function identity: signature, return type, SECURITY DEFINER,
-- and search_path (including the handful of functions Production shows
-- with NO SET search_path clause at all — create_event, archive_event,
-- unarchive_event — reproduced exactly as supplied, not "fixed" to match
-- the newer SET search_path convention, since that would be an
-- unrequested, unrelated change). No REVOKE/GRANT needed — none of these
-- functions' authenticated-callable posture changes.
--
-- Event Type configuration (src/app/(app)/admin/settings/EventTypesSection.tsx)
-- remains completely untouched and admin-only — no function in this
-- migration is part of that surface.
--
-- Does not modify 0131-0135. Not applied by this checkpoint. Apply in
-- Supabase SQL Editor (cloud only).
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ─────────────────────────────────────────────────────────────────────────
-- create_event — allowlist widened admin+pro -> admin+pro+staff. No
-- ownership restriction exists in this function (nothing to own yet).
-- Production has no SET search_path clause here — reproduced as-is.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_event(p_event_type_id uuid, p_title text, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_court_ids uuid[], p_description text DEFAULT NULL::text, p_capacity integer DEFAULT NULL::integer, p_notes text DEFAULT NULL::text, p_member_joinable boolean DEFAULT true)
 RETURNS events
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_profile  profiles%rowtype;
  v_et       event_types%rowtype;
  v_event    events%rowtype;
  v_court_id uuid;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.status <> 'active' then raise exception 'account_inactive'; end if;

  if v_profile.role not in ('pro', 'admin', 'staff') then
    raise exception 'insufficient_role';
  end if;

  if p_ends_at <= p_starts_at then raise exception 'invalid_duration'; end if;
  -- Phase 21N-B: past-date guard removed. Admins and pros may create events
  -- in the past for record-keeping purposes.

  select * into v_et
    from event_types
    where id      = p_event_type_id
      and club_id = v_profile.club_id;
  if not found then raise exception 'event_type_not_found'; end if;

  insert into events (
    club_id, event_type_id, title, description,
    starts_at, ends_at, capacity, court_count, status, created_by, member_joinable
  ) values (
    v_profile.club_id, v_et.id, p_title, p_description,
    p_starts_at, p_ends_at,
    coalesce(p_capacity, v_et.default_capacity),
    array_length(p_court_ids, 1),
    'scheduled', auth.uid(),
    coalesce(p_member_joinable, true)
  )
  returning * into v_event;

  -- Phase 21I-D: host participant row not inserted.
  -- The creator is recorded in events.created_by for ownership/audit;
  -- they join the roster only if explicitly added via the roster UI.

  foreach v_court_id in array p_court_ids loop
    insert into reservations (
      club_id, court_id, owner_user_id,
      starts_at, ends_at, status, reason, event_id, created_by, notes
    ) values (
      v_profile.club_id, v_court_id, auth.uid(),
      p_starts_at, p_ends_at, 'confirmed', 'event', v_event.id, auth.uid(), p_notes
    );
  end loop;

  return v_event;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- update_event — was admin-only (no Pro path at all); widened admin ->
-- admin+staff. Pro's absence from this function is unchanged.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_event(p_event_id uuid, p_expected_club_id uuid, p_expected_updated_at timestamp with time zone, p_title text, p_event_type_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_court_ids uuid[], p_capacity integer, p_description text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_notify_roster_member_id uuid;
  v_notify_member_id     uuid;
  v_new_notification_id   uuid;
  v_exception_transitioned boolean;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is distinct from 'admin' and v_role is distinct from 'staff' then raise exception 'insufficient_role'; end if;

  select * into v_before
    from events
    where id = p_event_id and club_id = v_club_id
    for update;
  if not found then raise exception 'event_not_found'; end if;

  if v_before.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_before.archived_at is not null then raise exception 'event_archived'; end if;
  if v_before.starts_at <= now() then raise exception 'event_started'; end if;

  if v_before.updated_at is distinct from p_expected_updated_at then
    raise exception 'stale_edit_conflict';
  end if;

  if v_before.program_id is not null then
    if p_title is distinct from v_before.title
       or p_event_type_id is distinct from v_before.event_type_id
       or p_description is distinct from v_before.description
    then
      raise exception 'program_session_field_not_editable';
    end if;
  end if;

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

  -- Capacity floor: confirmed/offered participants (role='participant') +
  -- active guests only (Phase 33E2).
  select
    (select count(*) from event_participants
       where event_id = p_event_id and status in ('confirmed', 'offered') and role = 'participant')
    + (select count(*) from event_guests where event_id = p_event_id and status = 'active')
    into v_occupied;

  if p_capacity < v_occupied then raise exception 'capacity_below_participants'; end if;

  if exists (
    select 1 from unnest(p_court_ids) as t(id)
    where not exists (
      select 1 from courts c
      where c.id = t.id and c.club_id = v_club_id and c.is_active = true
    )
  ) then
    raise exception 'invalid_court';
  end if;

  with locked_res as (
    select * from reservations
    where event_id = p_event_id and reason = 'event' and status in ('pending', 'confirmed')
    for update
  )
  select array_agg(court_id) into v_existing_court_ids from locked_res;
  v_existing_court_ids := coalesce(v_existing_court_ids, '{}');

  select notes into v_canonical_notes
    from reservations
    where event_id = p_event_id and reason = 'event' and status in ('pending', 'confirmed')
    order by (notes is null), court_id
    limit 1;

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

  if array_length(v_changed_fields, 1) is null then
    return jsonb_build_object(
      'event',          to_jsonb(v_before),
      'changed_fields', to_jsonb(v_changed_fields),
      'notifications',  '[]'::jsonb
    );
  end if;

  if v_time_changed then
    update reservations
      set starts_at = p_starts_at, ends_at = p_ends_at, updated_at = now()
      where event_id = p_event_id and reason = 'event' and status in ('pending', 'confirmed')
        and court_id = any(v_retained_ids);
  end if;

  update reservations
    set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
        cancellation_kind = 'system', updated_at = now()
    where event_id = p_event_id and reason = 'event' and status in ('pending', 'confirmed')
      and court_id = any(v_removed_ids);

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

  if p_event_type_id is distinct from v_before.event_type_id then
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

  if p_capacity > v_before.capacity then
    perform expire_stale_offers_for_event(p_event_id, v_club_id, v_after.title);
    perform advance_waitlist_offer(p_event_id, v_club_id, v_after.title);
  end if;

  if 'title' = any(v_changed_fields)
     or 'event_type_id' = any(v_changed_fields)
     or 'starts_at' = any(v_changed_fields)
     or 'ends_at' = any(v_changed_fields)
     or 'court_ids' = any(v_changed_fields)
     or 'capacity' = any(v_changed_fields)
  then
    for v_notify_roster_member_id in
      select roster_member_id from event_participants
      where event_id = p_event_id and status in ('confirmed', 'waitlisted', 'offered')
    loop
      select claimed_by into v_notify_member_id
        from roster_members
       where id = v_notify_roster_member_id;

      if v_notify_member_id is not null then
        insert into notifications (club_id, user_id, kind, body, metadata)
        values (
          v_club_id,
          v_notify_member_id,
          'event_updated',
          '"' || v_after.title || '" was updated — check the calendar for the latest details.',
          jsonb_build_object('event_id', p_event_id)
        )
        returning id into v_new_notification_id;

        v_notifications := v_notifications || jsonb_build_object(
          'notification_id', v_new_notification_id,
          'user_id',          v_notify_member_id
        );
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'event',          to_jsonb(v_after),
    'changed_fields', to_jsonb(v_changed_fields),
    'notifications',  v_notifications
  );
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- cancel_event — allowlist widened admin+pro -> admin+pro+staff. The
-- Pro-ownership guard immediately below only ever fires for role='pro' —
-- untouched, and structurally cannot apply to a Staff caller.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancel_event(p_event_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_profile               public.profiles%rowtype;
  v_event                 public.events%rowtype;
  v_result                public.events%rowtype;
  v_affected_roster_ids   uuid[];
  v_affected_member_ids   uuid[];
  v_notifications         jsonb;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  select * into v_event
    from public.events
    where id      = p_event_id
      and club_id = v_profile.club_id
      and status  = 'scheduled';
  if not found then raise exception 'event_not_found'; end if;

  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  if v_profile.role is distinct from 'admin' and v_profile.role is distinct from 'pro' and v_profile.role is distinct from 'staff' then
    raise exception 'insufficient_role';
  end if;

  if v_profile.role = 'pro' and v_event.created_by is distinct from auth.uid() then
    raise exception 'insufficient_role';
  end if;

  -- Capture the exact affected roster identity set BEFORE any participant
  -- status mutation runs — same ordering-safety reasoning as before
  -- (0102), now keyed by the durable roster_member_id (NOT NULL) rather
  -- than the possibly-null profile_id.
  select coalesce(array_agg(roster_member_id), '{}') into v_affected_roster_ids
    from public.event_participants
    where event_id = p_event_id
      and status   in ('confirmed', 'waitlisted', 'offered');

  update public.events
    set status = 'cancelled', updated_at = now()
    where id = p_event_id
    returning * into v_result;

  update public.reservations set
    status            = 'cancelled',
    cancelled_at      = now(),
    cancelled_by      = auth.uid(),
    cancellation_kind = 'admin',
    updated_at        = now()
  where event_id = p_event_id
    and status in ('pending', 'confirmed');

  update public.event_participants
    set status           = 'cancelled',
        offer_expires_at = null,
        updated_at       = now()
    where event_id = p_event_id
      and status   = 'offered';

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'cancel_event',
    'event',
    p_event_id,
    jsonb_build_object('title', v_event.title, 'starts_at', v_event.starts_at)
  );

  -- Phase 33D2: resolve CURRENT accounts fresh via roster_members.
  -- claimed_by, filtering out still-unclaimed identities BEFORE the
  -- notification insert — this is what makes the NULL-user_id crash
  -- structurally impossible, rather than relying on a NOT NULL roster_
  -- member_id guarantee upstream alone.
  select coalesce(array_agg(claimed_by), '{}') into v_affected_member_ids
    from public.roster_members
    where id = any(v_affected_roster_ids)
      and claimed_by is not null;

  with ins as (
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    select
      v_event.club_id,
      mid,
      'event_cancelled',
      '"' || v_event.title || '" has been cancelled.',
      jsonb_build_object('event_id', p_event_id)
    from unnest(v_affected_member_ids) as mid
    returning id, user_id
  )
  select coalesce(
    jsonb_agg(jsonb_build_object('notification_id', id, 'user_id', user_id)),
    '[]'::jsonb
  )
  into v_notifications
  from ins;

  return jsonb_build_object(
    'event',         to_jsonb(v_result),
    'notifications', v_notifications
  );
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- get_event_roster — allowlist widened admin+pro -> admin+pro+staff. No
-- ownership restriction — every operator sees the full roster, unchanged.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_event_roster(p_event_id uuid)
 RETURNS TABLE(profile_id uuid, display_name text, role text, status text, attendance_status text, offer_expires_at timestamp with time zone, waitlist_position integer, roster_member_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_profile profiles%rowtype;
  v_event   events%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.role not in ('admin', 'pro', 'staff') then
    raise exception 'insufficient_role';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_profile.club_id;
  if not found then raise exception 'event_not_found'; end if;

  return query
    with ranked as (
      select
        ep.profile_id,
        ep.roster_member_id,
        ep.role,
        ep.status,
        ep.attendance_status,
        ep.offer_expires_at,
        ep.created_at,
        row_number() over (
          partition by ep.status
          order by ep.created_at asc
        ) as pos
      from event_participants ep
      where ep.event_id = p_event_id
        and ep.status   in ('confirmed', 'waitlisted', 'offered')
    ),
    member_rows as (
      select
        r.profile_id,
        coalesce(
          nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''),
          nullif(trim(concat_ws(' ', rm.first_name, rm.last_name)), ''),
          'Unknown'
        )::text                                                       as display_name,
        r.role::text,
        r.status::text,
        r.attendance_status::text,
        r.offer_expires_at,
        case when r.status = 'waitlisted' then r.pos::int else null end
                                                                      as waitlist_position,
        r.roster_member_id,
        case r.status
          when 'confirmed'  then 1
          when 'offered'    then 2
          when 'waitlisted' then 3
          else 4
        end                                                           as sort_group,
        r.created_at
      from ranked r
      left join profiles p on p.id = r.profile_id
      left join roster_members rm on rm.id = r.roster_member_id
    ),
    guest_rows as (
      select
        eg.id                       as profile_id,
        eg.display_name::text,
        'guest'::text               as role,
        'confirmed'::text           as status,
        eg.attendance_status::text  as attendance_status,
        null::timestamptz           as offer_expires_at,
        null::int                   as waitlist_position,
        eg.roster_member_id,
        4                           as sort_group,
        eg.created_at
      from event_guests eg
      where eg.event_id = p_event_id
        and eg.status    = 'active'
    )
    select
      c.profile_id,
      c.display_name,
      c.role,
      c.status,
      c.attendance_status,
      c.offer_expires_at,
      c.waitlist_position,
      c.roster_member_id
    from (
      select * from member_rows
      union all
      select * from guest_rows
    ) c
    order by c.sort_group, c.created_at asc;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- get_event_eligible_members — allowlist widened admin+pro -> admin+pro+
-- staff.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_event_eligible_members(p_event_id uuid)
 RETURNS TABLE(roster_member_id uuid, profile_id uuid, display_name text, has_account boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id uuid;
  v_role    text;
  v_event   public.events%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role is null or v_role not in ('admin', 'pro', 'staff') then raise exception 'admin_required'; end if;

  select * into v_event
    from public.events
   where id      = p_event_id
     and club_id = v_club_id;
  if not found then raise exception 'event_not_found'; end if;

  return query
    select
      rm.id                                                                            as roster_member_id,
      rm.claimed_by                                                                    as profile_id,
      coalesce(nullif(trim(concat_ws(' ', rm.first_name, rm.last_name)), ''), 'Unknown')::text
                                                                                        as display_name,
      (rm.claimed_by is not null)                                                      as has_account
    from public.roster_members rm
    where rm.club_id = v_club_id
      and rm.role     = 'member'
      and rm.status   = 'active'
      and not exists (
        select 1 from public.event_participants ep
        where ep.event_id         = p_event_id
          and ep.roster_member_id = rm.id
          and ep.status           in ('confirmed', 'offered', 'waitlisted')
      )
    order by rm.last_name asc nulls last, rm.first_name asc nulls last, rm.id asc;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- set_event_member_joinable — allowlist widened admin+pro -> admin+pro+
-- staff. Pro-ownership guard untouched, cannot apply to Staff.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_event_member_joinable(p_event_id uuid, p_member_joinable boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_profile profiles%rowtype;
  v_event   events%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role not in ('admin', 'pro', 'staff') then raise exception 'insufficient_role'; end if;

  -- Explicit null checks — avoid silent no-op from null equality.
  if p_event_id is null then raise exception 'event_not_found'; end if;
  if p_member_joinable is null then raise exception 'invalid_value'; end if;

  select * into v_event
  from events
  where id = p_event_id and club_id = v_profile.club_id;
  if not found then raise exception 'event_not_found'; end if;

  if v_event.status = 'cancelled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  -- Server-side future guard. The UI already restricts this, but a stale client
  -- or direct RPC call must not be able to change a started event.
  if v_event.starts_at <= now() then raise exception 'event_started'; end if;

  -- Pros may only change events they created.
  if v_profile.role = 'pro' and v_event.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  update events
  set member_joinable = p_member_joinable,
      updated_at      = now()
  where id = p_event_id;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'set_event_member_joinable',
    'event',
    p_event_id,
    jsonb_build_object('member_joinable', p_member_joinable)
  );
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- archive_event — allowlist widened admin+pro -> admin+pro+staff.
-- Pro-ownership guard untouched, cannot apply to Staff. No SET search_path
-- in Production — reproduced as-is.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.archive_event(p_event_id uuid)
 RETURNS events
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_profile profiles%rowtype;
  v_event   events%rowtype;
  v_result  events%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.status <> 'active' then raise exception 'account_inactive'; end if;

  if v_profile.role not in ('admin', 'pro', 'staff') then
    raise exception 'insufficient_role';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_profile.club_id;
  if not found then raise exception 'event_not_found'; end if;

  -- Admins can archive any event in the club.
  -- Pros can archive only events they created.
  if v_profile.role = 'pro' and v_event.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_event.archived_at is not null then
    raise exception 'already_archived';
  end if;

  -- Block archiving future scheduled events; cancelled events are always allowed.
  if v_event.status = 'scheduled' and v_event.starts_at > now() then
    raise exception 'event_not_past';
  end if;

  update events
    set archived_at = now(),
        archived_by = auth.uid(),
        updated_at  = now()
    where id = p_event_id
    returning * into v_result;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'archive_event',
    'event',
    p_event_id,
    jsonb_build_object(
      'title',     v_event.title,
      'starts_at', v_event.starts_at,
      'status',    v_event.status
    )
  );

  return v_result;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- unarchive_event — allowlist widened admin+pro -> admin+pro+staff.
-- Pro-ownership guard untouched, cannot apply to Staff. No SET search_path
-- in Production — reproduced as-is.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.unarchive_event(p_event_id uuid)
 RETURNS events
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_profile profiles%rowtype;
  v_event   events%rowtype;
  v_result  events%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.status <> 'active' then raise exception 'account_inactive'; end if;

  if v_profile.role not in ('admin', 'pro', 'staff') then
    raise exception 'insufficient_role';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_profile.club_id;
  if not found then raise exception 'event_not_found'; end if;

  -- Admins can unarchive any event in the club.
  -- Pros can unarchive only events they created.
  if v_profile.role = 'pro' and v_event.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_event.archived_at is null then
    raise exception 'not_archived';
  end if;

  update events
    set archived_at = null,
        archived_by = null,
        updated_at  = now()
    where id = p_event_id
    returning * into v_result;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'unarchive_event',
    'event',
    p_event_id,
    jsonb_build_object(
      'title',     v_event.title,
      'starts_at', v_event.starts_at,
      'status',    v_event.status
    )
  );

  return v_result;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- admin_add_guest — allowlist widened admin+pro -> admin+pro+staff.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_add_guest(p_event_id uuid, p_display_name text)
 RETURNS event_guests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor        profiles%rowtype;
  v_event        events%rowtype;
  v_name         text;
  v_occupied     int;
  v_was_over_cap boolean;
  v_result       event_guests%rowtype;
begin
  select * into v_actor from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_actor.role not in ('admin', 'pro', 'staff') then
    raise exception 'admin_required';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_actor.club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  v_name := trim(p_display_name);
  if char_length(v_name) < 1 then raise exception 'invalid_guest_name'; end if;

  select
    (select count(*)
       from event_participants
       where event_id = p_event_id
         and status   in ('confirmed', 'offered')
         and role     = 'participant')
    +
    (select count(*)
       from event_guests
       where event_id = p_event_id
         and status   = 'active')
    into v_occupied;

  v_was_over_cap := v_occupied >= v_event.capacity;

  insert into event_guests (event_id, display_name, added_by)
  values (p_event_id, v_name, auth.uid())
  returning * into v_result;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'admin_add_guest',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_title',       v_event.title,
      'guest_id',          v_result.id,
      'guest_name',        v_name,
      'was_over_capacity', v_was_over_cap
    )
  );

  return v_result;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- admin_add_roster_participant — the sole live "Add Member" path (both
-- claimed and no-account, via p_roster_member_id). Allowlist widened
-- admin+pro -> admin+pro+staff.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_add_roster_participant(p_event_id uuid, p_expected_club_id uuid, p_roster_member_id uuid)
 RETURNS event_participants
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id    uuid;
  v_role       text;
  v_event      public.events%rowtype;
  v_roster     public.roster_members%rowtype;
  v_member_id  uuid;
  v_existing   public.event_participants%rowtype;
  v_existing_found boolean;
  v_occupied   int;
  v_new_status text;
  v_result     public.event_participants%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is null or v_role not in ('admin', 'pro', 'staff') then raise exception 'admin_required'; end if;

  select * into v_event
    from public.events
   where id      = p_event_id
     and club_id = v_club_id
   for update;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_club_id;
  if not found then raise exception 'roster_member_not_found'; end if;

  v_member_id := v_roster.claimed_by;

  select * into v_existing
    from public.event_participants
   where event_id = p_event_id
     and (
       roster_member_id = p_roster_member_id
       or (v_member_id is not null and profile_id = v_member_id)
     )
   for update;
  v_existing_found := found;

  if v_existing_found and v_existing.status in ('confirmed', 'waitlisted', 'offered') then
    raise exception 'already_joined';
  end if;

  v_occupied := public._event_effective_occupancy(
    p_event_id,
    case when v_existing_found then v_existing.id else null end
  );

  v_new_status := case when v_occupied >= v_event.capacity then 'waitlisted' else 'confirmed' end;

  if v_existing_found then
    update public.event_participants
       set status           = v_new_status,
           profile_id       = v_member_id,
           roster_member_id = p_roster_member_id,
           offer_expires_at = null,
           updated_at       = now()
     where id = v_existing.id
    returning * into v_result;
  else
    insert into public.event_participants (event_id, profile_id, roster_member_id, role, status)
    values (p_event_id, v_member_id, p_roster_member_id, 'participant', v_new_status)
    returning * into v_result;
  end if;

  if v_result.id is null then
    raise exception 'event_participant_write_failed';
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'admin_add_roster_participant', 'event', p_event_id,
    jsonb_build_object(
      'roster_member_id', p_roster_member_id,
      'member_id',        v_member_id,
      'member_claimed',   v_member_id is not null,
      'final_status',     v_new_status
    )
  );

  return v_result;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- admin_remove_guest — allowlist widened admin+pro -> admin+pro+staff.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_remove_guest(p_event_id uuid, p_guest_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor        profiles%rowtype;
  v_event        events%rowtype;
  v_guest        event_guests%rowtype;
  v_occupied     int;
  v_rows_updated int;
begin
  select * into v_actor from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_actor.role not in ('admin', 'pro', 'staff') then
    raise exception 'admin_required';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_actor.club_id
    for update;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  select * into v_guest
    from event_guests
    where id       = p_guest_id
      and event_id = p_event_id
      and status   = 'active';
  if not found then raise exception 'guest_not_found'; end if;

  update event_guests
     set status       = 'cancelled',
         cancelled_at = now(),
         cancelled_by = auth.uid()
   where id       = p_guest_id
     and status   = 'active';

  get diagnostics v_rows_updated = row_count;
  if v_rows_updated = 0 then raise exception 'guest_not_found'; end if;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'admin_remove_guest',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_title', v_event.title,
      'guest_id',    p_guest_id,
      'guest_name',  v_guest.display_name
    )
  );

  select
    (select count(*)
       from event_participants
       where event_id = p_event_id
         and status   in ('confirmed', 'offered')
         and role     = 'participant')
    +
    (select count(*)
       from event_guests
       where event_id = p_event_id
         and status   = 'active')
    into v_occupied;

  if v_occupied < v_event.capacity then
    perform expire_stale_offers_for_event(p_event_id, v_actor.club_id, v_event.title);
    perform advance_waitlist_offer(p_event_id, v_actor.club_id, v_event.title);
  end if;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- admin_remove_participant — allowlist widened admin+pro -> admin+pro+
-- staff. Live: branched to from EventRosterSheet.tsx for claimed Members.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_remove_participant(p_event_id uuid, p_profile_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor      profiles%rowtype;
  v_event      events%rowtype;
  v_old_status text;
begin
  select * into v_actor from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_actor.role not in ('admin', 'pro', 'staff') then
    raise exception 'admin_required';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_actor.club_id
    for update;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  select status into v_old_status
    from event_participants
    where event_id   = p_event_id
      and profile_id = p_profile_id
      and status     in ('confirmed', 'offered', 'waitlisted');
  if not found then raise exception 'participant_not_found'; end if;

  update event_participants
    set status           = 'cancelled',
        offer_expires_at = null,
        updated_at       = now()
    where event_id   = p_event_id
      and profile_id = p_profile_id;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'admin_remove_participant',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_title',        v_event.title,
      'removed_profile_id', p_profile_id,
      'previous_status',    v_old_status
    )
  );

  if v_old_status in ('confirmed', 'offered') then
    perform expire_stale_offers_for_event(p_event_id, v_actor.club_id, v_event.title);
    perform advance_waitlist_offer(p_event_id, v_actor.club_id, v_event.title);
  end if;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- admin_remove_roster_participant — allowlist widened admin+pro ->
-- admin+pro+staff. Live: branched to for no-account Members.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_remove_roster_participant(p_event_id uuid, p_expected_club_id uuid, p_roster_member_id uuid)
 RETURNS event_participants
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id      uuid;
  v_role         text;
  v_event        public.events%rowtype;
  v_participant_id uuid;
  v_old_status   text;
  v_result       public.event_participants%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is null or v_role not in ('admin', 'pro', 'staff') then raise exception 'admin_required'; end if;

  select * into v_event
    from public.events
   where id      = p_event_id
     and club_id = v_club_id
   for update;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  select id, status into v_participant_id, v_old_status
    from public.event_participants
   where event_id         = p_event_id
     and roster_member_id = p_roster_member_id
     and status            in ('confirmed', 'waitlisted', 'offered');
  if not found then raise exception 'participant_not_found'; end if;

  update public.event_participants
     set status           = 'cancelled',
         offer_expires_at = null,
         updated_at       = now()
   where id = v_participant_id
  returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'admin_remove_roster_participant', 'event', p_event_id,
    jsonb_build_object(
      'roster_member_id', p_roster_member_id,
      'previous_status',  v_old_status
    )
  );

  if v_old_status in ('confirmed', 'offered') then
    perform public.expire_stale_offers_for_event(p_event_id, v_club_id, v_event.title, auth.uid());
    perform public.advance_waitlist_offer(p_event_id, v_club_id, v_event.title, auth.uid());
  end if;

  return v_result;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- admin_force_confirm — allowlist widened admin+pro -> admin+pro+staff.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_force_confirm(p_event_id uuid, p_profile_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor            public.profiles%rowtype;
  v_event            public.events%rowtype;
  v_old_status       text;
  v_occupied         int;
  v_was_over_cap     boolean;
  v_result           public.event_participants%rowtype;
  v_notification_id  uuid;
begin
  select * into v_actor from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_actor.role not in ('admin', 'pro', 'staff') then
    raise exception 'admin_required';
  end if;

  select * into v_event
    from public.events
    where id      = p_event_id
      and club_id = v_actor.club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  if not exists (
    select 1 from public.profiles
    where id      = p_profile_id
      and club_id = v_actor.club_id
      and status  = 'active'
  ) then
    if not exists (select 1 from public.profiles where id = p_profile_id and club_id = v_actor.club_id) then
      raise exception 'member_not_found';
    end if;
    raise exception 'member_inactive';
  end if;

  select status into v_old_status
    from public.event_participants
    where event_id   = p_event_id
      and profile_id = p_profile_id;
  if not found then raise exception 'participant_not_found'; end if;
  if v_old_status = 'confirmed' then raise exception 'already_joined'; end if;

  select
    (select count(*)
       from public.event_participants
       where event_id = p_event_id
         and status   in ('confirmed', 'offered')
         and role     = 'participant')
    +
    (select count(*)
       from public.event_guests
       where event_id = p_event_id
         and status   = 'active')
    into v_occupied;

  v_was_over_cap := v_occupied >= v_event.capacity;

  perform set_config('courttime.skip_capacity_guard', 'true', true);

  update public.event_participants
    set status           = 'confirmed',
        offer_expires_at = null,
        updated_at       = now()
    where event_id   = p_event_id
      and profile_id = p_profile_id
    returning * into v_result;

  perform set_config('courttime.skip_capacity_guard', 'false', true);

  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_actor.club_id,
    p_profile_id,
    'waitlist_promoted',
    'An admin confirmed your spot in "' || v_event.title || '".',
    jsonb_build_object('event_id', p_event_id, 'triggered_by', auth.uid())
  )
  returning id into v_notification_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'admin_force_confirm',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_title',       v_event.title,
      'profile_id',        p_profile_id,
      'previous_status',   v_old_status,
      'was_over_capacity', v_was_over_cap
    )
  );

  return jsonb_build_object(
    'participant',      to_jsonb(v_result),
    'notification_id',  v_notification_id
  );
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- admin_force_confirm_roster_participant — allowlist widened admin+pro ->
-- admin+pro+staff.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_force_confirm_roster_participant(p_event_id uuid, p_expected_club_id uuid, p_roster_member_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id          uuid;
  v_role             text;
  v_event            public.events%rowtype;
  v_roster           public.roster_members%rowtype;
  v_current_member_id uuid;
  v_participant_id   uuid;
  v_old_status       text;
  v_occupied         int;
  v_was_over_cap     boolean;
  v_result           public.event_participants%rowtype;
  v_notification_id  uuid;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is null or v_role not in ('admin', 'pro', 'staff') then raise exception 'admin_required'; end if;

  select * into v_event
    from public.events
   where id      = p_event_id
     and club_id = v_club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_club_id;
  if not found then raise exception 'roster_member_not_found'; end if;
  v_current_member_id := v_roster.claimed_by;

  select id, status into v_participant_id, v_old_status
    from public.event_participants
   where event_id         = p_event_id
     and roster_member_id = p_roster_member_id;
  if not found then raise exception 'participant_not_found'; end if;
  if v_old_status = 'confirmed' then raise exception 'already_joined'; end if;

  select
    (select count(*)
       from public.event_participants
       where event_id = p_event_id
         and status   in ('confirmed', 'offered')
         and role     = 'participant')
    +
    (select count(*)
       from public.event_guests
       where event_id = p_event_id
         and status   = 'active')
    into v_occupied;
  v_was_over_cap := v_occupied >= v_event.capacity;

  perform set_config('courttime.skip_capacity_guard', 'true', true);

  update public.event_participants
     set status           = 'confirmed',
         offer_expires_at = null,
         updated_at       = now()
   where id = v_participant_id
  returning * into v_result;

  perform set_config('courttime.skip_capacity_guard', 'false', true);

  if v_current_member_id is not null then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id, v_current_member_id, 'waitlist_promoted',
      'An admin confirmed your spot in "' || v_event.title || '".',
      jsonb_build_object('event_id', p_event_id, 'triggered_by', auth.uid())
    )
    returning id into v_notification_id;
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'admin_force_confirm', 'event', p_event_id,
    jsonb_build_object(
      'event_title',       v_event.title,
      'roster_member_id',  p_roster_member_id,
      'previous_status',   v_old_status,
      'was_over_capacity', v_was_over_cap
    )
  );

  return jsonb_build_object('participant', to_jsonb(v_result), 'notification_id', v_notification_id);
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- admin_offer_spot — allowlist widened admin+pro -> admin+pro+staff.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_offer_spot(p_event_id uuid, p_profile_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor              public.profiles%rowtype;
  v_event              public.events%rowtype;
  v_target_row         public.event_participants%rowtype;
  v_slot_count         int;
  v_offer_window_hours int;
  v_offer_expires_at   timestamptz;
  v_tz                 text;
  v_expires_label      text;
  v_skipped_ids        uuid[];
  v_result             public.event_participants%rowtype;
  v_notification_id    uuid;
begin
  select * into v_actor from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_actor.role not in ('admin', 'pro', 'staff') then
    raise exception 'admin_required';
  end if;

  select * into v_event
    from public.events
    where id      = p_event_id
      and club_id = v_actor.club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  select * into v_target_row
    from public.event_participants
    where event_id   = p_event_id
      and profile_id = p_profile_id
      and status     = 'waitlisted';
  if not found then raise exception 'participant_not_found'; end if;

  if exists (
    select 1 from public.event_participants
    where event_id        = p_event_id
      and status          = 'offered'
      and offer_expires_at > now()
  ) then raise exception 'offer_already_active'; end if;

  select
    (select count(*)
       from public.event_participants
       where event_id = p_event_id
         and status   in ('confirmed', 'offered')
         and role     = 'participant')
    +
    (select count(*)
       from public.event_guests
       where event_id = p_event_id
         and status   = 'active')
    into v_slot_count;

  if v_slot_count >= v_event.capacity then
    raise exception 'no_capacity_for_offer';
  end if;

  select coalesce(array_agg(profile_id order by created_at asc), '{}') into v_skipped_ids
    from public.event_participants
    where event_id   = p_event_id
      and status     = 'waitlisted'
      and profile_id <> p_profile_id
      and created_at < v_target_row.created_at;

  select waitlist_offer_window_hours into v_offer_window_hours
    from public.club_settings
    where club_id = v_actor.club_id;

  if not found then
    v_offer_window_hours := 2;
  end if;

  v_offer_expires_at := now() + (v_offer_window_hours || ' hours')::interval;

  select timezone into v_tz from public.clubs where id = v_actor.club_id;

  v_expires_label := to_char(
    v_offer_expires_at at time zone coalesce(v_tz, 'UTC'),
    'Mon DD "at" HH12:MI AM'
  );

  update public.event_participants
    set status           = 'offered',
        offer_expires_at = v_offer_expires_at,
        updated_at       = now()
    where event_id   = p_event_id
      and profile_id = p_profile_id
    returning * into v_result;

  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_actor.club_id,
    p_profile_id,
    'waitlist_offer',
    'A spot opened in "' || v_event.title || '"! Accept by ' || v_expires_label || '.',
    jsonb_build_object(
      'event_id',         p_event_id,
      'offer_expires_at', v_offer_expires_at,
      'triggered_by',     auth.uid()
    )
  )
  returning id into v_notification_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'admin_offer_spot',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_title',         v_event.title,
      'profile_id',          p_profile_id,
      'offer_expires_at',    v_offer_expires_at,
      'skipped_profile_ids', v_skipped_ids
    )
  );

  return jsonb_build_object(
    'participant',     to_jsonb(v_result),
    'notification_id', v_notification_id
  );
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- admin_offer_spot_roster_participant — allowlist widened admin+pro ->
-- admin+pro+staff.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_offer_spot_roster_participant(p_event_id uuid, p_expected_club_id uuid, p_roster_member_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id            uuid;
  v_role               text;
  v_event              public.events%rowtype;
  v_roster             public.roster_members%rowtype;
  v_current_member_id  uuid;
  v_target_row         public.event_participants%rowtype;
  v_slot_count         int;
  v_offer_window_hours int;
  v_offer_expires_at   timestamptz;
  v_tz                 text;
  v_expires_label      text;
  v_skipped_ids        uuid[];
  v_result             public.event_participants%rowtype;
  v_notification_id    uuid;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is null or v_role not in ('admin', 'pro', 'staff') then raise exception 'admin_required'; end if;

  select * into v_event
    from public.events
   where id      = p_event_id
     and club_id = v_club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_club_id;
  if not found then raise exception 'roster_member_not_found'; end if;
  v_current_member_id := v_roster.claimed_by;

  select * into v_target_row
    from public.event_participants
   where event_id         = p_event_id
     and roster_member_id = p_roster_member_id
     and status            = 'waitlisted';
  if not found then raise exception 'participant_not_found'; end if;

  if exists (
    select 1 from public.event_participants
    where event_id        = p_event_id
      and status          = 'offered'
      and offer_expires_at > now()
  ) then raise exception 'offer_already_active'; end if;

  select
    (select count(*)
       from public.event_participants
       where event_id = p_event_id
         and status   in ('confirmed', 'offered')
         and role     = 'participant')
    +
    (select count(*)
       from public.event_guests
       where event_id = p_event_id
         and status   = 'active')
    into v_slot_count;

  if v_slot_count >= v_event.capacity then
    raise exception 'no_capacity_for_offer';
  end if;

  select coalesce(array_agg(roster_member_id order by created_at asc), '{}') into v_skipped_ids
    from public.event_participants
   where event_id         = p_event_id
     and status            = 'waitlisted'
     and roster_member_id <> p_roster_member_id
     and created_at        < v_target_row.created_at;

  select waitlist_offer_window_hours into v_offer_window_hours
    from public.club_settings
   where club_id = v_club_id;
  if not found then v_offer_window_hours := 2; end if;

  v_offer_expires_at := now() + (v_offer_window_hours || ' hours')::interval;
  select timezone into v_tz from public.clubs where id = v_club_id;
  v_expires_label := to_char(v_offer_expires_at at time zone coalesce(v_tz, 'UTC'), 'Mon DD "at" HH12:MI AM');

  update public.event_participants
     set status           = 'offered',
         offer_expires_at = v_offer_expires_at,
         updated_at       = now()
   where id = v_target_row.id
  returning * into v_result;

  if v_current_member_id is not null then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id, v_current_member_id, 'waitlist_offer',
      'A spot opened in "' || v_event.title || '"! Accept by ' || v_expires_label || '.',
      jsonb_build_object('event_id', p_event_id, 'offer_expires_at', v_offer_expires_at, 'triggered_by', auth.uid())
    )
    returning id into v_notification_id;
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'admin_offer_spot', 'event', p_event_id,
    jsonb_build_object(
      'event_title',              v_event.title,
      'roster_member_id',         p_roster_member_id,
      'offer_expires_at',         v_offer_expires_at,
      'skipped_roster_member_ids', v_skipped_ids
    )
  );

  return jsonb_build_object('participant', to_jsonb(v_result), 'notification_id', v_notification_id);
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- admin_expire_offer — allowlist widened admin+pro -> admin+pro+staff. No
-- SET search_path in Production — reproduced as-is.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_expire_offer(p_event_id uuid, p_profile_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_actor  profiles%rowtype;
  v_event  events%rowtype;
begin
  select * into v_actor from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_actor.role not in ('admin', 'pro', 'staff') then
    raise exception 'admin_required';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_actor.club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  -- Target must be in offered state.
  if not exists (
    select 1 from event_participants
    where event_id   = p_event_id
      and profile_id = p_profile_id
      and status     = 'offered'
  ) then raise exception 'participant_not_found'; end if;

  -- Cancel the offered row. No auto-advance — admin controls next step.
  update event_participants
    set status           = 'cancelled',
        offer_expires_at = null,
        updated_at       = now()
    where event_id   = p_event_id
      and profile_id = p_profile_id
      and status     = 'offered';

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'admin_expire_offer',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_title', v_event.title,
      'profile_id',  p_profile_id
    )
  );
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- admin_expire_offer_roster_participant — allowlist widened admin+pro ->
-- admin+pro+staff.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_expire_offer_roster_participant(p_event_id uuid, p_expected_club_id uuid, p_roster_member_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id uuid;
  v_role    text;
  v_event   public.events%rowtype;
  v_participant_id uuid;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is null or v_role not in ('admin', 'pro', 'staff') then raise exception 'admin_required'; end if;

  select * into v_event
    from public.events
   where id      = p_event_id
     and club_id = v_club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  select id into v_participant_id
    from public.event_participants
   where event_id         = p_event_id
     and roster_member_id = p_roster_member_id
     and status            = 'offered';
  if not found then raise exception 'participant_not_found'; end if;

  update public.event_participants
     set status           = 'cancelled',
         offer_expires_at = null,
         updated_at       = now()
   where id = v_participant_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'admin_expire_offer', 'event', p_event_id,
    jsonb_build_object('event_title', v_event.title, 'roster_member_id', p_roster_member_id)
  );
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- mark_attendance_roster_participant — allowlist widened admin+pro ->
-- admin+pro+staff. (mark_attendance, the profile_id-keyed sibling, needs
-- no change — see migration header — and is not reproduced here.)
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mark_attendance_roster_participant(p_event_id uuid, p_expected_club_id uuid, p_roster_member_id uuid, p_attendance_status text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id      uuid;
  v_role         text;
  v_event        public.events%rowtype;
  v_rows_updated int;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is null or v_role not in ('admin', 'pro', 'staff') then raise exception 'insufficient_role'; end if;

  if p_attendance_status is not null
     and p_attendance_status not in ('attended', 'no_show') then
    raise exception 'invalid_attendance_status';
  end if;

  select * into v_event
    from public.events
   where id      = p_event_id
     and club_id = v_club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  update public.event_participants
     set attendance_status = p_attendance_status,
         updated_at        = now()
   where event_id         = p_event_id
     and roster_member_id = p_roster_member_id
     and status            = 'confirmed';

  get diagnostics v_rows_updated = row_count;
  if v_rows_updated = 0 then raise exception 'participant_not_found'; end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'mark_attendance', 'event_participant', p_roster_member_id,
    jsonb_build_object('event_id', p_event_id, 'attendance_status', p_attendance_status)
  );
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- mark_attendance_guest — allowlist widened admin+pro -> admin+pro+staff.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mark_attendance_guest(p_event_id uuid, p_expected_club_id uuid, p_guest_id uuid, p_attendance_status text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id      uuid;
  v_role         text;
  v_event        public.events%rowtype;
  v_rows_updated int;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is null or v_role not in ('admin', 'pro', 'staff') then raise exception 'insufficient_role'; end if;

  if p_attendance_status is not null
     and p_attendance_status not in ('attended', 'no_show') then
    raise exception 'invalid_attendance_status';
  end if;

  select * into v_event
    from public.events
   where id      = p_event_id
     and club_id = v_club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  update public.event_guests
     set attendance_status = p_attendance_status
   where id       = p_guest_id
     and event_id = p_event_id
     and status   = 'active';

  get diagnostics v_rows_updated = row_count;
  if v_rows_updated = 0 then raise exception 'guest_not_found'; end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'mark_attendance_guest', 'event_guest', p_guest_id,
    jsonb_build_object('event_id', p_event_id, 'attendance_status', p_attendance_status)
  );
end;
$function$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- Restore each function by re-querying its live Production definition
-- (pg_get_functiondef) immediately before rolling back — this migration's
-- own bodies were sourced the same way. No RLS policy and no table is
-- touched by this migration — nothing else requires rollback.
