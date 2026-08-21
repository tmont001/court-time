-- 0141_event_pricing.sql
-- Phase 34B — Admin-Controlled Pricing Foundation, part 3 of 4.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Event Type carries the Admin-controlled DEFAULT price. An Event receives
-- a PRICE SNAPSHOT at creation from that default — pricing does not
-- dynamically inherit forever. Every participant/guest that joins receives
-- its own price snapshot from the Event's price at the moment they commit
-- (join, get added, or get reactivated after a prior cancel).
--
-- Every RPC body below is copied verbatim from the already-Production-
-- verified 0136 body, or from the Production pg_get_functiondef output
-- supplied directly by the operator this checkpoint (join_event) — not
-- reconstructed. The ONLY change to each is the price-resolution/snapshot
-- logic described in its own inline comment.
--
-- create_event deliberately receives NO client-supplied pricing
-- parameter — price is always derived server-side from the current
-- event_type default, for every caller (Admin, Staff, or Pro alike).
-- Setting an explicit per-instance override is a separate, Admin-only
-- action (set_event_price_override) performed after the Event exists —
-- this keeps create_event's shared, Staff/Pro-inclusive signature
-- price-blind rather than threading an admin-only branch through an
-- already-widened operational RPC. The same reasoning keeps
-- update_event untouched by this migration entirely.
--
-- Historical rows remain NULL — no backfill. Production preflight (this
-- checkpoint) confirmed 155 events, 259 event_participants, 34
-- event_guests, none of which are touched by this migration's ALTER TABLE
-- statements beyond adding the new nullable columns.
--
-- Does not modify 0131-0140 or the confirmed-dead admin_add_member /
-- admin_add_roster_member_to_event. Not applied by this checkpoint. Apply
-- in Supabase SQL Editor (cloud only).
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ─────────────────────────────────────────────────────────────────────────
-- Schema
-- ─────────────────────────────────────────────────────────────────────────

alter table public.event_types
  add column default_price_amount_cents integer null;

alter table public.event_types
  add constraint event_types_default_price_amount_cents_nonneg
    check (default_price_amount_cents is null or default_price_amount_cents >= 0);

alter table public.events
  add column price_amount_cents integer null;

alter table public.events
  add constraint events_price_amount_cents_nonneg
    check (price_amount_cents is null or price_amount_cents >= 0);

alter table public.event_participants
  add column price_amount_cents integer null;

alter table public.event_participants
  add constraint event_participants_price_amount_cents_nonneg
    check (price_amount_cents is null or price_amount_cents >= 0);

alter table public.event_guests
  add column price_amount_cents integer null;

alter table public.event_guests
  add constraint event_guests_price_amount_cents_nonneg
    check (price_amount_cents is null or price_amount_cents >= 0);

-- ─────────────────────────────────────────────────────────────────────────
-- set_event_type_price — new, Admin-only. Mirrors set_event_type_active's
-- exact auth/lookup/audit style. Existing Event Type create/edit behavior
-- (create_event_type, update_event_type, set_event_type_active) is
-- untouched by this migration.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.set_event_type_price(p_id uuid, p_default_price_amount_cents integer)
returns event_types
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_profile profiles%rowtype;
  v_result  event_types%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  if p_id is null then raise exception 'invalid_event_type'; end if;

  if p_default_price_amount_cents is not null and p_default_price_amount_cents < 0 then
    raise exception 'invalid_price';
  end if;

  -- Verify the row belongs to this admin's club.
  perform 1 from event_types where id = p_id and club_id = v_profile.club_id;
  if not found then raise exception 'not_found'; end if;

  update event_types
  set default_price_amount_cents = p_default_price_amount_cents, updated_at = now()
  where id = p_id
  returning * into v_result;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'set_event_type_price',
    'event_type',
    p_id,
    jsonb_build_object('default_price_amount_cents', p_default_price_amount_cents)
  );

  return v_result;
end;
$$;

revoke execute on function public.set_event_type_price(uuid, integer) from public, anon;
grant  execute on function public.set_event_type_price(uuid, integer) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- set_event_price_override — new, Admin-only. Changes only the Event's own
-- price snapshot; existing event_participants/event_guests snapshots are
-- never rewritten. New participants/guests added after this call use the
-- Event's new price.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.set_event_price_override(p_event_id uuid, p_price_amount_cents integer)
returns events
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_profile profiles%rowtype;
  v_event   events%rowtype;
  v_result  events%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  select * into v_event from events where id = p_event_id and club_id = v_profile.club_id;
  if not found then raise exception 'event_not_found'; end if;

  if p_price_amount_cents is not null and p_price_amount_cents < 0 then
    raise exception 'invalid_price';
  end if;

  update events
  set price_amount_cents = p_price_amount_cents, updated_at = now()
  where id = p_event_id
  returning * into v_result;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'set_event_price_override', 'event', p_event_id,
    jsonb_build_object('price_amount_cents', p_price_amount_cents)
  );

  return v_result;
end;
$$;

revoke execute on function public.set_event_price_override(uuid, integer) from public, anon;
grant  execute on function public.set_event_price_override(uuid, integer) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- create_event — 0136 body (already Production-verified) + price snapshot
-- from the event_type's current default. No client-supplied price
-- parameter — identical for Admin, Staff, and Pro callers. v_et was
-- already selected by the existing body; no new lookup added.
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

  -- Phase 34B: price is always snapshotted from the event type's current
  -- default at creation — identical for every caller (Admin, Staff, Pro).
  -- An explicit per-instance override is a separate, Admin-only action
  -- (set_event_price_override) performed after the Event exists.
  insert into events (
    club_id, event_type_id, title, description,
    starts_at, ends_at, capacity, court_count, status, created_by, member_joinable,
    price_amount_cents
  ) values (
    v_profile.club_id, v_et.id, p_title, p_description,
    p_starts_at, p_ends_at,
    coalesce(p_capacity, v_et.default_capacity),
    array_length(p_court_ids, 1),
    'scheduled', auth.uid(),
    coalesce(p_member_joinable, true),
    v_et.default_price_amount_cents
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
-- join_event — verbatim Production body + participant price snapshot.
-- Both reachable branches (waitlisted, confirmed) represent a fresh or
-- reactivated commitment — join_event rejects outright before this point
-- if the caller already has an active row (confirmed/waitlisted/offered),
-- so every UPDATE-existing-row branch here is necessarily reactivating a
-- previously-cancelled row, and every INSERT branch is a first-time join.
-- Both snapshot the Event's CURRENT price.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.join_event(p_event_id uuid)
 RETURNS event_participants
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_profile  profiles%rowtype;
  v_event    events%rowtype;
  v_existing event_participants%rowtype;
  v_existing_found boolean;
  v_count    int;
  v_result   event_participants%rowtype;
  v_roster_member_id uuid;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.status <> 'active' then raise exception 'account_inactive'; end if;

  -- Phase 34A3: restated as an explicit admin/pro allowlist rather than a
  -- member-exclusion — see this section's header above.
  if v_profile.role not in ('admin', 'pro') and not current_club_has_capability('member_self_service') then
    raise exception 'capability_not_available';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_profile.club_id
      and status  = 'scheduled'
    for update;
  if not found then raise exception 'event_not_found'; end if;

  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  if not v_event.member_joinable then
    raise exception 'event_not_joinable';
  end if;

  if v_event.starts_at < now() then
    raise exception 'event_already_started';
  end if;

  select id into v_roster_member_id
    from roster_members
   where club_id    = v_profile.club_id
     and claimed_by = auth.uid();
  if not found then
    raise exception 'phase33d2_unresolved_member_identity';
  end if;

  perform expire_stale_offers_for_event(p_event_id, v_profile.club_id, v_event.title);
  perform advance_waitlist_offer(p_event_id, v_profile.club_id, v_event.title);

  select * into v_existing
    from event_participants
   where event_id = p_event_id
     and (profile_id = auth.uid() or roster_member_id = v_roster_member_id)
   for update;
  v_existing_found := found;

  if v_existing_found and v_existing.status in ('confirmed', 'waitlisted', 'offered') then
    raise exception 'already_joined';
  end if;

  v_count := public._event_effective_occupancy(
    p_event_id,
    case when v_existing_found then v_existing.id else null end
  );

  if v_count >= v_event.capacity then
    if v_existing_found then
      update event_participants
         set status = 'waitlisted', profile_id = auth.uid(), roster_member_id = v_roster_member_id,
             price_amount_cents = v_event.price_amount_cents, updated_at = now()
       where id = v_existing.id
      returning * into v_result;
    else
      insert into event_participants (event_id, profile_id, roster_member_id, role, status, price_amount_cents)
      values (p_event_id, auth.uid(), v_roster_member_id, 'participant', 'waitlisted', v_event.price_amount_cents)
      returning * into v_result;
    end if;

    if v_result.id is null then
      raise exception 'event_participant_write_failed';
    end if;
  else
    if v_existing_found then
      update event_participants
         set status = 'confirmed', profile_id = auth.uid(), roster_member_id = v_roster_member_id,
             price_amount_cents = v_event.price_amount_cents, updated_at = now()
       where id = v_existing.id
      returning * into v_result;
    else
      insert into event_participants (event_id, profile_id, roster_member_id, role, status, price_amount_cents)
      values (p_event_id, auth.uid(), v_roster_member_id, 'participant', 'confirmed', v_event.price_amount_cents)
      returning * into v_result;
    end if;

    if v_result.id is null then
      raise exception 'event_participant_write_failed';
    end if;

    if user_pref_enabled(auth.uid(), 'event_joined') then
      insert into notifications (club_id, user_id, kind, body, metadata)
      values (
        v_profile.club_id,
        auth.uid(),
        'event_joined',
        'You''ve joined "' || v_event.title || '".',
        jsonb_build_object('event_id', p_event_id)
      );
    end if;
  end if;

  return v_result;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- admin_add_roster_participant — 0136 body + participant price snapshot.
-- Same "every reachable UPDATE/INSERT branch is a fresh or reactivated
-- commitment" reasoning as join_event (already_joined is raised for an
-- active existing row before this point).
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
           price_amount_cents = v_event.price_amount_cents,
           updated_at       = now()
     where id = v_existing.id
    returning * into v_result;
  else
    insert into public.event_participants (event_id, profile_id, roster_member_id, role, status, price_amount_cents)
    values (p_event_id, v_member_id, p_roster_member_id, 'participant', v_new_status, v_event.price_amount_cents)
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
-- admin_add_guest — 0136 body + guest price snapshot. Always a fresh
-- insert (no existing-row reuse pattern for guests).
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

  -- Phase 34B: guest price snapshot preserves what the guest seat cost
  -- when added. This does not create guest payment mechanics — who
  -- ultimately pays for the guest remains deferred to 34C+.
  insert into event_guests (event_id, display_name, added_by, price_amount_cents)
  values (p_event_id, v_name, auth.uid(), v_event.price_amount_cents)
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

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- Drop set_event_type_price(uuid, integer) and set_event_price_override
-- (uuid, integer) (both new, safe to drop outright). Restore create_event,
-- join_event, admin_add_roster_participant, and admin_add_guest by
-- re-querying their live Production definitions immediately before rolling
-- back. Drop the new columns/constraints on event_types, events,
-- event_participants, and event_guests. No other function, table, or
-- policy is touched by this migration.
