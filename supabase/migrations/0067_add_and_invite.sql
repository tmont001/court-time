-- 0067_add_and_invite.sql
-- Phase 22B: unified onboarding and security hardening.
--
-- 1. add_roster_member_and_invite — atomically creates a roster_members row and
--    an email-restricted club_invites row. Expiry is always 7 days from the call
--    time; callers cannot supply a custom expiry. Email format is validated
--    server-side. A transaction-level advisory lock on (club_id, email) serialises
--    concurrent requests so duplicate-check + insert is atomic under concurrency.
--
-- 2. accept_club_invite (updated) — copies first_name, last_name, and phone from
--    the claimed roster entry into the profile when those fields are NULL or blank
--    after trimming. Allows /welcome to be skipped when the admin already entered
--    the member's name.
--
-- Security: both functions use SECURITY DEFINER with a fixed search_path. EXECUTE
-- is revoked from PUBLIC and anon and granted only to authenticated.
--
-- Safe to re-apply: CREATE OR REPLACE + idempotent REVOKE/GRANT.
-- Apply in Supabase SQL Editor (cloud only).


-- ─── 1. add_roster_member_and_invite ─────────────────────────────────────────
-- Admin only. Club is derived from the authenticated admin's profile — never
-- trusted from the caller.
--
-- All validation and duplicate checks run before any INSERT so a failed call
-- leaves no partial state. Returns JSONB {roster_member_id uuid, code text}.

create or replace function public.add_roster_member_and_invite(
  p_first_name text,
  p_last_name  text,
  p_email      text,
  p_role       text default 'member',
  p_phone      text default null,
  p_notes      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  -- 1. Auth / admin gate.
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  -- 2. Role validation: only member/pro for invite-linked onboarding.
  if p_role not in ('member', 'pro') then
    raise exception 'invalid_role';
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
$$;

revoke execute on function public.add_roster_member_and_invite(text, text, text, text, text, text) from public, anon;
grant  execute on function public.add_roster_member_and_invite(text, text, text, text, text, text) to authenticated;


-- ─── 2. accept_club_invite (updated) ─────────────────────────────────────────
-- All validation, email restriction, role assignment, and audit logging are
-- unchanged from migration 0056.
--
-- Extended roster-claim block: first_name, last_name, and phone are now copied
-- when the profile field is NULL or blank after trimming (btrim = ''). This
-- means an admin-entered name is used even if the profile was previously written
-- with an empty string rather than NULL.

create or replace function public.accept_club_invite(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite        club_invites%rowtype;
  v_profile       profiles%rowtype;
  v_club          clubs%rowtype;
  v_auth_email    text;
  -- Roster auto-link fields
  v_roster_id     uuid;
  v_roster_first  text;
  v_roster_last   text;
  v_roster_phone  text;
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

  -- Assign club and role to the caller's profile.
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

  -- Audit: invite accepted.
  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_invite.club_id,
    auth.uid(),
    'accept_invite',
    'profile',
    auth.uid(),
    jsonb_build_object('role', v_invite.role, 'invite_id', v_invite.id)
  );

  -- Auto-link matching roster member by email (case-insensitive).
  -- Fetch auth email if not already retrieved (unrestricted invite path).
  if v_auth_email is null then
    select email into v_auth_email from auth.users where id = auth.uid();
  end if;

  if v_auth_email is not null then
    select rm.id, rm.first_name, rm.last_name, rm.phone
      into v_roster_id, v_roster_first, v_roster_last, v_roster_phone
      from roster_members rm
     where rm.club_id     = v_invite.club_id
       and lower(rm.email) = lower(v_auth_email)
       and rm.claimed_by  is null
     limit 1
     for update;

    if v_roster_id is not null then
      -- Mark the roster entry claimed.
      update roster_members
         set claimed_by = auth.uid(),
             updated_at = now()
       where id = v_roster_id;

      -- Copy first_name, last_name, and phone into the profile when those
      -- fields are NULL or blank (empty/whitespace-only). Never overwrites a
      -- meaningful existing value the member has already entered.
      update profiles
         set first_name = case when btrim(coalesce(first_name, '')) = '' then v_roster_first else first_name end,
             last_name  = case when btrim(coalesce(last_name,  '')) = '' then v_roster_last  else last_name  end,
             phone      = case when btrim(coalesce(phone,      '')) = '' then v_roster_phone else phone      end,
             updated_at = now()
       where id = auth.uid();

      -- Audit: roster claimed.
      insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
      values (
        v_invite.club_id,
        auth.uid(),
        'claim_roster_member',
        'roster_member',
        v_roster_id,
        jsonb_build_object('invite_id', v_invite.id)
      );
    end if;
  end if;

  return jsonb_build_object(
    'club_id',   v_invite.club_id,
    'role',      v_invite.role,
    'club_name', v_club.name
  );
end;
$$;

revoke execute on function public.accept_club_invite(text) from public, anon;
grant  execute on function public.accept_club_invite(text) to authenticated;
