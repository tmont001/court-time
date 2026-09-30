-- 0214_event_guest_waiver_staff_authorization.sql
-- Phase 45D2 — fixes the P2 Event/Staff authorization inconsistency found in
-- the Phase 45D audit: public.get_event_guest_waiver_compliance(p_event_id)
-- excluded 'staff' from its role check (admin/pro only), while its two
-- sibling functions — get_club_member_waiver_compliance (admin/staff) and
-- get_reservation_guest_waiver_compliance (via
-- _authorize_reservation_roster_access: admin/staff/member/pro) — both
-- already include staff, and Staff already has established event
-- operational authority (roster access, attendance management — migration
-- 0136) predating this function's own creation (migration 0199). This is a
-- narrow consistency correction, not a general widening of Staff authority:
-- Staff gains exactly the one capability its siblings and its established
-- event authority already implied it should have.
--
-- MULTI-CLUB AUTHORIZATION CORRECTION (verified live via pg_get_functiondef
-- before writing this migration, not assumed): the current live function
-- derives caller identity via `select * into v_profile from public.profiles
-- where id = auth.uid()` and then reads v_profile.role/v_profile.club_id —
-- the legacy pattern, not this schema's current authorization truth under
-- the multi-club foundation (see migration 0213's own header for the full
-- explanation of why profiles.club_id/role must not be used as tenant/role
-- authority). This migration redefines the function to derive caller club
-- and role via the same trusted active-membership helpers every other
-- current authorization-sensitive RPC in this schema uses:
--   public.current_user_club_id() / public.current_user_role()
-- (both ultimately backed by public._current_user_active_membership() —
-- club_memberships with status='active' and removed_at is null, cross-
-- checked against profiles.active_club_id). A caller with no valid active
-- membership gets both as NULL from the SAME underlying row, so checking
-- v_club_id is null first (before the role check) correctly yields
-- not_authenticated rather than a misleading event_not_found, and
-- guarantees v_role is non-null by the time the role check runs.
--
-- Everything else — the waiver-compliance CASE logic (not_required/
-- current/outdated/never_accepted), the active-event_guests filter, the
-- RETURNS TABLE shape, STABLE/SECURITY DEFINER/search_path — is preserved
-- exactly. The only substantive changes are: (1) 'staff' added to the
-- allowed-role list, and (2) v_profile.role/v_profile.club_id replaced with
-- v_role/v_club_id sourced from the active-membership helpers (a mechanical
-- consequence of removing the legacy v_profile lookup, not a scoping
-- change — the waiver club-scope value is identical either way for any
-- caller with a valid active membership).
--
-- Signature and return shape are unchanged (p_event_id uuid) -> TABLE
-- (relationship_id uuid, waiver_configured boolean, status text), so
-- CREATE OR REPLACE is sufficient.
--
-- Created by this checkpoint. Do NOT apply until reviewed.

begin;

create or replace function public.get_event_guest_waiver_compliance(
  p_event_id uuid
)
returns table(relationship_id uuid, waiver_configured boolean, status text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_event   public.events%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;

  if v_role not in ('admin', 'staff', 'pro') then
    raise exception 'insufficient_role';
  end if;

  select * into v_event
    from public.events
   where id      = p_event_id
     and club_id = v_club_id;
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
      on w.club_id = v_club_id and w.audience = 'guest'
   where eg.event_id = p_event_id
     and eg.status     = 'active';
end;
$$;

alter function public.get_event_guest_waiver_compliance(uuid) owner to postgres;
revoke execute on function public.get_event_guest_waiver_compliance(uuid) from public;
revoke execute on function public.get_event_guest_waiver_compliance(uuid) from anon;
grant  execute on function public.get_event_guest_waiver_compliance(uuid) to authenticated;
grant  execute on function public.get_event_guest_waiver_compliance(uuid) to service_role;

commit;
