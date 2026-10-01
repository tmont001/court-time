-- 0217_waitlist_offer_terminal_status_guard.sql
-- Phase 45E1 — closes the P1 finding from the Phase 45E concurrency audit:
-- public.accept_waitlist_offer(uuid) and public.decline_waitlist_offer(uuid)
-- both correctly READ the caller's participant row with a
-- `status = 'offered'` filter, but their terminal UPDATE statements then
-- mutate by participant id ALONE — with no `AND status = 'offered'` guard
-- at the actual write. public.admin_expire_offer(uuid, uuid) already
-- demonstrates the correct pattern: its own terminal UPDATE carries
-- `where event_id = ... and profile_id = ... and status = 'offered'`.
--
-- LIVE VERIFICATION (performed fresh this checkpoint, not assumed): pulled
-- pg_get_functiondef for all three functions plus their proacl/prosecdef/
-- proconfig/owner metadata. All three are unchanged from the Phase 45E
-- audit's own evidence: SECURITY DEFINER, search_path = public, pg_temp,
-- owner postgres, EXECUTE granted only to authenticated/service_role (no
-- PUBLIC, no anon — confirming 0216's PUBLIC-execute closeout is already
-- live). admin_expire_offer's body is unchanged and is NOT redefined by
-- this migration — it is already correct.
--
-- RACE THIS CLOSES (accept, symmetric case for decline):
--   T1 (Member, accept_waitlist_offer): locks the events row FOR UPDATE,
--     reads the participant row (status='offered', unlocked), confirms
--     offer_expires_at > now().
--   T2 (Admin, admin_expire_offer — or a second concurrent accept/decline
--     call for the same row): does not contend for T1's events-row lock,
--     and its own terminal UPDATE (already guarded by status='offered')
--     succeeds first, committing status='cancelled'.
--   T1 resumes and, before this fix, its terminal UPDATE matched by id
--     alone and unconditionally overwrote status back to 'confirmed' —
--     silently reviving an already-cancelled/superseded offer after T1 had
--     already created a payment obligation, sent a confirmation
--     notification, and written an audit_log entry for the (no longer
--     valid) acceptance.
--
-- THE FIX: add `and status = 'offered'` to each function's own terminal
-- UPDATE ... WHERE clause (mirroring admin_expire_offer's existing
-- pattern exactly), and check `if not found then raise exception
-- 'offer_no_longer_available';` immediately after that UPDATE — before any
-- of the payment-obligation/notification/audit work that follows it in the
-- original control flow. Because each function is one PL/pgSQL function
-- body executing inside the caller's single Postgres transaction, this
-- exception aborts and rolls back the entire RPC call — no payment
-- obligation, no notification, no audit_log row can survive when the
-- terminal transition itself did not actually happen.
--
-- NOTHING ELSE CHANGES: capacity logic, event locking order, payment
-- obligation semantics, offer expiry rules, notification contents, audit
-- contents, and the participant status model are all preserved exactly as
-- they were. admin_expire_offer is not touched. No RLS change. No table/
-- schema change. No grant/ACL change (CREATE OR REPLACE preserves the
-- existing owner/security/ACL of an unchanged signature and return type
-- automatically — confirmed unchanged below).
--
-- Created by this checkpoint. Do NOT apply until reviewed.

begin;

create or replace function public.accept_waitlist_offer(p_event_id uuid)
returns event_participants
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_profile  profiles%rowtype;
  v_event    events%rowtype;
  v_my_row   event_participants%rowtype;
  v_result   event_participants%rowtype;
  v_roster_member_id uuid;
  v_has_prior_payment boolean;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_profile.club_id
      and status  = 'scheduled'
    for update;
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

  -- Phase 45E1: terminal write now reasserts status = 'offered' at the
  -- actual mutation, not just at the earlier read above. A concurrent
  -- admin_expire_offer/decline_waitlist_offer/second accept that already
  -- transitioned this row away from 'offered' causes this UPDATE to match
  -- zero rows, and the immediate `if not found` raises before any
  -- payment/notification/audit work below can run.
  update event_participants
    set status           = 'confirmed',
        offer_expires_at = null,
        updated_at       = now()
    where id     = v_my_row.id
      and status = 'offered'
  returning * into v_result;

  if not found then
    raise exception 'offer_no_longer_available';
  end if;

  -- Phase 34C (lifecycle correction): determine reactivation from prior
  -- payment existence, not from status — see header note above.
  select exists (
    select 1 from public.payments
     where club_id = v_profile.club_id
       and domain_type = 'event_participant'
       and domain_id = v_result.id
  ) into v_has_prior_payment;

  -- Ensure a payment obligation using the row's own already-snapshotted
  -- price and roster identity — no repricing here.
  perform public._create_payment_obligation(
    v_profile.club_id, 'event_participant', v_result.id, v_result.roster_member_id,
    v_result.price_amount_cents, auth.uid(), v_has_prior_payment
  );

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
$function$;

create or replace function public.decline_waitlist_offer(p_event_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
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
      and club_id = v_profile.club_id
    for update;

  if found and v_event.archived_at is not null then
    raise exception 'event_archived';
  end if;

  -- Phase 45E1: terminal write now reasserts status = 'offered' at the
  -- actual mutation — see accept_waitlist_offer's own comment above for
  -- the full race this closes (symmetric here: a concurrent
  -- admin_expire_offer/accept_waitlist_offer/second decline that already
  -- transitioned this row away from 'offered' causes zero rows to match).
  update event_participants
    set status           = 'cancelled',
        offer_expires_at = null,
        updated_at       = now()
    where id     = v_my_row.id
      and status = 'offered';

  if not found then
    raise exception 'offer_no_longer_available';
  end if;

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
$function$;

commit;
