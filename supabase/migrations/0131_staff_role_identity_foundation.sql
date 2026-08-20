-- 0131_staff_role_identity_foundation.sql
-- Phase 34A3: Staff Role Identity Foundation.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 34A1 (audit) and 34A2 (application-layer role helpers) established
-- that Court Time needs a fourth base role, 'staff', distinct from 'pro':
-- an operational employee identity, not a teaching-provider identity.
-- Teaching/provider identity remains the existing, separate
-- is_lesson_provider boolean — this migration does not change that axis's
-- meaning, only which role values may carry it.
--
-- THIS MIGRATION MAKES 'staff' A VALID STORED VALUE. IT DOES NOT GRANT
-- STAFF ANY OPERATIONAL AUTHORITY. Every RLS policy and every RPC that
-- currently authorizes by an explicit allowlist (role = 'admin',
-- role in ('admin', 'pro'), etc.) is UNCHANGED by this migration — 'staff'
-- is simply never a member of those lists yet. A user with role = 'staff'
-- after this migration:
--   • cannot reach /admin/* (src/lib/auth/roles.ts's
--     canAccessOperationsWorkspace() — Phase 34A2 — already excludes staff,
--     untouched here)
--   • cannot call any admin/pro-gated RPC (admin_add_member,
--     admin_lesson_ops, roster CRUD reads, settings, audit log, reports,
--     communications-send, etc. — none of their role allowlists are
--     touched here)
--   • sees only their own reservations/events/programs via RLS in a
--     Staff-Managed club, same as a plain Member (the Section-2-style
--     policies from 0123 already fall back to own-row visibility for any
--     role outside admin/pro/entitled-member — untouched here)
-- Widening those allowlists to admit 'staff' is explicitly deferred to a
-- later checkpoint (34A4), which will make that decision domain by domain.
--
-- SCOPE — five parts, each justified by the Phase 34A3 activation-safety
-- audit (see the accompanying report for the full finding-by-finding
-- classification):
--   1. Widen five CHECK constraints so 'staff' is a legal stored role
--      value: profiles.role, club_memberships.role, roster_members.role,
--      club_invites.role, lesson_requests.last_actor_role.
--   2. Widen the role-assignment validation in four identity functions so
--      an admin can actually create/invite/reassign a Staff identity:
--      set_member_role, create_club_invite, add_roster_member,
--      update_roster_member. No authorization gate in any of these four
--      changes — each is still admin-only exactly as before; only the SET
--      of role values an admin may assign is widened. add_roster_member
--      and update_roster_member additionally gain SECURITY DEFINER
--      search_path hardening (schema-qualified `public.<name>`, explicit
--      `set search_path = public, pg_temp`) — a genuine pre-existing gap
--      (confirmed: neither was ever covered by
--      0068_harden_phase22_function_search_path.sql or any later
--      migration) surfaced while this migration was already touching both
--      functions, corrected rather than left in place. See Section 4's
--      header for the full justification and the six-function
--      SECURITY DEFINER/search_path audit in the Phase 34A3 report.
--   3. Widen set_lesson_provider_status's target-role guard from
--      admin-only to admin-or-staff, so an admin can represent a
--      "Staff · Pro" account (role='staff', is_lesson_provider=true) —
--      the one concrete Staff+lesson-provider capability the Phase 34A3
--      brief calls for. Still admin-only to CALL; only which ROLE the
--      TARGET may have is widened.
--   4. Activation-safety corrections to four NEW-entry self-service RPCs —
--      create_reservation, join_event, join_program, submit_lesson_request
--      — each of which was written as "if role = 'member' then restrict"
--      (i.e. every other role, implicitly only admin/pro today, is
--      exempt) in TWO independent places per function: a scheduling/
--      capacity guard (create_reservation's booking window only) and,
--      separately, the Staff-Managed member_self_service entitlement gate
--      (all four functions). Left unchanged, a Staff account would
--      silently inherit the admin/pro exemption from BOTH the moment
--      'staff' became a legal value — an accidental grant of operational
--      latitude and an accidental bypass of the club's commercial tier for
--      a Staff person's own self-service actions, neither of which this
--      migration may cause. Both corrected to an explicit `role not in
--      ('admin', 'pro')` allowlist per guard, so Staff remains subject to
--      the same booking window AND the same Staff-Managed/Connected
--      entitlement as Member for these four self-service entry points,
--      until 34A4 gives Staff a separate, dedicated operational path.
--      Admin/Pro behavior is byte-identical either way (`role not in
--      ('admin','pro')` and `role = 'member'` agree on every value except
--      'staff', which did not previously exist). create_club_invite's own
--      entitlement gate is deliberately NOT changed — see its own section
--      — Staff employee invitations are an admin operational action,
--      independent of commercial tier, not a Staff person's own
--      self-service action. Every other RPC/RLS check audited already
--      authorizes via a positive admin/pro allowlist or a relationship
--      check (owner/participant/pro_id), which excludes an unrelated
--      Staff account with no code change required.
--   5. Nothing else. No RLS policy is touched. No operational allowlist
--      (role in ('admin','pro')) is widened. No new table. No Staff UI.
--      No pricing/payments.
--
-- Every function below is reproduced from its current effective body
-- (confirmed via direct migration-history read, not assumed) with the
-- minimum change described above for that function — no unrelated logic
-- is touched, reordered, or "cleaned up". set_member_role and
-- create_club_invite change by exactly one validation line each;
-- create_reservation, join_event, join_program, and submit_lesson_request
-- each change by exactly one entitlement-condition line (plus, for
-- create_reservation only, the previously-accepted booking-window line);
-- set_lesson_provider_status changes by exactly one target-role-guard
-- line; add_roster_member and update_roster_member change their signature
-- line, validation line, and LANGUAGE/SECURITY/search_path clause only,
-- per Section 4's header.
--
-- Not applied by this checkpoint — see the Phase 34A3 report's pre-apply
-- verification checklist. Apply in Supabase SQL Editor (cloud only).
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. CHECK constraint widening — five columns, 'staff' added to each.
-- Every one of these constraints has had exactly one definition since its
-- introducing migration (0001/0031/0056/0069/0081 respectively) and has
-- never been altered since (confirmed: no later migration issues DROP/ADD
-- CONSTRAINT against any of them) — so each currently carries Postgres's
-- standard auto-generated <table>_<column>_check name, the same name every
-- other constraint-widening migration in this repo already relies on
-- (0065_event_type_management.sql, 0070_lesson_competitive_foundation.sql,
-- 0074_expand_club_theme_presets.sql — identical drop/add pattern).
--
-- FAIL-CLOSED BY DESIGN: the Phase 34A3 pre-apply checklist runs Check 1
-- (pg_constraint lookup of these five exact names) immediately before this
-- migration is applied — its entire purpose is to confirm the name and
-- definition assumed here are still correct. Given that preflight already
-- ran, DROP CONSTRAINT below is deliberately NOT "IF EXISTS": if schema
-- drift means the expected name no longer exists, this statement raises
-- undefined_object and the whole transaction rolls back — nothing is
-- silently skipped or left half-widened. IF EXISTS would swallow exactly
-- that failure mode (a name mismatch would no-op the DROP, then ADD
-- CONSTRAINT would fail on a duplicate-name conflict instead, or — worse,
-- if the ADD used a different name — leave BOTH the old three-role
-- constraint and a new permissive one in place simultaneously). Failing
-- loudly here is the intended, verified behavior, not a leftover.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.profiles
  drop constraint profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('member', 'pro', 'staff', 'admin'));

alter table public.club_memberships
  drop constraint club_memberships_role_check;
alter table public.club_memberships
  add constraint club_memberships_role_check
  check (role in ('member', 'pro', 'staff', 'admin'));

alter table public.roster_members
  drop constraint roster_members_role_check;
alter table public.roster_members
  add constraint roster_members_role_check
  check (role in ('member', 'pro', 'staff', 'admin'));

alter table public.club_invites
  drop constraint club_invites_role_check;
alter table public.club_invites
  add constraint club_invites_role_check
  check (role in ('member', 'pro', 'staff', 'admin'));

-- lesson_requests.last_actor_role is not an assignable identity role — it is
-- a historical-audit echo of whatever role the acting caller held at the
-- moment they touched a lesson request (see cancel_lesson below, and the
-- last_actor_role = v_profile.role writes throughout the lesson-request RPC
-- family, none of which are touched by this migration). Its authorization
-- gates are relationship-based (the request's member/roster identity, its
-- assigned pro_id, or role = 'admin'), never a broad role allowlist, so a
-- Staff account can already only reach these writes by independently being
-- the member on their OWN lesson request — a legitimate, expected case (a
-- staff employee who is also a club member taking lessons). Without this
-- widening, that specific, already-possible interaction would hard-fail
-- with a constraint violation the moment their account became role='staff'.
-- This is activation-safety (don't break an existing legitimate write path),
-- not new authorization.
alter table public.lesson_requests
  drop constraint lesson_requests_last_actor_role_check;
alter table public.lesson_requests
  add constraint lesson_requests_last_actor_role_check
  check (last_actor_role in ('member', 'pro', 'staff', 'admin'));


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. set_member_role — widen p_new_role validation only.
-- Latest effective body: 0083_auth_context_and_membership_controls.sql.
-- Every other line reproduced verbatim, including the is_lesson_provider
-- sync CASE, which is deliberately NOT changed: `when p_new_role = 'pro'
-- then true / when p_new_role = 'member' then false / else
-- cm.is_lesson_provider` already does the right thing for 'staff' the
-- moment it becomes a legal argument, with no code change —
--   • Member -> Staff: falls to `else`, preserves is_lesson_provider, which
--     was already false for a plain Member. Result: false. Matches the
--     locked "plain Staff defaults to provider=false" rule.
--   • Pro -> Staff: falls to `else`, preserves is_lesson_provider, which
--     was true for a Pro. Result: true — representing "Staff · Pro"
--     exactly as intended by the locked model, with no special case.
--   • Staff -> Member: still hits the explicit `when p_new_role = 'member'
--     then false` branch — forces is_lesson_provider false regardless of
--     prior state, exactly as the locked model requires.
-- This is the Phase 34A3 report's Step 3 transition-matrix proof, not an
-- assumption — see the report for the full A-G walkthrough.
-- Authorization (insufficient_role -> admin only), last-admin protection,
-- and every audit_log write are untouched.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.set_member_role(
  p_target_user_id uuid,
  p_new_role       text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_club_id uuid;
  v_actor_role    text;
  v_target        public.club_memberships%rowtype;
  v_admin_count   int;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  -- Capture actor club and role together, one statement, one snapshot —
  -- prevents a concurrent set_active_club in another session from pairing
  -- an Admin role from one club with a different now-active club. No
  -- further call to either helper below; only v_actor_club_id is used.
  select public.current_user_club_id(), public.current_user_role()
    into v_actor_club_id, v_actor_role;

  if v_actor_role is distinct from 'admin' then
    raise exception 'insufficient_role';
  end if;

  if p_new_role not in ('member', 'pro', 'staff', 'admin') then
    raise exception 'invalid_role';
  end if;

  -- Lock order: target's profiles row first (deadlock-avoidance rationale
  -- unchanged from the 0083 header comment for this function).
  perform 1 from public.profiles where id = p_target_user_id for update;

  select cm.* into v_target
    from public.club_memberships cm
   where cm.user_id = p_target_user_id
     and cm.club_id = v_actor_club_id
     and cm.removed_at is null;

  if not found then raise exception 'user_not_found'; end if;

  if auth.uid() = p_target_user_id then
    raise exception 'cannot_change_own_role';
  end if;

  if v_target.role = 'admin' and p_new_role <> 'admin' then
    -- Lock all active, non-removed admin memberships in the active club to
    -- serialize concurrent demotions.
    perform cm.id
      from public.club_memberships cm
     where cm.club_id    = v_actor_club_id
       and cm.role       = 'admin'
       and cm.status     = 'active'
       and cm.removed_at is null
     for update;

    select count(*) into v_admin_count
      from public.club_memberships cm
     where cm.club_id    = v_actor_club_id
       and cm.role       = 'admin'
       and cm.status     = 'active'
       and cm.removed_at is null
       and cm.user_id   <> p_target_user_id;

    if v_admin_count = 0 then
      raise exception 'last_admin';
    end if;
  end if;

  update public.club_memberships cm
     set role               = p_new_role,
         is_lesson_provider = case
           when p_new_role = 'pro'    then true
           when p_new_role = 'member' then false
           else cm.is_lesson_provider
         end
   where cm.user_id = p_target_user_id
     and cm.club_id = v_actor_club_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor_club_id, auth.uid(), 'set_member_role', 'profile', p_target_user_id,
    jsonb_build_object('old_role', v_target.role, 'new_role', p_new_role)
  );
end;
$$;

revoke execute on function public.set_member_role(uuid, text) from public, anon;
grant  execute on function public.set_member_role(uuid, text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. create_club_invite — widen p_role validation only.
-- Latest effective body: 0123_staff_managed_connected_enforcement.sql.
-- The Staff-Managed entitlement gate (`p_role = 'member' and not
-- current_club_has_capability(...)`) is deliberately untouched — it stays
-- scoped to 'member' exactly as today, so a Staff invitation is never
-- blocked by a club's commercial tier, consistent with the Phase 34A1
-- audit's conclusion that Staff role and Staff-Managed/Connected tier are
-- orthogonal. Every other line reproduced verbatim.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.create_club_invite(
  p_role             text,
  p_roster_member_id uuid,
  p_expires_at       timestamptz default now() + interval '7 days'
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile   public.profiles%rowtype;
  v_roster    public.roster_members%rowtype;
  v_invite_id uuid;
  v_code      text;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  if p_role not in ('member', 'pro', 'staff', 'admin') then
    raise exception 'invalid_role';
  end if;

  -- Phase 33F3B: a Staff-Managed club may not create a NEW Member-role
  -- invitation. Admin/Pro/Staff invitations are unaffected.
  if p_role = 'member' and not public.current_club_has_capability('member_self_service') then
    raise exception 'capability_not_available';
  end if;

  if p_roster_member_id is null then
    raise exception 'roster_identity_required';
  end if;

  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_profile.club_id
   for update;
  if not found                       then raise exception 'roster_member_not_found';         end if;
  if v_roster.claimed_by is not null then raise exception 'roster_member_already_claimed';   end if;
  if v_roster.email is null          then raise exception 'roster_email_required';           end if;
  if v_roster.status is distinct from 'active' then raise exception 'roster_member_inactive'; end if;

  if exists (
    select 1 from public.club_invites
     where roster_member_id = p_roster_member_id
       and accepted_at is null
       and revoked_at  is null
       and expires_at  > now()
  ) then
    raise exception 'invite_already_pending';
  end if;

  insert into public.club_invites (club_id, role, email, roster_member_id, created_by, expires_at)
  values (
    v_profile.club_id,
    p_role,
    v_roster.email,
    p_roster_member_id,
    auth.uid(),
    p_expires_at
  )
  returning id, code into v_invite_id, v_code;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'create_invite',
    'club_invite',
    v_invite_id,
    jsonb_build_object('role', p_role, 'roster_member_id', p_roster_member_id, 'expires_at', p_expires_at)
  );

  return v_code;
end;
$$;

revoke execute on function public.create_club_invite(text, uuid, timestamptz) from public, anon;
grant  execute on function public.create_club_invite(text, uuid, timestamptz) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. add_roster_member / update_roster_member — widen p_role validation
-- only. Latest (and only) effective body for both: 0056_roster_members.sql
-- — never redefined since. Every other line reproduced verbatim, including
-- the admin-only gate and the roster_members.role column's own "display/
-- intent only — does not grant app permissions" contract (unchanged: a
-- roster row's role is realized only once accept_club_invite copies the
-- linked invite's role onto the claiming profile — untouched by this
-- migration).
--
-- SEARCH_PATH HARDENING (Phase 34A3 correction): the 0056 body predates
-- both the schema-qualified `public.<name>` convention and
-- 0068_harden_phase22_function_search_path.sql's `set search_path =
-- public, pg_temp` convention — and, unlike every function 0068 covered
-- (0064-0067's SECURITY DEFINER functions), add_roster_member and
-- update_roster_member were never in 0068's stated scope and have never
-- been hardened by any later migration either (confirmed: no
-- `alter function ... add_roster_member`/`update_roster_member` exists
-- anywhere in this repo's history). Reproducing the 0056 body verbatim via
-- CREATE OR REPLACE here would therefore not weaken any existing live
-- protection — there was none to begin with — but leaving that gap
-- uncorrected while touching these two functions anyway would be a missed,
-- and increasingly conspicuous, opportunity. Both are corrected here to
-- the same secure posture every other function in this migration already
-- has: schema-qualified `public.add_roster_member`/`public.
-- update_roster_member`, and an explicit `set search_path = public,
-- pg_temp`. This is the only change beyond the p_role widening — no body
-- logic, error code, or audit behavior is touched.
--
-- add_roster_member_and_invite (0067_add_and_invite.sql) is a separate,
-- deliberately narrower convenience RPC whose own p_role validation
-- (`not in ('member', 'pro')`) already excludes 'admin' by original
-- product decision, independent of Staff. It is NOT widened here: the
-- two-step path (add_roster_member, then create_club_invite — both
-- widened above) already fully supports creating and inviting a Staff
-- identity, so add_roster_member_and_invite's narrower scope is not a
-- blocker for Staff identity to exist. Whether the combined quick-add flow
-- should also support Staff is a product/UI decision left to 34A4. It
-- already has search_path hardening from 0068 (defense-in-depth) and is
-- not touched by this migration at all, so nothing about its security
-- posture needs re-verifying here.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.add_roster_member(
  p_first_name text,
  p_last_name  text,
  p_email      text    default null,
  p_phone      text    default null,
  p_role       text    default 'member',
  p_notes      text    default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile   profiles%rowtype;
  v_first     text;
  v_last      text;
  v_email     text;
  v_phone     text;
  v_notes     text;
  v_new_id    uuid;
  v_dup_count int;
begin
  -- 1. Auth / admin gate.
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  -- 2. Validate role.
  if p_role not in ('member', 'pro', 'staff', 'admin') then
    raise exception 'invalid_role';
  end if;

  -- 3. Trim and normalise — empty strings become null.
  v_first := nullif(btrim(p_first_name), '');
  v_last  := nullif(btrim(p_last_name), '');
  v_email := nullif(btrim(coalesce(p_email, '')), '');
  v_phone := nullif(btrim(coalesce(p_phone, '')), '');
  v_notes := nullif(btrim(coalesce(p_notes, '')), '');

  if v_first is null then raise exception 'first_name_required'; end if;
  if v_last  is null then raise exception 'last_name_required';  end if;

  -- 4. Duplicate email check (only when email is provided).
  if v_email is not null then
    -- Against unclaimed roster members in same club.
    select count(*) into v_dup_count
      from roster_members
     where club_id      = v_profile.club_id
       and lower(email)  = lower(v_email)
       and claimed_by   is null;

    if v_dup_count > 0 then
      raise exception 'email_already_on_roster';
    end if;

    -- Against existing auth-linked profiles in same club.
    select count(*) into v_dup_count
      from profiles p
      join auth.users u on u.id = p.id
     where p.club_id      = v_profile.club_id
       and lower(u.email)  = lower(v_email);

    if v_dup_count > 0 then
      raise exception 'email_already_a_member';
    end if;
  end if;

  -- 5. Insert.
  insert into roster_members (club_id, first_name, last_name, email, phone, role, notes, created_by)
  values (v_profile.club_id, v_first, v_last, v_email, v_phone, p_role, v_notes, auth.uid())
  returning id into v_new_id;

  -- 6. Audit.
  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'add_roster_member',
    'roster_member',
    v_new_id,
    jsonb_build_object(
      'first_name', v_first,
      'last_name',  v_last,
      'email',      v_email,
      'role',       p_role
    )
  );

  return v_new_id;
end;
$$;

create or replace function public.update_roster_member(
  p_id         uuid,
  p_first_name text,
  p_last_name  text,
  p_email      text    default null,
  p_phone      text    default null,
  p_role       text    default 'member',
  p_notes      text    default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile   profiles%rowtype;
  v_roster    roster_members%rowtype;
  v_first     text;
  v_last      text;
  v_email     text;
  v_phone     text;
  v_notes     text;
  v_dup_count int;
begin
  -- 1. Auth / admin gate.
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  -- 2. Load target, scoped to admin's club.
  select * into v_roster
    from roster_members
   where id      = p_id
     and club_id = v_profile.club_id;
  if not found then raise exception 'roster_member_not_found'; end if;

  -- 3. Cannot update a claimed entry (manage via profiles instead).
  if v_roster.claimed_by is not null then
    raise exception 'roster_member_already_claimed';
  end if;

  -- 4. Validate role.
  if p_role not in ('member', 'pro', 'staff', 'admin') then
    raise exception 'invalid_role';
  end if;

  -- 5. Trim and normalise.
  v_first := nullif(btrim(p_first_name), '');
  v_last  := nullif(btrim(p_last_name), '');
  v_email := nullif(btrim(coalesce(p_email, '')), '');
  v_phone := nullif(btrim(coalesce(p_phone, '')), '');
  v_notes := nullif(btrim(coalesce(p_notes, '')), '');

  if v_first is null then raise exception 'first_name_required'; end if;
  if v_last  is null then raise exception 'last_name_required';  end if;

  -- 6. Duplicate email check if email changed.
  if v_email is not null
     and (v_roster.email is null or lower(v_email) <> lower(v_roster.email))
  then
    select count(*) into v_dup_count
      from roster_members
     where club_id      = v_profile.club_id
       and lower(email)  = lower(v_email)
       and id           <> p_id
       and claimed_by   is null;

    if v_dup_count > 0 then
      raise exception 'email_already_on_roster';
    end if;

    select count(*) into v_dup_count
      from profiles p
      join auth.users u on u.id = p.id
     where p.club_id      = v_profile.club_id
       and lower(u.email)  = lower(v_email);

    if v_dup_count > 0 then
      raise exception 'email_already_a_member';
    end if;
  end if;

  -- 7. Update.
  update roster_members
     set first_name = v_first,
         last_name  = v_last,
         email      = v_email,
         phone      = v_phone,
         role       = p_role,
         notes      = v_notes
   where id = p_id;

  -- 8. Audit.
  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'update_roster_member',
    'roster_member',
    p_id,
    jsonb_build_object(
      'first_name', v_first,
      'last_name',  v_last,
      'email',      v_email,
      'role',       p_role
    )
  );
end;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. set_lesson_provider_status — widen target-role guard to admin-or-staff.
-- Latest effective body: 0083_auth_context_and_membership_controls.sql.
-- This is the Phase 34A3 Step 3B requirement: an admin must be able to
-- designate a Staff account as a lesson provider (role='staff',
-- is_lesson_provider=true — "Staff · Pro"). The CALLER gate
-- (insufficient_role -> admin only) is untouched; only which ROLE the
-- TARGET may have is widened, from admin-only to admin-or-staff.
--
-- The error code raised when the target is neither admin nor staff is
-- deliberately left as the existing 'target_not_admin_role' string rather
-- than renamed, so src/app/(app)/admin/members/[id]/actions.ts's existing
-- ERROR_MESSAGES map (Phase 34A3 makes no frontend changes) continues to
-- work unmodified. The message text ("...can only be set for Admin-role
-- members") is now slightly stale for the staff case, but is unreachable
-- through the current UI regardless — there is no Staff-role member-detail
-- flow yet to reach it — and is left as a documented, explicit 34A4 UI
-- follow-up rather than touched here.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.set_lesson_provider_status(
  p_target_user_id uuid,
  p_enabled        boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_club_id uuid;
  v_actor_role    text;
  v_target        public.club_memberships%rowtype;
  v_old_val       boolean;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  select public.current_user_club_id(), public.current_user_role()
    into v_actor_club_id, v_actor_role;

  if v_actor_role is distinct from 'admin' then
    raise exception 'insufficient_role';
  end if;

  perform 1 from public.profiles where id = p_target_user_id for update;

  select cm.* into v_target
    from public.club_memberships cm
   where cm.user_id = p_target_user_id
     and cm.club_id = v_actor_club_id
     and cm.removed_at is null;

  if not found then raise exception 'user_not_found'; end if;

  if v_target.role not in ('admin', 'staff') then
    raise exception 'target_not_admin_role';
  end if;

  v_old_val := v_target.is_lesson_provider;
  if v_old_val = p_enabled then
    return;
  end if;

  update public.club_memberships
     set is_lesson_provider = p_enabled
   where user_id = p_target_user_id
     and club_id = v_actor_club_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor_club_id, auth.uid(), 'set_lesson_provider_status', 'profile', p_target_user_id,
    jsonb_build_object('old_value', v_old_val, 'new_value', p_enabled)
  );
end;
$$;

revoke execute on function public.set_lesson_provider_status(uuid, boolean) from public, anon;
grant  execute on function public.set_lesson_provider_status(uuid, boolean) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. create_reservation — TWO activation-safety corrections.
-- Latest effective body: 0123_staff_managed_connected_enforcement.sql.
--
-- (a) Booking-window guard: `role = 'member'` (restrict Member, implicitly
-- exempt everyone else — today that "everyone else" is only admin/pro) ->
-- explicit `role not in ('admin', 'pro')` allowlist, so Staff does not
-- silently inherit the admin/pro scheduling exemption merely because
-- 'staff' becomes a legal role value. Staff remains subject to the same
-- booking window as Member until 34A4 deliberately decides whether Staff
-- should get this exemption as part of Reservations operational authority.
--
-- (b) Staff-Managed entitlement gate: `role = 'member'` -> `role not in
-- ('admin', 'pro')`, for the identical reason, corrected here in place of
-- the prior (34A3-interim) reasoning that this gate should stay
-- 'member'-only. That reasoning conflated two distinct things: Staff's
-- future OPERATIONAL authority (e.g. an admin/pro-equivalent path for
-- creating a reservation ON BEHALF OF a member, deferred to 34A4, correctly
-- orthogonal to commercial tier) versus a Staff person's own MEMBER-STYLE
-- self-service action (booking a court for THEMSELVES via this exact RPC,
-- the same one a plain Member calls). The latter is functionally identical
-- to Member self-service and must follow the same commercial gate — a
-- Staff-Managed club still means "no unentitled self-service booking,"
-- for a Staff person acting as a self-service caller, exactly as for a
-- Member, until 34A4 gives Staff a SEPARATE, dedicated operational RPC
-- path that is not gated this way. Admin/Pro are unaffected either way —
-- `role not in ('admin', 'pro')` is false for both, identical to the prior
-- `role = 'member'` test being false for both. create_club_invite's own
-- entitlement gate is a genuinely different case and is NOT changed (see
-- its own section above) — inviting a Staff EMPLOYEE is an admin
-- operational action independent of commercial tier, not a Staff person's
-- own self-service action.
--
-- The past-date guard and the 30/60/90/120-minute duration whitelist are
-- both already unconditional (no role check at all) and are untouched.
-- Every other line reproduced verbatim from 0123.
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


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. join_event — ONE activation-safety correction, same shape as
-- create_reservation's entitlement-gate fix above (Section 6b).
-- Latest effective body: 0127_program_session_capacity_correctness.sql.
-- Only the entitlement-gate condition changes, from `role = 'member'` to
-- `role not in ('admin', 'pro')` — a Staff person joining an Event for
-- THEMSELVES is the same self-service action a Member performs via this
-- exact RPC, so it must follow the same commercial gate until 34A4 gives
-- Staff a separate operational join/add path. Admin/Pro behavior
-- unaffected (`role not in ('admin','pro')` is false for both, identical
-- to the prior `role = 'member'` test). Every other line — capacity via
-- _event_effective_occupancy, waitlist offer advancement, roster-identity
-- resolution, notification — reproduced verbatim from 0127.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function join_event(p_event_id uuid)
returns event_participants
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile  profiles%rowtype;
  v_event    events%rowtype;
  v_existing event_participants%rowtype;
  v_existing_found boolean;
  v_count    int;
  v_result   event_participants%rowtype;
  v_roster_member_id uuid;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.status <> 'active' then raise exception 'account_inactive'; end if;

  -- Phase 34A3: restated as an explicit admin/pro allowlist rather than a
  -- member-exclusion — see this section's header above.
  if v_profile.role not in ('admin', 'pro') and not current_club_has_capability('member_self_service') then
    raise exception 'capability_not_available';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_profile.club_id
      and status  = 'scheduled'
    for update;
  if not found then raise exception 'event_not_found'; end if;

  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  if not v_event.member_joinable then
    raise exception 'event_not_joinable';
  end if;

  if v_event.starts_at < now() then
    raise exception 'event_already_started';
  end if;

  select id into v_roster_member_id
    from roster_members
   where club_id    = v_profile.club_id
     and claimed_by = auth.uid();
  if not found then
    raise exception 'phase33d2_unresolved_member_identity';
  end if;

  perform expire_stale_offers_for_event(p_event_id, v_profile.club_id, v_event.title);
  perform advance_waitlist_offer(p_event_id, v_profile.club_id, v_event.title);

  select * into v_existing
    from event_participants
   where event_id = p_event_id
     and (profile_id = auth.uid() or roster_member_id = v_roster_member_id)
   for update;
  v_existing_found := found;

  if v_existing_found and v_existing.status in ('confirmed', 'waitlisted', 'offered') then
    raise exception 'already_joined';
  end if;

  v_count := public._event_effective_occupancy(
    p_event_id,
    case when v_existing_found then v_existing.id else null end
  );

  if v_count >= v_event.capacity then
    if v_existing_found then
      update event_participants
         set status = 'waitlisted', profile_id = auth.uid(), roster_member_id = v_roster_member_id, updated_at = now()
       where id = v_existing.id
      returning * into v_result;
    else
      insert into event_participants (event_id, profile_id, roster_member_id, role, status)
      values (p_event_id, auth.uid(), v_roster_member_id, 'participant', 'waitlisted')
      returning * into v_result;
    end if;

    if v_result.id is null then
      raise exception 'event_participant_write_failed';
    end if;
  else
    if v_existing_found then
      update event_participants
         set status = 'confirmed', profile_id = auth.uid(), roster_member_id = v_roster_member_id, updated_at = now()
       where id = v_existing.id
      returning * into v_result;
    else
      insert into event_participants (event_id, profile_id, roster_member_id, role, status)
      values (p_event_id, auth.uid(), v_roster_member_id, 'participant', 'confirmed')
      returning * into v_result;
    end if;

    if v_result.id is null then
      raise exception 'event_participant_write_failed';
    end if;

    if user_pref_enabled(auth.uid(), 'event_joined') then
      insert into notifications (club_id, user_id, kind, body, metadata)
      values (
        v_profile.club_id,
        auth.uid(),
        'event_joined',
        'You''ve joined "' || v_event.title || '".',
        jsonb_build_object('event_id', p_event_id)
      );
    end if;
  end if;

  return v_result;
end;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 8. join_program — ONE activation-safety correction, identical shape to
-- Section 7 above. Latest effective body:
-- 0127_program_session_capacity_correctness.sql. Only the entitlement-gate
-- condition changes, from `role = 'member'` to `role not in ('admin',
-- 'pro')`. Admin/Pro unaffected. Every other line — whole-program
-- enrollment eligibility, waitlist-offer expiry/advancement, capacity and
-- future-session-fit checks, materialization into future sessions, audit
-- log — reproduced verbatim from 0127, including the last_actor_role
-- literal 'member' left exactly as-is: it is not a fourth-role activation
-- concern (it was already a pre-existing, unconditional literal — every
-- caller who reaches this line, regardless of role, gets the same
-- 'member' audit label today, both before and after this migration) and
-- is out of this checkpoint's scope to correct.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.join_program(p_program_id uuid)
returns public.program_enrollments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id  uuid;
  v_role     text;
  v_roster_member_id uuid;
  v_program  public.programs%rowtype;
  v_existing public.program_enrollments%rowtype;
  v_existing_found boolean;
  v_count    int;
  v_new_status text;
  v_result   public.program_enrollments%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  -- Phase 34A3: restated as an explicit admin/pro allowlist rather than a
  -- member-exclusion — see this section's header above.
  if v_role not in ('admin', 'pro') and not public.current_club_has_capability('member_self_service') then
    raise exception 'capability_not_available';
  end if;

  v_roster_member_id := public.current_user_roster_member_id();
  if v_roster_member_id is null then raise exception 'phase33d2_unresolved_member_identity'; end if;

  select * into v_program from public.programs
    where id = p_program_id and club_id = v_club_id for update;
  if not found then raise exception 'program_not_found'; end if;
  if v_program.enrollment_model <> 'program' then raise exception 'program_not_whole_enrollment'; end if;
  if not public._program_is_enrollable(v_program) then raise exception 'program_not_enrollable'; end if;

  select * into v_existing from public.program_enrollments
    where program_id = p_program_id and (profile_id = auth.uid() or roster_member_id = v_roster_member_id);
  if found and v_existing.status = 'enrolled' then return v_existing; end if;

  perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);
  perform public._advance_program_waitlist_offer(p_program_id, v_club_id, v_program.title);

  select * into v_existing from public.program_enrollments
    where program_id = p_program_id and (profile_id = auth.uid() or roster_member_id = v_roster_member_id)
    for update;
  v_existing_found := found;

  if v_existing_found and v_existing.status in ('waitlisted', 'offered') then
    raise exception 'already_enrolled';
  end if;

  select count(*) into v_count from public.program_enrollments
    where program_id = p_program_id and status in ('enrolled', 'offered');

  if v_count >= v_program.default_capacity or exists (
    select 1 from public.program_enrollments where program_id = p_program_id and status = 'waitlisted'
  ) then
    v_new_status := 'waitlisted';
  elsif not public._program_candidate_fits_future_sessions(p_program_id, v_roster_member_id) then
    v_new_status := 'waitlisted';
  else
    v_new_status := 'enrolled';
  end if;

  if v_existing_found then
    update public.program_enrollments
       set status = v_new_status, profile_id = auth.uid(), roster_member_id = v_roster_member_id,
           offer_expires_at = null,
           waitlisted_at = case when v_new_status = 'waitlisted' then now() else null end,
           updated_at = now()
     where id = v_existing.id
    returning * into v_result;
  else
    insert into public.program_enrollments (program_id, profile_id, roster_member_id, status, waitlisted_at)
    values (p_program_id, auth.uid(), v_roster_member_id, v_new_status,
      case when v_new_status = 'waitlisted' then now() else null end)
    returning * into v_result;
  end if;

  if v_result.id is null then raise exception 'program_enrollment_write_failed'; end if;

  if v_new_status = 'enrolled' then
    perform public._materialize_program_member_into_future_events(p_program_id, v_roster_member_id, v_club_id);
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (v_club_id, auth.uid(), 'join_program', 'program', p_program_id,
    jsonb_build_object('status', v_result.status, 'actor_role', v_role));

  return v_result;
end;
$$;

revoke execute on function public.join_program(uuid) from public, anon;
grant  execute on function public.join_program(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 9. submit_lesson_request — ONE activation-safety correction, identical
-- shape to Sections 6b/7/8 above. Latest effective body:
-- 0123_staff_managed_connected_enforcement.sql. Only the entitlement-gate
-- condition changes, from `role = 'member'` to `role not in ('admin',
-- 'pro')`. Admin/Pro unaffected — the function's own pre-existing
-- 'cannot_request_yourself' guard and the pro-eligibility query
-- (`role in ('pro', 'admin') and is_lesson_provider = true`, itself
-- deliberately NOT widened here — provider lookup eligibility is 34A4
-- territory, per the Phase 34A3 report's Step-1 finding #10) are both
-- untouched. The last_actor_role literal 'member' on insert is left
-- exactly as-is for the same pre-existing, out-of-scope reason noted in
-- Section 8 above. Every other line reproduced verbatim from 0123.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.submit_lesson_request(
  p_pro_id             uuid,
  p_duration_minutes   int,
  p_preferred_court_id uuid    default null,
  p_member_note        text    default null,
  p_preferred_windows  jsonb   default null,
  p_lesson_type_id     uuid    default null
)
returns public.lesson_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile           public.profiles%rowtype;
  v_pro                public.profiles%rowtype;
  v_result             public.lesson_requests%rowtype;
  -- Phase 33D1: the caller's own durable Member identity for this club.
  v_roster_member_id   uuid;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;
  if v_profile.status <> 'active' then raise exception 'account_inactive'; end if;

  -- Phase 34A3: restated as an explicit admin/pro allowlist rather than a
  -- member-exclusion — see this section's header above.
  if v_profile.role not in ('admin', 'pro') and not public.current_club_has_capability('member_self_service') then
    raise exception 'capability_not_available';
  end if;

  -- Phase 33D1: resolve the caller's own roster identity in this club.
  -- Never client-supplied — auth.uid() and v_profile.club_id are both
  -- server-derived, matching create_reservation's identical 0108 pattern.
  -- Fails closed: every active club member is expected to have one after
  -- 33B1's backfill and accept_club_invite's fail-closed roster
  -- resolution, so this should never legitimately raise.
  select id into v_roster_member_id
    from public.roster_members
   where club_id    = v_profile.club_id
     and claimed_by = auth.uid();
  if not found then raise exception 'no_roster_identity'; end if;

  -- Validate pro: active, same club, role pro or admin, is_lesson_provider = true
  select * into v_pro
    from public.profiles
   where id      = p_pro_id
     and club_id = v_profile.club_id
     and status  = 'active'
     and role    in ('pro', 'admin')
     and is_lesson_provider = true;
  if not found then raise exception 'pro_not_found'; end if;

  if p_pro_id = auth.uid() then raise exception 'cannot_request_yourself'; end if;

  -- Duration: positive multiple of 15 minutes, minimum 30
  if p_duration_minutes < 30 or p_duration_minutes % 15 <> 0 then
    raise exception 'invalid_duration';
  end if;

  -- Input length validation
  if length(p_member_note) > 500 then raise exception 'note_too_long'; end if;

  -- Validate optional preferred court
  if p_preferred_court_id is not null and not exists (
    select 1 from public.courts
     where id       = p_preferred_court_id
       and club_id  = v_profile.club_id
       and is_active = true
  ) then
    raise exception 'court_not_found';
  end if;

  -- Validate optional lesson type (active, same club)
  if p_lesson_type_id is not null then
    if not exists (
      select 1 from public.lesson_types
       where id       = p_lesson_type_id
         and club_id  = v_profile.club_id
         and is_active = true
    ) then
      raise exception 'lesson_type_not_found';
    end if;

    -- Enforce that requested duration is among the type's allowed durations (when set)
    if exists (
      select 1 from public.lesson_types lt
       where lt.id            = p_lesson_type_id
         and lt.allowed_durations is not null
         and array_length(lt.allowed_durations, 1) > 0
         and not (p_duration_minutes = any(lt.allowed_durations))
    ) then
      raise exception 'duration_not_allowed_for_type';
    end if;
  end if;

  insert into public.lesson_requests (
    club_id, member_id, pro_id, roster_member_id,
    preferred_court_id, duration_minutes,
    member_note, preferred_windows, status,
    lesson_type_id,
    last_actor_id, last_actor_role
  ) values (
    v_profile.club_id,
    auth.uid(),
    p_pro_id,
    v_roster_member_id,
    p_preferred_court_id,
    p_duration_minutes,
    btrim(coalesce(p_member_note, '')),
    p_preferred_windows,
    'pending',
    p_lesson_type_id,
    auth.uid(), 'member'
  ) returning * into v_result;

  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    p_pro_id,
    'lesson_request_received',
    trim(coalesce(v_profile.first_name, '') || ' ' || coalesce(v_profile.last_name, '')) ||
      ' has requested a ' || p_duration_minutes || '-minute lesson.',
    jsonb_build_object('request_id', v_result.id, 'target_path', '/events?tab=lessons')
  );

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'submit_lesson_request', 'lesson_request', v_result.id,
    jsonb_build_object('pro_id', p_pro_id, 'duration_minutes', p_duration_minutes, 'roster_member_id', v_roster_member_id)
  );

  return v_result;
end;
$$;

revoke execute on function public.submit_lesson_request(uuid, int, uuid, text, jsonb, uuid) from public, anon;
grant  execute on function public.submit_lesson_request(uuid, int, uuid, text, jsonb, uuid) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- Constraints — restore the pre-34A3 three-value CHECK on each:
--   alter table public.profiles          drop constraint if exists profiles_role_check;
--   alter table public.profiles          add constraint profiles_role_check check (role in ('member','pro','admin'));
--   alter table public.club_memberships  drop constraint if exists club_memberships_role_check;
--   alter table public.club_memberships  add constraint club_memberships_role_check check (role in ('member','pro','admin'));
--   alter table public.roster_members    drop constraint if exists roster_members_role_check;
--   alter table public.roster_members    add constraint roster_members_role_check check (role in ('member','pro','admin'));
--   alter table public.club_invites      drop constraint if exists club_invites_role_check;
--   alter table public.club_invites      add constraint club_invites_role_check check (role in ('member','pro','admin'));
--   alter table public.lesson_requests   drop constraint if exists lesson_requests_last_actor_role_check;
--   alter table public.lesson_requests   add constraint lesson_requests_last_actor_role_check check (last_actor_role in ('member','pro','admin'));
-- Rolling back the constraints FIRST, before any row is ever written with
-- role='staff', is safe unconditionally. Rolling back AFTER a real
-- role='staff' row exists would fail (existing row violates the restored
-- constraint) — reassign every such row's role away from 'staff' first.
--
-- Functions — restore the prior CREATE OR REPLACE body from its cited
-- source migration:
--   set_member_role           -> supabase/migrations/0083_auth_context_and_membership_controls.sql
--   create_club_invite        -> supabase/migrations/0123_staff_managed_connected_enforcement.sql
--   add_roster_member         -> supabase/migrations/0056_roster_members.sql (note: reverts search_path
--                                 hardening too — pre-34A3 this function had none)
--   update_roster_member      -> supabase/migrations/0056_roster_members.sql (same note)
--   set_lesson_provider_status -> supabase/migrations/0083_auth_context_and_membership_controls.sql
--   create_reservation        -> supabase/migrations/0123_staff_managed_connected_enforcement.sql
--   join_event                -> supabase/migrations/0127_program_session_capacity_correctness.sql
--   join_program               -> supabase/migrations/0127_program_session_capacity_correctness.sql
--   submit_lesson_request      -> supabase/migrations/0123_staff_managed_connected_enforcement.sql
-- No RLS policy, no new table, and no other function is touched by this
-- migration — nothing else requires rollback.
