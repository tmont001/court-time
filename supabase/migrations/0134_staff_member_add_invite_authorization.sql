-- 0134_staff_member_add_invite_authorization.sql
-- Phase 34A4A — final runtime QA follow-up.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- 0132 (applied, verified in Production) widened add_roster_member/
-- update_roster_member to admit a Staff caller restricted to p_role=
-- 'member'. It did NOT touch public.add_roster_member_and_invite (0067) —
-- that function remained strictly admin-only, unnoticed until this
-- checkpoint's runtime QA/audit surfaced it as a live gap: Staff's "Add and
-- generate invite" flow was hidden client-side only, papering over a real
-- server-side admin-only rejection rather than genuinely supporting Staff-
-- initiated Member invites.
--
-- The body below is the exact Production pg_get_functiondef output for
-- public.add_roster_member_and_invite(text, text, text, text, text, text),
-- supplied directly by the operator and copied verbatim — not reconstructed
-- from 0067. Exactly three changes from that verbatim text:
--
--   1. Caller gate widened so a Staff caller is admitted alongside the
--      existing Admin role: `role <> 'admin'` -> `role not in ('admin',
--      'staff')`.
--
--   2. A narrow Staff-only denial added immediately after the function's
--      own existing p_role validation (`p_role not in ('member', 'pro')` —
--      no new role vocabulary invented): a Staff caller is rejected
--      whenever p_role <> 'member', i.e. any attempt to invite a Pro.
--      p_role can never be 'staff' or 'admin' here regardless of caller —
--      the existing validation above this addition already restricts
--      p_role to ('member', 'pro') for every caller, unchanged. This
--      mirrors add_roster_member's identical Staff restriction (0132)
--      exactly.
--
--   3. Correction (this revision, not yet applied): a Staff-only
--      member_self_service entitlement guard, added immediately after
--      change #2 above, before any write. The Production body has no
--      entitlement check of its own — widening the caller gate to Staff
--      without this would let a Staff caller create a Member invite in a
--      Staff-Managed club, which is not allowed. Reuses the canonical,
--      already-established entitlement primitive verbatim — the same
--      helper (public.current_club_has_capability('member_self_service'),
--      0122) and the same exception name ('capability_not_available')
--      create_club_invite (0131/0132) already uses for this exact
--      "Member invite requires Connected" case:
--      `if p_role = 'member' and not public.current_club_has_capability
--      ('member_self_service') then raise exception
--      'capability_not_available'; end if;` — scoped here to `v_profile.
--      role = 'staff'` only (p_role is already forced to 'member' whenever
--      that holds, by change #2 immediately above), not to p_role='member'
--      unconditionally: Admin's existing behavior in this function — which
--      has never had an entitlement check — is deliberately left
--      unchanged, exactly as instructed. No new entitlement helper and no
--      new commercial architecture introduced.
--
-- Resulting behavior:
--   Admin  — unchanged (allowed for p_role in ('member', 'pro'), no
--            entitlement check, same as the untouched Production body).
--   Staff  — p_role='member' in a Connected club (member_self_service
--            enabled): allowed (new in this migration). p_role='member' in
--            a Staff-Managed club (member_self_service disabled): blocked,
--            'capability_not_available' (new in this migration).
--            p_role='pro': still blocked, 'insufficient_role' (change #2).
--   Pro    — unchanged; this function has never admitted role='pro' as a
--            caller and still does not.
--   Member — unchanged; this function has never admitted role='member' as
--            a caller and still does not.
--
-- Every other line — input normalisation, email format validation, the
-- advisory-lock serialisation, all three duplicate checks (existing
-- member/unclaimed roster/pending invite), the roster_members insert, both
-- audit_log writes, the club_invites insert with its fixed 7-day expiry,
-- and the return contract — reproduced verbatim from Production. No DROP:
-- this CREATE OR REPLACE targets the exact live function identity, whose
-- signature and return type are unchanged. REVOKE/GRANT reapplied
-- idempotently using the exact signature 0067 originally granted, for
-- parity with this migration's own sibling widenings in 0132 — the
-- function's authenticated-callable posture is unchanged either way.
--
-- Does not modify 0132 or 0133. Not applied by this checkpoint. Apply in
-- Supabase SQL Editor (cloud only).
-- ═══════════════════════════════════════════════════════════════════════════

begin;

CREATE OR REPLACE FUNCTION public.add_roster_member_and_invite(p_first_name text, p_last_name text, p_email text, p_role text DEFAULT 'member'::text, p_phone text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_profile    profiles%rowtype;
  v_first      text;
  v_last       text;
  v_email      text;
  v_phone      text;
  v_notes      text;
  v_dup_count  int;
  v_roster_id  uuid;
  v_invite_id  uuid;
  v_code       text;
begin
  -- 1. Auth / operator gate. Phase 34A4A: widened admin-only -> admin+staff.
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  -- 2. Role validation: only member/pro for invite-linked onboarding.
  if p_role not in ('member', 'pro') then
    raise exception 'invalid_role';
  end if;

  -- Phase 34A4A: a Staff caller may only invite an ordinary Member — never
  -- Pro. Mirrors add_roster_member's identical Staff restriction (0132).
  if v_profile.role = 'staff' and p_role <> 'member' then
    raise exception 'insufficient_role';
  end if;

  -- Phase 34A4A correction: a Staff caller may only invite a Member when
  -- the club has member_self_service enabled (Connected) — canonical
  -- entitlement check (current_club_has_capability, 0122), same helper and
  -- same exception create_club_invite (0131/0132) already uses for this
  -- exact case. Scoped to the Staff branch only — Admin's existing
  -- behavior in this function (no entitlement check) is unchanged.
  if v_profile.role = 'staff' and not public.current_club_has_capability('member_self_service') then
    raise exception 'capability_not_available';
  end if;

  -- 3. Normalise inputs (empty strings → null).
  v_first := nullif(btrim(p_first_name), '');
  v_last  := nullif(btrim(p_last_name), '');
  v_email := lower(nullif(btrim(coalesce(p_email, '')), ''));
  v_phone := nullif(btrim(coalesce(p_phone, '')), '');
  v_notes := nullif(btrim(coalesce(p_notes, '')), '');

  if v_first is null then raise exception 'first_name_required'; end if;
  if v_last  is null then raise exception 'last_name_required';  end if;
  if v_email is null then raise exception 'email_required';      end if;

  -- 4. Server-side email format validation.
  --    Rejects anything without a local part, @, domain, and TLD component.
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^\s]+$' then
    raise exception 'invalid_email_format';
  end if;

  -- 5. Serialise concurrent requests for the same (club, email) pair.
  --    pg_advisory_xact_lock holds until the transaction ends, so a second
  --    concurrent call for the same key blocks until the first commits, then
  --    sees the first call's rows in the duplicate checks below.
  perform pg_advisory_xact_lock(
    hashtext(v_profile.club_id::text || ':' || v_email)::bigint
  );

  -- 6. Duplicate checks — all must pass before any write.

  -- Not an existing active club member.
  select count(*) into v_dup_count
    from profiles p
    join auth.users u on u.id = p.id
   where p.club_id      = v_profile.club_id
     and lower(u.email) = v_email;
  if v_dup_count > 0 then raise exception 'email_already_a_member'; end if;

  -- No existing unclaimed roster entry with this email.
  select count(*) into v_dup_count
    from roster_members
   where club_id    = v_profile.club_id
     and lower(email) = v_email
     and claimed_by is null;
  if v_dup_count > 0 then raise exception 'email_already_on_roster'; end if;

  -- No active pending invite for this email.
  select count(*) into v_dup_count
    from club_invites
   where club_id     = v_profile.club_id
     and lower(email) = v_email
     and accepted_at  is null
     and revoked_at   is null
     and expires_at   > now();
  if v_dup_count > 0 then raise exception 'invite_already_pending'; end if;

  -- 7. Insert roster member.
  insert into roster_members (club_id, first_name, last_name, email, phone, role, notes, created_by)
  values (v_profile.club_id, v_first, v_last, v_email, v_phone, p_role, v_notes, auth.uid())
  returning id into v_roster_id;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'add_roster_member', 'roster_member', v_roster_id,
    jsonb_build_object(
      'first_name', v_first,
      'last_name',  v_last,
      'email',      v_email,
      'role',       p_role,
      'source',     'add_roster_member_and_invite'
    )
  );

  -- 8. Insert email-restricted invite with a fixed 7-day expiry.
  --    The expiry is always enforced by the RPC; callers cannot override it.
  insert into club_invites (club_id, role, email, created_by, expires_at)
  values (v_profile.club_id, p_role, v_email, auth.uid(), now() + interval '7 days')
  returning id, code into v_invite_id, v_code;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'create_invite', 'club_invite', v_invite_id,
    jsonb_build_object(
      'role',       p_role,
      'email',      v_email,
      'expires_at', now() + interval '7 days'
    )
  );

  return jsonb_build_object(
    'roster_member_id', v_roster_id,
    'code',             v_code
  );
end;
$function$;

revoke execute on function public.add_roster_member_and_invite(text, text, text, text, text, text) from public, anon;
grant  execute on function public.add_roster_member_and_invite(text, text, text, text, text, text) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- Restore by re-querying the live Production function definition
-- (pg_get_functiondef) immediately before rolling back — this migration's
-- own body was sourced the same way (supplied directly by the operator),
-- not from 0067 or any other migration file. No RLS policy, no other
-- function, and no table is touched by this migration — nothing else
-- requires rollback.
