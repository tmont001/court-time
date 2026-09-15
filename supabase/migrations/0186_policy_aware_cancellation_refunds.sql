-- 0186_policy_aware_cancellation_refunds.sql
-- Phase 41A — Policy-Aware Cancellation & Refund Foundation.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- SCOPE (locked)
-- ═══════════════════════════════════════════════════════════════════════════
-- Reservations + lessons only. Events/programs untouched. No automatic
-- Stripe refund execution — a policy-eligible cancellation only ENSURES a
-- payment_refund_requests row exists; Admin still approves/executes it
-- through the EXISTING begin_refund_request_execution -> open_payment_
-- refund_attempt -> Stripe -> bind/reconcile pipeline, unmodified. No new
-- club_settings column of any kind (no auto-approve toggle).
--
-- This is a CORRECTION PASS on the first draft of this same migration
-- (never applied — no rollback concern). Four integration issues found in
-- review are fixed in place, all summarized below; the overall approved
-- architecture (shared evaluator stays authoritative, late still creates
-- no refund entitlement, the reservation Checkout-invalidation gap fix,
-- the domain-row-first/payment-row-second lock order) is unchanged.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- CORRECTION 1 — the public refundable-amount RPC is Admin/Staff-gated,
-- but a Member/Pro cancellation transaction needs the same calculation
-- ═══════════════════════════════════════════════════════════════════════════
-- The first draft's _ensure_policy_cancellation_refund_request called the
-- PUBLIC get_online_refundable_amount_for_payments RPC. That RPC checks
-- current_user_role() — which always reflects the ACTUAL calling session
-- (SECURITY DEFINER only changes table-privilege checking, never what a
-- session-derived helper like current_user_role() returns) — so a Member
-- or Pro cancelling their own reservation/lesson would hit
-- insufficient_role even though the outer cancellation RPC is itself
-- SECURITY DEFINER.
--
-- Fix: the effective 0157 "newest-refundable-attempt-first" calculation is
-- extracted verbatim into a new PRIVATE primitive,
-- _compute_online_refundable_amounts(p_club_id, p_payment_ids) — same
-- query, same RETURNS TABLE shape, zero actor-role check, club_id passed
-- in by the trusted caller rather than derived from the session.
-- get_online_refundable_amount_for_payments is redefined as a thin
-- wrapper: identical signature/return shape/Admin+Staff-only
-- authorization/club scoping/grants, its body now just resolves
-- v_club_id + the same role check it always had, then delegates. No
-- external caller of the public RPC can observe any behavioral
-- difference. open_payment_refund_attempt is untouched — it has its own
-- separate, mutation-time attempt-selection logic under its own FOR
-- UPDATE lock, never reachable from a cancellation path at all (Stripe
-- execution stays fully decoupled, exactly as before).
--
-- ═══════════════════════════════════════════════════════════════════════════
-- CORRECTION 2 — a refund-eligible cancellation could leave an unpaid/
-- partially-paid obligation outstanding forever
-- ═══════════════════════════════════════════════════════════════════════════
-- New private primitive, _release_uncollected_cancellation_balance(p_club_
-- id, p_payment_id, p_actor_id) — reproduces void_payment_obligation's own
-- 'unpaid' path (amount_paid_cents = 0, amount_due_cents > 0: one
-- void_payment_obligation payment_events row for the full due amount) and
-- waive_payment's own 'partially_paid' path (one 'waived' payment_events
-- row for exactly due - paid) VERBATIM, minus the Admin-only role check —
-- both existing RPCs remain completely unmodified and Admin-only; this is
-- a separate, internal-only entry point. Every OTHER status (paid,
-- overpaid, partially_refunded, refunded, waived, void) is left
-- completely untouched — matches isPaymentOpenForRecording's own exact
-- 'unpaid'/'partially_paid' status gate (src/lib/payments.ts) — never a
-- fabricated event merely because amount_due_cents - amount_paid_cents is
-- numerically positive under some other status. Called from the SAME
-- gated block as the refund-request primitive in all three cancel RPCs:
-- Member in_policy/grace and Admin/Staff/assigned-Pro always; Member
-- 'late' gets neither call — its obligation remains fully collectible, no
-- void, no waiver, no refund request. Collected online money is still
-- handled exclusively via payment_refund_requests; collected manual/
-- offline money is NEVER auto-refunded — record_refund (Admin, existing,
-- unmodified) remains the only path. Verified safe against the current
-- rollup model by direct re-read of void_payment_obligation/waive_
-- payment's own bodies (0151) — no conflict found, so this proceeds
-- rather than stopping.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- CORRECTION 3 — the wrong person was notified on rejection/completion
-- ═══════════════════════════════════════════════════════════════════════════
-- payment_refund_requests.requested_by is (and remains) the cancellation
-- ACTOR, for audit attribution — but reject_refund_request/_complete_
-- refund_request_for_attempt notified requested_by with an /admin/
-- payments deep link, which is wrong when the actor is a Member or Pro,
-- not Staff. Fix: payment_refund_requests gains beneficiary_user_id
-- (nullable, FK profiles) — for a policy row, resolved ONLY from the
-- payment's own trusted, snapshotted roster_member_id -> roster_members.
-- claimed_by (never client-supplied, never re-derived from a live
-- booking row); NULL for a still-unclaimed no-account Member. Existing
-- Staff-created rows stay NULL unless a later cancellation happens to
-- attach to the same pending payment (see correction 4). reject_refund_
-- request and _complete_refund_request_for_attempt are both redefined
-- with the same two-part notification rule:
--   * source = 'staff_requested' -> send the EXISTING notification to
--     requested_by, byte-identical shape, unchanged.
--   * beneficiary_user_id is not null AND (source <> 'staff_requested' OR
--     beneficiary_user_id <> requested_by) -> send a SEPARATE, member-safe
--     notification (same existing kind, reused — no new notification kind
--     — different body text, no target_path at all, matching the
--     established target_path-omission pattern already used by
--     reservation_cancelled_by_member/lesson_cancelled) to
--     beneficiary_user_id.
-- An ordinary Staff request with no beneficiary fires only the first
-- block, byte-identical to today. A pure policy request (source =
-- 'cancellation_policy') never fires the first (admin-linked) block at
-- all, only the second. A Staff request that later gains a DIFFERENT
-- beneficiary fires both. If beneficiary_user_id ever equals requested_by
-- for a Staff row, the second block's own condition suppresses the
-- duplicate.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- CORRECTION 4 — an existing pending request's amount was trusted blindly
-- ═══════════════════════════════════════════════════════════════════════════
-- _ensure_policy_cancellation_refund_request now ALWAYS recomputes the
-- current policy-refundable amount (via the new private calculation) even
-- when a pending request already exists, and ALWAYS attaches trusted
-- beneficiary context to that existing row. payment_refund_requests
-- gains policy_refundable_cents_at_cancellation (nullable integer) —
-- durably records what the policy calculation produced at the moment a
-- cancellation touched this request. When the existing request's own
-- requested_amount_cents already matches, nothing else changes. When it
-- differs, the Staff-authored requested_amount_cents is NEVER overwritten
-- — a manual-review note (stating the computed amount) is appended to
-- (never replacing) any existing notes. Cancellation still succeeds
-- either way; no duplicate pending request is ever created — the existing
-- payment_refund_requests_one_pending_per_payment partial unique index
-- remains the authoritative backstop, now paired with a race-caught
-- attach-to-the-winner branch identical in shape to the fresh-insert
-- race already handled.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- TARGETED MULTI-CHECKOUT-ATTEMPT FINDING (unchanged from the first draft
-- — verified once, still holds)
-- ═══════════════════════════════════════════════════════════════════════════
-- get_online_refundable_amount_for_payments / open_payment_refund_attempt
-- (both effective as of 0157, "Blocker 3 — newest-refundable-attempt-
-- first") deliberately resolve only the SINGLE most-recently-completed
-- payment_checkout_attempts row that still has remaining refundable room
-- — never a sum across every completed attempt for a payment. This
-- migration does NOT build a multi-attempt refund engine.
-- _ensure_policy_cancellation_refund_request does a single, cheap,
-- non-financial COUNT of the payment's 'completed' payment_checkout_
-- attempts rows; when more than one exists, the created request's notes
-- are annotated for manual review rather than silently presenting a
-- partial amount as complete.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- LOCK ORDER (unchanged from the first draft)
-- ═══════════════════════════════════════════════════════════════════════════
-- Domain-primary RPCs (update_member_reservation, cancel_lesson,
-- cancel_member_reservation, admin_cancel_reservation_v2) lock the domain
-- row FIRST, then `payments` SECOND, immediately before the pre-mutation
-- Checkout-invalidation call — no payment-primary RPC ever locks a domain
-- row, so this order is provably safe. _release_uncollected_cancellation_
-- balance and _ensure_policy_cancellation_refund_request both assume the
-- caller already holds FOR UPDATE on the target payments row and take no
-- lock of their own on it; _ensure_policy_cancellation_refund_request
-- additionally locks the specific payment_refund_requests row SECOND
-- (payment-row-first, request-row-second), matching begin_refund_
-- request_execution's own established order exactly.
--
-- Not applied by this checkpoint. Not committed.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Schema
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.reservations
  add column cancellation_policy_state text
    check (cancellation_policy_state in ('in_policy', 'grace', 'late', 'not_applicable'));

alter table public.lesson_requests
  add column cancellation_policy_state text
    check (cancellation_policy_state in ('in_policy', 'grace', 'late', 'not_applicable'));

-- Distinguishes a Staff-typed request (create_refund_request, unchanged)
-- from a system-generated one. NOT NULL DEFAULT keeps create_refund_
-- request's existing explicit-column-list INSERT a zero-diff call — the
-- omitted column simply takes its default.
alter table public.payment_refund_requests
  add column source text not null default 'staff_requested'
    check (source in ('staff_requested', 'cancellation_policy'));

-- Correction 3: who the refund actually belongs to, distinct from
-- requested_by (the acting Staff member OR cancellation actor). Never
-- client-supplied — populated only from trusted, snapshotted payment/
-- roster identity (see _ensure_policy_cancellation_refund_request below).
alter table public.payment_refund_requests
  add column beneficiary_user_id uuid references public.profiles(id);

-- Correction 4: the policy-computed refundable amount at the moment a
-- cancellation touched this request — durable manual-review context,
-- never used to silently overwrite a Staff-authored requested_amount_
-- cents.
alter table public.payment_refund_requests
  add column policy_refundable_cents_at_cancellation integer
    check (policy_refundable_cents_at_cancellation is null or policy_refundable_cents_at_cancellation >= 0);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. public._compute_online_refundable_amounts — PRIVATE, no actor-role
--    check. The exact 0157 "newest-refundable-attempt-first" query,
--    parameterized on a trusted p_club_id instead of deriving it from the
--    session.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public._compute_online_refundable_amounts(
  p_club_id     uuid,
  p_payment_ids uuid[]
)
returns table (
  payment_id       uuid,
  refundable_cents integer,
  currency          text
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  return query
    with sources as (
      select a.id as attempt_id, a.payment_id, a.amount_expected_cents, a.created_at, p.currency
        from public.payment_checkout_attempts a
        join public.payments p on p.id = a.payment_id
       where a.club_id = p_club_id
         and a.payment_id = any(p_payment_ids)
         and a.status = 'completed'
    ),
    reserved as (
      select pra.source_checkout_attempt_id as attempt_id, coalesce(sum(pra.requested_amount_cents), 0) as reserved_cents
        from public.payment_refund_attempts pra
       where pra.club_id = p_club_id
         and pra.status in ('succeeded', 'pending', 'requires_action')
       group by pra.source_checkout_attempt_id
    ),
    attempts_with_remaining as (
      select s.attempt_id, s.payment_id, s.currency, s.created_at,
             greatest(s.amount_expected_cents - coalesce(r.reserved_cents, 0), 0)::integer as remaining_cents
        from sources s
        left join reserved r on r.attempt_id = s.attempt_id
    ),
    selected as (
      select distinct on (w.payment_id)
        w.payment_id, w.remaining_cents, w.currency
        from attempts_with_remaining w
       where w.remaining_cents > 0
       order by w.payment_id, w.created_at desc, w.attempt_id desc
    )
    select sel.payment_id, sel.remaining_cents, sel.currency
      from selected sel;
end;
$$;

revoke execute on function public._compute_online_refundable_amounts(uuid, uuid[])
  from public, anon, authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. get_online_refundable_amount_for_payments — thin public wrapper
-- ═══════════════════════════════════════════════════════════════════════════
-- Signature, return shape, Admin+Staff-only authorization, club scoping,
-- and grants are all byte-identical to the currently-applied 0157 body.
-- Only the query body itself moved into the private primitive above.
create or replace function public.get_online_refundable_amount_for_payments(
  p_payment_ids uuid[]
)
returns table (
  payment_id       uuid,
  refundable_cents integer,
  currency          text
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_role    text;
begin
  v_club_id := public.current_user_club_id();
  v_role    := public.current_user_role();
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;

  return query
    select * from public._compute_online_refundable_amounts(v_club_id, p_payment_ids);
end;
$$;

revoke execute on function public.get_online_refundable_amount_for_payments(uuid[]) from public, anon;
grant  execute on function public.get_online_refundable_amount_for_payments(uuid[]) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. public._release_uncollected_cancellation_balance — new PRIVATE
--    primitive (correction 2)
-- ═══════════════════════════════════════════════════════════════════════════
-- Caller MUST already hold FOR UPDATE on the target payments row (same
-- contract as _ensure_policy_cancellation_refund_request below) — this
-- function takes no lock of its own. Only ever called from the same
-- gated point in a cancellation RPC that a Member's 'late' cancellation
-- never reaches, so a late cancellation's obligation is never voided or
-- waived by construction (not merely by a redundant status check here).
-- Never touches payments.amount_due_cents/amount_paid_cents/status
-- directly — both branches are a single payment_events insert, exactly
-- reproducing void_payment_obligation's/waive_payment's own existing,
-- currently-applied event shape and amount computation (minus their
-- Admin-only role check, which does not apply to this internal-only
-- entry point). Every other status is left untouched — matches
-- isPaymentOpenForRecording's own exact gate (src/lib/payments.ts).
create or replace function public._release_uncollected_cancellation_balance(
  p_club_id    uuid,
  p_payment_id uuid,
  p_actor_id   uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment   public.payments%rowtype;
  v_remaining integer;
begin
  if p_club_id is null or p_payment_id is null or p_actor_id is null then
    raise exception 'invalid_arguments';
  end if;

  select * into v_payment
    from public.payments
   where id = p_payment_id and club_id = p_club_id;
  if not found then
    return;
  end if;

  if v_payment.status = 'unpaid' then
    -- Mirrors void_payment_obligation's own exact gate.
    if v_payment.amount_paid_cents = 0 and v_payment.amount_due_cents > 0 then
      insert into public.payment_events (payment_id, club_id, event_type, amount_cents, notes, actor_id)
      values (p_payment_id, p_club_id, 'void_payment_obligation', v_payment.amount_due_cents,
              'Released by cancellation — never collected.', p_actor_id);

      insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
      values (p_club_id, p_actor_id, 'void_payment_obligation', 'payment', p_payment_id,
        jsonb_build_object('amount_voided_cents', v_payment.amount_due_cents, 'reason', 'cancellation'));
    end if;

  elsif v_payment.status = 'partially_paid' then
    -- Mirrors waive_payment's own exact computation.
    v_remaining := v_payment.amount_due_cents - v_payment.amount_paid_cents;
    if v_remaining > 0 then
      insert into public.payment_events (payment_id, club_id, event_type, amount_cents, notes, actor_id)
      values (p_payment_id, p_club_id, 'waived', v_remaining,
              'Released by cancellation — remaining balance never collected.', p_actor_id);

      insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
      values (p_club_id, p_actor_id, 'waive_payment', 'payment', p_payment_id,
        jsonb_build_object('amount_waived_cents', v_remaining, 'reason', 'cancellation'));
    end if;
  end if;
  -- paid / overpaid / partially_refunded / refunded / waived / void: no
  -- uncollected balance exists by definition — never fabricate an event.
end;
$$;

revoke execute on function public._release_uncollected_cancellation_balance(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. public._ensure_policy_cancellation_refund_request — redefined
--    (corrections 1, 3, 4)
-- ═══════════════════════════════════════════════════════════════════════════
-- Contract unchanged: caller MUST already hold FOR UPDATE on the target
-- payments row; p_policy_state must be 'in_policy', 'grace', or
-- 'not_applicable' (never 'late'). Returns the id of the request that now
-- exists, or NULL when none is needed (no payment, manual payment,
-- nothing currently refundable online AND no pre-existing pending
-- request to attach context to).
create or replace function public._ensure_policy_cancellation_refund_request(
  p_club_id      uuid,
  p_payment_id   uuid,
  p_actor_id     uuid,
  p_policy_state text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment                public.payments%rowtype;
  v_refundable              integer;
  v_beneficiary_user_id      uuid;
  v_existing                 public.payment_refund_requests%rowtype;
  v_completed_attempts_count integer;
  v_reason                   text;
  v_notes                    text;
  v_result_id                 uuid;
begin
  if p_club_id is null or p_payment_id is null or p_actor_id is null then
    raise exception 'invalid_arguments';
  end if;
  if p_policy_state not in ('in_policy', 'grace', 'not_applicable') then
    raise exception 'invalid_policy_state_for_refund_request';
  end if;

  select * into v_payment
    from public.payments
   where id = p_payment_id and club_id = p_club_id;
  if not found then
    return null;
  end if;

  if v_payment.payment_mode_at_creation <> 'court_time_payments' then
    return null;
  end if;

  -- Correction 3: trusted beneficiary resolution — the payment's OWN
  -- snapshotted roster_member_id (never re-derived from a live booking
  -- row) to that Member's CURRENT claimed account, if any. Never accepted
  -- from the client. NULL for a still-unclaimed no-account Member.
  if v_payment.roster_member_id is not null then
    select claimed_by into v_beneficiary_user_id
      from public.roster_members
     where id = v_payment.roster_member_id;
  end if;

  -- Correction 1: the PRIVATE, non-role-gated calculation.
  select refundable_cents into v_refundable
    from public._compute_online_refundable_amounts(p_club_id, array[p_payment_id])
   where payment_id = p_payment_id;
  v_refundable := coalesce(v_refundable, 0);

  -- Correction 4: an unresolved pending request already exists (Staff-
  -- created, or a prior policy call) — never duplicated. ALWAYS attach
  -- trusted beneficiary context and the current policy-computed amount;
  -- NEVER overwrite a Staff-authored requested_amount_cents. Payment-
  -- row-first (already held by caller), request-row-second.
  select * into v_existing
    from public.payment_refund_requests
   where payment_id = p_payment_id and status = 'pending'
   for update;

  if found then
    v_notes := v_existing.notes;
    if v_existing.requested_amount_cents <> v_refundable then
      v_notes := case
        when v_notes is null or btrim(v_notes) = '' then
          'Policy-computed refundable amount at cancellation: ' || v_refundable || ' cents — differs from this request''s requested amount. Verify before approving.'
        else
          v_notes || E'\n' || 'Policy-computed refundable amount at cancellation: ' || v_refundable || ' cents — differs from this request''s requested amount. Verify before approving.'
      end;
    end if;

    update public.payment_refund_requests
       set beneficiary_user_id                     = coalesce(beneficiary_user_id, v_beneficiary_user_id),
           policy_refundable_cents_at_cancellation  = v_refundable,
           notes                                    = v_notes
     where id = v_existing.id;

    return v_existing.id;
  end if;

  if v_refundable <= 0 then
    return null;
  end if;

  v_reason := case p_policy_state
    when 'in_policy' then 'Automatic refund request: Member cancelled within the club''s cancellation policy.'
    when 'grace'      then 'Automatic refund request: Member cancelled during the grace period.'
    else                   'Automatic refund request: booking cancelled by the club or assigned provider.'
  end;

  -- Targeted multi-Checkout-attempt finding — cheap cardinality check
  -- only, never a re-derivation of refund math.
  select count(*) into v_completed_attempts_count
    from public.payment_checkout_attempts
   where payment_id = p_payment_id and status = 'completed';

  v_notes := null;
  if v_completed_attempts_count > 1 then
    v_notes := 'This payment has more than one completed online Checkout attempt — the requested amount reflects only the most recent attempt with remaining balance. Verify the full refundable balance before treating this as complete.';
  end if;

  begin
    insert into public.payment_refund_requests (
      club_id, payment_id, requested_by, requested_amount_cents, reason, notes, source,
      beneficiary_user_id, policy_refundable_cents_at_cancellation
    ) values (
      p_club_id, p_payment_id, p_actor_id, v_refundable, v_reason, v_notes, 'cancellation_policy',
      v_beneficiary_user_id, v_refundable
    ) returning id into v_result_id;
  exception
    when unique_violation then
      -- Genuine race — another transaction (Staff, or a concurrent policy
      -- call) created a pending request between our own check and this
      -- insert. Attach context to that winning row rather than erroring —
      -- same reasoning as the found-existing branch above.
      select * into v_existing
        from public.payment_refund_requests
       where payment_id = p_payment_id and status = 'pending'
       for update;

      v_notes := v_existing.notes;
      if v_existing.requested_amount_cents <> v_refundable then
        v_notes := case
          when v_notes is null or btrim(v_notes) = '' then
            'Policy-computed refundable amount at cancellation: ' || v_refundable || ' cents — differs from this request''s requested amount. Verify before approving.'
          else
            v_notes || E'\n' || 'Policy-computed refundable amount at cancellation: ' || v_refundable || ' cents — differs from this request''s requested amount. Verify before approving.'
        end;
      end if;

      update public.payment_refund_requests
         set beneficiary_user_id                    = coalesce(beneficiary_user_id, v_beneficiary_user_id),
             policy_refundable_cents_at_cancellation = v_refundable,
             notes                                   = v_notes
       where id = v_existing.id;

      return v_existing.id;
  end;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    p_club_id, p_actor_id, 'create_refund_request', 'payment_refund_request', v_result_id,
    jsonb_build_object(
      'payment_id',             p_payment_id,
      'requested_amount_cents', v_refundable,
      'source',                 'cancellation_policy',
      'policy_state',           p_policy_state,
      'beneficiary_user_id',    v_beneficiary_user_id
    )
  );

  -- Admin-facing notification — unchanged shape/recipients from the first
  -- draft, reused verbatim from create_refund_request's own 0183 block.
  insert into public.notifications (club_id, user_id, kind, body, metadata)
  select
    p_club_id,
    cm.user_id,
    'refund_request_submitted',
    'Refund request received',
    jsonb_build_object(
      'request_id',             v_result_id,
      'payment_id',             p_payment_id,
      'requested_by',           p_actor_id,
      'requested_amount_cents', v_refundable,
      'target_path',            '/admin/payments?refundRequest=' || v_result_id::text
    )
    from public.club_memberships cm
   where cm.club_id    = p_club_id
     and cm.role        = 'admin'
     and cm.status      = 'active'
     and cm.removed_at is null
     and cm.user_id    <> p_actor_id;

  return v_result_id;
end;
$$;

revoke execute on function public._ensure_policy_cancellation_refund_request(uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. reject_refund_request — redefined (correction 3)
-- ═══════════════════════════════════════════════════════════════════════════
-- Reproduced from its currently-applied body (0181) with exactly one
-- change: the single unconditional notification insert is replaced by
-- the two-part rule described in this migration's own header comment
-- ("CORRECTION 3"). Every check, the payment-first lock order, the
-- execution-started guard, and the status transition/audit_log insert
-- are byte-identical to 0181's body.
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
  if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;

  v_reason := btrim(coalesce(p_rejection_reason, ''));
  if length(v_reason) = 0 then
    raise exception 'rejection_reason_required';
  end if;

  select * into v_probe
    from public.payment_refund_requests
   where id = p_request_id and club_id = v_club_id;
  if not found then raise exception 'request_not_found'; end if;

  select * into v_payment
    from public.payments
   where id = v_probe.payment_id and club_id = v_club_id
   for update;
  if not found then raise exception 'payment_not_found'; end if;

  select * into v_request
    from public.payment_refund_requests
   where id = p_request_id and club_id = v_club_id
   for update;

  if not found or v_request.payment_id <> v_payment.id then
    raise exception 'request_not_found';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'request_not_pending';
  end if;

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

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'reject_refund_request', 'payment_refund_request', p_request_id,
    jsonb_build_object('payment_id', v_request.payment_id, 'rejection_reason', v_reason)
  );

  -- Correction 3: two-part notification rule — see this migration's own
  -- header comment for the full case analysis (A/B/C).
  if v_request.source = 'staff_requested' then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id, v_request.requested_by, 'refund_request_rejected',
      'Your refund request was not approved.',
      jsonb_build_object('request_id', v_request.id, 'payment_id', v_request.payment_id, 'target_path', '/admin/payments')
    );
  end if;

  if v_request.beneficiary_user_id is not null
     and (v_request.source <> 'staff_requested' or v_request.beneficiary_user_id <> v_request.requested_by)
  then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id, v_request.beneficiary_user_id, 'refund_request_rejected',
      'A refund related to your cancelled booking was not approved. Contact the club for details.',
      jsonb_build_object('request_id', v_request.id, 'payment_id', v_request.payment_id)
    );
  end if;

  return v_request;
end;
$$;

-- Grants unchanged — same signature, CREATE OR REPLACE preserves existing
-- grants on the function's own OID.

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. _complete_refund_request_for_attempt — redefined (correction 3)
-- ═══════════════════════════════════════════════════════════════════════════
-- Reproduced from its currently-applied body (0181) with exactly one
-- change: the single unconditional notification insert is replaced by
-- the SAME two-part rule as reject_refund_request above. The idempotent
-- no-op guard, the status transition, and the audit_log insert are
-- byte-identical to 0181's body.
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

  if not found then
    return;
  end if;

  update public.payment_refund_requests
     set status = 'completed'
   where id = v_request.id;

  if v_request.source = 'staff_requested' then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_request.club_id, v_request.requested_by, 'refund_request_completed',
      'Your refund request has been approved and the refund is complete.',
      jsonb_build_object('request_id', v_request.id, 'payment_id', v_request.payment_id, 'target_path', '/admin/payments')
    );
  end if;

  if v_request.beneficiary_user_id is not null
     and (v_request.source <> 'staff_requested' or v_request.beneficiary_user_id <> v_request.requested_by)
  then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_request.club_id, v_request.beneficiary_user_id, 'refund_request_completed',
      'Your refund for a cancelled booking has been processed.',
      jsonb_build_object('request_id', v_request.id, 'payment_id', v_request.payment_id)
    );
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_request.club_id, v_request.reviewed_by, 'complete_refund_request', 'payment_refund_request', v_request.id,
    jsonb_build_object('payment_id', v_request.payment_id, 'refund_attempt_id', p_refund_attempt_id)
  );
end;
$$;

revoke all on function public._complete_refund_request_for_attempt(uuid)
  from public, anon, authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. cancel_member_reservation — late no longer blocks; Checkout guard
--    added; uncollected-balance release + policy refund request for
--    in_policy/grace
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.cancel_member_reservation(
  p_reservation_id   uuid,
  p_expected_club_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id                     uuid;
  v_role                        text;
  v_roster_member_id            uuid;
  v_before                      reservations%rowtype;
  v_after                       reservations%rowtype;
  v_cancellation_window_hours   integer;
  v_cancellation_grace_minutes  integer;
  v_tz               text;
  v_policy_state      text;
  v_payment_id        uuid;
  v_refund_request_id uuid;
  v_notification_id  uuid;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  -- Null-safe: NULL NOT IN ('member','pro') evaluates to NULL (not TRUE),
  -- which would silently fail to raise for a null v_role — reject null
  -- explicitly rather than relying on NOT IN alone.
  if v_role is null or v_role not in ('member', 'pro') then
    raise exception 'insufficient_role';
  end if;

  -- Phase 33C3: the caller's own durable Member identity for this club, if
  -- claimed. Server-resolved only — never accepted from the client — and
  -- inherently same-club (see helper definition above). May legitimately
  -- be null; that is not an error here, it only narrows the ownership
  -- match below back to the original owner_user_id-only behavior.
  v_roster_member_id := public.current_user_roster_member_id();

  select * into v_before
    from reservations
    where id = p_reservation_id
      and club_id = v_club_id
      and (
        owner_user_id = auth.uid()
        or (v_roster_member_id is not null and roster_member_id = v_roster_member_id)
      )
    for update;
  if not found then raise exception 'reservation_not_found'; end if;

  if v_before.reason <> 'member_booking' then raise exception 'reservation_not_editable'; end if;
  if v_before.status <> 'confirmed' then raise exception 'reservation_not_editable'; end if;

  -- Cancellation-window/grace resolution unchanged from 0097/0110 — same
  -- club_settings lookup, same 24h/5min defaulting behavior.
  select cancellation_window_hours, cancellation_grace_minutes
    into v_cancellation_window_hours, v_cancellation_grace_minutes
    from club_settings
    where club_id = v_club_id;

  if not found then
    v_cancellation_window_hours  := 24;
    v_cancellation_grace_minutes := 5;
  else
    v_cancellation_window_hours  := coalesce(v_cancellation_window_hours, 24);
    v_cancellation_grace_minutes := coalesce(v_cancellation_grace_minutes, 5);
  end if;

  -- Phase 40's shared evaluator remains authoritative — still classifies
  -- in_policy/grace/late. Phase 41A: 'late' no longer raises. It is now
  -- simply persisted (below) and skips both the uncollected-balance
  -- release and the policy refund request.
  select state into v_policy_state
    from public._evaluate_cancellation_policy(
      v_before.starts_at,
      v_cancellation_window_hours,
      v_cancellation_grace_minutes,
      v_before.created_at,
      now()
    );

  -- Phase 41A: resolve+lock this reservation's current payment obligation
  -- (if any) and run the SAME pre-mutation Stripe Checkout-invalidation
  -- guard every other domain mutation already uses — this RPC never had
  -- it (the gap the Phase 41 audit found). Domain-row-first, payment-row
  -- second — see this migration's own header "LOCK ORDER" comment.
  select id into v_payment_id
    from public.payments
   where club_id = v_club_id and domain_type = 'reservation' and domain_id = p_reservation_id
   order by obligation_cycle desc
   limit 1
   for update;

  if v_payment_id is not null then
    perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id);

    -- in_policy/grace: release any uncollected balance and ensure a
    -- policy refund request for whatever was already collected online.
    -- late: neither call runs — the obligation remains fully collectible.
    if v_policy_state <> 'late' then
      perform public._release_uncollected_cancellation_balance(v_club_id, v_payment_id, auth.uid());
      v_refund_request_id := public._ensure_policy_cancellation_refund_request(
        v_club_id, v_payment_id, auth.uid(), v_policy_state
      );
    end if;
  end if;

  update reservations set
    status                     = 'cancelled',
    cancelled_at               = now(),
    cancelled_by               = auth.uid(),
    cancellation_kind          = 'member',
    cancellation_policy_state  = v_policy_state,
    updated_at                 = now()
  where id = p_reservation_id
  returning * into v_after;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id,
    auth.uid(),
    'cancel_member_reservation',
    'reservation',
    p_reservation_id,
    jsonb_build_object(
      'court_id',         v_before.court_id,
      'owner_user_id',    v_before.owner_user_id,
      'roster_member_id', v_before.roster_member_id,
      'starts_at',        v_before.starts_at,
      'reason',           v_before.reason,
      'policy_state',      v_policy_state,
      'refund_request_id', v_refund_request_id
    )
  );

  select timezone into v_tz from clubs where id = v_club_id;

  v_notification_id := null;

  -- Preserved exactly from notify_reservation_cancelled_by_member (0040/0043):
  -- same kind, same preference gating, same body shape. Always addressed to
  -- auth.uid() (the caller performing the cancellation), never to
  -- v_before.owner_user_id — unaffected by the ownership-match change above.
  if user_pref_enabled(auth.uid(), 'reservation_cancelled_by_member') then
    insert into notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id,
      auth.uid(),
      'reservation_cancelled_by_member',
      'Your reservation on '
        || to_char(v_before.starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM')
        || ' was cancelled.',
      jsonb_build_object('reservation_id', p_reservation_id)
    )
    returning id into v_notification_id;
  end if;

  return jsonb_build_object(
    'reservation',     to_jsonb(v_after),
    'notification_id', v_notification_id
  );
end;
$$;

-- Grants unchanged — same signature, CREATE OR REPLACE preserves existing
-- grants on the function's own OID.

-- ═══════════════════════════════════════════════════════════════════════════
-- 9. admin_cancel_reservation_v2 — FOR UPDATE added, Checkout guard added,
--    always-eligible uncollected-balance release + policy refund request
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
  v_payment_id        uuid;
  v_refund_request_id uuid;
  v_notification_id uuid;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.role not in ('admin', 'staff') then
    raise exception 'insufficient_role';
  end if;

  select * into v_res
    from public.reservations
    where id      = p_reservation_id
      and club_id = v_profile.club_id
      and status in ('pending', 'confirmed')
    for update;
  if not found then raise exception 'reservation_not_found'; end if;

  -- Phase 41A: same Checkout-invalidation guard as cancel_member_
  -- reservation above; club/Staff cancellation of a paid booking is
  -- ALWAYS refund-eligible and its uncollected balance is ALWAYS
  -- released, regardless of timing — no policy-state gate. Domain-row-
  -- first (already locked above), payment-row second.
  select id into v_payment_id
    from public.payments
   where club_id = v_profile.club_id and domain_type = 'reservation' and domain_id = p_reservation_id
   order by obligation_cycle desc
   limit 1
   for update;

  if v_payment_id is not null then
    perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id);

    perform public._release_uncollected_cancellation_balance(v_profile.club_id, v_payment_id, auth.uid());
    v_refund_request_id := public._ensure_policy_cancellation_refund_request(
      v_profile.club_id, v_payment_id, auth.uid(), 'not_applicable'
    );
  end if;

  update public.reservations set
    status                    = 'cancelled',
    cancelled_at              = now(),
    cancelled_by              = auth.uid(),
    cancellation_kind         = 'admin',
    cancellation_policy_state = 'not_applicable',
    updated_at                = now()
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
      'reason',        v_res.reason,
      'policy_state',      'not_applicable',
      'refund_request_id', v_refund_request_id
    )
  );

  select timezone into v_tz from public.clubs where id = v_profile.club_id;

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

-- Grants unchanged — same signature, CREATE OR REPLACE preserves existing
-- grants on the function's own OID.

-- ═══════════════════════════════════════════════════════════════════════════
-- 10. cancel_lesson — Member late no longer blocks; existing Checkout
--     guard reused (not re-locked) for uncollected-balance release +
--     policy refund request
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.cancel_lesson(
  p_request_id uuid,
  p_reason     text default null
)
returns public.lesson_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile          public.profiles%rowtype;
  v_request          public.lesson_requests%rowtype;
  v_actor_role        text;
  -- Phase 34A4A correction: the value actually persisted to
  -- lesson_requests.last_actor_role — deliberately kept separate from
  -- v_actor_role (a BEHAVIORAL classification used only for the
  -- cancellation-window check and the reservations.cancellation_kind
  -- mapping below, both unchanged). Same branch structure as v_actor_role,
  -- differing in exactly one place: a Staff operator resolves to 'staff'
  -- here (their actual role) rather than v_actor_role's 'admin' bucket.
  v_persisted_actor_role text;
  v_result            public.lesson_requests%rowtype;
  v_member             public.profiles%rowtype;
  v_pro                public.profiles%rowtype;
  v_window_hours       int;
  v_policy_state        text;
  v_refund_request_id   uuid;
  v_old_reservation    public.reservations%rowtype;
  v_effective_starts_at timestamptz;
  v_caller_roster_id    uuid;
  v_is_member_by_history boolean;
  v_is_member_by_roster  boolean;
  v_is_pro               boolean;
  v_is_admin             boolean;
  v_roster              public.roster_members%rowtype;
  v_current_member_id   uuid;
  -- Phase 34F-A (external review correction): pre-mutation Stripe
  -- Checkout invalidation.
  v_payment_id_for_checkout_guard uuid;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  select * into v_request
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_profile.club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  select id into v_caller_roster_id
    from public.roster_members
   where club_id    = v_profile.club_id
     and claimed_by = auth.uid();

  select * into v_roster from public.roster_members where id = v_request.roster_member_id;
  v_current_member_id := v_roster.claimed_by;

  v_is_member_by_history := v_request.member_id is not null and v_request.member_id = auth.uid();
  v_is_member_by_roster  := v_caller_roster_id is not null and v_request.roster_member_id = v_caller_roster_id;
  v_is_pro                := v_request.pro_id = auth.uid();
  v_is_admin               := v_profile.role = 'admin';

  -- Phase 34A4: Staff joins this allowlist as a generic operator — every
  -- other admitted case above is unchanged.
  if not (v_is_member_by_history or v_is_member_by_roster or v_is_pro or v_is_admin or v_profile.role = 'staff') then
    raise exception 'not_authorised_to_cancel';
  end if;

  if not (
    v_request.status = 'confirmed'
    or (v_request.status = 'proposed' and v_request.linked_reservation_id is not null)
  ) then
    raise exception 'invalid_status_for_cancel';
  end if;

  if v_request.linked_reservation_id is not null then
    select * into v_old_reservation
      from public.reservations
     where id      = v_request.linked_reservation_id
       and club_id = v_profile.club_id
       and reason  = 'pro_lesson'
       and status  = 'confirmed'
     for update;
    if not found then raise exception 'linked_reservation_not_found'; end if;
    v_effective_starts_at := v_old_reservation.starts_at;
  else
    v_effective_starts_at := v_request.proposed_starts_at;
  end if;

  -- Phase 34A4: Staff gets the same already-started correction exemption
  -- Admin already has.
  if v_effective_starts_at <= now() and v_profile.role not in ('admin', 'staff') then
    raise exception 'lesson_already_started';
  end if;

  -- Phase 34A4: NEW third branch inserted after the unchanged admin/pro
  -- branches, before the unchanged `else 'member'` fallback — see this
  -- section's header above for the full non-regression argument. Purely
  -- BEHAVIORAL from here down (cancellation-window check,
  -- reservations.cancellation_kind mapping) — never written to
  -- lesson_requests.last_actor_role directly (see v_persisted_actor_role
  -- below, Phase 34A4A correction).
  v_actor_role := case
    when v_profile.role = 'admin' then 'admin'
    when auth.uid() = v_request.pro_id then 'pro'
    when v_profile.role = 'staff' and not (v_is_member_by_history or v_is_member_by_roster) then 'admin'
    else 'member'
  end;

  -- Phase 34A4A correction: identical branch structure/conditions to
  -- v_actor_role above — admin, pro-as-assigned-provider, and the
  -- else-'member' fallback (which also covers a non-staff, non-pro-here
  -- club member such as a Pro taking a lesson from another Pro — unchanged
  -- pre-existing behavior, not touched by this correction) all resolve
  -- identically to v_actor_role. Differs in exactly one branch: a Staff
  -- operator resolves to 'staff' (their actual role), not v_actor_role's
  -- 'admin' bucket — this is the only value ever written to
  -- lesson_requests.last_actor_role.
  v_persisted_actor_role := case
    when v_profile.role = 'admin' then 'admin'
    when auth.uid() = v_request.pro_id then 'pro'
    when v_profile.role = 'staff' and not (v_is_member_by_history or v_is_member_by_roster) then 'staff'
    else 'member'
  end;

  -- Phase 40: admin/pro/staff never enter the window-check branch — this
  -- migration does not change their behavior at all beyond the
  -- always-eligible uncollected-balance release/refund request below.
  -- Phase 41A: the Member-only window check no longer raises for 'late'
  -- — in_policy/grace/late all now succeed. Grace remains disabled for
  -- lessons (0 minutes, no anchor) — lesson_requests.created_at is never
  -- used as a grace anchor.
  if v_actor_role = 'member' then
    select coalesce(cs.cancellation_window_hours, 24) into v_window_hours
      from public.club_settings cs
     where cs.club_id = v_profile.club_id;

    select state into v_policy_state
      from public._evaluate_cancellation_policy(
        v_effective_starts_at,
        v_window_hours,
        0,
        null,
        now()
      );
  else
    v_policy_state := 'not_applicable';
  end if;

  -- Phase 34F-A (external review correction) — pre-mutation Stripe
  -- Checkout invalidation, mirroring 0151's admin_update_member_lesson/
  -- update_member_reservation guard exactly. Reachable from BOTH of this
  -- function's two admitted entry statuses ('confirmed', and 'proposed'
  -- with a linked reservation — a reschedule proposal on an already-
  -- confirmed lesson); either can have an existing payment obligation
  -- (created once, at first confirmation, by accept_lesson_proposal/
  -- admin_create_member_lesson, 0144) and, on the confirmed path, a
  -- genuinely open Stripe Checkout attempt a Member started before this
  -- cancellation. Runs only after every status/window validation above has
  -- passed — an invalid cancel request must never expire a legitimate
  -- Stripe Checkout Session before Court Time even knows the requested
  -- action would fail. Still a pure DOMAIN mutation, never a money
  -- mutation: this call only ever cancels/flags a Checkout ATTEMPT row —
  -- it never touches payments.amount_due_cents/amount_paid_cents, never
  -- inserts a payment_events row, never refunds/waives/voids anything. If
  -- a bound Session may still be genuinely payable, _invalidate_or_flag_
  -- open_checkout_attempt raises open_checkout_requires_resolution and
  -- this entire cancellation rolls back — the calling Server Action
  -- (cancelLesson, lessons/actions.ts) resolves the remote Session via the
  -- established resolveBlockingCheckoutBeforeMutation handshake, then
  -- safely retries this exact call once.
  select id into v_payment_id_for_checkout_guard
    from public.payments
   where club_id = v_profile.club_id and domain_type = 'lesson_request' and domain_id = p_request_id
   order by obligation_cycle desc
   limit 1
   for update;
  if v_payment_id_for_checkout_guard is not null then
    perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);

    -- Phase 41A: reuses the SAME already-locked payment id — no second
    -- lock acquisition. A Member's in_policy cancellation, and any
    -- admin/pro cancellation, releases any uncollected balance and
    -- ensures a policy refund request; a Member's 'late' cancellation
    -- does neither.
    if v_policy_state <> 'late' then
      perform public._release_uncollected_cancellation_balance(v_profile.club_id, v_payment_id_for_checkout_guard, auth.uid());
      v_refund_request_id := public._ensure_policy_cancellation_refund_request(
        v_profile.club_id, v_payment_id_for_checkout_guard, auth.uid(), v_policy_state
      );
    end if;
  end if;

  if v_request.linked_reservation_id is not null then
    update public.reservations
       set status            = 'cancelled',
           cancelled_at      = now(),
           cancelled_by      = auth.uid(),
           cancellation_kind = case when v_actor_role = 'member' then 'member' else 'admin' end
     where id = v_request.linked_reservation_id;
  end if;

  update public.lesson_requests
     set status            = 'cancelled',
         lesson_outcome    = 'cancelled',
         cancellation_reason = p_reason,
         cancelled_at        = now(),
         last_actor_id        = auth.uid(),
         -- Phase 34A4A correction: v_persisted_actor_role, not v_actor_role
         -- — see its declaration/computation above. Admin, Pro-as-assigned-
         -- provider, and every pre-existing else-'member' case (including
         -- a Pro taking a lesson from another Pro, unchanged) resolve
         -- identically to before; only a Staff operator now correctly
         -- resolves to 'staff' instead of v_actor_role's 'admin' bucket.
         last_actor_role      = v_persisted_actor_role,
         cancellation_policy_state = v_policy_state,
         proposed_starts_at   = null,
         proposed_ends_at     = null,
         proposed_court_id    = null,
         updated_at           = now()
   where id = p_request_id
  returning * into v_result;

  select * into v_member from public.profiles where id = v_current_member_id;
  select * into v_pro     from public.profiles where id = v_request.pro_id;

  if v_actor_role <> 'pro' and v_request.pro_id is not null then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_profile.club_id,
      v_request.pro_id,
      'lesson_cancelled',
      'Your lesson with '
        || trim(coalesce(v_member.first_name, '') || ' ' || coalesce(v_member.last_name, ''))
        || ' was cancelled.',
      jsonb_build_object('request_id', p_request_id)
    );
  end if;

  if v_actor_role <> 'member' and v_current_member_id is not null then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_profile.club_id,
      v_current_member_id,
      'lesson_cancelled',
      'Your lesson with '
        || trim(coalesce(v_pro.first_name, '') || ' ' || coalesce(v_pro.last_name, ''))
        || ' was cancelled.',
      jsonb_build_object('request_id', p_request_id)
    );
  end if;

  return v_result;
end;
$$;

-- Grants unchanged — same signature, CREATE OR REPLACE preserves existing
-- grants on the function's own OID.

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration is created
-- in this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- Every object here is drop-safe independently and in either order:
--
-- 1. Restore cancel_member_reservation/admin_cancel_reservation_v2/
--    cancel_lesson to their pre-0186 bodies (0185 / 0132 / 0185
--    respectively) — remove the payment-lock/Checkout-guard/uncollected-
--    balance-release/refund-request blocks and cancellation_policy_state
--    from each UPDATE and audit_log metadata; restore admin_cancel_
--    reservation_v2's reservation lookup to unlocked; restore the
--    original `cancellation_window_closed`/`within_cancellation_window`
--    raises. Same signatures throughout.
--
-- 2. Restore reject_refund_request/_complete_refund_request_for_attempt
--    to their pre-0186 (0181) bodies — the single unconditional
--    requested_by notification, no beneficiary branch. Same signatures.
--
-- 3. Restore get_online_refundable_amount_for_payments to its pre-0186
--    (0157) body — the full query inline, no delegation. Same signature.
--
-- 4. Drop the new private functions, once nothing calls them:
--    `drop function if exists public._ensure_policy_cancellation_refund_request(uuid, uuid, uuid, text);`
--    `drop function if exists public._release_uncollected_cancellation_balance(uuid, uuid, uuid);`
--    `drop function if exists public._compute_online_refundable_amounts(uuid, uuid[]);`
--
-- 5. `alter table public.payment_refund_requests drop column if exists policy_refundable_cents_at_cancellation;`
--    `alter table public.payment_refund_requests drop column if exists beneficiary_user_id;`
--    `alter table public.payment_refund_requests drop column if exists source;`
--    `alter table public.lesson_requests drop column if exists cancellation_policy_state;`
--    `alter table public.reservations drop column if exists cancellation_policy_state;`
--
-- Data impact: any payment_refund_requests row created by this migration's
-- helper, any payment_events void_payment_obligation/waived row this
-- migration's uncollected-balance helper inserted, remains a completely
-- normal, valid row after rollback — none of it depends on the dropped
-- columns to remain internally consistent (the payments rollup trigger
-- reads only event_type/amount_cents, never the columns this rollback
-- drops). Any reservation/lesson cancelled while this migration was live
-- remains cancelled after rollback. No payment/payment_events row this
-- migration writes ever needs to be reversed for correctness — voiding/
-- waiving an uncollected balance and requesting a refund of collected
-- money are both normal, valid financial history after the fact.
