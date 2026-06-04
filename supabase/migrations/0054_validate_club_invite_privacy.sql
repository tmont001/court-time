-- 0054_validate_club_invite_privacy.sql
-- Phase 20D-C: remove restricted invite email from anonymous validate_club_invite response.
--
-- Previously, validate_club_invite returned the stored restricted email address
-- ('email': value or null) to unauthenticated callers. Although the function is
-- scoped to public-safe fields, returning the actual email allows anyone holding the
-- invite link to discover the invited address — a privacy exposure that is not
-- required by any UI workflow.
--
-- This migration changes the valid-invite response to return only a boolean indicator:
--   'email_restricted': true  — invite is restricted to one specific email address
--   'email_restricted': false — invite is unrestricted (any account may accept)
--
-- The actual email comparison for restricted invites remains exclusively in
-- accept_club_invite (migration 0032), which runs inside a security definer context
-- with direct access to auth.users. That function and its enforcement are unchanged.
--
-- No schema changes. No data changes. No RLS changes. Idempotent.
-- Apply in Supabase SQL Editor (cloud only) before deploying 20D-C UI changes.

create or replace function validate_club_invite(p_code text)
returns jsonb
language plpgsql security definer as $$
declare
  v_invite    club_invites%rowtype;
  v_club_name text;
begin
  select *
    into v_invite
    from club_invites
   where code = p_code;

  if not found then
    return jsonb_build_object('valid', false, 'reason', 'not_found');
  end if;

  select name
    into v_club_name
    from clubs
   where id = v_invite.club_id;

  if v_invite.revoked_at is not null then
    return jsonb_build_object('valid', false, 'reason', 'revoked');
  end if;

  if v_invite.accepted_at is not null then
    return jsonb_build_object('valid', false, 'reason', 'used');
  end if;

  if v_invite.expires_at < now() then
    return jsonb_build_object('valid', false, 'reason', 'expired');
  end if;

  return jsonb_build_object(
    'valid',            true,
    'club_name',        v_club_name,
    'role',             v_invite.role,
    'email_restricted', v_invite.email is not null
  );
end;
$$;
