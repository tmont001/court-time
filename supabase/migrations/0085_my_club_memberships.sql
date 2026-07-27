-- 0085_my_club_memberships.sql
-- Phase 26E1: Membership List and Club Switcher — protected list RPC.
--
-- Adds public.get_my_club_memberships(), the read model behind the new
-- desktop/mobile club switcher and the /profile "Clubs" section. Naming
-- matches the repository's existing "get_my_<noun>" convention for
-- caller-scoped read RPCs (get_my_lesson_requests).
--
-- FOCUSED AUDIT (switcher-relevant only; the Phase 26 architecture audit is
-- not repeated here):
--   • club_memberships has had RLS enabled with zero policies and ALL
--     privileges revoked from anon/authenticated since migration 0081 — no
--     browser code has ever had direct table access, and this migration
--     does not change that. The switcher reads memberships exclusively
--     through this new SECURITY DEFINER RPC.
--   • current_user_club_id() (0082) already resolves the caller's active
--     club from club_memberships via profiles.active_club_id — reused here
--     to compute is_active_club rather than re-deriving it.
--   • set_active_club(uuid) (0082) already performs the validated switch
--     with its own locking/error semantics — this migration adds no new
--     writer; the application-layer switch action calls that existing RPC
--     directly.
--
-- Contains only this one function and its grants — no other object is
-- touched. profiles, club_memberships, and every existing helper/trigger
-- from 0081-0084 are unaffected.
--
-- ATOMICITY: runs inside one transaction. No exception handler here
-- swallows a migration failure.
--
-- Apply in Supabase SQL Editor (cloud only). Not applied by this checkpoint.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- get_my_club_memberships() — new
-- ═══════════════════════════════════════════════════════════════════════════
-- Returns only the caller's own switchable memberships: status = 'active'
-- and removed_at is null. Inactive, suspended, and removed memberships are
-- never returned — there is no membership-administration or reactivation
-- capability in this checkpoint. Identity is derived exclusively from
-- auth.uid(); there is no caller-controlled user-id parameter of any kind.
-- Returns only display fields (club identity, role, provider flag, active
-- marker) — no membership provenance (joined_at, invited_by,
-- source_invite_id, removed_at/removed_by) or any other administrative
-- field.
--
-- Deterministic ordering: the active club first, then alphabetically by
-- club name — matches the UI's required "current club first" ordering
-- without needing any client-side sort.
create or replace function public.get_my_club_memberships()
returns table (
  club_id            uuid,
  club_name          text,
  club_slug          text,
  theme_key          text,
  role               text,
  is_lesson_provider boolean,
  is_active_club     boolean
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_active_club_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  -- Reuses the existing Phase 26B2 helper rather than re-deriving "which
  -- club is active" from profiles.active_club_id directly.
  v_active_club_id := public.current_user_club_id();

  return query
    select
      cm.club_id,
      c.name  as club_name,
      c.slug  as club_slug,
      c.theme_key,
      cm.role,
      cm.is_lesson_provider,
      (cm.club_id = v_active_club_id) as is_active_club
    from public.club_memberships cm
    join public.clubs c on c.id = cm.club_id
   where cm.user_id = auth.uid()
     and cm.status = 'active'
     and cm.removed_at is null
   order by (cm.club_id = v_active_club_id) desc, c.name asc;
end;
$$;

revoke execute on function public.get_my_club_memberships() from public, anon;
grant  execute on function public.get_my_club_memberships() to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration is created
-- in this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- Rolling back 0085 must NOT roll back 0081-0084. To revert in place:
--   DROP FUNCTION public.get_my_club_memberships();
-- only after the application-layer switcher components/action stop calling
-- it (see the Phase 26E1 report for the exact application files). No other
-- schema object is touched by this migration or needs any rollback action
-- of its own.
