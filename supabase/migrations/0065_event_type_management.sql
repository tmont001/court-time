-- 0065_event_type_management.sql
-- Phase 22A: admin-managed event types.
--
-- Background
-- ----------
-- event_types was seeded with exactly 5 rows per club (lesson, clinic, social,
-- league, tournament) and had no write path from the app. Admins could not
-- rename labels, change colors, or deactivate types without direct SQL access.
--
-- Changes
-- -------
-- 1. Remove the key CHECK constraint.
--    The constraint limited key to the 5 seed values and blocked custom types.
--    Removing it while keeping the UNIQUE(club_id, key) constraint preserves
--    all current uniqueness guarantees; the 5 seed rows are unaffected.
--
-- 2. Add is_active boolean not null default true.
--    Allows soft-deactivation instead of deletion. All existing rows default
--    to active. Historical events retain their event_type_id FK and continue
--    to display the type's current label/color via join even after deactivation.
--    CreateEventSheet filters is_active = true (app-layer change already applied).
--
-- 3. RLS INSERT/UPDATE policies for admins (defense-in-depth).
--    All writes go through security-definer RPCs that perform their own role
--    checks; these policies are a second layer of protection.
--
-- 4. Three admin-only RPCs:
--    create_event_type(p_label, p_color) — derives key from label.
--    update_event_type(p_id, p_label, p_color) — edits label and color only.
--    set_event_type_active(p_id, p_is_active) — activates or deactivates a type.
--
-- 5. Inactive-type integrity trigger on events.
--    Prevents INSERT or UPDATE OF event_type_id referencing an inactive type.
--    UPDATE of other columns on existing events (status changes, roster edits)
--    is not affected; the trigger fires only when event_type_id changes.
--
-- Rerun safety
-- ------------
-- Idempotent:
--   DROP CONSTRAINT IF EXISTS — no-op if constraint is already gone.
--   ADD COLUMN IF NOT EXISTS — no-op if column already exists.
--   DROP POLICY IF EXISTS — no-op if policy does not exist (added before each
--     CREATE POLICY so reruns succeed).
--   CREATE OR REPLACE FUNCTION — replaces function body on every run.
--   DROP TRIGGER IF EXISTS — no-op if trigger does not exist.
--   REVOKE/GRANT — idempotent.
-- NOT idempotent:
--   CREATE POLICY — fails if the named policy already exists. Each CREATE POLICY
--     is preceded by DROP POLICY IF EXISTS to make the block rerunnable.
--   CREATE TRIGGER — fails if trigger exists. Preceded by DROP TRIGGER IF EXISTS.
-- Safe to apply in any environment, including production.

-- ---------------------------------------------------------------------------
-- 1. Remove key CHECK constraint
-- ---------------------------------------------------------------------------
alter table event_types
  drop constraint if exists event_types_key_check;

-- ---------------------------------------------------------------------------
-- 2. Add is_active column (existing rows preserved as active via default)
-- ---------------------------------------------------------------------------
alter table event_types
  add column if not exists is_active boolean not null default true;

-- ---------------------------------------------------------------------------
-- 3. RLS INSERT/UPDATE policies (defense-in-depth; writes go via RPC)
-- ---------------------------------------------------------------------------
drop policy if exists "event_types_insert_admin" on event_types;
create policy "event_types_insert_admin"
  on event_types for insert
  with check (
    club_id = current_user_club_id()
    and current_user_role() = 'admin'
  );

drop policy if exists "event_types_update_admin" on event_types;
create policy "event_types_update_admin"
  on event_types for update
  using (
    club_id = current_user_club_id()
    and current_user_role() = 'admin'
  )
  with check (
    club_id = current_user_club_id()
    and current_user_role() = 'admin'
  );

-- ---------------------------------------------------------------------------
-- 4a. create_event_type — admin-only; key derived from label
-- ---------------------------------------------------------------------------
create or replace function create_event_type(
  p_label text,
  p_color text
)
returns event_types
language plpgsql security definer as $$
declare
  v_profile profiles%rowtype;
  v_key     text;
  v_suffix  int;
  v_result  event_types%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  -- Explicit null checks: trim(null) = null and null = '' is null (not true),
  -- so the blank-label guard would silently pass without this.
  if p_label is null or trim(p_label) = '' then raise exception 'invalid_label'; end if;

  -- Explicit null check: null !~ '...' evaluates to null (not true), so the
  -- regex guard would silently pass without this.
  if p_color is null or p_color !~ '^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$' then
    raise exception 'invalid_color';
  end if;

  -- Derive key: lowercase, collapse non-alphanumeric runs to underscore, strip
  -- leading/trailing underscores, truncate to 50 chars.
  v_key := lower(regexp_replace(trim(p_label), '[^a-zA-Z0-9]+', '_', 'g'));
  v_key := trim(both '_' from v_key);
  v_key := left(v_key, 50);

  -- Labels containing only punctuation, emoji, or other non-ASCII characters
  -- produce an empty slug after the substitution above. Fall back to a safe
  -- base so we never insert an empty key.
  if v_key = '' or v_key is null then
    v_key := 'event_type';
  end if;

  -- Ensure uniqueness within the club using a numeric suffix.
  if exists (
    select 1 from event_types where club_id = v_profile.club_id and key = v_key
  ) then
    v_suffix := 2;
    loop
      exit when not exists (
        select 1 from event_types
        where club_id = v_profile.club_id
          and key = v_key || '_' || v_suffix
      );
      v_suffix := v_suffix + 1;
    end loop;
    v_key := v_key || '_' || v_suffix;
  end if;

  insert into event_types (
    club_id, key, label, color,
    default_capacity, default_duration_minutes, default_court_count,
    shows_participant_names, is_active
  ) values (
    v_profile.club_id, v_key, trim(p_label), p_color,
    8, 60, 1, false, true
  )
  returning * into v_result;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'create_event_type',
    'event_type',
    v_result.id,
    jsonb_build_object('key', v_key, 'label', trim(p_label), 'color', p_color)
  );

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4b. update_event_type — admin-only; only label and color are editable.
--     The key column is immutable after creation; editing a label does not
--     change the key.
-- ---------------------------------------------------------------------------
create or replace function update_event_type(
  p_id    uuid,
  p_label text,
  p_color text
)
returns event_types
language plpgsql security definer as $$
declare
  v_profile profiles%rowtype;
  v_result  event_types%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  -- Explicit null check: where id = null matches no rows, producing 'not_found'
  -- rather than a clear validation error. Reject early with a distinct code.
  if p_id is null then raise exception 'invalid_event_type'; end if;

  if p_label is null or trim(p_label) = '' then raise exception 'invalid_label'; end if;

  if p_color is null or p_color !~ '^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$' then
    raise exception 'invalid_color';
  end if;

  -- Verify the row belongs to this admin's club.
  perform 1 from event_types where id = p_id and club_id = v_profile.club_id;
  if not found then raise exception 'not_found'; end if;

  update event_types
  set label = trim(p_label), color = p_color, updated_at = now()
  where id = p_id
  returning * into v_result;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'update_event_type',
    'event_type',
    p_id,
    jsonb_build_object('label', trim(p_label), 'color', p_color)
  );

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4c. set_event_type_active — admin-only; activates or deactivates a type.
-- ---------------------------------------------------------------------------
create or replace function set_event_type_active(p_id uuid, p_is_active boolean)
returns void
language plpgsql security definer as $$
declare
  v_profile profiles%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  -- Explicit null checks: p_id = null matches nothing (silent not_found);
  -- p_is_active = null would write null into a NOT NULL column.
  if p_id is null then raise exception 'invalid_event_type'; end if;
  if p_is_active is null then raise exception 'invalid_active_state'; end if;

  -- Verify the row belongs to this admin's club.
  perform 1 from event_types where id = p_id and club_id = v_profile.club_id;
  if not found then raise exception 'not_found'; end if;

  update event_types
  set is_active = p_is_active, updated_at = now()
  where id = p_id;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    case when p_is_active then 'activate_event_type' else 'deactivate_event_type' end,
    'event_type',
    p_id,
    jsonb_build_object('is_active', p_is_active)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Inactive-event-type integrity trigger on events
--
-- Fires BEFORE INSERT and BEFORE UPDATE OF event_type_id only. This means:
--   - New events must reference an active type.
--   - If event_type_id is later changed on an existing event, the new type
--     must also be active.
--   - All other updates to an existing event (status, roster, cancellation)
--     are NOT checked — historical events using inactive types remain fully
--     editable for unrelated fields.
-- ---------------------------------------------------------------------------
create or replace function check_event_type_active()
returns trigger language plpgsql security definer as $$
begin
  if not exists (
    select 1 from event_types
    where id        = new.event_type_id
      and club_id   = new.club_id
      and is_active = true
  ) then
    raise exception 'inactive_event_type';
  end if;
  return new;
end;
$$;

drop trigger if exists events_check_event_type_active on events;
create trigger events_check_event_type_active
  before insert or update of event_type_id on events
  for each row execute function check_event_type_active();

-- ---------------------------------------------------------------------------
-- Restrict execution of the three admin RPCs to authenticated users only.
-- check_event_type_active is a trigger function and cannot be called by users
-- directly; no grant is required for trigger invocation.
-- ---------------------------------------------------------------------------
revoke execute on function create_event_type(text, text) from public;
revoke execute on function create_event_type(text, text) from anon;
grant  execute on function create_event_type(text, text) to   authenticated;

revoke execute on function update_event_type(uuid, text, text) from public;
revoke execute on function update_event_type(uuid, text, text) from anon;
grant  execute on function update_event_type(uuid, text, text) to   authenticated;

revoke execute on function set_event_type_active(uuid, boolean) from public;
revoke execute on function set_event_type_active(uuid, boolean) from anon;
grant  execute on function set_event_type_active(uuid, boolean) to   authenticated;
