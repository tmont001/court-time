-- 0093_program_roster_member_lookup.sql
-- Phase 27D3C: Membership-native member lookup for the staff program
-- roster UI's Add Member picker.
--
-- Audit finding (see this checkpoint's request): no existing RPC satisfies
-- all four required properties at once —
--   1. returns club member names,
--   2. sources eligibility exclusively from club_memberships,
--   3. is callable by both admin and pro (not admin-only),
--   4. returns only active, non-removed same-club members.
-- get_members() (0086) satisfies (1) and (2) but is hard admin-only and
-- deliberately includes removed members (fails 3 and 4). get_program_roster
-- (0092) satisfies (3) but is sourced from program_enrollments/profiles,
-- not club_memberships, and returns enrollees, not the general member
-- directory (fails 1 and 2). get_club_pros() (0070) has no role gate but is
-- sourced entirely from legacy profiles.club_id/status/role/
-- is_lesson_provider and only returns pros/admins, never the general
-- member list (fails 1 and 2). No RPC in this codebase satisfies all four,
-- so this migration adds one new, narrowly-scoped RPC rather than reusing
-- an unsuitable one.
--
-- One read-only SECURITY DEFINER RPC: get_program_eligible_members. Does
-- not edit 0087-0092 and is independently reviewable/rollback-able from
-- them. No new table, no schema change, no grant/RLS change to any table —
-- the only object this migration creates is the function itself.
--
-- Authorization mirrors get_program_roster (0092) exactly: membership-
-- native auth capture, role checked before the program lookup, admin may
-- look up eligible members for any same-club program, pro only for a
-- program they created, member gets insufficient_role, cross-club/
-- nonexistent program gets program_not_found, wrong enrollment_model gets
-- program_not_whole_enrollment.
--
-- Eligibility is sourced exclusively from club_memberships
-- (club_id/status='active'/removed_at is null) — never
-- profiles.club_id/role/status/is_lesson_provider. profiles is joined only
-- for first_name/last_name/display_name; no other profile column is
-- selected, and email is never included (this RPC is a picker source, not
-- a roster or contact-detail view).
--
-- Excludes any club member who already has a program_enrollments row with
-- status in ('enrolled','offered','waitlisted') for this specific program
-- — they are not "eligible to add" since add_program_member (0092) would
-- either no-op-return them unchanged (matching its own locked no-reorder
-- behavior) or reject them; showing them in an "eligible members" picker
-- would be misleading either way. A member with no row at all, or a
-- 'cancelled' row, is included — matching add_program_member's own
-- "cancelled member re-added with a fresh queue position" support.
--
-- Ordering: last_name asc nulls last, first_name asc nulls last, profile_id
-- asc as a final deterministic tiebreaker — same convention get_members()
-- (0086) already uses for its own alphabetical member ordering.
--
-- See supabase/scripts/verify_phase27d3_member_lookup.sql for the
-- read-only verification pass.
--
-- Apply in Supabase SQL Editor (cloud only). Not applied by this checkpoint.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- get_program_eligible_members
-- ═══════════════════════════════════════════════════════════════════════════
-- Error codes: not_authenticated, insufficient_role, program_not_found,
-- program_not_whole_enrollment.

create or replace function public.get_program_eligible_members(p_program_id uuid)
returns table (
  profile_id    uuid,
  first_name    text,
  last_name     text,
  display_name  text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_program public.programs%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  if v_role not in ('admin', 'pro') then
    raise exception 'insufficient_role';
  end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id;
  if not found then raise exception 'program_not_found'; end if;

  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_program.enrollment_model <> 'program' then
    raise exception 'program_not_whole_enrollment';
  end if;

  return query
    select
      cm.user_id,
      p.first_name,
      p.last_name,
      coalesce(nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), 'Unknown')::text as display_name
    from public.club_memberships cm
    join public.profiles p on p.id = cm.user_id
    where cm.club_id    = v_club_id
      and cm.status     = 'active'
      and cm.removed_at is null
      and not exists (
        select 1 from public.program_enrollments pe
        where pe.program_id = p_program_id
          and pe.profile_id = cm.user_id
          and pe.status     in ('enrolled', 'offered', 'waitlisted')
      )
    order by p.last_name asc nulls last, p.first_name asc nulls last, cm.user_id asc;
end;
$$;

revoke execute on function public.get_program_eligible_members(uuid) from public, anon;
grant  execute on function public.get_program_eligible_members(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════════
-- One new function, depending on nothing this migration itself created —
-- dropping it is a clean, complete rollback:
--
--   drop function if exists public.get_program_eligible_members(uuid);
--
-- No schema, grant, or RLS change was made anywhere in this migration, so
-- there is nothing else to reverse.

commit;
