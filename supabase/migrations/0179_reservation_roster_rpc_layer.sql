-- 0179_reservation_roster_rpc_layer.sql
-- Phase 37C — Reservation Roster RPC / Authorization Layer.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- 0178 (APPLIED, verified) created reservation_participants/
-- reservation_guests with RLS enabled, zero client-facing policies, and
-- zero direct table privileges — by design, the tables have no ordinary
-- access surface at all. This migration builds that surface: exactly six
-- public SECURITY DEFINER RPCs, plus one private authorization helper that
-- materially reduces duplicated security logic across all six. It does not
-- alter 0178, any existing reservation CRUD RPC, pricing, payments,
-- checkout, refunds, disputes, reporting, player_count, format, or
-- guest_names. No UI is added in this checkpoint.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- FOCUSED PREFLIGHT — exact conventions confirmed against the current repo
-- before writing any of the SQL below (not from paraphrase):
-- ═══════════════════════════════════════════════════════════════════════════
--   - 0178 reservation_participants/reservation_guests: schema unchanged
--     from what was applied — id/reservation_id/roster_member_id (or
--     display_name)/status('active'|'removed')/removed_at/removed_by/
--     added_by/created_at/updated_at; UNIQUE(reservation_id,
--     roster_member_id) on reservation_participants (plain, not partial);
--     reservation_guests.display_name constrained to
--     `display_name = btrim(display_name) and char_length(display_name)
--     between 1 and 100` (canonical-storage form, confirmed current after
--     the post-37B correction). RLS enabled, zero policies, zero grants on
--     both — confirmed unchanged, and this migration adds no policy/grant
--     to either table directly.
--   - current_user_club_id() / current_user_role() (final bodies: 0082):
--     `language sql security definer stable set search_path = public,
--     pg_temp`, resolved exclusively through the active-membership helper
--     (never profiles.club_id/profiles.role) — reused exactly, never
--     bypassed.
--   - current_user_roster_member_id() (0110): same shape, returns the
--     caller's own roster_members.id for their current club or null —
--     reused exactly for claim-continuity ownership matching.
--   - current_club_has_capability(p_capability text) (0122): `select
--     coalesce(club_has_capability(current_user_club_id(), p_capability),
--     false)` — fail-closed (null club -> false, never an error). Reused
--     verbatim for the member_self_service gate, exactly as
--     create_reservation (0131) already calls it.
--   - Expected-club convention (0097/0108/0109/0110/0132, unbroken):
--     `if p_expected_club_id is distinct from v_club_id then raise
--     exception 'stale_club_context'; end if;` — canonical club always
--     comes from current_user_club_id() first; p_expected_club_id is
--     compared, never trusted as authority. Reused exactly.
--   - Claim-continuity ownership (0110's cancel_member_reservation,
--     current/final): `owner_user_id = auth.uid() or (v_roster_member_id
--     is not null and roster_member_id = v_roster_member_id)`, folded
--     directly into the target row's own SELECT ... WHERE clause (not a
--     separate post-hoc check) so an unowned target simply reads as "not
--     found" — the established anti-leakage posture. Reused exactly.
--   - Operator role-gate wording (0108/0109/0132 admin_create_member_
--     reservation/update_member_reservation): `if v_role not in ('admin',
--     'staff') then raise exception 'insufficient_role'; end if;`.
--   - roster_members (0056, altered 0107/0117/0131): status text check
--     ('active','inactive'), default 'active' (0117); role text check
--     ('member','pro','staff','admin') (0131) — confirms "any role is
--     eligible" is a real, already-established roster shape, not a new
--     concept. Safe display-name convention (0117/0118, get_event_roster/
--     get_event_eligible_members): `coalesce(nullif(trim(concat_ws(' ',
--     first_name, last_name)), ''), 'Unknown')::text` — reused verbatim,
--     never email as a fallback.
--   - Error-string reuse confirmed exact: 'roster_identity_required'
--     (0108/0109/0132), 'roster_member_inactive' (0132: `if v_roster.status
--     is distinct from 'active' then raise exception
--     'roster_member_inactive'; end if;`), 'capability_not_available'
--     (0131's create_reservation), 'reservation_not_participant_eligible'
--     / 'reservation_roster_locked' (0178's own domain guard).
--   - audit_log convention (every reservation/event RPC): `insert into
--     audit_log (club_id, actor_id, action, target_type, target_id,
--     metadata) values (...)`, target_type = 'reservation' for every
--     existing reservation-domain audit row (update_member_reservation,
--     cancel_member_reservation) — reused exactly, never a new
--     target_type.
--   - Closest hardened SECURITY DEFINER precedent for the reactivate-or-
--     insert shape: admin_add_roster_participant (0127, post-0114-fix) —
--     `select ... for update; v_existing_found := found;` (FOUND captured
--     into a local boolean on the very next line, before any other SQL
--     statement can overwrite it), then branch update/insert, then a
--     fail-closed `if v_result.id is null then raise exception ...`.
--     Reused exactly for add_reservation_participant below, with one
--     addition (see Section 4's own header) not present in 0127: this
--     table's UNIQUE(reservation_id, roster_member_id) is a PLAIN
--     (non-partial) constraint that always applies, so two genuinely
--     concurrent first-time inserts of the SAME pair race at the database
--     level in a way 0127's own pattern does not itself close — addressed
--     here with an explicit unique_violation retry, never a raw 23P01/
--     23505 leaking to the caller.
--   - No naming/schema contradiction found against any locked requirement.
--     Proceeding as designed.
--
-- Not applied by this checkpoint. Not committed. Does not modify 0001-0178.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. _authorize_reservation_roster_access — the single shared authorization
-- gate for all six public RPCs below. Materially reduces duplicated
-- security logic: every locked rule from the Phase 37C authorization
-- matrix lives here exactly once.
--
-- Returns the authorized reservation row, or raises. Never trusts
-- p_expected_club_id as authority — it is compared against
-- current_user_club_id() for staleness only; every actual data-scoping
-- decision below uses v_club_id (server-resolved), never the parameter.
-- Never reads profiles.role/profiles.club_id, never authorizes from
-- created_by, never authorizes from calendar-visibility RLS (this
-- function's own SELECT is the sole authority, executed with this
-- SECURITY DEFINER function's own elevated read access to
-- public.reservations — RLS is not consulted here any more than it is by
-- any other existing reservation RPC).
--
-- Ownership match is folded directly into the target row's own SELECT ...
-- WHERE clause (the established anti-leakage posture from
-- cancel_member_reservation) rather than a separate post-hoc check: an
-- Admin/Staff caller bypasses the ownership clause entirely
-- (`v_role in ('admin','staff')`); a Member/Pro caller must satisfy real
-- claim-continuity ownership
-- (`owner_user_id = auth.uid() or roster_member_id =
-- current_user_roster_member_id()`) or the row simply is not found — a
-- Member/Pro probing another user's reservation id gets the identical
-- reservation_not_found a genuinely nonexistent id would produce.
--
-- member_self_service is checked for role = 'member' only, before the
-- reservation lookup (club-wide, not reservation-specific, so its
-- ordering relative to the lookup has no tenant-isolation implication) —
-- Pro is explicitly exempt from this capability per the locked matrix,
-- an intentional, deliberate asymmetry with Member (Phase 37B's own
-- architecture review flagged and the product owner has now locked this
-- exact shape into Phase 37C's spec).
--
-- p_require_not_cancelled lets get_reservation_roster (false — cancelled
-- reservations remain readable) share this same gate with the other five
-- RPCs (true — cancelled reservations reject every other operation) without
-- a second, parallel authorization function.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public._authorize_reservation_roster_access(
  p_reservation_id        uuid,
  p_expected_club_id      uuid,
  p_require_not_cancelled boolean
)
returns public.reservations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id          uuid;
  v_role             text;
  v_roster_member_id uuid;
  v_reservation      public.reservations%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;

  -- Null-safe, explicit allowlist — an unrecognized/null role must never
  -- silently fall through into the ownership-only branch below.
  if v_role is null or v_role not in ('admin', 'staff', 'member', 'pro') then
    raise exception 'insufficient_role';
  end if;

  -- Locked matrix: Member requires member_self_service; Pro does not.
  -- Admin/Staff are never gated by this capability.
  if v_role = 'member' and not public.current_club_has_capability('member_self_service') then
    raise exception 'capability_not_available';
  end if;

  v_roster_member_id := public.current_user_roster_member_id();

  select * into v_reservation
    from public.reservations
   where id      = p_reservation_id
     and club_id = v_club_id
     and (
       v_role in ('admin', 'staff')
       or owner_user_id = auth.uid()
       or (v_roster_member_id is not null and roster_member_id = v_roster_member_id)
     );
  if not found then raise exception 'reservation_not_found'; end if;

  if v_reservation.reason <> 'member_booking' then
    raise exception 'reservation_not_participant_eligible';
  end if;

  if p_require_not_cancelled and v_reservation.status = 'cancelled' then
    raise exception 'reservation_roster_locked';
  end if;

  return v_reservation;
end;
$$;

revoke execute on function public._authorize_reservation_roster_access(uuid, uuid, boolean)
  from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. get_reservation_roster — the normal roster read. Cancelled
-- reservations remain readable (p_require_not_cancelled = false); every
-- other operation in this migration passes true.
--
-- Returns ACTIVE reservation_participants and ACTIVE reservation_guests
-- rows only — removed relationship rows remain durable database/audit
-- history but are never part of this normal read (matches the Phase 37B
-- locked decision). The join to roster_members is unconditional (no
-- rm.status filter) so an active participant remains visible even if that
-- roster identity later became inactive — historical participation is
-- never hidden by a later, unrelated roster-lifecycle change.
--
-- is_holder is derived per-row (participant.roster_member_id =
-- reservation.roster_member_id), never persisted, and is always false for
-- a guest row (guests have no roster identity to compare). reservation_
-- status is included on every row so the UI can enforce read-only for a
-- cancelled reservation without a second round-trip.
--
-- reservation_participants has no role/host column (Phase 37A's locked
-- decision not to import Events' host/participant ceremony) — is_holder is
-- the intentional substitute for "role if useful" here.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.get_reservation_roster(
  p_reservation_id   uuid,
  p_expected_club_id uuid
)
returns table (
  kind               text,
  relationship_id    uuid,
  roster_member_id   uuid,
  display_name       text,
  is_holder          boolean,
  reservation_status text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reservation public.reservations%rowtype;
begin
  v_reservation := public._authorize_reservation_roster_access(p_reservation_id, p_expected_club_id, false);

  return query
    select roster.kind, roster.relationship_id, roster.roster_member_id,
           roster.display_name, roster.is_holder, roster.reservation_status
    from (
      select
        'participant'::text                                                                  as kind,
        rp.id                                                                                 as relationship_id,
        rp.roster_member_id,
        coalesce(nullif(trim(concat_ws(' ', rm.first_name, rm.last_name)), ''), 'Unknown')::text
                                                                                                as display_name,
        (rp.roster_member_id = v_reservation.roster_member_id)                                as is_holder,
        v_reservation.status::text                                                            as reservation_status
      from public.reservation_participants rp
      join public.roster_members rm on rm.id = rp.roster_member_id
      where rp.reservation_id = p_reservation_id
        and rp.status          = 'active'
      union all
      select
        'guest'::text,
        rg.id,
        null::uuid,
        rg.display_name,
        false,
        v_reservation.status::text
      from public.reservation_guests rg
      where rg.reservation_id = p_reservation_id
        and rg.status          = 'active'
    ) roster
    order by case roster.kind when 'participant' then 0 else 1 end, roster.display_name asc;
end;
$$;

revoke execute on function public.get_reservation_roster(uuid, uuid) from public, anon;
grant  execute on function public.get_reservation_roster(uuid, uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. get_reservation_eligible_roster_members — populates the "Add club
-- member" picker. Rejects a cancelled reservation (reservation_roster_
-- locked, via p_require_not_cancelled = true). ANY currently-active
-- same-club roster identity is eligible regardless of role — Member, Pro,
-- Staff, or Admin — with no claimed-account requirement; a no-account
-- active roster identity is a fully valid candidate. "Currently active"
-- requires BOTH rm.status = 'active' AND rm.removed_at IS NULL — status
-- alone is not sufficient, since roster_members' own removal provenance
-- (removed_at/removed_by, mirroring club_memberships' shape, 0117) is the
-- authoritative signal that a removal event has actually happened to this
-- identity. Only an ACTIVE reservation_participants relationship excludes
-- a candidate — a previously removed relationship does not, since
-- re-adding that identity is exactly what this picker exists to enable
-- (it will reactivate the same durable row, not create a second one). The
-- reservation holder is never implicitly excluded or specially injected —
-- they appear under the exact same rule as anyone else, flagged via
-- is_reservation_holder purely for the UI's benefit.
--
-- Post-review correction: does NOT return has_account/claimed_by. This
-- RPC is callable by a Member on their own reservation, and whether
-- another roster identity has ever claimed a Court Time account is not
-- needed by the reservation-participant workflow — exposing it here would
-- be an unnecessary account-status leak the picker's UI has no use for.
-- No replacement account-status field is introduced.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.get_reservation_eligible_roster_members(
  p_reservation_id   uuid,
  p_expected_club_id uuid
)
returns table (
  roster_member_id      uuid,
  display_name          text,
  role                   text,
  is_reservation_holder  boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reservation public.reservations%rowtype;
begin
  v_reservation := public._authorize_reservation_roster_access(p_reservation_id, p_expected_club_id, true);

  return query
    select
      rm.id                                                                               as roster_member_id,
      coalesce(nullif(trim(concat_ws(' ', rm.first_name, rm.last_name)), ''), 'Unknown')::text
                                                                                            as display_name,
      rm.role::text                                                                        as role,
      (rm.id = v_reservation.roster_member_id)                                             as is_reservation_holder
    from public.roster_members rm
    where rm.club_id     = v_reservation.club_id
      and rm.status      = 'active'
      and rm.removed_at is null
      and not exists (
        select 1 from public.reservation_participants rp
         where rp.reservation_id   = p_reservation_id
           and rp.roster_member_id = rm.id
           and rp.status           = 'active'
      )
    order by rm.last_name asc nulls last, rm.first_name asc nulls last, rm.id asc;
end;
$$;

revoke execute on function public.get_reservation_eligible_roster_members(uuid, uuid) from public, anon;
grant  execute on function public.get_reservation_eligible_roster_members(uuid, uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. add_reservation_participant — insert-or-reactivate the one durable
-- (reservation_id, roster_member_id) row. Target roster identity must
-- exist, belong to the reservation's own club, and be CURRENTLY eligible
-- (any role is valid; no claimed-account requirement) —
-- 'roster_member_not_found' covers both "does not exist" and "exists in a
-- different club" (the same anti-leakage posture as the ownership check
-- above: a cross-club id is never distinguished from a nonexistent one).
-- "Currently eligible" is rejected as roster_member_inactive (no new error
-- code) when EITHER status is distinct from 'active' OR removed_at is not
-- null — status alone is not sufficient, matching
-- get_reservation_eligible_roster_members's own eligibility predicate
-- exactly (post-review correction).
--
-- CONCURRENCY / IDEMPOTENCY: `select ... for update; v_existing_found :=
-- found;` captures FOUND into a local boolean on the very next line,
-- before any other SQL statement can overwrite it — the exact 0114-fix
-- discipline, not the pre-0114 bug. Three outcomes:
--   - no row exists                -> INSERT a fresh active row.
--   - row exists, status='removed' -> reactivate THAT SAME row (status,
--     removed_at, removed_by, added_by, updated_at only — id and
--     created_at are structurally untouched, matching 0178's own
--     immutability trigger, which never even fires for these columns).
--   - row exists, status='active'  -> idempotent success: return the
--     existing id, write no audit row, insert/update nothing.
-- A genuine two-concurrent-first-time-insert race (no prior row for
-- EITHER transaction's FOR UPDATE to lock) is closed by retrying on
-- unique_violation: the plain (non-partial) UNIQUE(reservation_id,
-- roster_member_id) constraint means the losing transaction's INSERT
-- fails with 23505, which is caught here and looped — the next iteration's
-- SELECT now finds the winner's row and correctly takes the idempotent or
-- reactivate branch, so no raw unique-violation ever reaches the caller.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.add_reservation_participant(
  p_reservation_id   uuid,
  p_expected_club_id uuid,
  p_roster_member_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reservation    public.reservations%rowtype;
  v_roster         public.roster_members%rowtype;
  v_existing       public.reservation_participants%rowtype;
  v_existing_found boolean;
  v_result         public.reservation_participants%rowtype;
  v_reactivated    boolean := false;
begin
  v_reservation := public._authorize_reservation_roster_access(p_reservation_id, p_expected_club_id, true);

  if p_roster_member_id is null then raise exception 'roster_identity_required'; end if;

  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_reservation.club_id;
  if not found then raise exception 'roster_member_not_found'; end if;

  if v_roster.status is distinct from 'active' or v_roster.removed_at is not null then
    raise exception 'roster_member_inactive';
  end if;

  loop
    select * into v_existing
      from public.reservation_participants
     where reservation_id   = p_reservation_id
       and roster_member_id = p_roster_member_id
     for update;
    v_existing_found := found;

    if v_existing_found then
      if v_existing.status = 'active' then
        v_result := v_existing;
        exit;
      end if;

      update public.reservation_participants
         set status     = 'active',
             removed_at = null,
             removed_by = null,
             added_by   = auth.uid(),
             updated_at = now()
       where id = v_existing.id
      returning * into v_result;

      v_reactivated := true;
      exit;
    else
      begin
        insert into public.reservation_participants (reservation_id, roster_member_id, added_by)
        values (p_reservation_id, p_roster_member_id, auth.uid())
        returning * into v_result;
        exit;
      exception when unique_violation then
        -- A concurrent caller inserted this exact pair between our SELECT
        -- and this INSERT. Loop back — the row now exists, so the next
        -- iteration's SELECT ... FOR UPDATE finds and correctly branches
        -- on it instead of this raw error reaching the caller.
        continue;
      end;
    end if;
  end loop;

  if v_result.id is null then
    raise exception 'reservation_participant_write_failed';
  end if;

  -- No audit row for the idempotent-success case (v_existing_found and not
  -- v_reactivated) — an actual-state-change-only audit trail.
  if v_reactivated or not v_existing_found then
    insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
    values (
      v_reservation.club_id,
      auth.uid(),
      case when v_reactivated then 'reactivate_reservation_participant' else 'add_reservation_participant' end,
      'reservation',
      p_reservation_id,
      jsonb_build_object(
        'participant_id',   v_result.id,
        'roster_member_id', p_roster_member_id
      )
    );
  end if;

  return v_result.id;
end;
$$;

revoke execute on function public.add_reservation_participant(uuid, uuid, uuid) from public, anon;
grant  execute on function public.add_reservation_participant(uuid, uuid, uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. remove_reservation_participant — contextual removal: the reservation
-- is authorized FIRST, then the participant relationship row is looked up
-- scoped to THAT SAME reservation_id, so a participant id belonging to a
-- different reservation (or a different club's reservation) can never be
-- targeted through this function no matter what p_reservation_id is
-- combined with. Soft-remove only — never DELETE. Idempotent: an
-- already-removed row returns its id with no second audit entry. 0178's
-- own domain-guard trigger remains the structural backstop underneath this
-- RPC's own checks (e.g. it independently re-rejects a cancelled
-- reservation at the moment of the UPDATE, regardless of what this RPC's
-- own earlier authorize-call saw).
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.remove_reservation_participant(
  p_reservation_id   uuid,
  p_expected_club_id uuid,
  p_participant_id   uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reservation public.reservations%rowtype;
  v_existing    public.reservation_participants%rowtype;
begin
  v_reservation := public._authorize_reservation_roster_access(p_reservation_id, p_expected_club_id, true);

  select * into v_existing
    from public.reservation_participants
   where id             = p_participant_id
     and reservation_id = p_reservation_id
   for update;
  if not found then raise exception 'reservation_participant_not_found'; end if;

  if v_existing.status = 'removed' then
    return v_existing.id;
  end if;

  update public.reservation_participants
     set status     = 'removed',
         removed_at = now(),
         removed_by = auth.uid(),
         updated_at = now()
   where id = p_participant_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_reservation.club_id,
    auth.uid(),
    'remove_reservation_participant',
    'reservation',
    p_reservation_id,
    jsonb_build_object(
      'participant_id',   v_existing.id,
      'roster_member_id', v_existing.roster_member_id
    )
  );

  return v_existing.id;
end;
$$;

revoke execute on function public.remove_reservation_participant(uuid, uuid, uuid) from public, anon;
grant  execute on function public.remove_reservation_participant(uuid, uuid, uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. add_reservation_guest — canonicalizes with btrim() BEFORE INSERT so
-- the stored value always satisfies 0178's
-- reservation_guests_display_name_canonical_check by construction, never
-- by accident. Rejects null, empty-after-trim, and >100 characters with
-- distinct error codes. No deduplication — two real guests may share a
-- display_name; every valid call creates a brand-new row (guests have no
-- durable identity to reactivate, unlike participants).
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.add_reservation_guest(
  p_reservation_id   uuid,
  p_expected_club_id uuid,
  p_display_name     text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reservation  public.reservations%rowtype;
  v_display_name text;
  v_result       public.reservation_guests%rowtype;
begin
  v_reservation := public._authorize_reservation_roster_access(p_reservation_id, p_expected_club_id, true);

  v_display_name := btrim(p_display_name);

  if v_display_name is null or char_length(v_display_name) < 1 then
    raise exception 'guest_display_name_required';
  end if;

  if char_length(v_display_name) > 100 then
    raise exception 'guest_display_name_too_long';
  end if;

  insert into public.reservation_guests (reservation_id, display_name, added_by)
  values (p_reservation_id, v_display_name, auth.uid())
  returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_reservation.club_id,
    auth.uid(),
    'add_reservation_guest',
    'reservation',
    p_reservation_id,
    jsonb_build_object('guest_id', v_result.id)
  );

  return v_result.id;
end;
$$;

revoke execute on function public.add_reservation_guest(uuid, uuid, text) from public, anon;
grant  execute on function public.add_reservation_guest(uuid, uuid, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. remove_reservation_guest — same contextual-removal shape as
-- remove_reservation_participant: authorize the reservation first, then
-- scope the guest lookup to that same reservation_id. Soft-remove only,
-- idempotent, no reactivation-by-name logic (guests have no identity to
-- reactivate against).
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.remove_reservation_guest(
  p_reservation_id   uuid,
  p_expected_club_id uuid,
  p_guest_id         uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reservation public.reservations%rowtype;
  v_existing    public.reservation_guests%rowtype;
begin
  v_reservation := public._authorize_reservation_roster_access(p_reservation_id, p_expected_club_id, true);

  select * into v_existing
    from public.reservation_guests
   where id             = p_guest_id
     and reservation_id = p_reservation_id
   for update;
  if not found then raise exception 'reservation_guest_not_found'; end if;

  if v_existing.status = 'removed' then
    return v_existing.id;
  end if;

  update public.reservation_guests
     set status     = 'removed',
         removed_at = now(),
         removed_by = auth.uid(),
         updated_at = now()
   where id = p_guest_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_reservation.club_id,
    auth.uid(),
    'remove_reservation_guest',
    'reservation',
    p_reservation_id,
    jsonb_build_object('guest_id', v_existing.id)
  );

  return v_existing.id;
end;
$$;

revoke execute on function public.remove_reservation_guest(uuid, uuid, uuid) from public, anon;
grant  execute on function public.remove_reservation_guest(uuid, uuid, uuid) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint). Purely additive — every object below is brand new with
-- nothing else depending on it yet.
-- ═══════════════════════════════════════════════════════════════════════════
--   drop function if exists public.remove_reservation_guest(uuid, uuid, uuid);
--   drop function if exists public.add_reservation_guest(uuid, uuid, text);
--   drop function if exists public.remove_reservation_participant(uuid, uuid, uuid);
--   drop function if exists public.add_reservation_participant(uuid, uuid, uuid);
--   drop function if exists public.get_reservation_eligible_roster_members(uuid, uuid);
--   drop function if exists public.get_reservation_roster(uuid, uuid);
--   drop function if exists public._authorize_reservation_roster_access(uuid, uuid, boolean);
