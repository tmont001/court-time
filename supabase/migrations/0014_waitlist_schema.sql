-- 0014_waitlist_schema.sql
-- Phase 7A: extend status/kind check constraints for waitlist support.
-- No new tables, columns, or RPCs. Existing rows are unaffected.
-- Safe to apply once in Supabase SQL Editor.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1.  event_participants.status  →  add 'waitlisted'
-- ─────────────────────────────────────────────────────────────────────────────
-- Locate the inline check constraint that references the status column,
-- then drop and recreate it with the expanded value list.

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
  check (status in ('confirmed', 'cancelled', 'waitlisted'));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2.  notifications.kind  →  add 'waitlist_promoted'
-- ─────────────────────────────────────────────────────────────────────────────

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
    'event_cancelled',
    'event_joined',
    'waitlist_promoted'
  ));
