-- 0041_send_announcement_rpc.sql
-- Phase 16C: send_announcement(p_title text, p_body text) security-definer RPC.
-- Admin only. Bulk-inserts 'announcement' notifications for all active members
-- of the calling admin's club (sender excluded). Writes one audit_log row.
-- Returns the number of members notified as an integer.
-- Requires 0039_expand_notification_kinds.sql to be applied first.
-- Apply in Supabase SQL Editor (cloud only).

create or replace function send_announcement(
  p_title text,
  p_body  text
)
returns integer
language plpgsql security definer as $$
declare
  v_profile        profiles%rowtype;
  v_recipient_count integer;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.role <> 'admin' then
    raise exception 'insufficient_role';
  end if;

  -- Validate: both fields required; title ≤ 100 chars; body ≤ 500 chars.
  if trim(p_title) = '' or trim(p_body) = '' then
    raise exception 'invalid_announcement';
  end if;
  if length(trim(p_title)) > 100 or length(trim(p_body)) > 500 then
    raise exception 'invalid_announcement';
  end if;

  -- Count eligible recipients before inserting.
  select count(*) into v_recipient_count
    from profiles
    where club_id = v_profile.club_id
      and status  = 'active'
      and id      <> auth.uid();

  -- Bulk-insert announcement notifications for all active members in the club,
  -- excluding the sender. kind = 'announcement' (added in migration 0039).
  insert into notifications (club_id, user_id, kind, body, metadata)
  select
    v_profile.club_id,
    p.id,
    'announcement',
    trim(p_body),
    jsonb_build_object(
      'title',     trim(p_title),
      'sender_id', auth.uid()
    )
  from profiles p
  where p.club_id = v_profile.club_id
    and p.status  = 'active'
    and p.id      <> auth.uid();

  -- Audit log.
  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'send_announcement',
    'club',
    v_profile.club_id,
    jsonb_build_object(
      'title',           trim(p_title),
      'recipient_count', v_recipient_count
    )
  );

  return v_recipient_count;
end;
$$;
