-- 0130_drop_legacy_update_member_reservation_overload.sql
-- Phase 33G4 optional cleanup: drops the orphaned 10-argument
-- update_member_reservation overload left behind by 0109.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS IS SAFE
-- ═══════════════════════════════════════════════════════════════════════════
-- 0097 (reservation_edit_foundation) originally defined:
--   update_member_reservation(uuid, uuid, timestamptz, uuid, timestamptz,
--     timestamptz, text, int, text[], text)                       -- 10 args
--
-- 0109 (reservation_member_reassignment) added a NEW parameter,
-- p_roster_member_id, via `create or replace function
-- public.update_member_reservation(...)` — but Postgres resolves function
-- identity by (name, argument-type signature), not name alone. A different
-- argument list is a NEW, ADDITIONAL overload, not a replacement. 0109
-- never dropped the original 10-arg version; both signatures have
-- coexisted, live, since 0109 was applied.
--
-- Verified (grep across the entire src/ tree) that exactly one action
-- calls this RPC today: updateMemberReservationAdmin
-- (src/app/(app)/calendar/actions.ts), itself called only from
-- EditReservationSheet.tsx. Its params type declares p_roster_member_id
-- as a required (non-optional) field, always sent — so every real call
-- resolves to the 11-argument (0109) overload; the 10-argument (0097)
-- overload has had zero callers since 0109 shipped. src/lib/db/types.ts's
-- generated RPC type only models one Args/Returns shape for this name
-- (the 11-arg one), consistent with the 10-arg overload being unused by
-- any typed call site. No other file references update_member_reservation
-- except as prose comments naming it.
--
-- This migration drops ONLY the 10-argument overload by its exact
-- signature. The 11-argument (0109) overload, its grants, and every other
-- reservation RPC are completely untouched — this is a pure dead-code
-- removal, not a behavior change for any live code path.
--
-- No preflight needed: dropping an unreferenced function overload has no
-- data to check — it either has zero callers (confirmed above) and this
-- is a no-op for every real request, or (if this analysis is ever revisited
-- and found wrong) the drop would immediately and loudly fail any caller
-- with a Postgres "function does not exist" error rather than silently
-- corrupting anything — there is no partial-failure or data-integrity risk
-- class here at all.

begin;

drop function if exists public.update_member_reservation(
  uuid, uuid, timestamptz, uuid, timestamptz, timestamptz, text, int, text[], text
);

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- Re-create using 0097's exact original body (reproduced verbatim in that
-- migration file) if the 10-argument overload is ever genuinely needed
-- again — not expected, given it has had no callers since 0109 shipped.
