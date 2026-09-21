-- 0202_peak_off_peak_price_preview_currency_fix.sql
-- Peak / Off-Peak Pricing — Checkpoint B, Part 1 hotfix. 0201 (the
-- preview_court_reservation_price RPC) is APPLIED and IMMUTABLE — this
-- migration does not edit it, it republishes the same function via
-- CREATE OR REPLACE (identical signature, no DROP needed) with one
-- functional correction.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Live QA on the applied 0201 function found a runtime failure:
--
--   ERROR 42702: column reference "currency" is ambiguous
--   DETAIL: It could refer to either a PL/pgSQL variable or a table
--   column.
--
-- The failing statement:
--   select currency into v_currency
--     from public.club_settings
--    where club_id = v_club_id;
--
-- `currency` is also one of this function's own RETURNS TABLE output
-- columns (an implicit PL/pgSQL variable in scope for the whole function
-- body), so the unqualified column reference inside this SELECT is
-- genuinely ambiguous between that output variable and
-- club_settings.currency — Postgres correctly refuses to guess. The fix
-- is a plain explicit table alias, exactly as instructed: `cs.currency`
-- from `public.club_settings cs`.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- SCOPE
-- ═══════════════════════════════════════════════════════════════════════════
-- CREATE OR REPLACE ONLY public.preview_court_reservation_price(uuid,
-- timestamptz, timestamptz, uuid, uuid) — the exact 0201 body, verbatim,
-- with the one line above replaced by its explicitly-aliased equivalent.
-- No other line changed. Signature unchanged, so no DROP is needed and no
-- other object (the two REVOKE/GRANT statements included) needs to be
-- reissued for a new overload — Postgres treats this as the same function
-- identity.
--
-- Every other behavior is preserved byte-for-byte from 0201: SECURITY
-- DEFINER, STABLE, hardened search_path, authenticated-only EXECUTE
-- (public/anon revoked), the self-service account_inactive check, the
-- self-service member_self_service capability check, caller-owned roster
-- identity resolution via current_user_roster_member_id(), the
-- Admin/Staff explicit-target authorization (role check, required
-- p_expected_club_id, same-club roster lookup), the universal stale-club
-- guard, active-court validation, the 30/60/90/120 supported-duration
-- check, canonical is_active_club_member classification, verbatim reuse
-- of public._resolve_court_reservation_rate (0200, immutable, untouched),
-- the exact price_amount_cents formula, and zero writes (no reservation,
-- payment obligation, checkout, or pricing mutation of any kind).
--
-- Explicitly NOT touched: 0200 (all of it), 0201 (this migration
-- republishes the same function identity via CREATE OR REPLACE rather
-- than editing 0201's own file), create_reservation,
-- admin_create_member_reservation, update_member_reservation,
-- update_club_pricing, Stripe/payment ledger architecture, any frontend
-- file, any UI wiring (Checkpoint C).
--
-- Not applied by this checkpoint. Do not create 0203.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace function public.preview_court_reservation_price(
  p_court_id          uuid,
  p_starts_at         timestamptz,
  p_ends_at           timestamptz,
  p_roster_member_id  uuid default null,
  p_expected_club_id  uuid default null
)
returns table (
  membership_pricing_class text,
  hourly_rate_cents        integer,
  price_amount_cents       integer,
  currency                 text,
  applied_rate_source      text,
  applied_rate_period_id   uuid,
  applied_rate_period_name text
)
language plpgsql
security definer
stable
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id                  uuid;
  v_role                     text;
  v_profile                  public.profiles%rowtype;
  v_court                    public.courts%rowtype;
  v_roster                   public.roster_members%rowtype;
  v_target_roster_member_id  uuid;
  v_membership_pricing_class text;
  v_rate_resolution          record;
  v_price_amount_cents       integer;
  v_currency                 text;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  select
    public.current_user_club_id(),
    public.current_user_role()
  into
    v_club_id,
    v_role;

  if v_club_id is null then
    raise exception 'not_authenticated';
  end if;

  -- Universal stale-context guard: if the caller supplies ANY expected
  -- club id (required below for the explicit-target branch, optional for
  -- self-service), it must match the caller's own current club.
  if p_expected_club_id is not null and p_expected_club_id is distinct from v_club_id then
    raise exception 'stale_club_context';
  end if;

  if p_roster_member_id is not null then
    -- Admin/Staff previewing on behalf of an explicit, same-club roster
    -- Member — the SAME authorization gate admin_create_member_reservation
    -- (0189/0190) already enforces for this exact operator workflow. Never
    -- widened: a Member or Pro supplying this parameter is rejected
    -- outright, regardless of whose id it names.
    if v_role not in ('admin', 'staff') then
      raise exception 'insufficient_role';
    end if;

    -- Mirrors admin_create_member_reservation's own REQUIRED (non-default)
    -- p_expected_club_id stale-context parameter — the explicit-target
    -- workflow always supplies one; a preview reaching this branch without
    -- it fails closed rather than silently skipping the guard.
    if p_expected_club_id is null then
      raise exception 'stale_club_context';
    end if;

    select * into v_roster
      from public.roster_members
     where id = p_roster_member_id
       and club_id = v_club_id;
    if not found then
      raise exception 'roster_member_not_found';
    end if;

    v_target_roster_member_id := p_roster_member_id;
  else
    -- Self-service preview — the SAME active-profile invariant
    -- create_reservation (0190) enforces before its own capability gate:
    -- a Member/Admin/Pro whose profile row is not 'active' cannot create
    -- a self-service booking, so they must not be able to preview one
    -- either. Deliberately NOT applied to the explicit-target branch
    -- above — admin_create_member_reservation (0190) has no equivalent
    -- check on the ACTING Admin/Staff caller's own profile status, so
    -- adding one here would be new behavior beyond what that RPC already
    -- enforces.
    select * into v_profile from public.profiles where id = auth.uid();
    if not found then
      raise exception 'not_authenticated';
    end if;
    if v_profile.status <> 'active' then
      raise exception 'account_inactive';
    end if;

    -- Self-service preview — the SAME gate create_reservation (0190)
    -- already enforces for the identical self-booking workflow. Staff
    -- without member_self_service, or a club that hasn't enabled it, are
    -- rejected exactly as they would be attempting the real booking.
    if v_role not in ('admin', 'pro') and not public.current_club_has_capability('member_self_service') then
      raise exception 'capability_not_available';
    end if;

    -- Never client-supplied — resolves ONLY the caller's own roster
    -- identity via the existing canonical helper (0110). A Member can
    -- never reach another identity's pricing through this branch: there
    -- is no parameter here for them to supply one.
    v_target_roster_member_id := public.current_user_roster_member_id();
    if v_target_roster_member_id is null then
      raise exception 'no_roster_identity';
    end if;
  end if;

  select * into v_court
    from public.courts
   where id        = p_court_id
     and club_id   = v_club_id
     and is_active = true;
  if not found then
    raise exception 'court_not_found';
  end if;

  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then
    raise exception 'invalid_duration';
  end if;

  -- Same supported-duration set every write path already enforces.
  if extract(epoch from (p_ends_at - p_starts_at)) / 60 not in (30, 60, 90, 120) then
    raise exception 'invalid_duration';
  end if;

  -- Canonical, role-agnostic classification — identical formula to every
  -- write path. Never re-derived differently for a preview.
  v_membership_pricing_class := case
    when public.is_active_club_member(v_target_roster_member_id, v_club_id) then 'member'
    else 'non_member'
  end;

  -- The ONE place pricing precedence is expressed (0200, immutable) —
  -- never reproduced here. Selects the rate active at p_starts_at only
  -- (locked start-time-pricing rule — no proration).
  select * into v_rate_resolution
    from public._resolve_court_reservation_rate(
      v_club_id, p_court_id, v_membership_pricing_class, p_starts_at
    );

  if v_rate_resolution.hourly_rate_cents is not null then
    v_price_amount_cents := round(v_rate_resolution.hourly_rate_cents * extract(epoch from (p_ends_at - p_starts_at)) / 3600.0)::integer;
  else
    v_price_amount_cents := null;
  end if;

  -- 0202 fix: `currency` alone is ambiguous here — it is simultaneously
  -- this function's own RETURNS TABLE output column (an implicit PL/pgSQL
  -- variable in scope for the whole function body) and a column of
  -- club_settings. Explicitly aliased and qualified so Postgres resolves
  -- it to the table column, not the output variable.
  select cs.currency into v_currency
    from public.club_settings cs
   where cs.club_id = v_club_id;

  membership_pricing_class := v_membership_pricing_class;
  hourly_rate_cents        := v_rate_resolution.hourly_rate_cents;
  price_amount_cents       := v_price_amount_cents;
  currency                 := v_currency;
  applied_rate_source      := v_rate_resolution.applied_rate_source;
  applied_rate_period_id   := v_rate_resolution.applied_rate_period_id;
  applied_rate_period_name := v_rate_resolution.applied_rate_period_name;

  return next;
end;
$$;

revoke execute on function public.preview_court_reservation_price(uuid, timestamptz, timestamptz, uuid, uuid) from public, anon;
grant  execute on function public.preview_court_reservation_price(uuid, timestamptz, timestamptz, uuid, uuid) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- Restore public.preview_court_reservation_price(uuid, timestamptz,
-- timestamptz, uuid, uuid) to its exact 0201 body (the sole difference is
-- the one currency SELECT statement) via CREATE OR REPLACE — no DROP
-- needed, the signature never changed. No other table, policy, or
-- function is touched by this migration.
