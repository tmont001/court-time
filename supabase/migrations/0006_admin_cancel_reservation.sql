-- 0006_admin_cancel_reservation.sql
-- Phase 4C: admin_cancel_reservation RPC.
-- Admin only. Cancels any confirmed/pending reservation in the same club.
-- Writes to audit_log (created in 0005_audit_log.sql).
-- Apply in Supabase SQL Editor (cloud only).

create or replace function admin_cancel_reservation(p_reservation_id uuid)
returns reservations
language plpgsql security definer as $$
declare
  v_profile profiles%rowtype;
  v_res     reservations%rowtype;
  v_result  reservations%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  -- Admin only — pro is excluded.
  if v_profile.role <> 'admin' then
    raise exception 'insufficient_role';
  end if;

  select * into v_res
    from reservations
    where id      = p_reservation_id
      and club_id = v_profile.club_id
      and status in ('pending', 'confirmed');
  if not found then raise exception 'reservation_not_found'; end if;

  update reservations set
    status            = 'cancelled',
    cancelled_at      = now(),
    cancelled_by      = auth.uid(),
    cancellation_kind = 'admin',
    updated_at        = now()
  where id = p_reservation_id
  returning * into v_result;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'admin_cancel_reservation',
    'reservation',
    p_reservation_id,
    jsonb_build_object(
      'court_id',      v_res.court_id,
      'owner_user_id', v_res.owner_user_id,
      'starts_at',     v_res.starts_at,
      'reason',        v_res.reason
    )
  );

  return v_result;
end;
$$;
