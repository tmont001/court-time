-- 0019_notification_deliveries.sql
-- Phase 8C: notification_deliveries table for tracking external delivery attempts.
-- Channel-neutral: supports 'sms' now, 'email' later without schema changes.
-- No INSERT policy — writes come through record_delivery_attempt RPC in Phase 8D.
-- Apply in Supabase SQL Editor (cloud only).

-- ---------------------------------------------------------------------------
-- notification_deliveries
-- ---------------------------------------------------------------------------
create table notification_deliveries (
  id                  uuid        primary key default uuid_generate_v4(),
  notification_id     uuid        not null references notifications(id) on delete cascade,
  club_id             uuid        not null references clubs(id) on delete cascade,
  channel             text        not null check (channel in ('sms', 'email')),
  status              text        not null check (status in ('sent', 'failed', 'opted_out', 'no_phone')),
  provider            text,
  provider_message_id text,
  error               text,
  created_at          timestamptz not null default now(),
  sent_at             timestamptz
);

create index nd_notification_idx on notification_deliveries (notification_id);
create index nd_club_created_idx  on notification_deliveries (club_id, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table notification_deliveries enable row level security;

-- Admins may read delivery records for their own club only.
-- No INSERT/UPDATE/DELETE policies — all writes go through record_delivery_attempt RPC.
create policy "admin_select"
  on notification_deliveries for select
  using (
    club_id = (select club_id from profiles where id = auth.uid())
    and (select role from profiles where id = auth.uid()) = 'admin'
  );
