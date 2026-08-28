-- 0157_late_payment_overpayment_resilience.sql
-- Phase 34E-D — Late Payment / Overpayment Resilience.
--
-- This is a REWRITE of 0157 following external review. 0157 has never
-- been applied, so it is rewritten in place rather than superseded by a
-- new migration (0158 is explicitly forbidden). This version replaces
-- the prior draft's timestamp/UUID-based waiver guard entirely and adds
-- the newest-refundable-attempt-first correction. See the three
-- numbered sections below for what changed and why.
--
-- ══════════════════════════════════════════════════════════════════════
-- BLOCKER 1 — collectible-due model (waiver/void must never reopen
-- collection, and must never be masked once genuinely satisfied)
-- ══════════════════════════════════════════════════════════════════════
--
-- ── Downstream amount_due_cents audit (required before this change) ─────
-- Every consumer of payments.amount_due_cents / PaymentStateRow.current_
-- amount_due_cents was traced:
--   * isPaymentOpenForRecording (src/lib/payments.ts) and
--     isReservationPaymentEligibleForCheckout (paymentsConfig.ts) both
--     check `status in ('unpaid','partially_paid')` FIRST (short-circuit
--     &&) — amount_due_cents is never read for a waived/void payment in
--     either gate.
--   * createReservationCheckoutAction/open_payment_checkout_attempt/
--     record_manual_payment all gate on the SAME status allowlist before
--     ever reading amount_due_cents — never reached for waived/void.
--   * formatPaymentStateLabel's own 'waived'/'void' cases render a plain
--     "Waived"/"Void" label with NO amount_due_cents interpolation at
--     all — unaffected either way.
--   * waive_payment reads amount_due_cents only to compute the amount of
--     THIS NEW waiver (v_remaining = due - paid, evaluated BEFORE this
--     waiver applies) — composes correctly under the new model (a SECOND
--     waiver on an already-partially-waived-but-still-open payment
--     correctly reads the already-reduced collectible remainder).
--   * void_payment_obligation requires status = 'unpaid' AND amount_paid_
--     cents = 0 strictly — at that moment no waiver can have ever been
--     applied (waived and unpaid are mutually exclusive statuses), so
--     nominal_due and collectible_due are identical there regardless.
--   * get_payment_states_for_domains (0145) excludes 'waived'/'void' from
--     "unresolved_prior" by STATUS, never by comparing amount_due_cents —
--     unaffected.
--   * Phase 28 reporting (0095/0096) does not reference payments.amount_
--     due_cents or amount_paid_cents at all (confirmed by direct
--     inspection) — no reporting consumer exists yet to break.
--   * The ONE place amount_due_cents becomes semantically live for a
--     payment that WAS waived/void and later shows 'overpaid' is
--     formatPaymentStateLabel's "overpaid" branch, which computes
--     `paid - due`. Using the OLD nominal due there would be WRONG (it
--     would show "Overpaid by $0" or a negative-clamped $0 in exactly
--     the scenario that must show the real excess) — using collectible
--     due is not merely safe here, it is REQUIRED for this already-
--     shipped label to be correct.
-- Conclusion: no legitimate established invariant depends on amount_due_
-- cents remaining the pre-waiver NOMINAL amount for a waived/void
-- payment. The collectible-due model is implemented below.
--
-- ── The model ─────────────────────────────────────────────────────────
-- nominal_due   = latest obligation_created/obligation_amount_adjusted
--                 amount (unchanged derivation).
-- active_waiver_amount = SUM of every non-reversed 'waived' event's own
--                 amount_cents (composes correctly across more than one
--                 sequential waiver on the same payment).
-- collectible_due = 0                                    if voided
--                  = greatest(nominal_due - active_waiver_amount, 0)  otherwise
-- v_due (the value stored into amount_due_cents) IS collectible_due.
-- v_net (net money actually received) is completely unchanged — still an
-- uncapped SUM over payment_events, never touched by this section.
--
-- With v_due now meaning collectible_due, the status precedence
-- (SECOND external review correction — 'overpaid' now checked BEFORE
-- 'waived', and 'waived' requires EXACT equality) becomes:
--   void:     v_void and v_net <= 0            (v_due is 0 when voided,
--                                                 so this is equivalent to
--                                                 v_net <= v_due; kept in
--                                                 its original, already-
--                                                 correct literal form to
--                                                 minimize the diff)
--   overpaid: v_net > v_due                    (checked BEFORE waived —
--                                                 unchanged expression,
--                                                 now correctly fires for
--                                                 ANY late money beyond
--                                                 the collectible amount,
--                                                 whether the prior state
--                                                 was void, waived, or
--                                                 neither)
--   waived:   v_waived and v_net = v_due        (EXACT equality, not
--                                                 <= — a `<=` guard was
--                                                 too broad: an Admin
--                                                 REVERSAL of an earlier
--                                                 manual payment, after a
--                                                 waiver, can legitimately
--                                                 drop v_net below v_due
--                                                 while the waiver event
--                                                 itself is untouched —
--                                                 that must expose the
--                                                 real remaining balance,
--                                                 never stay masked as
--                                                 'waived'. A reversal is
--                                                 a correction to
--                                                 financial history, not
--                                                 an unexpected late
--                                                 Stripe capture, and must
--                                                 be treated differently.)
--   ...refunded/partially_refunded/paid/partially_paid/unpaid branches
--   are byte-identical to 0153 — only the MEANING of v_due changed, not
--   these comparisons' own text.
--
-- Verified against every worked example in the review (see the
-- accompanying regression test file for the full nine-scenario proof,
-- including the reversal case this correction specifically fixes):
--   $30 nominal, $20 collected, $10 waived, no late money:
--     collectible_due=$20, v_net=$20 -> v_net=v_due -> 'waived'.
--   ...then a late $10 capture arrives (v_net becomes $30):
--     v_net>v_due? 30>20 YES -> 'overpaid' (checked before waived).
--     Never 'partially_paid'. Never reopens Record Payment/Pay Now.
--   $30 nominal, $30 waived (nothing collected first), late $10 capture:
--     collectible_due=$0, v_net=$10 -> v_net>v_due? 10>0 YES ->
--     'overpaid'. Never 'partially_paid'.
--   Void, $30 nominal, late PARTIAL $15 capture (a case the review didn't
--   name but this same model also fixes): under the OLD nominal-due
--   comparison this produced 'partially_paid' (15 < 30 nominal) — a
--   voided obligation reopened for collection, which is exactly what the
--   locked economic model forbids. Under collectible_due=0 for void,
--   v_net(15) > v_due(0) -> 'overpaid' instead. Never collectible again.
--   $20 collected + $10 waived (due=$20, net=$20, 'waived'), THEN the
--   Admin reverses the original $20 manual payment (net becomes $0, due
--   stays $20 since the waiver itself is untouched): v_net=v_due? 0=20
--   NO -> falls through to 'unpaid'. The real $20 unresolved balance is
--   never masked as 'waived'.
--
-- ══════════════════════════════════════════════════════════════════════
-- BLOCKER 2 — no timestamp/UUID causal ordering
-- ══════════════════════════════════════════════════════════════════════
-- The prior draft's v_waived_event_id/v_waived_at/v_late_money_after_
-- waiver variables and the `(pe.created_at, pe.id) > (v_waived_at,
-- v_waived_event_id)` comparison are REMOVED ENTIRELY. The collectible-
-- due model above needs no notion of "did this event happen after that
-- one" — it reasons purely from ledger AMOUNTS (nominal_due,
-- active_waiver_amount, v_net), which is both simpler and correct by
-- construction rather than by inferring causality from a payments-row
-- lock's own transaction ordering.
--
-- ══════════════════════════════════════════════════════════════════════
-- BLOCKER 3 — newest-refundable-attempt-first
-- ══════════════════════════════════════════════════════════════════════
-- get_online_refundable_amount_for_payments (0154) and open_payment_
-- refund_attempt (0153/0155) both previously resolved ONLY the single
-- most-recently-completed Checkout attempt per payment, regardless of
-- whether it had any refundable room remaining. If that newest attempt
-- was already fully refunded but an OLDER completed attempt for the SAME
-- payment still held refundable money (the exact multi-capture
-- overpayment scenario this phase makes operationally safe), Court Time
-- could neither DISPLAY nor CREATE a refund against that older attempt's
-- real Stripe money at all.
--
-- Both functions now apply the SAME deterministic selection rule: among
-- the payment's own verified-provenance COMPLETED attempts, select the
-- MOST RECENT one whose own remaining refundable amount (its
-- amount_expected_cents minus its own reserved succeeded/pending/
-- requires_action refund attempts) is > 0. One refund action still
-- targets exactly one Stripe charge/PaymentIntent/attempt — never split
-- across attempts, never an aggregate object, never metadata-authorized.
-- Once that attempt's remaining refundable reaches 0 (e.g. fully
-- refunded), the NEXT Admin refund action naturally falls through to the
-- next-most-recent attempt with remaining room, with no code change
-- required (the same query simply excludes the now-exhausted attempt).
--
-- Neither function's own OUT-parameter/RETURNS TABLE shape changes.
-- Every table reference in both is alias-qualified end-to-end (pca/pra
-- for open_payment_refund_attempt matching 0155's own established
-- convention; a/p/s/r for get_online_refundable_amount_for_payments
-- matching 0154's own established convention) — manually re-verified
-- against every one of their own OUT-parameter names below.
--
-- ══════════════════════════════════════════════════════════════════════
-- Scope discipline
-- ══════════════════════════════════════════════════════════════════════
-- Exactly three functions are CREATE OR REPLACE'd: _recompute_payment_
-- rollup, get_online_refundable_amount_for_payments, open_payment_
-- refund_attempt. No table, index, constraint, grant, or RLS policy is
-- touched. No new function of any kind is introduced. No historical
-- applied migration (0143-0156) is edited. No new PL/pgSQL RETURNS TABLE
-- function is introduced — the two RETURNS TABLE functions touched here
-- already existed as RETURNS TABLE before this migration; only their
-- bodies are refined, with aggressive alias qualification throughout.
--
-- Deliberately NOT addressed further here: this migration does not
-- change refund AUTHORIZATION beyond attempt SELECTION — the amount
-- ceiling, Admin-only role check, stale-Checkout invalidation, and every
-- other 34E-B guarantee are untouched.
--
-- Apply in Supabase SQL Editor (cloud only).

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. _recompute_payment_rollup — collectible-due model (Blocker 1 + 2).
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public._recompute_payment_rollup(p_payment_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_nominal_due integer;
  v_net    integer;
  v_has_refund boolean;
  v_void   boolean;
  v_active_waiver_amount integer;
  v_waived boolean;
  v_due    integer;
  v_status text;
begin
  select amount_cents into v_nominal_due
    from public.payment_events
   where payment_id = p_payment_id
     and event_type in ('obligation_created', 'obligation_amount_adjusted')
     and id not in (
       select reverses_event_id from public.payment_events where reverses_event_id is not null
     )
   order by created_at desc, id desc
   limit 1;
  v_nominal_due := coalesce(v_nominal_due, 0);

  select
    coalesce(sum(amount_cents) filter (where event_type in ('manual_payment_recorded', 'online_payment_recorded')), 0)
    - coalesce(sum(amount_cents) filter (where event_type in ('refund_recorded', 'online_refund_recorded')), 0)
    into v_net
    from public.payment_events
   where payment_id = p_payment_id
     and id not in (
       select reverses_event_id from public.payment_events where reverses_event_id is not null
     );
  v_net := coalesce(v_net, 0);

  select exists(
    select 1 from public.payment_events
     where payment_id = p_payment_id and event_type in ('refund_recorded', 'online_refund_recorded')
       and id not in (
         select reverses_event_id from public.payment_events where reverses_event_id is not null
       )
  ) into v_has_refund;

  select exists(
    select 1 from public.payment_events
     where payment_id = p_payment_id and event_type = 'void_payment_obligation'
       and id not in (
         select reverses_event_id from public.payment_events where reverses_event_id is not null
       )
  ) into v_void;

  -- Phase 34E-D (corrected) — the collectible-due model. Summed (not
  -- "latest only") so more than one sequential waiver on the same
  -- payment composes correctly. No causal/timestamp ordering anywhere.
  select coalesce(sum(amount_cents), 0) into v_active_waiver_amount
    from public.payment_events
   where payment_id = p_payment_id and event_type = 'waived'
     and id not in (
       select reverses_event_id from public.payment_events where reverses_event_id is not null
     );
  v_waived := v_active_waiver_amount > 0;

  if v_void then
    v_due := 0;
  else
    v_due := greatest(v_nominal_due - v_active_waiver_amount, 0);
  end if;

  -- External review correction — 'overpaid' must be checked BEFORE
  -- 'waived', and 'waived' requires EXACT equality (v_net = v_due), not
  -- v_net <= v_due. A `<=` guard was too broad: if the ledger's net money
  -- ever falls BELOW the collectible due while a waiver is still active
  -- (e.g. an Admin reverses an earlier manual payment — a correction to
  -- financial history, never an unexpected late Stripe capture), the old
  -- condition still matched and silently relabeled a real, newly-exposed
  -- unresolved balance as 'waived'. Exact equality means 'waived' only
  -- ever describes the state precisely intended: net money exactly equal
  -- to what remains collectible after the waiver, with the ordinary
  -- refunded/partially_refunded/paid/partially_paid/unpaid branches
  -- (unchanged text) as the fallback the moment net drifts away from
  -- that in either direction — including a refund that lands exactly
  -- back on the waived amount, which correctly reads 'waived' again.
  if v_void and v_net <= 0 then
    v_status := 'void';
  elsif v_net > v_due then
    v_status := 'overpaid';
  elsif v_waived and v_net = v_due then
    v_status := 'waived';
  elsif v_has_refund then
    if v_net <= 0 then
      v_status := 'refunded';
    elsif v_net < v_due then
      v_status := 'partially_refunded';
    else
      v_status := 'paid';
    end if;
  else
    if v_net <= 0 then
      v_status := 'unpaid';
    elsif v_net < v_due then
      v_status := 'partially_paid';
    else
      v_status := 'paid';
    end if;
  end if;

  update public.payments
     set amount_due_cents = v_due,
         amount_paid_cents = v_net,
         status = v_status
   where id = p_payment_id;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. get_online_refundable_amount_for_payments — newest-refundable-
--    attempt-first (Blocker 3). Same RETURNS TABLE shape as 0154; every
--    table reference alias-qualified.
-- ═══════════════════════════════════════════════════════════════════════════
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
    with sources as (
      select a.id as attempt_id, a.payment_id, a.amount_expected_cents, a.created_at, p.currency
        from public.payment_checkout_attempts a
        join public.payments p on p.id = a.payment_id
       where a.club_id = v_club_id
         and a.payment_id = any(p_payment_ids)
         and a.status = 'completed'
    ),
    reserved as (
      select pra.source_checkout_attempt_id as attempt_id, coalesce(sum(pra.requested_amount_cents), 0) as reserved_cents
        from public.payment_refund_attempts pra
       where pra.club_id = v_club_id
         and pra.status in ('succeeded', 'pending', 'requires_action')
       group by pra.source_checkout_attempt_id
    ),
    -- Every completed attempt's OWN remaining refundable amount —
    -- computed for ALL of them, not just the latest, so the ranking step
    -- below can correctly skip an already-exhausted newest attempt.
    attempts_with_remaining as (
      select s.attempt_id, s.payment_id, s.currency, s.created_at,
             greatest(s.amount_expected_cents - coalesce(r.reserved_cents, 0), 0)::integer as remaining_cents
        from sources s
        left join reserved r on r.attempt_id = s.attempt_id
    ),
    -- Newest-refundable-attempt-first (locked selection rule, 34E-D
    -- Blocker 3): among attempts with remaining_cents > 0, pick the most
    -- recently completed one per payment. A payment with no attempt
    -- still holding refundable money simply produces no row here — the
    -- caller's own `?? 0` fallback (unchanged, src/app/(app)/admin/
    -- payments/page.tsx) already treats a missing row as $0 refundable,
    -- identical in effect to the pre-0157 behavior for that case.
    -- External review correction — a deterministic tie-break
    -- (w.attempt_id desc) for two completed attempts sharing the exact
    -- same created_at. This is ONLY a tie-break for equal timestamps,
    -- never a causal/financial ordering mechanism (see this migration's
    -- own header comment, Blocker 2).
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

revoke execute on function public.get_online_refundable_amount_for_payments(uuid[]) from public, anon;
grant  execute on function public.get_online_refundable_amount_for_payments(uuid[]) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. open_payment_refund_attempt — SAME newest-refundable-attempt-first
--    rule (Blocker 3), under the SAME canonical payments-row lock. Same
--    RETURNS TABLE shape/signature as 0155; every table reference alias-
--    qualified.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.open_payment_refund_attempt(
  p_payment_id             uuid,
  p_club_id                uuid,
  p_requested_amount_cents integer,
  p_actor_id               uuid,
  p_admin_reason           text default null
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
set search_path to 'public', 'pg_temp'
as $$
declare
  v_payment          public.payments%rowtype;
  v_source           public.payment_checkout_attempts%rowtype;
  v_existing_pending public.payment_refund_attempts%rowtype;
  v_reserved_total    integer;
  v_refundable         integer;
  v_result_id           uuid;
begin
  if p_payment_id is null or p_club_id is null or p_actor_id is null then
    raise exception 'invalid_arguments';
  end if;

  if p_requested_amount_cents is null or p_requested_amount_cents <= 0 then
    raise exception 'invalid_refund_amount';
  end if;

  select * into v_payment
    from public.payments p
   where p.id = p_payment_id and p.club_id = p_club_id
   for update;
  if not found then
    raise exception 'payment_not_found';
  end if;

  -- Reuse-before-create: never mint a second idempotency key for what may
  -- be the same in-flight Stripe request (locked decisions 6, 7 D/E) —
  -- but ONLY when the retried request is for the identical amount (see
  -- this function's own header comment). A different amount fails
  -- closed, before any Stripe call and before this existing attempt's
  -- own financial identity is ever touched. Unaffected by the newest-
  -- refundable-attempt-first correction below — an existing PENDING
  -- attempt already has its own fixed source_checkout_attempt_id from
  -- when IT was opened.
  select * into v_existing_pending
    from public.payment_refund_attempts pra
   where pra.payment_id = p_payment_id and pra.stripe_refund_id is null and pra.status = 'pending'
   for update;

  if found then
    if v_existing_pending.requested_amount_cents <> p_requested_amount_cents then
      raise exception 'pending_refund_amount_mismatch';
    end if;
    select * into v_source from public.payment_checkout_attempts pca where pca.id = v_existing_pending.source_checkout_attempt_id;
    return query select
      v_existing_pending.id, v_existing_pending.payment_id, v_existing_pending.club_id,
      v_existing_pending.source_checkout_attempt_id, v_existing_pending.stripe_account_id,
      v_existing_pending.livemode, v_source.stripe_checkout_session_id, v_existing_pending.stripe_payment_intent_id,
      v_existing_pending.requested_amount_cents, v_existing_pending.status, v_payment.currency;
    return;
  end if;

  -- Trusted provenance (locked decision 3/5) + newest-refundable-attempt-
  -- first (34E-D Blocker 3): among the payment's own COMPLETED online
  -- attempts, select the MOST RECENT one that still has remaining
  -- refundable room (its own amount_expected_cents minus its own
  -- reserved succeeded/pending/requires_action refund attempts) — never
  -- the club's currently-configured Stripe connection, never split
  -- across attempts. Locked FOR UPDATE the same way as before; the
  -- payments row is already locked above, so no concurrent call for this
  -- SAME payment can race this resolution.
  select * into v_source
    from public.payment_checkout_attempts pca
   where pca.payment_id = p_payment_id
     and pca.status = 'completed'
     and pca.amount_expected_cents - coalesce((
           select sum(pra2.requested_amount_cents)
             from public.payment_refund_attempts pra2
            where pra2.source_checkout_attempt_id = pca.id
              and pra2.status in ('succeeded', 'pending', 'requires_action')
         ), 0) > 0
   -- External review correction — a deterministic tie-break (pca.id desc)
   -- for two completed attempts sharing the exact same created_at. This
   -- is ONLY a tie-break for equal timestamps, never a causal/financial
   -- ordering mechanism (see this migration's own header comment,
   -- Blocker 2) — and matches get_online_refundable_amount_for_payments'
   -- own identical tie-break exactly, so both functions always agree on
   -- which single attempt is selected.
   order by pca.created_at desc, pca.id desc
   limit 1
   for update;
  if not found then
    raise exception 'no_online_payment_to_refund';
  end if;

  -- Stripe-refundable ceiling for THIS specific selected attempt only
  -- (locked decision 1) — never payments.amount_paid_cents, which nets
  -- manual money in too.
  select coalesce(sum(pra.requested_amount_cents), 0) into v_reserved_total
    from public.payment_refund_attempts pra
   where pra.source_checkout_attempt_id = v_source.id
     and pra.status in ('succeeded', 'pending', 'requires_action');

  v_refundable := v_source.amount_expected_cents - v_reserved_total;
  if p_requested_amount_cents > v_refundable then
    raise exception 'refund_exceeds_online_remaining';
  end if;

  insert into public.payment_refund_attempts as pra (
    club_id, payment_id, source_checkout_attempt_id, stripe_account_id, livemode,
    stripe_payment_intent_id, requested_amount_cents, status, admin_reason, created_by
  ) values (
    p_club_id, p_payment_id, v_source.id, v_source.stripe_account_id, v_source.livemode,
    v_source.stripe_payment_intent_id, p_requested_amount_cents, 'pending', p_admin_reason, p_actor_id
  ) returning pra.id into v_result_id;

  return query select
    v_result_id, p_payment_id, p_club_id, v_source.id, v_source.stripe_account_id,
    v_source.livemode, v_source.stripe_checkout_session_id, v_source.stripe_payment_intent_id,
    p_requested_amount_cents, 'pending'::text, v_payment.currency;
end;
$$;

revoke execute on function public.open_payment_refund_attempt(uuid, uuid, integer, uuid, text) from public, anon, authenticated;
grant  execute on function public.open_payment_refund_attempt(uuid, uuid, integer, uuid, text) to service_role;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback (manual, cloud SQL Editor) — restores the EXACT currently-
-- applied bodies of all THREE functions this migration changes (0153's
-- _recompute_payment_rollup, 0154's get_online_refundable_amount_for_
-- payments, 0155's open_payment_refund_attempt). Uncomment and run
-- top-to-bottom if 0157 must be reverted after being applied.
-- ═══════════════════════════════════════════════════════════════════════════
-- begin;
--
-- create or replace function public._recompute_payment_rollup(p_payment_id uuid)
-- returns void
-- language plpgsql
-- security definer
-- set search_path to 'public', 'pg_temp'
-- as $$
-- declare
--   v_due    integer;
--   v_net    integer;
--   v_has_refund boolean;
--   v_void   boolean;
--   v_waived boolean;
--   v_status text;
-- begin
--   select amount_cents into v_due
--     from public.payment_events
--    where payment_id = p_payment_id
--      and event_type in ('obligation_created', 'obligation_amount_adjusted')
--      and id not in (
--        select reverses_event_id from public.payment_events where reverses_event_id is not null
--      )
--    order by created_at desc, id desc
--    limit 1;
--   v_due := coalesce(v_due, 0);
--
--   select
--     coalesce(sum(amount_cents) filter (where event_type in ('manual_payment_recorded', 'online_payment_recorded')), 0)
--     - coalesce(sum(amount_cents) filter (where event_type in ('refund_recorded', 'online_refund_recorded')), 0)
--     into v_net
--     from public.payment_events
--    where payment_id = p_payment_id
--      and id not in (
--        select reverses_event_id from public.payment_events where reverses_event_id is not null
--      );
--   v_net := coalesce(v_net, 0);
--
--   select exists(
--     select 1 from public.payment_events
--      where payment_id = p_payment_id and event_type in ('refund_recorded', 'online_refund_recorded')
--        and id not in (
--          select reverses_event_id from public.payment_events where reverses_event_id is not null
--        )
--   ) into v_has_refund;
--
--   select exists(
--     select 1 from public.payment_events
--      where payment_id = p_payment_id and event_type = 'void_payment_obligation'
--        and id not in (
--          select reverses_event_id from public.payment_events where reverses_event_id is not null
--        )
--   ) into v_void;
--
--   select exists(
--     select 1 from public.payment_events
--      where payment_id = p_payment_id and event_type = 'waived'
--        and id not in (
--          select reverses_event_id from public.payment_events where reverses_event_id is not null
--        )
--   ) into v_waived;
--
--   if v_void and v_net <= 0 then
--     v_status := 'void';
--   elsif v_waived then
--     v_status := 'waived';
--   elsif v_net > v_due then
--     v_status := 'overpaid';
--   elsif v_has_refund then
--     if v_net <= 0 then
--       v_status := 'refunded';
--     elsif v_net < v_due then
--       v_status := 'partially_refunded';
--     else
--       v_status := 'paid';
--     end if;
--   else
--     if v_net <= 0 then
--       v_status := 'unpaid';
--     elsif v_net < v_due then
--       v_status := 'partially_paid';
--     else
--       v_status := 'paid';
--     end if;
--   end if;
--
--   update public.payments
--      set amount_due_cents = v_due,
--          amount_paid_cents = v_net,
--          status = v_status
--    where id = p_payment_id;
-- end;
-- $$;
--
-- create or replace function public.get_online_refundable_amount_for_payments(
--   p_payment_ids uuid[]
-- )
-- returns table (
--   payment_id       uuid,
--   refundable_cents integer,
--   currency          text
-- )
-- language plpgsql
-- security definer
-- set search_path to 'public', 'pg_temp'
-- as $$
-- declare
--   v_club_id uuid;
--   v_role    text;
-- begin
--   v_club_id := public.current_user_club_id();
--   v_role    := public.current_user_role();
--   if v_club_id is null then raise exception 'not_authenticated'; end if;
--   if v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;
--
--   return query
--     with sources as (
--       select a.id as attempt_id, a.payment_id, a.amount_expected_cents, a.created_at, p.currency
--         from public.payment_checkout_attempts a
--         join public.payments p on p.id = a.payment_id
--        where a.club_id = v_club_id
--          and a.payment_id = any(p_payment_ids)
--          and a.status = 'completed'
--     ),
--     latest as (
--       select distinct on (s.payment_id)
--         s.attempt_id,
--         s.payment_id,
--         s.amount_expected_cents,
--         s.currency
--       from sources s
--       order by s.payment_id, s.created_at desc
--     ),
--     reserved as (
--       select source_checkout_attempt_id as attempt_id, coalesce(sum(requested_amount_cents), 0) as reserved_cents
--         from public.payment_refund_attempts
--        where club_id = v_club_id
--          and status in ('succeeded', 'pending', 'requires_action')
--        group by source_checkout_attempt_id
--     )
--     select l.payment_id, greatest(l.amount_expected_cents - coalesce(r.reserved_cents, 0), 0)::integer, l.currency
--       from latest l
--       left join reserved r on r.attempt_id = l.attempt_id;
-- end;
-- $$;
--
-- revoke execute on function public.get_online_refundable_amount_for_payments(uuid[]) from public, anon;
-- grant  execute on function public.get_online_refundable_amount_for_payments(uuid[]) to authenticated;
--
-- create or replace function public.open_payment_refund_attempt(
--   p_payment_id             uuid,
--   p_club_id                uuid,
--   p_requested_amount_cents integer,
--   p_actor_id               uuid,
--   p_admin_reason           text default null
-- )
-- returns table (
--   id                          uuid,
--   payment_id                  uuid,
--   club_id                      uuid,
--   source_checkout_attempt_id  uuid,
--   stripe_account_id            text,
--   livemode                     boolean,
--   stripe_checkout_session_id   text,
--   stripe_payment_intent_id     text,
--   requested_amount_cents       integer,
--   status                       text,
--   currency                     text
-- )
-- language plpgsql
-- security definer
-- set search_path to 'public', 'pg_temp'
-- as $$
-- declare
--   v_payment          public.payments%rowtype;
--   v_source           public.payment_checkout_attempts%rowtype;
--   v_existing_pending public.payment_refund_attempts%rowtype;
--   v_reserved_total    integer;
--   v_refundable         integer;
--   v_result_id           uuid;
-- begin
--   if p_payment_id is null or p_club_id is null or p_actor_id is null then
--     raise exception 'invalid_arguments';
--   end if;
--
--   if p_requested_amount_cents is null or p_requested_amount_cents <= 0 then
--     raise exception 'invalid_refund_amount';
--   end if;
--
--   select * into v_payment
--     from public.payments p
--    where p.id = p_payment_id and p.club_id = p_club_id
--    for update;
--   if not found then
--     raise exception 'payment_not_found';
--   end if;
--
--   -- Reuse-before-create: never mint a second idempotency key for what may
--   -- be the same in-flight Stripe request (locked decisions 6, 7 D/E) —
--   -- but ONLY when the retried request is for the identical amount (see
--   -- this function's own header comment). A different amount fails
--   -- closed, before any Stripe call and before this existing attempt's
--   -- own financial identity is ever touched.
--   select * into v_existing_pending
--     from public.payment_refund_attempts pra
--    where pra.payment_id = p_payment_id and pra.stripe_refund_id is null and pra.status = 'pending'
--    for update;
--
--   if found then
--     if v_existing_pending.requested_amount_cents <> p_requested_amount_cents then
--       raise exception 'pending_refund_amount_mismatch';
--     end if;
--     select * into v_source from public.payment_checkout_attempts pca where pca.id = v_existing_pending.source_checkout_attempt_id;
--     return query select
--       v_existing_pending.id, v_existing_pending.payment_id, v_existing_pending.club_id,
--       v_existing_pending.source_checkout_attempt_id, v_existing_pending.stripe_account_id,
--       v_existing_pending.livemode, v_source.stripe_checkout_session_id, v_existing_pending.stripe_payment_intent_id,
--       v_existing_pending.requested_amount_cents, v_existing_pending.status, v_payment.currency;
--     return;
--   end if;
--
--   -- Trusted provenance (locked decision 3/5): the payment's own latest
--   -- COMPLETED online attempt — never the club's currently-configured
--   -- Stripe connection.
--   select * into v_source
--     from public.payment_checkout_attempts pca
--    where pca.payment_id = p_payment_id and pca.status = 'completed'
--    order by pca.created_at desc
--    limit 1
--    for update;
--   if not found then
--     raise exception 'no_online_payment_to_refund';
--   end if;
--
--   -- Stripe-refundable ceiling for THIS specific completed attempt only
--   -- (locked decision 1) — never payments.amount_paid_cents, which nets
--   -- manual money in too.
--   select coalesce(sum(pra.requested_amount_cents), 0) into v_reserved_total
--     from public.payment_refund_attempts pra
--    where pra.source_checkout_attempt_id = v_source.id
--      and pra.status in ('succeeded', 'pending', 'requires_action');
--
--   v_refundable := v_source.amount_expected_cents - v_reserved_total;
--   if p_requested_amount_cents > v_refundable then
--     raise exception 'refund_exceeds_online_remaining';
--   end if;
--
--   insert into public.payment_refund_attempts as pra (
--     club_id, payment_id, source_checkout_attempt_id, stripe_account_id, livemode,
--     stripe_payment_intent_id, requested_amount_cents, status, admin_reason, created_by
--   ) values (
--     p_club_id, p_payment_id, v_source.id, v_source.stripe_account_id, v_source.livemode,
--     v_source.stripe_payment_intent_id, p_requested_amount_cents, 'pending', p_admin_reason, p_actor_id
--   ) returning pra.id into v_result_id;
--
--   return query select
--     v_result_id, p_payment_id, p_club_id, v_source.id, v_source.stripe_account_id,
--     v_source.livemode, v_source.stripe_checkout_session_id, v_source.stripe_payment_intent_id,
--     p_requested_amount_cents, 'pending'::text, v_payment.currency;
-- end;
-- $$;
--
-- revoke execute on function public.open_payment_refund_attempt(uuid, uuid, integer, uuid, text) from public, anon, authenticated;
-- grant  execute on function public.open_payment_refund_attempt(uuid, uuid, integer, uuid, text) to service_role;
--
-- commit;
