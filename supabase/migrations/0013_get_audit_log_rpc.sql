-- 0013_get_audit_log_rpc.sql
-- Phase 6D: paginated audit log viewer for admins.
-- Joins profiles to surface actor display name instead of raw UUID.
-- Apply in Supabase SQL Editor (cloud only).

create or replace function get_audit_log(
  p_limit  int default 50,
  p_offset int default 0
)
returns table (
  id          uuid,
  actor_name  text,
  action      text,
  target_type text,
  target_id   uuid,
  metadata    jsonb,
  created_at  timestamptz
)
language plpgsql security definer as $$
declare
  v_profile profiles%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  return query
    select
      al.id          as id,
      coalesce(nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), 'Unknown')::text
                     as actor_name,
      al.action      as action,
      al.target_type as target_type,
      al.target_id   as target_id,
      al.metadata    as metadata,
      al.created_at  as created_at
    from audit_log al
    left join profiles p on p.id = al.actor_id
    where al.club_id = v_profile.club_id
    order by al.created_at desc
    limit p_limit offset p_offset;
end;
$$;
