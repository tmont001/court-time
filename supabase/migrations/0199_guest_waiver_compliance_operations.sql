-- 0199_guest_waiver_compliance_operations.sql
-- Phase 43B-5B — Guest Waiver Compliance Surfaces. BACKEND ONLY.
-- Apply in Supabase SQL Editor (cloud only). NOT applied by this
-- checkpoint — the user applies manually after review.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 43B-5A surfaced existing Member waiver compliance
-- (get_club_member_waiver_compliance, 0194) on /admin/members. This
-- checkpoint does the Guest-side equivalent: a compact waiver status per
-- participation-scoped Guest (reservation_guests/event_guests row) on the
-- existing Reservation and Event Guest rosters.
--
-- BLOCKER audit (performed before this migration was authorized): neither
-- get_reservation_roster (0179) nor get_event_roster (0117, current — no
-- later migration redefines it) join guest_waiver_acceptances or waivers
-- at all. The only functions that ever touch guest_waiver_acceptances are
-- 0198's own four (_mint_guest_waiver_invitation, the two per-domain mint
-- entry points, resolve_guest_waiver_invitation, accept_guest_waiver) —
-- every one of them resolves exactly ONE Guest slot at a time, via a
-- bearer-token hash, never a whole roster. No existing set-based read
-- exists for "compliance per Guest, for this Reservation/Event" — this
-- migration adds exactly that, mirroring get_club_member_waiver_
-- compliance's (0194) own Member-side pattern, Guest/participation-scoped
-- instead of club-wide.
--
-- 0009-0198 are APPLIED and IMMUTABLE — not touched. This migration is
-- purely additive: two new read-only, set-based SECURITY DEFINER
-- functions. No table, column, existing RPC, or grant is altered. No
-- writes, no enforcement, no new table.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- AUTHORIZATION AUDIT — Event roster READ boundary (performed narrowly,
-- before writing this file, per this checkpoint's own explicit request)
-- ═══════════════════════════════════════════════════════════════════════════
-- CONCLUSION: the current, effective Event roster READ boundary is
-- Admin+Pro ONLY — never Staff. Evidence:
--   - get_event_roster's role check has been `role not in ('admin',
--     'pro')` -> insufficient_role in EVERY migration that has ever
--     defined it (0016, 0049, 0050, 0057, 0113 "staff_managed_events_
--     identity" notwithstanding its own name, and 0117 — the CURRENT,
--     last-touched definition). No migration after 0117 redefines
--     get_event_roster. It has never included 'staff' at any point in
--     this repo's history.
--   - EventRosterSheet.tsx (the component this checkpoint wires into)
--     loads its roster via exactly this RPC (`supabase.rpc(
--     "get_event_roster", { p_event_id: eventId })`, browser-side,
--     RLS/role-scoped by the caller's own session) — so a Staff caller
--     who somehow reaches this component would have that RPC call itself
--     raise insufficient_role. This is a pre-existing inconsistency
--     between that component's own presentation-layer `isAdmin`
--     variable (canAccessOperationsWorkspace: admin/pro/staff, which
--     gates mutation controls like Remove/Add Guest) and the roster
--     READ RPC's own narrower admin+pro-only enforcement — NOT
--     something this checkpoint introduces or is asked to fix.
--   - Per this checkpoint's own locked rule ("Do NOT use admin_add_
--     guest/admin_remove_guest's mutation authorization as a reason to
--     widen a read RPC"): 0136 widened the MUTATION RPCs (admin_add_
--     guest/admin_remove_guest) to admin+pro+staff, but never touched
--     get_event_roster (the READ RPC) at all — mutation and read
--     authorization are two independently-versioned things here, and
--     only the read boundary is relevant to this migration.
-- get_event_guest_waiver_compliance therefore uses role in ('admin',
-- 'pro') ONLY, exactly mirroring get_event_roster's own current
-- definition — not the wider mutation boundary.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- DESIGN DECISIONS
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Two functions, not one polymorphic function — mirrors this
--    checkpoint's own two independent Guest domains (reservation_guests
--    vs event_guests) and their two independently-evolving authorization
--    boundaries (_authorize_reservation_roster_access vs get_event_
--    roster's role check) exactly, rather than inventing a shared
--    abstraction neither existing roster-read RPC has.
--
-- 2. waiver_configured semantics are DELIBERATELY STRICTER than 0194's
--    Member-side get_club_member_waiver_compliance, per this
--    checkpoint's own explicit spec: waiver_configured = true ONLY when
--    a CURRENT PUBLISHED Guest waiver version exists (w.current_
--    version_id is not null) — not merely "a waivers row exists at all"
--    (0194's own, looser Member-side definition, which is true even
--    before any version has ever been published). This is an
--    intentional divergence from the Member-side precedent, not an
--    inconsistency: the Guest-side UI (this checkpoint) uses
--    waiver_configured specifically to decide whether to show the
--    indicator AT ALL, and "a document exists but nothing has ever been
--    published" has nothing meaningful to show.
--
-- 3. Status vocabulary (current/never_accepted/outdated/not_required) is
--    byte-identical to 0194/0192's own Member-side vocabulary — the same
--    CASE structure, same ordering, same column-ambiguity discipline
--    (every column reference alias-qualified without exception, since
--    both RETURNS TABLE shapes introduce `status`/`waiver_configured`/
--    `relationship_id` as implicit PL/pgSQL variables in scope for the
--    whole function body — the exact bug class 0192 hit and 0194's own
--    header already documents guarding against).
--
-- 4. Invitation existence never participates in compliance — neither
--    function ever references guest_waiver_invitations. Compliance is
--    derived ONLY from guest_waiver_acceptances (an actual acceptance
--    row) and waivers/waiver_versions (the current Guest waiver state) —
--    exactly the same two tables resolve_guest_waiver_invitation/
--    accept_guest_waiver (0198) already treat as the sole sources of
--    truth for a single Guest slot, applied here set-based.
--
-- 5. Set-based, no per-Guest loop, no token/invitation dependency — one
--    query per function, returning one row per active Guest slot in the
--    given Reservation/Event. No new index added: reservation_guests
--    (reservation_id, status) and event_guests (event_id, status) are
--    already the natural filter columns these tables' own existing
--    lookups use (get_reservation_roster/get_event_roster themselves
--    filter identically, unindexed, at the same table sizes) — no query
--    plan evidence exists here that a new index is actually needed.
--
-- ═══════════════════════════════════════════════════════════════════════════
begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. get_reservation_guest_waiver_compliance — authenticated. Reuses
--    _authorize_reservation_roster_access (0179, private, unchanged)
--    verbatim, with p_require_not_cancelled = false — the EXACT same call
--    get_reservation_roster itself makes, so this RPC's visibility can
--    never diverge from the roster read it's shown alongside.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.get_reservation_guest_waiver_compliance(
  p_reservation_id   uuid,
  p_expected_club_id uuid
)
returns table (
  relationship_id   uuid,
  waiver_configured boolean,
  status            text
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_reservation public.reservations%rowtype;
begin
  v_reservation := public._authorize_reservation_roster_access(p_reservation_id, p_expected_club_id, false);

  return query
    select
      rg.id,
      (w.current_version_id is not null),
      case
        when w.current_version_id is null then 'not_required'
        when w.is_required is false       then 'not_required'
        when exists (
          select 1 from public.guest_waiver_acceptances a
           where a.waiver_version_id      = w.current_version_id
             and a.reservation_guest_id   = rg.id
        ) then 'current'
        when exists (
          select 1
            from public.guest_waiver_acceptances a
            join public.waiver_versions v on v.id = a.waiver_version_id
           where v.waiver_id             = w.id
             and a.reservation_guest_id  = rg.id
        ) then 'outdated'
        else 'never_accepted'
      end
    from public.reservation_guests rg
    left join public.waivers w
      on w.club_id = v_reservation.club_id and w.audience = 'guest'
   where rg.reservation_id = p_reservation_id
     and rg.status          = 'active';
end;
$$;

revoke execute on function public.get_reservation_guest_waiver_compliance(uuid, uuid)
  from public, anon;
grant  execute on function public.get_reservation_guest_waiver_compliance(uuid, uuid)
  to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. get_event_guest_waiver_compliance — authenticated. Role check
--    (admin/pro ONLY) and same-club scoping copied verbatim from get_
--    event_roster's own CURRENT (0117) definition — see the
--    AUTHORIZATION AUDIT above for why this is admin/pro, not admin/pro/
--    staff.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.get_event_guest_waiver_compliance(
  p_event_id uuid
)
returns table (
  relationship_id   uuid,
  waiver_configured boolean,
  status            text
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_event   public.events%rowtype;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.role not in ('admin', 'pro') then
    raise exception 'insufficient_role';
  end if;

  select * into v_event
    from public.events
   where id      = p_event_id
     and club_id = v_profile.club_id;
  if not found then raise exception 'event_not_found'; end if;

  return query
    select
      eg.id,
      (w.current_version_id is not null),
      case
        when w.current_version_id is null then 'not_required'
        when w.is_required is false       then 'not_required'
        when exists (
          select 1 from public.guest_waiver_acceptances a
           where a.waiver_version_id = w.current_version_id
             and a.event_guest_id    = eg.id
        ) then 'current'
        when exists (
          select 1
            from public.guest_waiver_acceptances a
            join public.waiver_versions v on v.id = a.waiver_version_id
           where v.waiver_id      = w.id
             and a.event_guest_id = eg.id
        ) then 'outdated'
        else 'never_accepted'
      end
    from public.event_guests eg
    left join public.waivers w
      on w.club_id = v_profile.club_id and w.audience = 'guest'
   where eg.event_id = p_event_id
     and eg.status     = 'active';
end;
$$;

revoke execute on function public.get_event_guest_waiver_compliance(uuid)
  from public, anon;
grant  execute on function public.get_event_guest_waiver_compliance(uuid)
  to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Manual live/DB QA (to be performed by the user before commit/push).
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. As Admin or Pro, call get_event_guest_waiver_compliance for an event
--    with at least one active event Guest. With the club's Guest waiver
--    current + Required, expect one row per active Guest, status =
--    'never_accepted' for a Guest who has never accepted, waiver_
--    configured = true.
--
-- 2. Mint a Guest waiver invitation for one of those Guests (existing
--    43B-4A/4B mint + public flow), accept the CURRENT version through
--    the public page. Re-call get_event_guest_waiver_compliance — expect
--    that Guest's row now shows status = 'current'. Confirm merely
--    MINTING (never accepting) an invitation does NOT change status —
--    call compliance again right after mint, before acceptance, and
--    confirm the row is still 'never_accepted'.
--
-- 3. Publish a REPLACEMENT Guest waiver version. Re-call compliance for
--    the same Guest from step 2 (who accepted the prior version). Expect
--    status = 'outdated' now, not 'current'.
--
-- 4. As Admin, set Guest waiver Required OFF. Expect every row's status
--    to become 'not_required', waiver_configured still = true (a current
--    version still exists, it's just not required).
--
-- 5. As a Member who owns a reservation with an active Guest, call
--    get_reservation_guest_waiver_compliance for that reservation.
--    Expect it to succeed (Member ownership is part of _authorize_
--    reservation_roster_access's existing boundary) and return exactly
--    one row per active reservation Guest, with the same status
--    semantics as steps 1-4.
--
-- 6. As Staff, call get_event_guest_waiver_compliance directly. Expect
--    insufficient_role — confirming this migration does NOT widen Event
--    roster read access to Staff (matching get_event_roster's own
--    current, unchanged boundary).
--
-- 7. As anon (no session), attempt either RPC. Expect a permission-denied
--    error at the Postgres/PostgREST layer — never reaching this
--    function's own body.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created
-- in this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- begin;
--
-- drop function if exists public.get_event_guest_waiver_compliance(uuid);
-- drop function if exists public.get_reservation_guest_waiver_compliance(uuid, uuid);
--
-- commit;
--
-- No table, RLS policy, or function outside this migration's own two new
-- objects is touched — reservation_guests, event_guests, waivers/
-- waiver_versions, guest_waiver_acceptances, guest_waiver_invitations
-- (never referenced), profiles, events, reservations, and
-- _authorize_reservation_roster_access are all read-only from this
-- migration's perspective.
