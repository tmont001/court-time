-- 0042_notification_preferences.sql
-- Phase 16F: per-kind notification preferences for members.
-- Stores a row only when a user explicitly changes a default.
-- Missing row = kind is enabled (default on).
-- Only the four user-configurable kinds may appear here.
-- Mandatory kinds (reservation_cancelled_by_admin, event_cancelled,
-- waitlist_promoted) are always delivered with no preference row.
-- Apply in Supabase SQL Editor (cloud only).

-- ---------------------------------------------------------------------------
-- notification_preferences
-- ---------------------------------------------------------------------------
create table notification_preferences (
  id         uuid        primary key default uuid_generate_v4(),
  user_id    uuid        not null references profiles(id) on delete cascade,
  club_id    uuid        not null references clubs(id) on delete cascade,
  kind       text        not null
               check (kind in (
                 'reservation_confirmed',
                 'reservation_cancelled_by_member',
                 'event_joined',
                 'announcement'
               )),
  enabled    boolean     not null default true,
  updated_at timestamptz not null default now(),
  unique (user_id, kind)
);

create index np_user_idx on notification_preferences (user_id);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table notification_preferences enable row level security;

-- Users may read only their own preferences.
create policy "own_select"
  on notification_preferences for select
  using (user_id = auth.uid());

-- No INSERT / UPDATE / DELETE via client — all writes go through the RPC below.

-- ---------------------------------------------------------------------------
-- user_pref_enabled
-- Returns true when no preference row exists (default on = enabled).
-- Called inside notification-inserting security-definer RPCs to gate creation.
-- ---------------------------------------------------------------------------
create or replace function user_pref_enabled(p_user_id uuid, p_kind text)
returns boolean
language sql security definer stable as $$
  select coalesce(
    (select enabled
       from notification_preferences
      where user_id = p_user_id
        and kind    = p_kind),
    true
  );
$$;

-- ---------------------------------------------------------------------------
-- update_notification_preference
-- Authenticated user only. Upserts their own preference for one kind.
-- Raises invalid_kind for any kind not in the user-configurable list.
-- ---------------------------------------------------------------------------
create or replace function update_notification_preference(
  p_kind    text,
  p_enabled boolean
)
returns void
language plpgsql security definer as $$
declare
  v_club_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  if p_kind not in (
    'reservation_confirmed',
    'reservation_cancelled_by_member',
    'event_joined',
    'announcement'
  ) then
    raise exception 'invalid_kind';
  end if;

  select club_id into v_club_id from profiles where id = auth.uid();

  insert into notification_preferences (user_id, club_id, kind, enabled, updated_at)
  values (auth.uid(), v_club_id, p_kind, p_enabled, now())
  on conflict (user_id, kind) do update
    set enabled    = excluded.enabled,
        updated_at = now();
end;
$$;
