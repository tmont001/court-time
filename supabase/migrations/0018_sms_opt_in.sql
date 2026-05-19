-- 0018_sms_opt_in.sql
-- Phase 8A: SMS consent columns on profiles and update_sms_preference RPC.
-- Provides the foundation for SMS opt-in without any delivery infrastructure.
-- No Twilio, no notification_deliveries table — those come in later checkpoints.
-- Apply in Supabase SQL Editor (cloud only).

-- ---------------------------------------------------------------------------
-- profiles — add SMS consent columns
-- ---------------------------------------------------------------------------
-- sms_opt_in: explicit user consent flag. Defaults to false; never pre-checked.
-- sms_opted_in_at: timestamp of the most recent opt-in action (cleared on opt-out).
-- sms_opted_in_ip: IP address recorded at opt-in time for TCPA consent records
--   (cleared on opt-out). Set only by the update_sms_preference RPC via the
--   server action — not writable directly by clients.
alter table profiles
  add column sms_opt_in      boolean     not null default false,
  add column sms_opted_in_at timestamptz,
  add column sms_opted_in_ip text;

-- ---------------------------------------------------------------------------
-- update_sms_preference
-- Authenticated user only. Toggles their own SMS opt-in state.
-- On opt-in:  records consent timestamp and caller IP.
-- On opt-out: clears all three consent fields — no consent record survives.
-- ---------------------------------------------------------------------------
create or replace function update_sms_preference(
  p_sms_opt_in boolean,
  p_ip         text default null
)
returns void
language plpgsql security definer as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  if p_sms_opt_in then
    update profiles
      set sms_opt_in      = true,
          sms_opted_in_at = now(),
          sms_opted_in_ip = p_ip,
          updated_at      = now()
      where id = auth.uid();
  else
    update profiles
      set sms_opt_in      = false,
          sms_opted_in_at = null,
          sms_opted_in_ip = null,
          updated_at      = now()
      where id = auth.uid();
  end if;
end;
$$;
