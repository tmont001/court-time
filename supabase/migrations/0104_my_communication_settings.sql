-- 0104_my_communication_settings.sql
-- Phase 31D runtime-defect correction. Apply in Supabase SQL Editor (cloud
-- only). Additive only — no existing table, RLS policy, or grant is
-- changed. Do not apply until reviewed; the accompanying application-code
-- change in this same checkpoint calls this RPC by name and will fail at
-- runtime until this migration is applied.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Confirmed root cause (from migration history, no live query needed):
-- migration 0079_phase25_account_foundation.sql revoked table-wide SELECT on
-- public.profiles from `authenticated` and re-granted SELECT on only this
-- explicit column list:
--
--   id, club_id, role, first_name, last_name, status, phone,
--   is_lesson_provider, created_at, updated_at
--
-- `sms_opt_in` (added earlier, in 0018_sms_opt_in.sql) was never added to
-- that list. Postgres denies a SELECT statement in full when it references
-- any column the caller lacks privilege on — it does not silently omit the
-- ungranted column. Both `src/app/(app)/profile/notifications/page.tsx`
-- (`.select("phone, sms_opt_in")`) and `sendTestSms` in
-- `src/app/(app)/admin/settings/actions.ts`
-- (`.select("phone, sms_opt_in, club_id")`) include `sms_opt_in` in the same
-- query as `phone`, so the entire query is denied — not just the
-- `sms_opt_in` field. Both call sites destructure only `{ data }` from the
-- result and never inspected `error`, so the resulting `data: null` was
-- indistinguishable from "no phone on file," producing exactly the observed
-- symptom: an Admin with a real, correct phone number (correctly displayed
-- on /profile via get_current_account_context(), a SECURITY DEFINER RPC
-- that bypasses column grants entirely and does not even select
-- sms_opt_in) sees "No phone number added" on /profile/notifications and
-- gets "Add a phone number to your profile first." from Test SMS.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS IS A NEW RPC, NOT A WIDENED COLUMN GRANT
-- ═══════════════════════════════════════════════════════════════════════════
-- The direct fix — adding sms_opt_in to 0079's column-level SELECT grant —
-- was rejected: profiles' RLS (profiles_select_same_club) makes any granted
-- column visible not just on the caller's own row but on every same-club
-- profile's row too. Granting table-wide (even column-scoped) SELECT on
-- sms_opt_in would let any authenticated same-club user read any other
-- member's SMS opt-in status directly from the client — a real widening of
-- exposure with no product justification. Instead, this migration adds one
-- narrow, self-only SECURITY DEFINER RPC that derives the caller
-- exclusively from auth.uid(), accepts no parameters, and returns only
-- phone and sms_opt_in for the caller's own row — never any other profile
-- field, and never another user's row. profiles' RLS and column grants are
-- completely unchanged by this migration.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- FUNCTION ADDED
-- ═══════════════════════════════════════════════════════════════════════════
--   get_my_communication_settings() returns jsonb
--     { phone: text | null, sms_opt_in: boolean } for the caller's own row,
--     or null if the caller is unauthenticated or has no profile row (an
--     anomaly for an already-authenticated session — application code
--     treats this identically to an RPC-level error: a failed lookup, never
--     "phone is null").
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.get_my_communication_settings()
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_caller_id  uuid := auth.uid();
  v_phone      text;
  v_sms_opt_in boolean;
begin
  if v_caller_id is null then return null; end if;

  select phone, sms_opt_in into v_phone, v_sms_opt_in
    from public.profiles
    where id = v_caller_id;

  if not found then return null; end if;

  return jsonb_build_object('phone', v_phone, 'sms_opt_in', coalesce(v_sms_opt_in, false));
end;
$$;

revoke execute on function public.get_my_communication_settings() from public, anon;
grant  execute on function public.get_my_communication_settings() to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- End of 0104_my_communication_settings.sql
-- ═══════════════════════════════════════════════════════════════════════════
