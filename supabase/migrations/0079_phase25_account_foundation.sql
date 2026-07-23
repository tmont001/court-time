-- 0079_phase25_account_foundation.sql
-- Phase 25A: Account, Profile, Membership, and Club Switching — Foundation
--
-- Changes in this migration:
--   1. Add is_lesson_provider to the profiles column-level SELECT grant.
--      Migration 0075 established column-level SELECT (revoking table-level),
--      but omitted is_lesson_provider (added in 0070). Phase 25B needs it
--      to display Lesson Pro status on the profile page.
--
--   2. Harden profiles UPDATE access.
--      Supabase's default grants table-level UPDATE to authenticated on all
--      public tables. The profiles_update_own_row RLS policy prevents role
--      escalation but does not restrict which columns may be written, so
--      any authenticated user can currently self-update status, club_id,
--      is_lesson_provider, admin_notes, etc. on their own row.
--
--      Correct posture: revoke table-level UPDATE, then re-grant only the
--      three personal columns a user is allowed to self-edit. All sensitive
--      field updates (role, status, club_id, is_lesson_provider) go through
--      SECURITY DEFINER RPCs that are unaffected by table-level grants.
--
--      Direct self-update call sites in app code:
--        • src/app/(app)/profile/actions.ts  — { first_name, last_name, phone }
--        • src/app/(auth)/welcome/WelcomeForm.tsx — { first_name, last_name, phone }
--      Both update only the three approved personal columns; this grant covers them.
--
--      Admin profile mutations (role, status, club_id, is_lesson_provider) use:
--        • set_member_role()   — SECURITY DEFINER
--        • set_member_status() — SECURITY DEFINER
--        • accept_club_invite() — SECURITY DEFINER
--        • update_sms_preference() — SECURITY DEFINER
--      All bypass table-level grants and are unaffected by this change.
--
-- NOT in this migration (already fixed in prior phases):
--   • handle_new_user hardcoded 'riverside' club — fixed in 0034 (Phase 12E).
--     New users already receive club_id = NULL. No change needed here.
--
-- Apply in Supabase SQL Editor (cloud only).

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Profiles SELECT grant — add is_lesson_provider
-- ═══════════════════════════════════════════════════════════════════════════
-- Revoke and re-grant to update the column list atomically. This replaces
-- the equivalent REVOKE + GRANT pair from migration 0075.

revoke select on public.profiles from authenticated;

grant select (
  id,
  club_id,
  role,
  first_name,
  last_name,
  status,
  phone,
  is_lesson_provider,
  created_at,
  updated_at
) on public.profiles to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Profiles UPDATE grant — column-level hardening
-- ═══════════════════════════════════════════════════════════════════════════
-- Revoke the broad table-level UPDATE that Supabase grants by default,
-- then re-grant only the three personal columns a user may self-edit.
-- anon receives no UPDATE access.

revoke update on public.profiles from authenticated;
revoke update on public.profiles from anon;

grant update (first_name, last_name, phone) on public.profiles to authenticated;
