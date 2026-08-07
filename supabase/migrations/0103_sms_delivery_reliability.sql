-- 0103_sms_delivery_reliability.sql
-- Phase 31C SMS reliability correction. Apply in Supabase SQL Editor (cloud
-- only). Additive only — no existing table, policy, or function from
-- migration 0102 is touched. Do not apply until this migration has been
-- reviewed; the application-code cutover in this same checkpoint is a
-- separate, already-written change that depends on these three functions
-- existing before it can be deployed.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 31C's first cutover round consolidated reservation/event SMS contact
-- resolution into a raw `supabase.from("profiles").select("sms_opt_in,
-- phone").eq("id", recipientUserId).single()` call, authorized only by
-- profiles' `profiles_select_same_club` RLS policy. Two confirmed local
-- reproductions (notification ids 8e1abb6f-946e-44c2-9680-787c3b0cf8eb and
-- 424895c2-07b8-4bcd-ac41-2d69e5d374c6, both reservation_cancelled_by_admin,
-- both with a valid phone and sms_opt_in = true on the recipient) showed
-- email succeeding while SMS produced zero notification_deliveries rows —
-- even after a prior correction made the contact-resolution failure path
-- record a `failed` row instead of returning silently, no SMS was ever
-- attempted. This confirms the profile-based reservation/event SMS contact
-- path is not pilot-reliable: `profiles_select_same_club`'s same-club branch
-- authorizes through `current_user_club_id()` (the active-membership helper,
-- 0082), a different mechanism than the one `get_user_email_for_notification`
-- uses to authorize the email side of the exact same dispatch call (a direct
-- `profiles.club_id`/`role` read for the caller, 0055) — these two
-- mechanisms are kept in sync only by 0081's compatibility triggers, and
-- nothing in the schema guarantees they can never diverge for a given
-- session.
--
-- This migration replaces that raw, RLS-dependent profiles read for the
-- reservation and event domains with the same pattern migration 0102 already
-- established for the waitlist domain: a narrowly-scoped, exact-identity,
-- SECURITY DEFINER RPC per domain, authorizing identically to that domain's
-- existing delivery-context RPC, returning only `phone`/`sms_opt_in`. It also
-- closes the confirmed SMS-side idempotency gap (no equivalent of
-- `email_already_delivered` exists for SMS) with one additional narrow RPC.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- FUNCTIONS ADDED (all new; nothing from 0102 or earlier is dropped,
-- recreated, or altered)
-- ═══════════════════════════════════════════════════════════════════════════
--   get_reservation_recipient_sms_contact(p_notification_id uuid) returns jsonb
--     Authorization identical to get_reservation_delivery_context (0102):
--     recipient always; same-club Admin only for reservation_cancelled_by_
--     admin / reservation_rescheduled; Pro never; cross-club denied.
--
--   get_event_recipient_sms_contact(p_notification_id uuid) returns jsonb
--     Authorization identical to get_event_delivery_context (0102):
--     recipient always; same-club Admin always; creator-Pro only when
--     events.created_by = auth.uid() for the event referenced in the
--     notification's own metadata.event_id; unrelated Pro denied; cross-club
--     denied.
--
--   sms_already_delivered(p_notification_id uuid) returns boolean
--     Pilot-level best-effort idempotency check mirroring
--     email_already_delivered's purpose (0055), but — unlike
--     email_already_delivered, which performs no authorization check at all
--     beyond requiring an authenticated caller — this one re-derives which
--     domain the notification belongs to (reservation / event / waitlist)
--     from its own `kind` column and applies that domain's exact
--     authorization rule (the same three rule sets as the three delivery-
--     context RPCs) before disclosing anything. An unauthorized or
--     cross-club caller gets `false`, identical to "not yet delivered" —
--     existence of the notification is never disclosed to a caller who
--     couldn't already prove standing over it via the matching context RPC.
--     Returns a bare boolean only — no notification content, no contact
--     info, no metadata.
--
-- Every function: SECURITY DEFINER, `set search_path = public, pg_temp`,
-- `revoke execute ... from public, anon`, `grant execute ... to
-- authenticated`. All three use current_user_club_id()/current_user_role()
-- for the caller's own context, exactly as every other domain-scoped RPC
-- added in migration 0102. None accepts a caller-supplied recipient id —
-- the recipient is always derived from `notifications.user_id` for the
-- exact `p_notification_id` given. None widens `profiles` or `notifications`
-- RLS. None uses service-role application code — all three run under the
-- calling user's own authenticated session, elevated only inside the
-- SECURITY DEFINER function body, exactly like every other RPC in this
-- schema.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- COMPATIBILITY WITH THE CURRENTLY DEPLOYED APP
-- ═══════════════════════════════════════════════════════════════════════════
-- Purely additive — three new functions, nothing dropped or altered. The
-- currently deployed app does not call any of these three names yet, so
-- applying this migration alone changes no behavior until the accompanying
-- application-code cutover (same checkpoint, separate deploy) is shipped.
-- ═══════════════════════════════════════════════════════════════════════════


-- ---------------------------------------------------------------------------
-- 1. get_reservation_recipient_sms_contact
-- ---------------------------------------------------------------------------
create or replace function public.get_reservation_recipient_sms_contact(
  p_notification_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_caller_id   uuid := auth.uid();
  v_caller_club uuid;
  v_caller_role text;
  v_notif       public.notifications%rowtype;
  v_phone       text;
  v_sms_opt_in  boolean;
begin
  if v_caller_id is null then return null; end if;

  select public.current_user_club_id(), public.current_user_role()
    into v_caller_club, v_caller_role;
  if v_caller_club is null then return null; end if;

  select * into v_notif from public.notifications where id = p_notification_id;
  if not found then return null; end if;

  -- Domain guard: reject any notification id that isn't a reservation kind.
  if v_notif.kind not in (
    'reservation_confirmed',
    'reservation_cancelled_by_admin',
    'reservation_cancelled_by_member',
    'reservation_rescheduled'
  ) then
    return null;
  end if;

  -- Club isolation.
  if v_notif.club_id is distinct from v_caller_club then return null; end if;

  -- Authorization: recipient always; same-club Admin only for the two
  -- Admin-driven kinds; Pro never. Identical to
  -- get_reservation_delivery_context's rule (0102).
  if v_caller_id = v_notif.user_id then
    null;
  elsif v_caller_role = 'admin'
        and v_notif.kind in ('reservation_cancelled_by_admin', 'reservation_rescheduled') then
    null;
  else
    return null;
  end if;

  select phone, sms_opt_in into v_phone, v_sms_opt_in
    from public.profiles
    where id = v_notif.user_id;

  return jsonb_build_object('phone', v_phone, 'sms_opt_in', coalesce(v_sms_opt_in, false));
end;
$$;

revoke execute on function public.get_reservation_recipient_sms_contact(uuid) from public, anon;
grant  execute on function public.get_reservation_recipient_sms_contact(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 2. get_event_recipient_sms_contact
-- ---------------------------------------------------------------------------
create or replace function public.get_event_recipient_sms_contact(
  p_notification_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_caller_id   uuid := auth.uid();
  v_caller_club uuid;
  v_caller_role text;
  v_notif       public.notifications%rowtype;
  v_event_id    uuid;
  v_event       public.events%rowtype;
  v_phone       text;
  v_sms_opt_in  boolean;
begin
  if v_caller_id is null then return null; end if;

  select public.current_user_club_id(), public.current_user_role()
    into v_caller_club, v_caller_role;
  if v_caller_club is null then return null; end if;

  select * into v_notif from public.notifications where id = p_notification_id;
  if not found then return null; end if;

  if v_notif.kind not in ('event_cancelled', 'event_joined', 'event_updated') then
    return null;
  end if;

  if v_notif.club_id is distinct from v_caller_club then return null; end if;

  -- Authorization identical to get_event_delivery_context's rule (0102):
  -- recipient always; same-club Admin always; creator-Pro only, derived
  -- from the trusted, immutable metadata.event_id and events.created_by
  -- established by the notification-creating mutation RPCs — never a
  -- caller-supplied recipient or event id.
  if v_caller_id = v_notif.user_id then
    null;
  elsif v_caller_role = 'admin' then
    null;
  elsif v_caller_role = 'pro' then
    v_event_id := nullif(v_notif.metadata->>'event_id', '')::uuid;
    if v_event_id is null then return null; end if;

    select * into v_event from public.events
      where id = v_event_id and club_id = v_caller_club;
    if not found then return null; end if;

    if v_event.created_by is distinct from v_caller_id then
      return null;
    end if;
  else
    return null;
  end if;

  select phone, sms_opt_in into v_phone, v_sms_opt_in
    from public.profiles
    where id = v_notif.user_id;

  return jsonb_build_object('phone', v_phone, 'sms_opt_in', coalesce(v_sms_opt_in, false));
end;
$$;

revoke execute on function public.get_event_recipient_sms_contact(uuid) from public, anon;
grant  execute on function public.get_event_recipient_sms_contact(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 3. sms_already_delivered
-- Pilot-level best-effort idempotency for SMS, matching the existing
-- email_already_delivered approach in spirit (a single exists() check
-- against notification_deliveries) but, unlike email_already_delivered,
-- authorized per-domain before disclosing anything — see header. Not a
-- queue, not a pending/lease status, not a distributed worker — a single
-- boolean guard called immediately before contacting Twilio.
-- ---------------------------------------------------------------------------
create or replace function public.sms_already_delivered(
  p_notification_id uuid
)
returns boolean
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_caller_id    uuid := auth.uid();
  v_caller_club  uuid;
  v_caller_role  text;
  v_notif        public.notifications%rowtype;
  v_event_id     uuid;
  v_event        public.events%rowtype;
  v_triggered_by uuid;
  v_authorized   boolean := false;
begin
  if v_caller_id is null then return false; end if;

  select public.current_user_club_id(), public.current_user_role()
    into v_caller_club, v_caller_role;
  if v_caller_club is null then return false; end if;

  select * into v_notif from public.notifications where id = p_notification_id;
  if not found then return false; end if;

  if v_notif.club_id is distinct from v_caller_club then return false; end if;

  if v_notif.kind in (
    'reservation_confirmed',
    'reservation_cancelled_by_admin',
    'reservation_cancelled_by_member',
    'reservation_rescheduled'
  ) then
    -- Reservation domain rule — identical to
    -- get_reservation_recipient_sms_contact / get_reservation_delivery_context.
    if v_caller_id = v_notif.user_id then
      v_authorized := true;
    elsif v_caller_role = 'admin'
          and v_notif.kind in ('reservation_cancelled_by_admin', 'reservation_rescheduled') then
      v_authorized := true;
    end if;

  elsif v_notif.kind in ('event_cancelled', 'event_joined', 'event_updated') then
    -- Event domain rule — identical to get_event_recipient_sms_contact /
    -- get_event_delivery_context.
    if v_caller_id = v_notif.user_id then
      v_authorized := true;
    elsif v_caller_role = 'admin' then
      v_authorized := true;
    elsif v_caller_role = 'pro' then
      v_event_id := nullif(v_notif.metadata->>'event_id', '')::uuid;
      if v_event_id is not null then
        select * into v_event from public.events
          where id = v_event_id and club_id = v_caller_club;
        if found and v_event.created_by = v_caller_id then
          v_authorized := true;
        end if;
      end if;
    end if;

  elsif v_notif.kind in ('waitlist_offer', 'waitlist_promoted') then
    -- Waitlist domain rule — identical to get_waitlist_recipient_sms_contact
    -- / get_waitlist_delivery_context.
    v_triggered_by := nullif(v_notif.metadata->>'triggered_by', '')::uuid;
    if v_caller_id = v_notif.user_id then
      v_authorized := true;
    elsif v_caller_role = 'admin' then
      v_authorized := true;
    elsif v_triggered_by is not null and v_caller_id = v_triggered_by then
      v_authorized := true;
    end if;

  else
    -- Unsupported/unknown kind for SMS dispatch — deny rather than guess.
    return false;
  end if;

  if not v_authorized then return false; end if;

  return exists(
    select 1 from public.notification_deliveries
     where notification_id = p_notification_id
       and channel         = 'sms'
       and status          = 'sent'
  );
end;
$$;

revoke execute on function public.sms_already_delivered(uuid) from public, anon;
grant  execute on function public.sms_already_delivered(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- End of 0103_sms_delivery_reliability.sql
-- ═══════════════════════════════════════════════════════════════════════════
