-- 0183_refund_request_admin_notification.sql
-- Phase 38B final notification polish — one missing operational workflow
-- identified before final Stripe-approval browser QA: when Staff
-- successfully submits a refund request, active Admins in that SAME club
-- currently learn about it only by noticing the "Refund requested"
-- indicator on /admin/payments. This adds an in-app notification so it is
-- surfaced proactively, matching the existing refund_request_rejected/
-- refund_request_completed notifications' own posture exactly (IN-APP
-- ONLY — no email, no SMS).
--
-- ── What changes ─────────────────────────────────────────────────────────
-- create_refund_request (0181) is REDEFINED (create or replace — same
-- name/signature/return type) to insert one notification row per eligible
-- Admin, immediately after its own audit_log insert, inside the SAME
-- function call — i.e. the SAME implicit transaction as the request row
-- itself. If the notification insert fails for any reason, the entire
-- call rolls back, including the request row — this DB genuinely cannot
-- persist a request while silently losing its Admin notification.
-- notifications_kind_check is widened to add 'refund_request_submitted' as
-- the 20th allowed kind.
--
-- 0181/0182 are NOT modified — 0181's OWN "no Admin notification on
-- submission" comment documented that migration's own locked decision at
-- the time; this migration is what supersedes it, layered on top, exactly
-- as 0182 layered a correction on top of 0181 without editing it.
--
-- Every other locked 0181/0182 behavior — authorization
-- (Staff-only, `insufficient_role` otherwise), reason/amount validation,
-- refundable-amount revalidation, the one-pending-per-payment partial
-- unique index and its friendly-error wrapping, and the audit_log entry —
-- is reproduced here VERBATIM (re-confirmed by direct re-read of the
-- currently-applied 0181 body) and is not redefined.
--
-- ── Recipient selection ("current club membership truth") ────────────────
-- Selects directly from club_memberships (never profiles.role, never
-- profiles.active_club_id) — the SAME four-column predicate this
-- project's other club-wide recipient-selection RPC already uses
-- (send_announcement_v2, 0177): club_id = <this request's club>, role =
-- 'admin', status = 'active', removed_at is null. club_memberships' own
-- unique(user_id, club_id) constraint (0081) makes duplicate recipients
-- structurally impossible from this one query — no DISTINCT needed.
-- Explicitly excludes auth.uid() (the requesting Staff member themselves)
-- for defense in depth, even though role = 'admin' already excludes them
-- today (a club_membership row's role is Staff XOR Admin XOR Pro XOR
-- Member, never more than one) — this is belt-and-suspenders against any
-- future role-model change, not evidence such a change is planned.
-- Deliberately does NOT join notification_preferences (unlike
-- send_announcement_v2's own announcement-kind check) — this notification
-- is IN-APP ONLY with no email/SMS delivery path to opt out of, the exact
-- same reasoning 0181 already documented for refund_request_rejected/
-- refund_request_completed when it deliberately did NOT add either kind
-- to notification_preferences_kind_check.
--
-- ── Deep link ─────────────────────────────────────────────────────────────
-- metadata.target_path = '/admin/payments?refundRequest=<request id>' —
-- no standalone refund-request page; /admin/payments itself recognizes
-- this query param (AdminPaymentsClient.tsx) and auto-opens
-- ReviewRefundRequestSheet for that exact request when it still exists,
-- is still pending, and the viewer is Admin, mirroring the pre-existing
-- ?lessonId= auto-open pattern (LessonsTab.tsx, Phase 30G/36) exactly — no
-- new routing framework. metadata.request_id is ALSO included so the
-- client-side notification-target resolver (src/lib/notification-
-- targets.ts) can independently derive the identical structured path,
-- exactly like every other domain-specific notification kind already
-- does; target_path itself remains the legacy fallback + audit-visible
-- convenience field, per that resolver's own documented precedence order.
--
-- Apply in Supabase SQL Editor (cloud only).

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. create_refund_request — redefined to notify active club Admins
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.create_refund_request(
  p_payment_id   uuid,
  p_amount_cents integer,
  p_reason       text,
  p_notes        text default null
)
returns public.payment_refund_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id    uuid;
  v_role       text;
  v_reason     text;
  v_payment    public.payments%rowtype;
  v_refundable integer;
  v_result     public.payment_refund_requests%rowtype;
begin
  v_club_id := public.current_user_club_id();
  v_role    := public.current_user_role();
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  -- Staff only — Admin/Pro/Member all blocked by this single exact check
  -- (Admin has no product value here: direct refund authority already
  -- exists; Pro/Member were never candidates). `is distinct from`, not
  -- `<>` — a NULL role (no active membership) must be REJECTED, not
  -- silently pass: `<>` against NULL evaluates to NULL, and an IF
  -- condition that evaluates to NULL is treated as false in PL/pgSQL
  -- (the exact trap 0177's send_announcement_v2 fix already documented
  -- and avoided for this same class of check).
  if v_role is distinct from 'staff' then raise exception 'insufficient_role'; end if;

  v_reason := btrim(coalesce(p_reason, ''));
  if length(v_reason) = 0 then
    raise exception 'refund_reason_required';
  end if;

  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'invalid_refund_amount';
  end if;

  select * into v_payment
    from public.payments
   where id = p_payment_id and club_id = v_club_id;
  if not found then raise exception 'payment_not_found'; end if;

  -- Reuse the EXISTING, unmodified online-refundable calculation — never
  -- payments.amount_paid_cents, never a duplicated ledger SUM/FILTER. The
  -- same RPC the Admin/Staff-facing /admin/payments UI already calls
  -- (get_online_refundable_amount_for_payments, latest: 0157).
  select refundable_cents into v_refundable
    from public.get_online_refundable_amount_for_payments(array[p_payment_id])
   where payment_id = p_payment_id;
  v_refundable := coalesce(v_refundable, 0);

  if v_refundable <= 0 then
    raise exception 'no_online_payment_to_refund';
  end if;
  if p_amount_cents > v_refundable then
    raise exception 'refund_exceeds_online_remaining';
  end if;

  -- Friendly pre-check — the partial unique index
  -- (payment_refund_requests_one_pending_per_payment) below is the
  -- authoritative race backstop, not this check.
  if exists (
    select 1 from public.payment_refund_requests
     where payment_id = p_payment_id and status = 'pending'
  ) then
    raise exception 'refund_request_already_pending';
  end if;

  -- Request creation never touches payments/payment_events/payment_
  -- refund_attempts/payment_checkout_attempts/Stripe — a pure, isolated
  -- insert. Wrapped so the rare genuine race against the partial unique
  -- index above (two near-simultaneous creations) fails with the SAME
  -- friendly code as the pre-check, never a raw Postgres error.
  begin
    insert into public.payment_refund_requests (
      club_id, payment_id, requested_by, requested_amount_cents, reason, notes
    ) values (
      v_club_id, p_payment_id, auth.uid(), p_amount_cents, v_reason, p_notes
    ) returning * into v_result;
  exception
    when unique_violation then
      raise exception 'refund_request_already_pending';
  end;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'create_refund_request', 'payment_refund_request', v_result.id,
    jsonb_build_object('payment_id', p_payment_id, 'requested_amount_cents', p_amount_cents)
  );

  -- Phase 38B notification polish — ONE in-app notification per active
  -- club Admin, inside this SAME function call (same implicit
  -- transaction as the insert above — a failure here rolls back the
  -- whole request, never a persisted request with a silently-lost
  -- notification). Never Staff/Pro/Member, never the requesting Staff
  -- user themselves (role = 'admin' already excludes them; user_id <>
  -- auth.uid() is explicit defense in depth). See this migration's own
  -- header comment for the full recipient-selection and deep-link
  -- rationale.
  insert into public.notifications (club_id, user_id, kind, body, metadata)
  select
    v_club_id,
    cm.user_id,
    'refund_request_submitted',
    'Refund request received',
    jsonb_build_object(
      'request_id',             v_result.id,
      'payment_id',             v_result.payment_id,
      'requested_by',           v_result.requested_by,
      'requested_amount_cents', v_result.requested_amount_cents,
      'target_path',            '/admin/payments?refundRequest=' || v_result.id::text
    )
    from public.club_memberships cm
   where cm.club_id    = v_club_id
     and cm.role        = 'admin'
     and cm.status      = 'active'
     and cm.removed_at is null
     and cm.user_id    <> auth.uid();

  return v_result;
end;
$$;

revoke execute on function public.create_refund_request(uuid, integer, text, text) from public, anon;
grant  execute on function public.create_refund_request(uuid, integer, text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. notifications_kind_check — add refund_request_submitted. Same
--    drop/re-add idiom as every prior kind-expansion migration (0181 was
--    the last to touch this constraint). All 19 currently-allowed kinds
--    preserved verbatim; adds this one as the 20th. IN-APP ONLY —
--    deliberately NOT added to notification_preferences_kind_check, same
--    reasoning as refund_request_rejected/refund_request_completed (0181):
--    no email/SMS delivery path exists, so there is nothing to opt out of.
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.notifications
  drop constraint if exists notifications_kind_check;

alter table public.notifications
  add constraint notifications_kind_check
  check (kind in (
    'reservation_confirmed',
    'reservation_cancelled_by_admin',
    'reservation_cancelled_by_member',
    'reservation_rescheduled',
    'event_cancelled',
    'event_joined',
    'event_updated',
    'waitlist_promoted',
    'waitlist_offer',
    'announcement',
    'lesson_request_received',
    'lesson_request_proposed',
    'lesson_request_confirmed',
    'lesson_request_declined',
    'lesson_cancelled',
    'lesson_provider_reassigned',
    'lesson_admin_requested',
    'refund_request_rejected',
    'refund_request_completed',
    'refund_request_submitted'  -- Phase 38B notification polish
  ));

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback (manual, cloud SQL Editor)
-- ═══════════════════════════════════════════════════════════════════════════
-- begin;
--
-- alter table public.notifications
--   drop constraint if exists notifications_kind_check;
-- alter table public.notifications
--   add constraint notifications_kind_check
--   check (kind in (
--     'reservation_confirmed', 'reservation_cancelled_by_admin',
--     'reservation_cancelled_by_member', 'reservation_rescheduled',
--     'event_cancelled', 'event_joined', 'event_updated',
--     'waitlist_promoted', 'waitlist_offer', 'announcement',
--     'lesson_request_received', 'lesson_request_proposed',
--     'lesson_request_confirmed', 'lesson_request_declined',
--     'lesson_cancelled', 'lesson_provider_reassigned',
--     'lesson_admin_requested', 'refund_request_rejected',
--     'refund_request_completed'
--   ));
--
-- -- Restores create_refund_request to its exact pre-0183 (0181) body —
-- -- i.e. this migration's own function definition above, MINUS the
-- -- "Phase 38B notification polish" notifications insert block. Not
-- -- reproduced here as a second full copy of that function; an operator
-- -- rolling back re-applies 0181's own create_refund_request definition
-- -- verbatim (lines 226-325 of 0181_staff_refund_requests.sql).
--
-- commit;
