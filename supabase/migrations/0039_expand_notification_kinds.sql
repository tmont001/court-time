-- 0039_expand_notification_kinds.sql
-- Phase 16B+C: expand notifications.kind check constraint to include
--   'reservation_cancelled_by_member' (16B) and 'announcement' (16C).
-- Uses the same dynamic-constraint-drop pattern as 0014_waitlist_schema.sql.
-- Apply in Supabase SQL Editor (cloud only) before deploying Phase 16B code.

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
    'announcement'
  ));
