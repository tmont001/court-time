-- 0040_notify_reservation_cancelled_by_member_rpc.sql
-- Phase 16B: security-definer RPC that inserts a reservation_cancelled_by_member
-- notification after a member self-cancels.
--
-- The notifications table has no INSERT policy for regular users, so all
-- notification inserts must go through security-definer functions.
-- This function is called from the cancelReservation server action in
-- my-schedule/page.tsx AFTER the reservation row has been set to 'cancelled'.
--
-- Guards:
--   - Caller must be authenticated.
--   - Reservation must exist, be owned by the caller, belong to their club,
--     and already have status = 'cancelled' (verifies the cancel succeeded).
-- Requires 0039_expand_notification_kinds.sql to be applied first.
-- Apply in Supabase SQL Editor (cloud only).

create or replace function notify_reservation_cancelled_by_member(
  p_reservation_id uuid
)
returns void
language plpgsql security definer as $$
declare
  v_profile profiles%rowtype;
  v_res     reservations%rowtype;
  v_tz      text;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  -- Verify the reservation belongs to the caller, is in their club, and is
  -- already cancelled. Checking status = 'cancelled' ensures the server action's
  -- update succeeded before we record the notification.
  select * into v_res
    from reservations
    where id            = p_reservation_id
      and owner_user_id = auth.uid()
      and club_id       = v_profile.club_id
      and status        = 'cancelled';
  if not found then raise exception 'reservation_not_found'; end if;

  select timezone into v_tz from clubs where id = v_profile.club_id;

  insert into notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'reservation_cancelled_by_member',
    'Your reservation on '
      || to_char(v_res.starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM')
      || ' was cancelled.',
    jsonb_build_object('reservation_id', p_reservation_id)
  );
end;
$$;
