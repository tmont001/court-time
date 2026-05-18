-- 0005_audit_log.sql
-- Phase 4B: audit_log table for admin action tracking.
-- All writes are via security definer RPCs in later checkpoints.
-- No direct insert/update/delete policies are created here.
-- Apply in Supabase SQL Editor (cloud only).

-- ---------------------------------------------------------------------------
-- audit_log
-- ---------------------------------------------------------------------------
create table audit_log (
  id          uuid        primary key default uuid_generate_v4(),
  club_id     uuid        not null references clubs(id) on delete cascade,
  actor_id    uuid        not null references profiles(id),
  action      text        not null,
  target_type text        not null,
  target_id   uuid        not null,
  metadata    jsonb,
  created_at  timestamptz not null default now()
);

create index audit_log_club_created_idx
  on audit_log (club_id, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table audit_log enable row level security;

-- Admin-only SELECT. No member or pro access.
-- All writes come from security definer RPCs that bypass RLS.
create policy "audit_log_select_admin"
  on audit_log for select
  using (
    club_id = current_user_club_id()
    and current_user_role() = 'admin'
  );
