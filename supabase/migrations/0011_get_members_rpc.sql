-- 0011_get_members_rpc.sql
-- Phase 6B: security definer function returning club members with email.
-- Joins auth.users (inaccessible to the anon/authenticated role directly)
-- so that admins can see member emails without exposing auth.users to RLS.
-- Apply in Supabase SQL Editor (cloud only).

create or replace function get_members()
returns table (
  id         uuid,
  first_name text,
  last_name  text,
  phone      text,
  role       text,
  status     text,
  created_at timestamptz,
  email      text
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
      p.id,
      p.first_name,
      p.last_name,
      p.phone,
      p.role,
      p.status,
      p.created_at,
      u.email::text
    from profiles p
    join auth.users u on u.id = p.id
    where p.club_id = v_profile.club_id
    order by p.last_name asc nulls last, p.first_name asc nulls last;
end;
$$;
