-- 0151_stale_checkout_invalidation.sql
-- Phase 34E-A — Payment Lifecycle Resilience: Stale Checkout Prevention.
--
-- ── The problem (34E audit, section B.3 / C.3) ───────────────────────────
-- A Stripe Checkout Session bound to a payment_checkout_attempts row
-- (0150) remains genuinely payable at its own Stripe-hosted URL for as
-- long as Stripe itself reports it 'open' — a local mutation that changes
-- what that Session was FOR (the remaining balance, the payment's
-- resolution, or its payer identity) does not, by itself, invalidate that
-- URL. If an Admin/Staff action resolves a payment locally (records a
-- manual payment, waives/voids the balance, refunds retained money,
-- reverses an event, or edits a priced reservation/lesson's court/
-- duration/Member) while a Member's Checkout tab is still open, the
-- Member can complete a Stripe payment that no longer corresponds to
-- reality — Court Time must never lose that real money (process_stripe_
-- payment_event, 0150, already guarantees it is recorded regardless — see
-- that function's own header comment), but it should not have been
-- allowed to happen in the first place when it was preventable.
--
-- ── The fix: PRE-MUTATION invalidation, not post-mutation cleanup ───────
-- Every mutation capable of changing amount_due_cents, amount_paid_cents,
-- or status on an existing payments row already acquires a `for update`
-- lock on that row before making its change (established canonical lock
-- order, 0150). This migration inserts one call — public._invalidate_or_
-- flag_open_checkout_attempt(payment_id) (section 1) — immediately after
-- that lock in each such mutation RPC, BEFORE the mutation itself:
--
--   * no open attempt for this payment           -> proceeds silently.
--   * an open attempt with NO bound Stripe Session yet (a concurrent
--     Checkout-creation call is mid-flight — the "unbound race" the 34E
--     audit specifically flagged, section "IMPORTANT RACE TO CLOSE") ->
--     canceled right here, in the SAME transaction as the caller's own
--     mutation. record_checkout_session_created (0150) already fails
--     loudly (checkout_attempt_not_open) if that concurrent flow later
--     tries to bind a Session onto this now-canceled row — the Member's
--     in-flight Pay Now click safely requires a retry, exactly as the
--     34E-A spec allows ("A successfully expired Checkout may safely
--     require the Member to click Pay Now again").
--   * an open attempt WITH a bound Stripe Session -> Postgres cannot
--     itself call Stripe, so this raises open_checkout_requires_
--     resolution, rolling back the caller's ENTIRE mutation before any
--     local financial change is applied ("fail closed BEFORE applying
--     the competing local financial mutation" per the 34E-A spec). The
--     calling Server Action catches this specific error, resolves the
--     remote Session via Stripe using the two new service-role RPCs in
--     section 2 (mirroring 0150's open_payment_checkout_attempt /
--     supersede_checkout_attempt_and_open_fresh two-call handshake
--     exactly), then safely retries the ORIGINAL mutation RPC call —
--     which this time finds no blocking attempt and proceeds normally,
--     applying the local mutation and the attempt invalidation together,
--     atomically, in one transaction.
--
-- If Stripe reports the old Session already 'complete' (a real payment
-- processing or finished), the Server Action never calls either new RPC
-- and never retries the mutation — it surfaces a clear, non-destructive
-- error and leaves both Court Time and Stripe exactly as they were,
-- letting the existing exactly-once webhook reconciliation (0150,
-- unchanged) finish the job. If Stripe cannot be safely queried or
-- expired, the Server Action likewise never retries — fails closed.
--
-- ── Call-site inventory (34E-A audit, section A) ─────────────────────────
-- Every RPC that can insert a payment_events row against an EXISTING
-- payment (as opposed to _create_payment_obligation's own fresh-row
-- insert, which can never have a pre-existing attempt) drives
-- _recompute_payment_rollup (0143) and is therefore a candidate. That is
-- exactly five 0143 RPCs plus the price-adjustment branch of two 0144
-- RPCs — reproduced below via CREATE OR REPLACE, each with ONE new line
-- added and NOTHING else changed:
--   record_manual_payment, waive_payment, void_payment_obligation,
--   record_refund, reverse_payment_event (0143)
--   update_member_reservation, admin_update_member_lesson (0144) — only
--   the price-changing/member-reassignment edit branch is guarded; every
--   other check, computation, and side effect in these two functions is
--   byte-identical to the currently-applied 0144 text.
--
-- Member reassignment itself (_check_member_reassignment_allowed, 0143)
-- needs no independent guard: it already requires the current obligation
-- cycle to be resolved with zero retained money (amount_due_cents = 0
-- and amount_paid_cents = 0, or a terminal status with amount_paid_cents
-- = 0) before reassignment may proceed — a state only reachable once any
-- open Checkout attempt for that cycle has ALREADY been invalidated by
-- one of the mutations this migration guards (a waive/void/refund/price-
-- adjustment-to-zero). The guard below is still called unconditionally
-- alongside a member-reassignment edit in both 0144 RPCs, purely as
-- defense in depth — never because reassignment is independently
-- reachable while a live attempt exists.
--
-- create_reservation, admin_create_member_reservation, admin_create_
-- member_lesson, accept_lesson_proposal, join_event, admin_add_roster_
-- participant, admin_add_guest, accept_waitlist_offer, admin_force_
-- confirm, admin_force_confirm_roster_participant, join_program, add_
-- program_member, add_program_roster_member, accept_program_waitlist_
-- offer, force_confirm_program_roster_member (all 0144) call ONLY _create_
-- payment_obligation in NORMAL (non-reassignment) mode on a domain row
-- that, by construction, has no prior payment at all or reuses an
-- unchanged obligation — none of these ever change amount_due_cents/
-- amount_paid_cents/status on an EXISTING attempt-bearing payment, so none
-- require this guard. process_stripe_payment_event (0150) is the
-- webhook-driven reconciliation path itself — it must never be blocked by
-- its own guard.
--
-- ── Scope discipline ──────────────────────────────────────────────────
-- No new table, no new column, no widened CHECK constraint. payment_
-- checkout_attempts' existing status vocabulary ('open', 'completed',
-- 'expired', 'canceled') already covers every state this migration needs
-- — 'canceled' for the unbound race (matching open_payment_checkout_
-- attempt's own existing use of 'canceled' for the identical case),
-- 'expired' for a confirmed-dead bound Session (matching supersede_
-- checkout_attempt_and_open_fresh's own existing use of 'expired' for the
-- identical case). Refunds, disputes, and the reactive "payment received
-- after resolution" review UI remain out of scope (34E-B/C/D).
--
-- Apply in Supabase SQL Editor (cloud only).

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Internal helper — _invalidate_or_flag_open_checkout_attempt
-- ═══════════════════════════════════════════════════════════════════════════
-- Not granted to any role (revoke all from public, below) — callable only
-- from within another SECURITY DEFINER function in this schema, exactly
-- like _create_payment_obligation / _adjust_payment_obligation / _check_
-- member_reassignment_allowed (0143). Assumes the caller already holds a
-- `for update` lock on the target payments row (canonical lock order,
-- payments -> payment_checkout_attempts, 0150) — this function only ever
-- locks payment_checkout_attempts, never payments itself.
create or replace function public._invalidate_or_flag_open_checkout_attempt(p_payment_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_attempt public.payment_checkout_attempts%rowtype;
begin
  select * into v_attempt
    from public.payment_checkout_attempts
   where payment_id = p_payment_id and status = 'open'
   for update;

  if not found then
    return;
  end if;

  if v_attempt.stripe_checkout_session_id is null then
    -- No remote Stripe artifact exists yet — nothing could still be
    -- payable. Safe to invalidate right here, in the caller's own
    -- transaction alongside its real mutation.
    update public.payment_checkout_attempts
       set status = 'canceled', updated_at = now()
     where id = v_attempt.id;
    return;
  end if;

  -- A bound Session may still be genuinely payable at Stripe. Postgres
  -- cannot itself resolve that — raise so the caller's ENTIRE mutation
  -- rolls back before any competing local financial change is applied.
  raise exception 'open_checkout_requires_resolution';
end;
$$;

revoke all on function public._invalidate_or_flag_open_checkout_attempt(uuid) from public;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2a. get_blocking_checkout_attempt_for_payment — service-role-only, read-only
-- ═══════════════════════════════════════════════════════════════════════════
-- Called by a Server Action immediately after its own mutation RPC raised
-- open_checkout_requires_resolution, to fetch the Stripe identity of the
-- attempt it must resolve via Stripe before safely retrying. Mutates
-- nothing. Returns zero rows if the blocking attempt was somehow already
-- resolved between the two calls (race-safe: the caller simply retries
-- the original mutation directly in that case).
create or replace function public.get_blocking_checkout_attempt_for_payment(
  p_payment_id uuid,
  p_club_id    uuid
)
returns table (
  id                          uuid,
  stripe_account_id           text,
  livemode                    boolean,
  stripe_checkout_session_id  text
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if p_payment_id is null or p_club_id is null then
    raise exception 'invalid_arguments';
  end if;

  return query
    select a.id, a.stripe_account_id, a.livemode, a.stripe_checkout_session_id
      from public.payment_checkout_attempts a
     where a.payment_id = p_payment_id
       and a.club_id    = p_club_id
       and a.status     = 'open'
       and a.stripe_checkout_session_id is not null;
end;
$$;

revoke execute on function public.get_blocking_checkout_attempt_for_payment(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.get_blocking_checkout_attempt_for_payment(uuid, uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2b. expire_blocking_checkout_attempt — service-role-only
-- ═══════════════════════════════════════════════════════════════════════════
-- Called ONLY after the Server Action has independently confirmed via
-- Stripe (in the blocking attempt's own stored stripe_account_id/livemode
-- context) that its bound Session is no longer payable — either Stripe
-- reported it already 'expired', or the Server Action actively expired an
-- 'open' one through Stripe first.
--
-- Re-reads the attempt under a fresh lock and branches on its CURRENT
-- status (correction pass — a prior revision of this function treated
-- every non-'open' status identically as 'already_completed', which
-- wrongly blocked the caller's mutation even when the attempt was merely
-- already 'expired' or 'canceled" by some other safe path):
--   'open'      -> Stripe has just been confirmed to no longer consider
--                  this Session payable; mark the attempt 'expired' here
--                  and return action='proceed'.
--   'expired'   -> already dead (e.g. a concurrent resolution flow, or
--                  the unbound-race cancellation in _invalidate_or_flag_
--                  open_checkout_attempt got there first) — nothing to
--                  mutate, action='proceed'. Never re-marks it 'expired'
--                  a second time.
--   'canceled'  -> same reasoning as 'expired' — action='proceed'.
--   'completed' -> Stripe has genuinely collected real money against
--                  this attempt (the webhook reconciled it during the
--                  round-trip) — action='already_completed', mutates
--                  NOTHING. The caller must stop and let that state
--                  stand rather than let its competing local mutation
--                  proceed against money Stripe just collected. NEVER
--                  overwritten with 'expired'.
-- Canonical lock order (payments -> payment_checkout_attempts), matching
-- every other attempt-mutating RPC in 0150.
create or replace function public.expire_blocking_checkout_attempt(
  p_attempt_id uuid,
  p_payment_id uuid,
  p_club_id    uuid
)
returns table (action text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_payment public.payments%rowtype;
  v_attempt public.payment_checkout_attempts%rowtype;
begin
  if p_attempt_id is null or p_payment_id is null or p_club_id is null then
    raise exception 'invalid_arguments';
  end if;

  select * into v_payment
    from public.payments p
   where p.id = p_payment_id and p.club_id = p_club_id
   for update;
  if not found then
    raise exception 'payment_not_found';
  end if;

  select * into v_attempt
    from public.payment_checkout_attempts a
   where a.id = p_attempt_id and a.payment_id = p_payment_id
   for update;
  if not found then
    raise exception 'checkout_attempt_not_found';
  end if;

  if v_attempt.status = 'completed' then
    -- Real money was genuinely collected against this attempt — never
    -- overwritten, never treated the same as a merely-dead Session.
    return query select 'already_completed'::text;
    return;
  end if;

  if v_attempt.status in ('expired', 'canceled') then
    -- Already dead via some other safe path — nothing to mutate, safe
    -- for the caller to proceed with its local mutation.
    return query select 'proceed'::text;
    return;
  end if;

  -- v_attempt.status = 'open' — Stripe has just been confirmed to no
  -- longer consider this Session payable; mark it expired now.
  update public.payment_checkout_attempts a
     set status = 'expired', updated_at = now()
   where a.id = v_attempt.id;

  return query select 'proceed'::text;
end;
$$;

revoke execute on function public.expire_blocking_checkout_attempt(uuid, uuid, uuid) from public, anon, authenticated;
grant  execute on function public.expire_blocking_checkout_attempt(uuid, uuid, uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. record_manual_payment — CREATE OR REPLACE, ONE new line
-- ═══════════════════════════════════════════════════════════════════════════
-- Delta from 0143: perform public._invalidate_or_flag_open_checkout_
-- attempt(p_payment_id) immediately after the payment lock/found check.
-- Everything else byte-identical to the currently-applied 0143 text.
create or replace function public.record_manual_payment(
  p_payment_id         uuid,
  p_amount_cents       integer,
  p_method             text,
  p_occurred_at        timestamptz default now(),
  p_external_reference text default null,
  p_notes              text default null
)
returns public.payments
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_payment public.payments%rowtype;
  v_result  public.payments%rowtype;
begin
  v_club_id := public.current_user_club_id();
  v_role    := public.current_user_role();
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;

  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'invalid_payment_amount';
  end if;
  if p_method not in ('cash', 'check', 'card_terminal', 'bank_transfer', 'digital_wallet', 'other') then
    raise exception 'invalid_payment_method';
  end if;

  select * into v_payment from public.payments where id = p_payment_id and club_id = v_club_id for update;
  if not found then raise exception 'payment_not_found'; end if;

  if v_payment.status not in ('unpaid', 'partially_paid')
     or v_payment.amount_due_cents <= 0
     or v_payment.amount_due_cents <= v_payment.amount_paid_cents
  then
    raise exception 'payment_not_open_for_payment';
  end if;

  -- Phase 34E-A (correction pass): pre-mutation Stripe Checkout
  -- invalidation. Runs only after every local validation above has
  -- passed — an invalid request (bad amount/method, or a payment not
  -- open for payment) must never expire a legitimate Stripe Checkout
  -- Session before Court Time even knows the requested local action
  -- would fail.
  perform public._invalidate_or_flag_open_checkout_attempt(p_payment_id);

  insert into public.payment_events (
    payment_id, club_id, event_type, amount_cents, method, external_reference, notes, actor_id, occurred_at
  ) values (
    p_payment_id, v_club_id, 'manual_payment_recorded', p_amount_cents, p_method, p_external_reference, p_notes,
    auth.uid(), coalesce(p_occurred_at, now())
  );

  select * into v_result from public.payments where id = p_payment_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (v_club_id, auth.uid(), 'record_manual_payment', 'payment', p_payment_id,
    jsonb_build_object('amount_cents', p_amount_cents, 'method', p_method));

  return v_result;
end;
$$;

revoke execute on function public.record_manual_payment(uuid, integer, text, timestamptz, text, text) from public, anon;
grant  execute on function public.record_manual_payment(uuid, integer, text, timestamptz, text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. record_refund — CREATE OR REPLACE, ONE new line
-- ═══════════════════════════════════════════════════════════════════════════
-- Delta from 0143: perform public._invalidate_or_flag_open_checkout_
-- attempt(p_payment_id) immediately after the payment lock/found check.
-- Everything else byte-identical to the currently-applied 0143 text. Not
-- yet reachable from any Server Action (34E audit, section A) — this
-- guard is added now as defense in depth ahead of 34E-B wiring it up.
create or replace function public.record_refund(
  p_payment_id         uuid,
  p_amount_cents       integer,
  p_method             text default null,
  p_occurred_at        timestamptz default now(),
  p_external_reference text default null,
  p_notes              text default null
)
returns public.payments
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_payment public.payments%rowtype;
  v_result  public.payments%rowtype;
begin
  v_club_id := public.current_user_club_id();
  v_role    := public.current_user_role();
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role <> 'admin' then raise exception 'insufficient_role'; end if;

  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'invalid_refund_amount';
  end if;
  if p_method is not null and p_method not in ('cash', 'check', 'card_terminal', 'bank_transfer', 'digital_wallet', 'other') then
    raise exception 'invalid_payment_method';
  end if;

  select * into v_payment from public.payments where id = p_payment_id and club_id = v_club_id for update;
  if not found then raise exception 'payment_not_found'; end if;

  if p_amount_cents > v_payment.amount_paid_cents then
    raise exception 'refund_exceeds_amount_paid';
  end if;

  -- Phase 34E-A (correction pass): pre-mutation Stripe Checkout
  -- invalidation. Runs only after the refund-amount validation above has
  -- passed — an invalid refund request must never expire a legitimate
  -- Stripe Checkout Session before Court Time even knows the requested
  -- local action would fail.
  perform public._invalidate_or_flag_open_checkout_attempt(p_payment_id);

  insert into public.payment_events (
    payment_id, club_id, event_type, amount_cents, method, external_reference, notes, actor_id, occurred_at
  ) values (
    p_payment_id, v_club_id, 'refund_recorded', p_amount_cents, p_method, p_external_reference, p_notes,
    auth.uid(), coalesce(p_occurred_at, now())
  );

  select * into v_result from public.payments where id = p_payment_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (v_club_id, auth.uid(), 'record_refund', 'payment', p_payment_id,
    jsonb_build_object('amount_cents', p_amount_cents));

  return v_result;
end;
$$;

revoke execute on function public.record_refund(uuid, integer, text, timestamptz, text, text) from public, anon;
grant  execute on function public.record_refund(uuid, integer, text, timestamptz, text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. reverse_payment_event — CREATE OR REPLACE, ONE new line
-- ═══════════════════════════════════════════════════════════════════════════
-- Delta from 0143: perform public._invalidate_or_flag_open_checkout_
-- attempt(v_target.payment_id) immediately after the payment lock.
-- Everything else byte-identical to the currently-applied 0143 text. Not
-- yet reachable from any Server Action (34E audit, section A) — this
-- guard is added now as defense in depth ahead of 34E-B wiring it up.
create or replace function public.reverse_payment_event(p_event_id uuid, p_reason text default null)
returns public.payments
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_target  public.payment_events%rowtype;
  v_payment public.payments%rowtype;
  v_result  public.payments%rowtype;
begin
  v_club_id := public.current_user_club_id();
  v_role    := public.current_user_role();
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role <> 'admin' then raise exception 'insufficient_role'; end if;

  select * into v_target from public.payment_events where id = p_event_id and club_id = v_club_id;
  if not found then raise exception 'reversal_target_not_found'; end if;

  if v_target.event_type not in ('manual_payment_recorded', 'refund_recorded') then
    raise exception 'event_type_not_reversible';
  end if;

  select * into v_payment from public.payments where id = v_target.payment_id for update;

  if v_target.event_type = 'manual_payment_recorded' and v_target.amount_cents > v_payment.amount_paid_cents then
    raise exception 'reversal_would_make_net_negative';
  end if;

  -- Phase 34E-A (correction pass): pre-mutation Stripe Checkout
  -- invalidation. Runs only after the net-negative validation above has
  -- passed — an invalid reversal request must never expire a legitimate
  -- Stripe Checkout Session before Court Time even knows the requested
  -- local action would fail.
  perform public._invalidate_or_flag_open_checkout_attempt(v_target.payment_id);

  insert into public.payment_events (payment_id, club_id, event_type, reverses_event_id, notes, actor_id)
  values (v_target.payment_id, v_club_id, 'reverse_payment_event', p_event_id, p_reason, auth.uid());
  -- The BEFORE-INSERT trigger (0143 section 4) re-validates target existence,
  -- same-payment, and reversibility; the partial unique index (0143 section 3)
  -- rejects a second reversal of the same event.

  select * into v_result from public.payments where id = v_target.payment_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (v_club_id, auth.uid(), 'reverse_payment_event', 'payment_event', p_event_id,
    jsonb_build_object('payment_id', v_target.payment_id, 'reason', p_reason));

  return v_result;
end;
$$;

revoke execute on function public.reverse_payment_event(uuid, text) from public, anon;
grant  execute on function public.reverse_payment_event(uuid, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. waive_payment — CREATE OR REPLACE, ONE new line
-- ═══════════════════════════════════════════════════════════════════════════
-- Delta from 0143: perform public._invalidate_or_flag_open_checkout_
-- attempt(p_payment_id) immediately after the payment lock/found check.
-- Everything else byte-identical to the currently-applied 0143 text. Not
-- yet reachable from any Server Action (34E audit, section A) — this
-- guard is added now as defense in depth ahead of 34E-B/D wiring it up.
create or replace function public.waive_payment(p_payment_id uuid, p_reason text default null)
returns public.payments
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id  uuid;
  v_role     text;
  v_payment  public.payments%rowtype;
  v_remaining integer;
  v_result   public.payments%rowtype;
begin
  v_club_id := public.current_user_club_id();
  v_role    := public.current_user_role();
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role <> 'admin' then raise exception 'insufficient_role'; end if;

  select * into v_payment from public.payments where id = p_payment_id and club_id = v_club_id for update;
  if not found then raise exception 'payment_not_found'; end if;

  if v_payment.status not in ('unpaid', 'partially_paid') then
    raise exception 'payment_not_open_for_waiver';
  end if;

  v_remaining := v_payment.amount_due_cents - v_payment.amount_paid_cents;
  if v_remaining <= 0 then
    raise exception 'no_balance_to_waive';
  end if;

  -- Phase 34E-A (correction pass): pre-mutation Stripe Checkout
  -- invalidation. Runs only after the status/remaining-balance validation
  -- above has passed — an invalid waiver request must never expire a
  -- legitimate Stripe Checkout Session before Court Time even knows the
  -- requested local action would fail.
  perform public._invalidate_or_flag_open_checkout_attempt(p_payment_id);

  insert into public.payment_events (payment_id, club_id, event_type, amount_cents, notes, actor_id)
  values (p_payment_id, v_club_id, 'waived', v_remaining, p_reason, auth.uid());

  select * into v_result from public.payments where id = p_payment_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (v_club_id, auth.uid(), 'waive_payment', 'payment', p_payment_id,
    jsonb_build_object('amount_waived_cents', v_remaining, 'reason', p_reason));

  return v_result;
end;
$$;

revoke execute on function public.waive_payment(uuid, text) from public, anon;
grant  execute on function public.waive_payment(uuid, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. void_payment_obligation — CREATE OR REPLACE, ONE new line
-- ═══════════════════════════════════════════════════════════════════════════
-- Delta from 0143: perform public._invalidate_or_flag_open_checkout_
-- attempt(p_payment_id) immediately after the payment lock/found check.
-- Everything else byte-identical to the currently-applied 0143 text. Not
-- yet reachable from any Server Action (34E audit, section A) — this
-- guard is added now as defense in depth ahead of 34E-B/D wiring it up.
create or replace function public.void_payment_obligation(p_payment_id uuid, p_reason text default null)
returns public.payments
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_payment public.payments%rowtype;
  v_result  public.payments%rowtype;
begin
  v_club_id := public.current_user_club_id();
  v_role    := public.current_user_role();
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role <> 'admin' then raise exception 'insufficient_role'; end if;

  select * into v_payment from public.payments where id = p_payment_id and club_id = v_club_id for update;
  if not found then raise exception 'payment_not_found'; end if;

  if v_payment.status <> 'unpaid' then
    raise exception 'payment_not_open_for_void';
  end if;

  if v_payment.amount_paid_cents <> 0 then
    raise exception 'cannot_void_with_retained_payment';
  end if;

  if v_payment.amount_due_cents <= 0 then
    raise exception 'no_balance_to_void';
  end if;

  -- Phase 34E-A (correction pass): pre-mutation Stripe Checkout
  -- invalidation. Runs only after every status/amount validation above
  -- has passed — an invalid void request must never expire a legitimate
  -- Stripe Checkout Session before Court Time even knows the requested
  -- local action would fail.
  perform public._invalidate_or_flag_open_checkout_attempt(p_payment_id);

  insert into public.payment_events (payment_id, club_id, event_type, amount_cents, notes, actor_id)
  values (p_payment_id, v_club_id, 'void_payment_obligation', v_payment.amount_due_cents, p_reason, auth.uid());

  select * into v_result from public.payments where id = p_payment_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (v_club_id, auth.uid(), 'void_payment_obligation', 'payment', p_payment_id,
    jsonb_build_object('amount_voided_cents', v_payment.amount_due_cents, 'reason', p_reason));

  return v_result;
end;
$$;

revoke execute on function public.void_payment_obligation(uuid, text) from public, anon;
grant  execute on function public.void_payment_obligation(uuid, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. update_member_reservation — CREATE OR REPLACE, ONE new guarded block
-- ═══════════════════════════════════════════════════════════════════════════
-- Delta from 0144: a new v_payment_id_for_checkout_guard declaration, and,
-- immediately before the mutating UPDATE, whenever this edit is about to
-- change the priced amount OR reassign the Member (the same two
-- conditions the existing post-mutation payment-wiring block below already
-- keys off), the current obligation cycle's payment_id is resolved and
-- locked and public._invalidate_or_flag_open_checkout_attempt is called.
-- Everything else — every check, computation, mutation, and side effect —
-- is byte-identical to the currently-applied 0144 text.
create or replace function public.update_member_reservation(p_reservation_id uuid, p_expected_club_id uuid, p_expected_updated_at timestamp with time zone, p_court_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_roster_member_id uuid, p_format text DEFAULT NULL::text, p_player_count integer DEFAULT NULL::integer, p_guest_names text[] DEFAULT NULL::text[], p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id             uuid;
  v_role                text;
  v_before               reservations%rowtype;
  v_after                reservations%rowtype;
  v_court                courts%rowtype;
  v_tz                   text;
  v_date                 date;
  v_dow                  int;
  v_override             operating_hours_override%rowtype;
  v_hours                operating_hours%rowtype;
  v_scheduling_changed   boolean;
  v_changed_fields       text[] := '{}';
  v_notification_id      uuid;
  v_roster               public.roster_members%rowtype;
  v_member_changed       boolean;
  v_new_owner_id         uuid;
  -- Phase 34B: reservation-edit pricing invariants.
  v_settings             public.club_settings%rowtype;
  v_court_changed        boolean;
  v_duration_changed     boolean;
  v_new_hourly_rate_cents  integer;
  v_new_price_amount_cents integer;
  -- Phase 34E-A: pre-mutation Stripe Checkout invalidation.
  v_payment_id_for_checkout_guard uuid;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;

  if p_court_id is null then raise exception 'invalid_court'; end if;
  if p_starts_at is null or p_ends_at is null then raise exception 'invalid_duration'; end if;

  select * into v_before
    from reservations
    where id = p_reservation_id and club_id = v_club_id
    for update;
  if not found then raise exception 'reservation_not_found'; end if;

  if v_before.reason <> 'member_booking' then raise exception 'reservation_not_editable'; end if;
  if v_before.status <> 'confirmed' then raise exception 'reservation_not_editable'; end if;

  if v_before.starts_at <= now() then raise exception 'cannot_edit_started_reservation'; end if;

  if v_before.updated_at is distinct from p_expected_updated_at then
    raise exception 'stale_edit_conflict';
  end if;

  if p_starts_at <= now() then raise exception 'cannot_book_past'; end if;
  if p_ends_at <= p_starts_at then raise exception 'invalid_duration'; end if;

  if p_roster_member_id is null then
    raise exception 'roster_identity_required';
  end if;

  v_member_changed := p_roster_member_id is distinct from v_before.roster_member_id;

  if v_member_changed then
    select * into v_roster
      from public.roster_members
     where id      = p_roster_member_id
       and club_id = v_club_id;
    if not found then raise exception 'roster_member_not_found'; end if;
    v_new_owner_id := v_roster.claimed_by;
  else
    v_new_owner_id := v_before.owner_user_id;
  end if;

  -- Phase 34C: a reassignment must not silently abandon or transfer an
  -- unresolved obligation. Checked before any mutation below.
  if v_member_changed then
    perform public._check_member_reassignment_allowed(v_club_id, 'reservation', p_reservation_id);
  end if;

  v_scheduling_changed :=
    p_court_id  is distinct from v_before.court_id
    or p_starts_at is distinct from v_before.starts_at
    or p_ends_at   is distinct from v_before.ends_at;

  if v_scheduling_changed then
    select * into v_court
      from courts
      where id = p_court_id and club_id = v_club_id and is_active = true;
    if not found then raise exception 'invalid_court'; end if;

    if extract(epoch from (p_ends_at - p_starts_at)) / 60 not in (30, 60, 90, 120) then
      raise exception 'invalid_duration';
    end if;

    select timezone into v_tz from clubs where id = v_club_id;

    v_date := (p_starts_at at time zone v_tz)::date;
    v_dow  := extract(dow from p_starts_at at time zone v_tz)::int;

    select * into v_override
      from operating_hours_override
      where club_id = v_club_id and override_date = v_date;

    if found then
      if v_override.is_closed then
        raise exception 'club_closed_this_day';
      end if;
      if v_override.opens_at is not null and v_override.closes_at is not null then
        if (p_starts_at at time zone v_tz)::time < v_override.opens_at
           or (p_ends_at at time zone v_tz)::time > v_override.closes_at then
          raise exception 'outside_operating_hours';
        end if;
      end if;
    else
      select * into v_hours
        from operating_hours
        where club_id = v_club_id and day_of_week = v_dow;

      if not found or v_hours.is_closed then
        raise exception 'club_closed_this_day';
      end if;

      if (p_starts_at at time zone v_tz)::time < v_hours.opens_at
         or (p_ends_at at time zone v_tz)::time > v_hours.closes_at then
        raise exception 'outside_operating_hours';
      end if;
    end if;
  end if;

  -- Phase 34B: reservation-edit pricing invariants — see this function's
  -- own header comment above for the full A/B/C rule statement.
  v_court_changed    := p_court_id is distinct from v_before.court_id;
  v_duration_changed := (p_ends_at - p_starts_at) is distinct from (v_before.ends_at - v_before.starts_at);

  if v_court_changed then
    select * into v_settings from public.club_settings where club_id = v_club_id;
    v_new_hourly_rate_cents := coalesce(v_court.hourly_rate_cents, v_settings.default_court_hourly_rate_cents);
    if v_new_hourly_rate_cents is not null then
      v_new_price_amount_cents := round(v_new_hourly_rate_cents * extract(epoch from (p_ends_at - p_starts_at)) / 3600.0)::integer;
    else
      v_new_price_amount_cents := null;
    end if;
  elsif v_duration_changed then
    v_new_hourly_rate_cents := v_before.hourly_rate_cents;
    if v_new_hourly_rate_cents is not null then
      v_new_price_amount_cents := round(v_new_hourly_rate_cents * extract(epoch from (p_ends_at - p_starts_at)) / 3600.0)::integer;
    else
      v_new_price_amount_cents := null;
    end if;
  else
    v_new_hourly_rate_cents  := v_before.hourly_rate_cents;
    v_new_price_amount_cents := v_before.price_amount_cents;
  end if;

  -- Phase 34E-A: pre-mutation Stripe Checkout invalidation. Runs BEFORE
  -- the reservation UPDATE below whenever this edit is about to change
  -- the priced amount or reassign the Member — see this migration's own
  -- header comment for why reassignment needs no independent guard
  -- beyond this (it is included here purely as defense in depth).
  if v_member_changed or v_new_price_amount_cents is distinct from v_before.price_amount_cents then
    select id into v_payment_id_for_checkout_guard
      from public.payments
     where club_id = v_club_id and domain_type = 'reservation' and domain_id = p_reservation_id
     order by obligation_cycle desc
     limit 1
     for update;
    if v_payment_id_for_checkout_guard is not null then
      perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);
    end if;
  end if;

  if p_court_id is distinct from v_before.court_id then
    v_changed_fields := array_append(v_changed_fields, 'court_id');
  end if;
  if p_starts_at is distinct from v_before.starts_at then
    v_changed_fields := array_append(v_changed_fields, 'starts_at');
  end if;
  if p_ends_at is distinct from v_before.ends_at then
    v_changed_fields := array_append(v_changed_fields, 'ends_at');
  end if;
  if v_member_changed then
    v_changed_fields := array_append(v_changed_fields, 'roster_member_id');
  end if;
  if p_format is distinct from v_before.format then
    v_changed_fields := array_append(v_changed_fields, 'format');
  end if;
  if p_player_count is distinct from v_before.player_count then
    v_changed_fields := array_append(v_changed_fields, 'player_count');
  end if;
  if p_guest_names is distinct from v_before.guest_names then
    v_changed_fields := array_append(v_changed_fields, 'guest_names');
  end if;
  if p_notes is distinct from v_before.notes then
    v_changed_fields := array_append(v_changed_fields, 'notes');
  end if;
  if v_new_hourly_rate_cents is distinct from v_before.hourly_rate_cents then
    v_changed_fields := array_append(v_changed_fields, 'hourly_rate_cents');
  end if;
  if v_new_price_amount_cents is distinct from v_before.price_amount_cents then
    v_changed_fields := array_append(v_changed_fields, 'price_amount_cents');
  end if;

  if array_length(v_changed_fields, 1) is null then
    return jsonb_build_object(
      'reservation',     to_jsonb(v_before),
      'changed_fields',  to_jsonb(v_changed_fields),
      'notification_id', null
    );
  end if;

  update reservations set
    court_id          = p_court_id,
    starts_at         = p_starts_at,
    ends_at           = p_ends_at,
    roster_member_id  = p_roster_member_id,
    owner_user_id     = v_new_owner_id,
    format            = p_format,
    player_count      = p_player_count,
    guest_names       = p_guest_names,
    notes             = p_notes,
    hourly_rate_cents  = v_new_hourly_rate_cents,
    price_amount_cents = v_new_price_amount_cents,
    updated_at        = now()
  where id = p_reservation_id
  returning * into v_after;

  -- Phase 34C: payment wiring, after the mutation, using the final v_after
  -- state. Member reassignment always gets an explicit new cycle for the
  -- new Member (liable party changed is independently material); otherwise
  -- a price change adjusts the current cycle (if any) and ensures one
  -- exists. NULL is deliberately left unadjusted — a price becoming fully
  -- unpriced does not automatically touch an existing obligation; that
  -- remains an explicit Admin financial-resolution action.
  --
  -- Phase 34C (lifecycle correction): p_roster_member_id is now passed
  -- into _adjust_payment_obligation as the CURRENT identity — the latest
  -- payment cycle can belong to a PRIOR Member if this row was safely
  -- reassigned while unpriced (no positive obligation was created at that
  -- reassignment), and a later price edit must never silently adjust that
  -- prior Member's historical cycle. The helper no-ops on a mismatch;
  -- the following _create_payment_obligation call (NORMAL mode) then
  -- correctly allocates a fresh cycle for the current Member instead of
  -- reusing the mismatched one.
  if v_member_changed then
    perform public._create_payment_obligation(
      v_club_id, 'reservation', p_reservation_id, p_roster_member_id,
      v_new_price_amount_cents, auth.uid(), true
    );
  elsif v_new_price_amount_cents is distinct from v_before.price_amount_cents then
    if v_new_price_amount_cents is not null then
      perform public._adjust_payment_obligation(v_club_id, 'reservation', p_reservation_id, p_roster_member_id, v_new_price_amount_cents, auth.uid());
    end if;
    perform public._create_payment_obligation(
      v_club_id, 'reservation', p_reservation_id, p_roster_member_id,
      v_new_price_amount_cents, auth.uid()
    );
  end if;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id,
    auth.uid(),
    'update_member_reservation',
    'reservation',
    p_reservation_id,
    jsonb_build_object(
      'owner_user_id',     v_before.owner_user_id,
      'changed_fields',    v_changed_fields,
      'member_reassigned', v_member_changed,
      'before', jsonb_build_object(
        'court_id',         v_before.court_id,
        'starts_at',        v_before.starts_at,
        'ends_at',          v_before.ends_at,
        'format',           v_before.format,
        'player_count',     v_before.player_count,
        'guest_names',      v_before.guest_names,
        'notes',            v_before.notes,
        'roster_member_id', v_before.roster_member_id,
        'owner_user_id',    v_before.owner_user_id,
        'hourly_rate_cents', v_before.hourly_rate_cents,
        'price_amount_cents', v_before.price_amount_cents
      ),
      'after', jsonb_build_object(
        'court_id',         v_after.court_id,
        'starts_at',        v_after.starts_at,
        'ends_at',          v_after.ends_at,
        'format',           v_after.format,
        'player_count',     v_after.player_count,
        'guest_names',      v_after.guest_names,
        'notes',            v_after.notes,
        'roster_member_id', v_after.roster_member_id,
        'owner_user_id',    v_after.owner_user_id,
        'hourly_rate_cents', v_after.hourly_rate_cents,
        'price_amount_cents', v_after.price_amount_cents
      )
    )
  );

  v_notification_id := null;

  if v_scheduling_changed and v_after.owner_user_id is not null then
    if v_tz is null then
      select timezone into v_tz from clubs where id = v_club_id;
    end if;

    insert into notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id,
      v_after.owner_user_id,
      'reservation_rescheduled',
      'Your booking was moved to ' || v_court.name || ' on '
        || to_char(v_after.starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM')
        || ' – ' || to_char(v_after.ends_at at time zone v_tz, 'HH12:MI AM') || '.',
      jsonb_build_object('reservation_id', v_after.id, 'court_id', v_after.court_id)
    )
    returning id into v_notification_id;
  end if;

  return jsonb_build_object(
    'reservation',     to_jsonb(v_after),
    'changed_fields',  to_jsonb(v_changed_fields),
    'notification_id', v_notification_id
  );
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 9. admin_update_member_lesson — CREATE OR REPLACE, ONE new guarded block
-- ═══════════════════════════════════════════════════════════════════════════
-- Delta from 0144: a new v_payment_id_for_checkout_guard declaration, and,
-- immediately after the existing _check_member_reassignment_allowed call
-- (before any mutation), whenever this edit is about to reassign the
-- Member OR change the priced amount (the same two conditions the
-- existing post-mutation payment-wiring block below already keys off),
-- the current obligation cycle's payment_id is resolved and locked and
-- public._invalidate_or_flag_open_checkout_attempt is called. Everything
-- else — every check, computation, mutation, and side effect — is
-- byte-identical to the currently-applied 0144 text.
create or replace function public.admin_update_member_lesson(p_request_id uuid, p_expected_club_id uuid, p_expected_updated_at timestamp with time zone, p_roster_member_id uuid, p_pro_id uuid, p_court_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_lesson_type_id uuid DEFAULT NULL::uuid, p_member_note text DEFAULT NULL::text)
 RETURNS lesson_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id           uuid;
  v_role              text;
  v_before            public.lesson_requests%rowtype;
  v_old_reservation   public.reservations%rowtype;
  v_roster            public.roster_members%rowtype;
  v_member_id         uuid;
  v_pro               public.profiles%rowtype;
  v_duration_minutes  int;
  v_tz                text;
  v_scheduling_changed boolean;
  v_member_changed     boolean;
  v_pro_changed        boolean;
  v_res_id             uuid;
  v_member_name        text;
  v_result             public.lesson_requests%rowtype;
  -- FINAL LESSON PRICING REFINEMENT: lesson-type-change re-snapshot, plus
  -- duration-only recompute for an hourly-priced Lesson whose type is
  -- unchanged.
  v_lesson_type_changed boolean;
  v_duration_changed     boolean;
  v_pricing_basis            text;
  v_unit_price_amount_cents  integer;
  v_price_amount_cents       integer;
  -- Phase 34E-A: pre-mutation Stripe Checkout invalidation.
  v_payment_id_for_checkout_guard uuid;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is null or v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;

  select * into v_before
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  if v_before.status <> 'confirmed' then raise exception 'invalid_status_for_edit'; end if;
  if v_before.updated_at is distinct from p_expected_updated_at then raise exception 'stale_edit_conflict'; end if;
  if v_before.linked_reservation_id is null then raise exception 'linked_reservation_not_found'; end if;

  select * into v_old_reservation
    from public.reservations
   where id      = v_before.linked_reservation_id
     and club_id = v_club_id
     and reason  = 'pro_lesson'
     and status  = 'confirmed'
   for update;
  if not found then raise exception 'linked_reservation_not_found'; end if;

  if v_old_reservation.starts_at <= now() then
    raise exception 'cannot_reschedule_started_lesson';
  end if;

  -- Resolve and validate the (possibly reassigned) target roster Member.
  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_club_id;
  if not found then raise exception 'roster_member_not_found'; end if;

  v_member_id   := v_roster.claimed_by;
  v_member_name := trim(coalesce(v_roster.first_name, '') || ' ' || coalesce(v_roster.last_name, ''));

  -- Validate (possibly reassigned) pro.
  select * into v_pro
    from public.profiles
   where id                 = p_pro_id
     and club_id            = v_club_id
     and status              = 'active'
     and role                in ('pro', 'admin', 'staff')
     and is_lesson_provider  = true;
  if not found then raise exception 'pro_not_found'; end if;

  if v_member_id is not null and v_member_id = p_pro_id then
    raise exception 'cannot_request_yourself';
  end if;

  if p_starts_at < now() then raise exception 'cannot_propose_past_time'; end if;
  if p_ends_at  <= p_starts_at then raise exception 'invalid_duration'; end if;

  v_duration_minutes := round(extract(epoch from (p_ends_at - p_starts_at)) / 60)::int;
  if v_duration_minutes < 30 or v_duration_minutes % 15 <> 0 then
    raise exception 'invalid_duration';
  end if;

  if not exists (
    select 1 from public.courts
     where id        = p_court_id
       and club_id   = v_club_id
       and is_active = true
  ) then
    raise exception 'court_not_found';
  end if;

  if p_lesson_type_id is not null then
    if not exists (
      select 1 from public.lesson_types lt
       where lt.id        = p_lesson_type_id
         and lt.club_id   = v_club_id
         and lt.is_active = true
    ) then
      raise exception 'lesson_type_not_found';
    end if;

    if exists (
      select 1 from public.lesson_types lt
       where lt.id               = p_lesson_type_id
         and lt.allowed_durations is not null
         and array_length(lt.allowed_durations, 1) > 0
         and not (v_duration_minutes = any(lt.allowed_durations))
    ) then
      raise exception 'duration_not_allowed_for_type';
    end if;
  end if;

  -- FINAL LESSON PRICING REFINEMENT — full A/B/C-style edit invariants:
  --
  --  * lesson_type_id UNCHANGED, duration UNCHANGED (time/court/provider/
  --    member-only edits): preserve pricing_basis, unit price, and total
  --    exactly.
  --  * lesson_type_id UNCHANGED, duration CHANGED: preserve the existing
  --    pricing_basis + unit price snapshot. flat -> total stays exactly
  --    what it was (a flat Lesson price does not scale with duration).
  --    hourly -> recompute total from the PRESERVED unit rate times the
  --    NEW duration. A NULL preserved unit price always keeps the total
  --    NULL — never silently adopt today's Lesson Type rate merely because
  --    an existing Lesson's duration changed.
  --  * lesson_type_id CHANGES: snapshot the NEW type's CURRENT
  --    pricing_basis + unit price, and calculate a fresh total from the
  --    Lesson's current (possibly also-changed) duration — changing what
  --    is priced re-resolves from its current configuration, exactly like
  --    the reservation court-change rule. Changing to no Lesson Type at
  --    all (NULL) clears all three snapshot fields to NULL.
  v_lesson_type_changed := p_lesson_type_id is distinct from v_before.lesson_type_id;
  v_duration_changed    := v_duration_minutes is distinct from v_before.duration_minutes;

  if v_lesson_type_changed then
    if p_lesson_type_id is not null then
      select pricing_basis, unit_price_amount_cents
        into v_pricing_basis, v_unit_price_amount_cents
        from public.lesson_types where id = p_lesson_type_id;

      if v_pricing_basis = 'hourly' then
        if v_unit_price_amount_cents is not null then
          v_price_amount_cents := round(v_unit_price_amount_cents * v_duration_minutes / 60.0)::integer;
        else
          v_price_amount_cents := null;
        end if;
      else
        v_price_amount_cents := v_unit_price_amount_cents;
      end if;
    else
      v_pricing_basis           := null;
      v_unit_price_amount_cents := null;
      v_price_amount_cents      := null;
    end if;
  else
    v_pricing_basis           := v_before.pricing_basis;
    v_unit_price_amount_cents := v_before.unit_price_amount_cents;

    if v_duration_changed and v_pricing_basis = 'hourly' and v_unit_price_amount_cents is not null then
      v_price_amount_cents := round(v_unit_price_amount_cents * v_duration_minutes / 60.0)::integer;
    else
      v_price_amount_cents := v_before.price_amount_cents;
    end if;
  end if;

  if length(p_member_note) > 500 then raise exception 'note_too_long'; end if;

  v_scheduling_changed := (p_court_id, p_starts_at, p_ends_at)
    is distinct from (v_old_reservation.court_id, v_old_reservation.starts_at, v_old_reservation.ends_at);
  v_member_changed := p_roster_member_id is distinct from v_before.roster_member_id;
  v_pro_changed     := p_pro_id is distinct from v_before.pro_id;

  -- Phase 34C: a reassignment must not silently abandon or transfer an
  -- unresolved obligation. Checked before any mutation below.
  if v_member_changed then
    perform public._check_member_reassignment_allowed(v_club_id, 'lesson_request', p_request_id);
  end if;

  select timezone into v_tz from public.clubs where id = v_club_id;

  if v_scheduling_changed or v_pro_changed then

    -- Phase 33E3 fix: court-conflict pre-check, excluding this lesson's
    -- own currently-linked reservation — mirrors propose_lesson_time's
    -- already-live pattern. Without this, a genuine court double-book was
    -- only ever caught by the raw GiST EXCLUDE constraint on reservations,
    -- whose untranslated error text mapLessonError() cannot match, so the
    -- UI showed a generic "Something went wrong" instead of the friendly,
    -- already-mapped court_conflict message.
    if exists (
      select 1 from public.reservations r
       where r.court_id = p_court_id
         and r.status   in ('pending', 'confirmed')
         and tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')
         and r.id is distinct from v_old_reservation.id
    ) then
      raise exception 'court_conflict';
    end if;

    -- Time and/or pro changed — re-validate operating hours / pro /
    -- member conflicts, excluding this lesson's own still-active
    -- reservation, exactly like a self-service reschedule. Member check
    -- is unconditional (correction pass — see admin_create_member_
    -- lesson's header note above); p_roster_member_id always supplied.
    perform public._lesson_check_operating_hours(v_club_id, p_starts_at, p_ends_at, v_tz);
    perform public._lesson_check_pro_availability(p_pro_id, p_starts_at, p_ends_at, p_request_id);
    perform public._lesson_check_member_availability(v_member_id, p_roster_member_id, p_starts_at, p_ends_at, p_request_id);
  end if;

  -- Phase 34E-A (correction pass): pre-mutation Stripe Checkout
  -- invalidation. Moved here, AFTER every validation above (including the
  -- scheduling-conflict/operating-hours/pro/member-availability checks
  -- just above, which the original 34E-A placement ran BEFORE — an
  -- invalid edit that would go on to fail court_conflict or an
  -- availability check must never expire a legitimate Stripe Checkout
  -- Session first), but still strictly BEFORE any local mutation
  -- (reservation soft-cancel/insert/update, lesson_requests UPDATE)
  -- below. Runs whenever this edit is about to reassign the Member or
  -- change the priced amount — see this migration's own header comment
  -- for why reassignment needs no independent guard beyond this (it is
  -- included here purely as defense in depth).
  if v_member_changed or v_price_amount_cents is distinct from v_before.price_amount_cents then
    select id into v_payment_id_for_checkout_guard
      from public.payments
     where club_id = v_club_id and domain_type = 'lesson_request' and domain_id = p_request_id
     order by obligation_cycle desc
     limit 1
     for update;
    if v_payment_id_for_checkout_guard is not null then
      perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);
    end if;
  end if;

  if v_scheduling_changed then
    -- Soft-cancel the old reservation and insert a new one — mirrors
    -- accept_lesson_proposal's own reschedule pattern exactly. The new
    -- row's created_by is this admin: it is a genuinely new row, not a
    -- rewrite of the old one's created_by (which stays untouched on the
    -- now-cancelled row).
    update public.reservations
       set status            = 'cancelled',
           cancelled_at      = now(),
           cancelled_by      = auth.uid(),
           cancellation_kind = 'system',
           updated_at        = now()
     where id = v_old_reservation.id;

    insert into public.reservations (
      club_id, court_id, owner_user_id, roster_member_id,
      starts_at, ends_at, status, reason,
      notes, show_notes_to_members, created_by
    ) values (
      v_club_id, p_court_id, p_pro_id, p_roster_member_id,
      p_starts_at, p_ends_at, 'confirmed', 'pro_lesson',
      'Pro lesson with ' || v_member_name,
      false,
      auth.uid()
    ) returning id into v_res_id;
  elsif v_member_changed or v_pro_changed then
    -- Nothing time-related changed — update the existing reservation row
    -- directly in place (no history-losing replace) rather than the
    -- soft-cancel-and-reinsert pattern above, which is reserved for an
    -- actual scheduling change.
    update public.reservations
       set owner_user_id    = p_pro_id,
           roster_member_id = p_roster_member_id,
           notes            = 'Pro lesson with ' || v_member_name,
           updated_at       = now()
     where id = v_old_reservation.id;
    v_res_id := v_old_reservation.id;
  else
    v_res_id := v_old_reservation.id;
  end if;

  update public.lesson_requests
     set roster_member_id    = p_roster_member_id,
         member_id           = v_member_id,
         pro_id              = p_pro_id,
         duration_minutes    = v_duration_minutes,
         member_note         = btrim(coalesce(p_member_note, '')),
         lesson_type_id      = p_lesson_type_id,
         proposed_starts_at  = p_starts_at,
         proposed_ends_at    = p_ends_at,
         proposed_court_id   = p_court_id,
         linked_reservation_id = v_res_id,
         last_actor_id       = auth.uid(),
         last_actor_role     = v_role,
         pricing_basis           = v_pricing_basis,
         unit_price_amount_cents = v_unit_price_amount_cents,
         price_amount_cents      = v_price_amount_cents,
         updated_at          = now()
   where id = p_request_id
  returning * into v_result;

  -- Phase 34C: payment wiring, after the mutation, mirroring
  -- update_member_reservation's rule exactly, including the Phase 34C
  -- lifecycle correction: p_roster_member_id is passed as the CURRENT
  -- identity into _adjust_payment_obligation, which no-ops if the latest
  -- cycle belongs to a prior Member (reassigned while unpriced) rather
  -- than silently adjusting their historical payment. Member reassignment
  -- always gets an explicit new cycle for the new Member; otherwise a
  -- price change adjusts the current cycle (if any, and if the new total
  -- is not NULL) and ensures one exists.
  if v_member_changed then
    perform public._create_payment_obligation(
      v_club_id, 'lesson_request', p_request_id, p_roster_member_id,
      v_price_amount_cents, auth.uid(), true
    );
  elsif v_price_amount_cents is distinct from v_before.price_amount_cents then
    if v_price_amount_cents is not null then
      perform public._adjust_payment_obligation(v_club_id, 'lesson_request', p_request_id, p_roster_member_id, v_price_amount_cents, auth.uid());
    end if;
    perform public._create_payment_obligation(
      v_club_id, 'lesson_request', p_request_id, p_roster_member_id,
      v_price_amount_cents, auth.uid()
    );
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'admin_update_member_lesson', 'lesson_request', p_request_id,
    jsonb_build_object(
      'before', jsonb_build_object(
        'roster_member_id', v_before.roster_member_id,
        'member_id',        v_before.member_id,
        'pro_id',           v_before.pro_id,
        'court_id',         v_old_reservation.court_id,
        'starts_at',        v_old_reservation.starts_at,
        'ends_at',          v_old_reservation.ends_at,
        'lesson_type_id',   v_before.lesson_type_id,
        'pricing_basis',    v_before.pricing_basis,
        'unit_price_amount_cents', v_before.unit_price_amount_cents,
        'price_amount_cents', v_before.price_amount_cents
      ),
      'after', jsonb_build_object(
        'roster_member_id', p_roster_member_id,
        'member_id',        v_member_id,
        'pro_id',           p_pro_id,
        'court_id',         p_court_id,
        'starts_at',        p_starts_at,
        'ends_at',          p_ends_at,
        'lesson_type_id',   p_lesson_type_id,
        'pricing_basis',    v_pricing_basis,
        'unit_price_amount_cents', v_unit_price_amount_cents,
        'price_amount_cents', v_price_amount_cents
      ),
      'scheduling_changed', v_scheduling_changed,
      'member_changed',     v_member_changed,
      'pro_changed',        v_pro_changed,
      'lesson_type_changed', v_lesson_type_changed,
      'duration_changed',    v_duration_changed,
      'reservation_id',     v_res_id,
      'old_reservation_id', case when v_scheduling_changed then v_old_reservation.id else null end
    )
  );

  -- Notify pro — always, when the pro or the schedule changed (always has
  -- an account). Notify member only if claimed and something material
  -- changed. Reuses the existing lesson_request_confirmed kind — no new
  -- notification kind is introduced.
  if v_scheduling_changed or v_pro_changed then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id, p_pro_id, 'lesson_request_confirmed',
      'Lesson with ' || v_member_name || ' updated — now ' ||
        to_char(p_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM') || '.',
      jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id)
    );
  end if;

  if v_member_id is not null and (v_scheduling_changed or v_pro_changed or v_member_changed) then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id, v_member_id, 'lesson_request_confirmed',
      'Your lesson with ' ||
        trim(coalesce(v_pro.first_name, '') || ' ' || coalesce(v_pro.last_name, '')) ||
        ' is confirmed for ' || to_char(p_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM') || '.',
      jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id)
    );
  end if;

  return v_result;
end;
$function$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback (manual, cloud SQL Editor) — every statement below is the exact,
-- genuinely executable pre-0151 (0143/0144) text, extracted verbatim from
-- those migration files' own currently-applied text (sed line-range
-- extraction, not retyped), never a placeholder. Uncomment and run
-- top-to-bottom if 0151 must be reverted after being applied. update_member_
-- reservation and admin_update_member_lesson carry no revoke/grant lines
-- here, matching 0144's own text — neither migration touches their
-- permissions, which were established by an earlier migration and are left
-- untouched by CREATE OR REPLACE.
-- ═══════════════════════════════════════════════════════════════════════════
-- begin;
--
-- drop function if exists public.get_blocking_checkout_attempt_for_payment(uuid, uuid);
-- drop function if exists public.expire_blocking_checkout_attempt(uuid, uuid, uuid);
-- drop function if exists public._invalidate_or_flag_open_checkout_attempt(uuid);
--
-- create or replace function public.record_manual_payment(
--   p_payment_id         uuid,
--   p_amount_cents       integer,
--   p_method             text,
--   p_occurred_at        timestamptz default now(),
--   p_external_reference text default null,
--   p_notes              text default null
-- )
-- returns public.payments
-- language plpgsql
-- security definer
-- set search_path to 'public', 'pg_temp'
-- as $$
-- declare
--   v_club_id uuid;
--   v_role    text;
--   v_payment public.payments%rowtype;
--   v_result  public.payments%rowtype;
-- begin
--   v_club_id := public.current_user_club_id();
--   v_role    := public.current_user_role();
--   if v_club_id is null then raise exception 'not_authenticated'; end if;
--   if v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;
--
--   if p_amount_cents is null or p_amount_cents <= 0 then
--     raise exception 'invalid_payment_amount';
--   end if;
--   if p_method not in ('cash', 'check', 'card_terminal', 'bank_transfer', 'digital_wallet', 'other') then
--     raise exception 'invalid_payment_method';
--   end if;
--
--   select * into v_payment from public.payments where id = p_payment_id and club_id = v_club_id for update;
--   if not found then raise exception 'payment_not_found'; end if;
--
--   if v_payment.status not in ('unpaid', 'partially_paid')
--      or v_payment.amount_due_cents <= 0
--      or v_payment.amount_due_cents <= v_payment.amount_paid_cents
--   then
--     raise exception 'payment_not_open_for_payment';
--   end if;
--
--   insert into public.payment_events (
--     payment_id, club_id, event_type, amount_cents, method, external_reference, notes, actor_id, occurred_at
--   ) values (
--     p_payment_id, v_club_id, 'manual_payment_recorded', p_amount_cents, p_method, p_external_reference, p_notes,
--     auth.uid(), coalesce(p_occurred_at, now())
--   );
--
--   select * into v_result from public.payments where id = p_payment_id;
--
--   insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
--   values (v_club_id, auth.uid(), 'record_manual_payment', 'payment', p_payment_id,
--     jsonb_build_object('amount_cents', p_amount_cents, 'method', p_method));
--
--   return v_result;
-- end;
-- $$;
--
-- revoke execute on function public.record_manual_payment(uuid, integer, text, timestamptz, text, text) from public, anon;
-- grant  execute on function public.record_manual_payment(uuid, integer, text, timestamptz, text, text) to authenticated;
--
-- create or replace function public.record_refund(
--   p_payment_id         uuid,
--   p_amount_cents       integer,
--   p_method             text default null,
--   p_occurred_at        timestamptz default now(),
--   p_external_reference text default null,
--   p_notes              text default null
-- )
-- returns public.payments
-- language plpgsql
-- security definer
-- set search_path to 'public', 'pg_temp'
-- as $$
-- declare
--   v_club_id uuid;
--   v_role    text;
--   v_payment public.payments%rowtype;
--   v_result  public.payments%rowtype;
-- begin
--   v_club_id := public.current_user_club_id();
--   v_role    := public.current_user_role();
--   if v_club_id is null then raise exception 'not_authenticated'; end if;
--   if v_role <> 'admin' then raise exception 'insufficient_role'; end if;
--
--   if p_amount_cents is null or p_amount_cents <= 0 then
--     raise exception 'invalid_refund_amount';
--   end if;
--   if p_method is not null and p_method not in ('cash', 'check', 'card_terminal', 'bank_transfer', 'digital_wallet', 'other') then
--     raise exception 'invalid_payment_method';
--   end if;
--
--   select * into v_payment from public.payments where id = p_payment_id and club_id = v_club_id for update;
--   if not found then raise exception 'payment_not_found'; end if;
--
--   if p_amount_cents > v_payment.amount_paid_cents then
--     raise exception 'refund_exceeds_amount_paid';
--   end if;
--
--   insert into public.payment_events (
--     payment_id, club_id, event_type, amount_cents, method, external_reference, notes, actor_id, occurred_at
--   ) values (
--     p_payment_id, v_club_id, 'refund_recorded', p_amount_cents, p_method, p_external_reference, p_notes,
--     auth.uid(), coalesce(p_occurred_at, now())
--   );
--
--   select * into v_result from public.payments where id = p_payment_id;
--
--   insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
--   values (v_club_id, auth.uid(), 'record_refund', 'payment', p_payment_id,
--     jsonb_build_object('amount_cents', p_amount_cents));
--
--   return v_result;
-- end;
-- $$;
--
-- revoke execute on function public.record_refund(uuid, integer, text, timestamptz, text, text) from public, anon;
-- grant  execute on function public.record_refund(uuid, integer, text, timestamptz, text, text) to authenticated;
--
-- create or replace function public.reverse_payment_event(p_event_id uuid, p_reason text default null)
-- returns public.payments
-- language plpgsql
-- security definer
-- set search_path to 'public', 'pg_temp'
-- as $$
-- declare
--   v_club_id uuid;
--   v_role    text;
--   v_target  public.payment_events%rowtype;
--   v_payment public.payments%rowtype;
--   v_result  public.payments%rowtype;
-- begin
--   v_club_id := public.current_user_club_id();
--   v_role    := public.current_user_role();
--   if v_club_id is null then raise exception 'not_authenticated'; end if;
--   if v_role <> 'admin' then raise exception 'insufficient_role'; end if;
--
--   select * into v_target from public.payment_events where id = p_event_id and club_id = v_club_id;
--   if not found then raise exception 'reversal_target_not_found'; end if;
--
--   if v_target.event_type not in ('manual_payment_recorded', 'refund_recorded') then
--     raise exception 'event_type_not_reversible';
--   end if;
--
--   select * into v_payment from public.payments where id = v_target.payment_id for update;
--
--   if v_target.event_type = 'manual_payment_recorded' and v_target.amount_cents > v_payment.amount_paid_cents then
--     raise exception 'reversal_would_make_net_negative';
--   end if;
--
--   insert into public.payment_events (payment_id, club_id, event_type, reverses_event_id, notes, actor_id)
--   values (v_target.payment_id, v_club_id, 'reverse_payment_event', p_event_id, p_reason, auth.uid());
--   -- The BEFORE-INSERT trigger (section 4) re-validates target existence,
--   -- same-payment, and reversibility; the partial unique index (section 3)
--   -- rejects a second reversal of the same event.
--
--   select * into v_result from public.payments where id = v_target.payment_id;
--
--   insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
--   values (v_club_id, auth.uid(), 'reverse_payment_event', 'payment_event', p_event_id,
--     jsonb_build_object('payment_id', v_target.payment_id, 'reason', p_reason));
--
--   return v_result;
-- end;
-- $$;
--
-- revoke execute on function public.reverse_payment_event(uuid, text) from public, anon;
-- grant  execute on function public.reverse_payment_event(uuid, text) to authenticated;
--
-- create or replace function public.waive_payment(p_payment_id uuid, p_reason text default null)
-- returns public.payments
-- language plpgsql
-- security definer
-- set search_path to 'public', 'pg_temp'
-- as $$
-- declare
--   v_club_id  uuid;
--   v_role     text;
--   v_payment  public.payments%rowtype;
--   v_remaining integer;
--   v_result   public.payments%rowtype;
-- begin
--   v_club_id := public.current_user_club_id();
--   v_role    := public.current_user_role();
--   if v_club_id is null then raise exception 'not_authenticated'; end if;
--   if v_role <> 'admin' then raise exception 'insufficient_role'; end if;
--
--   select * into v_payment from public.payments where id = p_payment_id and club_id = v_club_id for update;
--   if not found then raise exception 'payment_not_found'; end if;
--
--   if v_payment.status not in ('unpaid', 'partially_paid') then
--     raise exception 'payment_not_open_for_waiver';
--   end if;
--
--   v_remaining := v_payment.amount_due_cents - v_payment.amount_paid_cents;
--   if v_remaining <= 0 then
--     raise exception 'no_balance_to_waive';
--   end if;
--
--   insert into public.payment_events (payment_id, club_id, event_type, amount_cents, notes, actor_id)
--   values (p_payment_id, v_club_id, 'waived', v_remaining, p_reason, auth.uid());
--
--   select * into v_result from public.payments where id = p_payment_id;
--
--   insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
--   values (v_club_id, auth.uid(), 'waive_payment', 'payment', p_payment_id,
--     jsonb_build_object('amount_waived_cents', v_remaining, 'reason', p_reason));
--
--   return v_result;
-- end;
-- $$;
--
-- revoke execute on function public.waive_payment(uuid, text) from public, anon;
-- grant  execute on function public.waive_payment(uuid, text) to authenticated;
--
-- create or replace function public.void_payment_obligation(p_payment_id uuid, p_reason text default null)
-- returns public.payments
-- language plpgsql
-- security definer
-- set search_path to 'public', 'pg_temp'
-- as $$
-- declare
--   v_club_id uuid;
--   v_role    text;
--   v_payment public.payments%rowtype;
--   v_result  public.payments%rowtype;
-- begin
--   v_club_id := public.current_user_club_id();
--   v_role    := public.current_user_role();
--   if v_club_id is null then raise exception 'not_authenticated'; end if;
--   if v_role <> 'admin' then raise exception 'insufficient_role'; end if;
--
--   select * into v_payment from public.payments where id = p_payment_id and club_id = v_club_id for update;
--   if not found then raise exception 'payment_not_found'; end if;
--
--   if v_payment.status <> 'unpaid' then
--     raise exception 'payment_not_open_for_void';
--   end if;
--
--   if v_payment.amount_paid_cents <> 0 then
--     raise exception 'cannot_void_with_retained_payment';
--   end if;
--
--   if v_payment.amount_due_cents <= 0 then
--     raise exception 'no_balance_to_void';
--   end if;
--
--   insert into public.payment_events (payment_id, club_id, event_type, amount_cents, notes, actor_id)
--   values (p_payment_id, v_club_id, 'void_payment_obligation', v_payment.amount_due_cents, p_reason, auth.uid());
--
--   select * into v_result from public.payments where id = p_payment_id;
--
--   insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
--   values (v_club_id, auth.uid(), 'void_payment_obligation', 'payment', p_payment_id,
--     jsonb_build_object('amount_voided_cents', v_payment.amount_due_cents, 'reason', p_reason));
--
--   return v_result;
-- end;
-- $$;
--
-- revoke execute on function public.void_payment_obligation(uuid, text) from public, anon;
-- grant  execute on function public.void_payment_obligation(uuid, text) to authenticated;
--
-- CREATE OR REPLACE FUNCTION public.update_member_reservation(p_reservation_id uuid, p_expected_club_id uuid, p_expected_updated_at timestamp with time zone, p_court_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_roster_member_id uuid, p_format text DEFAULT NULL::text, p_player_count integer DEFAULT NULL::integer, p_guest_names text[] DEFAULT NULL::text[], p_notes text DEFAULT NULL::text)
--  RETURNS jsonb
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public', 'pg_temp'
-- AS $function$
-- declare
--   v_club_id             uuid;
--   v_role                text;
--   v_before               reservations%rowtype;
--   v_after                reservations%rowtype;
--   v_court                courts%rowtype;
--   v_tz                   text;
--   v_date                 date;
--   v_dow                  int;
--   v_override             operating_hours_override%rowtype;
--   v_hours                operating_hours%rowtype;
--   v_scheduling_changed   boolean;
--   v_changed_fields       text[] := '{}';
--   v_notification_id      uuid;
--   v_roster               public.roster_members%rowtype;
--   v_member_changed       boolean;
--   v_new_owner_id         uuid;
--   -- Phase 34B: reservation-edit pricing invariants.
--   v_settings             public.club_settings%rowtype;
--   v_court_changed        boolean;
--   v_duration_changed     boolean;
--   v_new_hourly_rate_cents  integer;
--   v_new_price_amount_cents integer;
-- begin
--   select public.current_user_club_id(), public.current_user_role()
--     into v_club_id, v_role;
--
--   if v_club_id is null then raise exception 'not_authenticated'; end if;
--   if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
--   if v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;
--
--   if p_court_id is null then raise exception 'invalid_court'; end if;
--   if p_starts_at is null or p_ends_at is null then raise exception 'invalid_duration'; end if;
--
--   select * into v_before
--     from reservations
--     where id = p_reservation_id and club_id = v_club_id
--     for update;
--   if not found then raise exception 'reservation_not_found'; end if;
--
--   if v_before.reason <> 'member_booking' then raise exception 'reservation_not_editable'; end if;
--   if v_before.status <> 'confirmed' then raise exception 'reservation_not_editable'; end if;
--
--   if v_before.starts_at <= now() then raise exception 'cannot_edit_started_reservation'; end if;
--
--   if v_before.updated_at is distinct from p_expected_updated_at then
--     raise exception 'stale_edit_conflict';
--   end if;
--
--   if p_starts_at <= now() then raise exception 'cannot_book_past'; end if;
--   if p_ends_at <= p_starts_at then raise exception 'invalid_duration'; end if;
--
--   if p_roster_member_id is null then
--     raise exception 'roster_identity_required';
--   end if;
--
--   v_member_changed := p_roster_member_id is distinct from v_before.roster_member_id;
--
--   if v_member_changed then
--     select * into v_roster
--       from public.roster_members
--      where id      = p_roster_member_id
--        and club_id = v_club_id;
--     if not found then raise exception 'roster_member_not_found'; end if;
--     v_new_owner_id := v_roster.claimed_by;
--   else
--     v_new_owner_id := v_before.owner_user_id;
--   end if;
--
--   -- Phase 34C: a reassignment must not silently abandon or transfer an
--   -- unresolved obligation. Checked before any mutation below.
--   if v_member_changed then
--     perform public._check_member_reassignment_allowed(v_club_id, 'reservation', p_reservation_id);
--   end if;
--
--   v_scheduling_changed :=
--     p_court_id  is distinct from v_before.court_id
--     or p_starts_at is distinct from v_before.starts_at
--     or p_ends_at   is distinct from v_before.ends_at;
--
--   if v_scheduling_changed then
--     select * into v_court
--       from courts
--       where id = p_court_id and club_id = v_club_id and is_active = true;
--     if not found then raise exception 'invalid_court'; end if;
--
--     if extract(epoch from (p_ends_at - p_starts_at)) / 60 not in (30, 60, 90, 120) then
--       raise exception 'invalid_duration';
--     end if;
--
--     select timezone into v_tz from clubs where id = v_club_id;
--
--     v_date := (p_starts_at at time zone v_tz)::date;
--     v_dow  := extract(dow from p_starts_at at time zone v_tz)::int;
--
--     select * into v_override
--       from operating_hours_override
--       where club_id = v_club_id and override_date = v_date;
--
--     if found then
--       if v_override.is_closed then
--         raise exception 'club_closed_this_day';
--       end if;
--       if v_override.opens_at is not null and v_override.closes_at is not null then
--         if (p_starts_at at time zone v_tz)::time < v_override.opens_at
--            or (p_ends_at at time zone v_tz)::time > v_override.closes_at then
--           raise exception 'outside_operating_hours';
--         end if;
--       end if;
--     else
--       select * into v_hours
--         from operating_hours
--         where club_id = v_club_id and day_of_week = v_dow;
--
--       if not found or v_hours.is_closed then
--         raise exception 'club_closed_this_day';
--       end if;
--
--       if (p_starts_at at time zone v_tz)::time < v_hours.opens_at
--          or (p_ends_at at time zone v_tz)::time > v_hours.closes_at then
--         raise exception 'outside_operating_hours';
--       end if;
--     end if;
--   end if;
--
--   -- Phase 34B: reservation-edit pricing invariants — see this function's
--   -- own header comment above for the full A/B/C rule statement.
--   v_court_changed    := p_court_id is distinct from v_before.court_id;
--   v_duration_changed := (p_ends_at - p_starts_at) is distinct from (v_before.ends_at - v_before.starts_at);
--
--   if v_court_changed then
--     select * into v_settings from public.club_settings where club_id = v_club_id;
--     v_new_hourly_rate_cents := coalesce(v_court.hourly_rate_cents, v_settings.default_court_hourly_rate_cents);
--     if v_new_hourly_rate_cents is not null then
--       v_new_price_amount_cents := round(v_new_hourly_rate_cents * extract(epoch from (p_ends_at - p_starts_at)) / 3600.0)::integer;
--     else
--       v_new_price_amount_cents := null;
--     end if;
--   elsif v_duration_changed then
--     v_new_hourly_rate_cents := v_before.hourly_rate_cents;
--     if v_new_hourly_rate_cents is not null then
--       v_new_price_amount_cents := round(v_new_hourly_rate_cents * extract(epoch from (p_ends_at - p_starts_at)) / 3600.0)::integer;
--     else
--       v_new_price_amount_cents := null;
--     end if;
--   else
--     v_new_hourly_rate_cents  := v_before.hourly_rate_cents;
--     v_new_price_amount_cents := v_before.price_amount_cents;
--   end if;
--
--   if p_court_id is distinct from v_before.court_id then
--     v_changed_fields := array_append(v_changed_fields, 'court_id');
--   end if;
--   if p_starts_at is distinct from v_before.starts_at then
--     v_changed_fields := array_append(v_changed_fields, 'starts_at');
--   end if;
--   if p_ends_at is distinct from v_before.ends_at then
--     v_changed_fields := array_append(v_changed_fields, 'ends_at');
--   end if;
--   if v_member_changed then
--     v_changed_fields := array_append(v_changed_fields, 'roster_member_id');
--   end if;
--   if p_format is distinct from v_before.format then
--     v_changed_fields := array_append(v_changed_fields, 'format');
--   end if;
--   if p_player_count is distinct from v_before.player_count then
--     v_changed_fields := array_append(v_changed_fields, 'player_count');
--   end if;
--   if p_guest_names is distinct from v_before.guest_names then
--     v_changed_fields := array_append(v_changed_fields, 'guest_names');
--   end if;
--   if p_notes is distinct from v_before.notes then
--     v_changed_fields := array_append(v_changed_fields, 'notes');
--   end if;
--   if v_new_hourly_rate_cents is distinct from v_before.hourly_rate_cents then
--     v_changed_fields := array_append(v_changed_fields, 'hourly_rate_cents');
--   end if;
--   if v_new_price_amount_cents is distinct from v_before.price_amount_cents then
--     v_changed_fields := array_append(v_changed_fields, 'price_amount_cents');
--   end if;
--
--   if array_length(v_changed_fields, 1) is null then
--     return jsonb_build_object(
--       'reservation',     to_jsonb(v_before),
--       'changed_fields',  to_jsonb(v_changed_fields),
--       'notification_id', null
--     );
--   end if;
--
--   update reservations set
--     court_id          = p_court_id,
--     starts_at         = p_starts_at,
--     ends_at           = p_ends_at,
--     roster_member_id  = p_roster_member_id,
--     owner_user_id     = v_new_owner_id,
--     format            = p_format,
--     player_count      = p_player_count,
--     guest_names       = p_guest_names,
--     notes             = p_notes,
--     hourly_rate_cents  = v_new_hourly_rate_cents,
--     price_amount_cents = v_new_price_amount_cents,
--     updated_at        = now()
--   where id = p_reservation_id
--   returning * into v_after;
--
--   -- Phase 34C: payment wiring, after the mutation, using the final v_after
--   -- state. Member reassignment always gets an explicit new cycle for the
--   -- new Member (liable party changed is independently material); otherwise
--   -- a price change adjusts the current cycle (if any) and ensures one
--   -- exists. NULL is deliberately left unadjusted — a price becoming fully
--   -- unpriced does not automatically touch an existing obligation; that
--   -- remains an explicit Admin financial-resolution action.
--   --
--   -- Phase 34C (lifecycle correction): p_roster_member_id is now passed
--   -- into _adjust_payment_obligation as the CURRENT identity — the latest
--   -- payment cycle can belong to a PRIOR Member if this row was safely
--   -- reassigned while unpriced (no positive obligation was created at that
--   -- reassignment), and a later price edit must never silently adjust that
--   -- prior Member's historical cycle. The helper no-ops on a mismatch;
--   -- the following _create_payment_obligation call (NORMAL mode) then
--   -- correctly allocates a fresh cycle for the current Member instead of
--   -- reusing the mismatched one.
--   if v_member_changed then
--     perform public._create_payment_obligation(
--       v_club_id, 'reservation', p_reservation_id, p_roster_member_id,
--       v_new_price_amount_cents, auth.uid(), true
--     );
--   elsif v_new_price_amount_cents is distinct from v_before.price_amount_cents then
--     if v_new_price_amount_cents is not null then
--       perform public._adjust_payment_obligation(v_club_id, 'reservation', p_reservation_id, p_roster_member_id, v_new_price_amount_cents, auth.uid());
--     end if;
--     perform public._create_payment_obligation(
--       v_club_id, 'reservation', p_reservation_id, p_roster_member_id,
--       v_new_price_amount_cents, auth.uid()
--     );
--   end if;
--
--   insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
--   values (
--     v_club_id,
--     auth.uid(),
--     'update_member_reservation',
--     'reservation',
--     p_reservation_id,
--     jsonb_build_object(
--       'owner_user_id',     v_before.owner_user_id,
--       'changed_fields',    v_changed_fields,
--       'member_reassigned', v_member_changed,
--       'before', jsonb_build_object(
--         'court_id',         v_before.court_id,
--         'starts_at',        v_before.starts_at,
--         'ends_at',          v_before.ends_at,
--         'format',           v_before.format,
--         'player_count',     v_before.player_count,
--         'guest_names',      v_before.guest_names,
--         'notes',            v_before.notes,
--         'roster_member_id', v_before.roster_member_id,
--         'owner_user_id',    v_before.owner_user_id,
--         'hourly_rate_cents', v_before.hourly_rate_cents,
--         'price_amount_cents', v_before.price_amount_cents
--       ),
--       'after', jsonb_build_object(
--         'court_id',         v_after.court_id,
--         'starts_at',        v_after.starts_at,
--         'ends_at',          v_after.ends_at,
--         'format',           v_after.format,
--         'player_count',     v_after.player_count,
--         'guest_names',      v_after.guest_names,
--         'notes',            v_after.notes,
--         'roster_member_id', v_after.roster_member_id,
--         'owner_user_id',    v_after.owner_user_id,
--         'hourly_rate_cents', v_after.hourly_rate_cents,
--         'price_amount_cents', v_after.price_amount_cents
--       )
--     )
--   );
--
--   v_notification_id := null;
--
--   if v_scheduling_changed and v_after.owner_user_id is not null then
--     if v_tz is null then
--       select timezone into v_tz from clubs where id = v_club_id;
--     end if;
--
--     insert into notifications (club_id, user_id, kind, body, metadata)
--     values (
--       v_club_id,
--       v_after.owner_user_id,
--       'reservation_rescheduled',
--       'Your booking was moved to ' || v_court.name || ' on '
--         || to_char(v_after.starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM')
--         || ' – ' || to_char(v_after.ends_at at time zone v_tz, 'HH12:MI AM') || '.',
--       jsonb_build_object('reservation_id', v_after.id, 'court_id', v_after.court_id)
--     )
--     returning id into v_notification_id;
--   end if;
--
--   return jsonb_build_object(
--     'reservation',     to_jsonb(v_after),
--     'changed_fields',  to_jsonb(v_changed_fields),
--     'notification_id', v_notification_id
--   );
-- end;
-- $function$;
--
-- CREATE OR REPLACE FUNCTION public.admin_update_member_lesson(p_request_id uuid, p_expected_club_id uuid, p_expected_updated_at timestamp with time zone, p_roster_member_id uuid, p_pro_id uuid, p_court_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_lesson_type_id uuid DEFAULT NULL::uuid, p_member_note text DEFAULT NULL::text)
--  RETURNS lesson_requests
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public', 'pg_temp'
-- AS $function$
-- declare
--   v_club_id           uuid;
--   v_role              text;
--   v_before            public.lesson_requests%rowtype;
--   v_old_reservation   public.reservations%rowtype;
--   v_roster            public.roster_members%rowtype;
--   v_member_id         uuid;
--   v_pro               public.profiles%rowtype;
--   v_duration_minutes  int;
--   v_tz                text;
--   v_scheduling_changed boolean;
--   v_member_changed     boolean;
--   v_pro_changed        boolean;
--   v_res_id             uuid;
--   v_member_name        text;
--   v_result             public.lesson_requests%rowtype;
--   -- FINAL LESSON PRICING REFINEMENT: lesson-type-change re-snapshot, plus
--   -- duration-only recompute for an hourly-priced Lesson whose type is
--   -- unchanged.
--   v_lesson_type_changed boolean;
--   v_duration_changed     boolean;
--   v_pricing_basis            text;
--   v_unit_price_amount_cents  integer;
--   v_price_amount_cents       integer;
-- begin
--   select public.current_user_club_id(), public.current_user_role()
--     into v_club_id, v_role;
--
--   if v_club_id is null then raise exception 'not_authenticated'; end if;
--   if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
--   if v_role is null or v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;
--
--   select * into v_before
--     from public.lesson_requests
--    where id      = p_request_id
--      and club_id = v_club_id
--    for update;
--   if not found then raise exception 'request_not_found'; end if;
--
--   if v_before.status <> 'confirmed' then raise exception 'invalid_status_for_edit'; end if;
--   if v_before.updated_at is distinct from p_expected_updated_at then raise exception 'stale_edit_conflict'; end if;
--   if v_before.linked_reservation_id is null then raise exception 'linked_reservation_not_found'; end if;
--
--   select * into v_old_reservation
--     from public.reservations
--    where id      = v_before.linked_reservation_id
--      and club_id = v_club_id
--      and reason  = 'pro_lesson'
--      and status  = 'confirmed'
--    for update;
--   if not found then raise exception 'linked_reservation_not_found'; end if;
--
--   if v_old_reservation.starts_at <= now() then
--     raise exception 'cannot_reschedule_started_lesson';
--   end if;
--
--   -- Resolve and validate the (possibly reassigned) target roster Member.
--   select * into v_roster
--     from public.roster_members
--    where id      = p_roster_member_id
--      and club_id = v_club_id;
--   if not found then raise exception 'roster_member_not_found'; end if;
--
--   v_member_id   := v_roster.claimed_by;
--   v_member_name := trim(coalesce(v_roster.first_name, '') || ' ' || coalesce(v_roster.last_name, ''));
--
--   -- Validate (possibly reassigned) pro.
--   select * into v_pro
--     from public.profiles
--    where id                 = p_pro_id
--      and club_id            = v_club_id
--      and status              = 'active'
--      and role                in ('pro', 'admin', 'staff')
--      and is_lesson_provider  = true;
--   if not found then raise exception 'pro_not_found'; end if;
--
--   if v_member_id is not null and v_member_id = p_pro_id then
--     raise exception 'cannot_request_yourself';
--   end if;
--
--   if p_starts_at < now() then raise exception 'cannot_propose_past_time'; end if;
--   if p_ends_at  <= p_starts_at then raise exception 'invalid_duration'; end if;
--
--   v_duration_minutes := round(extract(epoch from (p_ends_at - p_starts_at)) / 60)::int;
--   if v_duration_minutes < 30 or v_duration_minutes % 15 <> 0 then
--     raise exception 'invalid_duration';
--   end if;
--
--   if not exists (
--     select 1 from public.courts
--      where id        = p_court_id
--        and club_id   = v_club_id
--        and is_active = true
--   ) then
--     raise exception 'court_not_found';
--   end if;
--
--   if p_lesson_type_id is not null then
--     if not exists (
--       select 1 from public.lesson_types lt
--        where lt.id        = p_lesson_type_id
--          and lt.club_id   = v_club_id
--          and lt.is_active = true
--     ) then
--       raise exception 'lesson_type_not_found';
--     end if;
--
--     if exists (
--       select 1 from public.lesson_types lt
--        where lt.id               = p_lesson_type_id
--          and lt.allowed_durations is not null
--          and array_length(lt.allowed_durations, 1) > 0
--          and not (v_duration_minutes = any(lt.allowed_durations))
--     ) then
--       raise exception 'duration_not_allowed_for_type';
--     end if;
--   end if;
--
--   -- FINAL LESSON PRICING REFINEMENT — full A/B/C-style edit invariants:
--   --
--   --  * lesson_type_id UNCHANGED, duration UNCHANGED (time/court/provider/
--   --    member-only edits): preserve pricing_basis, unit price, and total
--   --    exactly.
--   --  * lesson_type_id UNCHANGED, duration CHANGED: preserve the existing
--   --    pricing_basis + unit price snapshot. flat -> total stays exactly
--   --    what it was (a flat Lesson price does not scale with duration).
--   --    hourly -> recompute total from the PRESERVED unit rate times the
--   --    NEW duration. A NULL preserved unit price always keeps the total
--   --    NULL — never silently adopt today's Lesson Type rate merely because
--   --    an existing Lesson's duration changed.
--   --  * lesson_type_id CHANGES: snapshot the NEW type's CURRENT
--   --    pricing_basis + unit price, and calculate a fresh total from the
--   --    Lesson's current (possibly also-changed) duration — changing what
--   --    is priced re-resolves from its current configuration, exactly like
--   --    the reservation court-change rule. Changing to no Lesson Type at
--   --    all (NULL) clears all three snapshot fields to NULL.
--   v_lesson_type_changed := p_lesson_type_id is distinct from v_before.lesson_type_id;
--   v_duration_changed    := v_duration_minutes is distinct from v_before.duration_minutes;
--
--   if v_lesson_type_changed then
--     if p_lesson_type_id is not null then
--       select pricing_basis, unit_price_amount_cents
--         into v_pricing_basis, v_unit_price_amount_cents
--         from public.lesson_types where id = p_lesson_type_id;
--
--       if v_pricing_basis = 'hourly' then
--         if v_unit_price_amount_cents is not null then
--           v_price_amount_cents := round(v_unit_price_amount_cents * v_duration_minutes / 60.0)::integer;
--         else
--           v_price_amount_cents := null;
--         end if;
--       else
--         v_price_amount_cents := v_unit_price_amount_cents;
--       end if;
--     else
--       v_pricing_basis           := null;
--       v_unit_price_amount_cents := null;
--       v_price_amount_cents      := null;
--     end if;
--   else
--     v_pricing_basis           := v_before.pricing_basis;
--     v_unit_price_amount_cents := v_before.unit_price_amount_cents;
--
--     if v_duration_changed and v_pricing_basis = 'hourly' and v_unit_price_amount_cents is not null then
--       v_price_amount_cents := round(v_unit_price_amount_cents * v_duration_minutes / 60.0)::integer;
--     else
--       v_price_amount_cents := v_before.price_amount_cents;
--     end if;
--   end if;
--
--   if length(p_member_note) > 500 then raise exception 'note_too_long'; end if;
--
--   v_scheduling_changed := (p_court_id, p_starts_at, p_ends_at)
--     is distinct from (v_old_reservation.court_id, v_old_reservation.starts_at, v_old_reservation.ends_at);
--   v_member_changed := p_roster_member_id is distinct from v_before.roster_member_id;
--   v_pro_changed     := p_pro_id is distinct from v_before.pro_id;
--
--   -- Phase 34C: a reassignment must not silently abandon or transfer an
--   -- unresolved obligation. Checked before any mutation below.
--   if v_member_changed then
--     perform public._check_member_reassignment_allowed(v_club_id, 'lesson_request', p_request_id);
--   end if;
--
--   select timezone into v_tz from public.clubs where id = v_club_id;
--
--   if v_scheduling_changed or v_pro_changed then
--
--     -- Phase 33E3 fix: court-conflict pre-check, excluding this lesson's
--     -- own currently-linked reservation — mirrors propose_lesson_time's
--     -- already-live pattern. Without this, a genuine court double-book was
--     -- only ever caught by the raw GiST EXCLUDE constraint on reservations,
--     -- whose untranslated error text mapLessonError() cannot match, so the
--     -- UI showed a generic "Something went wrong" instead of the friendly,
--     -- already-mapped court_conflict message.
--     if exists (
--       select 1 from public.reservations r
--        where r.court_id = p_court_id
--          and r.status   in ('pending', 'confirmed')
--          and tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')
--          and r.id is distinct from v_old_reservation.id
--     ) then
--       raise exception 'court_conflict';
--     end if;
--
--     -- Time and/or pro changed — re-validate operating hours / pro /
--     -- member conflicts, excluding this lesson's own still-active
--     -- reservation, exactly like a self-service reschedule. Member check
--     -- is unconditional (correction pass — see admin_create_member_
--     -- lesson's header note above); p_roster_member_id always supplied.
--     perform public._lesson_check_operating_hours(v_club_id, p_starts_at, p_ends_at, v_tz);
--     perform public._lesson_check_pro_availability(p_pro_id, p_starts_at, p_ends_at, p_request_id);
--     perform public._lesson_check_member_availability(v_member_id, p_roster_member_id, p_starts_at, p_ends_at, p_request_id);
--   end if;
--
--   if v_scheduling_changed then
--     -- Soft-cancel the old reservation and insert a new one — mirrors
--     -- accept_lesson_proposal's own reschedule pattern exactly. The new
--     -- row's created_by is this admin: it is a genuinely new row, not a
--     -- rewrite of the old one's created_by (which stays untouched on the
--     -- now-cancelled row).
--     update public.reservations
--        set status            = 'cancelled',
--            cancelled_at      = now(),
--            cancelled_by      = auth.uid(),
--            cancellation_kind = 'system',
--            updated_at        = now()
--      where id = v_old_reservation.id;
--
--     insert into public.reservations (
--       club_id, court_id, owner_user_id, roster_member_id,
--       starts_at, ends_at, status, reason,
--       notes, show_notes_to_members, created_by
--     ) values (
--       v_club_id, p_court_id, p_pro_id, p_roster_member_id,
--       p_starts_at, p_ends_at, 'confirmed', 'pro_lesson',
--       'Pro lesson with ' || v_member_name,
--       false,
--       auth.uid()
--     ) returning id into v_res_id;
--   elsif v_member_changed or v_pro_changed then
--     -- Nothing time-related changed — update the existing reservation row
--     -- directly in place (no history-losing replace) rather than the
--     -- soft-cancel-and-reinsert pattern above, which is reserved for an
--     -- actual scheduling change.
--     update public.reservations
--        set owner_user_id    = p_pro_id,
--            roster_member_id = p_roster_member_id,
--            notes            = 'Pro lesson with ' || v_member_name,
--            updated_at       = now()
--      where id = v_old_reservation.id;
--     v_res_id := v_old_reservation.id;
--   else
--     v_res_id := v_old_reservation.id;
--   end if;
--
--   update public.lesson_requests
--      set roster_member_id    = p_roster_member_id,
--          member_id           = v_member_id,
--          pro_id              = p_pro_id,
--          duration_minutes    = v_duration_minutes,
--          member_note         = btrim(coalesce(p_member_note, '')),
--          lesson_type_id      = p_lesson_type_id,
--          proposed_starts_at  = p_starts_at,
--          proposed_ends_at    = p_ends_at,
--          proposed_court_id   = p_court_id,
--          linked_reservation_id = v_res_id,
--          last_actor_id       = auth.uid(),
--          last_actor_role     = v_role,
--          pricing_basis           = v_pricing_basis,
--          unit_price_amount_cents = v_unit_price_amount_cents,
--          price_amount_cents      = v_price_amount_cents,
--          updated_at          = now()
--    where id = p_request_id
--   returning * into v_result;
--
--   -- Phase 34C: payment wiring, after the mutation, mirroring
--   -- update_member_reservation's rule exactly, including the Phase 34C
--   -- lifecycle correction: p_roster_member_id is passed as the CURRENT
--   -- identity into _adjust_payment_obligation, which no-ops if the latest
--   -- cycle belongs to a prior Member (reassigned while unpriced) rather
--   -- than silently adjusting their historical payment. Member reassignment
--   -- always gets an explicit new cycle for the new Member; otherwise a
--   -- price change adjusts the current cycle (if any, and if the new total
--   -- is not NULL) and ensures one exists.
--   if v_member_changed then
--     perform public._create_payment_obligation(
--       v_club_id, 'lesson_request', p_request_id, p_roster_member_id,
--       v_price_amount_cents, auth.uid(), true
--     );
--   elsif v_price_amount_cents is distinct from v_before.price_amount_cents then
--     if v_price_amount_cents is not null then
--       perform public._adjust_payment_obligation(v_club_id, 'lesson_request', p_request_id, p_roster_member_id, v_price_amount_cents, auth.uid());
--     end if;
--     perform public._create_payment_obligation(
--       v_club_id, 'lesson_request', p_request_id, p_roster_member_id,
--       v_price_amount_cents, auth.uid()
--     );
--   end if;
--
--   insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
--   values (
--     v_club_id, auth.uid(), 'admin_update_member_lesson', 'lesson_request', p_request_id,
--     jsonb_build_object(
--       'before', jsonb_build_object(
--         'roster_member_id', v_before.roster_member_id,
--         'member_id',        v_before.member_id,
--         'pro_id',           v_before.pro_id,
--         'court_id',         v_old_reservation.court_id,
--         'starts_at',        v_old_reservation.starts_at,
--         'ends_at',          v_old_reservation.ends_at,
--         'lesson_type_id',   v_before.lesson_type_id,
--         'pricing_basis',    v_before.pricing_basis,
--         'unit_price_amount_cents', v_before.unit_price_amount_cents,
--         'price_amount_cents', v_before.price_amount_cents
--       ),
--       'after', jsonb_build_object(
--         'roster_member_id', p_roster_member_id,
--         'member_id',        v_member_id,
--         'pro_id',           p_pro_id,
--         'court_id',         p_court_id,
--         'starts_at',        p_starts_at,
--         'ends_at',          p_ends_at,
--         'lesson_type_id',   p_lesson_type_id,
--         'pricing_basis',    v_pricing_basis,
--         'unit_price_amount_cents', v_unit_price_amount_cents,
--         'price_amount_cents', v_price_amount_cents
--       ),
--       'scheduling_changed', v_scheduling_changed,
--       'member_changed',     v_member_changed,
--       'pro_changed',        v_pro_changed,
--       'lesson_type_changed', v_lesson_type_changed,
--       'duration_changed',    v_duration_changed,
--       'reservation_id',     v_res_id,
--       'old_reservation_id', case when v_scheduling_changed then v_old_reservation.id else null end
--     )
--   );
--
--   -- Notify pro — always, when the pro or the schedule changed (always has
--   -- an account). Notify member only if claimed and something material
--   -- changed. Reuses the existing lesson_request_confirmed kind — no new
--   -- notification kind is introduced.
--   if v_scheduling_changed or v_pro_changed then
--     insert into public.notifications (club_id, user_id, kind, body, metadata)
--     values (
--       v_club_id, p_pro_id, 'lesson_request_confirmed',
--       'Lesson with ' || v_member_name || ' updated — now ' ||
--         to_char(p_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM') || '.',
--       jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id)
--     );
--   end if;
--
--   if v_member_id is not null and (v_scheduling_changed or v_pro_changed or v_member_changed) then
--     insert into public.notifications (club_id, user_id, kind, body, metadata)
--     values (
--       v_club_id, v_member_id, 'lesson_request_confirmed',
--       'Your lesson with ' ||
--         trim(coalesce(v_pro.first_name, '') || ' ' || coalesce(v_pro.last_name, '')) ||
--         ' is confirmed for ' || to_char(p_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM') || '.',
--       jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id)
--     );
--   end if;
--
--   return v_result;
-- end;
-- $function$;
--
-- commit;
