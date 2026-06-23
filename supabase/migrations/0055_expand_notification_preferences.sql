-- Phase 21E-A: expand notification_preferences to allow all 8 notification
-- kinds. Previously only 4 kinds (reservation_confirmed,
-- reservation_cancelled_by_member, event_joined, announcement) were
-- user-configurable. The other 4 (reservation_cancelled_by_admin,
-- event_cancelled, waitlist_offer, waitlist_promoted) were mandatory and
-- had no preference rows.
--
-- Under the new product decision, all 8 kinds are default-ON (no row =
-- enabled) and members can opt out of email delivery for any kind. In-app
-- delivery for the 4 previously-mandatory kinds is unchanged — those
-- notifications always appear in the bell regardless of this setting.
--
-- The update_notification_preference RPC allowlist is expanded to match.
--
-- user_pref_enabled() is not changed — it is already generic and returns
-- coalesce(enabled, true) for any kind.
--
-- Also adds two security-definer helpers required by the email dispatch layer:
--
--   get_user_email_for_notification(p_notification_id) — reads auth.users.email
--     for the notification recipient. Requires the caller to be authenticated,
--     in the same club as the notification, and either the recipient themselves
--     or an admin/pro. Returns null on any authorization failure.
--
--   email_already_delivered(p_notification_id) — checks notification_deliveries
--     for an existing sent email for this notification. Used as a duplicate-send
--     guard before calling Resend. Security definer bypasses the admin-only RLS
--     on notification_deliveries so server actions can call it in any role context.
--
-- DEPLOYMENT ORDER (do not skip steps):
--   1. Add RESEND_API_KEY to Vercel → Settings → Environment Variables
--      (Production; server-side only — no NEXT_PUBLIC_ prefix).
--   2. Apply this migration in Supabase SQL Editor.
--   3. Deploy app code to Vercel (push main / trigger redeploy).
--   4. Run production QA (trigger a booking, verify email in Resend logs).
--
-- This migration is additive and non-destructive: no data is lost.

-- ---------------------------------------------------------------------------
-- 1. get_user_email_for_notification
--    Reads auth.users.email for a notification's recipient.
--    Authorization: caller must be authenticated, in the same club as the
--    notification, and either the recipient themselves OR have role admin/pro.
--    Returns null on any authorization failure — never raises.
-- ---------------------------------------------------------------------------
create or replace function get_user_email_for_notification(p_notification_id uuid)
returns text
language plpgsql security definer stable as $$
declare
  v_caller_id      uuid := auth.uid();
  v_caller_club_id uuid;
  v_caller_role    text;
  v_notif_club_id  uuid;
  v_notif_user_id  uuid;
begin
  if v_caller_id is null then
    return null;
  end if;

  select club_id, role
    into v_caller_club_id, v_caller_role
    from profiles
   where id = v_caller_id;

  select club_id, user_id
    into v_notif_club_id, v_notif_user_id
    from notifications
   where id = p_notification_id;

  -- Both the caller and notification must belong to the same club.
  if v_caller_club_id is null
     or v_notif_club_id  is null
     or v_caller_club_id  != v_notif_club_id then
    return null;
  end if;

  -- Caller must be the notification recipient OR have an elevated role.
  if v_caller_id != v_notif_user_id
     and v_caller_role not in ('admin', 'pro') then
    return null;
  end if;

  return (select email from auth.users where id = v_notif_user_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. email_already_delivered
--    Returns true if a 'sent' email delivery row already exists for this
--    notification. Security definer bypasses the admin-only SELECT policy on
--    notification_deliveries so member-context server actions can use it.
-- ---------------------------------------------------------------------------
create or replace function email_already_delivered(p_notification_id uuid)
returns boolean
language sql security definer stable as $$
  select exists(
    select 1
      from notification_deliveries
     where notification_id = p_notification_id
       and channel         = 'email'
       and status          = 'sent'
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. Expand notification_preferences.kind CHECK constraint to all 8 kinds
-- ---------------------------------------------------------------------------
alter table notification_preferences
  drop constraint if exists notification_preferences_kind_check;

alter table notification_preferences
  add constraint notification_preferences_kind_check
  check (kind in (
    'reservation_confirmed',
    'reservation_cancelled_by_member',
    'reservation_cancelled_by_admin',
    'event_joined',
    'event_cancelled',
    'waitlist_offer',
    'waitlist_promoted',
    'announcement'
  ));

-- ---------------------------------------------------------------------------
-- 4. Replace update_notification_preference with the expanded allowlist
-- ---------------------------------------------------------------------------
create or replace function update_notification_preference(
  p_kind    text,
  p_enabled boolean
)
returns void
language plpgsql security definer as $$
declare
  v_club_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  if p_kind not in (
    'reservation_confirmed',
    'reservation_cancelled_by_member',
    'reservation_cancelled_by_admin',
    'event_joined',
    'event_cancelled',
    'waitlist_offer',
    'waitlist_promoted',
    'announcement'
  ) then
    raise exception 'invalid_kind';
  end if;

  select club_id into v_club_id from profiles where id = auth.uid();

  insert into notification_preferences (user_id, club_id, kind, enabled, updated_at)
  values (auth.uid(), v_club_id, p_kind, p_enabled, now())
  on conflict (user_id, kind) do update
    set enabled    = excluded.enabled,
        updated_at = now();
end;
$$;
