-- 0034_update_handle_new_user.sql
-- Phase 12E: remove the hardcoded 'riverside' slug from handle_new_user.
-- New auth users now receive a profile row with club_id = null.
-- Club assignment happens when the user accepts an invite via accept_club_invite().
-- Requires migration 0033 (nullable club_id) to be applied first.
-- Apply in Supabase SQL Editor (cloud only).

create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into profiles (id, club_id, role, status)
  values (new.id, null, 'member', 'active');
  return new;
end;
$$;
