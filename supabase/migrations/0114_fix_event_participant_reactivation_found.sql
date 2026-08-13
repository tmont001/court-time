-- 0114_fix_event_participant_reactivation_found.sql
-- Phase 33D2a hotfix: PL/pgSQL FOUND lifetime misuse introduced by 0113.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ROOT CAUSE
-- ═══════════════════════════════════════════════════════════════════════════
-- In admin_add_member, join_event, and admin_add_roster_participant, 0113
-- introduced this shape:
--
--   select * into v_existing
--     from event_participants
--    where event_id = p_event_id and (...)
--    for update;
--
--   if found and v_existing.status in ('confirmed','waitlisted','offered')
--   then
--     raise exception 'already_joined';
--   end if;
--
--   select (...) + (...) into v_occupied;   -- capacity aggregate
--
--   if found then                            -- BUG: no longer describes
--     update event_participants ...          -- the v_existing lookup above
--   else                                      -- — it describes the capacity
--     insert into event_participants ...      -- aggregate SELECT instead.
--   end if;
--
-- PL/pgSQL's FOUND variable is a single, function-scoped flag reset by
-- EVERY SELECT INTO / INSERT / UPDATE / DELETE / PERFORM statement — not a
-- per-statement result tied to whichever query the developer intended. The
-- capacity aggregate (`select count(*) + count(*) into v_occupied`) always
-- returns exactly one row, even when both counts are zero, so it always
-- sets FOUND = true — unconditionally overwriting whatever FOUND meant
-- right after the v_existing lookup.
--
-- Net effect for a genuinely new participant (v_existing lookup correctly
-- finds nothing, FOUND = false at that point): the capacity aggregate
-- immediately resets FOUND = true, so execution takes the UPDATE branch
-- instead of INSERT. `v_existing.id` is null (never populated), so
-- `update ... where id = v_existing.id` matches zero rows. `returning *
-- into v_result` on a zero-row UPDATE leaves v_result unpopulated (all
-- null fields) without raising — no error, no row written. The function
-- then proceeds to write its audit_log entry and returns v_result (with a
-- null id) as if it had succeeded. This exactly matches the production
-- symptom: admin_add_roster_participant's audit_log committed with
-- final_status: "confirmed" three times for the same event/roster_member_id
-- pair (never once hitting already_joined, which only a genuinely-found
-- existing row could trigger), while event_participants remained
-- completely empty for that event.
--
-- Confirmed NOT present in _materialize_program_member_into_future_events
-- — its `if found then / else` branches immediately on the v_existing
-- lookup, with no intervening SQL statement between the SELECT and the
-- check. generate_program_sessions does not use this reactivation shape at
-- all (its bulk INSERT only ever targets a just-created event, per the
-- 0113 header's reactivation analysis).
--
-- A structurally similar-looking `if found` appears later in
-- decline_waitlist_offer (`if found and v_event.status = 'scheduled'
-- then`, after an intervening UPDATE and audit_log INSERT — both of which
-- also reset FOUND). This is NOT a new defect introduced by 0113: it is
-- byte-for-byte preserved from the live 0063 body. It is also not
-- functionally broken: the AND'd `v_event.status = 'scheduled'` condition
-- is null (falsy) whenever the earlier v_event lookup truly found nothing,
-- so the compound condition self-corrects regardless of the stale FOUND
-- value — unlike the three functions below, there is no separate
-- UPDATE-vs-INSERT branch whose *correctness* depends on FOUND being
-- accurate. Left untouched; out of scope for this hotfix.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- FIX
-- ═══════════════════════════════════════════════════════════════════════════
-- Each of the three affected functions gains one new local boolean,
-- v_existing_found, captured immediately after the v_existing SELECT ...
-- FOR UPDATE (`v_existing_found := found;`), then used for both the
-- already-active check and the later UPDATE-vs-INSERT branch — completely
-- independent of whatever any later SQL statement does to FOUND.
--
-- Each also gains a fail-closed post-write guard: if the UPDATE/INSERT's
-- `returning * into v_result` left v_result.id null (meaning it silently
-- affected zero rows, for this bug or any other reason), the function now
-- raises 'event_participant_write_failed' instead of writing a success
-- audit entry or notification and returning a hollow "success" result.
--
-- No signature, return type, grant, search_path, authorization rule,
-- capacity/waitlist rule, notification rule, roster-identity rule,
-- reactivation rule, existing error code, or audit shape changes. Every
-- edit below is exactly the FOUND-capture line, the substitution of
-- `v_existing_found` for the two now-provably-correct `found` reads, and
-- the new fail-closed guard — nothing else in any of the three bodies was
-- touched. CREATE OR REPLACE only; none of the three signatures changed,
-- so no DROP is required.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- admin_add_member
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
  v_existing_found boolean;
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
  -- see 0113's header, reactivation analysis.
  select * into v_existing
    from event_participants
   where event_id = p_event_id
     and (profile_id = p_profile_id or roster_member_id = v_roster_member_id)
   for update;
  -- Phase 33D2a hotfix: capture FOUND immediately — the capacity aggregate
  -- below issues its own SELECT INTO and would otherwise silently
  -- overwrite it before the UPDATE-vs-INSERT branch reads it.
  v_existing_found := found;

  if v_existing_found and v_existing.status in ('confirmed', 'waitlisted', 'offered') then
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

  if v_existing_found then
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

  -- Phase 33D2a hotfix: fail closed — never write a success audit entry or
  -- return a hollow "success" result if the write above affected zero rows.
  if v_result.id is null then
    raise exception 'event_participant_write_failed';
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
-- join_event
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
  v_existing_found boolean;
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
  -- cancelled) via EITHER profile_id or roster_member_id — see 0113's
  -- header, reactivation analysis. Replaces the old `INSERT ... ON
  -- CONFLICT (event_id, profile_id)`, which cannot detect a conflict
  -- against a pre-claim, staff-added row (profile_id null) sharing the
  -- same roster_member_id.
  select * into v_existing
    from event_participants
   where event_id = p_event_id
     and (profile_id = auth.uid() or roster_member_id = v_roster_member_id)
   for update;
  -- Phase 33D2a hotfix: capture FOUND immediately — the perform calls
  -- above and the capacity aggregate below each issue their own
  -- statements and would otherwise silently overwrite it before the
  -- UPDATE-vs-INSERT branches (in both the waitlisted and confirmed arms
  -- below) read it.
  v_existing_found := found;

  if v_existing_found and v_existing.status in ('confirmed', 'waitlisted', 'offered') then
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
    if v_existing_found then
      update event_participants
         set status = 'waitlisted', profile_id = auth.uid(), roster_member_id = v_roster_member_id, updated_at = now()
       where id = v_existing.id
      returning * into v_result;
    else
      insert into event_participants (event_id, profile_id, roster_member_id, role, status)
      values (p_event_id, auth.uid(), v_roster_member_id, 'participant', 'waitlisted')
      returning * into v_result;
    end if;

    -- Phase 33D2a hotfix: fail closed before returning "success".
    if v_result.id is null then
      raise exception 'event_participant_write_failed';
    end if;
    -- No notification for waitlist joins; UI reflects status immediately.
  else
    if v_existing_found then
      update event_participants
         set status = 'confirmed', profile_id = auth.uid(), roster_member_id = v_roster_member_id, updated_at = now()
       where id = v_existing.id
      returning * into v_result;
    else
      insert into event_participants (event_id, profile_id, roster_member_id, role, status)
      values (p_event_id, auth.uid(), v_roster_member_id, 'participant', 'confirmed')
      returning * into v_result;
    end if;

    -- Phase 33D2a hotfix: fail closed before the notification insert.
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
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- admin_add_roster_participant
-- ═══════════════════════════════════════════════════════════════════════════
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
  v_existing_found boolean;
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
  -- Phase 33D2a hotfix: capture FOUND immediately — the capacity aggregate
  -- below issues its own SELECT INTO and would otherwise silently
  -- overwrite it before the UPDATE-vs-INSERT branch reads it.
  v_existing_found := found;

  if v_existing_found and v_existing.status in ('confirmed', 'waitlisted', 'offered') then
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

  -- Phase 33D2a hotfix: fail closed — never write a success audit entry or
  -- return a hollow "success" result if the write above affected zero rows.
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
$$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- All three functions kept their exact pre-0114 (0113) signatures and
-- return shapes — restoring the pre-0114 bodies is a direct CREATE OR
-- REPLACE FUNCTION for each, using 0113's bodies verbatim (see
-- 0113_staff_managed_events_identity.sql, sections B and C, and the
-- admin_add_roster_participant definition in section G). No DROP needed
-- either direction.
