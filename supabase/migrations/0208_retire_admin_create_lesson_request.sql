-- 0208_retire_admin_create_lesson_request.sql
-- Phase 44A — retire the orphaned admin_create_lesson_request RPC.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY
-- ═══════════════════════════════════════════════════════════════════════════
-- 0207's post-apply live smoke exposed that public.admin_create_lesson_
-- request(...) reaches its INSERT but fails a NOT NULL constraint on
-- lesson_requests.roster_member_id (added by 0111_staff_managed_lessons_
-- identity.sql, Phase 33D1) — this function's INSERT column list was never
-- updated to populate it. A narrow current-repo audit (Phase 44A, this
-- checkpoint) determined this is not a bug worth repairing:
--
--   - Zero runtime call sites: adminCreateLessonRequestAction (its only
--     caller, src/app/(app)/lessons/actions.ts) is itself never imported
--     or invoked by any component.
--   - The live Admin lesson-create UI (AdminRequestLessonSheet, rendered
--     from both /admin/lessons and /admin/members/[id]) calls exclusively
--     adminCreateMemberLessonAction -> public.admin_create_member_lesson —
--     a direct-confirmed booking, by design, with no pending-request
--     negotiation stage. src/app/(app)/admin/members/[id]/page.tsx's own
--     current comment states this outright: "AdminRequestLessonSheet now
--     books via admin_create_member_lesson(p_roster_member_id, ...), not
--     the old profiles-keyed admin_create_lesson_request."
--   - 0111's own column comment on lesson_requests.roster_member_id names
--     exactly which functions were updated to populate it at creation —
--     submit_lesson_request and admin_create_member_lesson.
--     admin_create_lesson_request is absent from that list; it became
--     structurally stale the moment 0111 shipped.
--   - 0140_lesson_pricing.sql's own header, written well before this
--     checkpoint, already reached the same conclusion independently:
--     "Does not modify 0131-0139 or admin_create_lesson_request (confirmed
--     orphaned — its wrapping action has zero callers anywhere in src/;
--     not touched)."
--
-- Repairing a zero-caller RPC to satisfy a schema invariant it was never
-- updated for would just recreate the parallel-unmaintained-RPC risk
-- 0207's send_announcement v1 drop was meant to eliminate. Retiring it is
-- the narrower, safer change.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- DATABASE DEPENDENCY AUDIT (this checkpoint, against the live project)
-- ═══════════════════════════════════════════════════════════════════════════
-- Confirmed via direct inspection of the live database (not TypeScript
-- grep alone):
--   - pg_depend has ZERO rows referencing this function's oid as refobjid
--     (covers views, rules, triggers, policies, and every other
--     catalog-tracked dependency type).
--   - No other function's prosrc contains "admin_create_lesson_request"
--     (PL/pgSQL cross-function calls are not tracked by pg_depend, so this
--     was checked independently by text search).
--   - No RLS policy's qual/with_check references it.
--   - No view definition references it.
--   - No trigger has this function as its trigger function.
-- Zero database-level dependencies exist. No CASCADE is used or needed.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT
-- ═══════════════════════════════════════════════════════════════════════════
-- Exact-signature DROP FUNCTION only — same shape as 0207's send_
-- announcement(text, text) drop, and for the identical reason: deliberately
-- NOT "IF EXISTS". If this exact signature is somehow already absent, that
-- is schema drift from what this migration's own dependency audit (above)
-- assumed, and the migration must fail loudly rather than silently no-op —
-- matching the fail-closed DROP convention this repository already
-- established (0131's constraint drops, 0207's send_announcement drop).
--
-- Does not touch admin_create_member_lesson, submit_lesson_request,
-- reassign_lesson_provider, any lesson_requests column/constraint, any
-- notification kind/preference, any RLS policy, any payment/cancellation
-- behavior, or Phase 39. Migrations 0001-0207 are not edited.
--
-- Apply in Supabase SQL Editor (cloud only). Not applied by this
-- checkpoint — prepared for migration review only.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

drop function public.admin_create_lesson_request(
  uuid,
  uuid,
  integer,
  uuid,
  uuid,
  text,
  jsonb
);

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run manually after applying — NOT executed automatically by
-- this file)
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. select proname from pg_proc where proname = 'admin_create_lesson_request';
--    -- must return zero rows.
-- 2. select proname from pg_proc where proname = 'admin_create_member_lesson';
--    -- must return exactly one row, unchanged.
-- 3. Confirm /admin/lessons and /admin/members/[id]'s "Book Lesson" flow
--    still completes successfully end to end (unaffected — it never called
--    the dropped function).
-- ═══════════════════════════════════════════════════════════════════════════
-- End of 0208_retire_admin_create_lesson_request.sql
-- ═══════════════════════════════════════════════════════════════════════════
