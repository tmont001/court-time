-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 34G-D1 — Production Code Hardening (QA correction)
--
-- CONFIRMED RUNTIME + LIVE DATABASE FINDING: Staff CSV export QA on
-- /admin/payments failed closed on BOTH Outstanding Balances and Payment
-- Activity exports whenever a payment's domain was a program_enrollment —
-- exportDomainHydration.ts correctly reported "program_enrollment row not
-- found" even though the row genuinely exists. Root cause, confirmed by
-- direct live-database ACL/RLS inspection: Staff is intentionally
-- authorized by the Payments export action (isOperator = admin OR staff),
-- but program_enrollments' own RLS policy never granted Staff SELECT
-- visibility at all — so the export's own authenticated (RLS-governed)
-- client silently saw zero rows for a Staff caller, which
-- hydrateExportDomainContext correctly, safely reported as "not found"
-- (fail-closed financial-export behavior — see its own header comment —
-- deliberately NOT weakened by this migration). This is an RLS
-- authorization mismatch, not an export hydration defect.
--
-- LATEST EFFECTIVE POLICY BEFORE THIS FIX (confirmed by reading every
-- migration that has ever touched program_enrollments_select — 0087
-- original CREATE, 0091 comment-only/no redefinition, 0115 the latest
-- DROP+CREATE, nothing after 0115 touches it):
--
--   create policy "program_enrollments_select"
--     on public.program_enrollments for select
--     using (
--       exists (
--         select 1 from public.programs pr
--         where pr.id = program_enrollments.program_id
--           and pr.club_id = public.current_user_club_id()
--           and (
--             program_enrollments.profile_id = auth.uid()
--             or program_enrollments.roster_member_id = public.current_user_roster_member_id()
--             or public.current_user_role() = 'admin'
--             or (public.current_user_role() = 'pro' and pr.created_by = auth.uid())
--           )
--       )
--     );
--
-- Narrow audit of the OTHER 4 domain tables hydrateExportDomainContext
-- reads (reservations, lesson_requests, event_participants, event_guests)
-- confirmed Staff already has the SELECT visibility the Payments export
-- needs on all four (reservations/event_participants via `current_user_
-- role() in ('admin', 'pro', 'staff')`, lesson_requests via the admin
-- policy's `current_user_is_operator()` helper — admin-or-staff,
-- event_guests via an unrestricted same-club-authenticated policy with no
-- role check at all) — program_enrollments was the ONLY one missing
-- Staff. No other table needs correction in this migration.
--
-- FIX: preserves every existing branch verbatim (outer Program club_id
-- scoping, Member own profile_id, Member own roster_member_id, Admin,
-- Pro-creator-only) and adds exactly ONE new branch — Staff, same-club,
-- read-only — mirroring the existing bare `= 'admin'` role-literal style
-- already used in this exact policy (rather than introducing the
-- current_user_is_operator() helper here, to keep this a minimal,
-- surgical, easily-diffable widening of an already-applied policy). Does
-- NOT touch 0115 itself, does NOT touch INSERT/UPDATE/DELETE policies or
-- table-level grants, does NOT introduce any service-role/privileged
-- path, and does NOT change Program payment lifecycle.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

drop policy if exists "program_enrollments_select" on public.program_enrollments;

create policy "program_enrollments_select"
  on public.program_enrollments for select
  using (
    exists (
      select 1 from public.programs pr
      where pr.id = program_enrollments.program_id
        and pr.club_id = public.current_user_club_id()
        and (
          program_enrollments.profile_id = auth.uid()
          or program_enrollments.roster_member_id = public.current_user_roster_member_id()
          or public.current_user_role() = 'admin'
          or public.current_user_role() = 'staff'
          or (public.current_user_role() = 'pro' and pr.created_by = auth.uid())
        )
    )
  );

commit;
