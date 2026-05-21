-- 0031_club_invites.sql
-- Phase 12B: invite system table.
-- Clubs invite members, pros, and admins via a shareable token link.
-- Tokens are generated using gen_random_uuid() — no pgcrypto required.
-- Apply in Supabase SQL Editor (cloud only).

-- ---------------------------------------------------------------------------
-- club_invites
-- ---------------------------------------------------------------------------
create table club_invites (
  id           uuid        primary key default gen_random_uuid(),
  club_id      uuid        not null references clubs(id) on delete cascade,
  code         text        not null unique
                             default replace(gen_random_uuid()::text, '-', ''),
  role         text        not null default 'member'
                             check (role in ('member', 'pro', 'admin')),
  email        text,                    -- null = any email may accept
  created_by   uuid        not null references auth.users(id),
  expires_at   timestamptz not null default now() + interval '7 days',
  accepted_at  timestamptz,
  accepted_by  uuid        references auth.users(id),
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table club_invites enable row level security;

-- Admins of the same club can read their club's invites.
create policy "club_invites_select_admin"
  on club_invites for select
  using (
    club_id = current_user_club_id()
    and current_user_role() = 'admin'
  );

-- Admins can create invites scoped to their own club.
create policy "club_invites_insert_admin"
  on club_invites for insert
  with check (
    club_id = current_user_club_id()
    and current_user_role() = 'admin'
  );

-- Admins can revoke (update) invites for their own club only.
-- No delete policy — invites are soft-revoked to preserve the audit trail.
create policy "club_invites_update_admin"
  on club_invites for update
  using (
    club_id = current_user_club_id()
    and current_user_role() = 'admin'
  );
