-- 0182_fix_refund_request_execution_ambiguity.sql
-- Phase 38B runtime QA follow-up — column-reference ambiguity fix, same bug
-- class 0155 already fixed once for open_payment_refund_attempt, now
-- confirmed and fixed in public.begin_refund_request_execution (0181).
--
-- ── The problem (live runtime evidence) ──────────────────────────────────
-- A live call to begin_refund_request_execution(...) failed immediately
-- with:
--
--   ERROR 42702: column reference "id" is ambiguous
--
-- Root cause: this function's own `returns table (id uuid, payment_id
-- uuid, club_id uuid, source_checkout_attempt_id uuid, stripe_account_id
-- text, livemode boolean, stripe_checkout_session_id text, stripe_
-- payment_intent_id text, requested_amount_cents integer, status text,
-- currency text)` clause implicitly declares each of those names as a
-- PL/pgSQL OUT variable, in scope for the entire function body — exactly
-- the class of bug 0154/0155 already fixed once for get_online_
-- refundable_amount_for_payments/open_payment_refund_attempt. A full
-- re-audit of the currently-applied 0181 body found FIVE unqualified
-- table-column references that collide with these OUT variables (`id`
-- and/or `club_id`), all against tables that genuinely have columns by
-- those names:
--
--   1. `from public.payment_refund_requests
--       where id = p_request_id and club_id = p_club_id`
--      (id, club_id) — the initial non-locking probe (step A). This is
--      the FIRST statement reached on every call, so every invocation
--      failed here immediately, exactly matching the live evidence.
--   2. `from public.payments
--       where id = v_probe.payment_id and club_id = p_club_id
--       for update`
--      (id, club_id) — the payment lock (step B).
--   3. `from public.payment_refund_requests
--       where id = p_request_id and club_id = p_club_id
--       for update`
--      (id, club_id) — the request lock/re-read (step C).
--   4. `from public.payment_refund_attempts
--       where id = v_request.refund_attempt_id`
--      (id) — resolving the linked attempt.
--   5. `update public.payment_refund_requests
--       set refund_attempt_id = v_new.id, reviewed_by = p_actor_id,
--           reviewed_at = now()
--       where id = p_request_id`
--      (id) — the fresh-attempt-linking UPDATE.
--
-- Separately audited and confirmed SAFE (no fix needed): every OTHER
-- reference to these column names inside the function is already
-- qualified through a `%rowtype`/`record` variable field access
-- (`v_probe.payment_id`, `v_payment.id`, `v_request.status`,
-- `v_attempt.id`, `v_new.id`, etc.) — those are unambiguous variable-
-- field accesses, never a bare column name, and were never at risk. The
-- two `select ... into v_source from public.payment_checkout_attempts
-- pca where pca.id = ...` reads were already alias-qualified in 0181 and
-- needed no change. The UPDATE statement's own SET-list target columns
-- (`refund_attempt_id`, `reviewed_by`, `reviewed_at`) are required by
-- SQL syntax to stay unqualified there and do not collide with any OUT
-- variable name regardless.
--
-- ── The fix ───────────────────────────────────────────────────────────
-- CREATE OR REPLACE of ONLY public.begin_refund_request_execution(uuid,
-- uuid, uuid), starting from the exact currently-applied 0181 body. Every
-- table reference throughout the ENTIRE function is now explicitly
-- alias-qualified — payment_refund_requests r, payments p, payment_
-- refund_attempts pra, payment_checkout_attempts pca — matching 0155's
-- own established alias choices for open_payment_refund_attempt exactly,
-- not merely the five sites that currently fail, so no latent,
-- not-yet-triggered ambiguity remains either.
--
-- Preserved exactly, unchanged: function signature and RETURNS TABLE
-- shape, SECURITY DEFINER, pinned search_path, service-role-only grants,
-- the payment-first lock order (payments row locked before the request
-- row, request locked before any attempt is inspected), the request
-- revalidation after both locks are held, the pending/requires_action
-- reuse branch, the failed/canceled fresh-attempt branch, the succeeded
-- heal branch (via the unmodified _complete_refund_request_for_attempt),
-- reviewed_by/reviewed_at semantics (set only on a fresh-attempt branch,
-- never on reuse/heal), the call into the existing, unmodified
-- open_payment_refund_attempt using ONLY the stored request amount, and
-- every existing error code (invalid_arguments, request_not_found,
-- payment_not_found, request_not_pending, plus whatever open_payment_
-- refund_attempt itself raises). No behavior is redesigned.
--
-- Scope discipline: 0181 is already applied and is NOT edited here (it
-- cannot be — this is a corrective forward migration). No other
-- function, table, grant, or Stripe refund architecture is touched —
-- create_refund_request, get_pending_refund_requests_for_payments,
-- reject_refund_request, _complete_refund_request_for_attempt, and
-- _reconcile_stripe_refund_attempt are all already correctly qualified
-- (re-confirmed by direct re-read) and are not redefined here.
--
-- Apply in Supabase SQL Editor (cloud only).

begin;

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
  -- request before the payment. Alias-qualified (correction pass, 0182)
  -- — see this migration's own header comment.
  select * into v_probe
    from public.payment_refund_requests r
   where r.id = p_request_id and r.club_id = p_club_id;
  if not found then
    raise exception 'request_not_found';
  end if;

  -- B. Payment lock FIRST — the canonical top-level serialization point
  -- for this whole domain, matching open_payment_refund_attempt/
  -- _reconcile_stripe_refund_attempt exactly.
  select * into v_payment
    from public.payments p
   where p.id = v_probe.payment_id and p.club_id = p_club_id
   for update;
  if not found then
    raise exception 'payment_not_found';
  end if;

  -- C. Lock and RE-READ the request row SECOND.
  select * into v_request
    from public.payment_refund_requests r
   where r.id = p_request_id and r.club_id = p_club_id
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
    -- "LOCK ORDER" comment history (0181) for the full argument.
    select * into v_attempt
      from public.payment_refund_attempts pra
     where pra.id = v_request.refund_attempt_id;

    if v_attempt.status = 'succeeded' then
      -- HEAL — never call Stripe again. Idempotent via the shared
      -- completion helper (also used by _reconcile_stripe_refund_attempt
      -- itself) — a no-op if already completed by the time this runs.
      perform public._complete_refund_request_for_attempt(v_attempt.id);

      select * into v_source from public.payment_checkout_attempts pca where pca.id = v_attempt.source_checkout_attempt_id;
      return query select
        v_attempt.id, v_attempt.payment_id, v_attempt.club_id, v_attempt.source_checkout_attempt_id,
        v_attempt.stripe_account_id, v_attempt.livemode, v_source.stripe_checkout_session_id,
        v_attempt.stripe_payment_intent_id, v_attempt.requested_amount_cents, v_attempt.status, v_payment.currency;
      return;

    elsif v_attempt.status in ('pending', 'requires_action') then
      -- REUSE — same Stripe idempotency identity (payment-refund:<id>),
      -- no new attempt, reviewed_by/reviewed_at untouched (this click did
      -- not initiate the in-flight execution; a prior one did).
      select * into v_source from public.payment_checkout_attempts pca where pca.id = v_attempt.source_checkout_attempt_id;
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

  update public.payment_refund_requests r
     set refund_attempt_id = v_new.id,
         reviewed_by       = p_actor_id,
         reviewed_at       = now()
   where r.id = p_request_id;

  return query select
    v_new.id, v_new.payment_id, v_new.club_id, v_new.source_checkout_attempt_id,
    v_new.stripe_account_id, v_new.livemode, v_new.stripe_checkout_session_id,
    v_new.stripe_payment_intent_id, v_new.requested_amount_cents, v_new.status, v_new.currency;
end;
$$;

revoke execute on function public.begin_refund_request_execution(uuid, uuid, uuid) from public, anon, authenticated;
grant  execute on function public.begin_refund_request_execution(uuid, uuid, uuid) to service_role;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback (manual, cloud SQL Editor) — fully executable: restores the
-- exact pre-0182 (0181) body verbatim, ambiguous references included.
-- ═══════════════════════════════════════════════════════════════════════════
-- begin;
--
-- create or replace function public.begin_refund_request_execution(
--   p_request_id uuid,
--   p_club_id    uuid,
--   p_actor_id   uuid
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
-- set search_path = public, pg_temp
-- as $$
-- declare
--   v_probe   public.payment_refund_requests%rowtype;
--   v_request public.payment_refund_requests%rowtype;
--   v_payment public.payments%rowtype;
--   v_attempt public.payment_refund_attempts%rowtype;
--   v_source  public.payment_checkout_attempts%rowtype;
--   v_new     record;
-- begin
--   if p_request_id is null or p_club_id is null or p_actor_id is null then
--     raise exception 'invalid_arguments';
--   end if;
--
--   select * into v_probe
--     from public.payment_refund_requests
--    where id = p_request_id and club_id = p_club_id;
--   if not found then
--     raise exception 'request_not_found';
--   end if;
--
--   select * into v_payment
--     from public.payments
--    where id = v_probe.payment_id and club_id = p_club_id
--    for update;
--   if not found then
--     raise exception 'payment_not_found';
--   end if;
--
--   select * into v_request
--     from public.payment_refund_requests
--    where id = p_request_id and club_id = p_club_id
--    for update;
--
--   if not found or v_request.payment_id <> v_payment.id then
--     raise exception 'request_not_found';
--   end if;
--   if v_request.status <> 'pending' then
--     raise exception 'request_not_pending';
--   end if;
--
--   if v_request.refund_attempt_id is not null then
--     select * into v_attempt
--       from public.payment_refund_attempts
--      where id = v_request.refund_attempt_id;
--
--     if v_attempt.status = 'succeeded' then
--       perform public._complete_refund_request_for_attempt(v_attempt.id);
--
--       select * into v_source from public.payment_checkout_attempts pca where pca.id = v_attempt.source_checkout_attempt_id;
--       return query select
--         v_attempt.id, v_attempt.payment_id, v_attempt.club_id, v_attempt.source_checkout_attempt_id,
--         v_attempt.stripe_account_id, v_attempt.livemode, v_source.stripe_checkout_session_id,
--         v_attempt.stripe_payment_intent_id, v_attempt.requested_amount_cents, v_attempt.status, v_payment.currency;
--       return;
--
--     elsif v_attempt.status in ('pending', 'requires_action') then
--       select * into v_source from public.payment_checkout_attempts pca where pca.id = v_attempt.source_checkout_attempt_id;
--       return query select
--         v_attempt.id, v_attempt.payment_id, v_attempt.club_id, v_attempt.source_checkout_attempt_id,
--         v_attempt.stripe_account_id, v_attempt.livemode, v_source.stripe_checkout_session_id,
--         v_attempt.stripe_payment_intent_id, v_attempt.requested_amount_cents, v_attempt.status, v_payment.currency;
--       return;
--     end if;
--   end if;
--
--   select * into v_new
--     from public.open_payment_refund_attempt(
--       v_request.payment_id, p_club_id, v_request.requested_amount_cents, p_actor_id, null
--     );
--
--   update public.payment_refund_requests
--      set refund_attempt_id = v_new.id,
--          reviewed_by       = p_actor_id,
--          reviewed_at       = now()
--    where id = p_request_id;
--
--   return query select
--     v_new.id, v_new.payment_id, v_new.club_id, v_new.source_checkout_attempt_id,
--     v_new.stripe_account_id, v_new.livemode, v_new.stripe_checkout_session_id,
--     v_new.stripe_payment_intent_id, v_new.requested_amount_cents, v_new.status, v_new.currency;
-- end;
-- $$;
--
-- revoke execute on function public.begin_refund_request_execution(uuid, uuid, uuid) from public, anon, authenticated;
-- grant  execute on function public.begin_refund_request_execution(uuid, uuid, uuid) to service_role;
--
-- commit;
