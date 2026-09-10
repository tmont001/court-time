-- 0170_communications_activity_rpc.sql
-- Admin IA Checkpoint 4 — Communications. One narrow, read-only RPC backing
-- the new /admin/communications?tab=activity message-centric list.
--
-- NOT YET APPLIED to any database as of the correction pass below — this
-- file was edited in place (not superseded by a new migration number)
-- because it had not been applied when the correction was made.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- The Communications audit confirmed audit_log already has an Admin-only,
-- club-scoped RLS policy (0005_audit_log.sql, "audit_log_select_admin":
-- club_id = current_user_club_id() and current_user_role() = 'admin'), so a
-- direct, server-side-filtered `.from("audit_log").eq("action",
-- "send_announcement")` query IS safe and would correctly paginate the
-- top-level list (title/sent_at/recipient_count all already live in
-- audit_log.metadata, stamped by send_announcement_v2 — see
-- 0102_communications_delivery_identity.sql section F).
--
-- What audit_log cannot provide is the per-batch email_sent/failed
-- counts — those live in notification_deliveries, joined via
-- notifications.metadata->>'announcement_batch_id'. Computing those counts
-- with a second round trip PER announcement row (an N+1 pattern) was
-- explicitly rejected for the Activity list. This migration adds ONE
-- aggregate, read-only RPC that returns the complete row shape the Activity
-- list needs in a single query per page, using the exact same
-- current_user_club_id()/current_user_role() authorization primitives
-- already used by get_announcement_batch_delivery_context (0102) and every
-- RPC built since 0082_active_club_authorization_foundation.sql.
--
-- Does not modify send_announcement_v2, notifications, notification_
-- deliveries, or any existing RLS policy. Purely additive.
--
-- CORRECTION 1 (still pre-application) — email_opted_out_count removed:
-- send_announcement_v2's recipient INSERT already filters OUT any profile
-- whose notification_preferences row has kind='announcement', enabled=false
-- BEFORE any notification/delivery row is ever created for them (see
-- 0102_communications_delivery_identity.sql section F's WHERE clause). A
-- preference-disabled profile therefore has no notification_id and can
-- never produce a notification_deliveries row with status='opted_out' for
-- an announcement — that status exists on the channel-neutral
-- notification_deliveries table for OTHER domains (reservation/event/
-- waitlist dispatch can hit a preference check post-insert, since those
-- notifications are created unconditionally and preference-gated only at
-- email-dispatch time — see sendEmailNotification's guard 3). Presenting
-- an "email opted out" count on an announcement batch would therefore
-- always read zero and imply a distinction that cannot occur for this
-- domain. Removed rather than left as permanently-zero dead weight.
--
-- CORRECTION 2 (still pre-application) — attempts vs. recipient outcomes:
-- notification_deliveries has no unique constraint on (notification_id,
-- channel) — it represents delivery ATTEMPTS, not a one-row-per-recipient
-- outcome. email_already_delivered() only prevents a further email SEND
-- once a 'sent' row exists; it does not prevent multiple 'failed' rows
-- accumulating before an eventual success (e.g., a transient Resend error
-- followed by a successful retry). The original aggregation here summed
-- raw attempt rows per status, so one recipient with two failed attempts
-- and a later success would have inflated email_failed_count and implied
-- more distinct outcomes than there were recipients. Fixed by reducing
-- notification_deliveries to ONE evidence-based boolean outcome per
-- notification first (a bool_or-based CTE), then aggregating those
-- booleans per batch: a notification counts as sent if ANY email attempt
-- succeeded (regardless of how many failed attempts preceded it), and
-- counts as failed only if it has at least one failed attempt AND no
-- successful one. A notification with no email delivery row at all is
-- never inferred into either bucket.
-- ═══════════════════════════════════════════════════════════════════════════

-- ---------------------------------------------------------------------------
-- get_communications_activity — paginated, one row per announcement batch.
-- Admin-only, club-scoped (fails closed to an empty result set for any
-- non-admin or club-less caller — never raises, matching
-- get_announcement_batch_delivery_context's own fail-closed style).
--
-- email_sent_count / email_failed_count are RECIPIENT-level outcomes, not
-- raw notification_deliveries attempt-row counts (see CORRECTION 2 above).
-- Each is derived from a per-notification bool_or over that notification's
-- own email attempt rows: sent if any attempt succeeded; failed only if at
-- least one attempt failed AND none succeeded. Announcements have no SMS
-- delivery path (dispatchSmsNotification is never called for the
-- announcement domain), so no sms_* columns are returned here. There is
-- deliberately no "email not sent"/"pending" column: a notification can
-- lack any email delivery row for reasons this RPC cannot distinguish from
-- here (RESEND_API_KEY absent in the environment, no resolvable recipient
-- email) — recipients/email_sent/email_failed are the only strictly
-- evidence-backed counts; anything else would be inferred, not observed.
--
-- p_limit/p_offset are clamped rather than trusted verbatim: p_limit to
-- [1, 100] (default 20), p_offset to [0, ...) (default 0) — the simplest
-- guard against an authenticated Admin requesting an absurdly large page or
-- a negative offset. This is a fixed clamp, not general pagination
-- infrastructure.
--
-- GROUP BY al.id relies on audit_log.id being the primary key: Postgres's
-- functional-dependency rule lets every other selected audit_log column
-- (metadata, created_at) appear in the SELECT list ungrouped. LIMIT/OFFSET
-- apply to the resulting one-row-per-batch aggregate, ordered by
-- al.created_at desc — the same newest-first order get_audit_log uses.
-- ---------------------------------------------------------------------------
create or replace function public.get_communications_activity(
  p_limit  int default 20,
  p_offset int default 0
)
returns table (
  batch_id           uuid,
  title              text,
  sent_at            timestamptz,
  recipient_count    integer,
  email_sent_count   integer,
  email_failed_count integer
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_caller_club uuid;
  v_caller_role text;
  v_limit       int := greatest(1, least(coalesce(p_limit, 20), 100));
  v_offset      int := greatest(0, coalesce(p_offset, 0));
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_caller_club, v_caller_role;

  if v_caller_club is null or v_caller_role <> 'admin' then
    return;
  end if;

  return query
    with notification_outcomes as (
      -- One row per announcement notification, reduced to two booleans
      -- over ALL of its own email delivery attempts — never a raw
      -- per-attempt count. bool_or is true if ANY row qualifies, so
      -- multiple failed attempts collapse to a single true, and a later
      -- successful attempt still makes email_sent true regardless of how
      -- many failed attempts preceded it.
      select
        n.id                                  as notification_id,
        n.metadata->>'announcement_batch_id'  as batch_id_text,
        bool_or(nd.channel = 'email' and nd.status = 'sent')   as email_sent,
        bool_or(nd.channel = 'email' and nd.status = 'failed') as email_failed_attempt
      from public.notifications n
      left join public.notification_deliveries nd
        on nd.notification_id = n.id
      where n.club_id = v_caller_club
        and n.kind    = 'announcement'
      group by n.id
    )
    select
      (al.metadata->>'batch_id')::uuid                  as batch_id,
      al.metadata->>'title'                             as title,
      al.created_at                                     as sent_at,
      (al.metadata->>'recipient_count')::integer        as recipient_count,
      -- Sent takes priority: a notification that failed then later
      -- succeeded counts only as sent (LOCKED SEMANTICS).
      coalesce(sum(case when o.email_sent then 1 else 0 end), 0)::integer
        as email_sent_count,
      -- Failed only if it has a failed attempt AND was never sent — never
      -- double-counted per notification, never inferred for a
      -- notification with no email delivery row at all.
      coalesce(sum(case when o.email_failed_attempt and not o.email_sent then 1 else 0 end), 0)::integer
        as email_failed_count
    from public.audit_log al
    left join notification_outcomes o
      on o.batch_id_text = (al.metadata->>'batch_id')
    where al.club_id = v_caller_club
      and al.action  = 'send_announcement'
    group by al.id
    order by al.created_at desc
    limit v_limit offset v_offset;
end;
$$;

revoke execute on function public.get_communications_activity(int, int) from public, anon;
grant  execute on function public.get_communications_activity(int, int) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run manually after applying — NOT executed automatically by
-- this file)
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. As an Admin, confirm:
--      select * from get_communications_activity(20, 0);
--    returns one row per prior announcement send for that admin's club,
--    with email_sent_count + email_failed_count <= recipient_count for
--    each row (never claiming more outcomes than there were recipients).
-- 2. Confirm cross-club isolation: an Admin from Club B calling the same
--    RPC never sees Club A's batches.
-- 3. Confirm fail-closed behavior for non-admin roles:
--      select * from get_communications_activity(20, 0);
--    as a Staff/Pro/Member session returns zero rows (not an error).
-- 4. Confirm anon/public cannot execute at all:
--      revoke/grant above should make this a permission-denied error, not a
--      zero-row result, for an anon-key client.
-- 5. Confirm pagination clamping:
--      select * from get_communications_activity(100000, -50);
--    behaves identically to p_limit=100, p_offset=0 — no error, no
--    unbounded scan.
--      select * from get_communications_activity(0, 0);
--    behaves identically to p_limit=1 (never zero or negative rows
--    requested from Postgres's LIMIT clause).
-- 6. Confirm retry-safe recipient-level counting: for one notification_id,
--    insert two 'failed' notification_deliveries rows (channel='email')
--    followed by one 'sent' row, then call the RPC for that batch. Expect
--    email_sent_count to include that recipient exactly once and
--    email_failed_count to NOT include it at all (sent supersedes prior
--    failures). Separately, for a different notification_id with only
--    failed attempts and no sent row, expect it counted once in
--    email_failed_count, regardless of how many failed rows exist.
-- ═══════════════════════════════════════════════════════════════════════════
-- End of 0170_communications_activity_rpc.sql
-- ═══════════════════════════════════════════════════════════════════════════
