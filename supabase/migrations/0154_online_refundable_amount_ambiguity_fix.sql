-- 0154_online_refundable_amount_ambiguity_fix.sql
-- Phase 34E-B runtime QA follow-up — column-reference ambiguity fix.
--
-- ── The problem (runtime evidence) ───────────────────────────────────────
-- A fresh, fully paid, online (Stripe) Court Time payment with a
-- completed Checkout attempt and zero refund attempts against it did not
-- show a Refund button on /admin/payments, even on the "All" tab. An
-- authenticated Admin-session diagnostic against public.get_online_
-- refundable_amount_for_payments(uuid[]) for that exact payment id
-- returned:
--
--   rpc_error_message = column reference "payment_id" is ambiguous
--   rpc_error_code    = 42702
--
-- Root cause: the function's own `returns table (payment_id uuid,
-- refundable_cents integer, currency text)` clause implicitly declares
-- payment_id/refundable_cents/currency as PL/pgSQL variables, in scope for
-- the entire function body. Inside the `latest` CTE (0153's originally
-- shipped body), the select list and ORDER BY reference `payment_id` and
-- `currency` UNQUALIFIED:
--
--   latest as (
--     select distinct on (payment_id) attempt_id, payment_id,
--       amount_expected_cents, currency
--       from sources
--      order by payment_id, created_at desc
--   )
--
-- Postgres cannot tell whether these unqualified names mean the `sources`
-- CTE's own columns or the function's OUT parameter variables of the same
-- name, and raises 42702 at every call — this function has therefore
-- never successfully returned a row since 0153 was applied; every caller
-- silently received `{ data: null, error }`, and page.tsx's own `(data ??
-- []).map(...)` masked that into "0 refundable" for every payment, every
-- time.
--
-- ── The fix ───────────────────────────────────────────────────────────
-- CREATE OR REPLACE of ONLY public.get_online_refundable_amount_for_
-- payments(uuid[]), starting from the exact currently-applied 0153 body,
-- changed in exactly one place: the `latest` CTE now reads from `sources
-- s` and qualifies every column reference in its select list and ORDER BY
-- with `s.`, so none can be confused with the function's own OUT
-- parameters. The final `select` was already fully qualified via its own
-- `latest l` / `reserved r` aliases and is untouched. No other section of
-- this function contains an unqualified payment_id/refundable_cents/
-- currency reference (verified by direct re-read of the 0153 body).
--
-- Preserved exactly, unchanged: Admin/staff-only authorization
-- (not_authenticated/insufficient_role), the authenticated EXECUTE grant,
-- latest-completed-attempt-per-payment semantics, the succeeded/pending/
-- requires_action reservation subtraction, greatest(..., 0) flooring, and
-- the function's return shape/signature.
--
-- Scope discipline: 0153 is already applied and is NOT edited here. No
-- other function, table, grant, or Stripe refund architecture is touched.
--
-- Apply in Supabase SQL Editor (cloud only).

begin;

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
    latest as (
      select distinct on (s.payment_id)
        s.attempt_id,
        s.payment_id,
        s.amount_expected_cents,
        s.currency
      from sources s
      order by s.payment_id, s.created_at desc
    ),
    reserved as (
      select source_checkout_attempt_id as attempt_id, coalesce(sum(requested_amount_cents), 0) as reserved_cents
        from public.payment_refund_attempts
       where club_id = v_club_id
         and status in ('succeeded', 'pending', 'requires_action')
       group by source_checkout_attempt_id
    )
    select l.payment_id, greatest(l.amount_expected_cents - coalesce(r.reserved_cents, 0), 0)::integer, l.currency
      from latest l
      left join reserved r on r.attempt_id = l.attempt_id;
end;
$$;

revoke execute on function public.get_online_refundable_amount_for_payments(uuid[]) from public, anon;
grant  execute on function public.get_online_refundable_amount_for_payments(uuid[]) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback (manual, cloud SQL Editor) — restores the EXACT pre-0154
-- (originally shipped 0153) body, including its ambiguous unqualified
-- `latest` CTE references. Uncomment and run top-to-bottom only if 0154
-- must be reverted; note this knowingly restores the 42702 runtime bug.
-- ═══════════════════════════════════════════════════════════════════════════
-- begin;
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
--       select distinct on (payment_id) attempt_id, payment_id, amount_expected_cents, currency
--         from sources
--        order by payment_id, created_at desc
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
-- commit;
