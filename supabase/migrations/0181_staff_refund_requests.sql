-- 0181_staff_refund_requests.sql
-- Phase 38B Task 1 — Staff Refund Requests: schema, RPCs, reconciler
-- extension, notification kind.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- SCOPE
-- ═══════════════════════════════════════════════════════════════════════════
-- Court Time Payments (Stripe) refund balances only. Manual/offline refund
-- requests are out of scope — record_refund (0143/0151/0153) is not
-- referenced anywhere in this migration.
--
-- Core rule: STAFF MAY REQUEST. ADMIN CONTROLS THE MONEY.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- CURRENT EFFECTIVE STATE THIS MIGRATION WAS WRITTEN AGAINST (verified by
-- direct re-read immediately before authoring, not assumed from memory)
-- ═══════════════════════════════════════════════════════════════════════════
--   - open_payment_refund_attempt: latest redefinition is 0157 (not 0153,
--     not 0155) — same signature/RETURNS TABLE shape/error codes as always
--     (invalid_arguments, invalid_refund_amount, payment_not_found,
--     pending_refund_amount_mismatch, no_online_payment_to_refund,
--     refund_exceeds_online_remaining); only its internal source-attempt
--     SELECTION algorithm changed (newest-refundable-attempt-first,
--     34E-D Blocker 3) — entirely opaque to this migration, which only
--     ever calls it as a black box.
--   - get_online_refundable_amount_for_payments: latest redefinition is
--     also 0157 — same signature/return shape; same "newest-refundable-
--     attempt-first" selection change, equally opaque here.
--   - _reconcile_stripe_refund_attempt: no migration after 0153 redefines
--     it. This migration's own redefinition below reproduces that exact
--     0153 body verbatim, plus exactly one additive block.
--   - payment_refund_attempts (table/indexes/grants): unchanged since 0153.
--   - notifications_kind_check: no migration after 0099 redefines it —
--     17 values currently allowed, preserved verbatim below, plus 2 new.
--   - notification_preferences_kind_check: NOT touched by this migration
--     (the two new kinds are in-app only; there is no email delivery path
--     for either, so no preference surface is needed).
--   - Per 0158 (payment_internal_helper_privilege_hardening): this
--     Supabase project's own default-privileges behavior grants EXECUTE on
--     every newly created public-schema function to anon/authenticated/
--     service_role EXPLICITLY at creation time, regardless of any bare
--     `revoke ... from public`. Every REVOKE below therefore names every
--     role that must be excluded explicitly (never relies on a bare
--     `from public` alone) — matching 0158's own corrected convention.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- LOCK ORDER — PAYMENT FIRST, ALWAYS
-- ═══════════════════════════════════════════════════════════════════════════
-- The canonical top-level serialization point in this domain is, and
-- remains, the `payments` row lock — confirmed by direct re-read of both
-- open_payment_refund_attempt (locks payments first, then resolves/locks
-- the source payment_checkout_attempts row) and _reconcile_stripe_refund_
-- attempt (locks payments first, then locks the specific payment_refund_
-- attempts row). begin_refund_request_execution below follows the SAME
-- order: it locks `payments` FIRST, and only THEN locks the
-- payment_refund_requests row — never the reverse. Its initial read of the
-- request (needed only to discover payment_id before the payment lock can
-- even be attempted) is explicitly non-locking.
--
-- Because both begin_refund_request_execution and _reconcile_stripe_
-- refund_attempt take the SAME payments-row lock first, and hold it for
-- the remainder of their transaction, the two code paths can never be
-- concurrently past that point for the SAME payment — this is what makes
-- it safe for begin_refund_request_execution to read (not lock) the
-- linked payment_refund_attempts row without creating any lock-order
-- inversion risk against the reconciler's own payments -> attempts order:
-- only one of the two transactions can ever hold the payments lock for a
-- given payment at a time, so their respective downstream lock orders
-- never actually contend. The one residual "read a status that changes a
-- moment later" race this leaves is exactly what Stripe's own idempotency
-- key (payment-refund:<attemptId>) and _reconcile_stripe_refund_attempt's
-- own terminal-state backstop already resolve correctly today for the
-- EXISTING (non-request) refund flow — no new idempotency scheme is
-- introduced here.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- CONCURRENT APPROVAL BEHAVIOR (corrected from the original draft)
-- ═══════════════════════════════════════════════════════════════════════════
-- A second Admin click (or a second Admin entirely) reviewing the SAME
-- pending request while a first approval's Stripe call is still in flight
-- does NOT necessarily fail with request_not_pending — the request's own
-- status stays 'pending' with refund_attempt_id set for the ENTIRE window
-- between begin_refund_request_execution returning and Stripe's eventual
-- resolution (that window is outside this function's own transaction).
-- The correct, and implemented, behavior is:
--   refund_attempt_id IS NULL                    -> open/link a fresh attempt
--   linked attempt status = pending               -> reuse the SAME attempt
--   linked attempt status = requires_action        -> reuse the SAME attempt
--   linked attempt status = failed OR canceled     -> open a FRESH attempt
--                                                      (via the existing
--                                                      primitive, live
--                                                      ceiling revalidated),
--                                                      replacing
--                                                      refund_attempt_id
--   linked attempt status = succeeded              -> heal/finalize to
--                                                      'completed', NEVER
--                                                      call Stripe again
--   request.status <> 'pending' (already completed/rejected) -> fail
--                                                      closed
-- Two concurrent approval attempts therefore converge on the SAME refund
-- attempt (and the SAME Stripe idempotency key) whenever execution is
-- already in flight, rather than racing to create two different attempts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- REJECTION — blocked once execution has started (correction pass)
-- ═══════════════════════════════════════════════════════════════════════════
-- A pending request may be rejected only while no execution has begun
-- (refund_attempt_id IS NULL) or the prior attempt genuinely did not
-- succeed (failed/canceled). It may NOT be rejected while the linked
-- attempt is pending/requires_action (execution already in flight — the
-- Stripe outcome is not yet known) or succeeded (money already moved) —
-- either would let a request end up 'rejected' while Stripe money was, or
-- will shortly be, actually refunded. Blocked cases raise
-- refund_request_execution_started; no new request status is introduced
-- for this. reject_refund_request follows the SAME payment-first lock
-- order as begin_refund_request_execution (non-locking probe -> payments
-- lock -> request lock), so its own read of the linked attempt's live
-- status is safe for the identical reason.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- COMPLETION SIDE EFFECTS — the shared private helper
-- ═══════════════════════════════════════════════════════════════════════════
-- A request reaches 'completed' from exactly two call sites: the
-- succeeded-heal branch inside begin_refund_request_execution, and the
-- narrow addition inside _reconcile_stripe_refund_attempt's own existing
-- `if p_status = 'succeeded'` block (covering BOTH the synchronous
-- bind_stripe_refund_result path and the asynchronous webhook path, since
-- both already funnel through that one function). To guarantee both call
-- sites perform IDENTICAL, idempotent completion work (status flip +
-- notification + audit) without duplicating that SQL twice, both call a
-- new private helper, _complete_refund_request_for_attempt(uuid) — fully
-- internal, EXECUTE revoked from public, anon, authenticated, AND
-- service_role (transitive-only, matching _reconcile_stripe_refund_
-- attempt's own posture exactly), never a new client-reachable capability.
-- It is a no-op (matches zero rows) for a direct Admin refund attempt,
-- which never has a payment_refund_requests row pointing at it at all.
--
-- reviewed_by/reviewed_at are set ONCE, by begin_refund_request_execution,
-- at the moment execution is first/freshly (re)initiated by an Admin's own
-- click (the two branches that call open_payment_refund_attempt) — never
-- by the completion helper, and never invented by the asynchronous webhook
-- path, which has no legitimate Admin/session identity to attribute a
-- review to. The reuse (pending/requires_action) and heal (succeeded)
-- branches leave reviewed_by/reviewed_at exactly as a prior click already
-- set them.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT THIS MIGRATION DOES NOT DO
-- ═══════════════════════════════════════════════════════════════════════════
-- Does not modify open_payment_refund_attempt, get_online_refundable_
-- amount_for_payments, record_refund, bind_stripe_refund_result, process_
-- stripe_refund_webhook_event, or any table other than the one new
-- payment_refund_requests. Does not add an 'approved' status, a 'failed'
-- request status, or any stale/superseded status. Does not touch
-- notification_preferences_kind_check. Does not introduce a second Stripe
-- idempotency scheme. Application Server Actions/UI are Task 2+ and are
-- not touched here.
--
-- Apply in Supabase SQL Editor (cloud only). Not applied by this
-- checkpoint — prepared for review only.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. payment_refund_requests
-- ═══════════════════════════════════════════════════════════════════════════
create table public.payment_refund_requests (
  id                      uuid        primary key default gen_random_uuid(),
  club_id                 uuid        not null references public.clubs(id) on delete cascade,
  payment_id              uuid        not null,

  requested_by            uuid        not null references public.profiles(id),
  requested_amount_cents  integer     not null check (requested_amount_cents > 0),
  reason                  text        not null,
  notes                   text,

  status                  text        not null default 'pending'
                            check (status in ('pending', 'completed', 'rejected')),

  -- Set the moment an Admin's approval click BEGINS execution
  -- (begin_refund_request_execution) — never deferred to Stripe
  -- confirmation. See this migration's own header comment.
  reviewed_by             uuid        references public.profiles(id),
  reviewed_at             timestamptz,

  rejection_reason        text,

  -- Set as soon as begin_refund_request_execution opens/reuses a real
  -- payment_refund_attempts row — before any Stripe network call. Never a
  -- second source of truth for Stripe status/amount/id/currency/failure
  -- reason: those remain owned exclusively by payment_refund_attempts.
  refund_attempt_id       uuid        references public.payment_refund_attempts(id),

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  foreign key (payment_id, club_id) references public.payments(id, club_id)
);

-- One pending request per payment at a time — hard DB backstop. Historical
-- completed/rejected rows are retained (never deleted) and are unaffected
-- by this index.
create unique index payment_refund_requests_one_pending_per_payment
  on public.payment_refund_requests (payment_id)
  where status = 'pending';

create index payment_refund_requests_payment_idx on public.payment_refund_requests (payment_id);
create index payment_refund_requests_club_idx    on public.payment_refund_requests (club_id);
create index payment_refund_requests_attempt_idx on public.payment_refund_requests (refund_attempt_id)
  where refund_attempt_id is not null;

create trigger payment_refund_requests_updated_at
  before update on public.payment_refund_requests
  for each row execute function public.trigger_set_updated_at();

alter table public.payment_refund_requests enable row level security;
-- Deny-all direct client access by design — identical posture to
-- payment_refund_attempts/payment_checkout_attempts/club_stripe_accounts.
-- Every read/write goes through the SECURITY DEFINER RPCs below.
revoke all on public.payment_refund_requests from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. create_refund_request — authenticated, Staff only
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

  -- No Admin notification/email on submission (locked decision) — the
  -- /admin/payments pending-state indicator is the v1 visibility
  -- mechanism.
  return v_result;
end;
$$;

revoke execute on function public.create_refund_request(uuid, integer, text, text) from public, anon;
grant  execute on function public.create_refund_request(uuid, integer, text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. get_pending_refund_requests_for_payments — authenticated, Admin+Staff
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.get_pending_refund_requests_for_payments(
  p_payment_ids uuid[]
)
returns table (
  request_id             uuid,
  payment_id             uuid,
  requested_by           uuid,
  requested_by_name      text,
  requested_amount_cents integer,
  reason                 text,
  notes                  text,
  refund_attempt_id      uuid,
  attempt_status         text,
  created_at             timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
begin
  v_club_id := public.current_user_club_id();
  v_role    := public.current_user_role();
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  -- Admin+Staff only. `is distinct from ... and is distinct from ...`,
  -- not `not in (...)` — a NULL role must be REJECTED: `not in (...)`
  -- against NULL evaluates to NULL, which PL/pgSQL's IF treats as false
  -- (silently passing), the exact trap this null-safe form avoids.
  if v_role is distinct from 'admin' and v_role is distinct from 'staff' then
    raise exception 'insufficient_role';
  end if;

  return query
    select
      r.id, r.payment_id, r.requested_by,
      trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')),
      r.requested_amount_cents, r.reason, r.notes,
      r.refund_attempt_id, pra.status, r.created_at
      from public.payment_refund_requests r
      join public.profiles p on p.id = r.requested_by
      left join public.payment_refund_attempts pra on pra.id = r.refund_attempt_id
     where r.club_id = v_club_id
       and r.payment_id = any(p_payment_ids)
       and r.status = 'pending';
end;
$$;

revoke execute on function public.get_pending_refund_requests_for_payments(uuid[]) from public, anon;
grant  execute on function public.get_pending_refund_requests_for_payments(uuid[]) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. reject_refund_request — authenticated, Admin only
--
-- Correction pass — a pending request whose linked refund attempt has
-- already begun executing (pending/requires_action) or has already
-- SUCCEEDED must NOT be rejectable: doing so could leave a request
-- recorded as 'rejected' while Stripe money was, or will shortly be,
-- actually refunded. Rejection therefore stays available only while no
-- execution has ever begun (refund_attempt_id IS NULL) or the prior
-- attempt genuinely did not succeed (failed/canceled) — raising
-- refund_request_execution_started otherwise. No new request status is
-- introduced; this is purely an additional guard on the existing
-- pending -> rejected transition.
--
-- Also follows the SAME payment-first lock order as
-- begin_refund_request_execution: a non-locking probe to discover
-- payment_id, THEN the payments row lock, THEN the request row lock —
-- never request-lock -> payment-lock.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.reject_refund_request(
  p_request_id       uuid,
  p_rejection_reason text
)
returns public.payment_refund_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_reason  text;
  v_probe   public.payment_refund_requests%rowtype;
  v_payment public.payments%rowtype;
  v_request public.payment_refund_requests%rowtype;
  v_attempt public.payment_refund_attempts%rowtype;
begin
  v_club_id := public.current_user_club_id();
  v_role    := public.current_user_role();
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  -- `is distinct from`, not `<>` — see create_refund_request's identical
  -- comment for why a NULL role must be REJECTED, not silently pass.
  if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;

  v_reason := btrim(coalesce(p_rejection_reason, ''));
  if length(v_reason) = 0 then
    raise exception 'rejection_reason_required';
  end if;

  -- A. Non-locking probe to discover payment_id, so the canonical
  -- payments-row lock can be taken FIRST — never lock the request before
  -- the payment (matches begin_refund_request_execution exactly).
  select * into v_probe
    from public.payment_refund_requests
   where id = p_request_id and club_id = v_club_id;
  if not found then raise exception 'request_not_found'; end if;

  -- B. Payment lock FIRST.
  select * into v_payment
    from public.payments
   where id = v_probe.payment_id and club_id = v_club_id
   for update;
  if not found then raise exception 'payment_not_found'; end if;

  -- C. Lock and RE-READ the request row SECOND.
  select * into v_request
    from public.payment_refund_requests
   where id = p_request_id and club_id = v_club_id
   for update;

  -- D. Revalidate after both locks are held.
  if not found or v_request.payment_id <> v_payment.id then
    raise exception 'request_not_found';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'request_not_pending';
  end if;

  -- Execution-started guard (see this function's own header comment).
  -- Plain read (no FOR UPDATE) of the linked attempt — safe for the same
  -- reason begin_refund_request_execution's own read is safe: the
  -- payments lock already held above already serializes this transaction
  -- against _reconcile_stripe_refund_attempt (which also locks payments
  -- first) for this SAME payment.
  if v_request.refund_attempt_id is not null then
    select * into v_attempt
      from public.payment_refund_attempts
     where id = v_request.refund_attempt_id;

    if v_attempt.status in ('pending', 'requires_action', 'succeeded') then
      raise exception 'refund_request_execution_started';
    end if;
  end if;

  update public.payment_refund_requests
     set status            = 'rejected',
         reviewed_by       = auth.uid(),
         reviewed_at       = now(),
         rejection_reason  = v_reason
   where id = p_request_id
  returning * into v_request;

  -- Never touches payments/payment_events/Stripe — rejection is a pure
  -- status transition. No refund attempt is ever created by this
  -- function (the execution-started guard above ensures one is never
  -- silently abandoned mid-flight either).
  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'reject_refund_request', 'payment_refund_request', p_request_id,
    jsonb_build_object('payment_id', v_request.payment_id, 'rejection_reason', v_reason)
  );

  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_club_id, v_request.requested_by, 'refund_request_rejected',
    'Your refund request was not approved.',
    jsonb_build_object('request_id', v_request.id, 'payment_id', v_request.payment_id, 'target_path', '/admin/payments')
  );

  return v_request;
end;
$$;

revoke execute on function public.reject_refund_request(uuid, text) from public, anon;
grant  execute on function public.reject_refund_request(uuid, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. _complete_refund_request_for_attempt — shared private completion
--    helper. See this migration's own header comment ("COMPLETION SIDE
--    EFFECTS") for why this exists rather than duplicating the same SQL
--    inside both begin_refund_request_execution's heal branch and
--    _reconcile_stripe_refund_attempt's succeeded branch.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public._complete_refund_request_for_attempt(
  p_refund_attempt_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.payment_refund_requests%rowtype;
begin
  select * into v_request
    from public.payment_refund_requests
   where refund_attempt_id = p_refund_attempt_id
     and status = 'pending'
   for update;

  -- Idempotent no-op: a direct Admin refund attempt has no linked
  -- request row at all; an already-completed request matches nothing
  -- here either (status is no longer 'pending').
  if not found then
    return;
  end if;

  update public.payment_refund_requests
     set status = 'completed'
   where id = v_request.id;
  -- reviewed_by/reviewed_at are deliberately NOT touched here — they were
  -- already durably set, at execution-begin time, by whichever Admin
  -- click actually initiated the now-succeeded attempt (see this
  -- migration's own header comment). This helper has no legitimate
  -- Admin/session identity of its own to attribute a review to, and none
  -- is needed.

  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_request.club_id, v_request.requested_by, 'refund_request_completed',
    'Your refund request has been approved and the refund is complete.',
    jsonb_build_object('request_id', v_request.id, 'payment_id', v_request.payment_id, 'target_path', '/admin/payments')
  );

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_request.club_id, v_request.reviewed_by, 'complete_refund_request', 'payment_refund_request', v_request.id,
    jsonb_build_object('payment_id', v_request.payment_id, 'refund_attempt_id', p_refund_attempt_id)
  );
end;
$$;

-- Fully private, transitive-only — never a client-reachable capability.
-- Matches _reconcile_stripe_refund_attempt's own posture exactly: EXECUTE
-- revoked from every role, including service_role, since it is only ever
-- invoked via `perform` from another SECURITY DEFINER function owned by
-- the same role (begin_refund_request_execution, and _reconcile_stripe_
-- refund_attempt itself, below).
revoke all on function public._complete_refund_request_for_attempt(uuid)
  from public, anon, authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. begin_refund_request_execution — service_role ONLY. See this
--    migration's own header comments ("LOCK ORDER", "CONCURRENT APPROVAL
--    BEHAVIOR") for the full rationale.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.begin_refund_request_execution(
  p_request_id uuid,
  p_club_id    uuid,
  p_actor_id   uuid
)
returns table (
  id                          uuid,
  payment_id                  uuid,
  club_id                      uuid,
  source_checkout_attempt_id  uuid,
  stripe_account_id            text,
  livemode                     boolean,
  stripe_checkout_session_id   text,
  stripe_payment_intent_id     text,
  requested_amount_cents       integer,
  status                       text,
  currency                     text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_probe   public.payment_refund_requests%rowtype;
  v_request public.payment_refund_requests%rowtype;
  v_payment public.payments%rowtype;
  v_attempt public.payment_refund_attempts%rowtype;
  v_source  public.payment_checkout_attempts%rowtype;
  v_new     record;
begin
  if p_request_id is null or p_club_id is null or p_actor_id is null then
    raise exception 'invalid_arguments';
  end if;

  -- A. Initial NON-LOCKING read — only to discover payment_id, so the
  -- canonical payments-row lock can be taken FIRST. Never lock the
  -- request before the payment.
  select * into v_probe
    from public.payment_refund_requests
   where id = p_request_id and club_id = p_club_id;
  if not found then
    raise exception 'request_not_found';
  end if;

  -- B. Payment lock FIRST — the canonical top-level serialization point
  -- for this whole domain, matching open_payment_refund_attempt/
  -- _reconcile_stripe_refund_attempt exactly.
  select * into v_payment
    from public.payments
   where id = v_probe.payment_id and club_id = p_club_id
   for update;
  if not found then
    raise exception 'payment_not_found';
  end if;

  -- C. Lock and RE-READ the request row SECOND.
  select * into v_request
    from public.payment_refund_requests
   where id = p_request_id and club_id = p_club_id
   for update;

  -- D. Revalidate after both locks are held.
  if not found or v_request.payment_id <> v_payment.id then
    raise exception 'request_not_found';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'request_not_pending';
  end if;

  if v_request.refund_attempt_id is not null then
    -- Plain read (no FOR UPDATE) — safe because the payments lock already
    -- held above already serializes this transaction against any other
    -- (including _reconcile_stripe_refund_attempt, which also locks
    -- payments first) for this SAME payment. See this migration's own
    -- "LOCK ORDER" header comment for the full argument.
    select * into v_attempt
      from public.payment_refund_attempts
     where id = v_request.refund_attempt_id;

    if v_attempt.status = 'succeeded' then
      -- HEAL — never call Stripe again. Idempotent via the shared
      -- completion helper (also used by _reconcile_stripe_refund_attempt
      -- itself) — a no-op if already completed by the time this runs.
      perform public._complete_refund_request_for_attempt(v_attempt.id);

      select pca.* into v_source from public.payment_checkout_attempts pca where pca.id = v_attempt.source_checkout_attempt_id;
      return query select
        v_attempt.id, v_attempt.payment_id, v_attempt.club_id, v_attempt.source_checkout_attempt_id,
        v_attempt.stripe_account_id, v_attempt.livemode, v_source.stripe_checkout_session_id,
        v_attempt.stripe_payment_intent_id, v_attempt.requested_amount_cents, v_attempt.status, v_payment.currency;
      return;

    elsif v_attempt.status in ('pending', 'requires_action') then
      -- REUSE — same Stripe idempotency identity (payment-refund:<id>),
      -- no new attempt, reviewed_by/reviewed_at untouched (this click did
      -- not initiate the in-flight execution; a prior one did).
      select pca.* into v_source from public.payment_checkout_attempts pca where pca.id = v_attempt.source_checkout_attempt_id;
      return query select
        v_attempt.id, v_attempt.payment_id, v_attempt.club_id, v_attempt.source_checkout_attempt_id,
        v_attempt.stripe_account_id, v_attempt.livemode, v_source.stripe_checkout_session_id,
        v_attempt.stripe_payment_intent_id, v_attempt.requested_amount_cents, v_attempt.status, v_payment.currency;
      return;
    end if;
    -- else: 'failed' or 'canceled' — falls through to the single shared
    -- "open fresh" path below, exactly like the no-prior-attempt case.
  end if;

  -- No usable prior attempt (either none was ever opened, or the prior
  -- one failed/was canceled) — open a FRESH one through the EXISTING,
  -- unmodified execution primitive, using ONLY the STORED request amount
  -- (never a parameter on this function — there is no p_amount_cents
  -- here at all). Its own live-refundable-ceiling check is what makes an
  -- over-large or now-stale request fail safely, without this function
  -- ever duplicating that math. open_payment_refund_attempt re-locks
  -- `payments` internally — safe (re-entrant within this same
  -- transaction, which already holds that exact row lock from step B).
  select * into v_new
    from public.open_payment_refund_attempt(
      v_request.payment_id, p_club_id, v_request.requested_amount_cents, p_actor_id, null
    );

  update public.payment_refund_requests
     set refund_attempt_id = v_new.id,
         reviewed_by       = p_actor_id,
         reviewed_at       = now()
   where id = p_request_id;

  return query select
    v_new.id, v_new.payment_id, v_new.club_id, v_new.source_checkout_attempt_id,
    v_new.stripe_account_id, v_new.livemode, v_new.stripe_checkout_session_id,
    v_new.stripe_payment_intent_id, v_new.requested_amount_cents, v_new.status, v_new.currency;
end;
$$;

revoke execute on function public.begin_refund_request_execution(uuid, uuid, uuid) from public, anon, authenticated;
grant  execute on function public.begin_refund_request_execution(uuid, uuid, uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. _reconcile_stripe_refund_attempt — CREATE OR REPLACE, current
--    effective (0153) body reproduced verbatim, plus exactly one
--    additive call. Same signature, same security posture, same grants,
--    same existing validation, same existing terminal-state behavior,
--    same existing ledger insertion/idempotency. This is payment-critical
--    code — nothing above the marked addition differs from the currently
--    applied body in any way.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public._reconcile_stripe_refund_attempt(
  p_refund_attempt_id uuid,
  p_stripe_refund_id   text,
  p_status              text,
  p_amount_cents        integer,
  p_stripe_account_id   text,
  p_livemode            boolean,
  p_currency            text,
  p_failure_reason      text default null,
  p_stripe_payment_intent_id text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_lookup_payment_id uuid;
  v_payment            public.payments%rowtype;
  v_attempt            public.payment_refund_attempts%rowtype;
  v_old_status         text;
begin
  if p_status is null or p_amount_cents is null or p_stripe_account_id is null
     or p_livemode is null or p_currency is null then
    raise exception 'invalid_arguments';
  end if;
  if p_refund_attempt_id is null and p_stripe_refund_id is null then
    raise exception 'invalid_arguments';
  end if;
  if p_status not in ('pending', 'requires_action', 'succeeded', 'failed', 'canceled') then
    raise exception 'invalid_status';
  end if;

  select payment_id into v_lookup_payment_id
    from public.payment_refund_attempts
   where (p_stripe_refund_id is not null and stripe_refund_id = p_stripe_refund_id)
      or (p_refund_attempt_id is not null and id = p_refund_attempt_id)
   limit 1;

  if v_lookup_payment_id is null then
    raise exception 'refund_attempt_not_found';
  end if;

  select * into v_payment from public.payments where id = v_lookup_payment_id for update;
  if not found then
    raise exception 'payment_not_found';
  end if;

  select * into v_attempt
    from public.payment_refund_attempts
   where payment_id = v_payment.id
     and (
       (p_stripe_refund_id is not null and stripe_refund_id = p_stripe_refund_id)
       or (p_refund_attempt_id is not null and id = p_refund_attempt_id)
     )
   for update;
  if not found then
    raise exception 'refund_attempt_not_found';
  end if;

  if v_attempt.stripe_account_id <> p_stripe_account_id then
    raise exception 'stripe_account_mismatch';
  end if;

  if v_attempt.livemode <> p_livemode then
    raise exception 'livemode_mismatch';
  end if;

  -- PaymentIntent provenance validation (correction pass) — see this
  -- function's own header comment. Runs BEFORE any status/ledger
  -- mutation.
  if v_attempt.stripe_payment_intent_id is not null
     and p_stripe_payment_intent_id is not null
     and v_attempt.stripe_payment_intent_id <> p_stripe_payment_intent_id then
    raise exception 'payment_intent_mismatch';
  end if;

  if upper(p_currency) <> v_payment.currency then
    raise exception 'currency_mismatch';
  end if;

  if v_attempt.requested_amount_cents <> p_amount_cents then
    raise exception 'refund_amount_mismatch';
  end if;

  -- Backfill a previously-unknown PaymentIntent now that Stripe has
  -- genuinely confirmed it — never required before this point since
  -- refundActions.ts already backfills it via backfill_refund_attempt_
  -- payment_intent (section 5a) BEFORE ever calling refunds.create(); a
  -- Dashboard-imported row always carries its PaymentIntent from import
  -- time. This is defense in depth for any residual gap, mirroring
  -- process_stripe_payment_event's own null-to-non-null backfill
  -- discipline (0150) — never overwrites a KNOWN value (guarded above).
  if v_attempt.stripe_payment_intent_id is null and p_stripe_payment_intent_id is not null then
    update public.payment_refund_attempts
       set stripe_payment_intent_id = p_stripe_payment_intent_id, updated_at = now()
     where id = v_attempt.id;
  end if;

  if v_attempt.stripe_refund_id is null then
    if p_stripe_refund_id is null then
      raise exception 'invalid_arguments';
    end if;
    update public.payment_refund_attempts
       set stripe_refund_id = p_stripe_refund_id
     where id = v_attempt.id;
  elsif p_stripe_refund_id is not null and v_attempt.stripe_refund_id <> p_stripe_refund_id then
    raise exception 'refund_id_mismatch';
  end if;

  v_old_status := v_attempt.status;

  -- Terminal-state safety backstop — see this function's own header
  -- comment. Nothing below this point runs once a terminal status has
  -- already been recorded.
  if v_old_status in ('succeeded', 'failed', 'canceled') then
    if v_old_status = 'failed' and p_status = 'failed'
       and p_failure_reason is not null and v_attempt.failure_reason is null then
      update public.payment_refund_attempts
         set failure_reason = p_failure_reason, updated_at = now()
       where id = v_attempt.id;
    end if;
    return;
  end if;

  update public.payment_refund_attempts
     set status = p_status,
         failure_reason = coalesce(p_failure_reason, failure_reason),
         updated_at = now()
   where id = v_attempt.id;

  if p_status = 'succeeded' then
    insert into public.payment_events (
      payment_id, club_id, event_type, amount_cents, external_reference, actor_id
    ) values (
      v_attempt.payment_id, v_attempt.club_id, 'online_refund_recorded',
      p_amount_cents, p_stripe_refund_id, null
    );

    -- ═════════════════════════════════════════════════════════════════
    -- Phase 38B ADDITION — the ONLY new behavior in this function.
    -- Idempotently finalizes a linked pending payment_refund_requests
    -- row to 'completed', via the shared private helper (section 5
    -- above) — covers BOTH this synchronous bind_stripe_refund_result
    -- call path and the asynchronous process_stripe_refund_webhook_event
    -- path, since both already funnel through this one function. A
    -- direct Admin refund (no payment_refund_requests row ever points at
    -- this attempt) is a complete no-op here — the helper's own `if not
    -- found then return; end if;` matches zero rows for it.
    -- ═════════════════════════════════════════════════════════════════
    perform public._complete_refund_request_for_attempt(v_attempt.id);
  end if;
end;
$$;

revoke all on function public._reconcile_stripe_refund_attempt(uuid, text, text, integer, text, boolean, text, text, text)
  from public, anon, authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. notifications_kind_check — add refund_request_rejected and
--    refund_request_completed. Same drop/re-add idiom as every prior
--    kind-expansion migration (0014, 0039, 0048, 0069, 0078, 0097, 0099 —
--    the last to touch this constraint). All 17 currently-allowed kinds
--    preserved verbatim; adds these two as the 18th/19th. Both are
--    IN-APP ONLY — deliberately NOT added to notification_preferences_
--    kind_check, since no email delivery path exists for either (nothing
--    to opt out of).
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
    'refund_request_rejected',   -- Phase 38B
    'refund_request_completed'   -- Phase 38B
  ));

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback (manual, cloud SQL Editor) — NOT fully executable as written.
-- The notifications_kind_check restore and every `drop function`/`drop
-- table` line below ARE the exact, genuinely executable pre-0181
-- statements. The ONE exception, called out explicitly rather than left
-- to be discovered at rollback time: restoring _reconcile_stripe_refund_
-- attempt to its exact pre-0181 (0153) body is NOT reproduced here as
-- runnable SQL (doing so would mean re-pasting that entire ~140-line
-- function purely for a rollback path) — an operator rolling back must
-- separately re-apply the verbatim 0153 body of that one function (this
-- migration's own section 7 above IS that exact body, minus only the one
-- block marked "Phase 38B ADDITION") before this rollback is complete.
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
--     'lesson_admin_requested'
--   ));
--
-- drop function if exists public.begin_refund_request_execution(uuid, uuid, uuid);
-- drop function if exists public._complete_refund_request_for_attempt(uuid);
-- drop function if exists public.reject_refund_request(uuid, text);
-- drop function if exists public.get_pending_refund_requests_for_payments(uuid[]);
-- drop function if exists public.create_refund_request(uuid, integer, text, text);
-- drop table if exists public.payment_refund_requests;
--
-- -- NOT executable as-is — see the header note above: re-apply
-- -- _reconcile_stripe_refund_attempt's verbatim pre-0181 (0153) body
-- -- (this migration's own section 7, minus its one "Phase 38B ADDITION"
-- -- block) separately before considering this rollback complete.
--
-- commit;
