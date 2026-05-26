-- 0044_operating_hours_override_rls.sql
-- Phase 17A: admin INSERT / UPDATE / DELETE policies on operating_hours_override.
-- The SELECT policy ("operating_hours_override_select_same_club") already exists
-- from 0002_rls_policies.sql and is not touched here.
-- All writes are also gated by security-definer RPCs (0045, 0046); these
-- policies are a secondary safety net that prevents any future direct-client path
-- from bypassing access control.
-- Apply in Supabase SQL Editor (cloud only).

-- ---------------------------------------------------------------------------
-- operating_hours_override — INSERT (admin, own club only)
-- ---------------------------------------------------------------------------
create policy "operating_hours_override_insert_admin"
  on operating_hours_override for insert
  with check (
    club_id = current_user_club_id()
    and current_user_role() = 'admin'
  );

-- ---------------------------------------------------------------------------
-- operating_hours_override — UPDATE (admin, own club only)
-- Both USING and WITH CHECK must pass so an admin cannot move a row to another
-- club by changing club_id.
-- ---------------------------------------------------------------------------
create policy "operating_hours_override_update_admin"
  on operating_hours_override for update
  using  (club_id = current_user_club_id() and current_user_role() = 'admin')
  with check (club_id = current_user_club_id() and current_user_role() = 'admin');

-- ---------------------------------------------------------------------------
-- operating_hours_override — DELETE (admin, own club only)
-- ---------------------------------------------------------------------------
create policy "operating_hours_override_delete_admin"
  on operating_hours_override for delete
  using (club_id = current_user_club_id() and current_user_role() = 'admin');
