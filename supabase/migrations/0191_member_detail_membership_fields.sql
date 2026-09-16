-- 0191_member_detail_membership_fields.sql
-- Phase 42C-3A — Member Detail Membership Read Model.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- 0188 (42A, immutable) added roster_members.membership_status/
-- .membership_type_id and the membership_types table. 0190 (42C-1,
-- immutable) widened get_members() and get_roster_members(boolean) to
-- expose membership_status/membership_type_id/membership_type_name to the
-- Members LIST. get_admin_member_detail(uuid) — the read model the Member
-- DETAIL page (/admin/members/[id]) actually renders from — was
-- deliberately NOT widened in 0190 (see that migration's own audit note,
-- Section on get_admin_member_detail: "audited, NOT widened here...
-- deferred to future 42C-4"), so Member Detail today has zero visibility
-- into a claimed person's membership axis, even though the list already
-- does. This migration closes exactly that one gap — nothing else.
--
-- 42C-3 AUDIT FINDING (why a migration is required at all, not a client-
-- side workaround): get_admin_member_detail is the only Member Detail read
-- model missing these three columns. A raw `.from("roster_members")`
-- client-side read as an alternative would be scoped by roster_members'
-- existing RLS, which is admin-ONLY (0056's roster_members_select_admin
-- policy) — but get_admin_member_detail itself is Admin+Staff readable
-- (0132's own widening). Working around the RPC with a raw table read
-- would silently make membership data invisible to Staff on Member Detail
-- while it remains visible to Staff on the Members list (get_members() is
-- also Admin+Staff) — an inconsistent, accidental access-posture split.
-- Widening the RPC itself preserves identical Admin+Staff readability on
-- both surfaces, with zero authorization change.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- SCOPE
-- ═══════════════════════════════════════════════════════════════════════════
--   Widen ONLY public.get_admin_member_detail(uuid). Its current, latest
--   source of truth is 0132's definition (RETURNS TABLE with 14 columns,
--   Admin+Staff authorization, copied-from-Production body per 0132's own
--   "Phase 34A4A correction" note). Postgres forbids CREATE OR REPLACE from
--   changing a RETURNS TABLE column list even by pure addition (the same
--   constraint 0190's own get_members()/get_roster_members() DROP+CREATE
--   already documented and worked around) — so this migration issues an
--   explicit DROP FUNCTION (exact existing signature, no CASCADE) before
--   the CREATE OR REPLACE.
--
--   Return contract: every one of the 14 existing columns, in their exact
--   existing order, is preserved byte-for-byte. Exactly three trailing
--   columns are appended: membership_status text, membership_type_id uuid,
--   membership_type_name text.
--
--   Body change: the SAME club+claimed_by pairing 0190's get_members()
--   already uses to resolve a claimed person's durable roster identity —
--       left join public.roster_members rm
--         on rm.club_id = v_actor_club_id and rm.claimed_by = p.id
--   — followed by
--       left join public.membership_types mt
--         on mt.id = rm.membership_type_id and mt.club_id = v_actor_club_id
--   (the extra `mt.club_id = v_actor_club_id` predicate is defense in
--   depth beyond what get_members() itself bothers with — membership_type_id
--   is already same-club enforced by roster_members' own composite FK
--   against membership_types(id, club_id), so a cross-club mt row can never
--   actually be joined here; the explicit predicate costs nothing and
--   removes any doubt for a future reader). Both joins are LEFT JOINs, not
--   inner joins — a legacy or edge-case claimed profile with no matching
--   roster_members row (e.g. claimed before 0056 introduced roster_members,
--   or any other data gap) must not disappear from Member Detail merely
--   because it has no roster identity to report membership data from; it
--   simply reports membership_status/membership_type_id/membership_type_name
--   as NULL, exactly like every other genuinely-absent optional field this
--   function already returns (e.g. removed_at).
--
--   Everything else — the p_member_id uuid signature, SECURITY DEFINER,
--   search_path, the auth.uid() check, the canonical
--   current_user_club_id()/current_user_role() resolution, the Admin-OR-
--   Staff authorization line, the same-club club_memberships lookup and its
--   member_not_found behavior, the profiles/auth.users join for identity
--   fields, all four activity/stat subqueries, and the existing
--   revoke/grant — is preserved EXACTLY as 0132 left it. No table, RLS
--   policy, or other function is touched. membership_types' and
--   roster_members' RLS are read-only consumed here (this function is
--   SECURITY DEFINER and therefore not subject to the caller's own RLS
--   grants at all — same posture every other 0188 function already
--   documents), never modified.
--
-- Not applied by this checkpoint. STOP before applying. Do not create 0192.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

drop function public.get_admin_member_detail(uuid);

CREATE OR REPLACE FUNCTION public.get_admin_member_detail(p_member_id uuid)
 RETURNS TABLE(id uuid, first_name text, last_name text, phone text, role text, status text, created_at timestamp with time zone, email text, is_lesson_provider boolean, removed_at timestamp with time zone, attended_event_count bigint, event_no_show_count bigint, completed_lesson_count bigint, member_lesson_no_show_count bigint, membership_status text, membership_type_id uuid, membership_type_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor_club_id uuid;
  v_actor_role    text;
  v_membership    public.club_memberships%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  select public.current_user_club_id(), public.current_user_role()
    into v_actor_club_id, v_actor_role;

  if v_actor_role is distinct from 'admin' and v_actor_role is distinct from 'staff' then
    raise exception 'insufficient_role';
  end if;

  select cm.* into v_membership
    from public.club_memberships cm
   where cm.user_id = p_member_id
     and cm.club_id = v_actor_club_id;

  if not found then
    raise exception 'member_not_found';
  end if;

  return query
    select
      p.id,
      p.first_name,
      p.last_name,
      p.phone,
      v_membership.role,
      v_membership.status,
      p.created_at,
      u.email::text as email,
      v_membership.is_lesson_provider,
      v_membership.removed_at,
      (
        select count(*) from public.event_participants ep
          join public.events ev on ev.id = ep.event_id
         where ep.profile_id        = p_member_id
           and ep.attendance_status = 'attended'
           and ev.club_id           = v_actor_club_id
      ) as attended_event_count,
      (
        select count(*) from public.event_participants ep
          join public.events ev on ev.id = ep.event_id
         where ep.profile_id        = p_member_id
           and ep.attendance_status = 'no_show'
           and ev.club_id           = v_actor_club_id
      ) as event_no_show_count,
      (
        select count(*) from public.lesson_requests lr
         where lr.member_id      = p_member_id
           and lr.club_id        = v_actor_club_id
           and lr.lesson_outcome = 'completed'
      ) as completed_lesson_count,
      (
        select count(*) from public.lesson_requests lr
         where lr.member_id      = p_member_id
           and lr.club_id        = v_actor_club_id
           and lr.lesson_outcome = 'member_no_show'
      ) as member_lesson_no_show_count,
      rm.membership_status,
      rm.membership_type_id,
      mt.name as membership_type_name
    from public.profiles p
    left join auth.users u on u.id = p.id
    left join public.roster_members rm on rm.club_id = v_actor_club_id and rm.claimed_by = p.id
    left join public.membership_types mt on mt.id = rm.membership_type_id and mt.club_id = v_actor_club_id
   where p.id = p_member_id;
end;
$function$;

revoke execute on function public.get_admin_member_detail(uuid) from public, anon;
grant  execute on function public.get_admin_member_detail(uuid) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. `drop function public.get_admin_member_detail(uuid);` (17-column
--    signature) then restore the exact 0132 body (14-column RETURNS TABLE,
--    no roster_members/membership_types joins) via CREATE OR REPLACE,
--    followed by its existing revoke/grant (unchanged either way).
-- No other table, policy, or function is touched by this migration. 0188,
-- 0189, and 0190 are read-only consumed here, never modified.
-- ═══════════════════════════════════════════════════════════════════════════
