-- 0111_staff_managed_lessons_identity.sql
-- Phase 33D1: Staff-Managed Lessons — Identity + RPC Foundation
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Extends the staff-managed + stable-Member-identity model (Phase 33B-33C,
-- now live for court reservations) into the lesson domain. Front desk staff
-- must be able to create and manage a lesson for a Member whether or not
-- that Member currently has a Court Time account. A no-account Member is a
-- real roster_members row — never a Guest.
--
-- The focused audit for this checkpoint found lesson_requests.member_id and
-- .pro_id are BOTH `not null references profiles(id)` — a hard schema-level
-- constraint. A lesson_requests row for a no-account roster Member cannot
-- be created at all under the pre-0111 schema; 0108's own header explicitly
-- deferred this: "pro_lesson reason rows are not backfilled or touched —
-- deferred to 33D1 (Staff-Managed Lessons), per instruction."
--
-- Locked architecture (restated, unchanged):
--   - roster_members.id = permanent club-scoped Member business identity.
--   - lesson_requests.roster_member_id (new) = durable Member attribution.
--     NOT NULL after backfill — every lesson_requests row, without
--     exception, has exactly one roster identity (unlike reservations,
--     which branches on `reason`; lesson_requests has no such branching,
--     so a hard NOT NULL constraint is stronger and appropriate here).
--   - lesson_requests.member_id (existing) = optional authenticated
--     compatibility field. Relaxed to nullable — null for a no-account
--     Member, populated whenever the roster identity happens to be claimed.
--     Never derived live from roster_members.claimed_by at query time.
--   - reservations.roster_member_id (existing column, from 0108 — NOT
--     previously written for reason='pro_lesson') now populated for every
--     pro_lesson reservation, both self-service (accept_lesson_proposal)
--     and staff-created (the new admin_create_member_lesson below).
--   - reservations.owner_user_id on a pro_lesson row keeps its existing,
--     unchanged, "inverted" meaning: the PRO's profiles.id (Phase 33B
--     design doc §15) — never the member. Untouched by this migration.
--   - lesson_requests.pro_id / reservations.owner_user_id (pro_lesson) stay
--     profiles-based. See "Pro identity" below — there is no gap to close.
--
-- Pro identity — evaluated, no gap found, no schema change made:
--   A Pro must already be authenticated to perform any Pro action (propose
--   a time, accept/decline, mark an outcome, view their schedule) — there
--   is no front-desk "book a lesson under a no-account Pro" scenario
--   analogous to booking court time for a no-account Member; the brief
--   itself only asks for Member-side no-account support. Every Pro already
--   has a roster_members row too (0107's backfill covers every club
--   membership, Pro included, with claimed_by set to their own auth id) —
--   inventing a second, roster-based Pro identity model for lessons would
--   duplicate that without closing any real gap. lesson_requests.pro_id
--   and reservations.owner_user_id (pro_lesson) remain profiles-based,
--   unchanged.
--
-- Explicitly OUT OF SCOPE for this migration:
--   - No change to reservations schema (roster_member_id already exists,
--     from 0108) and no change to reservations_member_booking_identity_
--     guard (still scoped to reason='member_booking' only — see the RLS
--     analysis below for why pro_lesson does not need an equivalent).
--   - No change to _lesson_check_pro_availability (Pro identity has no
--     gap — see above). _lesson_check_member_availability IS widened
--     (Section M below) — see the "Member conflict-parity" note below for
--     why this is the SAME existing rule applying correctly, not a new one.
--   - No change to withdraw_lesson_request, decline_lesson_request,
--     reassign_lesson_provider — traced individually below and found to
--     have no reachable null-member_id OR claim-continuity hazard: all
--     three are only reachable for status in ('pending', 'proposed'-
--     non-reschedule), which a staff-created lesson (always created
--     'confirmed') never enters. Left untouched rather than changed
--     defensively for its own sake.
--   - No new product/conflict rule. Every conflict check reused below
--     (court GiST exclude, _lesson_check_pro_availability, _lesson_check_
--     member_availability) is the SAME existing rule, called the same way
--     self-service already calls it — nothing new is invented; Section M
--     widens WHICH rows _lesson_check_member_availability can see, not
--     WHAT it checks for.
--   - No communications/notification kind beyond what already exists
--     ('lesson_request_confirmed' is reused for both new RPCs' relevant
--     notifications; no new `kind` value is added to the CHECK constraint).
--   - reservations table's RLS is untouched (see the security note below).
--   - Not applied by this checkpoint. Not committed.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- CORRECTION PASS (post-initial-draft review) — claim continuity was
-- incomplete
-- ═══════════════════════════════════════════════════════════════════════════
-- The initial draft of this migration treated lesson_requests.member_id as
-- though it reflected the Member's CURRENT account state — it does not,
-- and must not: member_id is a point-in-time snapshot taken at creation,
-- never rewritten merely because the underlying roster identity is later
-- claimed (that would BE the history rewrite this phase exists to avoid).
-- The following were found to incorrectly key off member_id as if it were
-- live, and are corrected below:
--   - get_my_lesson_requests (Section A, new in this pass) — a claimed
--     Member must see a historical lesson attributed to them via roster_
--     member_id even though member_id on that row is still (and will
--     remain) null. Now matches on `member_id = auth.uid() OR roster_
--     member_id = <caller's own current-club roster identity, server-
--     resolved>` — never a client-supplied roster id.
--   - cancel_lesson (Section G) — the Member authorization route now also
--     accepts a caller whose server-resolved current roster identity
--     matches the lesson's roster_member_id, not only a historical
--     member_id match.
--   - propose_lesson_time (Section C) — no longer tests member_id IS NULL
--     as a permanent "no account" signal. Resolves the lesson's roster_
--     members row fresh and uses ITS CURRENT claimed_by: null means still
--     genuinely unclaimed (member_has_no_account remains correct); non-
--     null means that is the current account, and it is who member
--     notifications go to (never v_request.member_id, which may be stale).
--   - accept_lesson_proposal / decline_lesson_proposal (Sections D/E) — the
--     Member-ownership authorization check now also accepts a
--     server-resolved current roster match, not only historical member_id.
--     This is no longer merely defense-in-depth: once propose_lesson_time
--     (above) can legitimately move a null-member_id row into 'proposed'
--     for a NOW-claimed Member, accept/decline are genuinely reachable via
--     the roster route, not just the historical one.
--   - get_pro_lesson_requests (Section H) — member_claimed now reflects
--     roster_members.claimed_by IS NOT NULL (current state), not merely
--     whether historical lesson_requests.member_id was populated. The
--     profiles join for member name/claim state is now keyed off
--     roster_members.claimed_by, not lesson_requests.member_id.
-- None of this backfills or rewrites member_id anywhere — every fix above
-- is a READ-time correction (which rows a query can see/authorize), never
-- a WRITE to historical data. The one legitimate write path that changes
-- member_id — admin_update_member_lesson's explicit, audited Member
-- reassignment — is unchanged and is not a "claim rewrite" (it mirrors
-- 0109's reservations precedent: an explicit admin action, not a passive
-- side effect of someone claiming their account).
--
-- Why these RPCs resolve the caller's own roster identity with an inline
-- query (`select id from roster_members where club_id = v_profile.club_id
-- and claimed_by = auth.uid()`) rather than calling 0110's current_user_
-- roster_member_id() helper: that helper internally resolves club via
-- current_user_club_id() (the Phase 26 active-membership source), while
-- every RPC in this file that predates Phase 26 resolves club via
-- v_profile.club_id (the older profiles-direct source). The two are
-- expected to agree in the common case, but this file's own established
-- convention (restated in Section F1/F2 above) is to modify these
-- pre-Phase-26 RPCs only as strictly required, not migrate their club-
-- resolution source as a drive-by change — mixing the two sources within
-- a single function body would risk a subtle mismatch between "the club
-- this function is already operating in" and "the club the helper
-- resolves," which is a worse outcome than one extra inline query. The
-- PATTERN (server-resolved-only, never client-supplied) is reused
-- throughout; the literal helper function is not called from here.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- CORRECTION PASS — Member conflict-parity for _lesson_check_member_
-- availability (Section M)
-- ═══════════════════════════════════════════════════════════════════════════
-- The initial draft skipped _lesson_check_member_availability entirely
-- for an unclaimed roster Member (admin_create/admin_update_member_
-- lesson's own `if v_member_id is not null then` gate) — making an
-- EXISTING lesson-domain conflict rule silently depend on whether the
-- Member has an account. Inspected the function's three existing conflict
-- categories individually to find the smallest correct fix:
--   1. Overlapping court reservations (`r.owner_user_id = p_member_id`) —
--      FIXABLE with existing data: reservations.roster_member_id is
--      populated for both member_booking (since 0108) and, as of this
--      very migration, pro_lesson reservations — so this category is
--      widened to also match `r.roster_member_id = p_roster_member_id`.
--   2. Overlapping event participation (`event_participants.profile_id =
--      p_member_id`) — NOT FIXABLE without a cross-domain change:
--      event_participants has no roster-identity column, and a no-account
--      Member cannot join an event at all today (joining requires an
--      authenticated profile_id) — there is no data this category could
--      check for a no-account Member. This is a genuine, reported
--      limitation, not silently invented around: extending it would mean
--      touching the events/programs schema, explicitly out of scope for
--      33D1 ("Do NOT start programs/events (33D2)"). BLOCKER, reported as
--      such — not expanded into. This category remains member_id-only
--      (skipped entirely when p_member_id is null), exactly as before.
--   3. Overlapping confirmed lessons (`lesson_requests.member_id =
--      p_member_id AND status = 'confirmed'`) — FIXABLE with existing
--      data, same-migration, non-cross-domain: this is the very table
--      this migration adds roster_member_id to. Widened to also match
--      `lesson_requests.roster_member_id = p_roster_member_id`.
-- p_roster_member_id is a NEW required parameter (Section M is a DROP +
-- CREATE — private function, 0101 precedent already established this
-- exact pattern for this exact function when p_exclude_request_id was
-- added: "a stray old overload has no security exposure... but the old
-- signature is dropped anyway to leave exactly one"). Every call site is
-- updated to pass it; admin_create/admin_update_member_lesson's "only
-- when claimed" gate is removed — the function is now called
-- unconditionally, and correctly narrows itself internally per category.
-- A claimed Member's own result set is unchanged in the ordinary case
-- (owner_user_id/member_id already implies the same roster_member_id by
-- construction) — the one case where it now differs is a claimed Member
-- whose OWN pre-claim, staff-created reservation/lesson (owner_user_id/
-- member_id null, roster_member_id set to them) would previously have
-- been invisible to this check and is now correctly counted as a
-- conflict. This is a completion of the existing rule's intent — the same
-- Phase 33C3 claim-continuity principle applied to conflict-checking, not
-- a new restriction — and is called out explicitly here rather than left
-- as a silent behavior change.
--
-- RLS / trigger-guard analysis — why no new DB-level structural guard is
-- added here, unlike 0108's reservations_member_booking_identity_guard:
--   0108 needed a trigger because reservations_insert_own's RLS WITH CHECK
--   permits a direct, RLS-authorized client INSERT for reason=
--   'member_booking' (owner_user_id = auth.uid(), created_by = auth.uid())
--   — a gap only a DB-level trigger could close, since RLS cannot see
--   roster_members. Neither gap exists here:
--     1. reservations_insert_own's WITH CHECK requires reason =
--        'member_booking' explicitly (0003) — there is NO RLS policy that
--        permits any direct client INSERT of a reason='pro_lesson' row at
--        all. Every pro_lesson reservation can only ever be created by a
--        SECURITY DEFINER RPC (accept_lesson_proposal or the new
--        admin_create_member_lesson below) — both fully control and
--        validate roster_member_id themselves.
--     2. lesson_requests has ZERO INSERT/UPDATE/DELETE RLS policies at
--        all (only three SELECT policies, from 0069) — every mutation,
--        with or without this migration, already goes exclusively through
--        SECURITY DEFINER RPCs. There is no RLS-permitted direct client
--        write this migration could be leaving unguarded.
--   A structural trigger would therefore be defense-in-depth against a
--   hazard that does not exist, duplicating the reservations-domain
--   pattern without a corresponding gap to justify it. Not added.
--
-- Genuine correctness/security fixes required by relaxing member_id to
-- nullable (NOT a scope-expanding redesign — these are the minimum
-- necessary consequences of allowing member_id = NULL to exist at all,
-- traced individually per RPC below):
--   - propose_lesson_time: without a guard, calling this on a lesson with
--     member_id = NULL would reach `insert into notifications (...,
--     user_id, ...) values (..., v_request.member_id, ...)` with a NULL
--     user_id — notifications.user_id is NOT NULL, so this would hard-
--     crash with a raw constraint-violation error instead of a clean,
--     intentional one. Fixed with a single early guard (member_has_no_
--     account) — see Section C.
--   - accept_lesson_proposal / decline_lesson_proposal: both authorize via
--     `if v_request.member_id <> auth.uid() then raise 'not_your_request'`.
--     Postgres three-valued logic: NULL <> anything is NULL, not TRUE, so
--     this comparison silently fails to raise when member_id is NULL —
--     any authenticated user could otherwise pass this check. Unreachable
--     in practice once propose_lesson_time's guard prevents status from
--     ever reaching 'proposed' on a null-member_id row, but fixed at the
--     authorization check itself too (defense-in-depth on the actual
--     security boundary, not just its one current entry point) — see
--     Sections D/E.
--   - cancel_lesson: authorizes via `member_id <> auth.uid() AND pro_id <>
--     auth.uid() AND role <> 'admin'`. Unlike accept/decline above, this
--     status guard EXPLICITLY allows status='confirmed' — reachable for a
--     staff-created no-account lesson. Three-valued logic: for a caller
--     who is neither the pro nor an admin, `NULL AND TRUE AND TRUE`
--     evaluates to NULL, not TRUE — the IF does not raise, and cancellation
--     is silently PERMITTED for a random authenticated club member. This
--     is a genuine, reachable authorization bypass this migration's own
--     schema change would introduce if left unfixed. Fixed with a null-
--     safe rewrite of the same check — see Section G.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- A. SCHEMA — lesson_requests.roster_member_id, member_id relaxed
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.lesson_requests
  alter column member_id drop not null;

alter table public.lesson_requests
  add column if not exists roster_member_id uuid references public.roster_members(id);

comment on column public.lesson_requests.roster_member_id is
  'Phase 33D1: permanent Member attribution — the roster_members.id this '
  'lesson request is/was for, regardless of whether that identity is '
  'authenticated. NOT NULL after this migration''s backfill; every future '
  'row sets it at creation (submit_lesson_request, admin_create_member_'
  'lesson). Never reassigned once set except by admin_update_member_lesson''s '
  'explicit, audited Member-reassignment path.';

comment on column public.lesson_requests.member_id is
  'OPTIONAL, HISTORICAL, POINT-IN-TIME compatibility field — a snapshot of '
  'the authenticated account at creation (or last explicit admin '
  'reassignment via admin_update_member_lesson), NOT a live reflection of '
  'current account state. Do NOT use this column to infer whether the '
  'Member currently has an account: it is never rewritten merely because '
  'the underlying roster identity is later claimed (that would be a '
  'history rewrite). To resolve the CURRENT authenticated account for a '
  'lesson, read roster_members.claimed_by via roster_member_id instead — '
  'that is the only live source of truth. roster_member_id is the durable '
  'identity; this column is not.';

create index if not exists lesson_requests_roster_member_id_idx
  on public.lesson_requests (roster_member_id);

-- ── Fail-closed backfill guard ──────────────────────────────────────────────
-- Every existing lesson_requests row has member_id NOT NULL (pre-migration
-- schema guaranteed this) and was created only by an authenticated club
-- member — the same guarantee 0108's own reservations.owner_user_id
-- backfill relied on. 33B1's backfill (0107) covered every club_membership,
-- including removed ones, into roster_members with claimed_by set — so
-- every historical member_id should resolve to exactly one roster identity
-- via (roster_members.claimed_by = lesson_requests.member_id AND
-- roster_members.club_id = lesson_requests.club_id). This guard verifies
-- that independently before the backfill UPDATE runs, and refuses to
-- proceed — the whole migration rolls back — if even one row cannot
-- resolve. No partial backfill, no fabricated identity.
do $$
declare
  v_unresolved int;
begin
  select count(*) into v_unresolved
    from public.lesson_requests lr
   where lr.member_id is not null
     and not exists (
       select 1 from public.roster_members rm
        where rm.claimed_by = lr.member_id
          and rm.club_id    = lr.club_id
     );

  if v_unresolved > 0 then
    raise exception
      'phase33d1_unresolved_lesson_request_identities: % lesson_requests row(s) cannot resolve exactly one roster identity via (roster_members.claimed_by = lesson_requests.member_id AND roster_members.club_id = lesson_requests.club_id). Run supabase/scripts/verify_phase33d1_preflight.sql for per-row detail — this most likely means a member_id/club_id pairing was never backfilled into roster_members by 33B1. Resolve manually (do not fabricate a roster identity), then re-run this migration. No partial backfill will be applied.',
      v_unresolved;
  end if;
end $$;

update public.lesson_requests lr
   set roster_member_id = rm.id
  from public.roster_members rm
 where rm.claimed_by = lr.member_id
   and rm.club_id    = lr.club_id
   and lr.roster_member_id is null;

-- Guard already proved every row resolves — this NOT NULL is safe to apply
-- immediately. Unlike reservations.roster_member_id (nullable — branches on
-- `reason`), every lesson_requests row needs one, without exception.
alter table public.lesson_requests
  alter column roster_member_id set not null;


-- ═══════════════════════════════════════════════════════════════════════════
-- B. submit_lesson_request — resolve and write the caller's own roster
--    identity. Same 6-argument signature as 0072 — CREATE OR REPLACE only.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.submit_lesson_request(
  p_pro_id             uuid,
  p_duration_minutes   int,
  p_preferred_court_id uuid    default null,
  p_member_note        text    default null,
  p_preferred_windows  jsonb   default null,
  p_lesson_type_id     uuid    default null
)
returns public.lesson_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile           public.profiles%rowtype;
  v_pro                public.profiles%rowtype;
  v_result             public.lesson_requests%rowtype;
  -- Phase 33D1: the caller's own durable Member identity for this club.
  v_roster_member_id   uuid;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;
  if v_profile.status <> 'active' then raise exception 'account_inactive'; end if;

  -- Phase 33D1: resolve the caller's own roster identity in this club.
  -- Never client-supplied — auth.uid() and v_profile.club_id are both
  -- server-derived, matching create_reservation's identical 0108 pattern.
  -- Fails closed: every active club member is expected to have one after
  -- 33B1's backfill and accept_club_invite's fail-closed roster
  -- resolution, so this should never legitimately raise.
  select id into v_roster_member_id
    from public.roster_members
   where club_id    = v_profile.club_id
     and claimed_by = auth.uid();
  if not found then raise exception 'no_roster_identity'; end if;

  -- Validate pro: active, same club, role pro or admin, is_lesson_provider = true
  select * into v_pro
    from public.profiles
   where id      = p_pro_id
     and club_id = v_profile.club_id
     and status  = 'active'
     and role    in ('pro', 'admin')
     and is_lesson_provider = true;
  if not found then raise exception 'pro_not_found'; end if;

  if p_pro_id = auth.uid() then raise exception 'cannot_request_yourself'; end if;

  -- Duration: positive multiple of 15 minutes, minimum 30
  if p_duration_minutes < 30 or p_duration_minutes % 15 <> 0 then
    raise exception 'invalid_duration';
  end if;

  -- Input length validation
  if length(p_member_note) > 500 then raise exception 'note_too_long'; end if;

  -- Validate optional preferred court
  if p_preferred_court_id is not null and not exists (
    select 1 from public.courts
     where id       = p_preferred_court_id
       and club_id  = v_profile.club_id
       and is_active = true
  ) then
    raise exception 'court_not_found';
  end if;

  -- Validate optional lesson type (active, same club)
  if p_lesson_type_id is not null then
    if not exists (
      select 1 from public.lesson_types
       where id       = p_lesson_type_id
         and club_id  = v_profile.club_id
         and is_active = true
    ) then
      raise exception 'lesson_type_not_found';
    end if;

    -- Enforce that requested duration is among the type's allowed durations (when set)
    if exists (
      select 1 from public.lesson_types lt
       where lt.id            = p_lesson_type_id
         and lt.allowed_durations is not null
         and array_length(lt.allowed_durations, 1) > 0
         and not (p_duration_minutes = any(lt.allowed_durations))
    ) then
      raise exception 'duration_not_allowed_for_type';
    end if;
  end if;

  insert into public.lesson_requests (
    club_id, member_id, pro_id, roster_member_id,
    preferred_court_id, duration_minutes,
    member_note, preferred_windows, status,
    lesson_type_id,
    last_actor_id, last_actor_role
  ) values (
    v_profile.club_id,
    auth.uid(),
    p_pro_id,
    v_roster_member_id,
    p_preferred_court_id,
    p_duration_minutes,
    btrim(coalesce(p_member_note, '')),
    p_preferred_windows,
    'pending',
    p_lesson_type_id,
    auth.uid(), 'member'
  ) returning * into v_result;

  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    p_pro_id,
    'lesson_request_received',
    trim(coalesce(v_profile.first_name, '') || ' ' || coalesce(v_profile.last_name, '')) ||
      ' has requested a ' || p_duration_minutes || '-minute lesson.',
    jsonb_build_object('request_id', v_result.id, 'target_path', '/events?tab=lessons')
  );

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'submit_lesson_request', 'lesson_request', v_result.id,
    jsonb_build_object('pro_id', p_pro_id, 'duration_minutes', p_duration_minutes, 'roster_member_id', v_roster_member_id)
  );

  return v_result;
end;
$$;

revoke execute on function public.submit_lesson_request(uuid, int, uuid, text, jsonb, uuid) from public, anon;
grant  execute on function public.submit_lesson_request(uuid, int, uuid, text, jsonb, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- C. propose_lesson_time — early guard: a lesson whose roster identity is
--    CURRENTLY unclaimed cannot enter (or continue) the propose/accept
--    negotiation cycle. Same 5-argument signature as 0101 — CREATE OR
--    REPLACE only.
-- ═══════════════════════════════════════════════════════════════════════════
-- Full body otherwise byte-for-byte unchanged from 0101 — the guard tests
-- the lesson's roster_members row CURRENT claimed_by (not historical
-- member_id — see the migration header's claim-continuity correction) and
-- every downstream member-notification/conflict-check call site uses that
-- same freshly-resolved current identity, immediately after the request
-- is fetched/locked and before any other logic runs, so it applies
-- uniformly whether this call would start a first proposal
-- (status='pending') or a reschedule (status='confirmed'/'proposed').

create or replace function public.propose_lesson_time(
  p_request_id            uuid,
  p_expected_updated_at   timestamptz,
  p_starts_at             timestamptz,
  p_ends_at               timestamptz,
  p_court_id              uuid default null
)
returns public.lesson_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile        public.profiles%rowtype;
  v_request        public.lesson_requests%rowtype;
  v_result         public.lesson_requests%rowtype;
  v_old_reservation public.reservations%rowtype;
  v_is_reschedule  boolean;
  v_tz             text;
  -- Phase 33D1 correction: the lesson's CURRENT roster claim state — never
  -- read from historical v_request.member_id, which is a point-in-time
  -- snapshot that is not rewritten when the underlying identity is later
  -- claimed.
  v_current_member_id uuid;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;
  if v_profile.role not in ('pro', 'admin') then raise exception 'insufficient_role'; end if;

  select * into v_request
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_profile.club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  -- Phase 33D1 correction: resolve the lesson's roster identity fresh and
  -- use ITS CURRENT claimed_by, not the historical v_request.member_id
  -- snapshot. A lesson created for a no-account Member who has since
  -- claimed their account is now correctly eligible for this negotiation
  -- cycle; one that is still genuinely unclaimed correctly is not. This
  -- RPC's negotiation cycle (propose → member accepts/declines)
  -- structurally requires an authenticated Member to respond — a Member
  -- with no CURRENT account has no session and can never call accept_
  -- lesson_proposal/decline_lesson_proposal — proceeding here would either
  -- strand the request in 'proposed' forever, or (see accept/decline's own
  -- fix) let a stale-vs-current identity mismatch admit the wrong caller.
  -- Direct edits for a still-unclaimed Member's lesson go through admin_
  -- update_member_lesson instead (Section F2).
  select claimed_by into v_current_member_id
    from public.roster_members
   where id = v_request.roster_member_id;

  if v_current_member_id is null then
    raise exception 'member_has_no_account';
  end if;

  if v_profile.role = 'pro' and v_request.pro_id <> auth.uid() then
    raise exception 'not_assigned_pro';
  end if;

  -- 'confirmed' begins a reschedule; a 'proposed' request whose
  -- linked_reservation_id is already set is an in-flight reschedule that
  -- may be revised again before the member responds.
  if v_request.status not in ('pending', 'proposed', 'confirmed') then
    raise exception 'invalid_status_for_propose';
  end if;

  -- Optimistic concurrency.
  if v_request.updated_at is distinct from p_expected_updated_at then
    raise exception 'stale_edit_conflict';
  end if;

  v_is_reschedule := v_request.linked_reservation_id is not null;

  -- Authoritative original confirmed lesson. Once a reschedule is pending,
  -- lesson_requests.proposed_starts_at holds the *new* candidate, not the
  -- original — the still-active linked reservation is the only reliable
  -- source of the currently-confirmed court/time.
  if v_is_reschedule then
    select * into v_old_reservation
      from public.reservations
     where id      = v_request.linked_reservation_id
       and club_id = v_profile.club_id
       and reason  = 'pro_lesson'
       and status  = 'confirmed'
     for update;
    if not found then raise exception 'linked_reservation_not_found'; end if;

    if v_old_reservation.starts_at <= now() then
      raise exception 'cannot_reschedule_started_lesson';
    end if;
  end if;

  if p_starts_at <= now() then raise exception 'cannot_propose_past_time'; end if;
  if p_ends_at   <= p_starts_at then raise exception 'invalid_duration'; end if;

  if round(extract(epoch from (p_ends_at - p_starts_at)) / 60)::int <> v_request.duration_minutes then
    raise exception 'duration_mismatch';
  end if;

  -- ── Preflight conflict validation ─────────────────────────────────────────
  -- The still-active original lesson (and only that reservation) is excluded
  -- from every check below, so it never conflicts with its own proposed
  -- replacement. No other reservation is excluded. This is a preflight
  -- convenience only — acceptance re-validates via the GiST exclusion
  -- constraint, which remains the final authority.

  if p_court_id is not null then
    if not exists (
      select 1 from public.courts
       where id        = p_court_id
         and club_id   = v_profile.club_id
         and is_active = true
    ) then
      raise exception 'court_not_found';
    end if;

    if exists (
      select 1 from public.reservations r
       where r.court_id = p_court_id
         and r.status   in ('pending', 'confirmed')
         and tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')
         and (r.id is distinct from v_request.linked_reservation_id)
    ) then
      raise exception 'court_conflict';
    end if;
  end if;

  -- Operating hours
  select timezone into v_tz from public.clubs where id = v_profile.club_id;
  perform public._lesson_check_operating_hours(
    v_profile.club_id,
    p_starts_at,
    p_ends_at,
    v_tz
  );

  -- Pro conflicts — excludes this request's own linked reservation (the
  -- pro's own currently-confirmed lesson) so a reschedule never
  -- self-conflicts.
  perform public._lesson_check_pro_availability(
    v_request.pro_id,
    p_starts_at,
    p_ends_at,
    v_request.id
  );

  -- Member conflicts — same self-exclusion. Phase 33D1 correction: uses
  -- v_current_member_id (the lesson's CURRENT roster claimed_by, resolved
  -- above — guaranteed non-null past the guard) rather than historical
  -- member_id, plus the durable roster_member_id for the widened,
  -- roster-aware conflict categories (Section M).
  perform public._lesson_check_member_availability(
    v_current_member_id,
    v_request.roster_member_id,
    p_starts_at,
    p_ends_at,
    v_request.id
  );

  -- ── Commit ────────────────────────────────────────────────────────────────
  -- linked_reservation_id and confirmed_at are never in this SET list —
  -- the original confirmed reservation and its confirmation history are
  -- preserved untouched throughout the pending-proposal window.

  update public.lesson_requests
     set status             = 'proposed',
         proposed_starts_at = p_starts_at,
         proposed_ends_at   = p_ends_at,
         proposed_court_id  = p_court_id,
         last_actor_id      = auth.uid(),
         last_actor_role    = v_profile.role,
         updated_at         = now()
   where id = p_request_id
  returning * into v_result;

  -- Phase 33D1 correction: addressed to v_current_member_id (the CURRENT
  -- claimed_by, resolved above), not historical v_request.member_id —
  -- required for claim continuity (a lesson claimed after creation must
  -- notify the now-current account, and this is also what avoids a
  -- NOT NULL user_id crash for a still-unclaimed row, which the guard
  -- above already prevents reaching this point at all).
  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    v_current_member_id,
    'lesson_request_proposed',
    trim(coalesce(v_profile.first_name, '') || ' ' || coalesce(v_profile.last_name, '')) ||
      case when v_is_reschedule
           then ' proposed a new time for your confirmed lesson. Please review and respond.'
           else ' proposed a time for your lesson. Please review and respond.'
      end,
    jsonb_build_object('request_id', p_request_id, 'target_path', '/lessons')
  );

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'propose_lesson_time', 'lesson_request', p_request_id,
    jsonb_build_object(
      'proposed_starts_at', p_starts_at,
      'proposed_ends_at',   p_ends_at,
      'court_id',           p_court_id,
      'is_reschedule',      v_is_reschedule
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.propose_lesson_time(uuid, timestamptz, timestamptz, timestamptz, uuid) from public, anon;
grant  execute on function public.propose_lesson_time(uuid, timestamptz, timestamptz, timestamptz, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- D. accept_lesson_proposal — roster-aware Member-ownership authorization
--    (required for claim continuity — genuinely reachable, not merely
--    defense-in-depth, now that Section C's propose_lesson_time can move
--    a null-member_id row into 'proposed' once its roster identity is
--    claimed) + writes roster_member_id onto the resulting reservation.
--    Same 1-argument signature as 0101 — CREATE OR REPLACE only.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.accept_lesson_proposal(
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile         public.profiles%rowtype;
  v_request         public.lesson_requests%rowtype;
  v_pro             public.profiles%rowtype;
  v_member          public.profiles%rowtype;
  v_old_reservation public.reservations%rowtype;
  v_is_reschedule   boolean;
  v_tz              text;
  v_res_id          uuid;
  v_time_label      text;
  -- Phase 33D1 correction: the caller's own current roster identity in
  -- this club, server-resolved only — never a client-supplied roster id.
  v_caller_roster_id uuid;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  -- Fetch and row-lock
  select * into v_request
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_profile.club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  select id into v_caller_roster_id
    from public.roster_members
   where club_id    = v_profile.club_id
     and claimed_by = auth.uid();

  -- Phase 33D1 correction: authorized if the caller matches EITHER the
  -- historical member_id snapshot OR the lesson's durable roster_
  -- member_id via the caller's own current roster identity — the second
  -- branch is what makes this valid after a previously-unclaimed roster
  -- identity is later claimed (member_id stays null forever on that row;
  -- only the roster route can ever authorize it). Written as explicit
  -- `is not null and =` comparisons throughout rather than `<>`, so there
  -- is no three-valued-NULL-logic trap to reason about — a null on either
  -- side simply fails to match, never silently admits.
  if not (
    (v_request.member_id is not null and v_request.member_id = auth.uid())
    or (v_caller_roster_id is not null and v_request.roster_member_id = v_caller_roster_id)
  ) then
    raise exception 'not_your_request';
  end if;

  -- Must be in 'proposed' status
  if v_request.status <> 'proposed' then raise exception 'invalid_status_for_accept'; end if;

  -- proposed_starts_at / proposed_ends_at must be populated (enforced by constraint but guard anyway)
  if v_request.proposed_starts_at is null or v_request.proposed_ends_at is null then
    raise exception 'proposed_time_missing';
  end if;

  -- Proposed time must still be in the future
  if v_request.proposed_starts_at <= now() then raise exception 'proposed_time_in_past'; end if;

  -- Court required
  if v_request.proposed_court_id is null then raise exception 'proposed_court_missing'; end if;

  -- Revalidate the proposed court is still active and belongs to this club
  -- — it may have been deactivated at any point between proposal and
  -- acceptance. Uses the same court_not_found vocabulary as
  -- propose_lesson_time's own court check. Applies to every acceptance,
  -- not only a reschedule — accept_lesson_proposal previously trusted
  -- proposed_court_id unconditionally.
  if not exists (
    select 1 from public.courts
     where id        = v_request.proposed_court_id
       and club_id   = v_profile.club_id
       and is_active = true
  ) then
    raise exception 'court_not_found';
  end if;

  v_is_reschedule := v_request.linked_reservation_id is not null;

  -- Reschedule: lock and soft-cancel the old confirmed reservation before
  -- inserting its replacement, in this same transaction. Any failure below
  -- (including a genuine court conflict on the new slot, raised as Postgres
  -- 23P01 by the GiST exclusion constraint) rolls back this entire
  -- function, so the old reservation is left exactly as it was —
  -- 'confirmed' — never left cancelled with no replacement.
  if v_is_reschedule then
    select * into v_old_reservation
      from public.reservations
     where id      = v_request.linked_reservation_id
       and club_id = v_profile.club_id
       and reason  = 'pro_lesson'
       and status  = 'confirmed'
     for update;
    if not found then raise exception 'linked_reservation_not_found'; end if;

    -- The original lesson may have started (or already ended) in the time
    -- between proposal and acceptance. Checked before any mutation —
    -- including the old reservation's own cancellation below — so a stale
    -- acceptance can never cancel a lesson that has already happened.
    if v_old_reservation.starts_at <= now() then
      raise exception 'cannot_reschedule_started_lesson';
    end if;

    update public.reservations
       set status            = 'cancelled',
           cancelled_at      = now(),
           cancelled_by      = auth.uid(),
           cancellation_kind = 'system',
           updated_at        = now()
     where id = v_old_reservation.id;
  end if;

  -- Operating hours check
  select timezone into v_tz from public.clubs where id = v_profile.club_id;
  perform public._lesson_check_operating_hours(
    v_profile.club_id,
    v_request.proposed_starts_at,
    v_request.proposed_ends_at,
    v_tz
  );

  -- Pro availability check — excludes this request's own (already
  -- soft-cancelled above, if a reschedule) linked reservation.
  perform public._lesson_check_pro_availability(
    v_request.pro_id,
    v_request.proposed_starts_at,
    v_request.proposed_ends_at,
    v_request.id
  );

  -- Member availability check (caller is the member accepting). Phase
  -- 33D1: widened args — auth.uid() is the caller's own current account
  -- (always correct here regardless of claim timing, since the caller
  -- just proved ownership above), plus the durable roster_member_id for
  -- the widened conflict categories (Section M).
  perform public._lesson_check_member_availability(
    auth.uid(),
    v_request.roster_member_id,
    v_request.proposed_starts_at,
    v_request.proposed_ends_at,
    v_request.id
  );

  -- Fetch names for notifications
  select * into v_pro    from public.profiles where id = v_request.pro_id;
  select * into v_member from public.profiles where id = auth.uid();

  -- Create the replacement reservation (GiST EXCLUDE handles court conflicts
  -- atomically). Phase 33D1: roster_member_id added — v_request.roster_
  -- member_id was already resolved and stored at submission time
  -- (submit_lesson_request), so it is reused directly here rather than
  -- re-resolved; it is the same durable identity throughout this lesson's
  -- lifecycle.
  insert into public.reservations (
    club_id, court_id, owner_user_id, roster_member_id,
    starts_at, ends_at, status, reason,
    notes, show_notes_to_members, created_by
  ) values (
    v_profile.club_id,
    v_request.proposed_court_id,
    v_request.pro_id,
    v_request.roster_member_id,
    v_request.proposed_starts_at,
    v_request.proposed_ends_at,
    'confirmed',
    'pro_lesson',
    'Pro lesson with ' || trim(coalesce(v_member.first_name, '') || ' ' || coalesce(v_member.last_name, '')),
    false,
    auth.uid()
  ) returning id into v_res_id;

  -- Update the request
  update public.lesson_requests
     set status               = 'confirmed',
         linked_reservation_id = v_res_id,
         confirmed_at         = now(),
         last_actor_id        = auth.uid(),
         last_actor_role      = 'member',
         updated_at           = now()
   where id = p_request_id;

  v_time_label := to_char(v_request.proposed_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM');

  -- Notify member
  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'lesson_request_confirmed',
    'Your lesson with ' ||
      trim(coalesce(v_pro.first_name, '') || ' ' || coalesce(v_pro.last_name, '')) ||
      ' is confirmed for ' || v_time_label || '.',
    jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id)
  );

  -- Notify pro
  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    v_request.pro_id,
    'lesson_request_confirmed',
    'Lesson with ' ||
      trim(coalesce(v_member.first_name, '') || ' ' || coalesce(v_member.last_name, '')) ||
      ' confirmed for ' || v_time_label || '.',
    jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id)
  );

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'accept_lesson_proposal', 'lesson_request', p_request_id,
    jsonb_build_object(
      'reservation_id',     v_res_id,
      'new_reservation_id', v_res_id,
      'old_reservation_id', case when v_is_reschedule then v_old_reservation.id else null end,
      'is_reschedule',      v_is_reschedule,
      'roster_member_id',   v_request.roster_member_id
    )
  );

  return jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id);
end;
$$;

revoke execute on function public.accept_lesson_proposal(uuid) from public, anon;
grant  execute on function public.accept_lesson_proposal(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- E. decline_lesson_proposal — same roster-aware Member-ownership
--    authorization fix as accept_lesson_proposal (Section D). Same
--    1-argument signature as 0101 — CREATE OR REPLACE only. Full body
--    otherwise unchanged.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.decline_lesson_proposal(
  p_request_id uuid
)
returns public.lesson_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile         public.profiles%rowtype;
  v_request         public.lesson_requests%rowtype;
  v_result          public.lesson_requests%rowtype;
  v_old_reservation public.reservations%rowtype;
  v_is_reschedule   boolean;
  v_caller_roster_id uuid;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  select * into v_request
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_profile.club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  select id into v_caller_roster_id
    from public.roster_members
   where club_id    = v_profile.club_id
     and claimed_by = auth.uid();

  -- Phase 33D1 correction: see accept_lesson_proposal (Section D) for why
  -- the roster-based branch is required, not merely defense-in-depth.
  if not (
    (v_request.member_id is not null and v_request.member_id = auth.uid())
    or (v_caller_roster_id is not null and v_request.roster_member_id = v_caller_roster_id)
  ) then
    raise exception 'not_your_request';
  end if;
  if v_request.status <> 'proposed' then raise exception 'invalid_status_for_decline_proposal'; end if;

  v_is_reschedule := v_request.linked_reservation_id is not null;

  if v_is_reschedule then
    -- Restore from the still-untouched linked reservation — the
    -- authoritative original confirmed lesson. Locked FOR UPDATE before
    -- reading, consistent with every other place this migration treats
    -- the linked reservation as authoritative. The reservation itself is
    -- left completely alone; only the request's status and proposed_*
    -- fields are reverted to mirror it again.
    select * into v_old_reservation
      from public.reservations
     where id      = v_request.linked_reservation_id
       and club_id = v_profile.club_id
       and reason  = 'pro_lesson'
       and status  = 'confirmed'
     for update;
    if not found then raise exception 'linked_reservation_not_found'; end if;

    update public.lesson_requests
       set status              = 'confirmed',
           proposed_starts_at  = v_old_reservation.starts_at,
           proposed_ends_at    = v_old_reservation.ends_at,
           proposed_court_id   = v_old_reservation.court_id,
           last_actor_id       = auth.uid(),
           last_actor_role     = 'member',
           updated_at          = now()
     where id = p_request_id
    returning * into v_result;
  else
    update public.lesson_requests
       set status              = 'pending',
           proposed_starts_at  = null,
           proposed_ends_at    = null,
           proposed_court_id   = null,
           last_actor_id       = auth.uid(),
           last_actor_role     = 'member',
           updated_at          = now()
     where id = p_request_id
    returning * into v_result;
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'decline_lesson_proposal', 'lesson_request', p_request_id,
    jsonb_build_object(
      'previous_proposed_starts_at', v_request.proposed_starts_at,
      'is_reschedule',               v_is_reschedule,
      'restored_starts_at',          case when v_is_reschedule then v_old_reservation.starts_at else null end
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.decline_lesson_proposal(uuid) from public, anon;
grant  execute on function public.decline_lesson_proposal(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- G. cancel_lesson — REQUIRED authorization fix, now roster-aware (see
--    migration header — this is a genuine, reachable bypass, not
--    defense-in-depth; the correction pass additionally adds the roster-
--    based Member route needed for claim continuity). Same 2-argument
--    signature as 0101 — CREATE OR REPLACE only.
-- ═══════════════════════════════════════════════════════════════════════════
-- (Section lettered G, not F, to keep the letter aligned with this
-- migration's own internal numbering used in the header/audit trail —
-- F is reserved for the new-RPC pair below to read in creation order.)

create or replace function public.cancel_lesson(
  p_request_id uuid,
  p_reason     text default null
)
returns public.lesson_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile          public.profiles%rowtype;
  v_request          public.lesson_requests%rowtype;
  v_actor_role        text;
  v_result            public.lesson_requests%rowtype;
  v_member             public.profiles%rowtype;
  v_pro                public.profiles%rowtype;
  v_window_hours       int;
  v_old_reservation    public.reservations%rowtype;
  v_effective_starts_at timestamptz;
  -- Phase 33D1 correction: the caller's own current roster identity in
  -- this club, server-resolved only — never a client-supplied roster id.
  v_caller_roster_id    uuid;
  v_is_member_by_history boolean;
  v_is_member_by_roster  boolean;
  v_is_pro               boolean;
  v_is_admin             boolean;
  -- Phase 33D1 correction: the lesson's CURRENT roster claim state and
  -- name — never read from historical v_request.member_id, which is not
  -- rewritten when the underlying identity is later claimed.
  v_roster              public.roster_members%rowtype;
  v_current_member_id   uuid;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  select * into v_request
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_profile.club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  select id into v_caller_roster_id
    from public.roster_members
   where club_id    = v_profile.club_id
     and claimed_by = auth.uid();

  select * into v_roster from public.roster_members where id = v_request.roster_member_id;
  v_current_member_id := v_roster.claimed_by;

  -- Phase 33D1 correction: rewritten as explicit boolean checks, each
  -- using `is not null and =` rather than `<>`, so there is no three-
  -- valued-NULL-logic trap to reason about at all (the prior coalesce(...,
  -- true) form fixed the original bypass but was harder to extend
  -- correctly). v_is_member_by_roster is the required addition for claim
  -- continuity: member_id is a historical snapshot that is never rewritten
  -- when a previously-unclaimed roster identity is later claimed, so the
  -- historical-only check would incorrectly deny that Member forever.
  -- Authorized if the caller is the historical member, OR currently owns
  -- this lesson's durable roster identity, OR is the assigned pro, OR is
  -- an admin.
  v_is_member_by_history := v_request.member_id is not null and v_request.member_id = auth.uid();
  v_is_member_by_roster  := v_caller_roster_id is not null and v_request.roster_member_id = v_caller_roster_id;
  v_is_pro                := v_request.pro_id = auth.uid();
  v_is_admin               := v_profile.role = 'admin';

  if not (v_is_member_by_history or v_is_member_by_roster or v_is_pro or v_is_admin) then
    raise exception 'not_authorised_to_cancel';
  end if;

  -- Eligible: an ordinary confirmed lesson, or a confirmed lesson with a
  -- reschedule proposal currently pending (status='proposed' with a linked
  -- reservation still active). An ordinary first-time proposal
  -- (status='proposed', linked_reservation_id null) remains ineligible —
  -- it is declined or withdrawn, never "cancelled".
  if not (
    v_request.status = 'confirmed'
    or (v_request.status = 'proposed' and v_request.linked_reservation_id is not null)
  ) then
    raise exception 'invalid_status_for_cancel';
  end if;

  -- Authoritative original confirmed lesson time. Once a reschedule is
  -- pending, proposed_starts_at holds the new candidate, not the lesson
  -- that is actually still on the calendar — the linked reservation (if
  -- any) is locked here and used for every time-based guard below.
  if v_request.linked_reservation_id is not null then
    select * into v_old_reservation
      from public.reservations
     where id      = v_request.linked_reservation_id
       and club_id = v_profile.club_id
       and reason  = 'pro_lesson'
       and status  = 'confirmed'
     for update;
    if not found then raise exception 'linked_reservation_not_found'; end if;
    v_effective_starts_at := v_old_reservation.starts_at;
  else
    v_effective_starts_at := v_request.proposed_starts_at;
  end if;

  -- Block cancellation of already-started or past lessons by non-admins
  if v_effective_starts_at <= now() and v_profile.role <> 'admin' then
    raise exception 'lesson_already_started';
  end if;

  -- Derive actor role for audit / notification context
  v_actor_role := case
    when v_profile.role = 'admin' then 'admin'
    when auth.uid() = v_request.pro_id then 'pro'
    else 'member'
  end;

  -- Honor the club's cancellation window for member-initiated cancellations
  if v_actor_role = 'member' then
    select coalesce(cs.cancellation_window_hours, 24) into v_window_hours
      from public.club_settings cs
     where cs.club_id = v_profile.club_id;
    if (extract(epoch from (v_effective_starts_at - now())) / 3600) < v_window_hours then
      raise exception 'within_cancellation_window';
    end if;
  end if;

  -- Cancel the linked reservation (the still-active original — the same
  -- row locked above when present).
  -- cancellation_kind only allows 'member'|'admin'|'system'; map 'pro' → 'admin'.
  if v_request.linked_reservation_id is not null then
    update public.reservations
       set status            = 'cancelled',
           cancelled_at      = now(),
           cancelled_by      = auth.uid(),
           cancellation_kind = case when v_actor_role = 'member' then 'member' else 'admin' end
     where id = v_request.linked_reservation_id;
  end if;

  -- Update the request; set lesson_outcome = 'cancelled' so status and outcome
  -- remain consistent (outcome is never left null for a cancelled lesson).
  -- Any pending reschedule candidate in proposed_* is discarded as
  -- unresolved — status='cancelled' makes those fields purely historical.
  update public.lesson_requests
     set status              = 'cancelled',
         lesson_outcome      = 'cancelled',
         cancellation_reason = p_reason,
         cancelled_at        = now(),
         cancelled_by        = auth.uid(),
         last_actor_id       = auth.uid(),
         last_actor_role     = v_actor_role,
         updated_at          = now()
   where id = p_request_id
  returning * into v_result;

  -- Fetch names for notification bodies. Phase 33D1 correction: the
  -- member's profile is now looked up via v_current_member_id (the
  -- lesson's CURRENT roster claimed_by, resolved above), not historical
  -- v_request.member_id — a stale/null member_id would otherwise produce
  -- a blank name in the pro's notification body for a since-claimed
  -- Member, in addition to the notification-skip bug fixed below.
  select * into v_member from public.profiles where id = v_current_member_id;
  select * into v_pro    from public.profiles where id = v_request.pro_id;

  -- Notify both parties (skip actor — they already know). Phase 33D1
  -- correction: addressed to v_current_member_id, not historical
  -- v_request.member_id — required so a Member who claimed their account
  -- after this lesson was created (and is not the one cancelling) still
  -- receives the cancellation notice; the historical-only form would
  -- silently skip them forever (NULL <> anything is NULL, not TRUE).
  if v_current_member_id is not null and auth.uid() <> v_current_member_id then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_profile.club_id,
      v_current_member_id,
      'lesson_cancelled',
      'Your lesson with ' ||
        trim(coalesce(v_pro.first_name, '') || ' ' || coalesce(v_pro.last_name, '')) ||
        ' has been cancelled.' ||
        case when p_reason is not null and btrim(p_reason) <> ''
             then ' Reason: ' || btrim(p_reason)
             else ''
        end,
      jsonb_build_object('request_id', p_request_id)
    );
  end if;

  if auth.uid() <> v_request.pro_id then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_profile.club_id,
      v_request.pro_id,
      'lesson_cancelled',
      'Lesson with ' ||
        trim(coalesce(coalesce(v_member.first_name, v_roster.first_name), '') || ' ' || coalesce(coalesce(v_member.last_name, v_roster.last_name), '')) ||
        ' has been cancelled.' ||
        case when p_reason is not null and btrim(p_reason) <> ''
             then ' Reason: ' || btrim(p_reason)
             else ''
        end,
      jsonb_build_object('request_id', p_request_id)
    );
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'cancel_lesson', 'lesson_request', p_request_id,
    jsonb_build_object(
      'reason',              p_reason,
      'reservation_id',      v_request.linked_reservation_id,
      'cancelled_during_pending_reschedule', v_request.status = 'proposed',
      'roster_member_id',    v_request.roster_member_id
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.cancel_lesson(uuid, text) from public, anon;
grant  execute on function public.cancel_lesson(uuid, text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- F1. admin_create_member_lesson — NEW. Staff books a CONFIRMED lesson
--     directly for a roster Member (claimed or no-account) — no pending/
--     proposed negotiation stage, mirroring admin_create_member_reservation
--     (0108)'s directness for court bookings.
-- ═══════════════════════════════════════════════════════════════════════════
-- Uses current_user_club_id()/current_user_role() (the Phase 26 active-
-- membership helpers) rather than profiles.club_id/.role directly — this
-- is a brand-new function, not an edit to a pre-Phase-26 one, so it uses
-- the current, multi-club-correct pattern, matching every other new RPC
-- since 0108. The existing lesson RPCs above (submit_lesson_request,
-- propose_lesson_time, accept/decline_lesson_proposal, cancel_lesson) keep
-- their pre-existing profiles-direct pattern unchanged — modified only as
-- required, not migrated to the newer helpers as a drive-by change.
--
-- Member availability is checked via _lesson_check_member_availability
-- UNCONDITIONALLY (correction pass: the initial draft gated this behind
-- `if v_member_id is not null`, which is exactly what the review flagged
-- — an existing rule silently depending on account status). That helper
-- is now widened (Section M) to accept p_roster_member_id alongside
-- p_member_id, so it correctly narrows itself: court- and lesson-conflict
-- categories now see a no-account Member's own staff-created bookings via
-- roster_member_id; only the event-participation category remains
-- member_id-only (a genuine, reported, out-of-scope cross-domain
-- limitation — see Section M). Court-level conflict (GiST exclude) and
-- Pro-level conflict (_lesson_check_pro_availability, always profiles-id
-- based since every Pro has an account) remain fully enforced regardless.
create or replace function public.admin_create_member_lesson(
  p_expected_club_id uuid,
  p_roster_member_id uuid,
  p_pro_id            uuid,
  p_court_id          uuid,
  p_starts_at         timestamptz,
  p_ends_at           timestamptz,
  p_lesson_type_id    uuid default null,
  p_member_note       text default null
)
returns public.lesson_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id           uuid;
  v_role              text;
  v_roster            public.roster_members%rowtype;
  v_member_id         uuid;
  v_pro               public.profiles%rowtype;
  v_duration_minutes  int;
  v_tz                text;
  v_res_id            uuid;
  v_result            public.lesson_requests%rowtype;
  v_member_name       text;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is null or v_role <> 'admin' then raise exception 'insufficient_role'; end if;

  -- Resolve and validate the target roster Member — never trusted as
  -- "proof" of anything beyond its own existence/club scope; the caller's
  -- own admin authorization above is the only authorization this function
  -- relies on.
  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_club_id;
  if not found then raise exception 'roster_member_not_found'; end if;

  v_member_id   := v_roster.claimed_by;
  v_member_name := trim(coalesce(v_roster.first_name, '') || ' ' || coalesce(v_roster.last_name, ''));

  -- Validate pro: active, same club, role pro or admin, is_lesson_provider = true
  select * into v_pro
    from public.profiles
   where id                 = p_pro_id
     and club_id            = v_club_id
     and status              = 'active'
     and role                in ('pro', 'admin')
     and is_lesson_provider  = true;
  if not found then raise exception 'pro_not_found'; end if;

  if v_member_id is not null and v_member_id = p_pro_id then
    raise exception 'cannot_request_yourself';
  end if;

  if p_starts_at < now() then raise exception 'cannot_propose_past_time'; end if;
  if p_ends_at  <= p_starts_at then raise exception 'invalid_duration'; end if;

  v_duration_minutes := round(extract(epoch from (p_ends_at - p_starts_at)) / 60)::int;
  if v_duration_minutes < 30 or v_duration_minutes % 15 <> 0 then
    raise exception 'invalid_duration';
  end if;

  -- Validate court: active, same club
  if not exists (
    select 1 from public.courts
     where id        = p_court_id
       and club_id   = v_club_id
       and is_active = true
  ) then
    raise exception 'court_not_found';
  end if;

  -- Validate optional lesson type: active, same club, duration allowed
  if p_lesson_type_id is not null then
    if not exists (
      select 1 from public.lesson_types lt
       where lt.id        = p_lesson_type_id
         and lt.club_id   = v_club_id
         and lt.is_active = true
    ) then
      raise exception 'lesson_type_not_found';
    end if;

    if exists (
      select 1 from public.lesson_types lt
       where lt.id               = p_lesson_type_id
         and lt.allowed_durations is not null
         and array_length(lt.allowed_durations, 1) > 0
         and not (v_duration_minutes = any(lt.allowed_durations))
    ) then
      raise exception 'duration_not_allowed_for_type';
    end if;
  end if;

  if length(p_member_note) > 500 then raise exception 'note_too_long'; end if;

  -- Operating hours check — same helper self-service uses.
  select timezone into v_tz from public.clubs where id = v_club_id;
  perform public._lesson_check_operating_hours(v_club_id, p_starts_at, p_ends_at, v_tz);

  -- Pro conflict check — same helper self-service uses. Always applies:
  -- every Pro has an account by construction (profiles.role NOT NULL FK).
  perform public._lesson_check_pro_availability(p_pro_id, p_starts_at, p_ends_at, null);

  -- Member conflict check — unconditional (correction pass — see header
  -- note above). p_roster_member_id always supplied; v_member_id may be
  -- null for a still-unclaimed roster Member.
  perform public._lesson_check_member_availability(v_member_id, p_roster_member_id, p_starts_at, p_ends_at, null);

  -- Create the reservation (GiST EXCLUDE handles court conflicts
  -- atomically — the final authority, same as every other lesson-
  -- confirming path). owner_user_id keeps its existing, unchanged
  -- "inverted" pro_lesson meaning (the Pro's profiles.id). created_by is
  -- the admin performing this booking, not the member or pro — this
  -- reservation was not self-service.
  insert into public.reservations (
    club_id, court_id, owner_user_id, roster_member_id,
    starts_at, ends_at, status, reason,
    notes, show_notes_to_members, created_by
  ) values (
    v_club_id, p_court_id, p_pro_id, p_roster_member_id,
    p_starts_at, p_ends_at, 'confirmed', 'pro_lesson',
    'Pro lesson with ' || v_member_name,
    false,
    auth.uid()
  ) returning id into v_res_id;

  -- Create the lesson_requests row already confirmed — proposed_starts_at/
  -- ends_at/court_id carry the actual booked values (the existing UI
  -- displays a confirmed lesson's time from these columns; nothing was
  -- literally "proposed" here, matching the same overloaded-field
  -- convention the rest of this domain already uses for a directly-
  -- confirmed lesson).
  insert into public.lesson_requests (
    club_id, member_id, pro_id, roster_member_id,
    duration_minutes, member_note, lesson_type_id,
    proposed_starts_at, proposed_ends_at, proposed_court_id,
    status, linked_reservation_id, confirmed_at,
    last_actor_id, last_actor_role
  ) values (
    v_club_id, v_member_id, p_pro_id, p_roster_member_id,
    v_duration_minutes, btrim(coalesce(p_member_note, '')), p_lesson_type_id,
    p_starts_at, p_ends_at, p_court_id,
    'confirmed', v_res_id, now(),
    auth.uid(), 'admin'
  ) returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'admin_create_member_lesson', 'lesson_request', v_result.id,
    jsonb_build_object(
      'roster_member_id', p_roster_member_id,
      'member_id',        v_member_id,
      'member_claimed',   v_member_id is not null,
      'pro_id',           p_pro_id,
      'reservation_id',   v_res_id,
      'duration_minutes', v_duration_minutes
    )
  );

  -- Notify pro — always (has an account by construction).
  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_club_id, p_pro_id, 'lesson_request_confirmed',
    'Lesson with ' || v_member_name || ' confirmed for ' ||
      to_char(p_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM') || '.',
    jsonb_build_object('request_id', v_result.id, 'reservation_id', v_res_id)
  );

  -- Notify member — only if claimed. No-account Members receive no
  -- notification of any kind (communications for no-account Members
  -- remain explicitly deferred to Phase 33E, unchanged from every prior
  -- Phase 33 checkpoint).
  if v_member_id is not null then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id, v_member_id, 'lesson_request_confirmed',
      'Your lesson with ' ||
        trim(coalesce(v_pro.first_name, '') || ' ' || coalesce(v_pro.last_name, '')) ||
        ' is confirmed for ' || to_char(p_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM') || '.',
      jsonb_build_object('request_id', v_result.id, 'reservation_id', v_res_id)
    );
  end if;

  return v_result;
end;
$$;

revoke execute on function public.admin_create_member_lesson(
  uuid, uuid, uuid, uuid, timestamptz, timestamptz, uuid, text
) from public, anon;
grant  execute on function public.admin_create_member_lesson(
  uuid, uuid, uuid, uuid, timestamptz, timestamptz, uuid, text
) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- F2. admin_update_member_lesson — NEW. Staff directly edits a confirmed
--     lesson (Member/Pro/court/time/type/note) with no negotiation step —
--     mirrors update_member_reservation (0109)'s direct-edit authority
--     over any confirmed member_booking, extended to any confirmed
--     lesson_requests row regardless of self-service or staff origin.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.admin_update_member_lesson(
  p_request_id          uuid,
  p_expected_club_id    uuid,
  p_expected_updated_at timestamptz,
  p_roster_member_id    uuid,
  p_pro_id              uuid,
  p_court_id            uuid,
  p_starts_at           timestamptz,
  p_ends_at             timestamptz,
  p_lesson_type_id      uuid default null,
  p_member_note         text default null
)
returns public.lesson_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id           uuid;
  v_role              text;
  v_before            public.lesson_requests%rowtype;
  v_old_reservation   public.reservations%rowtype;
  v_roster            public.roster_members%rowtype;
  v_member_id         uuid;
  v_pro               public.profiles%rowtype;
  v_duration_minutes  int;
  v_tz                text;
  v_scheduling_changed boolean;
  v_member_changed     boolean;
  v_pro_changed        boolean;
  v_res_id             uuid;
  v_member_name        text;
  v_result             public.lesson_requests%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is null or v_role <> 'admin' then raise exception 'insufficient_role'; end if;

  select * into v_before
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  if v_before.status <> 'confirmed' then raise exception 'invalid_status_for_edit'; end if;
  if v_before.updated_at is distinct from p_expected_updated_at then raise exception 'stale_edit_conflict'; end if;
  if v_before.linked_reservation_id is null then raise exception 'linked_reservation_not_found'; end if;

  select * into v_old_reservation
    from public.reservations
   where id      = v_before.linked_reservation_id
     and club_id = v_club_id
     and reason  = 'pro_lesson'
     and status  = 'confirmed'
   for update;
  if not found then raise exception 'linked_reservation_not_found'; end if;

  if v_old_reservation.starts_at <= now() then
    raise exception 'cannot_reschedule_started_lesson';
  end if;

  -- Resolve and validate the (possibly reassigned) target roster Member.
  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_club_id;
  if not found then raise exception 'roster_member_not_found'; end if;

  v_member_id   := v_roster.claimed_by;
  v_member_name := trim(coalesce(v_roster.first_name, '') || ' ' || coalesce(v_roster.last_name, ''));

  -- Validate (possibly reassigned) pro.
  select * into v_pro
    from public.profiles
   where id                 = p_pro_id
     and club_id            = v_club_id
     and status              = 'active'
     and role                in ('pro', 'admin')
     and is_lesson_provider  = true;
  if not found then raise exception 'pro_not_found'; end if;

  if v_member_id is not null and v_member_id = p_pro_id then
    raise exception 'cannot_request_yourself';
  end if;

  if p_starts_at < now() then raise exception 'cannot_propose_past_time'; end if;
  if p_ends_at  <= p_starts_at then raise exception 'invalid_duration'; end if;

  v_duration_minutes := round(extract(epoch from (p_ends_at - p_starts_at)) / 60)::int;
  if v_duration_minutes < 30 or v_duration_minutes % 15 <> 0 then
    raise exception 'invalid_duration';
  end if;

  if not exists (
    select 1 from public.courts
     where id        = p_court_id
       and club_id   = v_club_id
       and is_active = true
  ) then
    raise exception 'court_not_found';
  end if;

  if p_lesson_type_id is not null then
    if not exists (
      select 1 from public.lesson_types lt
       where lt.id        = p_lesson_type_id
         and lt.club_id   = v_club_id
         and lt.is_active = true
    ) then
      raise exception 'lesson_type_not_found';
    end if;

    if exists (
      select 1 from public.lesson_types lt
       where lt.id               = p_lesson_type_id
         and lt.allowed_durations is not null
         and array_length(lt.allowed_durations, 1) > 0
         and not (v_duration_minutes = any(lt.allowed_durations))
    ) then
      raise exception 'duration_not_allowed_for_type';
    end if;
  end if;

  if length(p_member_note) > 500 then raise exception 'note_too_long'; end if;

  v_scheduling_changed := (p_court_id, p_starts_at, p_ends_at)
    is distinct from (v_old_reservation.court_id, v_old_reservation.starts_at, v_old_reservation.ends_at);
  v_member_changed := p_roster_member_id is distinct from v_before.roster_member_id;
  v_pro_changed     := p_pro_id is distinct from v_before.pro_id;

  select timezone into v_tz from public.clubs where id = v_club_id;

  if v_scheduling_changed or v_pro_changed then
    -- Time and/or pro changed — re-validate operating hours / pro /
    -- member conflicts, excluding this lesson's own still-active
    -- reservation, exactly like a self-service reschedule. Member check
    -- is unconditional (correction pass — see admin_create_member_
    -- lesson's header note above); p_roster_member_id always supplied.
    perform public._lesson_check_operating_hours(v_club_id, p_starts_at, p_ends_at, v_tz);
    perform public._lesson_check_pro_availability(p_pro_id, p_starts_at, p_ends_at, p_request_id);
    perform public._lesson_check_member_availability(v_member_id, p_roster_member_id, p_starts_at, p_ends_at, p_request_id);
  end if;

  if v_scheduling_changed then
    -- Soft-cancel the old reservation and insert a new one — mirrors
    -- accept_lesson_proposal's own reschedule pattern exactly. The new
    -- row's created_by is this admin: it is a genuinely new row, not a
    -- rewrite of the old one's created_by (which stays untouched on the
    -- now-cancelled row).
    update public.reservations
       set status            = 'cancelled',
           cancelled_at      = now(),
           cancelled_by      = auth.uid(),
           cancellation_kind = 'system',
           updated_at        = now()
     where id = v_old_reservation.id;

    insert into public.reservations (
      club_id, court_id, owner_user_id, roster_member_id,
      starts_at, ends_at, status, reason,
      notes, show_notes_to_members, created_by
    ) values (
      v_club_id, p_court_id, p_pro_id, p_roster_member_id,
      p_starts_at, p_ends_at, 'confirmed', 'pro_lesson',
      'Pro lesson with ' || v_member_name,
      false,
      auth.uid()
    ) returning id into v_res_id;
  elsif v_member_changed or v_pro_changed then
    -- Nothing time-related changed — update the existing reservation row
    -- directly in place (no history-losing replace) rather than the
    -- soft-cancel-and-reinsert pattern above, which is reserved for an
    -- actual scheduling change.
    update public.reservations
       set owner_user_id    = p_pro_id,
           roster_member_id = p_roster_member_id,
           notes            = 'Pro lesson with ' || v_member_name,
           updated_at       = now()
     where id = v_old_reservation.id;
    v_res_id := v_old_reservation.id;
  else
    v_res_id := v_old_reservation.id;
  end if;

  update public.lesson_requests
     set roster_member_id    = p_roster_member_id,
         member_id           = v_member_id,
         pro_id              = p_pro_id,
         duration_minutes    = v_duration_minutes,
         member_note         = btrim(coalesce(p_member_note, '')),
         lesson_type_id      = p_lesson_type_id,
         proposed_starts_at  = p_starts_at,
         proposed_ends_at    = p_ends_at,
         proposed_court_id   = p_court_id,
         linked_reservation_id = v_res_id,
         last_actor_id       = auth.uid(),
         last_actor_role     = 'admin',
         updated_at          = now()
   where id = p_request_id
  returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'admin_update_member_lesson', 'lesson_request', p_request_id,
    jsonb_build_object(
      'before', jsonb_build_object(
        'roster_member_id', v_before.roster_member_id,
        'member_id',        v_before.member_id,
        'pro_id',           v_before.pro_id,
        'court_id',         v_old_reservation.court_id,
        'starts_at',        v_old_reservation.starts_at,
        'ends_at',          v_old_reservation.ends_at
      ),
      'after', jsonb_build_object(
        'roster_member_id', p_roster_member_id,
        'member_id',        v_member_id,
        'pro_id',           p_pro_id,
        'court_id',         p_court_id,
        'starts_at',        p_starts_at,
        'ends_at',          p_ends_at
      ),
      'scheduling_changed', v_scheduling_changed,
      'member_changed',     v_member_changed,
      'pro_changed',        v_pro_changed,
      'reservation_id',     v_res_id,
      'old_reservation_id', case when v_scheduling_changed then v_old_reservation.id else null end
    )
  );

  -- Notify pro — always, when the pro or the schedule changed (always has
  -- an account). Notify member only if claimed and something material
  -- changed. Reuses the existing lesson_request_confirmed kind — no new
  -- notification kind is introduced.
  if v_scheduling_changed or v_pro_changed then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id, p_pro_id, 'lesson_request_confirmed',
      'Lesson with ' || v_member_name || ' updated — now ' ||
        to_char(p_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM') || '.',
      jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id)
    );
  end if;

  if v_member_id is not null and (v_scheduling_changed or v_pro_changed or v_member_changed) then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id, v_member_id, 'lesson_request_confirmed',
      'Your lesson with ' ||
        trim(coalesce(v_pro.first_name, '') || ' ' || coalesce(v_pro.last_name, '')) ||
        ' is confirmed for ' || to_char(p_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM') || '.',
      jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id)
    );
  end if;

  return v_result;
end;
$$;

revoke execute on function public.admin_update_member_lesson(
  uuid, uuid, timestamptz, uuid, uuid, uuid, timestamptz, timestamptz, uuid, text
) from public, anon;
grant  execute on function public.admin_update_member_lesson(
  uuid, uuid, timestamptz, uuid, uuid, uuid, timestamptz, timestamptz, uuid, text
) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- H. get_pro_lesson_requests — display continuity: LEFT JOIN roster_
--    members (was INNER JOIN profiles on lr.member_id — silently dropped
--    every no-account-Member row from every admin/pro list, hiding a
--    staff-created lesson from the very people who need to manage it) +
--    LEFT JOIN profiles keyed off the roster row's CURRENT claimed_by
--    (correction pass: not lr.member_id, a historical snapshot — see the
--    migration header's claim-continuity correction) + new member_claimed
--    column reflecting that same current state. member_first_name/
--    last_name keep their existing names (coalesced) so no existing
--    consumer breaks; only new trailing columns are added. DROP required
--    — Postgres cannot CREATE OR REPLACE a function whose RETURNS TABLE
--    column list changes — same input signature (uuid, text), so this is
--    safe: any Supabase-JS caller reads the result by field name, and no
--    existing field is removed or renamed. Not the DROP-before-CREATE-
--    with-a-live-deployed-caller hazard 0109 was about — that hazard is
--    specifically about an ARGUMENT list a currently-deployed caller
--    passes positionally/by count; a RETURN-shape addition consumed by
--    name is not that risk.
-- ═══════════════════════════════════════════════════════════════════════════

drop function if exists public.get_pro_lesson_requests(uuid, text);

create or replace function public.get_pro_lesson_requests(
  p_pro_filter uuid default null,
  p_status     text default null
)
returns table (
  id                    uuid,
  member_id             uuid,
  member_first_name     text,
  member_last_name      text,
  roster_member_id      uuid,
  member_claimed        boolean,
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
  last_actor_role       text,
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
begin
  select * into v_profile from public.profiles p where p.id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;
  if v_profile.role not in ('pro', 'admin') then raise exception 'insufficient_role'; end if;

  if v_profile.role = 'pro' and p_pro_filter is not null and p_pro_filter <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  return query
    select
      lr.id,
      lr.member_id,
      coalesce(mem.first_name, rm.first_name) as member_first_name,
      coalesce(mem.last_name,  rm.last_name)  as member_last_name,
      lr.roster_member_id,
      -- Phase 33D1 correction: member_claimed now reflects roster_members.
      -- claimed_by IS NOT NULL — the lesson's CURRENT roster claim state —
      -- not merely whether the historical lesson_requests.member_id
      -- snapshot happened to be populated at creation time. mem is now
      -- joined via rm.claimed_by (see FROM clause below), so mem.id is
      -- not null is equivalent to rm.claimed_by is not null; kept as
      -- mem.id for a single source of truth with the name coalesce above.
      (mem.id is not null)                    as member_claimed,
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
      lr.last_actor_role,
      lr.linked_reservation_id,
      lr.created_at,
      lr.updated_at,
      lr.confirmed_at,
      lr.lesson_type_id,
      lt.name         as lesson_type_name,
      lr.lesson_outcome
    from public.lesson_requests lr
    left join public.roster_members rm on rm.id = lr.roster_member_id
    -- Phase 33D1 correction: joined via rm.claimed_by (current roster
    -- claim state), not lr.member_id (historical snapshot) — this is what
    -- makes member_claimed and the displayed name reflect a claim that
    -- happened AFTER this lesson was created.
    left join public.profiles mem on mem.id = rm.claimed_by
    join public.profiles pro on pro.id = lr.pro_id
    left join public.courts pc on pc.id = lr.preferred_court_id
    left join public.courts xc on xc.id = lr.proposed_court_id
    left join public.lesson_types lt on lt.id = lr.lesson_type_id
   where lr.club_id = v_profile.club_id
     and (
       (v_profile.role = 'pro'   and lr.pro_id = auth.uid())
       or
       (v_profile.role = 'admin' and (p_pro_filter is null or lr.pro_id = p_pro_filter))
     )
     and (p_status is null or lr.status = p_status)
   order by lr.created_at desc;
end;
$$;

revoke execute on function public.get_pro_lesson_requests(uuid, text) from public, anon;
grant  execute on function public.get_pro_lesson_requests(uuid, text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- I. get_my_lesson_requests — NEW to this correction pass (the initial
--    0111 draft left this untouched, incorrectly reasoning that a
--    null-member_id row was structurally unreachable here — true only at
--    CREATION time, not after the underlying roster identity is later
--    claimed). Same 0-argument signature as 0071 — CREATE OR REPLACE only,
--    same RETURNS TABLE shape (no columns added/changed), so no DROP is
--    needed here (unlike Section H).
-- ═══════════════════════════════════════════════════════════════════════════
-- A claimed Member must see a lesson that was created for them while they
-- had no account (member_id null, and permanently staying null on that
-- historical row) alongside their ordinary member_id = auth.uid() rows.
-- Matches on EITHER condition; the roster identity used is always the
-- caller's own, server-resolved from auth.uid() + this function's existing
-- v_profile.club_id — never a client-supplied roster id, and never another
-- Member's.

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

  select id into v_roster_member_id
    from public.roster_members
   where club_id    = v_profile.club_id
     and claimed_by = auth.uid();

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


-- ═══════════════════════════════════════════════════════════════════════════
-- M. _lesson_check_member_availability — widened for Member conflict-
--    parity between claimed and no-account roster Members (see the
--    migration header's dedicated correction-pass note for the full
--    category-by-category analysis). Private function — revoked from
--    public/anon, never granted to authenticated, only reachable via an
--    internal `perform` call from another SECURITY DEFINER function.
--    Adding a required parameter changes the signature — DROP + CREATE,
--    same 0101 precedent already established for this exact function
--    ("a stray old overload has no security exposure... but the old
--    signature is dropped anyway to leave exactly one").
-- ═══════════════════════════════════════════════════════════════════════════

drop function if exists public._lesson_check_member_availability(uuid, timestamptz, timestamptz, uuid);

create or replace function public._lesson_check_member_availability(
  p_member_id           uuid,
  p_roster_member_id    uuid,
  p_starts_at           timestamptz,
  p_ends_at             timestamptz,
  p_exclude_request_id  uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_conflict int;
  v_range    tstzrange;
begin
  v_range := tstzrange(p_starts_at, p_ends_at, '[)');

  -- Check overlapping court reservations owned by the member (by
  -- authenticated owner_user_id) OR attributed to the same durable roster
  -- identity (roster_member_id — populated for both member_booking, since
  -- 0108, and, as of this migration, pro_lesson reservations). p_member_id
  -- may be null (still-unclaimed roster Member); p_roster_member_id is
  -- always supplied by every call site, claimed or not.
  select count(*) into v_conflict
    from public.reservations r
   where r.status in ('pending', 'confirmed')
     and tstzrange(r.starts_at, r.ends_at, '[)') && v_range
     and (
       (p_member_id is not null and r.owner_user_id = p_member_id)
       or (p_roster_member_id is not null and r.roster_member_id = p_roster_member_id)
     );
  if v_conflict > 0 then raise exception 'member_has_conflict'; end if;

  -- Check overlapping event participation. NOT extended to roster_
  -- member_id: event_participants has no roster-identity column, and a
  -- no-account Member cannot join an event at all today (joining requires
  -- an authenticated profile_id) — there is no data this category could
  -- check for one. This is the one genuine, reported cross-domain
  -- limitation from this correction pass (see the migration header) —
  -- events/programs are explicitly out of scope for 33D1. Skipped
  -- entirely when p_member_id is null, exactly as before this migration.
  if p_member_id is not null then
    select count(*) into v_conflict
      from public.event_participants ep
      join public.reservations       er on er.event_id  = ep.event_id
                                       and er.status     in ('pending', 'confirmed')
                                       and tstzrange(er.starts_at, er.ends_at, '[)') && v_range
     where ep.profile_id = p_member_id
       and ep.status     in ('confirmed', 'offered');
    if v_conflict > 0 then raise exception 'member_has_event_conflict'; end if;
  end if;

  -- Check overlapping confirmed lessons the member is party to — by
  -- historical member_id OR by durable roster_member_id (same-migration
  -- extension, not cross-domain: this is the very table roster_member_id
  -- was just added to). Excludes the request being (re)proposed against
  -- itself — without this, a reschedule proposal that overlaps the
  -- still-active original confirmed time would incorrectly flag the
  -- lesson as conflicting with itself.
  select count(*) into v_conflict
    from public.lesson_requests lr
   where lr.status = 'confirmed'
     and tstzrange(lr.proposed_starts_at, lr.proposed_ends_at, '[)') && v_range
     and (p_exclude_request_id is null or lr.id is distinct from p_exclude_request_id)
     and (
       (p_member_id is not null and lr.member_id = p_member_id)
       or (p_roster_member_id is not null and lr.roster_member_id = p_roster_member_id)
     );
  if v_conflict > 0 then raise exception 'member_has_lesson_conflict'; end if;
end;
$$;

revoke execute on function public._lesson_check_member_availability(uuid, uuid, timestamptz, timestamptz, uuid) from public, anon;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration is created
-- in this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Drop the two new RPCs (no other object in this migration depends on
--    them):
--    `drop function if exists public.admin_update_member_lesson(uuid, uuid,
--    timestamptz, uuid, uuid, uuid, timestamptz, timestamptz, uuid, text);`
--    `drop function if exists public.admin_create_member_lesson(uuid, uuid,
--    uuid, uuid, timestamptz, timestamptz, uuid, text);`
--    Any lesson/reservation they already created remain valid, ordinary
--    pro_lesson rows; nothing about them requires these functions to exist.
--
-- 2. Restore get_pro_lesson_requests(uuid, text) to its pre-0111 (0071)
--    RETURNS TABLE shape and body (drop the member_claimed/roster_
--    member_id output columns, the LEFT JOIN on roster_members, and revert
--    the profiles join back to an inner join on lr.member_id) via DROP +
--    CREATE (same reasoning as Section H — the return shape is changing
--    again).
--
-- 2a. Drop get_my_lesson_requests's roster-aware body and restore its
--     pre-0111 (0071) body (member_id = auth.uid() only) via CREATE OR
--     REPLACE — same 0-argument signature, so this is a direct replace,
--     not a DROP.
--
-- 2b. Restore _lesson_check_member_availability to its pre-0111 (0101)
--     4-argument form: `drop function if exists public._lesson_check_
--     member_availability(uuid, uuid, timestamptz, timestamptz, uuid);`
--     then recreate the 4-argument (p_member_id, p_starts_at, p_ends_at,
--     p_exclude_request_id) version from 0101. Must happen no earlier than
--     step 3 below (every call site reverting to the old 4-arg call shape
--     is part of restoring those function bodies) and no later — an
--     inconsistent intermediate state (5-arg helper, 4-arg callers or vice
--     versa) will fail to compile/apply, not silently misbehave.
--
-- 3. Restore cancel_lesson, decline_lesson_proposal, accept_lesson_
--    proposal, propose_lesson_time, submit_lesson_request to their pre-
--    0111 (0101/0072) bodies via CREATE OR REPLACE FUNCTION — same
--    signatures throughout this migration, so every one of these is a
--    direct CREATE OR REPLACE, never a DROP; no coexistence concern for
--    any of them. Perform together with steps 2a/2b as one logical unit.
--
-- 4. Only after step 3 (so no remaining function is trying to write a
--    now-dropped NOT NULL column), relax the constraint and clear the
--    backfilled data if the rollback requires it:
--    `alter table public.lesson_requests alter column roster_member_id
--    drop not null;`
--    `update public.lesson_requests set roster_member_id = null;` — this
--    only ever set a previously-null column for historical rows and a
--    column no function will write to anymore after step 3; no other
--    field was touched, and no row was inserted or deleted by this
--    migration's own backfill.
--
-- 5. member_id cannot safely return to NOT NULL once any legitimate
--    staff-created no-account-Member lesson exists: `alter table public.
--    lesson_requests alter column member_id set not null;` will FAIL if
--    any row has a null member_id — expected and correct, not a bug to
--    work around, exactly matching 0108's owner_user_id precedent. That
--    data represents real lessons for real people with no account, and
--    cannot be truthfully reverted without fabricating an identity. Do
--    not force it through by deleting those rows or inventing a member_id.
--
-- 6. Drop the new schema only when safe — i.e., only after step 4 (or
--    after confirming no row still depends on it) and only if step 5's
--    NOT NULL restoration is not itself being abandoned for the reason
--    above: `alter table public.lesson_requests drop column if exists
--    roster_member_id;` (also drops lesson_requests_roster_member_id_idx
--    automatically). Safe once nothing above still needs the column, but
--    — per step 5 — dropping it does not by itself make a full rollback
--    lossless if no-account-Member lessons exist; it only removes the
--    now-unused column, it does not restore member_id's NOT NULL
--    guarantee or recover an identity that was never fabricated.
