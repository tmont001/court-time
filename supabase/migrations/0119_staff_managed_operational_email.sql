-- 0119_staff_managed_operational_email.sql
-- Phase 33E3: Staff-Managed Communications — minimum operational email for
-- legitimate no-account Members.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- The existing notification/email architecture (notifications,
-- notification_preferences, notification_deliveries) is entirely account-
-- based: notifications.user_id is NOT NULL, references profiles(id), and
-- every email/SMS resolution RPC (get_user_email_for_notification,
-- get_waitlist_recipient_email, the SMS contact RPCs) resolves the
-- recipient through an authenticated user_id. None of it can represent a
-- no-account roster Member (roster_members.claimed_by IS NULL) — there is
-- no profiles row, hence no user_id, to attach a notification to. Retro-
-- fitting user_id to nullable, or a roster_member_id column onto
-- notifications, would weaken a NOT NULL identity guarantee the rest of
-- that system (RLS, delivery dedup, preferences) depends on — explicitly
-- avoided here per instruction.
--
-- This migration adds a SEPARATE, minimal, roster_member_id-keyed
-- operational-email path, used ONLY for transactional/operational kinds
-- (never announcement/marketing — those remain account/preferences-based
-- only, matching product scope). It does not touch notifications,
-- notification_preferences, or notification_deliveries in any way.
--
-- SCOPE — function-only, no schema change:
--   1. get_roster_member_email_for_notification — resolves an unclaimed,
--      active roster identity's email. Returns null (never crashes, never
--      fabricates a recipient) for a claimed identity, an inactive one, a
--      missing email, or a wrong-club/unauthorized lookup.
--   2. record_roster_operational_email — audit_log-backed delivery record.
--      No new table: audit_log (0005, generic club_id/actor_id/action/
--      target_type/target_id/metadata) already fits this exactly, avoiding
--      a bespoke notification_deliveries-style table for what is expected
--      to be low-volume traffic.
--   3. admin_cancel_reservation_v2 — BUG FIX. Its notification insert
--      (`user_id = v_res.owner_user_id`) has been unconditional since 0102,
--      predating 0108's relaxation of reservations.owner_user_id to
--      nullable. Cancelling a no-account Member's staff-created reservation
--      today raises a NOT NULL violation and rolls back the ENTIRE
--      cancellation — not a missing-notification gap, a genuine crash.
--      Fixed here with the same `if ... is not null` guard 0109 already
--      applied to update_member_reservation for the identical reason.
--
-- Explicitly NOT in this migration: Program waitlist offer email for a
-- no-account Member — considered and removed from this checkpoint. The
-- promotion trigger points include normal MEMBER-initiated actions
-- (leave_program, decline_program_waitlist_offer), which cannot be
-- authorized through an admin/pro-only claim RPC the way the reservation
-- and lesson staff-action call sites can — a Member-triggered promotion
-- would silently never email the promoted no-account enrollee, meaning that
-- design did not actually cover all Program promotion paths. A correct fix
-- also needs delivery-confirmed (not claim-before-send) idempotency, which
-- would require an outbox/worker/retry mechanism disproportionate to this
-- checkpoint. Deferred in full, alongside the already-deferred Event
-- waitlist offer email, lesson reschedule/update no-account email (admin_
-- update_member_lesson's return shape doesn't expose a changed-fields
-- signal the way update_member_reservation's does), any new SMS path (no
-- roster-level consent representation exists anywhere in this schema — a
-- phone number alone is not consent), and any change to announcement/
-- marketing delivery.
--
-- No preflight: no existing production data is transformed, backfilled, or
-- constrained — three function replacements, zero schema change, zero data
-- migration. No standalone verifier: risk is bounded by function-level
-- guards (see each function body) and the runtime QA plan in the
-- implementation report.
--
-- Not applied by this checkpoint. Not committed. Does not modify migrations
-- 0107-0118.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. get_roster_member_email_for_notification
-- Admin or pro, same club as the target roster identity (matches the
-- authorization boundary already used by every Event/Reservation roster-
-- management RPC in this project — current_user_club_id()/
-- current_user_role(), stale-club guard). Returns the identity's email ONLY
-- when it is genuinely unclaimed (claimed_by IS NULL) AND active
-- (status = 'active') — a claimed identity's email must flow through the
-- existing account-based notification/email pipeline, never this one; an
-- inactive identity is never a valid operational-email target (matches the
-- 33E2 lifecycle invariant). Returns null, never raises, for every "not a
-- valid target" case (not found, claimed, inactive, no email) — only
-- genuine caller-authorization failures raise, matching every other RPC in
-- this domain.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.get_roster_member_email_for_notification(
  p_roster_member_id  uuid,
  p_expected_club_id  uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_roster  public.roster_members%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is null or v_role not in ('admin', 'pro') then raise exception 'admin_required'; end if;

  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_club_id;
  if not found then return null; end if;

  if v_roster.claimed_by is not null then return null; end if;
  if v_roster.status is distinct from 'active' then return null; end if;

  return v_roster.email;
end;
$$;

revoke execute on function public.get_roster_member_email_for_notification(uuid, uuid) from public, anon;
grant  execute on function public.get_roster_member_email_for_notification(uuid, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. record_roster_operational_email
-- Same authorization boundary as above. Writes one audit_log row per
-- delivery attempt — actor_id is the calling admin/pro (auth.uid()), never
-- the recipient (audit_log.actor_id is NOT NULL references profiles(id),
-- which a no-account identity cannot satisfy — recipient identity is
-- carried in target_id/target_type instead, exactly as every other
-- roster_member-targeting audit_log write in this project already does).
-- Called by the TypeScript delivery layer AFTER the actual send attempt
-- (success or failure) — a failure to write this log row must never surface
-- to the user or affect delivery state; the caller wraps this in the same
-- non-blocking try/catch discipline used for record_delivery_attempt
-- throughout src/lib/email.ts and src/lib/sms.ts.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.record_roster_operational_email(
  p_roster_member_id     uuid,
  p_expected_club_id     uuid,
  p_kind                 text,
  p_status               text,
  p_provider_message_id  text default null,
  p_error                text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is null or v_role not in ('admin', 'pro') then raise exception 'admin_required'; end if;

  if p_status not in ('sent', 'failed') then raise exception 'invalid_status'; end if;

  if not exists (
    select 1 from public.roster_members
     where id      = p_roster_member_id
       and club_id = v_club_id
  ) then
    raise exception 'roster_member_not_found';
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id,
    auth.uid(),
    'roster_operational_email',
    'roster_member',
    p_roster_member_id,
    jsonb_build_object(
      'kind',                p_kind,
      'status',               p_status,
      'channel',              'email',
      'provider',             'resend',
      'provider_message_id',  p_provider_message_id,
      'error',                p_error
    )
  );
end;
$$;

revoke execute on function public.record_roster_operational_email(uuid, uuid, text, text, text, text) from public, anon;
grant  execute on function public.record_roster_operational_email(uuid, uuid, text, text, text, text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. admin_cancel_reservation_v2 — BUG FIX. Live source: 0102, unmodified
-- since. Only change: the notification insert is now guarded by
-- `v_res.owner_user_id is not null` — everything else (auth, cancellation
-- write, audit_log, return shape) is byte-for-byte identical to the current
-- live body. v_notification_id stays null (its declared default) when
-- skipped, exactly matching update_member_reservation's own established
-- "no notification, no crash" behavior for an unclaimed owner (0109).
-- Verified safe to change under the same name/signature: the only caller
-- (calendar/actions.ts's adminCancelReservation) already handles a null
-- notification_id.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.admin_cancel_reservation_v2(
  p_reservation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile         public.profiles%rowtype;
  v_res             public.reservations%rowtype;
  v_result          public.reservations%rowtype;
  v_tz              text;
  v_notification_id uuid;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.role <> 'admin' then
    raise exception 'insufficient_role';
  end if;

  select * into v_res
    from public.reservations
    where id      = p_reservation_id
      and club_id = v_profile.club_id
      and status in ('pending', 'confirmed');
  if not found then raise exception 'reservation_not_found'; end if;

  update public.reservations set
    status            = 'cancelled',
    cancelled_at      = now(),
    cancelled_by      = auth.uid(),
    cancellation_kind = 'admin',
    updated_at        = now()
  where id = p_reservation_id
  returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'admin_cancel_reservation',
    'reservation',
    p_reservation_id,
    jsonb_build_object(
      'court_id',      v_res.court_id,
      'owner_user_id', v_res.owner_user_id,
      'starts_at',     v_res.starts_at,
      'reason',        v_res.reason
    )
  );

  select timezone into v_tz from public.clubs where id = v_profile.club_id;

  -- Phase 33E3 fix: owner_user_id is nullable since 0108 (a no-account
  -- Member's staff-created reservation) — this insert would otherwise
  -- violate notifications.user_id's NOT NULL constraint and roll back the
  -- entire cancellation. The no-account operational email path (TypeScript
  -- layer, using v_result.roster_member_id from this function's own return
  -- value) covers that case instead — no in-app notification exists for it.
  if v_res.owner_user_id is not null then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_profile.club_id,
      v_res.owner_user_id,
      'reservation_cancelled_by_admin',
      'Your reservation on '
        || to_char(v_res.starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM')
        || ' was cancelled by the club.',
      jsonb_build_object('reservation_id', p_reservation_id)
    )
    returning id into v_notification_id;
  end if;

  return jsonb_build_object(
    'reservation',     to_jsonb(v_result),
    'notification_id', v_notification_id
  );
end;
$$;

revoke execute on function public.admin_cancel_reservation_v2(uuid) from public, anon;
grant  execute on function public.admin_cancel_reservation_v2(uuid) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- admin_cancel_reservation_v2's rollback is a direct CREATE OR REPLACE
-- FUNCTION using 0102's body verbatim (restores the unconditional insert —
-- reintroducing the crash this migration fixes, so only do this if 0102's
-- exact behavior is genuinely required for some other reason). New
-- functions get_roster_member_email_for_notification/record_roster_
-- operational_email would each need an explicit DROP FUNCTION.
