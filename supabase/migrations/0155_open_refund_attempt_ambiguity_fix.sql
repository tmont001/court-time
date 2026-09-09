-- 0155_open_refund_attempt_ambiguity_fix.sql
-- Phase 34E-B runtime QA follow-up — column-reference ambiguity fix, same
-- bug class as 0154 (get_online_refundable_amount_for_payments), now
-- confirmed and fixed in public.open_payment_refund_attempt.
--
-- ── The problem (runtime evidence) ───────────────────────────────────────
-- A $10 refund attempt against a fresh, fully paid, online $60 Court Time
-- payment (Refund button now correctly visible after 0154) returned
-- "Failed to start refund." — that generic Admin-facing message was the
-- only runtime signal observed; the underlying Postgres error was not
-- itself captured live. A static audit of the currently-applied 0153
-- body of public.open_payment_refund_attempt then established that it
-- contains the same PL/pgSQL OUT-variable ambiguity class already proven
-- (with a live 42702 error) in get_online_refundable_amount_for_payments
-- and fixed by 0154.
--
-- Root cause: exactly the ambiguity class fixed in 0154. This function's
-- own `returns table (id uuid, payment_id uuid, club_id uuid,
-- source_checkout_attempt_id uuid, stripe_account_id text, livemode
-- boolean, stripe_checkout_session_id text, stripe_payment_intent_id
-- text, requested_amount_cents integer, status text, currency text)`
-- clause implicitly declares each of those names as a PL/pgSQL variable,
-- in scope for the entire function body. A full re-audit of the
-- currently-applied 0153 body found FOUR runtime-reachable unqualified
-- references that collide with these OUT variables:
--
--   1. `where payment_id = p_payment_id and stripe_refund_id is null
--       and status = 'pending'` (payment_id, status) — against
--      payment_refund_attempts. This is the FIRST statement reached on
--      every call, so every invocation failed here immediately.
--   2. `where id = v_existing_pending.source_checkout_attempt_id` (id)
--      — against payment_checkout_attempts.
--   3. `where payment_id = p_payment_id and status = 'completed'`
--      (payment_id, status) — against payment_checkout_attempts.
--   4. `sum(requested_amount_cents) ... where source_checkout_attempt_id
--       = v_source.id and status in (...)` (requested_amount_cents,
--      source_checkout_attempt_id, status) — against
--      payment_refund_attempts.
--
-- A fifth, latent (not yet triggered, since execution never reached it)
-- site was also found while qualifying every column per instruction:
--   5. `insert into public.payment_refund_attempts (...) ... returning id
--       into v_result_id;` (id) — an INSERT...RETURNING target list is
--      evaluated the same way and is equally subject to this shadowing.
--      Fixed by aliasing the insert target (`insert into ... as pra`)
--      and qualifying the RETURNING clause (`returning pra.id`), standard
--      supported PostgreSQL syntax.
--
-- Separately audited and confirmed SAFE (no fix needed):
--   - process_stripe_refund_webhook_event: `returns table (
--     already_processed boolean, matched boolean)` — no table in this
--     schema has columns by either name, and no embedded statement
--     references them unqualified.
--   - get_online_refundable_amount_for_payments: already fixed by 0154.
--   - No other RETURNS TABLE function exists in 0153/0154 (record_refund
--     returns a plain public.payments composite, which does not create
--     this OUT-variable shadowing — every other function in 0153/0154
--     returns void or uuid).
--
-- ── The fix ───────────────────────────────────────────────────────────
-- CREATE OR REPLACE of ONLY public.open_payment_refund_attempt(uuid,
-- uuid, integer, uuid, text), starting from the exact currently-applied
-- 0153 body. Every table column reference throughout the ENTIRE function
-- is now explicitly alias-qualified (payment_refund_attempts pra,
-- payment_checkout_attempts pca, payments p) — not merely the four names
-- that currently fail, so no latent, not-yet-triggered ambiguity remains
-- either (e.g. `created_at` was also unqualified, though it does not
-- collide with any OUT variable name).
--
-- Preserved exactly, unchanged: function signature and return shape,
-- service-role-only grants, canonical payment-row-first locking
-- (`for update` on payments before payment_refund_attempts/payment_
-- checkout_attempts, same order as 0153), the same-amount pending-retry
-- reuse path, the different-amount fail-closed pending_refund_amount_
-- mismatch, latest-completed-Checkout provenance (order by created_at
-- desc limit 1), the online-refundable ceiling computation, and every
-- existing exception/return value. No refund behavior is redesigned.
--
-- Scope discipline: 0153/0154 are already applied and are NOT edited
-- here. No other function, table, grant, or Stripe refund architecture
-- is touched.
--
-- Apply in Supabase SQL Editor (cloud only).

begin;

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
  -- own financial identity is ever touched.
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

  -- Trusted provenance (locked decision 3/5): the payment's own latest
  -- COMPLETED online attempt — never the club's currently-configured
  -- Stripe connection.
  select * into v_source
    from public.payment_checkout_attempts pca
   where pca.payment_id = p_payment_id and pca.status = 'completed'
   order by pca.created_at desc
   limit 1
   for update;
  if not found then
    raise exception 'no_online_payment_to_refund';
  end if;

  -- Stripe-refundable ceiling for THIS specific completed attempt only
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
-- Rollback (manual, cloud SQL Editor) — restores the EXACT pre-0155
-- (originally shipped 0153) body, including its unqualified, ambiguous
-- references. Uncomment and run top-to-bottom only if 0155 must be
-- reverted; note this knowingly restores the 42702 runtime bug.
-- ═══════════════════════════════════════════════════════════════════════════
-- begin;
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
--     from public.payment_refund_attempts
--    where payment_id = p_payment_id and stripe_refund_id is null and status = 'pending'
--    for update;
--
--   if found then
--     if v_existing_pending.requested_amount_cents <> p_requested_amount_cents then
--       raise exception 'pending_refund_amount_mismatch';
--     end if;
--     select * into v_source from public.payment_checkout_attempts where id = v_existing_pending.source_checkout_attempt_id;
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
--     from public.payment_checkout_attempts
--    where payment_id = p_payment_id and status = 'completed'
--    order by created_at desc
--    limit 1
--    for update;
--   if not found then
--     raise exception 'no_online_payment_to_refund';
--   end if;
--
--   -- Stripe-refundable ceiling for THIS specific completed attempt only
--   -- (locked decision 1) — never payments.amount_paid_cents, which nets
--   -- manual money in too.
--   select coalesce(sum(requested_amount_cents), 0) into v_reserved_total
--     from public.payment_refund_attempts
--    where source_checkout_attempt_id = v_source.id
--      and status in ('succeeded', 'pending', 'requires_action');
--
--   v_refundable := v_source.amount_expected_cents - v_reserved_total;
--   if p_requested_amount_cents > v_refundable then
--     raise exception 'refund_exceeds_online_remaining';
--   end if;
--
--   insert into public.payment_refund_attempts (
--     club_id, payment_id, source_checkout_attempt_id, stripe_account_id, livemode,
--     stripe_payment_intent_id, requested_amount_cents, status, admin_reason, created_by
--   ) values (
--     p_club_id, p_payment_id, v_source.id, v_source.stripe_account_id, v_source.livemode,
--     v_source.stripe_payment_intent_id, p_requested_amount_cents, 'pending', p_admin_reason, p_actor_id
--   ) returning id into v_result_id;
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
