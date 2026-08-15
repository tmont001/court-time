-- 0118_event_member_eligibility.sql
-- Phase 33E2: Event Eligibility Parity for Admin + Pro
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- 0117 fixed EventRosterSheet's "Add Member" claimed-member source (which
-- used profiles.status — a stale, non-club-scoped legacy projection that
-- does not clear on club_memberships removal — see 0081's trg_project_
-- membership_to_profile, whose own comment says legacy columns are
-- "deliberately left untouched" once a membership is no longer valid) by
-- switching the ADMIN path to get_members() (0086, club_memberships-based,
-- correct) and leaving the PRO path deliberately empty, since no existing
-- admin+pro, club-scoped, non-Program-specific active-member source existed
-- and introducing one required a migration — out of scope for that
-- correction pass.
--
-- This migration closes that gap with ONE new, read-only, additive RPC:
-- get_event_eligible_members(p_event_id). It replaces EventRosterSheet's
-- entire dual-source lookup (the profiles/get_members query for claimed
-- Members, the get_roster_members() call for no-account Members) with a
-- single roster_members-sourced query, authorized identically to every
-- other Event roster-management RPC (admin OR pro, same club) — so both
-- roles get full, correct eligibility, not just Admin.
--
-- Authoritative source: roster_members.status (0117) — the same durable,
-- fail-closed-synced lifecycle signal already used by every other picker
-- fixed in 0117 (Calendar reservation picker, Lessons picker, Program
-- picker, get_roster_members). Claim state (claimed_by IS NULL vs NOT NULL)
-- never determines eligibility — only role='member' and status='active' do.
--
-- No schema change. No backfill. No data mutation. Purely additive: one new
-- function, no DROP, no CASCADE, no touch to any existing object. 0117 is
-- not modified.
--
-- Not applied by this checkpoint. Not committed.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- get_event_eligible_members — admin OR pro, same club as the target Event.
-- Returns every roster identity (claimed or unclaimed) eligible to be newly
-- added to this Event: real, active club Members (role='member',
-- status='active') not already represented among the Event's active
-- participant states (confirmed/offered/waitlisted). Historical/cancelled
-- participant rows do not exclude a candidate — re-adding a previously
-- removed/left participant is exactly what this picker is for.
--
-- Authorization mirrors admin_add_roster_participant/admin_force_confirm_
-- roster_participant/admin_offer_spot_roster_participant (0113/0117) —
-- current_user_club_id()/current_user_role(), 'admin_required' on failure —
-- the same boundary already enforced by every Event roster mutation RPC
-- this feeds into, so a Pro who can already call those can now also see a
-- correct candidate list to call them with.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.get_event_eligible_members(p_event_id uuid)
returns table (
  roster_member_id uuid,
  profile_id        uuid,
  display_name      text,
  has_account        boolean
)
language plpgsql
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
  if v_role is null or v_role not in ('admin', 'pro') then raise exception 'admin_required'; end if;

  select * into v_event
    from public.events
   where id      = p_event_id
     and club_id = v_club_id;
  if not found then raise exception 'event_not_found'; end if;

  return query
    select
      rm.id                                                                            as roster_member_id,
      rm.claimed_by                                                                    as profile_id,
      coalesce(nullif(trim(concat_ws(' ', rm.first_name, rm.last_name)), ''), 'Unknown')::text
                                                                                        as display_name,
      (rm.claimed_by is not null)                                                      as has_account
    from public.roster_members rm
    where rm.club_id = v_club_id
      and rm.role     = 'member'
      and rm.status   = 'active'
      and not exists (
        select 1 from public.event_participants ep
        where ep.event_id         = p_event_id
          and ep.roster_member_id = rm.id
          and ep.status           in ('confirmed', 'offered', 'waitlisted')
      )
    order by rm.last_name asc nulls last, rm.first_name asc nulls last, rm.id asc;
end;
$$;

revoke execute on function public.get_event_eligible_members(uuid) from public, anon;
grant  execute on function public.get_event_eligible_members(uuid) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- Purely additive — rollback is a single
-- `drop function if exists public.get_event_eligible_members(uuid);`
-- No other object depends on it (no CASCADE needed). EventRosterSheet.tsx
-- would need its Add Member fetch reverted to the pre-0118 dual-source
-- lookup (get_members() for admin, empty for pro, plus get_roster_members())
-- alongside this rollback, or its Add Member picker breaks entirely.
