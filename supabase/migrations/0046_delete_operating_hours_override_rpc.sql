-- 0046_delete_operating_hours_override_rpc.sql
-- Phase 17A: security-definer RPC to remove a date-specific operating-hours
-- override. Deleting an override restores normal weekly operating_hours for
-- that date. Existing reservations on the date are never cancelled or modified.
-- Requires 0044_operating_hours_override_rls.sql to be applied first.
-- Apply in Supabase SQL Editor (cloud only).

create or replace function delete_operating_hours_override(
  p_override_date date,
  p_dry_run       boolean default true
)
returns jsonb
language plpgsql security definer as $$
declare
  v_actor    profiles%rowtype;
  v_override operating_hours_override%rowtype;
begin
  -- 1. Load actor profile.
  select * into v_actor from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  -- 2. Actor must be admin.
  if v_actor.role <> 'admin' then raise exception 'insufficient_role'; end if;

  -- 3. Verify the override row exists for this club.
  --    Raise immediately if not found so the caller knows the date was already
  --    clear (idempotent delete would be silent; explicit error is safer for UI).
  select * into v_override
    from operating_hours_override
    where club_id       = v_actor.club_id
      and override_date = p_override_date;
  if not found then raise exception 'override_not_found'; end if;

  -- 4. Dry run: confirm the row exists and return without writing.
  if p_dry_run then
    return jsonb_build_object('dry_run', true, 'deleted', false);
  end if;

  -- 5a. Delete the override row.
  delete from operating_hours_override
    where club_id       = v_actor.club_id
      and override_date = p_override_date;

  -- 5b. Write audit log.
  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'delete_operating_hours_override',
    'operating_hours_override',
    v_actor.club_id,
    jsonb_build_object('override_date', p_override_date)
  );

  return jsonb_build_object('dry_run', false, 'deleted', true);
end;
$$;
