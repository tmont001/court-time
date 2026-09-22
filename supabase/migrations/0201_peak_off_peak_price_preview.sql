-- 0201_peak_off_peak_price_preview.sql
-- Peak / Off-Peak Pricing — Checkpoint B, Part 1: canonical authenticated
-- reservation-price preview RPC. 0200 (court_rate_periods, the shared
-- _resolve_court_reservation_rate resolver, the rate-period lifecycle
-- RPCs, and the write-path integration) is APPLIED and IMMUTABLE — this
-- migration reads it, never modifies it.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Checkpoint B needs a way for the browser to show a booking price BEFORE
-- a reservation is created, without ever letting the browser reproduce
-- Court Time's pricing precedence itself. This migration adds exactly one
-- new, read-only RPC — public.preview_court_reservation_price — that
-- reuses 0200's public._resolve_court_reservation_rate verbatim (the same
-- private helper create_reservation / admin_create_member_reservation /
-- update_member_reservation already call) so there is exactly one place
-- in the entire system where court/period/default precedence is decided.
--
-- No booking-time price display is wired into any UI by this migration —
-- that is Checkpoint C. This migration only adds the RPC surface.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- TARGETED AUDIT (performed before writing this file)
-- ═══════════════════════════════════════════════════════════════════════════
-- create_reservation's (0190, immutable) self-service authorization gate:
--   `if v_profile.role not in ('admin', 'pro') and not
--    current_club_has_capability('member_self_service') then raise
--    exception 'capability_not_available'; end if;`
-- reproduced verbatim below for the self-service preview branch — a Staff
-- person (or a Member at a club without the capability) who cannot
-- actually create a self-service booking must not be able to preview one
-- either.
--
-- admin_create_member_reservation's (0190, immutable) explicit-target
-- authorization gate:
--   `if v_role not in ('admin', 'staff') then raise exception
--    'insufficient_role'; end if;`
-- plus its REQUIRED (non-default) p_expected_club_id stale-context guard,
-- reproduced below for the admin/staff-on-behalf-of-a-Member preview
-- branch — never widened to 'pro' or 'member', matching that RPC's own
-- operator model exactly.
--
-- public.current_user_roster_member_id() (0110, immutable, already
-- granted to authenticated) is the existing canonical "caller's own
-- roster identity" resolver — reused verbatim for the self-service branch
-- rather than re-deriving it with a fresh inline SELECT.
--
-- public.is_active_club_member(roster_member_id, club_id) (0188,
-- immutable) is the existing canonical, role-agnostic classification
-- predicate — reused verbatim, exactly as all three write paths already
-- do, so a previewed classification can never diverge from what an actual
-- booking would receive for the same identity.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- SCOPE
-- ═══════════════════════════════════════════════════════════════════════════
--   1. public.preview_court_reservation_price(p_court_id, p_starts_at,
--      p_ends_at, p_roster_member_id default null, p_expected_club_id
--      default null) — SECURITY DEFINER (required so it can call
--      _resolve_court_reservation_rate, whose EXECUTE is revoked from
--      authenticated — see 0200), STABLE (performs only reads within a
--      single statement's snapshot, truthfully reflecting that it never
--      writes), hardened search_path, derives club/role exclusively via
--      current_user_club_id()/current_user_role(), EXECUTE revoked from
--      public/anon and granted to authenticated only. Performs ONLY
--      reads: no INSERT/UPDATE/DELETE anywhere in this function body — no
--      reservation is created, no payment obligation is touched, no
--      Stripe Checkout Session is minted, no pricing row is mutated.
--
--   Authorization (two mutually exclusive branches, matching the two
--   existing create-reservation operator workflows exactly — never a new,
--   independently-invented authorization shape):
--     a. p_roster_member_id is NULL — self-service preview. Caller
--        previews their OWN booking identity only, resolved via
--        current_user_roster_member_id(), never a client-supplied id.
--        Gated by the identical member_self_service capability check
--        create_reservation itself enforces — Staff (and a Member at a
--        club without the capability) get 'capability_not_available',
--        the exact error they'd get attempting the real booking. ALSO
--        gated by create_reservation's own active-profile invariant
--        (profiles.status <> 'active' -> 'account_inactive'), checked
--        before the capability gate, exactly as create_reservation orders
--        it. This check is deliberately scoped to the self-service branch
--        only — admin_create_member_reservation (0190) has no equivalent
--        check on the ACTING Admin/Staff caller's own profile status, so
--        the explicit-target branch below is intentionally left
--        unchanged.
--     b. p_roster_member_id is NOT NULL — Admin/Staff previewing on
--        behalf of an explicit, same-club roster Member. Requires
--        v_role in ('admin','staff') (never 'pro' or 'member' — a plain
--        Member supplying ANY value here, including their own id, is
--        rejected with 'insufficient_role', making "a Member cannot probe
--        another identity's pricing" a structural fact rather than a
--        value comparison) and REQUIRES p_expected_club_id to be supplied
--        and match, mirroring admin_create_member_reservation's own
--        required stale-context parameter. The target roster row is
--        looked up same-club-scoped; a cross-club or nonexistent id fails
--        closed with 'roster_member_not_found'.
--
--   Pricing behavior — entirely delegated:
--     - membership_pricing_class: public.is_active_club_member(...),
--       identical formula to every write path.
--     - hourly_rate_cents / applied_rate_source / applied_rate_period_id
--       / applied_rate_period_name: public._resolve_court_reservation_rate(...)
--       verbatim — the court/period/default, Member/Non-Member,
--       start-time-only precedence chain is NEVER reproduced here.
--     - price_amount_cents: the identical `round(hourly_rate_cents *
--       duration_hours)` formula every write path already uses.
--     - currency: read from club_settings, since the resolver itself
--       returns only a rate, not a currency.
--
--   Input validation — deliberately narrow (a price preview is NOT an
--   availability guarantee, per the locked product decision):
--     - court belongs to the caller's club AND is_active = true.
--     - p_starts_at/p_ends_at both present and p_ends_at > p_starts_at.
--     - duration is one of the four supported values (30/60/90/120
--       minutes) — the same check every write path already enforces.
--   Deliberately NOT checked here (full booking-window/past-date/
--   operating-hours/conflict engine is out of scope for a preview):
--     past-date, booking-window, operating-hours, conflicting-reservation
--     checks. These remain exclusively enforced by the actual create
--     paths at booking time.
--
-- Explicitly NOT touched: 0200 (court_rate_periods, its lifecycle RPCs,
-- and _resolve_court_reservation_rate — all read-only consumed here),
-- create_reservation, admin_create_member_reservation,
-- update_member_reservation, update_club_pricing, Stripe/payment ledger
-- architecture, any frontend file, any UI wiring (Checkpoint C).
--
-- Not applied by this checkpoint. Do not create 0202.
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

  select currency into v_currency from public.club_settings where club_id = v_club_id;

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
-- `drop function if exists public.preview_court_reservation_price(uuid,
-- timestamptz, timestamptz, uuid, uuid);` — the only object this migration
-- creates. No table, column, policy, or existing function is touched or
-- needs restoring. 0200 (all of it) is read-only consumed here, never
-- modified.
