-- 0056_roster_members.sql
-- Phase 21I-A: roster_members table for offline/unclaimed club members.
-- Admins can create member records without requiring a Supabase Auth account.
-- profiles.id remains FK to auth.users(id) — this migration is additive only.
-- Apply in Supabase SQL Editor (cloud only).

-- ═══════════════════════════════════════════════════════════════════════════
-- Table
-- ═══════════════════════════════════════════════════════════════════════════

create table roster_members (
  id          uuid        primary key default gen_random_uuid(),
  club_id     uuid        not null references clubs(id) on delete cascade,
  first_name  text        not null,
  last_name   text        not null,
  email       text,
  phone       text,
  role        text        not null default 'member'
                            check (role in ('member', 'pro', 'admin')),
  notes       text,
  claimed_by  uuid        unique references auth.users(id) on delete set null,
  created_by  uuid        not null references auth.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- role is display/intent only — it does NOT grant app permissions.
-- Actual access control always comes from profiles.role after the member
-- creates an account and claims this roster entry via accept_club_invite().
comment on column roster_members.role is
  'Display/intent only — does not grant app permissions. See profiles.role.';

create trigger roster_members_updated_at
  before update on roster_members
  for each row execute function trigger_set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- Indexes
-- ═══════════════════════════════════════════════════════════════════════════

-- Prevent duplicate emails within a club (case-insensitive, non-null only).
create unique index roster_members_club_email_uniq
  on roster_members (club_id, lower(email))
  where email is not null;

-- Fast lookup by club for get_roster_members.
create index roster_members_club_id_idx
  on roster_members (club_id);

-- Fast lookup by claimed_by for auto-link dedup.
create index roster_members_claimed_by_idx
  on roster_members (claimed_by)
  where claimed_by is not null;

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS — admin-only, same-club scoped
-- ═══════════════════════════════════════════════════════════════════════════

alter table roster_members enable row level security;

create policy "roster_members_select_admin"
  on roster_members for select
  using (
    club_id = current_user_club_id()
    and current_user_role() = 'admin'
  );

create policy "roster_members_insert_admin"
  on roster_members for insert
  with check (
    club_id = current_user_club_id()
    and current_user_role() = 'admin'
  );

create policy "roster_members_update_admin"
  on roster_members for update
  using (
    club_id = current_user_club_id()
    and current_user_role() = 'admin'
  )
  with check (
    club_id = current_user_club_id()
  );

create policy "roster_members_delete_admin"
  on roster_members for delete
  using (
    club_id = current_user_club_id()
    and current_user_role() = 'admin'
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- RPCs
-- ═══════════════════════════════════════════════════════════════════════════

-- ---------------------------------------------------------------------------
-- get_roster_members
-- Admin only. Returns unclaimed roster members for the caller's club.
-- ---------------------------------------------------------------------------
create or replace function get_roster_members()
returns table (
  id         uuid,
  first_name text,
  last_name  text,
  email      text,
  phone      text,
  role       text,
  notes      text,
  created_by uuid,
  created_at timestamptz
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
      rm.id,
      rm.first_name,
      rm.last_name,
      rm.email,
      rm.phone,
      rm.role,
      rm.notes,
      rm.created_by,
      rm.created_at
    from roster_members rm
    where rm.club_id    = v_profile.club_id
      and rm.claimed_by is null
    order by rm.last_name asc nulls last, rm.first_name asc nulls last;
end;
$$;

-- ---------------------------------------------------------------------------
-- add_roster_member
-- Admin only. Creates a roster member record.
-- Validates required fields, normalizes whitespace, checks email duplicates
-- against both roster_members and profiles (via auth.users).
-- Returns the new roster_member id.
-- ---------------------------------------------------------------------------
create or replace function add_roster_member(
  p_first_name text,
  p_last_name  text,
  p_email      text    default null,
  p_phone      text    default null,
  p_role       text    default 'member',
  p_notes      text    default null
)
returns uuid
language plpgsql security definer as $$
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
  if p_role not in ('member', 'pro', 'admin') then
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

-- ---------------------------------------------------------------------------
-- update_roster_member
-- Admin only. Updates an unclaimed roster member in the caller's club.
-- Validates names, checks email duplicates if email changed.
-- ---------------------------------------------------------------------------
create or replace function update_roster_member(
  p_id         uuid,
  p_first_name text,
  p_last_name  text,
  p_email      text    default null,
  p_phone      text    default null,
  p_role       text    default 'member',
  p_notes      text    default null
)
returns void
language plpgsql security definer as $$
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
  if p_role not in ('member', 'pro', 'admin') then
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

-- ---------------------------------------------------------------------------
-- delete_roster_member
-- Admin only. Deletes an unclaimed roster member from the caller's club.
-- Blocks deletion of claimed entries.
-- ---------------------------------------------------------------------------
create or replace function delete_roster_member(p_id uuid)
returns void
language plpgsql security definer as $$
declare
  v_profile profiles%rowtype;
  v_roster  roster_members%rowtype;
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

  -- 3. Cannot delete a claimed entry.
  if v_roster.claimed_by is not null then
    raise exception 'roster_member_already_claimed';
  end if;

  -- 4. Delete.
  delete from roster_members where id = p_id;

  -- 5. Audit.
  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'delete_roster_member',
    'roster_member',
    p_id,
    jsonb_build_object(
      'first_name', v_roster.first_name,
      'last_name',  v_roster.last_name,
      'email',      v_roster.email
    )
  );
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Modify accept_club_invite — auto-link roster member on claim
-- ═══════════════════════════════════════════════════════════════════════════
-- CREATE OR REPLACE preserves the existing function signature.
-- The only addition is the roster_members auto-link block after the
-- existing audit log entry, before the return.

create or replace function accept_club_invite(p_code text)
returns jsonb
language plpgsql security definer as $$
declare
  v_invite       club_invites%rowtype;
  v_profile      profiles%rowtype;
  v_club         clubs%rowtype;
  v_auth_email   text;
  -- Phase 21I-A: roster member auto-link
  v_roster_id    uuid;
  v_roster_phone text;
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

  -- Phase 21I-A: auto-link matching roster member.
  -- If an unclaimed roster_members row exists in the same club with a
  -- matching email, link it to this user. Non-matching or missing roster
  -- entries are silently ignored — normal invite acceptance is unaffected.
  if v_auth_email is null then
    select email into v_auth_email from auth.users where id = auth.uid();
  end if;

  if v_auth_email is not null then
    select rm.id, rm.phone
      into v_roster_id, v_roster_phone
      from roster_members rm
     where rm.club_id      = v_invite.club_id
       and lower(rm.email)  = lower(v_auth_email)
       and rm.claimed_by   is null
     limit 1
     for update;

    if v_roster_id is not null then
      update roster_members
         set claimed_by = auth.uid(),
             updated_at = now()
       where id = v_roster_id;

      -- Copy phone from roster to profile if profile has no phone.
      if v_roster_phone is not null and v_profile.phone is null then
        update profiles
           set phone      = v_roster_phone,
               updated_at = now()
         where id = auth.uid();
      end if;

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
