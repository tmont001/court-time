-- 0020_record_delivery_attempt_rpc.sql
-- Phase 8D: record_delivery_attempt RPC for writing notification_deliveries rows.
-- Security definer; enforces club isolation so no service role is needed in
-- server actions. Called after each SMS (or future email) send attempt.
-- Requires 0019_notification_deliveries.sql first.
-- Apply in Supabase SQL Editor (cloud only).

-- ---------------------------------------------------------------------------
-- record_delivery_attempt
-- Authenticated user only. Inserts one row into notification_deliveries.
-- Verifies the target notification belongs to the caller's club before inserting.
-- Returns the new delivery row id.
-- ---------------------------------------------------------------------------
create or replace function record_delivery_attempt(
  p_notification_id     uuid,
  p_channel             text,
  p_status              text,
  p_provider            text        default null,
  p_provider_message_id text        default null,
  p_error               text        default null,
  p_sent_at             timestamptz default null
)
returns uuid
language plpgsql security definer as $$
declare
  v_caller_club_id uuid;
  v_notif_club_id  uuid;
  v_delivery_id    uuid;
begin
  select club_id into v_caller_club_id from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  select club_id into v_notif_club_id from notifications where id = p_notification_id;
  if not found then raise exception 'notification_not_found'; end if;

  if v_notif_club_id <> v_caller_club_id then
    raise exception 'club_mismatch';
  end if;

  if p_channel not in ('sms', 'email') then
    raise exception 'invalid_channel';
  end if;

  if p_status not in ('sent', 'failed', 'opted_out', 'no_phone') then
    raise exception 'invalid_status';
  end if;

  insert into notification_deliveries
    (notification_id, club_id, channel, status, provider, provider_message_id, error, sent_at)
  values
    (p_notification_id, v_caller_club_id, p_channel, p_status, p_provider, p_provider_message_id, p_error, p_sent_at)
  returning id into v_delivery_id;

  return v_delivery_id;
end;
$$;
