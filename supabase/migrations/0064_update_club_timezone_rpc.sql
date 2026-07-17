-- 0064_update_club_timezone_rpc.sql
-- Phase 22A: allow admins to update the club timezone from Admin Settings.
--
-- Background
-- ----------
-- clubs.timezone already exists (migration 0001, default 'America/New_York').
-- No write path existed — changes required direct SQL access.
-- This migration adds a secure admin-only RPC that validates against the
-- approved IANA identifiers for the US pilot and records the change in audit_log.
--
-- clubs already has a "clubs_update_admin" RLS policy (migration 0023) that
-- restricts UPDATE to admins of the same club. The RPC uses SECURITY DEFINER
-- and performs its own role check, so the RLS policy is defense-in-depth.
--
-- Rerun safety
-- ------------
-- Fully idempotent:
--   CREATE OR REPLACE FUNCTION — replaces the function body on every run.
--   REVOKE/GRANT — idempotent; revoking a privilege not held is a no-op.
-- No schema columns, tables, indexes, or data are modified.
-- Safe to apply in any environment, including production.

-- ---------------------------------------------------------------------------
-- update_club_timezone
-- ---------------------------------------------------------------------------
create or replace function update_club_timezone(p_timezone text)
returns void
language plpgsql security definer as $$
declare
  v_profile profiles%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  -- Explicit null check: p_timezone IS NULL causes 'not in (...)' to evaluate
  -- to NULL (not TRUE), so the guard below would silently pass without this.
  if p_timezone is null then raise exception 'invalid_timezone'; end if;

  -- Only accept the IANA identifiers that cover US pilot clubs.
  -- Extend this list (or replace with pg_timezone_names lookup) when
  -- international clubs are onboarded.
  if p_timezone not in (
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Phoenix',
    'America/Los_Angeles',
    'America/Anchorage',
    'Pacific/Honolulu'
  ) then
    raise exception 'invalid_timezone';
  end if;

  update clubs
  set timezone = p_timezone, updated_at = now()
  where id = v_profile.club_id;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'update_club_timezone',
    'club',
    v_profile.club_id,
    jsonb_build_object('timezone', p_timezone)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Restrict execution to authenticated users; remove the default PUBLIC grant.
-- ---------------------------------------------------------------------------
revoke execute on function update_club_timezone(text) from public;
revoke execute on function update_club_timezone(text) from anon;
grant  execute on function update_club_timezone(text) to   authenticated;
