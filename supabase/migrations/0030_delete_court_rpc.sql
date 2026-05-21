-- 0030_delete_court_rpc.sql
-- Phase 11 polish: safe court deletion for courts with no history.
-- Courts with any reservation history (bookings, maintenance, admin blocks,
-- or events) are rejected. Event-court links live in reservations with
-- reason = 'event' — there is no separate event_courts table.
-- Apply in Supabase SQL Editor (cloud only).

create or replace function delete_court(p_court_id uuid)
returns void
language plpgsql security definer as $$
declare
  v_profile profiles%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  if not exists (
    select 1 from courts
    where id = p_court_id and club_id = v_profile.club_id
  ) then
    raise exception 'invalid_court';
  end if;

  -- Reservations covers all history: member bookings, maintenance blocks,
  -- admin blocks, and events (reason = 'event').
  if exists (select 1 from reservations where court_id = p_court_id) then
    raise exception 'court_has_history';
  end if;

  delete from courts where id = p_court_id;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'delete_court', 'court', p_court_id,
    jsonb_build_object('court_id', p_court_id)
  );
end;
$$;
