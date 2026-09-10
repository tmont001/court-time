-- 0172_financial_reporting_summary.sql
-- Admin Cleanup Checkpoint 6 — Financial Analytics + Reports Export.
-- One narrow, read-only RPC providing the range-scoped money-in/money-out
-- aggregate consumed identically by /admin/payments Overview and
-- /admin/reports Financial Summary (and, transitively, the Reports CSV
-- export, which reuses the same already-fetched values rather than
-- re-querying). Outstanding (a CURRENT SNAPSHOT, not a range metric) is
-- deliberately NOT computed here — see src/lib/financialSummary.ts, which
-- reuses the EXISTING, already-hardened Outstanding Balances computation
-- (selectLatestGenuinelyOutstandingPayments + hydrateExportDomainContext,
-- both already used by exportActions.ts's Outstanding Balances CSV) rather
-- than reimplementing its multi-table domain-collectibility joins in SQL.
--
-- CORRECTION (still pre-application) — domain identifier ambiguity: the
-- function's own RETURNS TABLE column `domain` doubles as a plpgsql
-- variable in this function's namespace. The original draft's unqualified
-- `... as domain ... group by domain` risked plpgsql resolving `domain`
-- against that variable rather than the query's own computed value. Fixed
-- by computing the domain mapping in a CTE (financial_events, aliased fe)
-- and referencing it only as the fully-qualified fe.domain throughout —
-- see the function body's own comment at the point of the fix for detail.
-- No other behavior changed.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- AUTHORITATIVE SOURCE AUDIT (informs every decision below)
-- ═══════════════════════════════════════════════════════════════════════════
-- payment_events is the append-only canonical ledger (0143). Money-in and
-- money-out event types, confirmed current as of 0150/0153 (the last
-- migrations to touch payment_events'/event_type or _recompute_payment_
-- rollup):
--   money in:  manual_payment_recorded, online_payment_recorded
--   money out: refund_recorded, online_refund_recorded
-- payments.amount_paid_cents (the "net" column) is itself defined,
-- unchanged, as exactly:
--   SUM(money-in event amounts) - SUM(money-out event amounts)
--   over NON-REVERSED events only (reverse_payment_event nullifies its
--   target via the reverses_event_id linkage — a partial unique index
--   guarantees at most one reversal per target event).
-- This migration's Collected/Refunded aggregates use that EXACT same
-- event-type partition and the EXACT same non-reversed exclusion, merely
-- scoped to a date range instead of all-time — never a competing formula.
--
-- Disputes (payment_disputes) are a STRUCTURALLY SEPARATE table with no
-- relationship to payment_events at all — a dispute being opened, lost, or
-- won never by itself inserts a refund_recorded/online_refund_recorded row
-- (confirmed: online_refund_recorded is inserted ONLY by the Stripe refund
-- reconciliation path, 0153, on a genuine Stripe Refund object reaching
-- 'succeeded'). This RPC never reads payment_disputes, so a dispute can
-- never be miscounted as a refund by construction, not by a filter this
-- code has to remember to apply.
--
-- Domain breakdown uses a real foreign-key join (payment_events.payment_id
-- -> payments.id, the same composite FK the ledger's own shape constraint
-- relies on) — never a heuristic/fuzzy join — grouping by payments.
-- domain_type, the same column value admin/payments/page.tsx already reads
-- directly today.
-- ═══════════════════════════════════════════════════════════════════════════

-- ---------------------------------------------------------------------------
-- get_financial_range_summary — one row per domain (reservation / lesson /
-- event / program / other), each with that domain's collected/refunded
-- totals for the selected club-local date range. Callers sum across rows
-- for grand totals and derive net_collected = collected - refunded
-- themselves (kept out of SQL so the LOCKED relationship is visibly
-- enforced once, in the shared TypeScript layer, not duplicated per call
-- site — see src/lib/financialSummary.ts).
--
-- Admin-only, club-scoped, fails LOUD (raises, matching get_reporting_
-- overview's own established convention for this RPC family — not the
-- fail-closed-to-empty-rows convention used by the Communications RPCs,
-- which serve a UI that already renders a plain empty state either way;
-- Reports' page.tsx already has a uniform RPC-failure handling path this
-- matches by raising the same way its five siblings do).
--
-- Reuses club_local_bounds (0095) for the exact same DST-safe, half-open
-- [start local midnight, day-after-end local midnight) boundary every
-- other Reports RPC already uses — never a second date-boundary
-- implementation.
-- ---------------------------------------------------------------------------
create or replace function public.get_financial_range_summary(
  p_start_date date,
  p_end_date   date
)
returns table (
  domain          text,
  collected_cents bigint,
  refunded_cents  bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_range   tstzrange;
begin
  v_club_id := public.current_user_club_id();
  v_role    := public.current_user_role();

  if v_club_id is null then
    raise exception 'not_authenticated';
  end if;

  if v_role <> 'admin' then
    raise exception 'insufficient_role';
  end if;

  v_range := public.club_local_bounds(v_club_id, p_start_date, p_end_date);

  -- Correction (still pre-application) — domain identifier ambiguity: this
  -- function's RETURNS TABLE column `domain` is ALSO a plpgsql variable in
  -- this function's own namespace (every OUT parameter of a RETURNS TABLE
  -- function is implicitly one). An unqualified `domain` in the original
  -- draft's SELECT-list alias and GROUP BY clause was therefore ambiguous
  -- at the plpgsql level, not just to a human reader — plpgsql resolves a
  -- bare identifier against its own variables before the SQL engine ever
  -- sees it, so `group by domain` risked binding to the (uninitialized)
  -- OUT parameter rather than the query's own computed value. Fixed by
  -- computing the domain mapping in a CTE with its own alias (fe) and
  -- referencing it ONLY in fully table-qualified form (fe.domain)
  -- throughout — structurally unambiguous, never relying on plpgsql's
  -- variable-vs-column disambiguation at all.
  return query
    with financial_events as (
      select
        case p.domain_type
          when 'reservation'        then 'reservation'
          when 'lesson_request'     then 'lesson'
          when 'event_participant'  then 'event'
          when 'event_guest'        then 'event'
          when 'program_enrollment' then 'program'
          else 'other'
        end as domain,
        pe.amount_cents,
        pe.event_type
      from public.payment_events pe
      join public.payments p on p.id = pe.payment_id
      where pe.club_id = v_club_id
        and pe.event_type in (
          'manual_payment_recorded', 'online_payment_recorded',
          'refund_recorded', 'online_refund_recorded'
        )
        and pe.occurred_at >= lower(v_range)
        and pe.occurred_at <  upper(v_range)
        and pe.id not in (
          select reverses_event_id
            from public.payment_events
           where reverses_event_id is not null
             and club_id = v_club_id
        )
    )
    select
      fe.domain,
      coalesce(sum(fe.amount_cents) filter (
        where fe.event_type in ('manual_payment_recorded', 'online_payment_recorded')
      ), 0)::bigint as collected_cents,
      coalesce(sum(fe.amount_cents) filter (
        where fe.event_type in ('refund_recorded', 'online_refund_recorded')
      ), 0)::bigint as refunded_cents
    from financial_events fe
    group by fe.domain;
end;
$$;

revoke execute on function public.get_financial_range_summary(date, date) from public, anon;
grant  execute on function public.get_financial_range_summary(date, date) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run manually after applying — NOT executed automatically by
-- this file; NOT applied by this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. As an Admin, confirm a basic call succeeds and totals reconcile against
--    a known payment:
--      select * from get_financial_range_summary(current_date - 30, current_date);
--    For any single domain row, collected_cents - refunded_cents should
--    match the sum of amount_paid_cents deltas you'd expect from manually
--    inspecting payment_events for that domain/range.
-- 2. Confirm reversed events are excluded: record a manual payment, reverse
--    it, and confirm it contributes 0 to collected_cents for that range.
-- 3. Confirm a dispute alone (no real refund_recorded/online_refund_recorded
--    event) never appears in refunded_cents — open/update a payment_disputes
--    row with no matching refund event and re-run the query; refunded_cents
--    must be unaffected.
-- 4. Confirm overpayment is NOT capped: a payment collecting more than its
--    amount_due_cents must still contribute its FULL collected amount here,
--    not clamped to amount_due_cents.
-- 5. Confirm cross-club isolation: an Admin from Club B never sees Club A's
--    amounts.
-- 6. Confirm fail-loud behavior: called as Staff/Pro/Member, expect an
--    error containing 'insufficient_role', not a zero-row silent result
--    (this RPC's family raises rather than fails closed to empty — see the
--    function's own header comment for why that matches Reports'
--    convention specifically).
-- 7. Confirm anon/public cannot execute at all (permission denied, not a
--    zero-row result).
-- 8. Confirm the domain-ambiguity fix: a club with activity across two or
--    more distinct domains (e.g. a reservation payment and an event
--    payment) in the same range must return one row PER domain with
--    correct, distinct collected_cents/refunded_cents — never a single
--    collapsed row, never a function-call error at all (the original
--    unqualified GROUP BY domain draft was never applied, so there is no
--    "before" behavior to compare against — this simply confirms the
--    function executes and groups correctly as written).
-- ═══════════════════════════════════════════════════════════════════════════
-- End of 0172_financial_reporting_summary.sql
-- ═══════════════════════════════════════════════════════════════════════════
