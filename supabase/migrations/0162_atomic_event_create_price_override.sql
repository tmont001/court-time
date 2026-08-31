-- 0162_atomic_event_create_price_override.sql
-- Phase 34F-B — pre-commit correction: atomic Admin custom-price Event
-- creation.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE PROBLEM (runtime QA, this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- The prior Create Event polish pass implemented a custom per-event price
-- as TWO separately committed calls: create_event (0141, unchanged),
-- returning the new Event id to the client, followed by a SECOND,
-- independent Server Action round-trip calling set_event_price_override
-- (0141, unchanged) with the Admin's intended price. Between those two
-- commits, the Event exists, at the Event Type's own DEFAULT price, and is
-- externally joinable/discoverable — a concurrent join_event during that
-- window would snapshot the wrong (default, not the Admin's intended
-- custom) price onto that participant's own event_participants.
-- price_amount_cents, permanently (per_participant price is snapshotted
-- once, at commit time, and is never retroactively corrected by a later
-- price change — this migration does not touch that locked invariant).
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE FIX
-- ═══════════════════════════════════════════════════════════════════════════
-- One new function, create_event_with_price_override, composes the
-- EXISTING, UNMODIFIED create_event and set_event_price_override via two
-- ordinary PL/pgSQL function calls inside ONE function body. Neither
-- create_event nor set_event_price_override is redefined, rewritten, or
-- duplicated internally anywhere below — every validation/insert/audit-log
-- statement either function performs remains entirely theirs, called by
-- reference. A single top-level PL/pgSQL function invocation is always one
-- Postgres transaction (there is no COMMIT available inside a plain
-- LANGUAGE plpgsql FUNCTION, only inside a PROCEDURE with explicit
-- transaction control, which this deliberately is not) — so if
-- set_event_price_override's own validation raises (e.g. invalid_price),
-- the entire transaction rolls back, including create_event's own INSERT
-- into events and its child reservations rows. No externally-visible
-- intermediate Event at the Event Type default price can ever exist for
-- this path: either both the Event and its custom price commit together,
-- or neither commits at all.
--
-- This composition pattern (a new, thin wrapper calling existing SECURITY
-- DEFINER functions by reference, never duplicating their bodies) is the
-- SAME one already proven throughout 34F-A/34F-B's own Checkout
-- architecture (open_event_payment_checkout_attempt delegating to
-- open_payment_checkout_attempt, etc.) — auth.uid()/current_user_role()
-- resolve from the session's JWT claims, not from call-nesting depth, so
-- composing two SECURITY DEFINER functions this way carries no privilege
-- ambiguity.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- SEMANTICS PRESERVED
-- ═══════════════════════════════════════════════════════════════════════════
-- p_price_amount_cents is NULLABLE, mirroring set_event_price_override's
-- own signature exactly: NULL = explicit "no price" override, 0 = explicit
-- Free, a positive integer = a genuine custom price. "Use the Event Type
-- default" is NOT expressible through this function at all — that path
-- continues to call plain create_event directly, which is entirely
-- untouched, still snapshots the Event Type's own current default, and
-- remains reachable by every role create_event already allows (pro, admin,
-- staff). This new function is Admin-pricing-authority-only, exactly like
-- set_event_price_override, and is never the path for an unmodified/
-- default-price creation.
--
-- Apply in Supabase SQL Editor (cloud only). NOT YET APPLIED — this
-- checkpoint stops after implementation + static validation, per explicit
-- instruction.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. create_event_with_price_override — Admin-only, atomic
-- ═══════════════════════════════════════════════════════════════════════════
-- Same authentication/role gate as set_event_price_override (checked HERE,
-- BEFORE create_event ever runs, so a non-admin caller — unreachable in
-- practice, since the Server Action only ever calls this function when
-- isAdmin is already true client-side, but re-verified server-side as
-- defense in depth like every other Admin-only RPC in this codebase —
-- fails fast with a single clean error rather than creating an Event that
-- then gets rolled back a moment later by set_event_price_override's own
-- identical check). p_price_amount_cents is validated up front too (same
-- rule set_event_price_override itself enforces) purely so an invalid
-- price never even reaches the (otherwise-wasted, would-be-rolled-back)
-- create_event insert — not required for atomicity, since a raise from
-- set_event_price_override's own later check would roll back identically
-- either way; this is a fail-fast efficiency/clarity choice only.
create or replace function public.create_event_with_price_override(
  p_event_type_id      uuid,
  p_title               text,
  p_starts_at           timestamp with time zone,
  p_ends_at             timestamp with time zone,
  p_court_ids           uuid[],
  p_price_amount_cents  integer,
  p_description         text default null::text,
  p_capacity            integer default null::integer,
  p_notes               text default null::text,
  p_member_joinable     boolean default true
)
returns events
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_profile profiles%rowtype;
  v_event   events%rowtype;
  v_result  events%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  -- Mirrors set_event_price_override's own exact Admin-only gate (0141) —
  -- deliberately duplicated here (not "widened" anywhere) so the failure
  -- happens before create_event's own INSERT, never after it.
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  if p_price_amount_cents is not null and p_price_amount_cents < 0 then
    raise exception 'invalid_price';
  end if;

  -- Delegates entirely to the existing, unmodified create_event — every
  -- one of its own checks (account_inactive, invalid_duration,
  -- event_type_not_found, etc.) and its own event_type-default price
  -- snapshot still run exactly as they always have; that snapshot is
  -- immediately overwritten below by the Admin's intended override, in
  -- the SAME transaction.
  v_event := public.create_event(
    p_event_type_id, p_title, p_starts_at, p_ends_at, p_court_ids,
    p_description, p_capacity, p_notes, p_member_joinable
  );

  -- Delegates entirely to the existing, unmodified set_event_price_override
  -- — its own audit_log entry ('set_event_price_override') is written
  -- exactly as it always is, now inside this same transaction as the
  -- Event's own creation.
  v_result := public.set_event_price_override(v_event.id, p_price_amount_cents);

  return v_result;
end;
$$;

revoke execute on function public.create_event_with_price_override(uuid, text, timestamptz, timestamptz, uuid[], integer, text, integer, text, boolean) from public, anon;
grant  execute on function public.create_event_with_price_override(uuid, text, timestamptz, timestamptz, uuid[], integer, text, integer, text, boolean) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created)
-- ═══════════════════════════════════════════════════════════════════════════
-- This migration adds exactly one brand-new function — it does not
-- redefine create_event or set_event_price_override (both remain byte-
-- identical to their 0141 bodies; neither appears in a CREATE OR REPLACE
-- anywhere above). Rollback is therefore a straightforward DROP FUNCTION —
-- no historical migration text is rewritten.
--
-- begin;
-- drop function if exists public.create_event_with_price_override(uuid, text, timestamptz, timestamptz, uuid[], integer, text, integer, text, boolean);
-- commit;
