-- 0066_set_event_member_joinable.sql
-- Phase 22A: two focused write-path RPCs for event configuration.
--
-- 1. set_event_member_joinable — toggle open/admin-managed on future events.
-- 2. delete_event_type         — permanently remove unused custom event types.
--
-- Rerun safety
-- ------------
-- Fully idempotent: CREATE OR REPLACE, REVOKE/GRANT.
-- No schema columns, tables, or indexes are modified.
-- Safe to apply in any environment, including production.

-- ---------------------------------------------------------------------------
-- 1. set_event_member_joinable
-- ---------------------------------------------------------------------------
-- Eligibility (all enforced server-side; the UI also restricts to future events
-- but that check must not be relied on exclusively):
--   - authenticated caller
--   - caller role is admin or pro
--   - event belongs to caller's club
--   - event is scheduled (not cancelled)
--   - event is not archived
--   - event has not yet started (starts_at > now())
--   - admin may change any eligible event in the club
--   - pro may change only an eligible event they created
--   - null event ID rejected
--   - null member_joinable rejected

create or replace function set_event_member_joinable(
  p_event_id        uuid,
  p_member_joinable boolean
)
returns void
language plpgsql security definer as $$
declare
  v_profile profiles%rowtype;
  v_event   events%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role not in ('admin', 'pro') then raise exception 'insufficient_role'; end if;

  -- Explicit null checks — avoid silent no-op from null equality.
  if p_event_id is null then raise exception 'event_not_found'; end if;
  if p_member_joinable is null then raise exception 'invalid_value'; end if;

  select * into v_event
  from events
  where id = p_event_id and club_id = v_profile.club_id;
  if not found then raise exception 'event_not_found'; end if;

  if v_event.status = 'cancelled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  -- Server-side future guard. The UI already restricts this, but a stale client
  -- or direct RPC call must not be able to change a started event.
  if v_event.starts_at <= now() then raise exception 'event_started'; end if;

  -- Pros may only change events they created.
  if v_profile.role = 'pro' and v_event.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  update events
  set member_joinable = p_member_joinable,
      updated_at      = now()
  where id = p_event_id;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'set_event_member_joinable',
    'event',
    p_event_id,
    jsonb_build_object('member_joinable', p_member_joinable)
  );
end;
$$;

revoke execute on function set_event_member_joinable(uuid, boolean) from public;
revoke execute on function set_event_member_joinable(uuid, boolean) from anon;
grant  execute on function set_event_member_joinable(uuid, boolean) to   authenticated;

-- ---------------------------------------------------------------------------
-- 2. delete_event_type
-- ---------------------------------------------------------------------------
-- Permanently removes a custom event type that is:
--   - inactive (is_active = false)
--   - unreferenced by any event row
--   - not a seeded type (lesson, clinic, social, league, tournament)
--
-- Writes an audit_log entry before deletion so the record is preserved even
-- after the row is gone.
--
-- Error codes
-- -----------
--   invalid_event_type   — null p_id
--   not_found            — type not found in caller's club
--   insufficient_role    — caller is not an admin
--   protected_event_type — key is a seeded type
--   event_type_active    — type is still active (deactivate first)
--   event_type_in_use    — events reference this type_id (keep inactive)

create or replace function delete_event_type(p_id uuid)
returns void
language plpgsql security definer as $$
declare
  v_profile profiles%rowtype;
  v_type    event_types%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  if p_id is null then raise exception 'invalid_event_type'; end if;

  select * into v_type
  from event_types
  where id = p_id and club_id = v_profile.club_id;
  if not found then raise exception 'not_found'; end if;

  -- Seeded types may never be deleted.
  if v_type.key in ('lesson','clinic','social','league','tournament') then
    raise exception 'protected_event_type';
  end if;

  -- Must be inactive before deletion can proceed.
  if v_type.is_active then raise exception 'event_type_active'; end if;

  -- Any event referencing this type_id blocks deletion.
  -- event_type_id is a uuid FK; the check is global (not club-scoped) to
  -- catch any orphaned references, though in practice all events share the
  -- type's club_id via create_event validation.
  if exists (select 1 from events where event_type_id = p_id) then
    raise exception 'event_type_in_use';
  end if;

  -- Audit before delete so the record survives the DELETE.
  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'delete_event_type',
    'event_type',
    p_id,
    jsonb_build_object('key', v_type.key, 'label', v_type.label)
  );

  delete from event_types where id = p_id;
end;
$$;

revoke execute on function delete_event_type(uuid) from public;
revoke execute on function delete_event_type(uuid) from anon;
grant  execute on function delete_event_type(uuid) to   authenticated;
