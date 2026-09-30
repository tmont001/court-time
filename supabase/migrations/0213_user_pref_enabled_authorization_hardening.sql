-- 0213_user_pref_enabled_authorization_hardening.sql
-- Phase 45D1 — fixes the P1 finding from the Phase 45D authorization audit:
-- public.user_pref_enabled(p_user_id uuid, p_kind text) accepted p_user_id
-- verbatim with NO authorization check at all, letting any authenticated
-- user (any role, any club) query any OTHER user's (any club's)
-- notification-kind preference. Confirmed live via pg_get_functiondef and a
-- read-only EXECUTE-ACL check during the audit; not exploitable for
-- anything beyond a low-value boolean, but a genuine, unauthenticated-by-
-- role, unscoped-by-club IDOR with zero legitimate justification for most
-- callers.
--
-- CALL-SITE AUDIT (read-only, before writing this migration — see the
-- Phase 45D1 report for the full inventory):
--   - Every SQL caller across 30+ prior migrations passes auth.uid() as
--     p_user_id (self-check) — a naive `p_user_id = auth.uid()` restriction
--     would not break any of these.
--   - src/lib/email.ts's sendEmailNotification (the shared dispatcher for
--     reservation/event/waitlist email) legitimately calls this CROSS-USER
--     — its own comment: "works cross-user (e.g. admin cancelling a
--     member's reservation)".
--   - Critically, src/lib/notification-dispatch.ts's own header comment for
--     dispatchWaitlistNotification documents that the TRIGGERING actor can
--     be "the Member who called leave_event" — i.e. an ordinary Member,
--     not just Admin/Staff/Pro — notifying a DIFFERENT member (the newly-
--     offered waitlisted member). Confirmed live in
--     src/app/(app)/calendar/actions.ts's leaveEvent, which runs entirely
--     under the leaving Member's own session with no elevated-role gate
--     before dispatch.
--   - src/app/(app)/lessons/actions.ts's dispatchLessonEmail has an
--     explicit comment: "A member calling dispatchLessonEmail to send to
--     the pro would fail that guard [get_user_email_for_notification's
--     admin/pro-only restriction]" — a second, independent confirmation
--     that an ordinary Member is a legitimate cross-user caller here, this
--     time notifying their Pro.
--
-- CONCLUSION: no role-based allowlist (admin/pro/staff or any subset) can
-- correctly gate this function without breaking real, currently-shipped
-- notification dispatch — Member is a required, legitimate cross-user
-- caller in at least two independent domains. The actual, evidence-backed
-- minimum boundary is CLUB, not role: the confirmed exploitable gap was
-- specifically CROSS-CLUB access (a user from Club A reading a Club B
-- user's preference), which no legitimate call site ever requires — every
-- real cross-user call site already targets a SAME-CLUB counterparty (the
-- other party to a reservation/event/waitlist/lesson interaction, which by
-- construction shares the caller's club).
--
-- IMPORTANT CORRECTION (migration review, before this file was ever
-- applied): the first draft of this migration resolved "club" for both
-- caller and target via profiles.club_id directly. That is NOT this
-- schema's authorization truth under the multi-club foundation —
-- profiles.club_id is legacy/informational only; the actual current-club
-- authority is the ACTIVE MEMBERSHIP model (profiles.active_club_id joined
-- to a club_memberships row with status='active' and removed_at is null —
-- see public.current_user_club_id()/_current_user_active_membership(),
-- confirmed live via pg_get_functiondef before writing this correction).
-- Using profiles.club_id would have reintroduced exactly the kind of
-- authorization-truth drift the multi-club hardening was written to
-- eliminate, and would incorrectly deny a legitimate multi-club target
-- whose own active_club_id happens to point at a DIFFERENT club than the
-- one they hold an active membership in that matches the caller's.
--
-- CORRECTED DESIGN: self access is always allowed (p_user_id = auth.uid()).
-- Cross-user access requires: (1) the CALLER's current active club via
-- public.current_user_club_id() (the same trusted helper every other
-- authorization-sensitive RPC in this schema uses — never profiles.club_id
-- directly), and (2) an independently-verified club_memberships row for
-- the TARGET (p_user_id) in that exact club with status='active' and
-- removed_at is null. The target's own profiles.active_club_id is
-- deliberately NOT consulted — a multi-club user may legitimately hold an
-- active membership in the caller's club while their own active UI context
-- points elsewhere. Anything else fails closed (returns false), matching
-- the established soft-fail convention already used by the adjacent
-- get_user_email_for_notification (returns null, not an exception, for an
-- unauthorized/mismatched-club request).
--
-- This is a deliberate, narrow security boundary, not an elimination of
-- cross-user access: legitimate same-club cross-user preference checks
-- (the waitlist and lesson-email flows documented above) remain
-- intentionally supported. Only CROSS-CLUB access is prohibited. A future
-- self-only preference RPC paired with a separate internal dispatch-
-- authorization mechanism could narrow this further, but that is out of
-- scope for this checkpoint.
--
-- Signature is unchanged (p_user_id uuid, p_kind text) -> boolean, so
-- CREATE OR REPLACE is sufficient; LANGUAGE moves from sql to plpgsql
-- (needed for the conditional club check — no other implementation change
-- forced this) matching the same language already used by every other
-- authorization-bearing helper in this file's neighborhood
-- (get_user_email_for_notification, record_delivery_attempt).
--
-- Created by this checkpoint. Do NOT apply until reviewed.

begin;

create or replace function public.user_pref_enabled(
  p_user_id uuid,
  p_kind    text
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller_id       uuid := auth.uid();
  v_caller_club_id  uuid;
  v_target_in_club  boolean;
begin
  -- Fail closed: no authenticated caller identity at all (e.g. a bare
  -- service_role call with no user JWT context — no current call site does
  -- this, and there is nothing to safely default to without one), or a
  -- null target. p_user_id <> v_caller_id below is never relied on to
  -- reject a null p_user_id by itself — SQL's three-valued NULL<>x
  -- evaluates to NULL (neither true nor false), not a reliable rejection.
  if v_caller_id is null or p_user_id is null then
    return false;
  end if;

  -- SELF is always allowed — the overwhelmingly common case (every SQL
  -- caller across the whole schema already passes auth.uid() here).
  if p_user_id <> v_caller_id then
    -- Cross-user: resolve the CALLER's club via the same trusted
    -- active-membership helper every other authorization-sensitive RPC in
    -- this schema uses (never profiles.club_id, which is not this
    -- schema's authorization truth under the multi-club foundation).
    v_caller_club_id := public.current_user_club_id();
    if v_caller_club_id is null then
      return false;
    end if;

    -- Independently verify the TARGET holds an ACTIVE club_memberships row
    -- in that exact club — never trusting p_user_id's own
    -- profiles.active_club_id (a multi-club target may legitimately belong
    -- to the caller's club while their own active UI context is another
    -- club), and never trusting p_user_id itself as tenant authority.
    select exists (
      select 1
        from public.club_memberships cm
       where cm.user_id     = p_user_id
         and cm.club_id     = v_caller_club_id
         and cm.status      = 'active'
         and cm.removed_at is null
    )
      into v_target_in_club;

    if not v_target_in_club then
      return false;
    end if;
  end if;

  -- Authorized (self, or confirmed same-club cross-user): identical lookup
  -- and default-true behavior as before this migration — no change to what
  -- an authorized caller sees.
  return coalesce(
    (select enabled
       from public.notification_preferences
      where user_id = p_user_id
        and kind    = p_kind),
    true
  );
end;
$$;

alter function public.user_pref_enabled(uuid, text) owner to postgres;
revoke execute on function public.user_pref_enabled(uuid, text) from public;
revoke execute on function public.user_pref_enabled(uuid, text) from anon;
grant  execute on function public.user_pref_enabled(uuid, text) to authenticated;
grant  execute on function public.user_pref_enabled(uuid, text) to service_role;

commit;
