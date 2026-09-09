-- 0164_pricing_packaging_alignment.sql
-- Phase 34G-A2 — Pricing & Packaging Alignment.
--
-- Locked commercial model (34G-A1 audit, 34G-A2 decision):
--   Tier 1 Staff-Managed — $149/mo, $1,490/yr. All existing staff/
--     operational functionality. No Member self-service.
--   Tier 2 Connected — $199/mo, $1,990/yr. Staff-Managed + the existing
--     member_self_service capability (Member accounts, court self-
--     booking, Event signup/waitlist, Program enrollment, Lesson
--     requests, self-service schedule/cancellation).
--   Court Time Payments — an OPTIONAL Connected-only add-on, never a
--     tier of its own. Founding Club (promotional, not a DB tier) =
--     Connected + Payments, priced at the Staff-Managed rate.
--
-- CORRECTION ROUND (still pre-apply) — the first draft of this migration
-- left the Connected -> Staff-Managed downgrade path unsafe: a club could
-- lose member_self_service while (a) a Member could still open a NEW
-- Stripe Checkout against an old obligation whose frozen payment_mode_at_
-- creation='court_time_payments', and (b) an already-open, remotely-
-- payable Stripe Checkout Session could survive the downgrade untouched.
-- This round closes BOTH gaps with a single canonical commercial lock/
-- serialization point shared by the downgrade path and every domain's
-- Checkout-opening path — see the CANONICAL COMMERCIAL LOCK section below
-- for the full design.
--
-- CORRECTION ROUND 2 (still pre-apply) — the first correction round's lock
-- covered tier downgrade and Checkout-opening, but NOT Payments activation
-- (section 2): activate_court_time_payments checked member_self_service
-- WITHOUT the canonical lock, so a concurrent downgrade could commit
-- between that check and activation's own club_settings write, producing
-- the impossible committed state staff_managed + court_time_payments. This
-- round joins activate_court_time_payments to the SAME canonical lock as
-- the other two families — see the CANONICAL COMMERCIAL LOCK section below
-- (now shared by all three) for the full design.
--
-- This migration now makes FIVE focused changes — no historical migration
-- is edited, no table is added, no RLS policy changes:
--
--   1. bootstrap_new_club (0035) — every NEWLY provisioned club now gets
--      an EXPLICIT, queryable club_subscriptions row stating
--      tier='staff_managed' at creation time, rather than the tier being
--      a silent absence that club_has_capability's own fail-closed
--      coalesce merely happens to interpret as Staff-Managed. This makes
--      the commercial default auditable, not inferred. club_entitlements
--      is deliberately NOT touched — see section 1's own comment for why.
--
--   2. activate_court_time_payments (0149) — Court Time Payments is now
--      commercially locked to Connected. Activation now acquires the SAME
--      canonical advisory lock as sections 3 and 4, then re-checks
--      member_self_service UNDER that lock — the only authoritative
--      capability check for activation — failing closed with the SAME
--      capability_not_available error every other member_self_service
--      gate already raises (0123) when the club lacks the capability.
--      Checked BEFORE the existing Stripe-readiness check, since Connected
--      is now the more fundamental prerequisite.
--
--   3. set_club_tier_for_operator (0122) — a genuine Connected -> Staff-
--      Managed downgrade now acquires the SAME canonical advisory lock as
--      sections 2 and 4, then fans out over every currently-'open' Stripe
--      Checkout attempt for the club (across all four domains at once —
--      Reservation/Lesson/Event/Program all share one `payments` table)
--      via the EXISTING, unmodified _invalidate_or_flag_open_checkout_
--      attempt helper (0151) — a bound, possibly-still-payable remote
--      Session fails the ENTIRE downgrade closed BEFORE any tier/
--      entitlement/payment_mode mutation runs, leaving the club fully
--      Connected. Only once every blocking attempt is resolved does the
--      downgrade proceed: tier/entitlement flip to staff_managed, and
--      club_settings.payment_mode steps down from 'court_time_payments'
--      to 'manual' (never 'none' — manual tracking/Record Payment must
--      stay available). No historical payments/payment_events row is
--      ever touched.
--
--   4. open_payment_checkout_attempt / supersede_checkout_attempt_and_
--      open_fresh (0150) — the ONE shared atomic opening boundary every
--      domain's own Checkout wrapper delegates to (Reservation calls it
--      directly; Lesson/Event/Program each lock their own domain-parent
--      row first, then delegate here — never duplicating this function's
--      own logic). Both now acquire the SAME canonical advisory lock as
--      sections 2 and 3, then fail closed with capability_not_available if
--      the club currently lacks member_self_service — closing the "NEW
--      Checkout after downgrade" gap for all four domains via ONE change,
--      not four separate ones. No pricing/ownership/status/balance/stale-
--      session/refund/lifecycle semantics are touched.
--
--   5. list_club_blocking_checkout_attempts (new) — service-role-only,
--      read-only. The operator-facing counterpart to section 3's fan-out
--      guard: lists every payment_id currently blocking a downgrade
--      (bound + open Stripe Session), so scripts/grant-club-entitlement.
--      mjs can report a clear, actionable error rather than an opaque
--      one. Mirrors list_event_blocking_checkout_attempts/list_program_
--      blocking_checkout_attempts' own established shape exactly.
--
-- Explicitly NOT done here (still out of scope, per 34G-A2's own STOP
-- report):
--   - No SaaS billing of any kind (Stripe Billing, subscriptions,
--     invoices, trial expiration, suspension).
--   - No Admin-facing tier mutation UI — set_club_tier_for_operator
--     remains service_role-only, reachable only via
--     scripts/grant-club-entitlement.mjs.
--   - No automated remote Stripe Session resolution INSIDE the CLI
--     script itself (it has no Stripe client/credentials) — a blocked
--     downgrade fails closed with a clear list of blocking payment ids;
--     an operator resolves them through the existing, proven server-side
--     paths (e.g. letting the Session expire naturally, or an Admin/Staff
--     action against that specific payment that already carries the same
--     stale-Checkout guard) and retries. Safety over one-click.
--
-- Apply in Supabase SQL Editor (cloud only). NOT YET APPLIED.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. bootstrap_new_club — CREATE OR REPLACE, explicit Staff-Managed
--    provisioning
-- ═══════════════════════════════════════════════════════════════════════════
-- Reproduced VERBATIM from its sole authoritative body (0035) with exactly
-- one addition: immediately after the club_settings insert, an explicit
-- club_subscriptions row stating tier='staff_managed', status='active'.
-- source='manual_pilot' — the exact same source value set_club_tier_for_
-- operator (0122) already uses for every manually-provisioned tier
-- change, matching this function's own documented nature ("Intended for
-- operator/manual SQL use only").
--
-- club_entitlements is deliberately NOT inserted into here: absence of an
-- active member_self_service grant already means "not granted" by design
-- (club_has_capability's own coalesce-to-false default, 0122) — inserting
-- an explicit disabled row would be a NEW pattern never used elsewhere.
-- set_club_tier_for_operator's own staff_managed branch never inserts a
-- disabled row either; it only revokes an existing ACTIVE grant if one is
-- present. A freshly bootstrapped club has no prior grant to revoke, so
-- there is nothing for this function to insert there consistent with that
-- same precedent.
--
-- No ON CONFLICT clause is needed: v_club.id is a brand-new gen_random_
-- uuid() produced by the clubs insert immediately above, in the same
-- function invocation — a club_subscriptions row for that id cannot
-- already exist.
create or replace function bootstrap_new_club(
  p_name                       text,
  p_slug                       text,
  p_timezone                   text,
  p_court_count                int,
  p_operator_user_id           uuid,
  p_court_names                text[]  default null,
  p_opens_at                   time    default '08:00',
  p_closes_at                  time    default '20:00',
  p_booking_window_days        int     default 14,
  p_cancellation_window_hours  int     default 24,
  p_cancellation_grace_minutes int     default 5
)
returns jsonb
language plpgsql security definer as $$
declare
  -- Slugs that collide with existing app routes or reserved paths.
  v_reserved    text[] := array[
    'admin', 'api', 'auth', 'join', 'sign-in', 'setup', 'operator',
    'app', 'www', 'mail', 'help', 'support', 'booking', 'dashboard'
  ];
  v_club        clubs%rowtype;
  v_code        text;
  v_dow         int;
  v_i           int;
  v_court_name  text;
begin
  -- -------------------------------------------------------------------------
  -- Validate p_name
  -- -------------------------------------------------------------------------
  if trim(p_name) is null or char_length(trim(p_name)) < 2 then
    raise exception 'invalid_name: club name must be at least 2 characters';
  end if;

  if char_length(trim(p_name)) > 80 then
    raise exception 'invalid_name: club name must be 80 characters or fewer';
  end if;

  -- -------------------------------------------------------------------------
  -- Validate p_slug format
  -- Allows: a single alphanumeric character, or a string of 2+ characters
  -- that starts and ends with alphanumeric and contains only lowercase
  -- letters, digits, and hyphens in the middle.
  -- -------------------------------------------------------------------------
  if p_slug is null or p_slug = '' then
    raise exception 'invalid_slug: slug is required';
  end if;

  if p_slug !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' then
    raise exception
      'invalid_slug: slug must contain only lowercase letters, digits, and '
      'hyphens, and must start and end with a letter or digit';
  end if;

  if p_slug = any(v_reserved) then
    raise exception 'invalid_slug: "%" is a reserved slug', p_slug;
  end if;

  -- -------------------------------------------------------------------------
  -- Validate slug uniqueness
  -- -------------------------------------------------------------------------
  if exists (select 1 from clubs where slug = p_slug) then
    raise exception
      'slug_already_exists: a club with slug "%" already exists', p_slug;
  end if;

  -- -------------------------------------------------------------------------
  -- Validate p_court_count
  -- -------------------------------------------------------------------------
  if p_court_count is null or p_court_count < 1 or p_court_count > 20 then
    raise exception 'invalid_court_count: court count must be between 1 and 20';
  end if;

  -- -------------------------------------------------------------------------
  -- Validate p_court_names length when provided
  -- -------------------------------------------------------------------------
  if p_court_names is not null then
    if array_length(p_court_names, 1) is null or
       array_length(p_court_names, 1) <> p_court_count then
      raise exception
        'invalid_court_names: p_court_names must contain exactly % '
        'elements to match p_court_count', p_court_count;
    end if;
  end if;

  -- -------------------------------------------------------------------------
  -- Validate operating hours
  -- -------------------------------------------------------------------------
  if p_closes_at <= p_opens_at then
    raise exception 'invalid_hours: closes_at must be after opens_at';
  end if;

  -- -------------------------------------------------------------------------
  -- Validate booking / cancellation settings
  -- -------------------------------------------------------------------------
  if p_booking_window_days < 1 or p_booking_window_days > 365 then
    raise exception
      'invalid_booking_window: booking_window_days must be between 1 and 365';
  end if;

  if p_cancellation_window_hours < 0 or p_cancellation_window_hours > 168 then
    raise exception
      'invalid_cancellation_window: cancellation_window_hours must be between 0 and 168';
  end if;

  if p_cancellation_grace_minutes < 0 or p_cancellation_grace_minutes > 60 then
    raise exception
      'invalid_grace_period: cancellation_grace_minutes must be between 0 and 60';
  end if;

  -- -------------------------------------------------------------------------
  -- Validate p_operator_user_id
  -- -------------------------------------------------------------------------
  if p_operator_user_id is null then
    raise exception 'invalid_operator_user: p_operator_user_id is required';
  end if;

  if not exists (select 1 from auth.users where id = p_operator_user_id) then
    raise exception
      'invalid_operator_user: user % does not exist in auth.users',
      p_operator_user_id;
  end if;

  -- =========================================================================
  -- All validations passed.
  -- The inserts below run in the caller's transaction — all or nothing.
  -- =========================================================================

  -- -------------------------------------------------------------------------
  -- Insert clubs
  -- -------------------------------------------------------------------------
  insert into clubs (name, slug, timezone, theme_key)
  values (trim(p_name), p_slug, p_timezone, 'classic-gray')
  returning * into v_club;

  -- -------------------------------------------------------------------------
  -- Insert club_settings
  -- -------------------------------------------------------------------------
  insert into club_settings (
    club_id,
    booking_window_days,
    cancellation_window_hours,
    cancellation_grace_minutes
  ) values (
    v_club.id,
    p_booking_window_days,
    p_cancellation_window_hours,
    p_cancellation_grace_minutes
  );

  -- -------------------------------------------------------------------------
  -- Phase 34G-A2 — explicit, auditable Staff-Managed commercial state.
  -- Every new club starts Staff-Managed by explicit record, not by silent
  -- absence. payment_mode is already explicit at the column-default level
  -- (club_settings.payment_mode defaults to 'none', 0143) — Court Time
  -- Payments starts off, unchanged. See this migration's own header for
  -- why club_entitlements is not also written here.
  -- -------------------------------------------------------------------------
  insert into club_subscriptions (club_id, tier, status, source)
  values (v_club.id, 'staff_managed', 'active', 'manual_pilot');

  -- -------------------------------------------------------------------------
  -- Insert courts
  -- display_order is 0-based, matching the convention in add_court().
  -- -------------------------------------------------------------------------
  for v_i in 1..p_court_count loop
    if p_court_names is not null then
      v_court_name := p_court_names[v_i];
    else
      v_court_name := 'Court ' || v_i::text;
    end if;

    insert into courts (club_id, name, display_order, is_active)
    values (v_club.id, v_court_name, v_i - 1, true);
  end loop;

  -- -------------------------------------------------------------------------
  -- Insert operating_hours — all 7 days open.
  -- create_reservation raises club_closed_this_day for any day-of-week row
  -- that is missing, not only for rows where is_closed = true.
  -- All days open by default; a future operating hours editor can close days.
  -- -------------------------------------------------------------------------
  for v_dow in 0..6 loop
    insert into operating_hours (club_id, day_of_week, opens_at, closes_at, is_closed)
    values (v_club.id, v_dow, p_opens_at, p_closes_at, false);
  end loop;

  -- -------------------------------------------------------------------------
  -- Insert event_types — 5 standard keys.
  --
  -- Column mapping from the plan spec:
  --   member_can_join → shows_participant_names
  --   (display_order is not a column on event_types; the app queries by key)
  --
  -- default_court_count values match the pilot club seed:
  --   lesson=1, clinic=1, social=2, league=1, tournament=4
  -- -------------------------------------------------------------------------
  insert into event_types (
    club_id, key, label, color,
    default_capacity, default_duration_minutes, default_court_count,
    shows_participant_names
  ) values
    (v_club.id, 'lesson',     'Private Lesson', '#3B7DD8',  1,  60, 1, false),
    (v_club.id, 'clinic',     'Group Clinic',   '#2E9B5E',  8,  90, 1, false),
    (v_club.id, 'social',     'Open Social',    '#E68433', 12, 120, 2, true),
    (v_club.id, 'league',     'League Match',   '#7B4FB5',  4,  90, 1, true),
    (v_club.id, 'tournament', 'Tournament',     '#C44545', 32, 240, 4, true);

  -- -------------------------------------------------------------------------
  -- Insert first admin invite.
  -- email = null means any email address may accept.
  -- expires_at = 14 days (double the default) to allow for delivery delays.
  -- created_by = p_operator_user_id satisfies the FK to auth.users without
  -- making the column nullable or introducing a fake UUID.
  -- -------------------------------------------------------------------------
  insert into club_invites (club_id, role, email, created_by, expires_at)
  values (v_club.id, 'admin', null, p_operator_user_id, now() + interval '14 days')
  returning code into v_code;

  -- -------------------------------------------------------------------------
  -- Return result
  -- -------------------------------------------------------------------------
  return jsonb_build_object(
    'club_id',     v_club.id,
    'slug',        v_club.slug,
    'invite_code', v_code
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Restrict to service_role / superuser only.
--
-- PostgreSQL grants EXECUTE to PUBLIC by default on all new functions.
-- Revoking from PUBLIC removes that default grant for anon and authenticated
-- PostgREST callers. The postgres superuser retains access unconditionally
-- (superusers bypass privilege checks) — SQL Editor testing is unaffected.
-- service_role is granted explicitly for Phase 13B's server-side operator page.
-- ---------------------------------------------------------------------------
revoke execute
  on function bootstrap_new_club(text, text, text, int, uuid, text[], time, time, int, int, int)
  from public;

grant execute
  on function bootstrap_new_club(text, text, text, int, uuid, text[], time, time, int, int, int)
  to service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. activate_court_time_payments — CREATE OR REPLACE, Connected-only
--    commercial enforcement
-- ═══════════════════════════════════════════════════════════════════════════
-- Reproduced VERBATIM from its sole authoritative body (0149) with two
-- additions, both BEFORE the existing Stripe-readiness check: the
-- canonical commercial lock (see the CANONICAL COMMERCIAL LOCK section
-- below), then a member_self_service capability check performed UNDER
-- that lock — the ONLY authoritative capability check for activation, not
-- an earlier pre-lock read. Without the lock, a concurrent Connected ->
-- Staff-Managed downgrade could commit between an unlocked capability
-- check and this function's own club_settings write, producing the
-- impossible committed state staff_managed + court_time_payments — see
-- CORRECTION ROUND 2 in this migration's own top header. The capability
-- check itself raises the SAME capability_not_available error every other
-- capability gate already raises (0123's own create_reservation/
-- join_event/join_program/submit_lesson_request/create_club_invite
-- guards) — no new error code invented. Connected is the more fundamental
-- commercial prerequisite, so a Staff-Managed Admin is told that reason
-- first rather than being sent to go connect Stripe only to hit a second
-- wall afterward.
--
-- club_has_capability (0122) is already SECURITY DEFINER, internal-only,
-- and designed to be called from exactly this kind of context (another
-- SECURITY DEFINER function) — reused verbatim, never duplicated.
--
-- This only gates NEW activation (payment_mode transitioning TO
-- 'court_time_payments'). It does not touch update_club_payment_mode
-- (the none/manual downgrade path, 0143, unchanged) and does not itself
-- retroactively examine a club that already has payment_mode =
-- 'court_time_payments' from before a later tier downgrade — that case is
-- a separate, already-handled concern: section 3's set_club_tier_for_
-- operator is what coordinates a Connected -> Staff-Managed downgrade for
-- a club with Payments already active, fanning out over any open
-- Checkout attempts and stepping payment_mode down to 'manual'. This
-- function's own responsibility stays scoped to gating NEW activation.
create or replace function public.activate_court_time_payments(
  p_club_id  uuid,
  p_livemode boolean,
  p_actor_id uuid
)
returns public.club_settings
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_ready  boolean;
  v_result public.club_settings%rowtype;
begin
  if p_club_id is null or p_livemode is null or p_actor_id is null then
    raise exception 'invalid_arguments';
  end if;

  -- Phase 34G-A2 (correction round 2) — canonical commercial lock, then
  -- the ONLY authoritative capability check for activation. See this
  -- migration's own CANONICAL COMMERCIAL LOCK section for the full
  -- lock-order/deadlock proof against set_club_tier_for_operator and the
  -- Checkout-opening pair. Without acquiring this lock first, a concurrent
  -- Connected -> Staff-Managed downgrade could commit between an unlocked
  -- capability read and this function's own club_settings write below,
  -- committing the impossible state staff_managed + court_time_payments.
  perform pg_advisory_xact_lock(hashtextextended('club_commercial_tier:' || p_club_id::text, 0));

  -- Court Time Payments is commercially locked to Connected. Fails closed
  -- for a Staff-Managed club before any Stripe-readiness check runs.
  if not public.club_has_capability(p_club_id, 'member_self_service') then
    raise exception 'capability_not_available';
  end if;

  select exists (
    select 1 from public.club_stripe_accounts
     where club_id = p_club_id
       and livemode = p_livemode
       and card_payments_status = 'active'
  ) into v_ready;

  if not v_ready then
    raise exception 'stripe_connect_not_ready';
  end if;

  update public.club_settings
     set payment_mode = 'court_time_payments',
         updated_at   = now()
   where club_id = p_club_id
  returning * into v_result;

  if not found then
    raise exception 'club_not_found';
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    p_club_id, p_actor_id, 'update_club_payment_mode', 'club_settings', p_club_id,
    jsonb_build_object('payment_mode', 'court_time_payments', 'livemode', p_livemode)
  );

  return v_result;
end;
$$;

revoke execute on function public.activate_court_time_payments(uuid, boolean, uuid) from public, anon, authenticated;
grant  execute on function public.activate_court_time_payments(uuid, boolean, uuid) to service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- CANONICAL COMMERCIAL LOCK — shared by sections 2, 3, and 4
-- ═══════════════════════════════════════════════════════════════════════════
-- pg_advisory_xact_lock(hashtextextended('club_commercial_tier:' ||
-- p_club_id::text, 0)) — a single, well-known per-club advisory lock,
-- acquired as the first commercial/state-synchronization step in ALL
-- THREE state-changing/opening families that must never observe or leave
-- a stale/incoherent commercial state for this club — after each
-- function's own ordinary argument/existence validation, but before any
-- relevant commercial state (tier, entitlement, payment_mode) is read or
-- mutated: activate_court_time_payments (Payments
-- activation, section 2), set_club_tier_for_operator (a tier downgrade,
-- section 3), and open_payment_checkout_attempt/supersede_checkout_
-- attempt_and_open_fresh (opening/superseding a Member Checkout, for
-- EVERY domain, since Reservation calls these directly and Lesson/Event/
-- Program each delegate here, section 4). Whichever of the three acquires
-- it first fully commits or rolls back before either of the other two
-- proceeds — there is no interleaving window in which, for example, a
-- Member could begin Checkout, an Admin could activate Payments, or an
-- operator could downgrade the same club and have any two of these
-- partially apply against each other. This is what closes the
-- CORRECTION ROUND 2 gap: without activation sharing this lock, a
-- concurrent downgrade could commit between activation's own (previously
-- unlocked) capability check and its club_settings write, producing the
-- impossible committed state staff_managed + court_time_payments.
--
-- Lock-order safety (why this cannot deadlock against the pre-existing
-- payments -> payment_checkout_attempts row-lock order, 0150): activation
-- (section 2) never locks a payments row, a payment_checkout_attempts
-- row, or any other row at all beyond its own single club_settings
-- update — it needs no second lock class whatsoever, so it cannot
-- participate in any lock-ordering cycle. The downgrade path (section 3)
-- NEVER locks a payments row directly either — it only ever calls the
-- existing _invalidate_or_flag_open_checkout_attempt helper (0151,
-- unmodified), which locks payment_checkout_attempts rows only. The
-- Checkout-opening path (section 4) always acquires this same advisory
-- lock strictly BEFORE its own payments row lock. Since neither
-- activation nor the downgrade path ever holds a payments row lock, and
-- the Checkout-opening path always acquires (advisory lock) -> (payments
-- row) in that fixed order, no transaction can ever hold these lock
-- classes in reverse order relative to another — no ABBA cycle is
-- possible among any of the three families.
--
-- Why an advisory lock rather than a `for update` lock on clubs/club_
-- subscriptions: neither table is otherwise touched by the Checkout-
-- opening path at all, and adding a lock there would risk contending with
-- unrelated club-row operations elsewhere in the app for no safety
-- benefit. This mirrors the codebase's own established precedent for
-- exactly this shape of problem — _create_payment_obligation (0143) uses
-- an identical pg_advisory_xact_lock(hashtextextended(...)) to serialize
-- concurrent obligation-creation calls before any row it needs yet
-- exists.

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. set_club_tier_for_operator — CREATE OR REPLACE, downgrade-safe
--    fan-out guard
-- ═══════════════════════════════════════════════════════════════════════════
-- Reproduced VERBATIM from its sole authoritative body (0122) with these
-- additions, all confined to BEFORE the pre-existing club_subscriptions
-- upsert (so a blocking Checkout fails the ENTIRE call closed before any
-- tier/entitlement/payment_mode mutation runs — required invariant 8:
-- "Failed downgrade must leave the club fully Connected"):
--   * validates p_tier and confirms the club exists first (unchanged from
--     0122), then acquires the canonical commercial lock (above) before
--     reading or mutating any commercial state;
--   * reads the club's CURRENT tier fresh, under that lock;
--   * ONLY for a genuine downgrade (currently something other than
--     'staff_managed', transitioning TO 'staff_managed' — granting/
--     re-granting Connected, or a staff_managed->staff_managed no-op call,
--     never needs this guard: Court Time Payments could never have been
--     activated without Connected in the first place, per section 2's own
--     gate, so there is nothing to invalidate) — fans out over every
--     CURRENTLY 'open' payment_checkout_attempts row for this club, across
--     ALL FOUR domains at once (Reservation/Lesson/Event/Program all share
--     the one `payments` table — no per-domain join is needed), calling
--     the EXISTING, unmodified _invalidate_or_flag_open_checkout_attempt
--     helper (0151) once per blocking payment. A bound, possibly-still-
--     payable remote Session raises open_checkout_requires_resolution
--     here exactly as it already does for every other guarded mutation —
--     rolling back this ENTIRE function call, including the advisory lock
--     release (automatic at transaction end) and the club_subscriptions/
--     club_entitlements upsert below, which never runs.
--   * only once the fan-out completes with nothing blocking does this
--     step down club_settings.payment_mode from 'court_time_payments' to
--     'manual' (never 'none' — see this migration's own header: manual
--     tracking/Record Payment must remain available; historical payments/
--     payment_events rows are never touched by this UPDATE, which only
--     ever changes the CURRENT/live club_settings row).
-- Every other check, computation, and mutation below (tier validation,
-- club-existence check, the club_subscriptions upsert, and the
-- club_entitlements grant/revoke branch) is byte-identical to the
-- currently-applied 0122 text.
create or replace function public.set_club_tier_for_operator(
  p_club_id uuid,
  p_tier    text
)
returns table (
  club_id uuid,
  tier    text,
  status  text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_exists        boolean;
  v_active_entitlement public.club_entitlements%rowtype;
  v_entitlement_found  boolean;
  -- Phase 34G-A2: downgrade-safe commercial lock/fan-out.
  v_current_tier                  text;
  v_payment_id_for_checkout_guard uuid;
begin
  if p_tier not in ('staff_managed', 'connected') then
    raise exception 'invalid_tier';
  end if;

  select exists(select 1 from public.clubs where id = p_club_id) into v_club_exists;
  if not v_club_exists then
    raise exception 'club_not_found';
  end if;

  -- Phase 34G-A2 — canonical commercial lock (see this migration's own
  -- header section immediately above for the full lock-order proof).
  perform pg_advisory_xact_lock(hashtextextended('club_commercial_tier:' || p_club_id::text, 0));

  select cs.tier into v_current_tier
    from public.club_subscriptions cs
   where cs.club_id = p_club_id;

  -- Phase 34G-A2 — Connected -> Staff-Managed downgrade fan-out guard.
  -- Only runs for a genuine downgrade — see this function's own header
  -- comment above for the full reasoning.
  if p_tier = 'staff_managed' and v_current_tier is distinct from 'staff_managed' then
    for v_payment_id_for_checkout_guard in
      select distinct p.id
        from public.payments p
        join public.payment_checkout_attempts a
          on a.payment_id = p.id
         and a.club_id    = p_club_id
         and a.status     = 'open'
       where p.club_id = p_club_id
    loop
      perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);
    end loop;

    -- The club can no longer be commercially configured as actively
    -- offering Member online payments once Connected is lost. Only ever
    -- touches the LIVE club_settings row — no historical payments/
    -- payment_events row is mutated by this statement.
    update public.club_settings
       set payment_mode = 'manual', updated_at = now()
     where club_id = p_club_id
       and payment_mode = 'court_time_payments';
  end if;

  insert into public.club_subscriptions (club_id, tier, status, source)
  values (p_club_id, p_tier, 'active', 'manual_pilot')
  on conflict (club_id) do update
    set tier       = excluded.tier,
        status     = excluded.status,
        source     = excluded.source,
        updated_at = now();

  select ce.* into v_active_entitlement
    from public.club_entitlements ce
   where ce.club_id     = p_club_id
     and ce.capability  = 'member_self_service'
     and ce.revoked_at is null;
  v_entitlement_found := found;

  if p_tier = 'connected' then
    if not v_entitlement_found or not v_active_entitlement.enabled then
      if v_entitlement_found then
        update public.club_entitlements
           set revoked_at = now()
         where id = v_active_entitlement.id;
      end if;

      insert into public.club_entitlements (club_id, capability, enabled, granted_by, note)
      values (
        p_club_id, 'member_self_service', true, null,
        'Granted via set_club_tier_for_operator (manual_pilot).'
      );
    end if;
  else
    -- staff_managed: revoke the active grant if one exists. Never inserts
    -- a "disabled" row — absence of an active row already means false
    -- (club_has_capability's own fail-closed default), so there is
    -- nothing to represent beyond the revocation itself.
    if v_entitlement_found and v_active_entitlement.enabled then
      update public.club_entitlements
         set revoked_at = now()
       where id = v_active_entitlement.id;
    end if;
  end if;

  return query
    select cs.club_id, cs.tier, cs.status
    from public.club_subscriptions cs
    where cs.club_id = p_club_id;
end;
$$;

revoke execute on function public.set_club_tier_for_operator(uuid, text) from public, anon, authenticated;
grant  execute on function public.set_club_tier_for_operator(uuid, text) to service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. open_payment_checkout_attempt / supersede_checkout_attempt_and_
--    open_fresh — CREATE OR REPLACE, live Connected enforcement at the
--    ONE shared atomic opening boundary for all four domains
-- ═══════════════════════════════════════════════════════════════════════════
-- Reproduced VERBATIM from their sole authoritative bodies (0150) with
-- exactly one addition each: the canonical commercial lock (this
-- migration's own header section above), then a live club_has_capability
-- check, both BEFORE the existing payments-row lock — closing the "Member
-- opens a NEW Checkout after the club has been downgraded" gap for an OLD
-- outstanding obligation whose payment_mode_at_creation is still
-- 'court_time_payments' (that frozen snapshot field is, and remains,
-- untouched — this is a live, CURRENT commercial-eligibility check
-- layered on top of it, not a rewrite of history). Reused by ALL FOUR
-- domains through the existing delegation pattern: Reservation calls
-- these directly; open_lesson_payment_checkout_attempt (0160)/open_event_
-- payment_checkout_attempt (0161)/open_program_payment_checkout_attempt
-- (0163) each lock their own domain-parent row first, then delegate their
-- ENTIRE remaining algorithm here — never duplicating it — so this one
-- change covers all four without touching any of those three wrapper
-- migrations. Every other check, computation, and mutation below
-- (argument validation, the payments row lock/eligibility/balance checks,
-- the existing-attempt reuse/supersede logic, the fresh insert) is
-- byte-identical to the currently-applied 0150 text.
create or replace function public.open_payment_checkout_attempt(
  p_payment_id         uuid,
  p_club_id            uuid,
  p_stripe_account_id  text,
  p_livemode           boolean,
  p_actor_id           uuid
)
returns table (
  action                      text,
  id                          uuid,
  payment_id                  uuid,
  club_id                     uuid,
  stripe_account_id           text,
  livemode                    boolean,
  stripe_checkout_session_id  text,
  stripe_session_expires_at   timestamptz,
  stripe_payment_intent_id    text,
  amount_expected_cents       integer,
  currency_expected           text,
  status                      text,
  created_by                  uuid,
  created_at                  timestamptz,
  updated_at                  timestamptz
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_payment    public.payments%rowtype;
  v_remaining  integer;
  v_existing   public.payment_checkout_attempts%rowtype;
  v_result     public.payment_checkout_attempts%rowtype;
begin
  if p_payment_id is null or p_club_id is null or p_stripe_account_id is null
     or p_livemode is null or p_actor_id is null then
    raise exception 'invalid_arguments';
  end if;

  -- Phase 34G-A2 — canonical commercial lock, then live Connected check.
  -- See this migration's own header section above for the full lock-
  -- order proof against set_club_tier_for_operator (section 3).
  perform pg_advisory_xact_lock(hashtextextended('club_commercial_tier:' || p_club_id::text, 0));

  if not public.club_has_capability(p_club_id, 'member_self_service') then
    raise exception 'capability_not_available';
  end if;

  select * into v_payment
    from public.payments p
   where p.id = p_payment_id and p.club_id = p_club_id
   for update;
  if not found then
    raise exception 'payment_not_found';
  end if;

  if v_payment.payment_mode_at_creation <> 'court_time_payments' then
    raise exception 'not_online_payable';
  end if;

  if v_payment.status not in ('unpaid', 'partially_paid') then
    raise exception 'payment_not_open_for_checkout';
  end if;

  v_remaining := v_payment.amount_due_cents - v_payment.amount_paid_cents;
  if v_remaining <= 0 then
    raise exception 'no_balance_due';
  end if;

  select * into v_existing
    from public.payment_checkout_attempts a
   where a.payment_id = p_payment_id and a.status = 'open'
   for update;

  if found then
    if v_existing.amount_expected_cents = v_remaining
       and v_existing.currency_expected = v_payment.currency
       and v_existing.stripe_account_id = p_stripe_account_id
       and v_existing.livemode = p_livemode
       and (v_existing.stripe_session_expires_at is null or v_existing.stripe_session_expires_at > now()) then
      return query select 'ready'::text, v_existing.id, v_existing.payment_id, v_existing.club_id,
        v_existing.stripe_account_id, v_existing.livemode, v_existing.stripe_checkout_session_id,
        v_existing.stripe_session_expires_at, v_existing.stripe_payment_intent_id,
        v_existing.amount_expected_cents, v_existing.currency_expected, v_existing.status,
        v_existing.created_by, v_existing.created_at, v_existing.updated_at;
      return;
    end if;

    if v_existing.stripe_checkout_session_id is null then
      -- No remote Session exists yet — nothing could still be payable.
      -- Safe to supersede locally right now, in this same transaction.
      update public.payment_checkout_attempts a
         set status = 'canceled', updated_at = now()
       where a.id = v_existing.id;
      -- Falls through to the fresh insert below.
    else
      if v_existing.livemode <> p_livemode then
        raise exception 'stale_attempt_environment_mismatch';
      end if;

      -- A remote Session may still be genuinely payable. Nothing is
      -- mutated — the caller must resolve it via Stripe first (see this
      -- function's own header comment).
      return query select 'must_expire_remote'::text, v_existing.id, v_existing.payment_id, v_existing.club_id,
        v_existing.stripe_account_id, v_existing.livemode, v_existing.stripe_checkout_session_id,
        v_existing.stripe_session_expires_at, v_existing.stripe_payment_intent_id,
        v_existing.amount_expected_cents, v_existing.currency_expected, v_existing.status,
        v_existing.created_by, v_existing.created_at, v_existing.updated_at;
      return;
    end if;
  end if;

  insert into public.payment_checkout_attempts (
    payment_id, club_id, stripe_account_id, livemode,
    amount_expected_cents, currency_expected, status, created_by
  ) values (
    p_payment_id, p_club_id, p_stripe_account_id, p_livemode,
    v_remaining, v_payment.currency, 'open', p_actor_id
  ) returning * into v_result;

  return query select 'ready'::text, v_result.id, v_result.payment_id, v_result.club_id,
    v_result.stripe_account_id, v_result.livemode, v_result.stripe_checkout_session_id,
    v_result.stripe_session_expires_at, v_result.stripe_payment_intent_id,
    v_result.amount_expected_cents, v_result.currency_expected, v_result.status,
    v_result.created_by, v_result.created_at, v_result.updated_at;
end;
$$;

revoke execute on function public.open_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) from public, anon, authenticated;
grant  execute on function public.open_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) to service_role;

create or replace function public.supersede_checkout_attempt_and_open_fresh(
  p_stale_attempt_id   uuid,
  p_payment_id         uuid,
  p_club_id            uuid,
  p_stripe_account_id  text,
  p_livemode           boolean,
  p_actor_id           uuid
)
returns table (
  action                      text,
  id                          uuid,
  payment_id                  uuid,
  club_id                     uuid,
  stripe_account_id           text,
  livemode                    boolean,
  stripe_checkout_session_id  text,
  stripe_session_expires_at   timestamptz,
  stripe_payment_intent_id    text,
  amount_expected_cents       integer,
  currency_expected           text,
  status                      text,
  created_by                  uuid,
  created_at                  timestamptz,
  updated_at                  timestamptz
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_payment   public.payments%rowtype;
  v_remaining integer;
  v_stale     public.payment_checkout_attempts%rowtype;
  v_result    public.payment_checkout_attempts%rowtype;
begin
  if p_stale_attempt_id is null or p_payment_id is null or p_club_id is null
     or p_stripe_account_id is null or p_livemode is null or p_actor_id is null then
    raise exception 'invalid_arguments';
  end if;

  -- Phase 34G-A2 — canonical commercial lock, then live Connected check.
  -- Same reasoning as open_payment_checkout_attempt immediately above —
  -- the Stripe round-trip a caller performs between the two attempt-
  -- opening call sites cannot hold a DB lock, so a concurrent downgrade
  -- could otherwise interleave during it.
  perform pg_advisory_xact_lock(hashtextextended('club_commercial_tier:' || p_club_id::text, 0));

  if not public.club_has_capability(p_club_id, 'member_self_service') then
    raise exception 'capability_not_available';
  end if;

  select * into v_payment
    from public.payments p
   where p.id = p_payment_id and p.club_id = p_club_id
   for update;
  if not found then
    raise exception 'payment_not_found';
  end if;

  if v_payment.payment_mode_at_creation <> 'court_time_payments' then
    raise exception 'not_online_payable';
  end if;

  if v_payment.status not in ('unpaid', 'partially_paid') then
    raise exception 'payment_not_open_for_checkout';
  end if;

  v_remaining := v_payment.amount_due_cents - v_payment.amount_paid_cents;
  if v_remaining <= 0 then
    raise exception 'no_balance_due';
  end if;

  select * into v_stale
    from public.payment_checkout_attempts a
   where a.id = p_stale_attempt_id and a.payment_id = p_payment_id
   for update;
  if not found then
    raise exception 'checkout_attempt_not_found';
  end if;

  if v_stale.status <> 'open' then
    -- Resolved by something else since the caller checked with Stripe
    -- (most notably: the webhook completing it) — never create a second
    -- attempt on top. The caller must stop and let that state stand.
    return query select 'already_completed'::text, v_stale.id, v_stale.payment_id, v_stale.club_id,
      v_stale.stripe_account_id, v_stale.livemode, v_stale.stripe_checkout_session_id,
      v_stale.stripe_session_expires_at, v_stale.stripe_payment_intent_id,
      v_stale.amount_expected_cents, v_stale.currency_expected, v_stale.status,
      v_stale.created_by, v_stale.created_at, v_stale.updated_at;
    return;
  end if;

  update public.payment_checkout_attempts a
     set status = 'expired', updated_at = now()
   where a.id = v_stale.id;

  insert into public.payment_checkout_attempts (
    payment_id, club_id, stripe_account_id, livemode,
    amount_expected_cents, currency_expected, status, created_by
  ) values (
    p_payment_id, p_club_id, p_stripe_account_id, p_livemode,
    v_remaining, v_payment.currency, 'open', p_actor_id
  ) returning * into v_result;

  return query select 'ready'::text, v_result.id, v_result.payment_id, v_result.club_id,
    v_result.stripe_account_id, v_result.livemode, v_result.stripe_checkout_session_id,
    v_result.stripe_session_expires_at, v_result.stripe_payment_intent_id,
    v_result.amount_expected_cents, v_result.currency_expected, v_result.status,
    v_result.created_by, v_result.created_at, v_result.updated_at;
end;
$$;

revoke execute on function public.supersede_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid) from public, anon, authenticated;
grant  execute on function public.supersede_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid) to service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. list_club_blocking_checkout_attempts — service-role-only, read-only,
--    operator-facing preflight for section 3's downgrade fan-out guard
-- ═══════════════════════════════════════════════════════════════════════════
-- For every payment belonging to this club with a CURRENTLY 'open' AND
-- bound (stripe_checkout_session_id is not null) Checkout attempt, returns
-- that payment's id — the exact same blocking predicate section 3's own
-- fan-out loop and _invalidate_or_flag_open_checkout_attempt (0151) use.
-- Returns payment_id ONLY — never a Stripe session id, never any Member/
-- domain identity — mirroring list_event_blocking_checkout_attempts
-- (0161) / list_program_blocking_checkout_attempts (0163)'s own identical
-- shape, but spans ALL FOUR domains at once (a plain payments join, since
-- payment_checkout_attempts is already club-scoped and keyed to a single
-- current payment_id per domain row — no per-domain "latest cycle" join
-- is needed here). Called by scripts/grant-club-entitlement.mjs only
-- after set_club_tier_for_operator itself has already raised open_
-- checkout_requires_resolution, to report exactly which payments are
-- blocking — never used as an authorization boundary itself.
create or replace function public.list_club_blocking_checkout_attempts(
  p_club_id uuid
)
returns table (payment_id uuid)
language plpgsql
security definer
stable
set search_path to 'public', 'pg_temp'
as $$
begin
  if p_club_id is null then
    raise exception 'invalid_arguments';
  end if;

  return query
    select distinct p.id
      from public.payments p
      join public.payment_checkout_attempts a
        on a.payment_id = p.id
       and a.club_id     = p_club_id
       and a.status      = 'open'
       and a.stripe_checkout_session_id is not null
     where p.club_id = p_club_id;
end;
$$;

revoke execute on function public.list_club_blocking_checkout_attempts(uuid) from public, anon, authenticated;
grant  execute on function public.list_club_blocking_checkout_attempts(uuid) to service_role;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created)
-- ═══════════════════════════════════════════════════════════════════════════
-- All five redefined functions restore to their EXACT pre-0164
-- authoritative bodies — byte-identical to the currently-applied text:
-- bootstrap_new_club (0035), activate_court_time_payments (0149),
-- set_club_tier_for_operator (0122), open_payment_checkout_attempt and
-- supersede_checkout_attempt_and_open_fresh (both 0150). The one new
-- function (list_club_blocking_checkout_attempts) rolls back via DROP
-- FUNCTION.
--
-- begin;
--
-- create or replace function bootstrap_new_club(
--   p_name                       text,
--   p_slug                       text,
--   p_timezone                   text,
--   p_court_count                int,
--   p_operator_user_id           uuid,
--   p_court_names                text[]  default null,
--   p_opens_at                   time    default '08:00',
--   p_closes_at                  time    default '20:00',
--   p_booking_window_days        int     default 14,
--   p_cancellation_window_hours  int     default 24,
--   p_cancellation_grace_minutes int     default 5
-- )
-- returns jsonb
-- language plpgsql security definer as $$
-- declare
--   -- Slugs that collide with existing app routes or reserved paths.
--   v_reserved    text[] := array[
--     'admin', 'api', 'auth', 'join', 'sign-in', 'setup', 'operator',
--     'app', 'www', 'mail', 'help', 'support', 'booking', 'dashboard'
--   ];
--   v_club        clubs%rowtype;
--   v_code        text;
--   v_dow         int;
--   v_i           int;
--   v_court_name  text;
-- begin
--   -- -------------------------------------------------------------------------
--   -- Validate p_name
--   -- -------------------------------------------------------------------------
--   if trim(p_name) is null or char_length(trim(p_name)) < 2 then
--     raise exception 'invalid_name: club name must be at least 2 characters';
--   end if;
--
--   if char_length(trim(p_name)) > 80 then
--     raise exception 'invalid_name: club name must be 80 characters or fewer';
--   end if;
--
--   -- -------------------------------------------------------------------------
--   -- Validate p_slug format
--   -- Allows: a single alphanumeric character, or a string of 2+ characters
--   -- that starts and ends with alphanumeric and contains only lowercase
--   -- letters, digits, and hyphens in the middle.
--   -- -------------------------------------------------------------------------
--   if p_slug is null or p_slug = '' then
--     raise exception 'invalid_slug: slug is required';
--   end if;
--
--   if p_slug !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' then
--     raise exception
--       'invalid_slug: slug must contain only lowercase letters, digits, and '
--       'hyphens, and must start and end with a letter or digit';
--   end if;
--
--   if p_slug = any(v_reserved) then
--     raise exception 'invalid_slug: "%" is a reserved slug', p_slug;
--   end if;
--
--   -- -------------------------------------------------------------------------
--   -- Validate slug uniqueness
--   -- -------------------------------------------------------------------------
--   if exists (select 1 from clubs where slug = p_slug) then
--     raise exception
--       'slug_already_exists: a club with slug "%" already exists', p_slug;
--   end if;
--
--   -- -------------------------------------------------------------------------
--   -- Validate p_court_count
--   -- -------------------------------------------------------------------------
--   if p_court_count is null or p_court_count < 1 or p_court_count > 20 then
--     raise exception 'invalid_court_count: court count must be between 1 and 20';
--   end if;
--
--   -- -------------------------------------------------------------------------
--   -- Validate p_court_names length when provided
--   -- -------------------------------------------------------------------------
--   if p_court_names is not null then
--     if array_length(p_court_names, 1) is null or
--        array_length(p_court_names, 1) <> p_court_count then
--       raise exception
--         'invalid_court_names: p_court_names must contain exactly % '
--         'elements to match p_court_count', p_court_count;
--     end if;
--   end if;
--
--   -- -------------------------------------------------------------------------
--   -- Validate operating hours
--   -- -------------------------------------------------------------------------
--   if p_closes_at <= p_opens_at then
--     raise exception 'invalid_hours: closes_at must be after opens_at';
--   end if;
--
--   -- -------------------------------------------------------------------------
--   -- Validate booking / cancellation settings
--   -- -------------------------------------------------------------------------
--   if p_booking_window_days < 1 or p_booking_window_days > 365 then
--     raise exception
--       'invalid_booking_window: booking_window_days must be between 1 and 365';
--   end if;
--
--   if p_cancellation_window_hours < 0 or p_cancellation_window_hours > 168 then
--     raise exception
--       'invalid_cancellation_window: cancellation_window_hours must be between 0 and 168';
--   end if;
--
--   if p_cancellation_grace_minutes < 0 or p_cancellation_grace_minutes > 60 then
--     raise exception
--       'invalid_grace_period: cancellation_grace_minutes must be between 0 and 60';
--   end if;
--
--   -- -------------------------------------------------------------------------
--   -- Validate p_operator_user_id
--   -- -------------------------------------------------------------------------
--   if p_operator_user_id is null then
--     raise exception 'invalid_operator_user: p_operator_user_id is required';
--   end if;
--
--   if not exists (select 1 from auth.users where id = p_operator_user_id) then
--     raise exception
--       'invalid_operator_user: user % does not exist in auth.users',
--       p_operator_user_id;
--   end if;
--
--   -- =========================================================================
--   -- All validations passed.
--   -- The inserts below run in the caller's transaction — all or nothing.
--   -- =========================================================================
--
--   -- -------------------------------------------------------------------------
--   -- Insert clubs
--   -- -------------------------------------------------------------------------
--   insert into clubs (name, slug, timezone, theme_key)
--   values (trim(p_name), p_slug, p_timezone, 'classic-gray')
--   returning * into v_club;
--
--   -- -------------------------------------------------------------------------
--   -- Insert club_settings
--   -- -------------------------------------------------------------------------
--   insert into club_settings (
--     club_id,
--     booking_window_days,
--     cancellation_window_hours,
--     cancellation_grace_minutes
--   ) values (
--     v_club.id,
--     p_booking_window_days,
--     p_cancellation_window_hours,
--     p_cancellation_grace_minutes
--   );
--
--   -- -------------------------------------------------------------------------
--   -- Insert courts
--   -- display_order is 0-based, matching the convention in add_court().
--   -- -------------------------------------------------------------------------
--   for v_i in 1..p_court_count loop
--     if p_court_names is not null then
--       v_court_name := p_court_names[v_i];
--     else
--       v_court_name := 'Court ' || v_i::text;
--     end if;
--
--     insert into courts (club_id, name, display_order, is_active)
--     values (v_club.id, v_court_name, v_i - 1, true);
--   end loop;
--
--   -- -------------------------------------------------------------------------
--   -- Insert operating_hours — all 7 days open.
--   -- create_reservation raises club_closed_this_day for any day-of-week row
--   -- that is missing, not only for rows where is_closed = true.
--   -- All days open by default; a future operating hours editor can close days.
--   -- -------------------------------------------------------------------------
--   for v_dow in 0..6 loop
--     insert into operating_hours (club_id, day_of_week, opens_at, closes_at, is_closed)
--     values (v_club.id, v_dow, p_opens_at, p_closes_at, false);
--   end loop;
--
--   -- -------------------------------------------------------------------------
--   -- Insert event_types — 5 standard keys.
--   --
--   -- Column mapping from the plan spec:
--   --   member_can_join → shows_participant_names
--   --   (display_order is not a column on event_types; the app queries by key)
--   --
--   -- default_court_count values match the pilot club seed:
--   --   lesson=1, clinic=1, social=2, league=1, tournament=4
--   -- -------------------------------------------------------------------------
--   insert into event_types (
--     club_id, key, label, color,
--     default_capacity, default_duration_minutes, default_court_count,
--     shows_participant_names
--   ) values
--     (v_club.id, 'lesson',     'Private Lesson', '#3B7DD8',  1,  60, 1, false),
--     (v_club.id, 'clinic',     'Group Clinic',   '#2E9B5E',  8,  90, 1, false),
--     (v_club.id, 'social',     'Open Social',    '#E68433', 12, 120, 2, true),
--     (v_club.id, 'league',     'League Match',   '#7B4FB5',  4,  90, 1, true),
--     (v_club.id, 'tournament', 'Tournament',     '#C44545', 32, 240, 4, true);
--
--   -- -------------------------------------------------------------------------
--   -- Insert first admin invite.
--   -- email = null means any email address may accept.
--   -- expires_at = 14 days (double the default) to allow for delivery delays.
--   -- created_by = p_operator_user_id satisfies the FK to auth.users without
--   -- making the column nullable or introducing a fake UUID.
--   -- -------------------------------------------------------------------------
--   insert into club_invites (club_id, role, email, created_by, expires_at)
--   values (v_club.id, 'admin', null, p_operator_user_id, now() + interval '14 days')
--   returning code into v_code;
--
--   -- -------------------------------------------------------------------------
--   -- Return result
--   -- -------------------------------------------------------------------------
--   return jsonb_build_object(
--     'club_id',     v_club.id,
--     'slug',        v_club.slug,
--     'invite_code', v_code
--   );
-- end;
-- $$;
--
-- -- ---------------------------------------------------------------------------
-- -- Restrict to service_role / superuser only.
-- --
-- -- PostgreSQL grants EXECUTE to PUBLIC by default on all new functions.
-- -- Revoking from PUBLIC removes that default grant for anon and authenticated
-- -- PostgREST callers. The postgres superuser retains access unconditionally
-- -- (superusers bypass privilege checks) — SQL Editor testing is unaffected.
-- -- service_role is granted explicitly for Phase 13B's server-side operator page.
-- -- ---------------------------------------------------------------------------
-- revoke execute
--   on function bootstrap_new_club(text, text, text, int, uuid, text[], time, time, int, int, int)
--   from public;
--
-- grant execute
--   on function bootstrap_new_club(text, text, text, int, uuid, text[], time, time, int, int, int)
--   to service_role;
--
-- create or replace function public.activate_court_time_payments(
--   p_club_id  uuid,
--   p_livemode boolean,
--   p_actor_id uuid
-- )
-- returns public.club_settings
-- language plpgsql
-- security definer
-- set search_path to 'public', 'pg_temp'
-- as $$
-- declare
--   v_ready  boolean;
--   v_result public.club_settings%rowtype;
-- begin
--   if p_club_id is null or p_livemode is null or p_actor_id is null then
--     raise exception 'invalid_arguments';
--   end if;
--
--   select exists (
--     select 1 from public.club_stripe_accounts
--      where club_id = p_club_id
--        and livemode = p_livemode
--        and card_payments_status = 'active'
--   ) into v_ready;
--
--   if not v_ready then
--     raise exception 'stripe_connect_not_ready';
--   end if;
--
--   update public.club_settings
--      set payment_mode = 'court_time_payments',
--          updated_at   = now()
--    where club_id = p_club_id
--   returning * into v_result;
--
--   if not found then
--     raise exception 'club_not_found';
--   end if;
--
--   insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
--   values (
--     p_club_id, p_actor_id, 'update_club_payment_mode', 'club_settings', p_club_id,
--     jsonb_build_object('payment_mode', 'court_time_payments', 'livemode', p_livemode)
--   );
--
--   return v_result;
-- end;
-- $$;
--
-- revoke execute on function public.activate_court_time_payments(uuid, boolean, uuid) from public, anon, authenticated;
-- grant  execute on function public.activate_court_time_payments(uuid, boolean, uuid) to service_role;
--
-- create or replace function public.set_club_tier_for_operator(
--   p_club_id uuid,
--   p_tier    text
-- )
-- returns table (
--   club_id uuid,
--   tier    text,
--   status  text
-- )
-- language plpgsql
-- security definer
-- set search_path = public, pg_temp
-- as $$
-- declare
--   v_club_exists        boolean;
--   v_active_entitlement public.club_entitlements%rowtype;
--   v_entitlement_found  boolean;
-- begin
--   if p_tier not in ('staff_managed', 'connected') then
--     raise exception 'invalid_tier';
--   end if;
--
--   select exists(select 1 from public.clubs where id = p_club_id) into v_club_exists;
--   if not v_club_exists then
--     raise exception 'club_not_found';
--   end if;
--
--   insert into public.club_subscriptions (club_id, tier, status, source)
--   values (p_club_id, p_tier, 'active', 'manual_pilot')
--   on conflict (club_id) do update
--     set tier       = excluded.tier,
--         status     = excluded.status,
--         source     = excluded.source,
--         updated_at = now();
--
--   select ce.* into v_active_entitlement
--     from public.club_entitlements ce
--    where ce.club_id     = p_club_id
--      and ce.capability  = 'member_self_service'
--      and ce.revoked_at is null;
--   v_entitlement_found := found;
--
--   if p_tier = 'connected' then
--     if not v_entitlement_found or not v_active_entitlement.enabled then
--       if v_entitlement_found then
--         update public.club_entitlements
--            set revoked_at = now()
--          where id = v_active_entitlement.id;
--       end if;
--
--       insert into public.club_entitlements (club_id, capability, enabled, granted_by, note)
--       values (
--         p_club_id, 'member_self_service', true, null,
--         'Granted via set_club_tier_for_operator (manual_pilot).'
--       );
--     end if;
--   else
--     -- staff_managed: revoke the active grant if one exists. Never inserts
--     -- a "disabled" row — absence of an active row already means false
--     -- (club_has_capability's own fail-closed default), so there is
--     -- nothing to represent beyond the revocation itself.
--     if v_entitlement_found and v_active_entitlement.enabled then
--       update public.club_entitlements
--          set revoked_at = now()
--        where id = v_active_entitlement.id;
--     end if;
--   end if;
--
--   return query
--     select cs.club_id, cs.tier, cs.status
--     from public.club_subscriptions cs
--     where cs.club_id = p_club_id;
-- end;
-- $$;
--
-- revoke execute on function public.set_club_tier_for_operator(uuid, text) from public, anon, authenticated;
-- grant  execute on function public.set_club_tier_for_operator(uuid, text) to service_role;
--
-- create or replace function public.open_payment_checkout_attempt(
--   p_payment_id         uuid,
--   p_club_id            uuid,
--   p_stripe_account_id  text,
--   p_livemode           boolean,
--   p_actor_id           uuid
-- )
-- returns table (
--   action                      text,
--   id                          uuid,
--   payment_id                  uuid,
--   club_id                     uuid,
--   stripe_account_id           text,
--   livemode                    boolean,
--   stripe_checkout_session_id  text,
--   stripe_session_expires_at   timestamptz,
--   stripe_payment_intent_id    text,
--   amount_expected_cents       integer,
--   currency_expected           text,
--   status                      text,
--   created_by                  uuid,
--   created_at                  timestamptz,
--   updated_at                  timestamptz
-- )
-- language plpgsql
-- security definer
-- set search_path to 'public', 'pg_temp'
-- as $$
-- declare
--   v_payment    public.payments%rowtype;
--   v_remaining  integer;
--   v_existing   public.payment_checkout_attempts%rowtype;
--   v_result     public.payment_checkout_attempts%rowtype;
-- begin
--   if p_payment_id is null or p_club_id is null or p_stripe_account_id is null
--      or p_livemode is null or p_actor_id is null then
--     raise exception 'invalid_arguments';
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
--   if v_payment.payment_mode_at_creation <> 'court_time_payments' then
--     raise exception 'not_online_payable';
--   end if;
--
--   if v_payment.status not in ('unpaid', 'partially_paid') then
--     raise exception 'payment_not_open_for_checkout';
--   end if;
--
--   v_remaining := v_payment.amount_due_cents - v_payment.amount_paid_cents;
--   if v_remaining <= 0 then
--     raise exception 'no_balance_due';
--   end if;
--
--   select * into v_existing
--     from public.payment_checkout_attempts a
--    where a.payment_id = p_payment_id and a.status = 'open'
--    for update;
--
--   if found then
--     if v_existing.amount_expected_cents = v_remaining
--        and v_existing.currency_expected = v_payment.currency
--        and v_existing.stripe_account_id = p_stripe_account_id
--        and v_existing.livemode = p_livemode
--        and (v_existing.stripe_session_expires_at is null or v_existing.stripe_session_expires_at > now()) then
--       return query select 'ready'::text, v_existing.id, v_existing.payment_id, v_existing.club_id,
--         v_existing.stripe_account_id, v_existing.livemode, v_existing.stripe_checkout_session_id,
--         v_existing.stripe_session_expires_at, v_existing.stripe_payment_intent_id,
--         v_existing.amount_expected_cents, v_existing.currency_expected, v_existing.status,
--         v_existing.created_by, v_existing.created_at, v_existing.updated_at;
--       return;
--     end if;
--
--     if v_existing.stripe_checkout_session_id is null then
--       -- No remote Session exists yet — nothing could still be payable.
--       -- Safe to supersede locally right now, in this same transaction.
--       update public.payment_checkout_attempts a
--          set status = 'canceled', updated_at = now()
--        where a.id = v_existing.id;
--       -- Falls through to the fresh insert below.
--     else
--       if v_existing.livemode <> p_livemode then
--         raise exception 'stale_attempt_environment_mismatch';
--       end if;
--
--       -- A remote Session may still be genuinely payable. Nothing is
--       -- mutated — the caller must resolve it via Stripe first (see this
--       -- function's own header comment).
--       return query select 'must_expire_remote'::text, v_existing.id, v_existing.payment_id, v_existing.club_id,
--         v_existing.stripe_account_id, v_existing.livemode, v_existing.stripe_checkout_session_id,
--         v_existing.stripe_session_expires_at, v_existing.stripe_payment_intent_id,
--         v_existing.amount_expected_cents, v_existing.currency_expected, v_existing.status,
--         v_existing.created_by, v_existing.created_at, v_existing.updated_at;
--       return;
--     end if;
--   end if;
--
--   insert into public.payment_checkout_attempts (
--     payment_id, club_id, stripe_account_id, livemode,
--     amount_expected_cents, currency_expected, status, created_by
--   ) values (
--     p_payment_id, p_club_id, p_stripe_account_id, p_livemode,
--     v_remaining, v_payment.currency, 'open', p_actor_id
--   ) returning * into v_result;
--
--   return query select 'ready'::text, v_result.id, v_result.payment_id, v_result.club_id,
--     v_result.stripe_account_id, v_result.livemode, v_result.stripe_checkout_session_id,
--     v_result.stripe_session_expires_at, v_result.stripe_payment_intent_id,
--     v_result.amount_expected_cents, v_result.currency_expected, v_result.status,
--     v_result.created_by, v_result.created_at, v_result.updated_at;
-- end;
-- $$;
--
-- revoke execute on function public.open_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) from public, anon, authenticated;
-- grant  execute on function public.open_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) to service_role;
--
-- create or replace function public.supersede_checkout_attempt_and_open_fresh(
--   p_stale_attempt_id   uuid,
--   p_payment_id         uuid,
--   p_club_id            uuid,
--   p_stripe_account_id  text,
--   p_livemode           boolean,
--   p_actor_id           uuid
-- )
-- returns table (
--   action                      text,
--   id                          uuid,
--   payment_id                  uuid,
--   club_id                     uuid,
--   stripe_account_id           text,
--   livemode                    boolean,
--   stripe_checkout_session_id  text,
--   stripe_session_expires_at   timestamptz,
--   stripe_payment_intent_id    text,
--   amount_expected_cents       integer,
--   currency_expected           text,
--   status                      text,
--   created_by                  uuid,
--   created_at                  timestamptz,
--   updated_at                  timestamptz
-- )
-- language plpgsql
-- security definer
-- set search_path to 'public', 'pg_temp'
-- as $$
-- declare
--   v_payment   public.payments%rowtype;
--   v_remaining integer;
--   v_stale     public.payment_checkout_attempts%rowtype;
--   v_result    public.payment_checkout_attempts%rowtype;
-- begin
--   if p_stale_attempt_id is null or p_payment_id is null or p_club_id is null
--      or p_stripe_account_id is null or p_livemode is null or p_actor_id is null then
--     raise exception 'invalid_arguments';
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
--   if v_payment.payment_mode_at_creation <> 'court_time_payments' then
--     raise exception 'not_online_payable';
--   end if;
--
--   if v_payment.status not in ('unpaid', 'partially_paid') then
--     raise exception 'payment_not_open_for_checkout';
--   end if;
--
--   v_remaining := v_payment.amount_due_cents - v_payment.amount_paid_cents;
--   if v_remaining <= 0 then
--     raise exception 'no_balance_due';
--   end if;
--
--   select * into v_stale
--     from public.payment_checkout_attempts a
--    where a.id = p_stale_attempt_id and a.payment_id = p_payment_id
--    for update;
--   if not found then
--     raise exception 'checkout_attempt_not_found';
--   end if;
--
--   if v_stale.status <> 'open' then
--     -- Resolved by something else since the caller checked with Stripe
--     -- (most notably: the webhook completing it) — never create a second
--     -- attempt on top. The caller must stop and let that state stand.
--     return query select 'already_completed'::text, v_stale.id, v_stale.payment_id, v_stale.club_id,
--       v_stale.stripe_account_id, v_stale.livemode, v_stale.stripe_checkout_session_id,
--       v_stale.stripe_session_expires_at, v_stale.stripe_payment_intent_id,
--       v_stale.amount_expected_cents, v_stale.currency_expected, v_stale.status,
--       v_stale.created_by, v_stale.created_at, v_stale.updated_at;
--     return;
--   end if;
--
--   update public.payment_checkout_attempts a
--      set status = 'expired', updated_at = now()
--    where a.id = v_stale.id;
--
--   insert into public.payment_checkout_attempts (
--     payment_id, club_id, stripe_account_id, livemode,
--     amount_expected_cents, currency_expected, status, created_by
--   ) values (
--     p_payment_id, p_club_id, p_stripe_account_id, p_livemode,
--     v_remaining, v_payment.currency, 'open', p_actor_id
--   ) returning * into v_result;
--
--   return query select 'ready'::text, v_result.id, v_result.payment_id, v_result.club_id,
--     v_result.stripe_account_id, v_result.livemode, v_result.stripe_checkout_session_id,
--     v_result.stripe_session_expires_at, v_result.stripe_payment_intent_id,
--     v_result.amount_expected_cents, v_result.currency_expected, v_result.status,
--     v_result.created_by, v_result.created_at, v_result.updated_at;
-- end;
-- $$;
--
-- revoke execute on function public.supersede_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid) from public, anon, authenticated;
-- grant  execute on function public.supersede_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid) to service_role;
--
-- drop function if exists public.list_club_blocking_checkout_attempts(uuid);
--
-- commit;
