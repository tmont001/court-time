-- 0113_staff_managed_events_identity.sql
-- Phase 33D2a: Events Member Identity Parity — CORRECTED against live paths
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Extends the staff-managed + stable-Member-identity model (Phase 33B-33D1,
-- live for court reservations and lessons) into event participation.
--
-- This is a corrected version of the original 33D2 draft. Review found the
-- draft was written against SUPERSEDED (pre-Phase-31/pre-0102) definitions
-- of several functions — `leave_event` in particular was rewritten against
-- its 0063 body, when 0102 had already replaced it with a thin wrapper over
-- a new internal `_leave_event_impl`, with an exact-notification-identity
-- contract (`{offered_profile_id, notification_id}`) that the 0063-based
-- rewrite did not preserve at all. This version traces and corrects every
-- CURRENT/live definition instead — see Section-by-section notes below for
-- exactly which migration each function's live body was taken from.
--
-- Locked architecture (restated, unchanged):
--   - roster_members.id = permanent club-scoped Member business identity.
--   - event_participants.roster_member_id (new) = durable Member
--     attribution. NOT NULL after a fail-closed backfill — corrected from
--     the original draft, which left it nullable out of concern for
--     cascading failure risk in Program session generation. Re-examined:
--     every event_participants row represents a genuine club Member
--     (self-service join, or staff add — event_guests is the sole home for
--     true, non-Member Guests) — there is no live path today that inserts
--     an event_participants row for anyone who is not a real, same-club
--     Member, and every such Member has a roster identity by construction
--     (33B1's backfill + accept_club_invite's fail-closed resolution +
--     submit_lesson_request/create_reservation's own identical guard
--     pattern already rely on this same guarantee elsewhere). No exception
--     path was found — this migration does not silently write a null
--     durable identity anywhere; every writer either resolves one or
--     raises.
--   - event_participants.profile_id (existing) = optional, historical,
--     point-in-time authenticated compatibility field. Relaxed to
--     nullable. Never rewritten merely because the underlying roster
--     identity is later claimed. MAY be refreshed by an explicit
--     reactivation action (a Member re-joining a row they were previously
--     removed/left from, or an admin re-adding them) — that is a deliberate
--     write by an explicit action, not a passive claim-triggered rewrite.
--   - event_guests (existing, roster_member_id already present from 0057)
--     is untouched by this migration's schema. Existing event_guests rows
--     with roster_member_id set (unclaimed-Member-as-Guest, added via the
--     pre-33D2 admin_add_roster_member_to_event path) are NOT migrated —
--     see the preflight script, which now BLOCKS if any exist, so this is
--     an explicit, confirmed-zero precondition to applying this migration,
--     not a silent assumption.
--   - True, non-Member Guests (event_guests with roster_member_id null)
--     remain wholly separate — untouched.
--
-- Explicitly OUT OF SCOPE for this migration:
--   - No change to program_enrollments schema or add_program_member/
--     get_program_eligible_members — Program-level no-account enrollment
--     remains a separate, later checkpoint.
--   - No change to event_guests schema, RLS, or its RPCs (admin_add_guest,
--     admin_remove_guest). admin_add_roster_member_to_event is left in
--     place (see the preflight/deprecation note below) but the frontend no
--     longer calls it.
--   - No new notification kind. No-account participants receive none.
--   - No new product/eligibility/capacity/scheduling rule — every function
--     below reuses its own pre-existing rule set unchanged; only identity
--     resolution (which row, which current notification recipient) is
--     corrected.
--   - Not applied by this checkpoint. Not committed.
--
-- Live-definition provenance (per function, so this migration's own
-- "CREATE OR REPLACE" bodies below can be checked against their true
-- current source rather than an earlier, superseded migration):
--   admin_add_member                       0061_archive_roster_guard.sql
--   join_event                             0063_member_rpc_lifecycle_guards.sql
--   accept_waitlist_offer                  0063_member_rpc_lifecycle_guards.sql
--   decline_waitlist_offer                 0063_member_rpc_lifecycle_guards.sql
--   admin_remove_participant (reference)   0061_archive_roster_guard.sql
--   admin_force_confirm (reference)        0102_communications_delivery_identity.sql
--   admin_offer_spot (reference)           0102_communications_delivery_identity.sql
--   admin_expire_offer (reference)         0061_archive_roster_guard.sql
--   mark_attendance (reference)            0077_fix_phase24_rpc_ambiguities.sql
--   advance_waitlist_offer                 0102_communications_delivery_identity.sql
--   expire_stale_offers_for_event          0102_communications_delivery_identity.sql
--   _leave_event_impl                      0102_communications_delivery_identity.sql
--   leave_event / leave_event_v2           0102_communications_delivery_identity.sql (thin
--                                           wrappers over _leave_event_impl — NOT
--                                           redeclared here; fixing the impl fixes both)
--   get_event_roster                       0057_member_notes_and_roster_events.sql
--   cancel_event                           0102_communications_delivery_identity.sql
--   update_event                           0099_event_edit_foundation.sql
--   generate_program_sessions              0091_whole_program_enrollment.sql
--   _materialize_program_member_into_future_events  0091_whole_program_enrollment.sql
--
-- RLS / trigger-guard analysis — unchanged from the original draft:
-- event_participants has been write-locked to RPC-only since 0091. No
-- RLS-permitted direct client write exists for this migration to leave
-- unguarded.
--
-- Reactivation / duplicate-row analysis (Section-1 correction): every
-- INSERT into event_participants below that could target a row already
-- represented by an existing (possibly cancelled) row for the SAME roster
-- identity now uses an explicit `SELECT ... FOR UPDATE` (matched via
-- profile_id OR roster_member_id) followed by an UPDATE (reactivate) or
-- INSERT (genuinely new) branch — never a bare `INSERT ... ON CONFLICT
-- (event_id, profile_id)`, which cannot detect a conflict against the NEW
-- `event_participants_event_roster_uniq` partial index (a cancelled row
-- with profile_id NULL and a fresh insert with a real profile_id never
-- collide on (event_id, profile_id) — NULL is never equal to anything,
-- including another NULL — but WOULD collide on (event_id,
-- roster_member_id), which ON CONFLICT (event_id, profile_id) cannot catch,
-- producing a raw, unhandled unique-violation error instead of a clean
-- reactivation). Fixed in: admin_add_member, join_event, admin_add_roster_
-- participant, _materialize_program_member_into_future_events.
-- generate_program_sessions' own bulk insert is exempt — it only ever
-- inserts into an events row it just created in the same statement, which
-- cannot already have any event_participants row.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- A. SCHEMA — event_participants.roster_member_id NOT NULL, profile_id
--    relaxed
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.event_participants
  alter column profile_id drop not null;

alter table public.event_participants
  add column if not exists roster_member_id uuid references public.roster_members(id);

comment on column public.event_participants.roster_member_id is
  'Phase 33D2: durable Member attribution — the roster_members.id this '
  'participation is/was for, regardless of whether that identity is '
  'authenticated. NOT NULL: every event_participants row represents a real '
  'club Member (event_guests is the sole home for true Guests) and every '
  'Member has a roster identity by construction — every write path either '
  'resolves one or fails closed, never writes null.';

comment on column public.event_participants.profile_id is
  'OPTIONAL, HISTORICAL, POINT-IN-TIME compatibility field — populated at '
  'row creation/reactivation when the roster identity happens to be '
  'claimed. NOT a live reflection of current account state: never '
  'rewritten merely because the underlying roster identity is later '
  'claimed (that would be a history rewrite) — only an explicit '
  'reactivation action (rejoin, admin re-add) may refresh it. To resolve '
  'the CURRENT authenticated account for a participation row, read '
  'roster_members.claimed_by via roster_member_id instead.';

create index if not exists event_participants_roster_member_id_idx
  on public.event_participants (roster_member_id);

create unique index if not exists event_participants_event_roster_uniq
  on public.event_participants (event_id, roster_member_id)
  where roster_member_id is not null;

-- ── Fail-closed backfill guard ──────────────────────────────────────────────
do $$
declare
  v_unresolved int;
begin
  select count(*) into v_unresolved
    from public.event_participants ep
    join public.events e on e.id = ep.event_id
   where ep.profile_id is not null
     and not exists (
       select 1 from public.roster_members rm
        where rm.claimed_by = ep.profile_id
          and rm.club_id    = e.club_id
     );

  if v_unresolved > 0 then
    raise exception
      'phase33d2_unresolved_event_participant_identities: % event_participants row(s) cannot resolve exactly one roster identity via (roster_members.claimed_by = event_participants.profile_id AND roster_members.club_id = events.club_id). Run supabase/scripts/verify_phase33d2_preflight.sql for per-row detail. Resolve manually (do not fabricate a roster identity), then re-run this migration.',
      v_unresolved;
  end if;
end $$;

update public.event_participants ep
   set roster_member_id = rm.id
  from public.roster_members rm, public.events e
 where e.id           = ep.event_id
   and rm.claimed_by  = ep.profile_id
   and rm.club_id     = e.club_id
   and ep.roster_member_id is null;

-- Guard already proved every row resolves — safe to enforce immediately.
alter table public.event_participants
  alter column roster_member_id set not null;


-- ═══════════════════════════════════════════════════════════════════════════
-- B. admin_add_member — resolves the target's roster identity; reactivates
--    an existing (possibly-cancelled) row via FOR UPDATE + branch instead
--    of ON CONFLICT. Same 2-argument signature — CREATE OR REPLACE only.
--    Live source: 0061_archive_roster_guard.sql.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function admin_add_member(
  p_event_id   uuid,
  p_profile_id uuid
)
returns event_participants
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      profiles%rowtype;
  v_event      events%rowtype;
  v_existing   event_participants%rowtype;
  v_occupied   int;
  v_new_status text;
  v_result     event_participants%rowtype;
  v_roster_member_id uuid;
begin
  select * into v_actor from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_actor.role not in ('admin', 'pro') then
    raise exception 'admin_required';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_actor.club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  if not exists (
    select 1 from profiles
    where id      = p_profile_id
      and club_id = v_actor.club_id
      and status  = 'active'
  ) then
    if not exists (select 1 from profiles where id = p_profile_id and club_id = v_actor.club_id) then
      raise exception 'member_not_found';
    end if;
    raise exception 'member_inactive';
  end if;

  select id into v_roster_member_id
    from roster_members
   where club_id    = v_actor.club_id
     and claimed_by = p_profile_id;
  if not found then
    raise exception 'phase33d2_unresolved_member_identity';
  end if;

  -- Phase 33D2: locate any existing row for this identity (active or
  -- cancelled) via EITHER profile_id or the durable roster_member_id —
  -- see migration header, reactivation analysis.
  select * into v_existing
    from event_participants
   where event_id = p_event_id
     and (profile_id = p_profile_id or roster_member_id = v_roster_member_id)
   for update;

  if found and v_existing.status in ('confirmed', 'waitlisted', 'offered') then
    raise exception 'already_joined';
  end if;

  select
    (select count(*)
       from event_participants
       where event_id = p_event_id
         and status   in ('confirmed', 'offered')
         and role     = 'participant')
    +
    (select count(*)
       from event_guests
       where event_id = p_event_id)
    into v_occupied;

  v_new_status := case when v_occupied >= v_event.capacity then 'waitlisted' else 'confirmed' end;

  if found then
    update event_participants
       set status           = v_new_status,
           profile_id       = p_profile_id,
           roster_member_id = v_roster_member_id,
           offer_expires_at = null,
           updated_at       = now()
     where id = v_existing.id
    returning * into v_result;
  else
    insert into event_participants (event_id, profile_id, roster_member_id, role, status)
    values (p_event_id, p_profile_id, v_roster_member_id, 'participant', v_new_status)
    returning * into v_result;
  end if;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'admin_add_member',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_title',      v_event.title,
      'added_profile_id', p_profile_id,
      'roster_member_id', v_roster_member_id,
      'final_status',     v_new_status
    )
  );

  return v_result;
end;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- C. join_event — resolves the caller's own roster identity; "already
--    joined" check and reactivation are both roster-aware. Same
--    1-argument signature — CREATE OR REPLACE only. Live source:
--    0063_member_rpc_lifecycle_guards.sql.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function join_event(p_event_id uuid)
returns event_participants
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile  profiles%rowtype;
  v_event    events%rowtype;
  v_existing event_participants%rowtype;
  v_count    int;
  v_result   event_participants%rowtype;
  v_roster_member_id uuid;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.status <> 'active' then raise exception 'account_inactive'; end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_profile.club_id
      and status  = 'scheduled';
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

  -- Phase 33D2: locate any existing row for this identity (active or
  -- cancelled) via EITHER profile_id or roster_member_id — see migration
  -- header, reactivation analysis. Replaces the old `INSERT ... ON
  -- CONFLICT (event_id, profile_id)`, which cannot detect a conflict
  -- against a pre-claim, staff-added row (profile_id null) sharing the
  -- same roster_member_id.
  select * into v_existing
    from event_participants
   where event_id = p_event_id
     and (profile_id = auth.uid() or roster_member_id = v_roster_member_id)
   for update;

  if found and v_existing.status in ('confirmed', 'waitlisted', 'offered') then
    raise exception 'already_joined';
  end if;

  select
    (select count(*)
       from event_participants
       where event_id = p_event_id
         and status   in ('confirmed', 'offered')
         and role     = 'participant')
    +
    (select count(*)
       from event_guests
       where event_id = p_event_id)
    into v_count;

  if v_count >= v_event.capacity then
    if found then
      update event_participants
         set status = 'waitlisted', profile_id = auth.uid(), roster_member_id = v_roster_member_id, updated_at = now()
       where id = v_existing.id
      returning * into v_result;
    else
      insert into event_participants (event_id, profile_id, roster_member_id, role, status)
      values (p_event_id, auth.uid(), v_roster_member_id, 'participant', 'waitlisted')
      returning * into v_result;
    end if;
    -- No notification for waitlist joins; UI reflects status immediately.
  else
    if found then
      update event_participants
         set status = 'confirmed', profile_id = auth.uid(), roster_member_id = v_roster_member_id, updated_at = now()
       where id = v_existing.id
      returning * into v_result;
    else
      insert into event_participants (event_id, profile_id, roster_member_id, role, status)
      values (p_event_id, auth.uid(), v_roster_member_id, 'participant', 'confirmed')
      returning * into v_result;
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
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- D. accept_waitlist_offer / decline_waitlist_offer — roster-aware "my
--    offered row" lookup. Same signatures — CREATE OR REPLACE only. Live
--    source: 0063_member_rpc_lifecycle_guards.sql (confirmed unchanged
--    since — 0102 did not touch either). Neither INSERTs, so neither needs
--    the FOR-UPDATE-then-branch reactivation pattern — both only UPDATE an
--    existing 'offered' row located by id.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function accept_waitlist_offer(p_event_id uuid)
returns event_participants
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile  profiles%rowtype;
  v_event    events%rowtype;
  v_my_row   event_participants%rowtype;
  v_result   event_participants%rowtype;
  v_roster_member_id uuid;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_profile.club_id
      and status  = 'scheduled';
  if not found then raise exception 'event_not_found'; end if;

  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  select id into v_roster_member_id
    from roster_members
   where club_id    = v_profile.club_id
     and claimed_by = auth.uid();

  select * into v_my_row
    from event_participants
    where event_id = p_event_id
      and status    = 'offered'
      and (
        profile_id = auth.uid()
        or (v_roster_member_id is not null and roster_member_id = v_roster_member_id)
      );

  if not found then
    raise exception 'offer_not_found';
  end if;

  if v_my_row.offer_expires_at <= now() then
    raise exception 'offer_expired';
  end if;

  update event_participants
    set status           = 'confirmed',
        offer_expires_at = null,
        updated_at       = now()
    where id = v_my_row.id
  returning * into v_result;

  perform expire_stale_offers_for_event(p_event_id, v_profile.club_id, v_event.title);

  insert into notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'waitlist_promoted',
    'You''ve accepted and are confirmed for "' || v_event.title || '".',
    jsonb_build_object('event_id', p_event_id)
  );

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'accept_waitlist_offer',
    'event',
    p_event_id,
    jsonb_build_object('event_title', v_event.title)
  );

  return v_result;
end;
$$;


create or replace function decline_waitlist_offer(p_event_id uuid)
returns uuid   -- next offered profile_id, or null
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile    profiles%rowtype;
  v_event      events%rowtype;
  v_my_row     event_participants%rowtype;
  v_offered_id uuid;
  v_roster_member_id uuid;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  select id into v_roster_member_id
    from roster_members
   where club_id    = v_profile.club_id
     and claimed_by = auth.uid();

  select * into v_my_row
    from event_participants
    where event_id = p_event_id
      and status    = 'offered'
      and (
        profile_id = auth.uid()
        or (v_roster_member_id is not null and roster_member_id = v_roster_member_id)
      );

  if not found then
    raise exception 'offer_not_found';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_profile.club_id;

  if found and v_event.archived_at is not null then
    raise exception 'event_archived';
  end if;

  update event_participants
    set status           = 'cancelled',
        offer_expires_at = null,
        updated_at       = now()
    where id = v_my_row.id;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'decline_waitlist_offer',
    'event',
    p_event_id,
    jsonb_build_object('event_title', coalesce(v_event.title, ''))
  );

  if found and v_event.status = 'scheduled' then
    perform expire_stale_offers_for_event(p_event_id, v_profile.club_id, v_event.title);
    perform advance_waitlist_offer(p_event_id, v_profile.club_id, v_event.title);
  end if;

  select profile_id into v_offered_id
    from event_participants
    where event_id        = p_event_id
      and status          = 'offered'
      and offer_expires_at > now()
    order by updated_at desc
    limit 1;

  return v_offered_id;
end;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- E. advance_waitlist_offer / expire_stale_offers_for_event — FIFO
--    selection is now by durable participant row (not profile_id, which
--    may be null); notification recipient is now resolved fresh via
--    roster_members.claimed_by at send time, never the historical
--    profile_id. Still-unclaimed: the status transition still applies,
--    notification is safely skipped. Same 4-argument signatures (with
--    p_actor_id default null, from 0102) — CREATE OR REPLACE only. Exact
--    {offered_profile_id, notification_id} return contract preserved —
--    only its VALUES are now correctly current rather than possibly-null-
--    but-historical.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.advance_waitlist_offer(
  p_event_id    uuid,
  p_club_id     uuid,
  p_event_title text,
  p_actor_id    uuid default null
)
returns jsonb
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
  v_tz                    text;
  v_expires_label         text;
  v_slot_count            int;
  v_capacity              int;
  v_notification_id       uuid;
  v_no_result             jsonb := jsonb_build_object('offered_profile_id', null, 'notification_id', null);
begin
  if exists (
    select 1 from public.event_participants
    where event_id        = p_event_id
      and status          = 'offered'
      and offer_expires_at > now()
  ) then
    return v_no_result;
  end if;

  select
    (select count(*)
       from public.event_participants
       where event_id = p_event_id
         and status   in ('confirmed', 'offered')
         and role     = 'participant')
    +
    (select count(*)
       from public.event_guests
       where event_id = p_event_id)
    into v_slot_count;

  select capacity into v_capacity from public.events where id = p_event_id;

  if v_slot_count >= coalesce(v_capacity, 0) then
    return v_no_result;
  end if;

  -- Phase 33D2: FIFO by durable participant row id, not profile_id.
  select id, roster_member_id into v_next_id, v_next_roster_member_id
    from public.event_participants
    where event_id = p_event_id
      and status   = 'waitlisted'
    order by created_at asc
    limit 1;

  if not found then
    return v_no_result;
  end if;

  select waitlist_offer_window_hours into v_offer_window_hours
    from public.club_settings
    where club_id = p_club_id;

  if not found then
    v_offer_window_hours := 2;
  end if;

  v_offer_expires_at := now() + (v_offer_window_hours || ' hours')::interval;

  select timezone into v_tz from public.clubs where id = p_club_id;

  v_expires_label := to_char(
    v_offer_expires_at at time zone coalesce(v_tz, 'UTC'),
    'Mon DD "at" HH12:MI AM'
  );

  update public.event_participants
    set status           = 'offered',
        offer_expires_at = v_offer_expires_at,
        updated_at       = now()
    where id = v_next_id;

  -- Phase 33D2: resolve the CURRENT account fresh via roster_members.
  -- claimed_by. Still-unclaimed: skip the notification, the business
  -- transition above already applies regardless (broader no-account
  -- communications remain Phase 33E).
  select claimed_by into v_current_member_id
    from public.roster_members
   where id = v_next_roster_member_id;

  if v_current_member_id is not null then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      p_club_id,
      v_current_member_id,
      'waitlist_offer',
      'A spot opened in "' || p_event_title || '"! Accept by ' || v_expires_label || '.',
      case when p_actor_id is null then
        jsonb_build_object(
          'event_id',         p_event_id,
          'offer_expires_at', v_offer_expires_at
        )
      else
        jsonb_build_object(
          'event_id',         p_event_id,
          'offer_expires_at', v_offer_expires_at,
          'triggered_by',     p_actor_id
        )
      end
    )
    returning id into v_notification_id;
  end if;

  return jsonb_build_object(
    'offered_profile_id', v_current_member_id,
    'notification_id',    v_notification_id
  );
end;
$$;

revoke execute on function public.advance_waitlist_offer(uuid, uuid, text, uuid) from public, anon, authenticated;


create or replace function public.expire_stale_offers_for_event(
  p_event_id    uuid,
  p_club_id     uuid,
  p_event_title text,
  p_actor_id    uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row             record;
  v_expired_count   int := 0;
  v_advance_result  jsonb := jsonb_build_object('offered_profile_id', null, 'notification_id', null);
begin
  for v_row in
    select id, profile_id, roster_member_id
      from public.event_participants
      where event_id        = p_event_id
        and status          = 'offered'
        and offer_expires_at < now()
  loop
    update public.event_participants
      set status           = 'cancelled',
          offer_expires_at = null,
          updated_at       = now()
      where id = v_row.id;

    -- Phase 33D2: roster_member_id added alongside the existing profile_id
    -- key (audit metadata, not a notification recipient — safe to include
    -- even when profile_id is null).
    insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
    values (
      p_club_id,
      auth.uid(),
      'waitlist_offer_expired',
      'event',
      p_event_id,
      jsonb_build_object(
        'profile_id',       v_row.profile_id,
        'roster_member_id', v_row.roster_member_id,
        'event_title',      p_event_title
      )
    );

    v_expired_count := v_expired_count + 1;
  end loop;

  if v_expired_count > 0 then
    select public.advance_waitlist_offer(p_event_id, p_club_id, p_event_title, p_actor_id)
      into v_advance_result;
  end if;

  return v_advance_result;
end;
$$;

revoke execute on function public.expire_stale_offers_for_event(uuid, uuid, text, uuid) from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- F. _leave_event_impl — the single internal leave implementation shared
--    by leave_event and leave_event_v2 (Phase 31C, 0102). "My row" is now
--    located via profile_id OR the caller's own current roster identity —
--    required for claim continuity, since a pre-claim staff-added row
--    keeps profile_id null forever. leave_event / leave_event_v2
--    themselves are thin wrappers over this function and are NOT
--    redeclared here — fixing this implementation fixes both callers
--    automatically, and their own external contracts (return shapes,
--    grants) are completely untouched. Same 1-argument signature —
--    CREATE OR REPLACE only. Live source: 0102_communications_delivery_
--    identity.sql.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public._leave_event_impl(p_event_id uuid)
returns jsonb   -- { offered_profile_id: uuid | null, notification_id: uuid | null }
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile        public.profiles%rowtype;
  v_event          public.events%rowtype;
  v_old_status     text;
  v_participant_id uuid;
  v_roster_member_id uuid;
  v_expire_result  jsonb;
  v_advance_result jsonb;
  v_final_result   jsonb := jsonb_build_object('offered_profile_id', null, 'notification_id', null);
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  select * into v_event
    from public.events
    where id      = p_event_id
      and club_id = v_profile.club_id;
  if found and v_event.archived_at is not null then
    raise exception 'event_archived';
  end if;

  select id into v_roster_member_id
    from public.roster_members
   where club_id    = v_profile.club_id
     and claimed_by = auth.uid();

  -- Phase 33D2: locate "my row" via profile_id OR the caller's own
  -- current roster identity, not profile_id alone.
  select id, status into v_participant_id, v_old_status
    from public.event_participants
    where event_id = p_event_id
      and status    in ('confirmed', 'waitlisted', 'offered')
      and (
        profile_id = auth.uid()
        or (v_roster_member_id is not null and roster_member_id = v_roster_member_id)
      );
  if not found then raise exception 'not_joined'; end if;

  update public.event_participants
    set status           = 'cancelled',
        offer_expires_at = null,
        updated_at       = now()
    where id = v_participant_id;

  if v_old_status = 'confirmed' then
    select * into v_event
      from public.events
      where id      = p_event_id
        and club_id = v_profile.club_id
        and status  = 'scheduled';

    if found then
      select public.expire_stale_offers_for_event(p_event_id, v_profile.club_id, v_event.title, auth.uid())
        into v_expire_result;
      select public.advance_waitlist_offer(p_event_id, v_profile.club_id, v_event.title, auth.uid())
        into v_advance_result;

      v_final_result := case
        when (v_expire_result->>'offered_profile_id') is not null then v_expire_result
        else v_advance_result
      end;
    end if;

  elsif v_old_status = 'offered' then
    select * into v_event
      from public.events
      where id      = p_event_id
        and club_id = v_profile.club_id
        and status  = 'scheduled';

    if found then
      insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
      values (
        v_profile.club_id,
        auth.uid(),
        'leave_offered_spot',
        'event',
        p_event_id,
        jsonb_build_object('event_title', v_event.title)
      );

      select public.expire_stale_offers_for_event(p_event_id, v_profile.club_id, v_event.title, auth.uid())
        into v_expire_result;
      select public.advance_waitlist_offer(p_event_id, v_profile.club_id, v_event.title, auth.uid())
        into v_advance_result;

      v_final_result := case
        when (v_expire_result->>'offered_profile_id') is not null then v_expire_result
        else v_advance_result
      end;
    end if;

  else
    return v_final_result;
  end if;

  return v_final_result;
end;
$$;

revoke execute on function public._leave_event_impl(uuid) from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- G. admin_add_roster_participant / admin_remove_roster_participant — the
--    Events-domain equivalent of 0111's admin_create_member_lesson: staff
--    adds/removes a roster Member (claimed or no-account) directly to/from
--    event_participants — never event_guests.
-- ═══════════════════════════════════════════════════════════════════════════
-- Uses current_user_club_id()/current_user_role() — brand-new RPCs, not
-- edits to pre-Phase-26 ones. admin_add_member above keeps its
-- pre-existing profiles-direct pattern unchanged.
--
-- Correction: admin_remove_roster_participant now mirrors admin_remove_
-- participant's (0061) exact behavior — captures the previous status,
-- expires stale offers and advances the queue only when a capacity slot
-- was actually freed (previous status confirmed/offered; waitlisted
-- removal frees nothing), and preserves the same audit shape. The
-- original draft cancelled the row but never called expire/advance at
-- all — fixed here.
create or replace function public.admin_add_roster_participant(
  p_event_id          uuid,
  p_expected_club_id  uuid,
  p_roster_member_id  uuid
)
returns public.event_participants
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id    uuid;
  v_role       text;
  v_event      public.events%rowtype;
  v_roster     public.roster_members%rowtype;
  v_member_id  uuid;
  v_existing   public.event_participants%rowtype;
  v_occupied   int;
  v_new_status text;
  v_result     public.event_participants%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is null or v_role not in ('admin', 'pro') then raise exception 'admin_required'; end if;

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

  v_member_id := v_roster.claimed_by;

  select * into v_existing
    from public.event_participants
   where event_id = p_event_id
     and (
       roster_member_id = p_roster_member_id
       or (v_member_id is not null and profile_id = v_member_id)
     )
   for update;

  if found and v_existing.status in ('confirmed', 'waitlisted', 'offered') then
    raise exception 'already_joined';
  end if;

  select
    (select count(*)
       from public.event_participants
       where event_id = p_event_id
         and status   in ('confirmed', 'offered')
         and role     = 'participant')
    +
    (select count(*)
       from public.event_guests
       where event_id = p_event_id)
    into v_occupied;

  v_new_status := case when v_occupied >= v_event.capacity then 'waitlisted' else 'confirmed' end;

  if found then
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
$$;

revoke execute on function public.admin_add_roster_participant(uuid, uuid, uuid) from public, anon;
grant  execute on function public.admin_add_roster_participant(uuid, uuid, uuid) to authenticated;


create or replace function public.admin_remove_roster_participant(
  p_event_id          uuid,
  p_expected_club_id  uuid,
  p_roster_member_id  uuid
)
returns public.event_participants
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  if v_role is null or v_role not in ('admin', 'pro') then raise exception 'admin_required'; end if;

  select * into v_event
    from public.events
   where id      = p_event_id
     and club_id = v_club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  -- Phase 33D2 correction: capture previous status, matching admin_
  -- remove_participant's own target-row lookup shape exactly (any active
  -- status), so the expire/advance decision below is correct.
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

  -- Phase 33D2 correction: a capacity slot was freed only if the previous
  -- status was confirmed or offered — waitlisted removal frees nothing.
  -- Matches admin_remove_participant's exact rule.
  if v_old_status in ('confirmed', 'offered') then
    perform public.expire_stale_offers_for_event(p_event_id, v_club_id, v_event.title, auth.uid());
    perform public.advance_waitlist_offer(p_event_id, v_club_id, v_event.title, auth.uid());
  end if;

  return v_result;
end;
$$;

revoke execute on function public.admin_remove_roster_participant(uuid, uuid, uuid) from public, anon;
grant  execute on function public.admin_remove_roster_participant(uuid, uuid, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- H. Roster-aware staff parity — NEW RPCs mirroring admin_force_confirm /
--    admin_offer_spot / admin_expire_offer / mark_attendance exactly
--    (same rules: capacity, FIFO skip-list, offer-window, role
--    permissions — nothing invented), keyed by roster_member_id so a
--    no-account participant supports the same operations as a claimed
--    one. The existing profile-based RPCs are UNCHANGED, preserved for
--    deployed compatibility. Notification recipient (where applicable) is
--    resolved via roster_members.claimed_by — skipped, never NULL, if
--    still unclaimed.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.admin_force_confirm_roster_participant(
  p_event_id          uuid,
  p_expected_club_id  uuid,
  p_roster_member_id  uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  if v_role is null or v_role not in ('admin', 'pro') then raise exception 'admin_required'; end if;

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
       where event_id = p_event_id)
    into v_occupied;
  v_was_over_cap := v_occupied >= v_event.capacity;

  update public.event_participants
     set status           = 'confirmed',
         offer_expires_at = null,
         updated_at       = now()
   where id = v_participant_id
  returning * into v_result;

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
$$;

revoke execute on function public.admin_force_confirm_roster_participant(uuid, uuid, uuid) from public, anon;
grant  execute on function public.admin_force_confirm_roster_participant(uuid, uuid, uuid) to authenticated;


create or replace function public.admin_offer_spot_roster_participant(
  p_event_id          uuid,
  p_expected_club_id  uuid,
  p_roster_member_id  uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  if v_role is null or v_role not in ('admin', 'pro') then raise exception 'admin_required'; end if;

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
       where event_id = p_event_id)
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
$$;

revoke execute on function public.admin_offer_spot_roster_participant(uuid, uuid, uuid) from public, anon;
grant  execute on function public.admin_offer_spot_roster_participant(uuid, uuid, uuid) to authenticated;


create or replace function public.admin_expire_offer_roster_participant(
  p_event_id          uuid,
  p_expected_club_id  uuid,
  p_roster_member_id  uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  if v_role is null or v_role not in ('admin', 'pro') then raise exception 'admin_required'; end if;

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
$$;

revoke execute on function public.admin_expire_offer_roster_participant(uuid, uuid, uuid) from public, anon;
grant  execute on function public.admin_expire_offer_roster_participant(uuid, uuid, uuid) to authenticated;


create or replace function public.mark_attendance_roster_participant(
  p_event_id          uuid,
  p_expected_club_id  uuid,
  p_roster_member_id  uuid,
  p_attendance_status text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  if v_role is null or v_role not in ('admin', 'pro') then raise exception 'insufficient_role'; end if;

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
$$;

revoke execute on function public.mark_attendance_roster_participant(uuid, uuid, uuid, text) from public, anon;
grant  execute on function public.mark_attendance_roster_participant(uuid, uuid, uuid, text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- I. get_event_roster — display continuity: member rows carry their real
--    roster_member_id (was hardcoded null::uuid) and fall back to the
--    roster row's own name when profile_id is null. Same 1-argument
--    signature, SAME 8-column RETURNS TABLE shape as 0057 — a direct
--    CREATE OR REPLACE, no DROP needed. Live source: 0057_member_notes_
--    and_roster_events.sql.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function get_event_roster(p_event_id uuid)
returns table (
  profile_id        uuid,
  display_name      text,
  role              text,
  status            text,
  attendance_status text,
  offer_expires_at  timestamptz,
  waitlist_position int,
  roster_member_id  uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile profiles%rowtype;
  v_event   events%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.role not in ('admin', 'pro') then
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
        eg.id             as profile_id,
        eg.display_name::text,
        'guest'::text     as role,
        'confirmed'::text as status,
        null::text        as attendance_status,
        null::timestamptz as offer_expires_at,
        null::int         as waitlist_position,
        eg.roster_member_id,
        4                 as sort_group,
        eg.created_at
      from event_guests eg
      where eg.event_id = p_event_id
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
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- J. cancel_event — notification recipients now resolved via the durable
--    roster_member_id, then filtered to CURRENT claimed_by before the
--    notification insert — the historical, possibly-null profile_id is
--    never passed to the notification insert. Same 1-argument signature,
--    same jsonb return contract — CREATE OR REPLACE only. Live source:
--    0102_communications_delivery_identity.sql. Required fix: the
--    previous body did `array_agg(profile_id)` then `unnest(...)` straight
--    into the notification insert — a single no-account participant
--    (profile_id null) would have made that array contain a NULL element,
--    and the INSERT ... SELECT would have attempted user_id = NULL for
--    that row, violating the NOT NULL constraint and aborting the ENTIRE
--    cancel_event call (all participants, not just the no-account one).
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.cancel_event(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

  if v_profile.role is distinct from 'admin' and v_profile.role is distinct from 'pro' then
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
$$;

revoke execute on function public.cancel_event(uuid) from public, anon;
grant  execute on function public.cancel_event(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- K. update_event — notification loop now iterates roster_member_id and
--    resolves the CURRENT account via claimed_by per participant, skipping
--    (not crashing on) a still-unclaimed one. Same 10-argument signature,
--    same jsonb return contract — CREATE OR REPLACE only. Live source:
--    0099_event_edit_foundation.sql. Required fix: the previous loop
--    selected profile_id directly and inserted it unconditionally as
--    notifications.user_id — a null profile_id would have crashed the
--    entire update_event call the same way cancel_event's bug did.
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
  v_notify_roster_member_id uuid;
  v_notify_member_id     uuid;
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

  -- Canonical pre-edit note.
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

  -- Retained courts: update time in place only if it changed.
  if v_time_changed then
    update reservations
      set starts_at = p_starts_at, ends_at = p_ends_at, updated_at = now()
      where event_id = p_event_id and reason = 'event' and status in ('pending', 'confirmed')
        and court_id = any(v_retained_ids);
  end if;

  -- Removed courts: soft-cancel.
  update reservations
    set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
        cancellation_kind = 'system', updated_at = now()
    where event_id = p_event_id and reason = 'event' and status in ('pending', 'confirmed')
      and court_id = any(v_removed_ids);

  -- Added courts: fresh rows, carrying the canonical pre-edit note forward.
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
  -- note above).
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

  -- Capacity increase: try to advance the waitlist queue exactly once.
  if p_capacity > v_before.capacity then
    perform expire_stale_offers_for_event(p_event_id, v_club_id, v_after.title);
    perform advance_waitlist_offer(p_event_id, v_club_id, v_after.title);
  end if;

  -- Mandatory in-app notification — fires only for material changes.
  -- Phase 33D2: iterates roster_member_id (NOT NULL, durable) and resolves
  -- the CURRENT account fresh via roster_members.claimed_by per
  -- participant, skipping (never inserting NULL for) a still-unclaimed one.
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
$$;

revoke execute on function public.update_event(
  uuid, uuid, timestamptz, text, uuid, timestamptz, timestamptz, uuid[], int, text
) from public, anon;
grant  execute on function public.update_event(
  uuid, uuid, timestamptz, text, uuid, timestamptz, timestamptz, uuid[], int, text
) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- L. Program → Event materialization — fail-closed (corrected from the
--    original draft's best-effort LEFT JOIN, per item 1). Same signatures
--    — CREATE OR REPLACE only. Live source: 0091_whole_program_
--    enrollment.sql. Program enrollment itself (program_enrollments
--    schema, add_program_member, get_program_eligible_members) is
--    UNCHANGED and OUT OF SCOPE.
-- ═══════════════════════════════════════════════════════════════════════════

-- _materialize_program_member_into_future_events: now fails closed if the
-- member cannot resolve a same-club roster identity, and reactivates any
-- existing (possibly cancelled) row for the same identity via FOR UPDATE +
-- branch, exactly like admin_add_roster_participant — required because the
-- original single set-based INSERT ... ON CONFLICT (event_id, profile_id)
-- cannot detect a conflict against the new (event_id, roster_member_id)
-- partial unique index (see migration header, reactivation analysis).
create or replace function public._materialize_program_member_into_future_events(
  p_program_id uuid,
  p_profile_id uuid,
  p_club_id    uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_roster_member_id uuid;
  v_event    record;
  v_existing public.event_participants%rowtype;
begin
  select id into v_roster_member_id
    from public.roster_members
   where club_id    = p_club_id
     and claimed_by = p_profile_id;
  if not found then
    raise exception 'phase33d2_unresolved_member_identity: cannot resolve a same-club roster identity for this enrolled member — investigate before materializing program participation. No partial materialization was applied.';
  end if;

  for v_event in
    select e.id
      from public.events e
     where e.program_id  = p_program_id
       and e.club_id      = p_club_id
       and e.status        = 'scheduled'
       and e.archived_at  is null
       and e.starts_at    >= now()
  loop
    select * into v_existing
      from public.event_participants
     where event_id = v_event.id
       and (profile_id = p_profile_id or roster_member_id = v_roster_member_id)
     for update;

    if found then
      if v_existing.status <> 'confirmed' then
        update public.event_participants
           set status           = 'confirmed',
               profile_id       = p_profile_id,
               roster_member_id = v_roster_member_id,
               updated_at       = now()
         where id = v_existing.id;
      end if;
    else
      insert into public.event_participants (event_id, profile_id, roster_member_id, role, status)
      values (v_event.id, p_profile_id, v_roster_member_id, 'participant', 'confirmed');
    end if;
  end loop;
end;
$$;

revoke execute on function public._materialize_program_member_into_future_events(uuid, uuid, uuid) from public, anon, authenticated;


-- generate_program_sessions: same body as 0091 except (1) a fail-closed
-- guard runs once, before the generation loop, verifying every currently-
-- 'enrolled' program member resolves a same-club roster identity — the
-- whole call aborts (no event created) if not; (2) the per-event bulk
-- insert now uses a plain (inner) join to roster_members and writes
-- roster_member_id — safe because the guard already proved every row
-- resolves. No FOR-UPDATE-then-branch reactivation logic needed here
-- (unlike the materialize helper above): this insert only ever targets an
-- events row this same function just created in the same transaction,
-- which cannot already have any event_participants row.
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
  v_unresolved_members int;
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

  -- Phase 33D2: fail-closed identity check, once, before anything is
  -- generated. Every currently-enrolled member of a whole-program program
  -- must resolve a same-club roster identity, or this call aborts
  -- entirely — no event, no reservation, no partial materialization.
  if v_program.enrollment_model = 'program' then
    select count(*) into v_unresolved_members
      from public.program_enrollments pe
     where pe.program_id = v_program.id
       and pe.status     = 'enrolled'
       and not exists (
         select 1 from public.roster_members rm
          where rm.claimed_by = pe.profile_id
            and rm.club_id    = v_club_id
       );
    if v_unresolved_members > 0 then
      raise exception 'phase33d2_unresolved_program_member_identities: % enrolled program member(s) cannot resolve a same-club roster identity. Investigate before generating sessions for this program. No sessions were generated.', v_unresolved_members;
    end if;
  end if;

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

    -- Phase 33D2: plain (inner) join — safe, the fail-closed guard above
    -- already proved every enrolled member resolves a roster identity.
    if v_program.enrollment_model = 'program' then
      insert into public.event_participants (event_id, profile_id, roster_member_id, role, status)
      select v_new_event.id, pe.profile_id, rm.id, 'participant', 'confirmed'
      from public.program_enrollments pe
      join public.roster_members rm
        on rm.claimed_by = pe.profile_id
       and rm.club_id    = v_club_id
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

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration is created
-- in this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Drop the six new RPCs (no other object in this migration depends on
--    them):
--    `drop function if exists public.mark_attendance_roster_participant(uuid, uuid, uuid, text);`
--    `drop function if exists public.admin_expire_offer_roster_participant(uuid, uuid, uuid);`
--    `drop function if exists public.admin_offer_spot_roster_participant(uuid, uuid, uuid);`
--    `drop function if exists public.admin_force_confirm_roster_participant(uuid, uuid, uuid);`
--    `drop function if exists public.admin_remove_roster_participant(uuid, uuid, uuid);`
--    `drop function if exists public.admin_add_roster_participant(uuid, uuid, uuid);`
--
-- 2. Restore admin_add_member, join_event, accept_waitlist_offer,
--    decline_waitlist_offer, advance_waitlist_offer, expire_stale_offers_
--    for_event, _leave_event_impl, get_event_roster, cancel_event,
--    update_event, generate_program_sessions, and _materialize_program_
--    member_into_future_events to their pre-0113 bodies (see the
--    "Live-definition provenance" list in this migration's header for
--    each one's exact source migration) via CREATE OR REPLACE FUNCTION —
--    every one of these kept its exact pre-0113 signature and return
--    shape throughout this migration, so every restoration is a direct
--    CREATE OR REPLACE, never a DROP. leave_event / leave_event_v2 need
--    no action — they were never redeclared by this migration.
--
-- 3. Only after step 2, relax the schema and clear the backfilled/newly-
--    written data if the rollback requires it:
--    `alter table public.event_participants alter column roster_member_id
--    drop not null;` and, if truly required:
--    `update public.event_participants set roster_member_id = null;`
--
-- 4. profile_id cannot safely return to NOT NULL once any legitimate
--    no-account participant exists: `alter table public.event_
--    participants alter column profile_id set not null;` will FAIL if any
--    row has a null profile_id — expected and correct, matching every
--    prior Phase 33 precedent. Do not force it through by deleting rows
--    or inventing a profile_id.
--
-- 5. Drop the new schema only when safe — i.e., only after step 3 (or
--    after confirming no row still depends on it) and only if step 4's
--    NOT NULL restoration is not itself being abandoned for the reason
--    above: `drop index if exists public.event_participants_event_roster_
--    uniq; alter table public.event_participants drop column if exists
--    roster_member_id;` (also drops event_participants_roster_member_id_
--    idx automatically).
