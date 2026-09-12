-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 36E correction — announcement eligibility bug (recipients AND sender)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0102/0171 are APPLIED and VERIFIED. This migration does not edit either
-- of them — it redefines send_announcement_v2(text, text) again via CREATE
-- OR REPLACE (same name, same signature, so the existing EXECUTE grants,
-- SECURITY DEFINER, and pinned search_path all carry forward unchanged —
-- no GRANT/REVOKE statements are needed or included here).
--
-- Both the RECIPIENT audience and the SENDER'S OWN admin authorization use
-- canonical, always-current club_memberships state as of this migration —
-- neither may be decided from the profiles legacy projection.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ROOT CAUSE, PART 1 — recipient eligibility (originally identified)
-- ═══════════════════════════════════════════════════════════════════════════
-- send_announcement_v2's recipient selection (unchanged since 0102) read:
--
--   from public.profiles p
--   where p.club_id = v_profile.club_id
--     and p.status  = 'active'
--     and p.id      <> auth.uid()
--     and coalesce((select enabled from notification_preferences ...), true)
--
-- profiles.club_id and profiles.status are LEGACY PROJECTION columns —
-- 0081_club_membership_compatibility_foundation.sql's own trigger
-- (trg_project_membership_to_profile) keeps them in sync ONLY while a
-- club_memberships row remains that user's current, valid, active
-- membership. The moment a Member is removed (remove_club_member sets
-- club_memberships.removed_at) or deactivated (set_member_status sets
-- club_memberships.status <> 'active'), that trigger explicitly — and by
-- documented design, at lines 448-453 of 0081 — leaves profiles.club_id
-- and profiles.status UNTOUCHED:
--
--   "Zero, or more than one: never guess. Clear it. Legacy columns
--    (club_id/role/status/is_lesson_provider) are deliberately left
--    untouched here ... existing admin RPCs still locate and reactivate
--    inactive users through profiles.club_id."
--
-- That design is correct for ITS purpose (letting an Admin find and
-- restore a removed/inactive member by their last-known club). It is NOT
-- a safe "is this person currently an active member of this club" check
-- — which is exactly what send_announcement_v2 used it for. The result:
-- a removed or deactivated Member's profiles row keeps showing their old
-- club_id and a frozen, stale 'active' status forever, so they continue
-- to match send_announcement_v2's WHERE clause and receive every future
-- announcement — both the in-app notification row AND the email (which
-- communicationsActions.ts sends by looping this RPC's own returned
-- {notification_id, user_id}[] — there is no second, separate recipient
-- query for email, so fixing this ONE query corrects both channels at
-- once).
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ROOT CAUSE, PART 2 — sender authorization (found in review of the
-- part-1 fix, before this migration was ever applied)
-- ═══════════════════════════════════════════════════════════════════════════
-- The part-1 draft of this migration kept the ORIGINAL sender-authorization
-- check unchanged:
--
--   select * into v_profile from public.profiles where id = auth.uid();
--   if not found then raise exception 'not_authenticated'; end if;
--   if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;
--   ... later: cm.club_id = v_profile.club_id
--
-- This is the EXACT SAME class of bug as part 1, just on the sender side:
-- v_profile.role/club_id are the identical stale legacy projection. A
-- former Admin whose club_memberships row was later removed or
-- deactivated would keep v_profile.role = 'admin' and v_profile.club_id
-- pointing at their old club FOREVER — meaning this SECURITY DEFINER RPC
-- could keep accepting them as an Admin of a club they no longer belong
-- to, and the recipient query would keep scoping to that stale club_id.
-- A privileged RPC's own authorization must never trust that projection.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- FIX
-- ═══════════════════════════════════════════════════════════════════════════
-- Sender authorization now uses current_user_club_id()/current_user_role()
-- — the SAME canonical helpers current_user_role() is built on for every
-- RLS policy and RPC in the schema (0082_active_club_authorization_
-- foundation.sql), and the exact pattern remove_club_member/
-- set_member_status (0117) already establish for this same "is the caller
-- currently an active Admin" question:
--
--   if auth.uid() is null then raise exception 'not_authenticated'; end if;
--   select current_user_club_id(), current_user_role() into v_club_id, v_role;
--   if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;
--
-- current_user_role()/current_user_club_id() resolve EXCLUSIVELY through
-- club_memberships (via the private _current_user_active_membership()
-- helper, 0082) — never profiles.role/club_id, directly or as a fallback.
-- For a removed, inactive, or suspended membership, both return NULL
-- unconditionally, regardless of whatever profiles.role/club_id still say.
-- `is distinct from` (not `<>`) is required precisely because a NULL role
-- must be REJECTED, not silently pass a plain `<>` comparison (which
-- evaluates to NULL, and an IF condition that evaluates to NULL is treated
-- as false in PL/pgSQL — the exact trap this migration avoids by matching
-- the established idiom exactly).
--
-- Recipient selection then scopes to v_club_id (the VERIFIED club from the
-- caller's own canonical active membership) instead of any profiles
-- column:
--
--   from public.club_memberships cm
--   where cm.club_id    = v_club_id
--     and cm.status     = 'active'
--     and cm.removed_at is null
--     and cm.user_id   <> auth.uid()
--     and coalesce((select enabled from notification_preferences ...), true)
--
-- No join to profiles is needed anywhere in this function any more — the
-- insert only ever consumed an id, identical to cm.user_id, and v_club_id
-- already carries the verified club identity for both the notifications
-- insert and the audit_log entry.
--
-- Preserved exactly, byte-for-byte in behavior, from the 0171 body:
--   - the external error contract (not_authenticated, insufficient_role,
--     invalid_announcement) — same exception strings, same three failure
--     categories, only the INTERNAL derivation of who is a valid Admin
--     changed
--   - title/body validation
--   - self-exclusion (the sender never receives their own announcement)
--   - announcement notification-preference filtering
--     (notification_preferences.kind='announcement', enabled defaults to
--     true when no preference row exists) — preference SEMANTICS are
--     unchanged; only WHO is even considered (as sender or recipient)
--     changed
--   - the notifications insert shape and its announcement_batch_id
--     metadata stamp (via gen_random_uuid())
--   - recipient_count, the exact {notification_id, user_id} returned
--     list, and the audit_log 'send_announcement' entry
--   - every role (member/pro/staff/admin) remains eligible as a
--     RECIPIENT exactly as before — this fix narrows WHO currently holds
--     an active membership (as sender or recipient), it does not narrow
--     WHICH roles may receive an announcement; club_memberships.role is
--     never filtered on in the recipient query, matching the
--     pre-existing, unchanged all-roles-eligible behavior. An active Pro
--     remains just as eligible a recipient as an active Member, Staff, or
--     Admin, subject only to their own announcement preference.
--
-- No cross-club leakage is introduced or possible: cm.club_id = v_club_id,
-- the sender's own VERIFIED (not merely stale-projected) club — a user's
-- membership row in any OTHER club is never matched, and a sender with no
-- current valid active-Admin membership anywhere can never produce a
-- v_club_id at all (the function raises before reaching the recipient
-- query).
--
-- Does not touch 0170, any table, any RLS policy, the payment domain, or
-- get_communications_activity/get_announcement_batch_delivery_context
-- (historical reporting over already-sent batches — out of scope; this
-- fix only changes who may send, and who is selected as a recipient, for
-- FUTURE announcements).
--
-- Apply in Supabase SQL Editor (cloud only). Not applied by this
-- checkpoint — prepared for migration review only.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace function public.send_announcement_v2(
  p_title text,
  p_body  text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id         uuid;
  v_role            text;
  v_batch_id        uuid := gen_random_uuid();
  v_notifications   jsonb;
  v_recipient_count integer;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_role is distinct from 'admin' then
    raise exception 'insufficient_role';
  end if;

  if trim(p_title) = '' or trim(p_body) = '' then
    raise exception 'invalid_announcement';
  end if;
  if length(trim(p_title)) > 100 or length(trim(p_body)) > 500 then
    raise exception 'invalid_announcement';
  end if;

  with ins as (
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    select
      v_club_id,
      cm.user_id,
      'announcement',
      trim(p_body),
      jsonb_build_object(
        'title',                trim(p_title),
        'sender_id',             auth.uid(),
        'announcement_batch_id', v_batch_id
      )
    from public.club_memberships cm
    where cm.club_id    = v_club_id
      and cm.status     = 'active'
      and cm.removed_at is null
      and cm.user_id   <> auth.uid()
      and coalesce(
        (select enabled
           from public.notification_preferences
          where user_id = cm.user_id
            and kind    = 'announcement'),
        true
      ) = true
    returning id, user_id
  )
  select
    coalesce(jsonb_agg(jsonb_build_object('notification_id', id, 'user_id', user_id)), '[]'::jsonb),
    count(*)
  into v_notifications, v_recipient_count
  from ins;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id,
    auth.uid(),
    'send_announcement',
    'club',
    v_club_id,
    jsonb_build_object(
      'title',           trim(p_title),
      'recipient_count', v_recipient_count,
      'batch_id',        v_batch_id
    )
  );

  return jsonb_build_object(
    'batch_id',        v_batch_id,
    'recipient_count', v_recipient_count,
    'notifications',   v_notifications
  );
end;
$$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run manually after applying — NOT executed automatically by
-- this file)
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Confirm the function body no longer reads the profiles legacy
--    projection anywhere, for sender OR recipients:
--      select prosrc from pg_proc where proname = 'send_announcement_v2';
--    should contain "from public.club_memberships cm" and
--    "public.current_user_club_id(), public.current_user_role()", and
--    must NOT contain "from public.profiles p", "p.status  = 'active'",
--    "v_profile.role", or "v_profile.club_id".
--
-- 2. Sender authorization — reproduce the bug's precondition, then confirm
--    it's fixed:
--    a. As an Admin, remove or deactivate ANOTHER Admin account in your
--       club (remove_club_member / set_member_status via the Members
--       admin UI) — use a second test Admin, not your own account
--       (set_member_status/remove_club_member both already reject
--       changing/removing your own membership).
--    b. select role, club_id from public.profiles where id = '<that
--       admin's id>'; — confirm this STILL shows role='admin' and the old
--       club_id (proving the legacy-column staleness this migration works
--       around, not something this migration attempts to fix).
--    c. select role, status, removed_at from public.club_memberships
--       where user_id = '<that admin's id>'; — confirm removed_at is set
--       (or status <> 'active').
--    d. Attempting to call send_announcement_v2 AS that removed/deactivated
--       former Admin (e.g. via the app while impersonating/signed in as
--       that test account, or a direct authenticated RPC call using their
--       session) must fail with insufficient_role — never succeed, never
--       insert any notification.
--    e. Confirm an ordinary CURRENT active Admin in the same club can
--       still send successfully.
--
-- 3. Recipient eligibility — reproduce the bug's precondition, then
--    confirm it's fixed:
--    a. As an Admin, remove or deactivate a test Member in your club.
--    b. select club_id, status from public.profiles where id = '<that
--       member's id>'; — confirm this STILL shows the old club_id and
--       'active'.
--    c. select club_id, status, removed_at from public.club_memberships
--       where user_id = '<that member's id>'; — confirm removed_at is set
--       (or status <> 'active').
--    d. As a current active Admin, send a real announcement from
--       /admin/communications (Compose tab).
--    e. select * from public.notifications where kind = 'announcement'
--       and user_id = '<that member's id>' order by created_at desc
--       limit 1; — confirm NO new row was created for this batch.
--    f. Confirm no email was sent to that member for this batch (check
--       your email provider's dashboard/logs for the test address, or
--       notification_deliveries for a lack of any new row keyed to a
--       notification for that user in this batch).
--
-- 4. Confirm an ordinary ACTIVE Member, Pro, Staff, and another Admin in
--    the same club still receive both the in-app notification and the
--    email for a new test announcement, exactly as before this migration
--    — in particular, confirm an active Pro is NOT excluded (this
--    migration adds no role filter to the recipient query).
--
-- 5. Confirm a Member with the announcement in-app/email preference
--    explicitly disabled (profile/notifications settings) still does not
--    receive it — preference semantics are unchanged by this migration.
--
-- 6. Confirm no cross-club leakage: a user who is active in a DIFFERENT
--    club (and has no membership row at all in the sending club) never
--    appears among recipients, and cannot use their OWN club's Admin
--    standing to send into a club they do not belong to.
-- ═══════════════════════════════════════════════════════════════════════════
-- End of 0177_announcement_active_membership_eligibility.sql
-- ═══════════════════════════════════════════════════════════════════════════
