-- 0200_court_rate_periods.sql
-- Peak / Off-Peak Pricing — Checkpoint A: schema, shared resolver,
-- lifecycle RPCs, and write-path integration ONLY. No preview RPC, no
-- Admin UI, no booking-time price display — those are Checkpoint B/C,
-- deferred.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 34B/42B/42C (0139/0189/0190, all applied/immutable) gave Court Time
-- optional, class-aware (Member/Non-Member) court pricing with a flat
-- club-default + per-court-override precedence. This migration adds one
-- more rung to that precedence — club-wide, time-of-day/day-of-week rate
-- periods ("Peak"/"Off-Peak"/"Weekend") — without touching payments,
-- Stripe, refunds, or the reservation snapshot columns' own semantics.
--
-- Locked product decisions (approved before this migration was written):
--   - START-TIME PRICING ONLY. The entire reservation is priced at the
--     rate in effect at its club-local START time. No proration, no
--     blended pricing, ever, in v1.
--   - Rate periods are CLUB-WIDE (no court_id column) and carry no
--     priority/order field — ambiguity is refused at write time via an
--     overlap check, never resolved at read time via precedence.
--   - Precedence per membership class:
--       Member:     court Member override -> matching period Member
--                   -> club Member default
--       Non-Member (memberships_enabled only): court Non-Member override
--                   -> matching period Non-Member -> club Non-Member
--                   default -> court Member override -> matching period
--                   Member -> club Member default
--     A class-specific court override wins over the matching rate period
--     for THAT SAME pricing class only. The established Non-Member
--     fallback chain remains unchanged: a court with only a Member
--     override configured (no Non-Member-specific override) can still
--     have its Non-Member price supplied by a matching rate period's
--     Non-Member rate, ahead of falling through to that same court's
--     Member override — court_rate_periods is NOT unconditionally shadowed
--     merely because a court has SOME flat rate configured.
--   - membership_pricing_class computation/snapshot rules are UNCHANGED
--     from 0189/0190 — this migration only changes what RATE a given,
--     already-resolved class maps to. It is never responsible for
--     deriving that class from a roster_member_id.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- TARGETED AUDIT (performed before writing this file)
-- ═══════════════════════════════════════════════════════════════════════════
-- Confirmed 0190 (not 0189) is the latest live body for create_reservation,
-- admin_create_member_reservation, and update_member_reservation — grepped
-- every migration for `create or replace function public.<name>` and
-- `CREATE OR REPLACE FUNCTION public.<name>` across both casings; 0190 is
-- the highest-numbered hit for all three. This migration's replacement
-- bodies are therefore verbatim-0190 plus the pricing-block changes
-- described per function below — never 0189's now-superseded bodies.
--
-- Confirmed update_club_pricing's latest live body is still 0189 (0190
-- never touches it) — this migration's replacement is verbatim-0189 plus
-- one additional UNION ALL clause in the existing currency-lock scan.
--
-- Confirmed club_settings.memberships_enabled (0190) already gates the
-- Non-Member rate chain via `v_settings.memberships_enabled and
-- v_membership_pricing_class = 'non_member'` — this exact predicate is
-- reproduced inside the new shared resolver, unchanged in meaning, so
-- "memberships off" continues to mean "price everyone through the
-- Member/standard chain regardless of their truthfully-preserved class,"
-- never "reclassify everyone as member."
--
-- ═══════════════════════════════════════════════════════════════════════════
-- SCOPE
-- ═══════════════════════════════════════════════════════════════════════════
--   1. court_rate_periods table — club-scoped, days_of_week int[], local
--      start/end time, per-class nullable rate columns, is_active. RLS
--      enabled with an admin-only SELECT policy; no INSERT/UPDATE/DELETE
--      policy at all (deny-by-default at the table level — every mutation
--      must go through the lifecycle RPCs below, which are
--      SECURITY DEFINER and therefore unaffected by the table's own RLS).
--   2. public._resolve_court_reservation_rate(club_id, court_id,
--      membership_pricing_class, starts_at) — the one place the
--      court/period/default precedence chain is expressed. SECURITY
--      INVOKER, STABLE, EXECUTE revoked from public/anon/authenticated —
--      reachable only from within an already-privileged SECURITY DEFINER
--      caller (ownership grants implicit EXECUTE regardless of the
--      revoke), never directly from a client. Accepts an
--      ALREADY-RESOLVED/PRESERVED membership_pricing_class — never derives
--      one itself from a roster_member_id, so 0189/0190's own class
--      resolution/preservation rules are entirely untouched by this
--      migration.
--   3. public.upsert_court_rate_period / public.set_court_rate_period_active
--      — Admin-only lifecycle RPCs (Add/Edit, Deactivate/Reactivate).
--      Overlap is validated whenever the resulting row is ACTIVE: on
--      every Add (new periods are active by default), on an Edit to an
--      already-ACTIVE period, and again on Reactivate. An Edit to an
--      INACTIVE period skips validation entirely — an inactive period
--      participates in no pricing, so it cannot conflict with anything
--      until it is reactivated, at which point the identical check runs
--      again. Concurrency-safe: both lock the club's own club_settings row
--      FOR UPDATE before validating overlap, serializing concurrent
--      same-club rate-period mutations so two racing Admin requests can
--      never both pass the overlap check.
--   4. create_reservation / admin_create_member_reservation: verbatim 0190
--      bodies, each with its inline rate-coalesce block replaced by one
--      call to the shared resolver. membership_pricing_class's own
--      computation is byte-identical to 0190 — untouched.
--   5. update_member_reservation: verbatim 0190 body, with the fresh-rate
--      trigger corrected from "court changed OR member changed" to "court
--      changed OR member changed OR starts_at changed" (a start-time shift
--      can cross a rate-period boundary even with court/member/duration
--      untouched), and that branch's inline rate-coalesce block replaced
--      by the shared resolver call using the ALREADY-COMPUTED
--      v_new_pricing_class (fresh only on reassignment, preserved
--      otherwise — unchanged rule). The duration-only and no-change
--      branches are byte-identical to 0190 — a pure ends_at/duration edit
--      still preserves the existing rate and only re-multiplies.
--   6. update_club_pricing: verbatim 0189 body, with one new UNION ALL
--      clause added to the existing currency-lock scan covering
--      court_rate_periods' two rate columns — a positive configured
--      period price locks currency exactly like every other pricing
--      source already in that scan.
--
-- Explicitly NOT touched: Stripe, payment ledger architecture
-- (_create_payment_obligation/_adjust_payment_obligation/
-- _check_member_reassignment_allowed/_invalidate_or_flag_open_checkout_
-- attempt), is_active_club_member's own definition, reservations table
-- schema (no new columns — hourly_rate_cents/price_amount_cents/
-- membership_pricing_class remain the sole snapshot), lessons/events/
-- programs pricing, any preview RPC, any frontend file.
--
-- Not applied by this checkpoint. Do not create 0201.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. court_rate_periods
-- ═══════════════════════════════════════════════════════════════════════════
create table public.court_rate_periods (
  id                             uuid primary key default uuid_generate_v4(),
  club_id                        uuid not null references public.clubs(id) on delete cascade,
  name                           text not null,
  days_of_week                   integer[] not null,
  starts_at_local                time not null,
  ends_at_local                  time not null,
  hourly_rate_cents              integer null,
  hourly_rate_non_member_cents   integer null,
  is_active                      boolean not null default true,
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now(),

  constraint court_rate_periods_days_of_week_nonempty
    check (coalesce(array_length(days_of_week, 1), 0) > 0),
  constraint court_rate_periods_days_of_week_valid
    check (days_of_week <@ array[0,1,2,3,4,5,6]::integer[]),
  constraint court_rate_periods_same_day_only
    check (ends_at_local > starts_at_local),
  constraint court_rate_periods_hourly_rate_cents_nonneg
    check (hourly_rate_cents is null or hourly_rate_cents >= 0),
  constraint court_rate_periods_hourly_rate_non_member_cents_nonneg
    check (hourly_rate_non_member_cents is null or hourly_rate_non_member_cents >= 0),
  constraint court_rate_periods_at_least_one_rate
    check (hourly_rate_cents is not null or hourly_rate_non_member_cents is not null)
);

comment on table public.court_rate_periods is
  'Peak/Off-Peak Pricing — Checkpoint A: club-wide Peak/Off-Peak-style rate windows. No court_id (v1 is
   club-wide only) and no priority/order column — overlapping active
   periods are rejected at write time by upsert_court_rate_period /
   set_court_rate_period_active, never resolved by runtime precedence.
   Rate-period selection for a reservation uses the reservation''s
   club-local START time only (locked v1 rule) — see
   _resolve_court_reservation_rate. No overnight (cross-midnight) periods
   in v1 — enforced by court_rate_periods_same_day_only.';

create index court_rate_periods_club_id_idx on public.court_rate_periods (club_id);

create trigger court_rate_periods_updated_at
  before update on public.court_rate_periods
  for each row execute function trigger_set_updated_at();

alter table public.court_rate_periods enable row level security;

-- Admin-only SELECT — no Member-facing consumer exists yet (Checkpoint
-- B/C's preview RPC and Admin UI are deferred), and the locked Checkpoint-A
-- instruction is explicit: do not give Members broad/direct rate-period
-- table access. No INSERT/UPDATE/DELETE policy is created at all — the
-- table is write-closed at the RLS layer; the only way to mutate it is
-- through the SECURITY DEFINER lifecycle RPCs below, which run as the
-- table owner and are therefore unaffected by RLS regardless.
create policy "court_rate_periods_select_admin"
  on public.court_rate_periods for select
  using (
    club_id = current_user_club_id()
    and current_user_role() = 'admin'
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. _resolve_court_reservation_rate — the one shared precedence chain.
--    SECURITY INVOKER (not DEFINER): it performs no writes and is meant to
--    run under whatever privilege level its SECURITY DEFINER caller is
--    already executing as. EXECUTE is revoked from public/anon/
--    authenticated so no client can call it directly via PostgREST;
--    ownership already grants the migration-running role (and therefore
--    every SECURITY DEFINER function it also owns) implicit EXECUTE
--    regardless of that revoke.
--
--    Accepts p_membership_pricing_class as an INPUT, never derives one —
--    0189/0190's is_active_club_member-based class resolution/preservation
--    rules are entirely owned by each caller and untouched here.
--
--    Rate-period selection is keyed on the club-local day-of-week/time of
--    p_starts_at ONLY (locked start-time-pricing rule) — p_ends_at plays
--    no role in which rate applies, only in the caller's own
--    price_amount_cents multiply, which stays each caller's job.
--
--    Returns enough truthful source metadata (applied_rate_source,
--    applied_rate_period_id/name) for a FUTURE preview RPC to display
--    accurately — the period id/name are populated ONLY when a rate from
--    that period actually supplied the selected rate, never when a court
--    override or a club default won instead. Not consumed by any RPC in
--    this checkpoint; no new reservations column stores it.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public._resolve_court_reservation_rate(
  p_club_id                  uuid,
  p_court_id                 uuid,
  p_membership_pricing_class text,
  p_starts_at                timestamptz
)
returns table (
  hourly_rate_cents        integer,
  applied_rate_source      text,
  applied_rate_period_id   uuid,
  applied_rate_period_name text
)
language plpgsql
security invoker
stable
set search_path to 'public', 'pg_temp'
as $$
declare
  v_settings       public.club_settings%rowtype;
  v_court          public.courts%rowtype;
  v_tz             text;
  v_dow            int;
  v_local_time     time;
  v_period         public.court_rate_periods%rowtype;
  v_period_found   boolean;
  v_use_non_member boolean;
begin
  select * into v_settings from public.club_settings where club_id = p_club_id;
  select * into v_court    from public.courts        where id = p_court_id and club_id = p_club_id;
  select timezone into v_tz from public.clubs where id = p_club_id;

  v_dow        := extract(dow  from p_starts_at at time zone v_tz)::int;
  v_local_time := (p_starts_at at time zone v_tz)::time;

  -- Phase 42C rule, reproduced unchanged: the Non-Member chain is only
  -- ever consulted when memberships_enabled — otherwise every booking
  -- resolves through the Member/standard chain regardless of the
  -- (still-accurately-preserved) class passed in.
  v_use_non_member := v_settings.memberships_enabled and p_membership_pricing_class = 'non_member';

  -- Locked start-time rule: exactly one matching ACTIVE period, keyed on
  -- the club-local day-of-week and start time of p_starts_at. Uniqueness
  -- is guaranteed by upsert_court_rate_period / set_court_rate_period_active's
  -- own overlap validation — this is a plain lookup, never a precedence
  -- decision.
  select * into v_period
    from public.court_rate_periods crp
   where crp.club_id   = p_club_id
     and crp.is_active = true
     and v_dow = any(crp.days_of_week)
     and v_local_time >= crp.starts_at_local
     and v_local_time <  crp.ends_at_local
   limit 1;
  v_period_found := found;

  if v_use_non_member then
    if v_court.hourly_rate_non_member_cents is not null then
      hourly_rate_cents := v_court.hourly_rate_non_member_cents;
      applied_rate_source := 'court_override_non_member';
    elsif v_period_found and v_period.hourly_rate_non_member_cents is not null then
      hourly_rate_cents := v_period.hourly_rate_non_member_cents;
      applied_rate_source := 'rate_period_non_member';
      applied_rate_period_id := v_period.id;
      applied_rate_period_name := v_period.name;
    elsif v_settings.default_court_hourly_rate_non_member_cents is not null then
      hourly_rate_cents := v_settings.default_court_hourly_rate_non_member_cents;
      applied_rate_source := 'club_default_non_member';
    elsif v_court.hourly_rate_cents is not null then
      hourly_rate_cents := v_court.hourly_rate_cents;
      applied_rate_source := 'court_override_member';
    elsif v_period_found and v_period.hourly_rate_cents is not null then
      hourly_rate_cents := v_period.hourly_rate_cents;
      applied_rate_source := 'rate_period_member';
      applied_rate_period_id := v_period.id;
      applied_rate_period_name := v_period.name;
    elsif v_settings.default_court_hourly_rate_cents is not null then
      hourly_rate_cents := v_settings.default_court_hourly_rate_cents;
      applied_rate_source := 'club_default_member';
    else
      hourly_rate_cents := null;
      applied_rate_source := 'unpriced';
    end if;
  else
    if v_court.hourly_rate_cents is not null then
      hourly_rate_cents := v_court.hourly_rate_cents;
      applied_rate_source := 'court_override_member';
    elsif v_period_found and v_period.hourly_rate_cents is not null then
      hourly_rate_cents := v_period.hourly_rate_cents;
      applied_rate_source := 'rate_period_member';
      applied_rate_period_id := v_period.id;
      applied_rate_period_name := v_period.name;
    elsif v_settings.default_court_hourly_rate_cents is not null then
      hourly_rate_cents := v_settings.default_court_hourly_rate_cents;
      applied_rate_source := 'club_default_member';
    else
      hourly_rate_cents := null;
      applied_rate_source := 'unpriced';
    end if;
  end if;

  return next;
end;
$$;

revoke execute on function public._resolve_court_reservation_rate(uuid, uuid, text, timestamptz) from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. upsert_court_rate_period — Add (p_id null) / Edit (p_id set).
--    Admin-only, same-club. Locks the club's own club_settings row FOR
--    UPDATE before validating overlap so two concurrent Admin requests can
--    never both pass the check and leave two overlapping active periods.
--    Overlap validation runs on Add (always — new periods are active by
--    default) and on an Edit to an already-ACTIVE period, but is SKIPPED
--    for an Edit to an INACTIVE period (v_existing.is_active = false) —
--    an inactive row participates in no pricing and cannot conflict with
--    anything, so it may be freely edited into whatever days/times an
--    Admin wants while it stays off; set_court_rate_period_active's own
--    Reactivate path re-runs this identical check before turning it back
--    on. This function never accepts an is_active parameter of its own —
--    activation state is managed exclusively by
--    set_court_rate_period_active.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.upsert_court_rate_period(
  p_id                           uuid,
  p_name                         text,
  p_days_of_week                 integer[],
  p_starts_at_local              time,
  p_ends_at_local                time,
  p_hourly_rate_cents            integer default null,
  p_hourly_rate_non_member_cents integer default null
)
returns public.court_rate_periods
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id        uuid;
  v_role           text;
  v_existing       public.court_rate_periods%rowtype;
  v_result         public.court_rate_periods%rowtype;
  v_overlap_exists boolean;
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

  if v_role is distinct from 'admin' then
    raise exception 'insufficient_role';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception 'name_required';
  end if;

  if p_days_of_week is null or coalesce(array_length(p_days_of_week, 1), 0) = 0 then
    raise exception 'days_required';
  end if;

  if not (p_days_of_week <@ array[0,1,2,3,4,5,6]::integer[]) then
    raise exception 'invalid_day_of_week';
  end if;

  if p_starts_at_local is null or p_ends_at_local is null then
    raise exception 'invalid_time_range';
  end if;

  if p_ends_at_local <= p_starts_at_local then
    raise exception 'invalid_time_range';
  end if;

  if p_hourly_rate_cents is not null and p_hourly_rate_cents < 0 then
    raise exception 'invalid_rate';
  end if;

  if p_hourly_rate_non_member_cents is not null and p_hourly_rate_non_member_cents < 0 then
    raise exception 'invalid_rate';
  end if;

  if p_hourly_rate_cents is null and p_hourly_rate_non_member_cents is null then
    raise exception 'rate_required';
  end if;

  -- Serialize concurrent rate-period mutations for this club — see this
  -- migration's header for why club_settings (a guaranteed one-row-per-club
  -- table) is the lock target rather than a new dedicated lock row.
  perform 1 from public.club_settings where club_id = v_club_id for update;

  if p_id is not null then
    select * into v_existing
      from public.court_rate_periods
     where id = p_id and club_id = v_club_id;
    if not found then
      raise exception 'rate_period_not_found';
    end if;
  end if;

  -- Overlap validation only applies when the resulting row will be
  -- ACTIVE: a brand-new period is active by default (p_id is null), and
  -- an edit to an already-active period must not silently create a
  -- conflict. Editing an INACTIVE period skips this check entirely — it
  -- does not participate in pricing while inactive, so it cannot conflict
  -- with anything until it is reactivated, at which point
  -- set_court_rate_period_active re-runs this identical check. Activation
  -- state itself is never touched here — only set_court_rate_period_active
  -- manages is_active.
  if p_id is null or v_existing.is_active then
    select exists (
      select 1
        from public.court_rate_periods crp
       where crp.club_id   = v_club_id
         and crp.is_active = true
         and (p_id is null or crp.id <> p_id)
         and crp.days_of_week && p_days_of_week
         and crp.starts_at_local < p_ends_at_local
         and crp.ends_at_local   > p_starts_at_local
    ) into v_overlap_exists;

    if v_overlap_exists then
      raise exception 'rate_period_overlap';
    end if;
  end if;

  if p_id is null then
    insert into public.court_rate_periods (
      club_id, name, days_of_week, starts_at_local, ends_at_local,
      hourly_rate_cents, hourly_rate_non_member_cents
    ) values (
      v_club_id, btrim(p_name), p_days_of_week, p_starts_at_local, p_ends_at_local,
      p_hourly_rate_cents, p_hourly_rate_non_member_cents
    )
    returning * into v_result;

    insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
    values (
      v_club_id, auth.uid(), 'create_court_rate_period', 'court_rate_period', v_result.id,
      jsonb_build_object(
        'name', v_result.name,
        'days_of_week', v_result.days_of_week,
        'starts_at_local', v_result.starts_at_local,
        'ends_at_local', v_result.ends_at_local,
        'hourly_rate_cents', v_result.hourly_rate_cents,
        'hourly_rate_non_member_cents', v_result.hourly_rate_non_member_cents
      )
    );
  else
    update public.court_rate_periods set
      name                         = btrim(p_name),
      days_of_week                 = p_days_of_week,
      starts_at_local              = p_starts_at_local,
      ends_at_local                = p_ends_at_local,
      hourly_rate_cents            = p_hourly_rate_cents,
      hourly_rate_non_member_cents = p_hourly_rate_non_member_cents,
      updated_at                   = now()
    where id = p_id and club_id = v_club_id
    returning * into v_result;

    insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
    values (
      v_club_id, auth.uid(), 'update_court_rate_period', 'court_rate_period', v_result.id,
      jsonb_build_object(
        'before', jsonb_build_object(
          'name', v_existing.name,
          'days_of_week', v_existing.days_of_week,
          'starts_at_local', v_existing.starts_at_local,
          'ends_at_local', v_existing.ends_at_local,
          'hourly_rate_cents', v_existing.hourly_rate_cents,
          'hourly_rate_non_member_cents', v_existing.hourly_rate_non_member_cents
        ),
        'after', jsonb_build_object(
          'name', v_result.name,
          'days_of_week', v_result.days_of_week,
          'starts_at_local', v_result.starts_at_local,
          'ends_at_local', v_result.ends_at_local,
          'hourly_rate_cents', v_result.hourly_rate_cents,
          'hourly_rate_non_member_cents', v_result.hourly_rate_non_member_cents
        )
      )
    );
  end if;

  return v_result;
end;
$$;

revoke execute on function public.upsert_court_rate_period(uuid, text, integer[], time, time, integer, integer) from public, anon;
grant  execute on function public.upsert_court_rate_period(uuid, text, integer[], time, time, integer, integer) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. set_court_rate_period_active — Deactivate (p_active = false) /
--    Reactivate (p_active = true). Reactivation re-runs the identical
--    overlap validation Add/Edit already enforce — a period switched off
--    months ago could otherwise collide with something added while it was
--    inactive. Deactivation needs no overlap check (an inactive period can
--    never conflict with anything). No hard-delete RPC in v1.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.set_court_rate_period_active(
  p_id     uuid,
  p_active boolean
)
returns public.court_rate_periods
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id        uuid;
  v_role           text;
  v_existing       public.court_rate_periods%rowtype;
  v_result         public.court_rate_periods%rowtype;
  v_overlap_exists boolean;
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

  if v_role is distinct from 'admin' then
    raise exception 'insufficient_role';
  end if;

  if p_active is null then
    raise exception 'active_required';
  end if;

  -- Serialize concurrent rate-period mutations for this club — identical
  -- lock target as upsert_court_rate_period.
  perform 1 from public.club_settings where club_id = v_club_id for update;

  select * into v_existing
    from public.court_rate_periods
   where id = p_id and club_id = v_club_id;
  if not found then
    raise exception 'rate_period_not_found';
  end if;

  if p_active and not v_existing.is_active then
    select exists (
      select 1
        from public.court_rate_periods crp
       where crp.club_id   = v_club_id
         and crp.is_active = true
         and crp.id <> p_id
         and crp.days_of_week && v_existing.days_of_week
         and crp.starts_at_local < v_existing.ends_at_local
         and crp.ends_at_local   > v_existing.starts_at_local
    ) into v_overlap_exists;

    if v_overlap_exists then
      raise exception 'rate_period_overlap';
    end if;
  end if;

  update public.court_rate_periods set
    is_active  = p_active,
    updated_at = now()
  where id = p_id and club_id = v_club_id
  returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id,
    auth.uid(),
    case when p_active then 'reactivate_court_rate_period' else 'deactivate_court_rate_period' end,
    'court_rate_period',
    v_result.id,
    jsonb_build_object('is_active', p_active)
  );

  return v_result;
end;
$$;

revoke execute on function public.set_court_rate_period_active(uuid, boolean) from public, anon;
grant  execute on function public.set_court_rate_period_active(uuid, boolean) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. create_reservation — verbatim 0190 body. The ONLY change: the inline
--    rate-coalesce block (both branches, including the memberships_enabled
--    predicate) is replaced by one call to the shared resolver.
--    membership_pricing_class's own computation is byte-identical to 0190.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.create_reservation(p_court_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_format text DEFAULT NULL::text, p_player_count integer DEFAULT NULL::integer, p_guest_names text[] DEFAULT NULL::text[], p_notes text DEFAULT NULL::text)
 RETURNS reservations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_profile           profiles%rowtype;
  v_settings          club_settings%rowtype;
  v_court              courts%rowtype;
  v_tz                  text;
  v_date                date;                             -- Phase 17A: local booking date
  v_override            operating_hours_override%rowtype;  -- Phase 17A: date-specific override
  v_dow                 int;
  v_hours               operating_hours%rowtype;
  v_result              reservations%rowtype;
  -- Phase 33C1: the caller's own durable Member identity for this club.
  v_roster_member_id    uuid;
  -- Phase 34B: resolved/snapshotted court-booking price.
  v_hourly_rate_cents    integer;
  v_price_amount_cents   integer;
  -- Phase 42B: resolved/snapshotted membership pricing class.
  v_membership_pricing_class text;
  -- Peak/Off-Peak Pricing — Checkpoint A: shared Peak/Off-Peak-capable rate resolution.
  v_rate_resolution record;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.status <> 'active' then raise exception 'account_inactive'; end if;

  -- Phase 33F3B: Staff-Managed Members may not book a NEW court reservation.
  -- Never gates Admin/Pro self-booking. Phase 34A3: restated as an
  -- explicit admin/pro allowlist rather than a member-exclusion, so a
  -- Staff person's own self-service booking is gated the same as a
  -- Member's — see this section's header above for the full rationale.
  if v_profile.role not in ('admin', 'pro') and not current_club_has_capability('member_self_service') then
    raise exception 'capability_not_available';
  end if;

  -- Phase 33C1: resolve the caller's own roster identity in this club.
  -- Never client-supplied — auth.uid() and v_profile.club_id are both
  -- server-derived, exactly like every other identity resolution in this
  -- function. A member can never specify another person's identity here;
  -- this only ever resolves the CALLER's own roster row. Fails closed:
  -- every active club member is expected to have one (Phase 33B1's own
  -- backfill plus accept_club_invite's fail-closed roster resolution both
  -- guarantee this for anyone who could reach this point), so this should
  -- never legitimately raise — it is verified, not assumed.
  select id into v_roster_member_id
    from roster_members
   where club_id    = v_profile.club_id
     and claimed_by = auth.uid();
  if not found then raise exception 'no_roster_identity'; end if;

  select * into v_court
    from courts
    where id        = p_court_id
      and club_id   = v_profile.club_id
      and is_active = true;
  if not found then raise exception 'court_not_found'; end if;

  select * into v_settings from club_settings where club_id = v_profile.club_id;

  select timezone into v_tz from clubs where id = v_profile.club_id;

  -- Past-date guard: applies to all roles. Admins and pros may not book in the past.
  if p_starts_at < now() then
    raise exception 'cannot_book_past';
  end if;

  -- Phase 34A3: booking-window guard restated as an explicit admin/pro
  -- allowlist rather than a member-exclusion — see the section header
  -- above. Behavior for member/admin/pro is byte-identical to before;
  -- Staff is newly, deliberately included in the restricted side.
  if v_profile.role not in ('admin', 'pro')
     and p_starts_at > now() + (v_settings.booking_window_days || ' days')::interval then
    raise exception 'outside_booking_window';
  end if;

  if p_ends_at <= p_starts_at then
    raise exception 'invalid_duration';
  end if;

  -- Phase 20D-B: member court reservations must use one of the supported durations.
  if extract(epoch from (p_ends_at - p_starts_at)) / 60 not in (30, 60, 90, 120) then
    raise exception 'invalid_duration';
  end if;

  -- ---------------------------------------------------------------------------
  -- Phase 17A: check for a date-specific override before falling back to the
  -- weekly operating_hours. The override lookup uses the club-local calendar
  -- date (v_date) derived from the booking's starts_at timestamp.
  -- ---------------------------------------------------------------------------
  v_date := (p_starts_at at time zone v_tz)::date;
  v_dow  := extract(dow from p_starts_at at time zone v_tz)::int;

  select * into v_override
    from operating_hours_override
    where club_id       = v_profile.club_id
      and override_date = v_date;

  if found then
    -- An override exists for this date — it takes priority over weekly hours.
    if v_override.is_closed then
      raise exception 'club_closed_this_day';
    end if;
    -- When special hours are set, reject bookings that fall outside them.
    if v_override.opens_at is not null and v_override.closes_at is not null then
      if (p_starts_at at time zone v_tz)::time < v_override.opens_at
         or (p_ends_at at time zone v_tz)::time > v_override.closes_at then
        raise exception 'outside_operating_hours';
      end if;
    end if;
    -- Override exists and booking is within bounds; skip the weekly check below.
  else
    -- No override for this date — apply normal weekly operating_hours.
    select * into v_hours
      from operating_hours
      where club_id     = v_profile.club_id
        and day_of_week = v_dow;

    if not found or v_hours.is_closed then
      raise exception 'club_closed_this_day';
    end if;

    if (p_starts_at at time zone v_tz)::time < v_hours.opens_at
       or (p_ends_at at time zone v_tz)::time > v_hours.closes_at then
      raise exception 'outside_operating_hours';
    end if;
  end if;
  -- ---------------------------------------------------------------------------

  -- Phase 42B: resolve the booking identity's membership pricing class via
  -- the canonical, role-agnostic predicate (0188) — Admin/Pro/Staff get
  -- Member pricing exactly like a plain Member if their own roster
  -- identity has active business membership, and vice versa. Named
  -- reservation participants/guests (Phase 37) are never consulted — only
  -- the booking identity itself determines the base court rate. Computed
  -- unconditionally — memberships_enabled and rate periods affect only
  -- which RATE this classification resolves to, never whether the
  -- classification itself happens.
  v_membership_pricing_class := case
    when public.is_active_club_member(v_roster_member_id, v_profile.club_id) then 'member'
    else 'non_member'
  end;

  -- Peak/Off-Peak Pricing — Checkpoint A: resolve and snapshot court-booking price via the shared,
  -- start-time-aware resolver — court override, else the ACTIVE rate
  -- period matching this reservation's club-local START time (locked
  -- start-time-pricing rule — no proration), else club default, per
  -- Member/Non-Member class (Non-Member chain only when
  -- memberships_enabled). Snapshotted once, here, at booking time — a
  -- later admin rate/rate-period change never reprices this reservation.
  select * into v_rate_resolution
    from public._resolve_court_reservation_rate(
      v_profile.club_id, p_court_id, v_membership_pricing_class, p_starts_at
    );
  v_hourly_rate_cents := v_rate_resolution.hourly_rate_cents;

  if v_hourly_rate_cents is not null then
    v_price_amount_cents := round(v_hourly_rate_cents * extract(epoch from (p_ends_at - p_starts_at)) / 3600.0)::integer;
  else
    v_price_amount_cents := null;
  end if;

  insert into reservations (
    club_id, court_id, owner_user_id, roster_member_id,
    starts_at, ends_at, status, reason,
    format, player_count, guest_names, notes, created_by,
    hourly_rate_cents, price_amount_cents, membership_pricing_class
  ) values (
    v_profile.club_id, p_court_id, auth.uid(), v_roster_member_id,
    p_starts_at, p_ends_at, 'confirmed', 'member_booking',
    p_format, p_player_count, p_guest_names, p_notes, auth.uid(),
    v_hourly_rate_cents, v_price_amount_cents, v_membership_pricing_class
  )
  returning * into v_result;

  -- Phase 34C: ensure a normal payment obligation for this fresh,
  -- confirmed, member_booking reservation. No-op when unpriced or when
  -- the club's payment_mode is not 'manual'.
  perform public._create_payment_obligation(
    v_profile.club_id, 'reservation', v_result.id, v_roster_member_id,
    v_price_amount_cents, auth.uid()
  );

  -- Phase 16F: only insert the in-app notification if the member has this kind enabled.
  if user_pref_enabled(auth.uid(), 'reservation_confirmed') then
    insert into notifications (club_id, user_id, kind, body, metadata)
    values (
      v_profile.club_id,
      auth.uid(),
      'reservation_confirmed',
      v_court.name || ' booked for '
        || to_char(p_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM'),
      jsonb_build_object('reservation_id', v_result.id, 'court_id', p_court_id)
    );
  end if;

  return v_result;
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. admin_create_member_reservation — verbatim 0190 body, identical
--    resolver-call replacement as create_reservation above.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.admin_create_member_reservation(p_court_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_roster_member_id uuid, p_expected_club_id uuid, p_format text DEFAULT NULL::text, p_player_count integer DEFAULT NULL::integer, p_guest_names text[] DEFAULT NULL::text[], p_notes text DEFAULT NULL::text)
 RETURNS reservations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id  uuid;
  v_role     text;
  v_court    public.courts%rowtype;
  v_roster   public.roster_members%rowtype;
  v_owner_id uuid;
  v_tz       text;
  v_date     date;
  v_dow      int;
  v_override public.operating_hours_override%rowtype;
  v_hours    public.operating_hours%rowtype;
  v_result   public.reservations%rowtype;
  -- Phase 34B: resolved/snapshotted court-booking price.
  v_settings public.club_settings%rowtype;
  v_hourly_rate_cents  integer;
  v_price_amount_cents integer;
  -- Phase 42B: resolved/snapshotted membership pricing class.
  v_membership_pricing_class text;
  -- Peak/Off-Peak Pricing — Checkpoint A: shared Peak/Off-Peak-capable rate resolution.
  v_rate_resolution record;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;

  if p_roster_member_id is null then raise exception 'roster_identity_required'; end if;

  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_club_id;
  if not found then raise exception 'roster_member_not_found'; end if;

  v_owner_id := v_roster.claimed_by;

  select * into v_court
    from public.courts
   where id        = p_court_id
     and club_id   = v_club_id
     and is_active = true;
  if not found then raise exception 'court_not_found'; end if;

  select * into v_settings from public.club_settings where club_id = v_club_id;

  select timezone into v_tz from public.clubs where id = v_club_id;

  if p_starts_at < now() then
    raise exception 'cannot_book_past';
  end if;

  if p_ends_at <= p_starts_at then
    raise exception 'invalid_duration';
  end if;

  if extract(epoch from (p_ends_at - p_starts_at)) / 60 not in (30, 60, 90, 120) then
    raise exception 'invalid_duration';
  end if;

  v_date := (p_starts_at at time zone v_tz)::date;
  v_dow  := extract(dow from p_starts_at at time zone v_tz)::int;

  select * into v_override
    from public.operating_hours_override
   where club_id       = v_club_id
     and override_date = v_date;

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
      from public.operating_hours
     where club_id     = v_club_id
       and day_of_week = v_dow;

    if not found or v_hours.is_closed then
      raise exception 'club_closed_this_day';
    end if;

    if (p_starts_at at time zone v_tz)::time < v_hours.opens_at
       or (p_ends_at at time zone v_tz)::time > v_hours.closes_at then
      raise exception 'outside_operating_hours';
    end if;
  end if;

  -- Phase 42B: identical role-agnostic pricing-class resolution as
  -- create_reservation, for the explicit target roster member. Computed
  -- unconditionally, exactly as above.
  v_membership_pricing_class := case
    when public.is_active_club_member(p_roster_member_id, v_club_id) then 'member'
    else 'non_member'
  end;

  -- Peak/Off-Peak Pricing — Checkpoint A: identical resolver call as create_reservation.
  select * into v_rate_resolution
    from public._resolve_court_reservation_rate(
      v_club_id, p_court_id, v_membership_pricing_class, p_starts_at
    );
  v_hourly_rate_cents := v_rate_resolution.hourly_rate_cents;

  if v_hourly_rate_cents is not null then
    v_price_amount_cents := round(v_hourly_rate_cents * extract(epoch from (p_ends_at - p_starts_at)) / 3600.0)::integer;
  else
    v_price_amount_cents := null;
  end if;

  insert into public.reservations (
    club_id, court_id, owner_user_id, roster_member_id,
    starts_at, ends_at, status, reason,
    format, player_count, guest_names, notes, created_by,
    hourly_rate_cents, price_amount_cents, membership_pricing_class
  ) values (
    v_club_id, p_court_id, v_owner_id, p_roster_member_id,
    p_starts_at, p_ends_at, 'confirmed', 'member_booking',
    p_format, p_player_count, p_guest_names, p_notes, auth.uid(),
    v_hourly_rate_cents, v_price_amount_cents, v_membership_pricing_class
  )
  returning * into v_result;

  -- Phase 34C: ensure a normal payment obligation for this fresh,
  -- confirmed, member_booking reservation.
  perform public._create_payment_obligation(
    v_club_id, 'reservation', v_result.id, p_roster_member_id,
    v_price_amount_cents, auth.uid()
  );

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id,
    auth.uid(),
    'admin_create_member_reservation',
    'reservation',
    v_result.id,
    jsonb_build_object(
      'roster_member_id', p_roster_member_id,
      'owner_user_id',    v_owner_id,
      'court_id',         p_court_id,
      'starts_at',        p_starts_at,
      'ends_at',          p_ends_at
    )
  );

  return v_result;
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. update_member_reservation — verbatim 0190 body. Two changes:
--      a. new v_starts_at_changed flag added to the fresh-rate trigger
--         condition (`v_court_changed or v_member_changed` ->
--         `v_court_changed or v_member_changed or v_starts_at_changed`).
--         v_scheduling_changed already covers loading v_court (with the
--         existing is_active requirement) whenever starts_at changes, so
--         no change is needed to either v_court-loading block — only the
--         trigger CONDITION for which branch resolves a fresh rate.
--      b. that branch's inline rate-coalesce block (and its now-redundant
--         `select * into v_settings` — the resolver loads club_settings
--         itself) replaced by the shared resolver call, using the
--         ALREADY-COMPUTED v_new_pricing_class (fresh only on
--         reassignment, preserved otherwise — 0190's rule, untouched).
--    The duration-only and no-change branches are byte-identical to 0190.
-- ═══════════════════════════════════════════════════════════════════════════
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
  v_court_changed        boolean;
  v_duration_changed     boolean;
  v_new_hourly_rate_cents  integer;
  v_new_price_amount_cents integer;
  -- Phase 34E-A: pre-mutation Stripe Checkout invalidation.
  v_payment_id_for_checkout_guard uuid;
  -- Phase 42B: reassignment-aware membership pricing class.
  v_new_pricing_class    text;
  -- Peak/Off-Peak Pricing — Checkpoint A: starts_at is a fresh-rate trigger in its own right (a
  -- start-time shift can cross a rate-period boundary even when
  -- court/member/duration are all unchanged), and the shared resolver.
  v_starts_at_changed    boolean;
  v_rate_resolution      record;
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
  -- own header comment above for the full rule statement.
  v_court_changed     := p_court_id is distinct from v_before.court_id;
  v_duration_changed  := (p_ends_at - p_starts_at) is distinct from (v_before.ends_at - v_before.starts_at);
  v_starts_at_changed := p_starts_at is distinct from v_before.starts_at;

  -- Phase 42B: membership pricing class — resolved fresh ONLY when the
  -- Member is being reassigned (a new customer identity, per this
  -- migration's locked rule); otherwise preserved exactly from the
  -- reservation's existing snapshot, regardless of any court/duration/
  -- starts_at change on this same edit. Role-agnostic, matching
  -- create_reservation. Computed unconditionally — unaffected by
  -- memberships_enabled or rate periods.
  if v_member_changed then
    v_new_pricing_class := case
      when public.is_active_club_member(p_roster_member_id, v_club_id) then 'member'
      else 'non_member'
    end;
  else
    v_new_pricing_class := v_before.membership_pricing_class;
  end if;

  -- Phase 42B (correction): when the Member is reassigned WITHOUT any
  -- scheduling change, v_court was never loaded by the v_scheduling_changed
  -- block above — load it now, same-club scoped, to read its pricing
  -- fields for repricing the new customer identity. Deliberately does NOT
  -- require is_active = true, unlike the court-change path above: this is
  -- a read of the reservation's ALREADY-BOOKED court, not authorization to
  -- create or move a booking onto it. A court legitimately deactivated for
  -- NEW bookings after this reservation was made must not block Admin from
  -- reassigning that existing, unmoved booking to a different roster
  -- Member — the court/time are not changing, only who is being billed for
  -- them. Contrast with v_scheduling_changed's own lookup, which DOES
  -- require is_active = true because it governs moving a booking onto a
  -- (possibly different) court, a genuine new-booking decision.
  if v_member_changed and not v_scheduling_changed then
    select * into v_court
      from courts
      where id = p_court_id and club_id = v_club_id;
    if not found then raise exception 'invalid_court'; end if;
  end if;

  -- Peak/Off-Peak Pricing — Checkpoint A: fresh-rate trigger now also fires on a starts_at change —
  -- a start-time shift can cross a rate-period boundary even when
  -- court/member/duration are all unchanged (e.g. 2:00-3:00 PM ->
  -- 5:00-6:00 PM, same court/member/duration, still must re-resolve).
  -- v_scheduling_changed already covers loading v_court (with is_active)
  -- whenever starts_at changes, so no new v_court-loading logic is needed
  -- — only this trigger condition changes.
  if v_court_changed or v_member_changed or v_starts_at_changed then
    select * into v_rate_resolution
      from public._resolve_court_reservation_rate(
        v_club_id, p_court_id, v_new_pricing_class, p_starts_at
      );
    v_new_hourly_rate_cents := v_rate_resolution.hourly_rate_cents;
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
  if v_new_pricing_class is distinct from v_before.membership_pricing_class then
    v_changed_fields := array_append(v_changed_fields, 'membership_pricing_class');
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
    membership_pricing_class = v_new_pricing_class,
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
        'price_amount_cents', v_before.price_amount_cents,
        'membership_pricing_class', v_before.membership_pricing_class
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
        'price_amount_cents', v_after.price_amount_cents,
        'membership_pricing_class', v_after.membership_pricing_class
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
-- 8. update_club_pricing — verbatim 0189 body (signature UNCHANGED, so a
--    plain CREATE OR REPLACE is sufficient — no DROP needed). Two changes:
--      a. one new UNION ALL clause in the existing currency-lock scan,
--         covering court_rate_periods' two rate columns exactly like every
--         other pricing source already scanned. Not filtered by is_active,
--         matching the existing courts/club_settings scan sources, which
--         are likewise unfiltered by any active/inactive concept of their
--         own.
--      b. the existing `select * into v_settings from club_settings ...`
--         now locks that row (FOR UPDATE) — the SAME club_settings row
--         mutex upsert_court_rate_period / set_court_rate_period_active
--         already take before their own overlap validation. Without this,
--         a currency change could race a concurrent rate-period creation:
--         the positive-pricing scan below could run and find nothing
--         while another transaction is mid-flight inserting a positive
--         court_rate_period under the OLD currency, and this function
--         could then commit a currency change the about-to-commit period
--         row was actually priced under. Locking the same row both
--         mutation paths already contend on serializes the two exactly
--         like any other same-club rate-period race.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.update_club_pricing(
  p_currency text,
  p_default_court_hourly_rate_cents integer,
  p_default_court_hourly_rate_non_member_cents integer default null
)
returns club_settings
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id  uuid;
  v_role     text;
  v_settings club_settings%rowtype;
  v_currency text;
  v_positive_pricing_exists boolean;
  v_result   club_settings%rowtype;
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

  if v_role is distinct from 'admin' then
    raise exception 'insufficient_role';
  end if;

  -- Locks the SAME club_settings row upsert_court_rate_period /
  -- set_court_rate_period_active already lock before their own overlap
  -- validation — serializes this currency change against a concurrent
  -- rate-period mutation so the positive-pricing scan below can never run
  -- against a stale view of court_rate_periods.
  select * into v_settings from club_settings where club_id = v_club_id for update;

  if p_currency is null or btrim(p_currency) = '' then raise exception 'currency_required'; end if;
  v_currency := upper(btrim(p_currency));
  if v_currency !~ '^[A-Z]{3}$' then raise exception 'invalid_currency'; end if;

  if p_default_court_hourly_rate_cents is not null and p_default_court_hourly_rate_cents < 0 then
    raise exception 'invalid_rate';
  end if;

  -- Phase 42B.
  if p_default_court_hourly_rate_non_member_cents is not null and p_default_court_hourly_rate_non_member_cents < 0 then
    raise exception 'invalid_rate';
  end if;

  if v_currency is distinct from v_settings.currency then
    select exists (
      select 1 from club_settings where club_id = v_club_id and default_court_hourly_rate_cents > 0
      union all
      select 1 from club_settings where club_id = v_club_id and default_court_hourly_rate_non_member_cents > 0
      union all
      select 1 from courts where club_id = v_club_id and hourly_rate_cents > 0
      union all
      select 1 from courts where club_id = v_club_id and hourly_rate_non_member_cents > 0
      union all
      select 1 from court_rate_periods
        where club_id = v_club_id
          and (hourly_rate_cents > 0 or hourly_rate_non_member_cents > 0)
      union all
      select 1 from lesson_types where club_id = v_club_id and unit_price_amount_cents > 0
      union all
      select 1 from event_types where club_id = v_club_id and default_price_amount_cents > 0
      union all
      select 1 from events where club_id = v_club_id and price_amount_cents > 0
      union all
      select 1 from programs where club_id = v_club_id and price_amount_cents > 0
      union all
      select 1 from reservations
        where club_id = v_club_id
          and (hourly_rate_cents > 0 or price_amount_cents > 0)
      union all
      select 1 from lesson_requests
        where club_id = v_club_id
          and (unit_price_amount_cents > 0 or price_amount_cents > 0)
      union all
      select 1 from event_participants ep
        join events e on e.id = ep.event_id
        where e.club_id = v_club_id and ep.price_amount_cents > 0
      union all
      select 1 from event_guests eg
        join events e on e.id = eg.event_id
        where e.club_id = v_club_id and eg.price_amount_cents > 0
      union all
      select 1 from program_enrollments pe
        join programs p on p.id = pe.program_id
        where p.club_id = v_club_id and pe.price_amount_cents > 0
    ) into v_positive_pricing_exists;

    if v_positive_pricing_exists then
      raise exception 'currency_locked_by_pricing';
    end if;
  end if;

  update club_settings set
    currency                                    = v_currency,
    default_court_hourly_rate_cents             = p_default_court_hourly_rate_cents,
    default_court_hourly_rate_non_member_cents  = p_default_court_hourly_rate_non_member_cents,
    updated_at                                  = now()
  where club_id = v_club_id
  returning * into v_result;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id,
    auth.uid(),
    'update_club_pricing',
    'club_settings',
    v_result.club_id,
    jsonb_build_object(
      'currency', v_currency,
      'default_court_hourly_rate_cents', p_default_court_hourly_rate_cents,
      'default_court_hourly_rate_non_member_cents', p_default_court_hourly_rate_non_member_cents
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.update_club_pricing(text, integer, integer) from public, anon;
grant  execute on function public.update_club_pricing(text, integer, integer) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Restore create_reservation, admin_create_member_reservation, and
--    update_member_reservation to their exact 0190 bodies (this migration
--    changed only the pricing-resolution block/trigger condition in each —
--    reverting is a pure text restore, no signature change).
-- 2. Restore update_club_pricing to its exact 0189 body (drop the one
--    added UNION ALL clause) via CREATE OR REPLACE — no DROP needed, the
--    signature never changed.
-- 3. Drop public.upsert_court_rate_period(uuid, text, integer[], time,
--    time, integer, integer) and public.set_court_rate_period_active(uuid,
--    boolean) outright (both new, safe to drop).
-- 4. Drop public._resolve_court_reservation_rate(uuid, uuid, text,
--    timestamptz) outright (new, safe to drop — no other function calls
--    it after step 1's restore).
-- 5. `drop table public.court_rate_periods;` (cascades its own index,
--    trigger, and RLS policy).
-- No other table, policy, or function is touched by this migration. 0188,
-- 0189, and 0190 are read-only consumed here, never modified. No
-- reservations row is ever UPDATEd by this migration — no backfill, no
-- bulk rewrite.
