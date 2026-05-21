-- 0033_profiles_nullable_club_id.sql
-- Phase 12E: allow profiles to exist before club assignment.
-- Existing rows are unaffected (all current pilot users have club_id set).
-- New users created after migration 0034 will have club_id = null until
-- they accept an invite via /join/[code].
-- Apply in Supabase SQL Editor (cloud only).

alter table profiles alter column club_id drop not null;
