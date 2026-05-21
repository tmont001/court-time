-- 0032_invite_rpcs.sql
-- Phase 12B: invite system RPCs.
-- All functions are security definer so authorization logic lives in SQL,
-- not in client code.
-- Apply in Supabase SQL Editor (cloud only).

-- ---------------------------------------------------------------------------
-- validate_club_invite
-- Safe for unauthenticated callers. Returns only public-safe fields:
-- valid, reason, club_name, role, email (null if unrestricted).
-- Never exposes internal IDs, invite creator, or member data.
-- ---------------------------------------------------------------------------
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
    'valid',     true,
    'club_name', v_club_name,
    'role',      v_invite.role,
    'email',     v_invite.email
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- accept_club_invite
-- Requires an authenticated caller. Atomically validates the invite,
-- assigns club_id + role to the caller's profile, and marks the invite used.
-- FOR UPDATE prevents a race between two simultaneous accept calls.
-- Only works when profiles.club_id is null (enforced in migration 0033+).
-- ---------------------------------------------------------------------------
create or replace function accept_club_invite(p_code text)
returns jsonb
language plpgsql security definer as $$
declare
  v_invite     club_invites%rowtype;
  v_profile    profiles%rowtype;
  v_club       clubs%rowtype;
  v_auth_email text;
begin
  -- Require authenticated caller.
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  -- Caller must not already belong to a club.
  if v_profile.club_id is not null then raise exception 'already_in_club'; end if;

  -- Lock the invite row to prevent concurrent accepts.
  select * into v_invite
    from club_invites
   where code = p_code
   for update;

  if not found                        then raise exception 'invalid_invite';  end if;
  if v_invite.revoked_at  is not null then raise exception 'invite_revoked';  end if;
  if v_invite.accepted_at is not null then raise exception 'invite_used';     end if;
  if v_invite.expires_at < now()      then raise exception 'invite_expired';  end if;

  -- Email restriction: compare inside security definer so auth.users is accessible.
  if v_invite.email is not null then
    select email into v_auth_email from auth.users where id = auth.uid();
    if lower(v_auth_email) <> lower(v_invite.email) then
      raise exception 'email_mismatch';
    end if;
  end if;

  -- Assign club and role.
  update profiles
     set club_id = v_invite.club_id,
         role    = v_invite.role
   where id = auth.uid();

  -- Mark invite accepted.
  update club_invites
     set accepted_at = now(),
         accepted_by = auth.uid()
   where id = v_invite.id;

  -- Fetch club name for the response.
  select * into v_club from clubs where id = v_invite.club_id;

  -- Audit.
  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_invite.club_id,
    auth.uid(),
    'accept_invite',
    'profile',
    auth.uid(),
    jsonb_build_object('role', v_invite.role, 'invite_id', v_invite.id)
  );

  return jsonb_build_object(
    'club_id',   v_invite.club_id,
    'role',      v_invite.role,
    'club_name', v_club.name
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- create_club_invite
-- Admin only. Scoped to the calling admin's club.
-- Returns the generated 32-character code so the caller can build the link.
-- ---------------------------------------------------------------------------
create or replace function create_club_invite(
  p_role       text        default 'member',
  p_email      text        default null,
  p_expires_at timestamptz default now() + interval '7 days'
)
returns text
language plpgsql security definer as $$
declare
  v_profile   profiles%rowtype;
  v_invite_id uuid;
  v_code      text;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  if p_role not in ('member', 'pro', 'admin') then
    raise exception 'invalid_role';
  end if;

  insert into club_invites (club_id, role, email, created_by, expires_at)
  values (
    v_profile.club_id,
    p_role,
    nullif(trim(coalesce(p_email, '')), ''),
    auth.uid(),
    p_expires_at
  )
  returning id, code into v_invite_id, v_code;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'create_invite',
    'club_invite',
    v_invite_id,
    jsonb_build_object('role', p_role, 'email', p_email, 'expires_at', p_expires_at)
  );

  return v_code;
end;
$$;

-- ---------------------------------------------------------------------------
-- revoke_club_invite
-- Admin only. Scoped to the calling admin's club.
-- Soft-revokes by setting revoked_at. Cannot revoke an already-accepted invite.
-- ---------------------------------------------------------------------------
create or replace function revoke_club_invite(p_code text)
returns void
language plpgsql security definer as $$
declare
  v_profile profiles%rowtype;
  v_invite  club_invites%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  select * into v_invite
    from club_invites
   where code = p_code
     and club_id = v_profile.club_id;

  if not found                        then raise exception 'invalid_invite';          end if;
  if v_invite.accepted_at is not null then raise exception 'invite_already_accepted'; end if;
  if v_invite.revoked_at  is not null then raise exception 'invite_already_revoked';  end if;

  update club_invites
     set revoked_at = now()
   where id = v_invite.id;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'revoke_invite',
    'club_invite',
    v_invite.id,
    jsonb_build_object('role', v_invite.role, 'email', v_invite.email)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- get_club_invites
-- Admin only. Returns all invites for the calling admin's club, newest first.
-- Includes the code so the client can reconstruct the shareable link.
-- ---------------------------------------------------------------------------
create or replace function get_club_invites()
returns table (
  id          uuid,
  code        text,
  role        text,
  email       text,
  expires_at  timestamptz,
  accepted_at timestamptz,
  accepted_by uuid,
  revoked_at  timestamptz,
  created_at  timestamptz
)
language plpgsql security definer as $$
declare
  v_profile profiles%rowtype;
begin
  select p.* into v_profile from profiles p where p.id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  return query
    select
      ci.id,
      ci.code,
      ci.role,
      ci.email,
      ci.expires_at,
      ci.accepted_at,
      ci.accepted_by,
      ci.revoked_at,
      ci.created_at
    from club_invites ci
   where ci.club_id = v_profile.club_id
   order by ci.created_at desc;
end;
$$;
