-- 0108_staff_managed_reservations_identity.sql
-- Phase 33C1: Staff-Managed Reservations — Identity + RPC Foundation
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 33C's targeted audit (read-only, no code) found that reservations
-- has zero relationship to roster_members — the permanent, club-scoped
-- Member identity established and now live in production as of Phase
-- 33B/33B1. This migration establishes roster_members as the durable
-- Member attribution for reason='member_booking' reservations, while
-- preserving every existing self-service behavior byte-for-byte.
--
-- Locked architecture (unchanged, restated):
--   - roster_members.id = permanent club-scoped Member business identity.
--   - reservations.roster_member_id (new) = durable Member attribution for
--     reason = 'member_booking'. Never null for a row created after this
--     migration; backfilled for every resolvable historical row below.
--   - reservations.owner_user_id (existing) = optional authenticated
--     compatibility/self-service field. Relaxed to nullable — populated
--     whenever the roster identity happens to be claimed (self-service, or
--     staff booking for a claimed Member), null when staff books for a
--     no-account Member. Never derived live from roster_members.claimed_by
--     at query time — it continues to mean "the authenticated identity at
--     booking time," matching every existing owner_user_id-keyed query
--     (My Schedule, Admin Overview, RLS self-cancel) unchanged.
--   - reservations.created_by (existing, untouched) = the authenticated
--     actor who performed the write. Already correct for every reason
--     value, including pro_lesson's inverted case (Phase 33B design doc
--     §15) — no change needed or made here.
--   - True guests (guest_names) remain wholly separate — never conflated
--     with roster_member_id, never touched by this migration.
--
-- Explicitly OUT OF SCOPE for this migration (per the 33C1 implementation
-- brief, corrections 1-4, and the standing Phase 33 discipline of minimum-
-- necessary change):
--   - No p_target_profile_id on create_reservation. Responsibilities stay
--     split: create_reservation is self-service only; the new
--     admin_create_member_reservation is the sole staff-booking path.
--   - No new removed/inactive-member booking restriction on the target
--     roster identity — no existing reservations-domain rule checks this
--     today (create_reservation's account_inactive check gates the ACTOR's
--     own profile in the self-service case, where actor == owner; it has
--     never been a target-eligibility rule), so none is added here.
--   - No new per-Member double-booking restriction — the GiST exclude
--     constraint (court_id + time range) remains the sole overlap
--     authority, exactly as today. No roster_member_id-keyed conflict
--     check is added.
--   - update_member_reservation, cancel_member_reservation,
--     admin_cancel_reservation, RLS policies, get_member_activity_history,
--     and every event/maintenance/lesson/program RPC are untouched.
--   - pro_lesson reason rows are not backfilled or touched — deferred to
--     33D1 (Staff-Managed Lessons), per instruction.
--   - No notifications/communications change of any kind, including inside
--     the new admin RPC — explicitly out of scope for this checkpoint.
--   - Not applied by this checkpoint. Not committed.
--
-- TRANSACTION BOUNDARY: the entire migration — schema changes, the new
-- identity-guard trigger, the fail-closed backfill guard, the backfill
-- itself, and both RPC changes — runs inside one BEGIN/COMMIT. If the
-- fail-closed guard or any later statement fails, no schema or data change
-- from this migration survives; Postgres DDL is fully transactional, so
-- this is safe (a prior draft ran the schema ALTERs before BEGIN — moved
-- here so the whole file commits or rolls back as one unit).
--
-- ═══════════════════════════════════════════════════════════════════════════
-- A. SCHEMA
-- ═══════════════════════════════════════════════════════════════════════════
-- roster_member_id: nullable, FK to roster_members(id), NO "on delete"
-- clause (default NO ACTION — blocks the delete rather than silently
-- orphaning reservation history). This deliberately differs from the
-- Phase 33B1 precedent (club_invites.roster_member_id, event_guests.
-- roster_member_id — both ON DELETE SET NULL): those rows are transient/
-- procedural (an invite or a guest-list entry losing its roster link is a
-- small, recoverable loss), whereas a reservation is a historical Member
-- activity record — losing its Member attribution is exactly the kind of
-- silent history loss this whole Phase 33 effort exists to prevent. A
-- roster_members row cannot currently be hard-deleted once claimed
-- (delete_roster_member already blocks that); the practical effect of NO
-- ACTION here is blocking deletion of an UNCLAIMED roster row that has
-- accrued reservation history — correct, since that history must survive
-- even if the person never creates an account.
--
-- owner_user_id: relaxed from NOT NULL to nullable. No other constraint on
-- it changes — it remains a `profiles(id)` FK, still populated identically
-- to today for every case except "staff books for an unclaimed Member."
--
-- No other reservation or activity table is touched.
begin;

alter table public.reservations
  add column if not exists roster_member_id uuid references public.roster_members(id);

create index if not exists reservations_roster_member_id_idx
  on public.reservations (roster_member_id)
  where roster_member_id is not null;

comment on column public.reservations.roster_member_id is
  'Phase 33C1: durable Member identity for reason=''member_booking'' rows —
   the permanent roster_members.id this reservation is/was for, regardless
   of whether that identity is authenticated. NULL for maintenance/
   admin_block/event rows (no Member at all) and, for this checkpoint,
   pro_lesson rows (deferred to Phase 33D1). Never reassigned once set.';

alter table public.reservations
  alter column owner_user_id drop not null;

comment on column public.reservations.owner_user_id is
  'Optional authenticated compatibility/self-service identity — the
   profiles(id) that was authenticated at booking time, when one exists.
   NULL only for a member_booking reservation staff created for a
   no-account roster Member (roster_member_id is set in that case; this
   column is not derived live from roster_members.claimed_by and does not
   change if that identity is claimed later). Untouched for every other
   reason value.';

-- ═══════════════════════════════════════════════════════════════════════════
-- A2. STRUCTURAL IDENTITY GUARD — validation trigger enforcing the
--     member_booking invariant at the database boundary (not just inside
--     the RPCs). Created here, before the backfill below, so it also
--     independently re-validates every row the backfill touches.
-- ═══════════════════════════════════════════════════════════════════════════
-- Why a trigger, not a CHECK constraint: a CHECK constraint can only see
-- columns on the same row — it cannot join against roster_members to
-- confirm the referenced identity belongs to the same club or is claimed
-- by the stated owner. That cross-table invariant is exactly what
-- reservations_insert_own's RLS policy cannot express either (RLS on
-- reservations has no visibility into roster_members at insert time) — a
-- direct, RLS-permitted client INSERT satisfying reservations_insert_own
-- today (owner_user_id = auth.uid(), created_by = auth.uid(), reason =
-- 'member_booking', club_id = current_user_club_id()) could still omit
-- roster_member_id entirely, or set it to an arbitrary UUID belonging to a
-- different club or a different person's claimed roster identity — RLS
-- alone cannot catch either case. This trigger is the smallest robust fix:
-- one BEFORE INSERT OR UPDATE OF (reason, roster_member_id, owner_user_id,
-- club_id) trigger, gated by WHEN (new.reason = 'member_booking'), so it
-- never fires for and never alters identity on maintenance/admin_block/
-- event/pro_lesson rows.
--
-- Enforces exactly the four invariants requested, no more:
--   1. roster_member_id IS NOT NULL for a member_booking row.
--   2. The referenced roster_members row's club_id matches the
--      reservation's own club_id (no cross-club roster identity, ever).
--   3. If owner_user_id IS NOT NULL, that roster row's claimed_by must
--      equal it exactly — a client can never point a "self" booking
--      (where RLS already forces owner_user_id = auth.uid()) at someone
--      else's roster identity.
--   4. owner_user_id IS NULL remains valid and unconstrained against
--      claimed_by — a staff-created no-account-Member booking is not
--      required to correlate with any particular claimed_by state.
--
-- No new booking policy is added — this does not touch booking-window,
-- operating-hours, duration, or overlap rules in any way; it only
-- validates the identity columns already being written by the RPCs.
--
-- "A later claim must not invalidate an existing NULL-owner reservation"
-- is satisfied structurally, not by special-case logic: this trigger is
-- defined ONLY on reservations INSERT/UPDATE OF the four named columns. A
-- later accept_club_invite call that sets roster_members.claimed_by is a
-- write to roster_members, not to reservations, so it can never re-fire
-- this trigger against any existing reservation row — there is nothing
-- here to re-validate on a claim, by construction.
--
-- SECURITY DEFINER + fixed search_path: a plain member's own direct
-- reservations INSERT (permitted by reservations_insert_own) must still
-- have this trigger's roster_members lookup succeed regardless of that
-- member's own RLS visibility into roster_members (admin-only SELECT,
-- 0056) — the trigger function needs to read roster_members independent
-- of the inserting session's own privileges, exactly like every other
-- cross-table check in this codebase that must not depend on the caller's
-- own row-level visibility.
create or replace function public.enforce_member_booking_roster_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_roster public.roster_members%rowtype;
begin
  if new.roster_member_id is null then
    raise exception 'member_booking_requires_roster_identity';
  end if;

  select * into v_roster
    from public.roster_members
   where id = new.roster_member_id;

  if not found then
    raise exception 'roster_member_not_found';
  end if;

  if v_roster.club_id <> new.club_id then
    raise exception 'roster_member_wrong_club';
  end if;

  if new.owner_user_id is not null and v_roster.claimed_by is distinct from new.owner_user_id then
    raise exception 'roster_member_owner_mismatch';
  end if;

  return new;
end;
$$;

drop trigger if exists reservations_member_booking_identity_guard on public.reservations;

create trigger reservations_member_booking_identity_guard
  before insert or update of reason, roster_member_id, owner_user_id, club_id
  on public.reservations
  for each row
  when (new.reason = 'member_booking')
  execute function public.enforce_member_booking_roster_identity();

-- ═══════════════════════════════════════════════════════════════════════════
-- B. EXISTING member_booking BACKFILL — fail-closed guard, then backfill
-- ═══════════════════════════════════════════════════════════════════════════
-- Coverage is expected to be deterministic and complete, not probabilistic:
-- every existing reason='member_booking' row's owner_user_id is, by
-- create_reservation's own (unchanged) authorization logic, an
-- authenticated profile that held a club_memberships row in that club_id
-- at booking time — and Phase 33B1's own backfill ran over EVERY
-- club_memberships row, including removed ones, guaranteeing a matching,
-- claimed roster_members row already exists for every such pairing. This
-- guard exists to verify that guarantee against real data rather than
-- assume it, matching the fail-closed discipline established in 0107 — it
-- should never fire, but the migration does not proceed if it does.
do $$
declare
  v_unresolved_count int;
begin
  select count(*) into v_unresolved_count
    from public.reservations r
   where r.reason = 'member_booking'
     and not exists (
       select 1 from public.roster_members rm
        where rm.claimed_by = r.owner_user_id
          and rm.club_id    = r.club_id
     );

  if v_unresolved_count > 0 then
    raise exception
      'phase33c1_unresolved_reservation_identities: % reservation(s) with reason=''member_booking'' cannot resolve exactly one roster identity via (roster_members.claimed_by = reservations.owner_user_id AND roster_members.club_id = reservations.club_id). Run supabase/scripts/verify_phase33c1_preflight.sql for per-row detail — this most likely means Phase 33B1''s own backfill did not fully cover every club_membership for these rows'' owners. Resolve manually (do not fabricate a roster identity), then re-run this migration. No partial backfill will be applied.',
      v_unresolved_count;
  end if;
end $$;

-- Backfill: preserves every reservations.id — one UPDATE, no delete/
-- reinsert. Only reason='member_booking' rows with roster_member_id still
-- null are touched; maintenance/admin_block/event/pro_lesson rows are
-- structurally excluded by the reason filter and are never written by this
-- statement.
update public.reservations r
set    roster_member_id = rm.id
from   public.roster_members rm
where  r.reason           = 'member_booking'
  and  r.roster_member_id is null
  and  rm.claimed_by       = r.owner_user_id
  and  rm.club_id          = r.club_id;

-- ═══════════════════════════════════════════════════════════════════════════
-- C. create_reservation — resolve and write the caller's roster identity;
--    fail closed if none exists. Signature UNCHANGED. Every existing
--    authorization/booking-window/court-hours/duration/overlap/
--    notification rule is preserved verbatim — the only behavioral
--    additions are the roster-identity lookup and the new column in the
--    INSERT list. One additional, non-behavioral hardening change: this
--    function is being rewritten here regardless (CREATE OR REPLACE), so
--    `set search_path = public, pg_temp` is added — the 0059 body never
--    had a fixed search_path, matching the convention every function
--    since 0068 uses. This does not otherwise change create_reservation's
--    behavior in any way.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.create_reservation(
  p_court_id     uuid,
  p_starts_at    timestamptz,
  p_ends_at      timestamptz,
  p_format       text    default null,
  p_player_count int     default null,
  p_guest_names  text[]  default null,
  p_notes        text    default null
)
returns reservations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.status <> 'active' then raise exception 'account_inactive'; end if;

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

  -- Booking-window guard: members only. Admins and pros may book beyond the window.
  if v_profile.role = 'member'
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

  insert into reservations (
    club_id, court_id, owner_user_id, roster_member_id,
    starts_at, ends_at, status, reason,
    format, player_count, guest_names, notes, created_by
  ) values (
    v_profile.club_id, p_court_id, auth.uid(), v_roster_member_id,
    p_starts_at, p_ends_at, 'confirmed', 'member_booking',
    p_format, p_player_count, p_guest_names, p_notes, auth.uid()
  )
  returning * into v_result;

  -- Phase 16F: only insert the in-app notification if the member has this kind enabled.
  -- Unchanged from the currently-effective (0059) body — not touched by 33C1.
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
$$;

-- No revoke/grant restatement — CREATE OR REPLACE preserves the existing
-- privileges on create_reservation, and its signature is unchanged, so no
-- new grant is needed.

-- ═══════════════════════════════════════════════════════════════════════════
-- D. admin_create_member_reservation — new SECURITY DEFINER RPC. Staff
--    books a member_booking reservation for a roster Member, claimed or
--    unclaimed. Admin-only, matching update_member_reservation and
--    admin_cancel_reservation — no existing evidence anywhere in the
--    reservations domain grants Pro authority to administer a reservation
--    on behalf of someone else (Pro's only existing reservation privilege
--    is the relaxed self-booking exemption inside create_reservation
--    itself), so none is added here.
-- ═══════════════════════════════════════════════════════════════════════════
-- Court/operating-hours/duration validation is a direct, unmodified copy of
-- create_reservation's own logic (this migration, Section C) — the same
-- duplication-over-extraction choice already established by
-- update_member_reservation (0097) for this exact domain, not a new
-- pattern. Booking-window guard is intentionally NOT reproduced: create_
-- reservation's own booking-window check only ever applies to role =
-- 'member' callers; this RPC's caller is always an admin (enforced below),
-- so the existing rule's own condition already exempts every caller who
-- can reach this function — this preserves that exact existing condition
-- rather than inventing a new admin-specific exemption.
--
-- No target-eligibility check on the roster identity's membership status —
-- no existing reservations-domain rule checks this for any target, so none
-- is added (see migration header). No roster_member_id-keyed double-
-- booking check — the existing GiST exclude constraint (court_id + time
-- range) remains the sole overlap authority, unchanged. No notification —
-- communications are out of scope for this checkpoint.
--
-- owner_user_id is never a client-supplied value — it is derived here
-- exclusively from the validated roster_members row's own claimed_by
-- column, matching the precedent set by add_roster_member_and_invite/
-- accept_club_invite (0107): never trust a client-asserted identity,
-- always resolve it server-side from a row already validated to belong to
-- the caller's own club.
create or replace function public.admin_create_member_reservation(
  p_court_id          uuid,
  p_starts_at         timestamptz,
  p_ends_at           timestamptz,
  p_roster_member_id  uuid,
  p_expected_club_id  uuid,
  p_format            text    default null,
  p_player_count      int     default null,
  p_guest_names       text[]  default null,
  p_notes             text    default null
)
returns reservations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
begin
  -- Actor authentication + authorization. Same club_id/role resolution
  -- pattern as update_member_reservation (0097) — current_user_club_id()/
  -- current_user_role() already only resolve for an active, non-removed
  -- membership, so no separate account_inactive-style check is needed here.
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;

  -- Resolve and validate the target roster identity — same-club only, no
  -- cross-club roster member can ever be booked. p_roster_member_id is the
  -- only client-supplied identity input; owner_user_id is derived from it
  -- below, never accepted directly.
  if p_roster_member_id is null then raise exception 'roster_identity_required'; end if;

  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_club_id;
  if not found then raise exception 'roster_member_not_found'; end if;

  v_owner_id := v_roster.claimed_by;

  -- Court/duration/operating-hours validation — unmodified copy of
  -- create_reservation's own logic (Section C above), scoped to v_club_id
  -- instead of v_profile.club_id (same value, different resolution path).
  select * into v_court
    from public.courts
   where id        = p_court_id
     and club_id   = v_club_id
     and is_active = true;
  if not found then raise exception 'court_not_found'; end if;

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

  insert into public.reservations (
    club_id, court_id, owner_user_id, roster_member_id,
    starts_at, ends_at, status, reason,
    format, player_count, guest_names, notes, created_by
  ) values (
    v_club_id, p_court_id, v_owner_id, p_roster_member_id,
    p_starts_at, p_ends_at, 'confirmed', 'member_booking',
    p_format, p_player_count, p_guest_names, p_notes, auth.uid()
  )
  returning * into v_result;

  -- Audit — matches update_member_reservation's established shape exactly
  -- (0097): one row per successful admin mutation in this domain.
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
$$;

revoke execute on function public.admin_create_member_reservation(
  uuid, timestamptz, timestamptz, uuid, uuid, text, int, text[], text
) from public, anon;
grant  execute on function public.admin_create_member_reservation(
  uuid, timestamptz, timestamptz, uuid, uuid, text, int, text[], text
) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration is created
-- in this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- CORRECTED ordering: an earlier draft of this section proposed clearing
-- roster_member_id (then step 3) and restoring create_reservation's pre-
-- 0108 body (then step 2) while reservations_member_booking_identity_guard
-- (Section A2) was still installed. Both would fail against the trigger as
-- actually built: clearing roster_member_id on a member_booking row raises
-- member_booking_requires_roster_identity (the trigger fires on UPDATE OF
-- roster_member_id and rejects a null value for reason='member_booking'),
-- and restoring the pre-0108 create_reservation while the trigger remains
-- installed would make every subsequent legacy-style self-service INSERT
-- (which no longer writes roster_member_id at all) fail the same way. The
-- trigger must be removed BEFORE either of those steps, not after. Correct
-- order:
--
-- 1. Drop admin_create_member_reservation:
--    `drop function if exists public.admin_create_member_reservation(
--    uuid, timestamptz, timestamptz, uuid, uuid, text, int, text[], text);`
--    — safe first, no other object in this migration depends on it. Any
--    reservations it already created remain valid, ordinary member_booking
--    rows; nothing about them requires this function to exist.
--
-- 2. Drop the trigger from reservations, before touching the function it
--    calls or any data:
--    `drop trigger if exists reservations_member_booking_identity_guard
--    on public.reservations;`
--    This must happen before steps 4-5 below — while it remains installed,
--    neither restoring create_reservation's pre-0108 body nor clearing any
--    roster_member_id value is possible without the trigger correctly
--    rejecting the write.
--
-- 3. Drop the trigger function, now that nothing references it:
--    `drop function if exists
--    public.enforce_member_booking_roster_identity();`
--
-- 4. Restore create_reservation to its pre-0108 (0059) body via CREATE OR
--    REPLACE FUNCTION (this migration's Section C is identical to 0059
--    except the added roster-identity lookup and the two new INSERT list
--    entries — remove both to revert exactly). Only safe to do after step
--    2 — with the trigger already gone, a reverted create_reservation that
--    no longer writes roster_member_id will not be rejected by it.
--
-- 5. Only now, with the trigger gone (steps 2-3 complete), may
--    roster_member_id values be cleared if the rollback requires it:
--    `update public.reservations set roster_member_id = null where reason
--    = 'member_booking'` — this only ever set a previously-null column; no
--    other field was touched, and no row was inserted or deleted. Attempting
--    this before step 2 fails with member_booking_requires_roster_identity.
--
-- 6. owner_user_id cannot safely return to NOT NULL once any legitimate
--    staff-created no-account-Member reservation exists: `alter table
--    public.reservations alter column owner_user_id set not null;` will
--    FAIL if any row has a null owner_user_id — expected and correct, not
--    a bug to work around. That data represents real bookings for real
--    people with no account, and cannot be truthfully reverted to NOT NULL
--    without fabricating an owner. Do not force it through by deleting
--    those rows or inventing an owner_user_id value for them. A full
--    schema rollback after such reservations exist is therefore NOT
--    automatically lossless: reverting owner_user_id to NOT NULL is only
--    possible if no no-account-Member reservation was ever created, or by
--    accepting that those specific rows/that constraint cannot both be
--    restored — never by deleting real bookings or fabricating identity to
--    force the constraint through.
--
-- 7. Remove the new roster_member_id schema/index only when safe — i.e.,
--    only after step 5 (or after confirming no row still depends on it)
--    and only if step 6's NOT NULL restoration is not itself being
--    abandoned for the reason above: `alter table public.reservations drop
--    column if exists roster_member_id;` (also drops
--    reservations_roster_member_id_idx and reservations_roster_member_id_
--    fkey automatically). Safe once nothing above still needs the column,
--    but — per step 6 — dropping it does not by itself make a full rollback
--    lossless if no-account-Member reservations exist; it only removes the
--    now-unused column, it does not restore owner_user_id's NOT NULL
--    guarantee or recover an identity that was never fabricated.
