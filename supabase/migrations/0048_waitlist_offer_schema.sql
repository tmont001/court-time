-- 0048_waitlist_offer_schema.sql
-- Phase 18A: schema additions for the waitlist offer/confirmation flow.
-- Adds 'offered' status, offer_expires_at column, per-club offer window
-- setting, and 'waitlist_offer' notification kind.
-- No new tables. No backfill beyond defaults.
-- Uses the same dynamic constraint-drop pattern as 0014 and 0039.
-- Apply in Supabase SQL Editor (cloud only) before 0049_waitlist_offer_rpcs.sql.

-- ---------------------------------------------------------------------------
-- 1.  event_participants.status  →  add 'offered'
-- ---------------------------------------------------------------------------
do $$
declare
  v_con text;
begin
  select c.conname into v_con
  from   pg_constraint c
  join   pg_class      t on t.oid = c.conrelid
  join   pg_attribute  a on a.attrelid = t.oid
                        and a.attnum   = any(c.conkey)
  where  t.relname = 'event_participants'
    and  c.contype = 'c'
    and  a.attname = 'status'
  limit 1;

  if v_con is not null then
    execute format('alter table event_participants drop constraint %I', v_con);
  end if;
end $$;

alter table event_participants
  add constraint event_participants_status_check
  check (status in ('confirmed', 'cancelled', 'waitlisted', 'offered'));

-- ---------------------------------------------------------------------------
-- 2.  event_participants.offer_expires_at
--     Nullable timestamptz. Set when status transitions to 'offered'.
--     Cleared (null) when transitioning away from 'offered'.
--     No default — existing rows are unaffected.
-- ---------------------------------------------------------------------------
alter table event_participants
  add column if not exists offer_expires_at timestamptz;

-- ---------------------------------------------------------------------------
-- 3.  club_settings.waitlist_offer_window_hours
--     How long (in hours) a waitlisted member has to accept a spot offer.
--     Default 2. Valid range enforced by update_club_settings RPC (1–72).
-- ---------------------------------------------------------------------------
alter table club_settings
  add column if not exists waitlist_offer_window_hours int not null default 2;

-- ---------------------------------------------------------------------------
-- 4.  notifications.kind  →  add 'waitlist_offer'
--     'waitlist_offer' is mandatory (like 'event_cancelled' and
--     'waitlist_promoted') — never gated by user_pref_enabled.
-- ---------------------------------------------------------------------------
do $$
declare
  v_con text;
begin
  select c.conname into v_con
  from   pg_constraint c
  join   pg_class      t on t.oid = c.conrelid
  join   pg_attribute  a on a.attrelid = t.oid
                        and a.attnum   = any(c.conkey)
  where  t.relname = 'notifications'
    and  c.contype = 'c'
    and  a.attname = 'kind'
  limit 1;

  if v_con is not null then
    execute format('alter table notifications drop constraint %I', v_con);
  end if;
end $$;

alter table notifications
  add constraint notifications_kind_check
  check (kind in (
    'reservation_confirmed',
    'reservation_cancelled_by_admin',
    'reservation_cancelled_by_member',
    'event_cancelled',
    'event_joined',
    'waitlist_promoted',
    'waitlist_offer',
    'announcement'
  ));
