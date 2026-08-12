-- 0112_fix_my_lesson_roster_lookup_ambiguity.sql
-- Phase 33D1 runtime fix: get_my_lesson_requests() — ambiguous column
-- reference "id"
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Manual QA against the applied 0111 produced a live runtime failure:
--
--   [MySchedule] get_my_lesson_requests failed:
--   column reference "id" is ambiguous
--
-- Root cause, confirmed by inspecting the applied 0111 function body:
-- get_my_lesson_requests() is `returns table (id uuid, ...)` — in PL/pgSQL,
-- RETURNS TABLE output columns are implicitly declared as variables in the
-- function's namespace, exactly like anything in its `declare` block. The
-- function's roster-identity lookup (added by 0111's claim-continuity
-- correction pass) reads:
--
--   select id into v_roster_member_id
--     from public.roster_members
--    where club_id    = v_profile.club_id
--      and claimed_by = auth.uid();
--
-- `id` here is unqualified, and both the output variable `id` and
-- `roster_members.id` are valid resolutions in scope — Postgres cannot
-- resolve the ambiguity and raises at execution time (this is not a
-- schema-time error; CREATE OR REPLACE FUNCTION succeeds regardless, which
-- is why 0111's own post-migration verification — which checks signatures,
-- grants, and function-body text patterns, never a live call — passed
-- while this defect shipped to production undetected).
--
-- Locked architecture: unchanged. This migration makes NO identity,
-- security, or business-logic change of any kind — it is a pure
-- column-qualification fix to the one line that caused the ambiguity, plus
-- (per explicit instruction) also qualifying the two adjacent columns in
-- the same lookup (club_id, claimed_by) for consistency, even though only
-- `id` was actually ambiguous against a RETURNS TABLE output name (neither
-- club_id nor claimed_by collides with any output column of this
-- function).
--
-- Focused scan for any OTHER unqualified-column collision in this same
-- function, per instruction — result: none found. Every other reference in
-- the function body is already fully table-qualified: `v_profile` fields
-- are read via `v_profile.club_id` (a record variable field access, not a
-- bare column reference); the initial profile lookup uses the `p` alias
-- (`p.id = auth.uid()`); the entire `return query select ...` block and its
-- `where`/`order by` clauses reference every column through an explicit
-- table alias (`lr.`, `pro.`, `pc.`, `xc.`, `lt.`) or a plpgsql variable
-- (`v_profile.club_id`, `v_roster_member_id`) — none of those are bare
-- column names, so none of them could collide with a RETURNS TABLE output
-- variable regardless of name overlap. The roster-identity lookup this
-- migration fixes was the only place in the function using bare,
-- unqualified column names against a real table.
--
-- Explicitly OUT OF SCOPE for this migration:
--   - No change to 0111's schema, RLS, other RPCs, or any other function.
--   - No change to the roster-aware ownership predicate's LOGIC — only the
--     one line that resolves v_roster_member_id gains table qualification;
--     the predicate itself (`lr.member_id = auth.uid() or (v_roster_
--     member_id is not null and lr.roster_member_id = v_roster_member_id)`)
--     is byte-for-byte unchanged.
--   - No write to lesson_requests.member_id anywhere in this function
--     (there never was one — this function is read-only).
--   - Not a variable-conflict directive (e.g. `#variable_conflict use_
--     column`) — explicit SQL qualification is the intended, precise fix,
--     scoped to exactly the line that needs it, per instruction.
--   - Not applied by this checkpoint. Not committed.
--
-- No preflight is required — this is a CREATE OR REPLACE of one function's
-- body with no data or schema assumption; nothing to backfill or verify
-- about existing rows beforehand.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace function public.get_my_lesson_requests()
returns table (
  id                    uuid,
  pro_id                uuid,
  pro_first_name        text,
  pro_last_name         text,
  preferred_court_id    uuid,
  preferred_court_name  text,
  duration_minutes      int,
  member_note           text,
  preferred_windows     jsonb,
  proposed_starts_at    timestamptz,
  proposed_ends_at      timestamptz,
  proposed_court_id     uuid,
  proposed_court_name   text,
  status                text,
  decline_reason        text,
  cancellation_reason   text,
  linked_reservation_id uuid,
  created_at            timestamptz,
  updated_at            timestamptz,
  confirmed_at          timestamptz,
  lesson_type_id        uuid,
  lesson_type_name      text,
  lesson_outcome        text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  -- Phase 33D1: the caller's own current roster identity in this club,
  -- server-resolved only.
  v_roster_member_id uuid;
begin
  select * into v_profile from public.profiles p where p.id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  -- 0112 fix: qualified via the rm alias. `rm.id` resolves unambiguously
  -- to roster_members.id — the unqualified `id` this replaces was
  -- ambiguous against this function's own RETURNS TABLE output column
  -- also named `id`. club_id/claimed_by are qualified too, for
  -- consistency, though neither collided with an output column.
  select rm.id into v_roster_member_id
    from public.roster_members rm
   where rm.club_id    = v_profile.club_id
     and rm.claimed_by = auth.uid();

  return query
    select
      lr.id,
      lr.pro_id,
      pro.first_name  as pro_first_name,
      pro.last_name   as pro_last_name,
      lr.preferred_court_id,
      pc.name         as preferred_court_name,
      lr.duration_minutes,
      lr.member_note,
      lr.preferred_windows,
      lr.proposed_starts_at,
      lr.proposed_ends_at,
      lr.proposed_court_id,
      xc.name         as proposed_court_name,
      lr.status,
      lr.decline_reason,
      lr.cancellation_reason,
      lr.linked_reservation_id,
      lr.created_at,
      lr.updated_at,
      lr.confirmed_at,
      lr.lesson_type_id,
      lt.name         as lesson_type_name,
      lr.lesson_outcome
    from public.lesson_requests lr
    join public.profiles pro on pro.id = lr.pro_id
    left join public.courts pc on pc.id = lr.preferred_court_id
    left join public.courts xc on xc.id = lr.proposed_court_id
    left join public.lesson_types lt on lt.id = lr.lesson_type_id
   where lr.club_id = v_profile.club_id
     and (
       lr.member_id = auth.uid()
       or (v_roster_member_id is not null and lr.roster_member_id = v_roster_member_id)
     )
   order by lr.created_at desc;
end;
$$;

revoke execute on function public.get_my_lesson_requests() from public, anon;
grant  execute on function public.get_my_lesson_requests() to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration is created
-- in this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- Reverting to the pre-0112 (0111) body would reintroduce the confirmed
-- "column reference \"id\" is ambiguous" runtime failure for every caller
-- — there is no scenario where reverting this migration is desirable.
-- If ever required regardless: `create or replace function public.
-- get_my_lesson_requests() ...` with the roster lookup's three qualified
-- references (rm.id, rm.club_id, rm.claimed_by) reverted to their
-- unqualified 0111 form. Same 0-argument signature throughout — a direct
-- CREATE OR REPLACE, never a DROP; no coexistence concern. No schema or
-- data was written by this migration, so there is nothing to unwind beyond
-- the function body itself.
