-- 0002_rls_policies.sql
-- Helper functions and Phase 1 RLS policies

-- ---------------------------------------------------------------------------
-- Helper functions (security definer so they bypass RLS themselves)
-- ---------------------------------------------------------------------------
create or replace function current_user_role()
returns text language sql security definer stable as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function current_user_club_id()
returns uuid language sql security definer stable as $$
  select club_id from profiles where id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- Enable RLS on every Phase 1 table
-- ---------------------------------------------------------------------------
alter table clubs                    enable row level security;
alter table club_settings            enable row level security;
alter table profiles                 enable row level security;
alter table courts                   enable row level security;
alter table operating_hours          enable row level security;
alter table operating_hours_override enable row level security;
alter table event_types              enable row level security;

-- ---------------------------------------------------------------------------
-- clubs — SELECT same club
-- ---------------------------------------------------------------------------
create policy "clubs_select_same_club"
  on clubs for select
  using (id = current_user_club_id());

-- ---------------------------------------------------------------------------
-- club_settings — SELECT same club
-- ---------------------------------------------------------------------------
create policy "club_settings_select_same_club"
  on club_settings for select
  using (club_id = current_user_club_id());

-- ---------------------------------------------------------------------------
-- profiles — SELECT same club; UPDATE own row (role column excluded)
-- ---------------------------------------------------------------------------
create policy "profiles_select_same_club"
  on profiles for select
  using (club_id = current_user_club_id());

create policy "profiles_update_own_row"
  on profiles for update
  using (id = auth.uid())
  with check (
    id = auth.uid()
    -- Prevent role escalation: new role must match current role
    and role = current_user_role()
  );

-- ---------------------------------------------------------------------------
-- courts — SELECT same club
-- ---------------------------------------------------------------------------
create policy "courts_select_same_club"
  on courts for select
  using (club_id = current_user_club_id());

-- ---------------------------------------------------------------------------
-- operating_hours — SELECT same club
-- ---------------------------------------------------------------------------
create policy "operating_hours_select_same_club"
  on operating_hours for select
  using (club_id = current_user_club_id());

-- ---------------------------------------------------------------------------
-- operating_hours_override — SELECT same club
-- ---------------------------------------------------------------------------
create policy "operating_hours_override_select_same_club"
  on operating_hours_override for select
  using (club_id = current_user_club_id());

-- ---------------------------------------------------------------------------
-- event_types — SELECT same club
-- ---------------------------------------------------------------------------
create policy "event_types_select_same_club"
  on event_types for select
  using (club_id = current_user_club_id());
