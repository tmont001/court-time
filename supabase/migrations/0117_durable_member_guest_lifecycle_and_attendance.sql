-- 0117_durable_member_guest_lifecycle_and_attendance.sql
-- Phase 33E2: Durable Member/Guest Lifecycle + Attendance + Reporting
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Three tightly-coupled outcomes, in dependency order:
--   A-D. roster_members gets a durable, trustworthy active/inactive lifecycle
--        (it has never had one — audit confirmed zero lifecycle column in
--        roster_members' entire history, 0056 through 0107). Claimed
--        identities' lifecycle is kept in sync with the existing, working
--        club_memberships lifecycle (0086: status/removed_at/removed_by) by
--        extending set_member_status/remove_club_member/restore_club_member
--        — FAIL-CLOSED: each sync UPDATE must affect exactly one row (GET
--        DIAGNOSTICS row_count = 1) or the entire call rolls back, so
--        club_memberships and roster_members can never disagree about a
--        claimed identity's active/inactive state. Unclaimed identities
--        get their own first-class lifecycle too — new remove_roster_
--        member/restore_roster_member RPCs (Section C2), scoped to
--        claimed_by IS NULL, preserving the same roster_members.id and
--        every historical relation. delete_roster_member remains callable
--        but is no longer used by normal Admin Members lifecycle actions —
--        it survives only as an unused cleanup primitive. Unclaimed
--        identities default to 'active' on initial backfill (no better
--        signal exists — never inferred from activity recency).
--   C3.  Invite/claim lifecycle invariant: create_club_invite/resend_club_
--        invite/accept_club_invite (all live since 0107) predate roster
--        lifecycle and none of them checked it — an inactive roster
--        identity must not be eligible for invitation or account claim, and
--        acceptance must never implicitly reactivate a removed Member.
--        create_club_invite and resend_club_invite now reject an inactive
--        target (roster_member_inactive); accept_club_invite now RAISEs the
--        same error immediately after identity resolution and before any
--        membership/claim write, rolling back the entire acceptance.
--        remove_roster_member (C2) also revokes any still-outstanding
--        invite bound to that identity at removal time, so an old link
--        cannot survive the removal it should have died with.
--   E-J. event_guests gets a durable soft-removal + attendance model
--        (status/attendance_status/cancelled_at/cancelled_by). The prior
--        model hard-deleted guest rows on removal (admin_remove_guest) and
--        never tracked guest attendance at all (attendance_status was
--        hardcoded null in get_event_roster's guest_rows CTE) — both
--        incompatible with durable Guest attendance / reporting.
--   K.   Every capacity/enrollment count that reads event_guests is updated
--        to filter to status = 'active', so a soft-cancelled guest stops
--        occupying capacity everywhere, not just in the one function that
--        cancelled it. Full inventory (15 SQL functions): admin_add_guest,
--        admin_remove_guest, admin_add_roster_member_to_event (deprecated,
--        still touched for consistency), join_event, admin_add_member,
--        admin_add_roster_participant, admin_force_confirm,
--        admin_force_confirm_roster_participant, admin_offer_spot,
--        admin_offer_spot_roster_participant, advance_waitlist_offer,
--        update_event (capacity floor), get_event_roster (guest_rows CTE),
--        get_reporting_overview (sess_guests), get_event_program_summary
--        (sess_guests). expire_stale_offers_for_event / cancel_event were
--        audited and confirmed to never reference event_guests at all — not
--        touched. Corresponding frontend raw event_guests(id) embeds are
--        widened to event_guests(id, status) with client-side active-only
--        filtering in a follow-up (non-SQL) change — see the implementation
--        report for the full frontend file list.
--   L.   Reporting is re-keyed to the new trustworthy roster lifecycle only
--        AFTER A-K land: get_member_engagement_summary and
--        get_reporting_overview's active-Member counts both move from
--        club_memberships-only (blind to no-account Members by
--        construction) to roster_members (role='member' and
--        status='active') — the same definition in both reports, per
--        product requirement. get_member_engagement_summary's activity CTEs
--        re-key from profile_id/owner_user_id + club_memberships joins to
--        roster_member_id + roster_members joins directly (reservations/
--        event_participants/program_enrollments all already carry a durable,
--        NOT NULL-by-construction roster_member_id from 33D1-33D2b). Live
--        production data confirmed ZERO ambiguous reservations rows
--        (owner_user_id not null, roster_member_id null, reason =
--        'member_booking') — no backfill needed, no STOP condition. Guest
--        attendance now participates in get_event_program_summary's
--        attendance metrics (previously explicitly excluded, per that
--        function's own 0096 header comment) while remaining excluded from
--        Member engagement metrics entirely, per the locked product
--        definitions. Historical Guest attendance remains reportable even
--        after that Guest is later soft-removed — the attendance CTE counts
--        by attendance_status alone, not filtered to status = 'active'.
--
-- Locked architecture (restated, unchanged):
--   - roster_members.id = permanent club-scoped Member business identity.
--   - claimed_by: NULL = no Court Time account, NOT NULL = linked account.
--     Claim status never defines active/inactive membership — that is
--     exactly the gap this migration closes with the new status column.
--   - Guests remain structurally separate from roster_members and from
--     event_participants — event_guests is untouched in that respect; only
--     its own internal lifecycle representation changes.
--
-- Not applied by this checkpoint. Not committed.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- A. roster_members — durable Member lifecycle schema + backfill
-- ═══════════════════════════════════════════════════════════════════════════
-- status: the durable answer to "is this roster identity currently an
-- active club Member" — independent of claimed_by. removed_at/removed_by
-- mirror club_memberships' existing shape for a claimed identity's removal
-- provenance; both remain null for an unclaimed identity (no removal event
-- has ever happened to it via this schema).
alter table public.roster_members
  add column status     text        not null default 'active'
    check (status in ('active', 'inactive')),
  add column removed_at timestamptz,
  add column removed_by uuid references public.profiles(id);

-- Fail-closed backfill guard: every CLAIMED roster identity must resolve
-- exactly one same-club club_memberships row to derive its initial
-- lifecycle state from. Provably true today (0107's per-club unique
-- claimed_by constraint plus the fact that claimed_by is only ever set to
-- an accepted invite's user_id in the same club — see accept_club_invite),
-- but proven here empirically rather than assumed, matching every prior
-- Phase 33 backfill's own discipline. See verify_phase33e2_preflight.sql
-- query 1 for the pre-apply version of this same check.
do $$
declare
  v_orphan_count int;
begin
  select count(*) into v_orphan_count
  from public.roster_members rm
  where rm.claimed_by is not null
    and not exists (
      select 1 from public.club_memberships cm
      where cm.user_id = rm.claimed_by
        and cm.club_id = rm.club_id
    );

  if v_orphan_count > 0 then
    raise exception
      'roster_lifecycle_backfill_blocked: % claimed roster_members rows have no matching same-club club_memberships row',
      v_orphan_count;
  end if;
end $$;

-- Claimed identities: derive initial status/removed_at/removed_by from the
-- linked club_memberships row (the durable, already-trustworthy lifecycle
-- source for every claimed identity). Unclaimed identities keep the column
-- default ('active', removed_at/removed_by null) — no fabrication, no
-- inference from activity recency, exactly matching current behavior.
update public.roster_members rm
set status     = case when cm.status = 'active' and cm.removed_at is null then 'active' else 'inactive' end,
    removed_at = cm.removed_at,
    removed_by = cm.removed_by
from public.club_memberships cm
where rm.claimed_by = cm.user_id
  and rm.club_id    = cm.club_id;


-- ═══════════════════════════════════════════════════════════════════════════
-- B. Sync hooks — keep roster_members.status in sync with club_memberships'
--    existing, working lifecycle for CLAIMED identities going forward.
--    Every function below is CREATE OR REPLACE only (same signature, same
--    return type, same auth/guard logic) — the ONLY change in each is one
--    additional UPDATE public.roster_members statement, inserted right
--    after the pre-existing club_memberships UPDATE.
--
--    FAIL-CLOSED (correction): 0107 established that every claimed club
--    membership has exactly one same-club roster identity. The sync UPDATE
--    below is therefore required to affect exactly one row — GET
--    DIAGNOSTICS checks row_count and raises 'roster_lifecycle_sync_failed'
--    if it is not exactly 1, which (since no exception handler catches it)
--    rolls back the ENTIRE function call, including the club_memberships
--    UPDATE already made. club_memberships and roster_members can never be
--    left disagreeing about a claimed identity's active/inactive state —
--    either both writes land, or neither does.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.set_member_status(
  p_target_user_id uuid,
  p_new_status     text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_club_id uuid;
  v_actor_role    text;
  v_target        public.club_memberships%rowtype;
  v_admin_count   int;
  v_rows_updated  int;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  select public.current_user_club_id(), public.current_user_role()
    into v_actor_club_id, v_actor_role;

  if v_actor_role is distinct from 'admin' then
    raise exception 'insufficient_role';
  end if;

  if p_new_status not in ('active', 'inactive', 'suspended') then
    raise exception 'invalid_status';
  end if;

  perform 1 from public.profiles where id = p_target_user_id for update;

  select cm.* into v_target
    from public.club_memberships cm
   where cm.user_id = p_target_user_id
     and cm.club_id = v_actor_club_id
     and cm.removed_at is null;

  if not found then raise exception 'user_not_found'; end if;

  if auth.uid() = p_target_user_id then
    raise exception 'cannot_change_own_status';
  end if;

  if v_target.role = 'admin' and v_target.status = 'active' and p_new_status <> 'active' then
    perform cm.id
      from public.club_memberships cm
     where cm.club_id    = v_actor_club_id
       and cm.role       = 'admin'
       and cm.status     = 'active'
       and cm.removed_at is null
     for update;

    select count(*) into v_admin_count
      from public.club_memberships cm
     where cm.club_id    = v_actor_club_id
       and cm.role       = 'admin'
       and cm.status     = 'active'
       and cm.removed_at is null
       and cm.user_id   <> p_target_user_id;

    if v_admin_count = 0 then
      raise exception 'last_admin';
    end if;
  end if;

  update public.club_memberships
     set status = p_new_status
   where user_id = p_target_user_id
     and club_id = v_actor_club_id;

  -- Phase 33E2: keep roster_members.status in sync for this claimed
  -- identity. v_target.removed_at is guaranteed null here (the capturing
  -- SELECT above filters to it), so 'inactive' below unambiguously means
  -- "not active", not "removed" — removal has its own dedicated function.
  update public.roster_members
     set status     = case when p_new_status = 'active' then 'active' else 'inactive' end,
         updated_at = now()
   where club_id    = v_actor_club_id
     and claimed_by = p_target_user_id;

  get diagnostics v_rows_updated = row_count;
  if v_rows_updated <> 1 then
    raise exception 'roster_lifecycle_sync_failed';
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor_club_id, auth.uid(), 'set_member_status', 'profile', p_target_user_id,
    jsonb_build_object('old_status', v_target.status, 'new_status', p_new_status)
  );
end;
$$;

revoke execute on function public.set_member_status(uuid, text) from public, anon;
grant  execute on function public.set_member_status(uuid, text) to authenticated;


create or replace function public.remove_club_member(
  p_target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_club_id uuid;
  v_actor_role    text;
  v_target        public.club_memberships%rowtype;
  v_admin_count   int;
  v_rows_updated  int;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  select public.current_user_club_id(), public.current_user_role()
    into v_actor_club_id, v_actor_role;

  if v_actor_role is distinct from 'admin' then
    raise exception 'insufficient_role';
  end if;

  perform 1 from public.profiles where id = p_target_user_id for update;

  select cm.* into v_target
    from public.club_memberships cm
   where cm.user_id = p_target_user_id
     and cm.club_id = v_actor_club_id
     and cm.removed_at is null;

  if not found then raise exception 'user_not_found'; end if;

  if auth.uid() = p_target_user_id then
    raise exception 'cannot_remove_self';
  end if;

  if v_target.role = 'admin' and v_target.status = 'active' then
    perform cm.id
      from public.club_memberships cm
     where cm.club_id    = v_actor_club_id
       and cm.role       = 'admin'
       and cm.status     = 'active'
       and cm.removed_at is null
     for update;

    select count(*) into v_admin_count
      from public.club_memberships cm
     where cm.club_id    = v_actor_club_id
       and cm.role       = 'admin'
       and cm.status     = 'active'
       and cm.removed_at is null
       and cm.user_id   <> p_target_user_id;

    if v_admin_count = 0 then
      raise exception 'last_admin';
    end if;
  end if;

  update public.club_memberships
     set removed_at = now(),
         removed_by = auth.uid()
   where user_id = p_target_user_id
     and club_id = v_actor_club_id;

  -- Phase 33E2: mirror the removal onto roster_members. A removed
  -- membership is always inactive, regardless of whatever status it held
  -- before removal — matches remove_club_member's own "never touches role
  -- or status" club_memberships behavior (status there is left as-is;
  -- roster_members.status is explicitly forced to 'inactive' here because,
  -- unlike club_memberships, roster_members has no separate
  -- suspended/removed distinction — 'inactive' is its only non-active
  -- state).
  update public.roster_members
     set status     = 'inactive',
         removed_at = now(),
         removed_by = auth.uid(),
         updated_at = now()
   where club_id    = v_actor_club_id
     and claimed_by = p_target_user_id;

  get diagnostics v_rows_updated = row_count;
  if v_rows_updated <> 1 then
    raise exception 'roster_lifecycle_sync_failed';
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor_club_id, auth.uid(), 'remove_club_member', 'profile', p_target_user_id,
    jsonb_build_object('old_role', v_target.role, 'old_status', v_target.status)
  );
end;
$$;

revoke execute on function public.remove_club_member(uuid) from public, anon;
grant  execute on function public.remove_club_member(uuid) to authenticated;


create or replace function public.restore_club_member(
  p_target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_club_id uuid;
  v_actor_role    text;
  v_target        public.club_memberships%rowtype;
  v_rows_updated  int;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  select public.current_user_club_id(), public.current_user_role()
    into v_actor_club_id, v_actor_role;

  if v_actor_role is distinct from 'admin' then
    raise exception 'insufficient_role';
  end if;

  perform 1 from public.profiles where id = p_target_user_id for update;

  select cm.* into v_target
    from public.club_memberships cm
   where cm.user_id = p_target_user_id
     and cm.club_id = v_actor_club_id
     and cm.removed_at is not null;

  if not found then raise exception 'user_not_found'; end if;

  update public.club_memberships
     set removed_at = null,
         removed_by = null
   where user_id = p_target_user_id
     and club_id = v_actor_club_id;

  -- Phase 33E2: mirror the restore onto roster_members. Deliberately
  -- mirrors restore_club_member's own "does not also force status back to
  -- active" nuance — v_target.status (captured above, before this restore)
  -- reflects whatever status the membership had AT removal time, so a
  -- membership removed while suspended/inactive comes back still
  -- inactive on the roster side too, not silently reactivated.
  update public.roster_members
     set status     = case when v_target.status = 'active' then 'active' else 'inactive' end,
         removed_at = null,
         removed_by = null,
         updated_at = now()
   where club_id    = v_actor_club_id
     and claimed_by = p_target_user_id;

  get diagnostics v_rows_updated = row_count;
  if v_rows_updated <> 1 then
    raise exception 'roster_lifecycle_sync_failed';
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor_club_id, auth.uid(), 'restore_club_member', 'profile', p_target_user_id,
    jsonb_build_object('role', v_target.role, 'status', v_target.status)
  );
end;
$$;

revoke execute on function public.restore_club_member(uuid) from public, anon;
grant  execute on function public.restore_club_member(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- C. get_roster_members — active-only by default for picker use, with an
--    opt-in p_include_inactive flag for the Admin Members CRM listing
--    (which wants to see and manage inactive unclaimed identities too).
--
--    SIGNATURE CORRECTION: adding a parameter to an existing function is a
--    NEW, DISTINCT overload in Postgres — CREATE OR REPLACE on a different
--    argument list does not replace the original zero-argument function; it
--    would leave both get_roster_members() and
--    get_roster_members(boolean) callable simultaneously, an ambiguous
--    surface this checkpoint must not introduce. Dependency audit (grep
--    across every migration and every frontend call site) found exactly two
--    callers — EventRosterSheet.tsx's bare `supabase.rpc("get_roster_
--    members")` and admin/members/page.tsx's `supabase.rpc("get_roster_
--    members", { p_include_inactive: true })` — and zero SQL functions or
--    RLS policies reference it internally, so an explicit DROP of the
--    zero-argument overload (no CASCADE — nothing depends on it) followed
--    by creating only the one-argument version is safe: existing zero-arg
--    call sites resolve through the DEFAULT, and Admin Members passes true
--    explicitly. Exactly one get_roster_members callable path exists after
--    this migration.
--
--    Also adds status/removed_at to the return contract (mirrors get_
--    members()'s own removed_at addition in 0086) — needed so Admin
--    Members can render a no-account Member's Removed/inactive state, order
--    puts active first then inactive (same convention as get_members()).
--    Also closes a pre-existing gap: this function never had `set search_
--    path` — added here. Grants are preserved exactly as they are today:
--    none has ever been added for this function (implicit PUBLIC EXECUTE,
--    gated entirely by its own internal admin-role check) — not changed
--    here, including on the recreated function.
-- ═══════════════════════════════════════════════════════════════════════════
drop function if exists public.get_roster_members();

create or replace function get_roster_members(p_include_inactive boolean default false)
returns table (
  id uuid, first_name text, last_name text, email text, phone text,
  role text, notes text, created_by uuid, created_at timestamptz,
  status text, removed_at timestamptz
)
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_profile profiles%rowtype;
begin
  select p.* into v_profile from profiles p where p.id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  return query
    select rm.id, rm.first_name, rm.last_name, rm.email, rm.phone,
           rm.role, rm.notes, rm.created_by, rm.created_at,
           rm.status, rm.removed_at
    from roster_members rm
    where rm.club_id    = v_profile.club_id
      and rm.claimed_by is null
      and (p_include_inactive or rm.status = 'active')
    order by (rm.status <> 'active') asc,
             rm.last_name asc nulls last, rm.first_name asc nulls last;
end;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- C2. remove_roster_member / restore_roster_member — NEW. A no-account
--    Member is a first-class Member: if they later leave the club, their
--    roster_members.id must remain durable (every historical Reservation/
--    Lesson/Event/Program stays attached to it) while their membership
--    becomes inactive — the same outcome remove_club_member/
--    restore_club_member give a claimed identity, via club_memberships.
--    These two RPCs are that same lifecycle for an UNCLAIMED identity,
--    scoped directly to roster_members since there is no club_memberships
--    row to drive it. Mirrors delete_roster_member's existing auth
--    pattern (profiles%rowtype + v_profile.role, matching every other
--    function already defined against this table) rather than the newer
--    current_user_club_id()/current_user_role() helpers used elsewhere in
--    this migration, for consistency with the rest of the roster_members
--    RPC family it joins.
--
--    Both require exactly one updated row (GET DIAGNOSTICS row_count) and
--    audit only after the confirmed mutation. claimed_by is null is
--    enforced both in the pre-check (friendly error) and in the UPDATE's
--    own WHERE clause (defense in depth against a concurrent claim race
--    between the check and the write) — a claimed identity must continue
--    through set_member_status/remove_club_member/restore_club_member
--    only. This is the normal-lifecycle removal path for a no-account
--    Member going forward; delete_roster_member remains callable but is no
--    longer used by any normal Admin Members UI action (see the frontend
--    changes below) — it survives only as an unused cleanup primitive.
--
--    Unlike Sections B's sync hooks, these are new functions with no prior
--    grant posture to preserve — explicit revoke/grant added, matching the
--    modern (0086+) discipline rather than the implicit-PUBLIC-EXECUTE
--    posture of this table's older sibling functions.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.remove_roster_member(p_roster_member_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_profile        profiles%rowtype;
  v_roster         roster_members%rowtype;
  v_rows_updated   int;
  v_invites_revoked int;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  select * into v_roster
    from roster_members
   where id      = p_roster_member_id
     and club_id = v_profile.club_id;
  if not found then raise exception 'roster_member_not_found'; end if;

  if v_roster.claimed_by is not null then
    raise exception 'roster_member_claimed';
  end if;

  if v_roster.status <> 'active' then
    raise exception 'roster_member_already_inactive';
  end if;

  update roster_members
     set status     = 'inactive',
         removed_at = now(),
         removed_by = auth.uid(),
         updated_at = now()
   where id         = p_roster_member_id
     and club_id    = v_profile.club_id
     and claimed_by is null
     and status      = 'active';

  get diagnostics v_rows_updated = row_count;
  if v_rows_updated <> 1 then
    raise exception 'roster_member_update_failed';
  end if;

  -- Phase 33E2-correction: an inactive roster identity is not eligible for
  -- invitation or claim (see create_club_invite/resend_club_invite/
  -- accept_club_invite below) — a removed Member must not be able to
  -- self-reactivate through an old outstanding invite. Revoke, never
  -- delete, every still-outstanding invite bound to this exact roster
  -- identity, same club, using the identical "outstanding" predicate
  -- create_club_invite's own invite_already_pending guard already relies
  -- on (accepted_at is null, revoked_at is null, expires_at > now()).
  -- Runs only after the roster UPDATE above is confirmed successful, and
  -- before the final audit entry, in the same transaction — if anything
  -- after this point rolls back, this revocation rolls back with it.
  update club_invites
     set revoked_at = now()
   where roster_member_id = p_roster_member_id
     and club_id           = v_profile.club_id
     and accepted_at is null
     and revoked_at  is null
     and expires_at  > now();

  get diagnostics v_invites_revoked = row_count;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'remove_roster_member', 'roster_member', p_roster_member_id,
    jsonb_build_object(
      'first_name',      v_roster.first_name,
      'last_name',       v_roster.last_name,
      'invites_revoked', v_invites_revoked
    )
  );
end;
$$;

revoke execute on function public.remove_roster_member(uuid) from public, anon;
grant  execute on function public.remove_roster_member(uuid) to authenticated;


create or replace function public.restore_roster_member(p_roster_member_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_profile      profiles%rowtype;
  v_roster       roster_members%rowtype;
  v_rows_updated int;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  select * into v_roster
    from roster_members
   where id      = p_roster_member_id
     and club_id = v_profile.club_id;
  if not found then raise exception 'roster_member_not_found'; end if;

  if v_roster.claimed_by is not null then
    raise exception 'roster_member_claimed';
  end if;

  if v_roster.status <> 'inactive' then
    raise exception 'roster_member_not_removed';
  end if;

  update roster_members
     set status     = 'active',
         removed_at = null,
         removed_by = null,
         updated_at = now()
   where id         = p_roster_member_id
     and club_id    = v_profile.club_id
     and claimed_by is null
     and status      = 'inactive';

  get diagnostics v_rows_updated = row_count;
  if v_rows_updated <> 1 then
    raise exception 'roster_member_update_failed';
  end if;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'restore_roster_member', 'roster_member', p_roster_member_id,
    jsonb_build_object('first_name', v_roster.first_name, 'last_name', v_roster.last_name)
  );
end;
$$;

revoke execute on function public.restore_roster_member(uuid) from public, anon;
grant  execute on function public.restore_roster_member(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- C3. Invite/claim lifecycle invariant — closes a hole the new
--    roster_members.status introduced: create_club_invite/
--    resend_club_invite/accept_club_invite all predate roster lifecycle
--    (live since 0107) and none of them checks it. Locked behavior: an
--    inactive roster identity is not eligible for invitation or account
--    claim, and invite acceptance must NEVER implicitly reactivate a
--    removed Member — remove_roster_member (Section C2, above) already
--    revokes any outstanding invite for that identity at removal time, but
--    that alone does not stop a NEW invite from being created against an
--    inactive identity, nor does it stop acceptance if the lifecycle check
--    is missing. All three functions below are otherwise the exact, live
--    0107 bodies — CREATE OR REPLACE only, same signatures, same
--    authorization, same-club guards, same claimed_by rules, same email
--    requirements, same grants, same SECURITY DEFINER/search_path, same
--    fail-closed identity-resolution behavior. Each gains exactly one new
--    guard, and none of them auto-restores/reactivates a roster identity —
--    every inactive case RAISEs 'roster_member_inactive' and rolls back.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.create_club_invite(
  p_role             text,
  p_roster_member_id uuid,
  p_expires_at       timestamptz default now() + interval '7 days'
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile   public.profiles%rowtype;
  v_roster    public.roster_members%rowtype;
  v_invite_id uuid;
  v_code      text;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  if p_role not in ('member', 'pro', 'admin') then
    raise exception 'invalid_role';
  end if;

  if p_roster_member_id is null then
    raise exception 'roster_identity_required';
  end if;

  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_profile.club_id
   for update;
  if not found                       then raise exception 'roster_member_not_found';         end if;
  if v_roster.claimed_by is not null then raise exception 'roster_member_already_claimed';   end if;
  if v_roster.email is null          then raise exception 'roster_email_required';           end if;
  -- Phase 33E2-correction: an inactive roster identity is not eligible for
  -- invitation.
  if v_roster.status is distinct from 'active' then raise exception 'roster_member_inactive'; end if;

  -- One active pending invite per roster identity at a time. resend_club_
  -- invite always revokes the old one first (in the same transaction), so
  -- this only ever blocks a genuine duplicate attempt, never the normal
  -- resend path.
  if exists (
    select 1 from public.club_invites
     where roster_member_id = p_roster_member_id
       and accepted_at is null
       and revoked_at  is null
       and expires_at  > now()
  ) then
    raise exception 'invite_already_pending';
  end if;

  insert into public.club_invites (club_id, role, email, roster_member_id, created_by, expires_at)
  values (
    v_profile.club_id,
    p_role,
    v_roster.email,
    p_roster_member_id,
    auth.uid(),
    p_expires_at
  )
  returning id, code into v_invite_id, v_code;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'create_invite',
    'club_invite',
    v_invite_id,
    jsonb_build_object('role', p_role, 'roster_member_id', p_roster_member_id, 'expires_at', p_expires_at)
  );

  return v_code;
end;
$$;

revoke execute on function public.create_club_invite(text, uuid, timestamptz) from public, anon;
grant  execute on function public.create_club_invite(text, uuid, timestamptz) to authenticated;


create or replace function public.resend_club_invite(
  p_old_code   text,
  p_expires_at timestamptz default now() + interval '7 days'
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile          public.profiles%rowtype;
  v_old_invite       public.club_invites%rowtype;
  v_roster_member_id uuid;
  v_new_code         text;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  select * into v_old_invite
    from public.club_invites
   where code    = p_old_code
     and club_id = v_profile.club_id
   for update;
  if not found                            then raise exception 'invalid_invite';          end if;
  if v_old_invite.accepted_at is not null then raise exception 'invite_already_accepted'; end if;

  -- Resolve the roster identity to resend for BEFORE touching anything.
  if v_old_invite.roster_member_id is not null
     and exists (
       select 1 from public.roster_members
        where id = v_old_invite.roster_member_id
          and claimed_by is null
     )
  then
    v_roster_member_id := v_old_invite.roster_member_id;
  elsif v_old_invite.email is not null then
    -- Legacy email-only invite: heal it if exactly one safe match exists.
    select id into v_roster_member_id
      from public.roster_members
     where club_id      = v_profile.club_id
       and claimed_by   is null
       and lower(email) = lower(v_old_invite.email)
     limit 1;
  end if;

  if v_roster_member_id is null then
    raise exception 'roster_identity_required';
  end if;

  -- Phase 33E2-correction: the resolved roster identity must still be
  -- active — do not create a replacement invite for an inactive one.
  -- Checked before the old invite is touched, matching this function's
  -- existing "resolve fully, THEN mutate" discipline.
  if not exists (
    select 1 from public.roster_members
     where id     = v_roster_member_id
       and status = 'active'
  ) then
    raise exception 'roster_member_inactive';
  end if;

  -- Revoke the old invite. Idempotent — harmless if already revoked/expired,
  -- matching the prior client-side "errors ignored" behavior, now enforced
  -- server-side in the same transaction instead of a separate round trip.
  update public.club_invites
     set revoked_at = coalesce(revoked_at, now())
   where id = v_old_invite.id;

  -- Reuse create_club_invite rather than duplicating its insert/validation
  -- logic — same roster identity, same role as the original invite. Runs in
  -- the same transaction: if this raises, the revoke above rolls back too,
  -- so a failed resend never leaves the admin with zero valid invites.
  v_new_code := public.create_club_invite(v_old_invite.role, v_roster_member_id, p_expires_at);

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'resend_invite',
    'club_invite',
    v_old_invite.id,
    jsonb_build_object(
      'roster_member_id',      v_roster_member_id,
      'healed_legacy_invite',  v_old_invite.roster_member_id is null
    )
  );

  return v_new_code;
end;
$$;

revoke execute on function public.resend_club_invite(text, timestamptz) from public, anon;
grant  execute on function public.resend_club_invite(text, timestamptz) to authenticated;


create or replace function public.accept_club_invite(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite            public.club_invites%rowtype;
  v_profile           public.profiles%rowtype;
  v_club              public.clubs%rowtype;
  v_auth_email        text;
  v_existing          public.club_memberships%rowtype;
  v_roster            public.roster_members%rowtype;
  -- Phase 33B1: true only when BOTH the roster row's and the profile's
  -- corresponding name field are populated AND disagree. A blank field on
  -- either side is never treated as a contradiction here — deliberately a
  -- more permissive rule than the backfill's batch classification (see the
  -- migration header's two truth tables). Verified against this repo's
  -- actual onboarding order: profiles.first_name/last_name are NULL for
  -- essentially every first-ever invite acceptance, by design, not by
  -- exception. Treating that routine blank state as a conflict here would
  -- break the "Add Member + Invite" flow for every brand-new Member.
  v_names_contradict  boolean;
begin
  -- Lock order: caller's own profiles row first (see 0084 header comment).
  select p.* into v_profile from public.profiles p where p.id = auth.uid() for update;
  if not found then raise exception 'not_authenticated'; end if;

  -- Lock the invite row second, exactly as before.
  select * into v_invite from public.club_invites where code = p_code for update;

  if not found                        then raise exception 'invalid_invite';  end if;
  if v_invite.revoked_at  is not null then raise exception 'invite_revoked';  end if;
  if v_invite.accepted_at is not null then raise exception 'invite_used';     end if;
  if v_invite.expires_at < now()      then raise exception 'invite_expired';  end if;

  select email into v_auth_email from auth.users where id = auth.uid();

  -- Email restriction: unchanged normalization (case-insensitive compare).
  if v_invite.email is not null then
    if lower(v_auth_email) <> lower(v_invite.email) then
      raise exception 'email_mismatch';
    end if;
  end if;

  -- Never a caller-controlled user id: every membership lookup/write below
  -- is scoped to auth.uid(), never to any value derived from p_code or any
  -- other input.
  select cm.* into v_existing
    from public.club_memberships cm
   where cm.user_id = auth.uid()
     and cm.club_id = v_invite.club_id;

  if found then
    if v_existing.status = 'active' and v_existing.removed_at is null then
      raise exception 'already_member';
    else
      raise exception 'membership_state_conflict';
    end if;
  end if;

  -- ═══════════════════════════════════════════════════════════════════════
  -- Resolve the destination club's stable roster identity BEFORE any
  -- irreversible write (membership INSERT, invite consumption, active-club
  -- change). Outcomes, exactly as specified:
  --   A_ALREADY_LINKED     — a roster row in this club already has
  --                          claimed_by = auth.uid(). Reuse it.
  --   B_SAFE_ROSTER_LINK   — an unclaimed roster row resolves, either
  --                          directly via v_invite.roster_member_id (set by
  --                          create_club_invite for every roster-first
  --                          invite) or, for a legacy email-only invite, by
  --                          exact email match — AND its populated name
  --                          field(s) do not contradict the profile.
  --   C_NO_ROSTER_IDENTITY — neither resolves. RAISE. Because invite
  --                          creation is now roster-first (Section 2), this
  --                          should no longer be a normal production path
  --                          — reachable only via a legacy pre-migration
  --                          invite that a resolved preflight should have
  --                          caught, or a direct RPC call bypassing the
  --                          application entirely.
  --   D_IDENTITY_CONFLICT  — a candidate exists but is claimed by a
  --                          different user, or its populated name(s)
  --                          genuinely contradict the profile. RAISE.
  -- ═══════════════════════════════════════════════════════════════════════

  -- A_ALREADY_LINKED — checked first, regardless of how the invite itself
  -- is shaped. `found` below reflects this select.
  select * into v_roster
    from public.roster_members
   where club_id    = v_invite.club_id
     and claimed_by = auth.uid()
   for update;

  if not found then
    if v_invite.roster_member_id is not null then
      -- Roster-first invite: identity is explicit, not inferred by email.
      select * into v_roster
        from public.roster_members
       where id      = v_invite.roster_member_id
         and club_id = v_invite.club_id
       for update;

      if found and v_roster.claimed_by is not null then
        -- Already claimed by a DIFFERENT user than the one accepting now.
        raise exception 'roster_identity_conflict';
      end if;
    elsif v_auth_email is not null then
      -- Legacy email-only invite: the pre-33B1 lookup, unchanged in shape.
      select * into v_roster
        from public.roster_members
       where club_id     = v_invite.club_id
         and claimed_by  is null
         and lower(email) = lower(v_auth_email)
       limit 1
       for update;
    end if;

    if v_roster.id is null then
      -- C_NO_ROSTER_IDENTITY.
      raise exception 'no_roster_identity';
    end if;

    -- Null-safe, asymmetric contradiction check.
    v_names_contradict := coalesce(
      (v_roster.first_name is not null and v_profile.first_name is not null
        and lower(btrim(v_roster.first_name)) <> lower(btrim(v_profile.first_name)))
      or
      (v_roster.last_name is not null and v_profile.last_name is not null
        and lower(btrim(v_roster.last_name)) <> lower(btrim(v_profile.last_name))),
      false
    );

    if v_names_contradict is true then
      -- D_IDENTITY_CONFLICT.
      raise exception 'roster_identity_conflict';
    end if;
  end if;

  -- v_roster is now guaranteed: a real, safe (A or B) roster identity row,
  -- locked FOR UPDATE. Proceed with the writes.

  -- Phase 33E2-correction: an inactive roster identity is not eligible for
  -- account claim. Checked here — after identity resolution, BEFORE any
  -- membership/invite/claim write below — so a removed Member can never
  -- self-reactivate through an old (or newly re-shared) invite link. Never
  -- auto-restores/reactivates the identity; the admin must explicitly call
  -- restore_roster_member first, then send a NEW invite if desired.
  if v_roster.status is distinct from 'active' then
    raise exception 'roster_member_inactive';
  end if;

  -- Create the destination membership. Preserves provenance (invited_by,
  -- source_invite_id) exactly as the schema supports. Never touches any
  -- other club's membership row — an existing membership elsewhere (e.g.
  -- Club A) is not read, written, or referenced anywhere in this function.
  insert into public.club_memberships (
    user_id, club_id, role, status, invited_by, source_invite_id
  ) values (
    auth.uid(), v_invite.club_id, v_invite.role, 'active', v_invite.created_by, v_invite.id
  );

  update public.club_invites
     set accepted_at = now(),
         accepted_by = auth.uid()
   where id = v_invite.id;

  -- Activate the newly created membership in the same transaction, reusing
  -- set_active_club's own validated switch (0082) rather than re-deriving
  -- its logic. The target row is guaranteed to exist and be valid at this
  -- point (just inserted, above, and still locked by this transaction), so
  -- this call cannot legitimately fail. Migration 0081's Trigger C performs
  -- the legacy profiles.club_id/role/status/is_lesson_provider projection
  -- as part of that same call — no direct profiles membership-field write
  -- happens in this function.
  perform public.set_active_club(v_invite.club_id);

  select * into v_club from public.clubs where id = v_invite.club_id;

  -- Audit: invite accepted. Scoped to the destination club only — never
  -- written against any other club the caller may belong to.
  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_invite.club_id,
    auth.uid(),
    'accept_invite',
    'profile',
    auth.uid(),
    jsonb_build_object('role', v_invite.role, 'invite_id', v_invite.id)
  );

  -- Claim the resolved roster identity. No-op if it was already
  -- A_ALREADY_LINKED to this exact user (claimed_by already correct);
  -- updated_at still refreshes harmlessly in that case.
  update public.roster_members
     set claimed_by = auth.uid(),
         updated_at = now()
   where id = v_roster.id;

  -- Global identity fields only (first_name/last_name/phone) — never
  -- club-scoped, unaffected by which club is being joined. Never overwrites
  -- a meaningful existing value the member has already entered.
  update public.profiles
     set first_name = case when btrim(coalesce(first_name, '')) = '' then v_roster.first_name else first_name end,
         last_name  = case when btrim(coalesce(last_name,  '')) = '' then v_roster.last_name  else last_name  end,
         phone      = case when btrim(coalesce(phone,      '')) = '' then v_roster.phone      else phone      end,
         updated_at = now()
   where id = auth.uid();

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_invite.club_id,
    auth.uid(),
    'claim_roster_member',
    'roster_member',
    v_roster.id,
    jsonb_build_object('invite_id', v_invite.id)
  );

  return jsonb_build_object(
    'club_id',   v_invite.club_id,
    'role',      v_invite.role,
    'club_name', v_club.name
  );
end;
$$;

revoke execute on function public.accept_club_invite(text) from public, anon;
grant  execute on function public.accept_club_invite(text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- D. get_program_eligible_roster_members — same active-only picker
--    filtering. CREATE OR REPLACE, same signature/return type; only the
--    WHERE clause gains one predicate.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.get_program_eligible_roster_members(p_program_id uuid)
returns table (
  roster_member_id uuid,
  first_name       text,
  last_name        text,
  display_name     text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_program public.programs%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  if v_role not in ('admin', 'pro') then
    raise exception 'insufficient_role';
  end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id;
  if not found then raise exception 'program_not_found'; end if;

  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_program.enrollment_model <> 'program' then
    raise exception 'program_not_whole_enrollment';
  end if;

  return query
    select
      rm.id,
      rm.first_name,
      rm.last_name,
      coalesce(nullif(trim(concat_ws(' ', rm.first_name, rm.last_name)), ''), 'Unknown')::text as display_name
    from public.roster_members rm
    where rm.club_id    = v_club_id
      and rm.claimed_by is null
      and rm.status      = 'active'
      and not exists (
        select 1 from public.program_enrollments pe
        where pe.program_id       = p_program_id
          and pe.roster_member_id = rm.id
          and pe.status           in ('enrolled', 'offered', 'waitlisted')
      )
    order by rm.last_name asc nulls last, rm.first_name asc nulls last, rm.id asc;
end;
$$;

revoke execute on function public.get_program_eligible_roster_members(uuid) from public, anon;
grant  execute on function public.get_program_eligible_roster_members(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- E. event_guests — durable soft-removal + attendance schema.
--    status: 'active' (occupies capacity, shown as current roster) or
--    'cancelled' (soft-removed — does not occupy capacity, historical row
--    preserved). attendance_status: same vocabulary as
--    event_participants.attendance_status ('attended'/'no_show'/null),
--    same CHECK-constraint shape as 0016's original column. cancelled_at/
--    cancelled_by record removal provenance, mirroring reservations' own
--    cancelled_at/cancelled_by pattern. No backfill needed: every existing
--    row defaults to status = 'active' (correct — every currently-existing
--    event_guests row IS an active, non-removed guest today, since the
--    prior model only ever hard-deleted on removal) and attendance_status
--    stays null (correct — no guest attendance has ever been tracked).
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.event_guests
  add column status            text not null default 'active'
    check (status in ('active', 'cancelled')),
  add column attendance_status text
    check (attendance_status in ('attended', 'no_show')),
  add column cancelled_at      timestamptz,
  add column cancelled_by      uuid references public.profiles(id);


-- ═══════════════════════════════════════════════════════════════════════════
-- F. admin_add_guest — capacity-count fix only (audit-scope function; not
--    otherwise touched). CREATE OR REPLACE, same signature/return type/
--    grants (none exist today, unchanged).
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function admin_add_guest(
  p_event_id     uuid,
  p_display_name text
)
returns event_guests
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_actor        profiles%rowtype;
  v_event        events%rowtype;
  v_name         text;
  v_occupied     int;
  v_was_over_cap boolean;
  v_result       event_guests%rowtype;
begin
  select * into v_actor from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_actor.role not in ('admin', 'pro') then
    raise exception 'admin_required';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_actor.club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  v_name := trim(p_display_name);
  if char_length(v_name) < 1 then raise exception 'invalid_guest_name'; end if;

  select
    (select count(*)
       from event_participants
       where event_id = p_event_id
         and status   in ('confirmed', 'offered')
         and role     = 'participant')
    +
    (select count(*)
       from event_guests
       where event_id = p_event_id
         and status   = 'active')
    into v_occupied;

  v_was_over_cap := v_occupied >= v_event.capacity;

  insert into event_guests (event_id, display_name, added_by)
  values (p_event_id, v_name, auth.uid())
  returning * into v_result;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'admin_add_guest',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_title',       v_event.title,
      'guest_id',          v_result.id,
      'guest_name',        v_name,
      'was_over_capacity', v_was_over_cap
    )
  );

  return v_result;
end;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- G. admin_remove_guest — converted from hard DELETE to soft cancel, with a
--    fail-closed zero-row-update guard (GET DIAGNOSTICS pattern, matching
--    0114/0116's established write-guard discipline). Idempotency:
--    targeting an already-cancelled guest now raises 'guest_not_found'
--    rather than silently "succeeding" a second time. Same signature/
--    return type/grants (none exist today, unchanged).
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function admin_remove_guest(
  p_event_id uuid,
  p_guest_id  uuid
)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_actor        profiles%rowtype;
  v_event        events%rowtype;
  v_guest        event_guests%rowtype;
  v_occupied     int;
  v_rows_updated int;
begin
  select * into v_actor from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_actor.role not in ('admin', 'pro') then
    raise exception 'admin_required';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_actor.club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  -- Guest row must exist for this event AND currently be active — an
  -- already-cancelled guest cannot be removed again.
  select * into v_guest
    from event_guests
    where id       = p_guest_id
      and event_id = p_event_id
      and status   = 'active';
  if not found then raise exception 'guest_not_found'; end if;

  update event_guests
     set status       = 'cancelled',
         cancelled_at = now(),
         cancelled_by = auth.uid()
   where id       = p_guest_id
     and status   = 'active';

  get diagnostics v_rows_updated = row_count;
  if v_rows_updated = 0 then raise exception 'guest_not_found'; end if;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'admin_remove_guest',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_title', v_event.title,
      'guest_id',    p_guest_id,
      'guest_name',  v_guest.display_name
    )
  );

  -- Check whether the removal freed a slot below capacity. Count AFTER the
  -- soft-cancel (the just-cancelled row no longer has status = 'active',
  -- so this filtered count already reflects the removal).
  select
    (select count(*)
       from event_participants
       where event_id = p_event_id
         and status   in ('confirmed', 'offered')
         and role     = 'participant')
    +
    (select count(*)
       from event_guests
       where event_id = p_event_id
         and status   = 'active')
    into v_occupied;

  if v_occupied < v_event.capacity then
    perform expire_stale_offers_for_event(p_event_id, v_actor.club_id, v_event.title);
    perform advance_waitlist_offer(p_event_id, v_actor.club_id, v_event.title);
  end if;
end;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- H. admin_add_roster_member_to_event — deprecated (frontend no longer
--    calls it), touched only for capacity-count consistency with every
--    other writer. Same signature/return type/grants (none exist today,
--    unchanged).
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function admin_add_roster_member_to_event(
  p_event_id        uuid,
  p_roster_member_id uuid
)
returns event_guests
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_actor        profiles%rowtype;
  v_event        events%rowtype;
  v_roster       roster_members%rowtype;
  v_name         text;
  v_occupied     int;
  v_was_over_cap boolean;
  v_result       event_guests%rowtype;
begin
  select * into v_actor from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_actor.role not in ('admin', 'pro') then
    raise exception 'admin_required';
  end if;

  select * into v_event
    from events
   where id      = p_event_id
     and club_id = v_actor.club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  select * into v_roster
    from roster_members
   where id      = p_roster_member_id
     and club_id = v_actor.club_id;
  if not found then raise exception 'roster_member_not_found'; end if;

  if v_roster.claimed_by is not null then
    raise exception 'roster_member_already_claimed';
  end if;

  v_name := trim(concat_ws(' ', v_roster.first_name, v_roster.last_name));

  select
    (select count(*)
       from event_participants
       where event_id = p_event_id
         and status   in ('confirmed', 'offered')
         and role     = 'participant')
    +
    (select count(*)
       from event_guests
       where event_id = p_event_id
         and status   = 'active')
    into v_occupied;

  v_was_over_cap := v_occupied >= v_event.capacity;

  insert into event_guests (event_id, display_name, added_by, roster_member_id)
  values (p_event_id, v_name, auth.uid(), p_roster_member_id)
  returning * into v_result;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'admin_add_roster_member_to_event',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_title',       v_event.title,
      'roster_member_id',  p_roster_member_id,
      'roster_member_name', v_name,
      'guest_id',          v_result.id,
      'was_over_capacity', v_was_over_cap
    )
  );

  return v_result;
end;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- I. get_event_roster — guest_rows CTE now filters to active guests only
--    and surfaces the real attendance_status (previously hardcoded null).
--    The `status` output column stays hardcoded 'confirmed' for guest rows,
--    unchanged — the frontend never reads it for role = 'guest' rows (it
--    branches on role instead), so changing it is unnecessary scope.
--    Same signature/return type/grants — CREATE OR REPLACE only.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function get_event_roster(p_event_id uuid)
returns table (
  profile_id        uuid,
  display_name      text,
  role              text,
  status            text,
  attendance_status text,
  offer_expires_at  timestamptz,
  waitlist_position int,
  roster_member_id  uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile profiles%rowtype;
  v_event   events%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.role not in ('admin', 'pro') then
    raise exception 'insufficient_role';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_profile.club_id;
  if not found then raise exception 'event_not_found'; end if;

  return query
    with ranked as (
      select
        ep.profile_id,
        ep.roster_member_id,
        ep.role,
        ep.status,
        ep.attendance_status,
        ep.offer_expires_at,
        ep.created_at,
        row_number() over (
          partition by ep.status
          order by ep.created_at asc
        ) as pos
      from event_participants ep
      where ep.event_id = p_event_id
        and ep.status   in ('confirmed', 'waitlisted', 'offered')
    ),
    member_rows as (
      select
        r.profile_id,
        coalesce(
          nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''),
          nullif(trim(concat_ws(' ', rm.first_name, rm.last_name)), ''),
          'Unknown'
        )::text                                                       as display_name,
        r.role::text,
        r.status::text,
        r.attendance_status::text,
        r.offer_expires_at,
        case when r.status = 'waitlisted' then r.pos::int else null end
                                                                      as waitlist_position,
        r.roster_member_id,
        case r.status
          when 'confirmed'  then 1
          when 'offered'    then 2
          when 'waitlisted' then 3
          else 4
        end                                                           as sort_group,
        r.created_at
      from ranked r
      left join profiles p on p.id = r.profile_id
      left join roster_members rm on rm.id = r.roster_member_id
    ),
    guest_rows as (
      select
        eg.id                       as profile_id,
        eg.display_name::text,
        'guest'::text               as role,
        'confirmed'::text           as status,
        eg.attendance_status::text  as attendance_status,
        null::timestamptz           as offer_expires_at,
        null::int                   as waitlist_position,
        eg.roster_member_id,
        4                           as sort_group,
        eg.created_at
      from event_guests eg
      where eg.event_id = p_event_id
        and eg.status    = 'active'
    )
    select
      c.profile_id,
      c.display_name,
      c.role,
      c.status,
      c.attendance_status,
      c.offer_expires_at,
      c.waitlist_position,
      c.roster_member_id
    from (
      select * from member_rows
      union all
      select * from guest_rows
    ) c
    order by c.sort_group, c.created_at asc;
end;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- J. mark_attendance_guest — NEW. Guest-attendance parity RPC, mirroring
--    mark_attendance_roster_participant's exact shape (same auth pattern,
--    same p_expected_club_id stale-club guard, same fail-closed zero-row
--    guard, same audit-after-mutation discipline). Only an ACTIVE guest row
--    may be newly marked/cleared — a soft-cancelled guest's existing
--    attendance_status (if any) is left untouched by this function (it
--    simply can no longer be targeted), which is exactly how "attendance
--    history preserved if Guest is subsequently removed" is satisfied:
--    admin_remove_guest never writes attendance_status, so a mark made
--    while active survives a later soft-removal unchanged.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.mark_attendance_guest(
  p_event_id          uuid,
  p_expected_club_id  uuid,
  p_guest_id          uuid,
  p_attendance_status text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id      uuid;
  v_role         text;
  v_event        public.events%rowtype;
  v_rows_updated int;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is null or v_role not in ('admin', 'pro') then raise exception 'insufficient_role'; end if;

  if p_attendance_status is not null
     and p_attendance_status not in ('attended', 'no_show') then
    raise exception 'invalid_attendance_status';
  end if;

  select * into v_event
    from public.events
   where id      = p_event_id
     and club_id = v_club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  update public.event_guests
     set attendance_status = p_attendance_status
   where id       = p_guest_id
     and event_id = p_event_id
     and status   = 'active';

  get diagnostics v_rows_updated = row_count;
  if v_rows_updated = 0 then raise exception 'guest_not_found'; end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'mark_attendance_guest', 'event_guest', p_guest_id,
    jsonb_build_object('event_id', p_event_id, 'attendance_status', p_attendance_status)
  );
end;
$$;

revoke execute on function public.mark_attendance_guest(uuid, uuid, uuid, text) from public, anon;
grant  execute on function public.mark_attendance_guest(uuid, uuid, uuid, text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- K. Remaining capacity-count fixes — every other function whose capacity
--    math reads event_guests. Each is CREATE OR REPLACE only, with the
--    identical one-line change: `from event_guests where event_id = ...`
--    gains `and status = 'active'`. No other logic in any of these nine
--    functions is touched.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function admin_add_member(
  p_event_id   uuid,
  p_profile_id uuid
)
returns event_participants
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      profiles%rowtype;
  v_event      events%rowtype;
  v_existing   event_participants%rowtype;
  v_existing_found boolean;
  v_occupied   int;
  v_new_status text;
  v_result     event_participants%rowtype;
  v_roster_member_id uuid;
begin
  select * into v_actor from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_actor.role not in ('admin', 'pro') then
    raise exception 'admin_required';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_actor.club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  if not exists (
    select 1 from profiles
    where id      = p_profile_id
      and club_id = v_actor.club_id
      and status  = 'active'
  ) then
    if not exists (select 1 from profiles where id = p_profile_id and club_id = v_actor.club_id) then
      raise exception 'member_not_found';
    end if;
    raise exception 'member_inactive';
  end if;

  select id into v_roster_member_id
    from roster_members
   where club_id    = v_actor.club_id
     and claimed_by = p_profile_id;
  if not found then
    raise exception 'phase33d2_unresolved_member_identity';
  end if;

  select * into v_existing
    from event_participants
   where event_id = p_event_id
     and (profile_id = p_profile_id or roster_member_id = v_roster_member_id)
   for update;
  v_existing_found := found;

  if v_existing_found and v_existing.status in ('confirmed', 'waitlisted', 'offered') then
    raise exception 'already_joined';
  end if;

  select
    (select count(*)
       from event_participants
       where event_id = p_event_id
         and status   in ('confirmed', 'offered')
         and role     = 'participant')
    +
    (select count(*)
       from event_guests
       where event_id = p_event_id
         and status   = 'active')
    into v_occupied;

  v_new_status := case when v_occupied >= v_event.capacity then 'waitlisted' else 'confirmed' end;

  if v_existing_found then
    update event_participants
       set status           = v_new_status,
           profile_id       = p_profile_id,
           roster_member_id = v_roster_member_id,
           offer_expires_at = null,
           updated_at       = now()
     where id = v_existing.id
    returning * into v_result;
  else
    insert into event_participants (event_id, profile_id, roster_member_id, role, status)
    values (p_event_id, p_profile_id, v_roster_member_id, 'participant', v_new_status)
    returning * into v_result;
  end if;

  if v_result.id is null then
    raise exception 'event_participant_write_failed';
  end if;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'admin_add_member',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_title',      v_event.title,
      'added_profile_id', p_profile_id,
      'roster_member_id', v_roster_member_id,
      'final_status',     v_new_status
    )
  );

  return v_result;
end;
$$;


create or replace function join_event(p_event_id uuid)
returns event_participants
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile  profiles%rowtype;
  v_event    events%rowtype;
  v_existing event_participants%rowtype;
  v_existing_found boolean;
  v_count    int;
  v_result   event_participants%rowtype;
  v_roster_member_id uuid;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.status <> 'active' then raise exception 'account_inactive'; end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_profile.club_id
      and status  = 'scheduled';
  if not found then raise exception 'event_not_found'; end if;

  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  if not v_event.member_joinable then
    raise exception 'event_not_joinable';
  end if;

  if v_event.starts_at < now() then
    raise exception 'event_already_started';
  end if;

  select id into v_roster_member_id
    from roster_members
   where club_id    = v_profile.club_id
     and claimed_by = auth.uid();
  if not found then
    raise exception 'phase33d2_unresolved_member_identity';
  end if;

  perform expire_stale_offers_for_event(p_event_id, v_profile.club_id, v_event.title);
  perform advance_waitlist_offer(p_event_id, v_profile.club_id, v_event.title);

  select * into v_existing
    from event_participants
   where event_id = p_event_id
     and (profile_id = auth.uid() or roster_member_id = v_roster_member_id)
   for update;
  v_existing_found := found;

  if v_existing_found and v_existing.status in ('confirmed', 'waitlisted', 'offered') then
    raise exception 'already_joined';
  end if;

  select
    (select count(*)
       from event_participants
       where event_id = p_event_id
         and status   in ('confirmed', 'offered')
         and role     = 'participant')
    +
    (select count(*)
       from event_guests
       where event_id = p_event_id
         and status   = 'active')
    into v_count;

  if v_count >= v_event.capacity then
    if v_existing_found then
      update event_participants
         set status = 'waitlisted', profile_id = auth.uid(), roster_member_id = v_roster_member_id, updated_at = now()
       where id = v_existing.id
      returning * into v_result;
    else
      insert into event_participants (event_id, profile_id, roster_member_id, role, status)
      values (p_event_id, auth.uid(), v_roster_member_id, 'participant', 'waitlisted')
      returning * into v_result;
    end if;

    if v_result.id is null then
      raise exception 'event_participant_write_failed';
    end if;
  else
    if v_existing_found then
      update event_participants
         set status = 'confirmed', profile_id = auth.uid(), roster_member_id = v_roster_member_id, updated_at = now()
       where id = v_existing.id
      returning * into v_result;
    else
      insert into event_participants (event_id, profile_id, roster_member_id, role, status)
      values (p_event_id, auth.uid(), v_roster_member_id, 'participant', 'confirmed')
      returning * into v_result;
    end if;

    if v_result.id is null then
      raise exception 'event_participant_write_failed';
    end if;

    if user_pref_enabled(auth.uid(), 'event_joined') then
      insert into notifications (club_id, user_id, kind, body, metadata)
      values (
        v_profile.club_id,
        auth.uid(),
        'event_joined',
        'You''ve joined "' || v_event.title || '".',
        jsonb_build_object('event_id', p_event_id)
      );
    end if;
  end if;

  return v_result;
end;
$$;


create or replace function public.admin_add_roster_participant(
  p_event_id          uuid,
  p_expected_club_id  uuid,
  p_roster_member_id  uuid
)
returns public.event_participants
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id    uuid;
  v_role       text;
  v_event      public.events%rowtype;
  v_roster     public.roster_members%rowtype;
  v_member_id  uuid;
  v_existing   public.event_participants%rowtype;
  v_existing_found boolean;
  v_occupied   int;
  v_new_status text;
  v_result     public.event_participants%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is null or v_role not in ('admin', 'pro') then raise exception 'admin_required'; end if;

  select * into v_event
    from public.events
   where id      = p_event_id
     and club_id = v_club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_club_id;
  if not found then raise exception 'roster_member_not_found'; end if;

  v_member_id := v_roster.claimed_by;

  select * into v_existing
    from public.event_participants
   where event_id = p_event_id
     and (
       roster_member_id = p_roster_member_id
       or (v_member_id is not null and profile_id = v_member_id)
     )
   for update;
  v_existing_found := found;

  if v_existing_found and v_existing.status in ('confirmed', 'waitlisted', 'offered') then
    raise exception 'already_joined';
  end if;

  select
    (select count(*)
       from public.event_participants
       where event_id = p_event_id
         and status   in ('confirmed', 'offered')
         and role     = 'participant')
    +
    (select count(*)
       from public.event_guests
       where event_id = p_event_id
         and status   = 'active')
    into v_occupied;

  v_new_status := case when v_occupied >= v_event.capacity then 'waitlisted' else 'confirmed' end;

  if v_existing_found then
    update public.event_participants
       set status           = v_new_status,
           profile_id       = v_member_id,
           roster_member_id = p_roster_member_id,
           offer_expires_at = null,
           updated_at       = now()
     where id = v_existing.id
    returning * into v_result;
  else
    insert into public.event_participants (event_id, profile_id, roster_member_id, role, status)
    values (p_event_id, v_member_id, p_roster_member_id, 'participant', v_new_status)
    returning * into v_result;
  end if;

  if v_result.id is null then
    raise exception 'event_participant_write_failed';
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'admin_add_roster_participant', 'event', p_event_id,
    jsonb_build_object(
      'roster_member_id', p_roster_member_id,
      'member_id',        v_member_id,
      'member_claimed',   v_member_id is not null,
      'final_status',     v_new_status
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.admin_add_roster_participant(uuid, uuid, uuid) from public, anon;
grant  execute on function public.admin_add_roster_participant(uuid, uuid, uuid) to authenticated;


create or replace function public.admin_force_confirm_roster_participant(
  p_event_id          uuid,
  p_expected_club_id  uuid,
  p_roster_member_id  uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id          uuid;
  v_role             text;
  v_event            public.events%rowtype;
  v_roster           public.roster_members%rowtype;
  v_current_member_id uuid;
  v_participant_id   uuid;
  v_old_status       text;
  v_occupied         int;
  v_was_over_cap     boolean;
  v_result           public.event_participants%rowtype;
  v_notification_id  uuid;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is null or v_role not in ('admin', 'pro') then raise exception 'admin_required'; end if;

  select * into v_event
    from public.events
   where id      = p_event_id
     and club_id = v_club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_club_id;
  if not found then raise exception 'roster_member_not_found'; end if;
  v_current_member_id := v_roster.claimed_by;

  select id, status into v_participant_id, v_old_status
    from public.event_participants
   where event_id         = p_event_id
     and roster_member_id = p_roster_member_id;
  if not found then raise exception 'participant_not_found'; end if;
  if v_old_status = 'confirmed' then raise exception 'already_joined'; end if;

  select
    (select count(*)
       from public.event_participants
       where event_id = p_event_id
         and status   in ('confirmed', 'offered')
         and role     = 'participant')
    +
    (select count(*)
       from public.event_guests
       where event_id = p_event_id
         and status   = 'active')
    into v_occupied;
  v_was_over_cap := v_occupied >= v_event.capacity;

  update public.event_participants
     set status           = 'confirmed',
         offer_expires_at = null,
         updated_at       = now()
   where id = v_participant_id
  returning * into v_result;

  if v_current_member_id is not null then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id, v_current_member_id, 'waitlist_promoted',
      'An admin confirmed your spot in "' || v_event.title || '".',
      jsonb_build_object('event_id', p_event_id, 'triggered_by', auth.uid())
    )
    returning id into v_notification_id;
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'admin_force_confirm', 'event', p_event_id,
    jsonb_build_object(
      'event_title',       v_event.title,
      'roster_member_id',  p_roster_member_id,
      'previous_status',   v_old_status,
      'was_over_capacity', v_was_over_cap
    )
  );

  return jsonb_build_object('participant', to_jsonb(v_result), 'notification_id', v_notification_id);
end;
$$;

revoke execute on function public.admin_force_confirm_roster_participant(uuid, uuid, uuid) from public, anon;
grant  execute on function public.admin_force_confirm_roster_participant(uuid, uuid, uuid) to authenticated;


create or replace function public.admin_offer_spot_roster_participant(
  p_event_id          uuid,
  p_expected_club_id  uuid,
  p_roster_member_id  uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id            uuid;
  v_role               text;
  v_event              public.events%rowtype;
  v_roster             public.roster_members%rowtype;
  v_current_member_id  uuid;
  v_target_row         public.event_participants%rowtype;
  v_slot_count         int;
  v_offer_window_hours int;
  v_offer_expires_at   timestamptz;
  v_tz                 text;
  v_expires_label      text;
  v_skipped_ids        uuid[];
  v_result             public.event_participants%rowtype;
  v_notification_id    uuid;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is null or v_role not in ('admin', 'pro') then raise exception 'admin_required'; end if;

  select * into v_event
    from public.events
   where id      = p_event_id
     and club_id = v_club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_club_id;
  if not found then raise exception 'roster_member_not_found'; end if;
  v_current_member_id := v_roster.claimed_by;

  select * into v_target_row
    from public.event_participants
   where event_id         = p_event_id
     and roster_member_id = p_roster_member_id
     and status            = 'waitlisted';
  if not found then raise exception 'participant_not_found'; end if;

  if exists (
    select 1 from public.event_participants
    where event_id        = p_event_id
      and status          = 'offered'
      and offer_expires_at > now()
  ) then raise exception 'offer_already_active'; end if;

  select
    (select count(*)
       from public.event_participants
       where event_id = p_event_id
         and status   in ('confirmed', 'offered')
         and role     = 'participant')
    +
    (select count(*)
       from public.event_guests
       where event_id = p_event_id
         and status   = 'active')
    into v_slot_count;

  if v_slot_count >= v_event.capacity then
    raise exception 'no_capacity_for_offer';
  end if;

  select coalesce(array_agg(roster_member_id order by created_at asc), '{}') into v_skipped_ids
    from public.event_participants
   where event_id         = p_event_id
     and status            = 'waitlisted'
     and roster_member_id <> p_roster_member_id
     and created_at        < v_target_row.created_at;

  select waitlist_offer_window_hours into v_offer_window_hours
    from public.club_settings
   where club_id = v_club_id;
  if not found then v_offer_window_hours := 2; end if;

  v_offer_expires_at := now() + (v_offer_window_hours || ' hours')::interval;
  select timezone into v_tz from public.clubs where id = v_club_id;
  v_expires_label := to_char(v_offer_expires_at at time zone coalesce(v_tz, 'UTC'), 'Mon DD "at" HH12:MI AM');

  update public.event_participants
     set status           = 'offered',
         offer_expires_at = v_offer_expires_at,
         updated_at       = now()
   where id = v_target_row.id
  returning * into v_result;

  if v_current_member_id is not null then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id, v_current_member_id, 'waitlist_offer',
      'A spot opened in "' || v_event.title || '"! Accept by ' || v_expires_label || '.',
      jsonb_build_object('event_id', p_event_id, 'offer_expires_at', v_offer_expires_at, 'triggered_by', auth.uid())
    )
    returning id into v_notification_id;
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'admin_offer_spot', 'event', p_event_id,
    jsonb_build_object(
      'event_title',              v_event.title,
      'roster_member_id',         p_roster_member_id,
      'offer_expires_at',         v_offer_expires_at,
      'skipped_roster_member_ids', v_skipped_ids
    )
  );

  return jsonb_build_object('participant', to_jsonb(v_result), 'notification_id', v_notification_id);
end;
$$;

revoke execute on function public.admin_offer_spot_roster_participant(uuid, uuid, uuid) from public, anon;
grant  execute on function public.admin_offer_spot_roster_participant(uuid, uuid, uuid) to authenticated;


create or replace function public.admin_force_confirm(
  p_event_id   uuid,
  p_profile_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor            public.profiles%rowtype;
  v_event            public.events%rowtype;
  v_old_status       text;
  v_occupied         int;
  v_was_over_cap     boolean;
  v_result           public.event_participants%rowtype;
  v_notification_id  uuid;
begin
  select * into v_actor from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_actor.role not in ('admin', 'pro') then
    raise exception 'admin_required';
  end if;

  select * into v_event
    from public.events
    where id      = p_event_id
      and club_id = v_actor.club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  if not exists (
    select 1 from public.profiles
    where id      = p_profile_id
      and club_id = v_actor.club_id
      and status  = 'active'
  ) then
    if not exists (select 1 from public.profiles where id = p_profile_id and club_id = v_actor.club_id) then
      raise exception 'member_not_found';
    end if;
    raise exception 'member_inactive';
  end if;

  select status into v_old_status
    from public.event_participants
    where event_id   = p_event_id
      and profile_id = p_profile_id;
  if not found then raise exception 'participant_not_found'; end if;
  if v_old_status = 'confirmed' then raise exception 'already_joined'; end if;

  select
    (select count(*)
       from public.event_participants
       where event_id = p_event_id
         and status   in ('confirmed', 'offered')
         and role     = 'participant')
    +
    (select count(*)
       from public.event_guests
       where event_id = p_event_id
         and status   = 'active')
    into v_occupied;

  v_was_over_cap := v_occupied >= v_event.capacity;

  update public.event_participants
    set status           = 'confirmed',
        offer_expires_at = null,
        updated_at       = now()
    where event_id   = p_event_id
      and profile_id = p_profile_id
    returning * into v_result;

  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_actor.club_id,
    p_profile_id,
    'waitlist_promoted',
    'An admin confirmed your spot in "' || v_event.title || '".',
    jsonb_build_object('event_id', p_event_id, 'triggered_by', auth.uid())
  )
  returning id into v_notification_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'admin_force_confirm',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_title',       v_event.title,
      'profile_id',        p_profile_id,
      'previous_status',   v_old_status,
      'was_over_capacity', v_was_over_cap
    )
  );

  return jsonb_build_object(
    'participant',      to_jsonb(v_result),
    'notification_id',  v_notification_id
  );
end;
$$;

revoke execute on function public.admin_force_confirm(uuid, uuid) from public, anon;
grant  execute on function public.admin_force_confirm(uuid, uuid) to authenticated;


create or replace function public.admin_offer_spot(
  p_event_id   uuid,
  p_profile_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor              public.profiles%rowtype;
  v_event              public.events%rowtype;
  v_target_row         public.event_participants%rowtype;
  v_slot_count         int;
  v_offer_window_hours int;
  v_offer_expires_at   timestamptz;
  v_tz                 text;
  v_expires_label      text;
  v_skipped_ids        uuid[];
  v_result             public.event_participants%rowtype;
  v_notification_id    uuid;
begin
  select * into v_actor from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_actor.role not in ('admin', 'pro') then
    raise exception 'admin_required';
  end if;

  select * into v_event
    from public.events
    where id      = p_event_id
      and club_id = v_actor.club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  select * into v_target_row
    from public.event_participants
    where event_id   = p_event_id
      and profile_id = p_profile_id
      and status     = 'waitlisted';
  if not found then raise exception 'participant_not_found'; end if;

  if exists (
    select 1 from public.event_participants
    where event_id        = p_event_id
      and status          = 'offered'
      and offer_expires_at > now()
  ) then raise exception 'offer_already_active'; end if;

  select
    (select count(*)
       from public.event_participants
       where event_id = p_event_id
         and status   in ('confirmed', 'offered')
         and role     = 'participant')
    +
    (select count(*)
       from public.event_guests
       where event_id = p_event_id
         and status   = 'active')
    into v_slot_count;

  if v_slot_count >= v_event.capacity then
    raise exception 'no_capacity_for_offer';
  end if;

  select coalesce(array_agg(profile_id order by created_at asc), '{}') into v_skipped_ids
    from public.event_participants
    where event_id   = p_event_id
      and status     = 'waitlisted'
      and profile_id <> p_profile_id
      and created_at < v_target_row.created_at;

  select waitlist_offer_window_hours into v_offer_window_hours
    from public.club_settings
    where club_id = v_actor.club_id;

  if not found then
    v_offer_window_hours := 2;
  end if;

  v_offer_expires_at := now() + (v_offer_window_hours || ' hours')::interval;

  select timezone into v_tz from public.clubs where id = v_actor.club_id;

  v_expires_label := to_char(
    v_offer_expires_at at time zone coalesce(v_tz, 'UTC'),
    'Mon DD "at" HH12:MI AM'
  );

  update public.event_participants
    set status           = 'offered',
        offer_expires_at = v_offer_expires_at,
        updated_at       = now()
    where event_id   = p_event_id
      and profile_id = p_profile_id
    returning * into v_result;

  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_actor.club_id,
    p_profile_id,
    'waitlist_offer',
    'A spot opened in "' || v_event.title || '"! Accept by ' || v_expires_label || '.',
    jsonb_build_object(
      'event_id',         p_event_id,
      'offer_expires_at', v_offer_expires_at,
      'triggered_by',     auth.uid()
    )
  )
  returning id into v_notification_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'admin_offer_spot',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_title',         v_event.title,
      'profile_id',          p_profile_id,
      'offer_expires_at',    v_offer_expires_at,
      'skipped_profile_ids', v_skipped_ids
    )
  );

  return jsonb_build_object(
    'participant',     to_jsonb(v_result),
    'notification_id', v_notification_id
  );
end;
$$;

revoke execute on function public.admin_offer_spot(uuid, uuid) from public, anon;
grant  execute on function public.admin_offer_spot(uuid, uuid) to authenticated;


create or replace function public.advance_waitlist_offer(
  p_event_id    uuid,
  p_club_id     uuid,
  p_event_title text,
  p_actor_id    uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_next_id               uuid;
  v_next_roster_member_id uuid;
  v_current_member_id     uuid;
  v_offer_window_hours    int;
  v_offer_expires_at      timestamptz;
  v_tz                    text;
  v_expires_label         text;
  v_slot_count            int;
  v_capacity              int;
  v_notification_id       uuid;
  v_no_result             jsonb := jsonb_build_object('offered_profile_id', null, 'notification_id', null);
begin
  if exists (
    select 1 from public.event_participants
    where event_id        = p_event_id
      and status          = 'offered'
      and offer_expires_at > now()
  ) then
    return v_no_result;
  end if;

  select
    (select count(*)
       from public.event_participants
       where event_id = p_event_id
         and status   in ('confirmed', 'offered')
         and role     = 'participant')
    +
    (select count(*)
       from public.event_guests
       where event_id = p_event_id
         and status   = 'active')
    into v_slot_count;

  select capacity into v_capacity from public.events where id = p_event_id;

  if v_slot_count >= coalesce(v_capacity, 0) then
    return v_no_result;
  end if;

  select id, roster_member_id into v_next_id, v_next_roster_member_id
    from public.event_participants
    where event_id = p_event_id
      and status   = 'waitlisted'
    order by created_at asc
    limit 1;

  if not found then
    return v_no_result;
  end if;

  select waitlist_offer_window_hours into v_offer_window_hours
    from public.club_settings
    where club_id = p_club_id;

  if not found then
    v_offer_window_hours := 2;
  end if;

  v_offer_expires_at := now() + (v_offer_window_hours || ' hours')::interval;

  select timezone into v_tz from public.clubs where id = p_club_id;

  v_expires_label := to_char(
    v_offer_expires_at at time zone coalesce(v_tz, 'UTC'),
    'Mon DD "at" HH12:MI AM'
  );

  update public.event_participants
    set status           = 'offered',
        offer_expires_at = v_offer_expires_at,
        updated_at       = now()
    where id = v_next_id;

  select claimed_by into v_current_member_id
    from public.roster_members
   where id = v_next_roster_member_id;

  if v_current_member_id is not null then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      p_club_id,
      v_current_member_id,
      'waitlist_offer',
      'A spot opened in "' || p_event_title || '"! Accept by ' || v_expires_label || '.',
      case when p_actor_id is null then
        jsonb_build_object(
          'event_id',         p_event_id,
          'offer_expires_at', v_offer_expires_at
        )
      else
        jsonb_build_object(
          'event_id',         p_event_id,
          'offer_expires_at', v_offer_expires_at,
          'triggered_by',     p_actor_id
        )
      end
    )
    returning id into v_notification_id;
  end if;

  return jsonb_build_object(
    'offered_profile_id', v_current_member_id,
    'notification_id',    v_notification_id
  );
end;
$$;

revoke execute on function public.advance_waitlist_offer(uuid, uuid, text, uuid) from public, anon, authenticated;


create or replace function public.update_event(
  p_event_id             uuid,
  p_expected_club_id     uuid,
  p_expected_updated_at  timestamptz,
  p_title                text,
  p_event_type_id        uuid,
  p_starts_at            timestamptz,
  p_ends_at              timestamptz,
  p_court_ids            uuid[],
  p_capacity             int,
  p_description          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id              uuid;
  v_role                 text;
  v_before                events%rowtype;
  v_after                 events%rowtype;
  v_existing_court_ids    uuid[];
  v_retained_ids          uuid[];
  v_removed_ids           uuid[];
  v_added_ids             uuid[];
  v_court_id              uuid;
  v_dup_count             int;
  v_distinct_count        int;
  v_time_changed          boolean;
  v_court_set_changed     boolean;
  v_occupied              int;
  v_changed_fields        text[] := '{}';
  v_canonical_notes       text;
  v_audit_before          jsonb;
  v_audit_after           jsonb;
  v_notifications         jsonb := '[]'::jsonb;
  v_notify_roster_member_id uuid;
  v_notify_member_id     uuid;
  v_new_notification_id   uuid;
  v_exception_transitioned boolean;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;

  select * into v_before
    from events
    where id = p_event_id and club_id = v_club_id
    for update;
  if not found then raise exception 'event_not_found'; end if;

  if v_before.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_before.archived_at is not null then raise exception 'event_archived'; end if;
  if v_before.starts_at <= now() then raise exception 'event_started'; end if;

  if v_before.updated_at is distinct from p_expected_updated_at then
    raise exception 'stale_edit_conflict';
  end if;

  if v_before.program_id is not null then
    if p_title is distinct from v_before.title
       or p_event_type_id is distinct from v_before.event_type_id
       or p_description is distinct from v_before.description
    then
      raise exception 'program_session_field_not_editable';
    end if;
  end if;

  if p_title is null or length(btrim(p_title)) = 0 then raise exception 'invalid_title'; end if;
  if p_event_type_id is null then raise exception 'event_type_not_found'; end if;
  if p_starts_at is null or p_ends_at is null then raise exception 'invalid_duration'; end if;

  if p_court_ids is null or array_length(p_court_ids, 1) is null then
    raise exception 'court_required';
  end if;

  select count(*), count(distinct c) into v_dup_count, v_distinct_count
    from unnest(p_court_ids) as c;
  if v_dup_count <> v_distinct_count then
    raise exception 'duplicate_court_in_event';
  end if;

  if p_ends_at <= p_starts_at then raise exception 'invalid_duration'; end if;
  if p_capacity is null or p_capacity <= 0 then raise exception 'invalid_capacity'; end if;

  -- Capacity floor: confirmed/offered participants (role='participant') +
  -- active guests only (Phase 33E2).
  select
    (select count(*) from event_participants
       where event_id = p_event_id and status in ('confirmed', 'offered') and role = 'participant')
    + (select count(*) from event_guests where event_id = p_event_id and status = 'active')
    into v_occupied;

  if p_capacity < v_occupied then raise exception 'capacity_below_participants'; end if;

  if exists (
    select 1 from unnest(p_court_ids) as t(id)
    where not exists (
      select 1 from courts c
      where c.id = t.id and c.club_id = v_club_id and c.is_active = true
    )
  ) then
    raise exception 'invalid_court';
  end if;

  with locked_res as (
    select * from reservations
    where event_id = p_event_id and reason = 'event' and status in ('pending', 'confirmed')
    for update
  )
  select array_agg(court_id) into v_existing_court_ids from locked_res;
  v_existing_court_ids := coalesce(v_existing_court_ids, '{}');

  select notes into v_canonical_notes
    from reservations
    where event_id = p_event_id and reason = 'event' and status in ('pending', 'confirmed')
    order by (notes is null), court_id
    limit 1;

  select coalesce(array_agg(c), '{}') into v_retained_ids
    from unnest(v_existing_court_ids) c where c = any(p_court_ids);
  select coalesce(array_agg(c), '{}') into v_removed_ids
    from unnest(v_existing_court_ids) c where not (c = any(p_court_ids));
  select coalesce(array_agg(c), '{}') into v_added_ids
    from unnest(p_court_ids) c where not (c = any(v_existing_court_ids));

  v_time_changed      := p_starts_at is distinct from v_before.starts_at
                          or p_ends_at is distinct from v_before.ends_at;
  v_court_set_changed := array_length(v_removed_ids, 1) is not null
                          or array_length(v_added_ids, 1) is not null;

  if p_title is distinct from v_before.title then
    v_changed_fields := array_append(v_changed_fields, 'title');
  end if;
  if p_event_type_id is distinct from v_before.event_type_id then
    v_changed_fields := array_append(v_changed_fields, 'event_type_id');
  end if;
  if p_starts_at is distinct from v_before.starts_at then
    v_changed_fields := array_append(v_changed_fields, 'starts_at');
  end if;
  if p_ends_at is distinct from v_before.ends_at then
    v_changed_fields := array_append(v_changed_fields, 'ends_at');
  end if;
  if p_capacity is distinct from v_before.capacity then
    v_changed_fields := array_append(v_changed_fields, 'capacity');
  end if;
  if p_description is distinct from v_before.description then
    v_changed_fields := array_append(v_changed_fields, 'description');
  end if;
  if v_court_set_changed then
    v_changed_fields := array_append(v_changed_fields, 'court_ids');
  end if;

  if array_length(v_changed_fields, 1) is null then
    return jsonb_build_object(
      'event',          to_jsonb(v_before),
      'changed_fields', to_jsonb(v_changed_fields),
      'notifications',  '[]'::jsonb
    );
  end if;

  if v_time_changed then
    update reservations
      set starts_at = p_starts_at, ends_at = p_ends_at, updated_at = now()
      where event_id = p_event_id and reason = 'event' and status in ('pending', 'confirmed')
        and court_id = any(v_retained_ids);
  end if;

  update reservations
    set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
        cancellation_kind = 'system', updated_at = now()
    where event_id = p_event_id and reason = 'event' and status in ('pending', 'confirmed')
      and court_id = any(v_removed_ids);

  foreach v_court_id in array v_added_ids loop
    insert into reservations (
      club_id, court_id, owner_user_id, starts_at, ends_at, status, reason,
      event_id, created_by, notes
    ) values (
      v_club_id, v_court_id, v_before.created_by, p_starts_at, p_ends_at, 'confirmed',
      'event', p_event_id, v_before.created_by, v_canonical_notes
    );
  end loop;

  v_exception_transitioned := (v_before.program_id is not null and v_before.is_program_exception = false);

  if p_event_type_id is distinct from v_before.event_type_id then
    update events set
      title                 = p_title,
      event_type_id         = p_event_type_id,
      starts_at             = p_starts_at,
      ends_at               = p_ends_at,
      capacity              = p_capacity,
      description           = p_description,
      court_count           = array_length(p_court_ids, 1),
      is_program_exception  = case when v_before.program_id is not null then true else v_before.is_program_exception end,
      updated_at            = now()
    where id = p_event_id
    returning * into v_after;
  else
    update events set
      title                 = p_title,
      starts_at             = p_starts_at,
      ends_at               = p_ends_at,
      capacity              = p_capacity,
      description           = p_description,
      court_count           = array_length(p_court_ids, 1),
      is_program_exception  = case when v_before.program_id is not null then true else v_before.is_program_exception end,
      updated_at            = now()
    where id = p_event_id
    returning * into v_after;
  end if;

  v_audit_before := jsonb_build_object(
    'title', v_before.title, 'event_type_id', v_before.event_type_id,
    'starts_at', v_before.starts_at, 'ends_at', v_before.ends_at,
    'capacity', v_before.capacity, 'description', v_before.description
  );
  v_audit_after := jsonb_build_object(
    'title', v_after.title, 'event_type_id', v_after.event_type_id,
    'starts_at', v_after.starts_at, 'ends_at', v_after.ends_at,
    'capacity', v_after.capacity, 'description', v_after.description
  );

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id,
    auth.uid(),
    'update_event',
    'event',
    p_event_id,
    jsonb_build_object(
      'changed_fields',              v_changed_fields,
      'before',                      v_audit_before,
      'after',                       v_audit_after,
      'program_id',                  v_before.program_id,
      'is_program_exception_set',    v_exception_transitioned,
      'old_court_ids',               to_jsonb(v_existing_court_ids),
      'new_court_ids',               to_jsonb(p_court_ids)
    )
  );

  if p_capacity > v_before.capacity then
    perform expire_stale_offers_for_event(p_event_id, v_club_id, v_after.title);
    perform advance_waitlist_offer(p_event_id, v_club_id, v_after.title);
  end if;

  if 'title' = any(v_changed_fields)
     or 'event_type_id' = any(v_changed_fields)
     or 'starts_at' = any(v_changed_fields)
     or 'ends_at' = any(v_changed_fields)
     or 'court_ids' = any(v_changed_fields)
     or 'capacity' = any(v_changed_fields)
  then
    for v_notify_roster_member_id in
      select roster_member_id from event_participants
      where event_id = p_event_id and status in ('confirmed', 'waitlisted', 'offered')
    loop
      select claimed_by into v_notify_member_id
        from roster_members
       where id = v_notify_roster_member_id;

      if v_notify_member_id is not null then
        insert into notifications (club_id, user_id, kind, body, metadata)
        values (
          v_club_id,
          v_notify_member_id,
          'event_updated',
          '"' || v_after.title || '" was updated — check the calendar for the latest details.',
          jsonb_build_object('event_id', p_event_id)
        )
        returning id into v_new_notification_id;

        v_notifications := v_notifications || jsonb_build_object(
          'notification_id', v_new_notification_id,
          'user_id',          v_notify_member_id
        );
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'event',          to_jsonb(v_after),
    'changed_fields', to_jsonb(v_changed_fields),
    'notifications',  v_notifications
  );
end;
$$;

revoke execute on function public.update_event(
  uuid, uuid, timestamptz, text, uuid, timestamptz, timestamptz, uuid[], int, text
) from public, anon;
grant execute on function public.update_event(
  uuid, uuid, timestamptz, text, uuid, timestamptz, timestamptz, uuid[], int, text
) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- L. Reporting identity parity — re-keyed to the now-trustworthy roster
--    lifecycle. Only get_member_engagement_summary, get_reporting_overview,
--    and get_event_program_summary change; get_reservation_summary and
--    get_waitlist_demand (both also in 0095/0096) are untouched — out of
--    this checkpoint's scope.
--
--    SELF-GUARD (correction): get_member_engagement_summary below re-keys
--    its reservation-engagement CTE from owner_user_id + club_memberships
--    joins to roster_member_id + roster_members joins directly. That
--    re-key is only safe if there are zero legitimate 'member_booking'
--    reservations that have an accountholder owner but no resolved roster
--    identity — such a row would silently vanish from Member engagement
--    metrics under the new roster-keyed query, with no error to signal it.
--    This was verified against live production data during this
--    checkpoint's audit (zero such rows), but the migration must not rely
--    on a point-in-time read taken outside the transaction — it re-checks
--    the exact same predicate here, inside the migration itself, and
--    raises + rolls back rather than applying a reporting change on top of
--    an unverified assumption. Existing unclaimed roster rows are
--    deliberately NOT touched by this guard or backfilled to 'inactive'
--    based on activity recency — no trustworthy historical signal exists
--    to infer that from, so they continue to initialize as 'active' (see
--    Section A).
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_ambiguous_count int;
begin
  select count(*) into v_ambiguous_count
  from public.reservations r
  where r.owner_user_id is not null
    and r.roster_member_id is null
    and r.reason = 'member_booking';

  if v_ambiguous_count > 0 then
    raise exception
      'member_engagement_reservation_identity_ambiguous: % member_booking reservations have an accountholder owner but no resolved roster_member_id — the roster-keyed engagement re-key would silently drop them',
      v_ambiguous_count;
  end if;
end $$;

-- get_reporting_overview: active_member_count moves from club_memberships
-- (blind to no-account Members) to roster_members (role='member' and
-- status='active') — the SAME definition get_member_engagement_summary now
-- uses below, per the product requirement that both reports agree on what
-- "Member" means. sess_guests now filters to active guests only, so a
-- soft-cancelled guest no longer inflates total_session_enrollment /
-- session_fill_rate_pct. Every other column/CTE is unchanged.
create or replace function public.get_reporting_overview(
  p_start_date date,
  p_end_date   date
)
returns table (
  gross_utilization_pct         numeric,
  member_demand_utilization_pct numeric,
  total_reservations            bigint,
  cancelled_reservations        bigint,
  cancellation_rate_pct         numeric,
  sessions_held                 bigint,
  total_session_capacity        bigint,
  total_session_enrollment      bigint,
  session_fill_rate_pct         numeric,
  active_member_count           bigint,
  outstanding_waitlist_count    bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_range   tstzrange;
  v_available_hours numeric;
  v_tz      text;
  v_today   date;
begin
  v_club_id := public.current_user_club_id();
  v_role    := public.current_user_role();

  if v_club_id is null then
    raise exception 'not_authenticated';
  end if;

  if v_role <> 'admin' then
    raise exception 'insufficient_role';
  end if;

  v_range := public.club_local_bounds(v_club_id, p_start_date, p_end_date);

  v_available_hours :=
    public._reporting_daily_open_hours(v_club_id, p_start_date, p_end_date)
    * (select count(*) from public.courts where club_id = v_club_id and is_active = true);

  select timezone into v_tz from public.clubs where id = v_club_id;
  v_today := (now() at time zone v_tz)::date;

  return query
  with reserved as (
    select * from public._reporting_reserved_hours(v_club_id, v_range)
  ),
  reserved_totals as (
    select
      coalesce(sum(hours), 0) as gross_hours,
      coalesce(sum(hours) filter (where reason in ('member_booking', 'event', 'pro_lesson')), 0) as member_hours
    from reserved
  ),
  res_counts as (
    select
      count(*) filter (where r.status in ('pending', 'confirmed', 'cancelled')) as total_res,
      count(*) filter (where r.status = 'cancelled')                            as cancelled_res
    from public.reservations r
    where r.club_id = v_club_id
      and r.starts_at >= lower(v_range)
      and r.starts_at <  upper(v_range)
  ),
  sess as (
    select e.id, e.capacity
    from public.events e
    where e.club_id = v_club_id
      and e.starts_at >= lower(v_range)
      and e.starts_at <  upper(v_range)
      and e.starts_at <= now()
      and e.status = 'scheduled'
  ),
  sess_participants as (
    select ep.event_id, count(*) as confirmed_count
    from public.event_participants ep
    join sess s on s.id = ep.event_id
    where ep.status = 'confirmed'
    group by ep.event_id
  ),
  sess_guests as (
    select eg.event_id, count(*) as guest_count
    from public.event_guests eg
    join sess s on s.id = eg.event_id
    where eg.status = 'active'
    group by eg.event_id
  ),
  sess_totals as (
    select
      (select count(*) from sess)                                    as sessions_held,
      (select coalesce(sum(capacity), 0) from sess)                  as total_capacity,
      (select coalesce(sum(confirmed_count), 0) from sess_participants)
        + (select coalesce(sum(guest_count), 0) from sess_guests)    as total_enrollment
  ),
  members as (
    select count(*) as active_count
    from public.roster_members rm
    where rm.club_id = v_club_id
      and rm.role     = 'member'
      and rm.status   = 'active'
  ),
  waitlist as (
    select
      (
        select count(*)
        from public.event_participants ep
        join public.events e on e.id = ep.event_id
        where e.club_id      = v_club_id
          and e.status       = 'scheduled'
          and e.archived_at is null
          and e.starts_at    > now()
          and (
            ep.status = 'waitlisted'
            or (ep.status = 'offered' and ep.offer_expires_at > now())
          )
      )
      +
      (
        select count(*)
        from public.program_enrollments pe
        join public.programs p on p.id = pe.program_id
        where p.club_id          = v_club_id
          and p.enrollment_model = 'program'
          and p.status           = 'active'
          and p.archived_at is null
          and p.ends_on          >= v_today
          and (
            pe.status = 'waitlisted'
            or (pe.status = 'offered' and pe.offer_expires_at > now())
          )
      ) as outstanding_count
  )
  select
    case when v_available_hours = 0 then 0
         else round(100.0 * rt.gross_hours / v_available_hours, 2) end,
    case when v_available_hours = 0 then 0
         else round(100.0 * rt.member_hours / v_available_hours, 2) end,
    rc.total_res,
    rc.cancelled_res,
    case when rc.total_res = 0 then 0
         else round(100.0 * rc.cancelled_res / rc.total_res, 2) end,
    st.sessions_held,
    st.total_capacity,
    st.total_enrollment,
    case when st.total_capacity = 0 then 0
         else round(100.0 * st.total_enrollment / st.total_capacity, 2) end,
    m.active_count,
    w.outstanding_count
  from reserved_totals rt, res_counts rc, sess_totals st, members m, waitlist w;
end;
$$;

revoke execute on function public.get_reporting_overview(date, date)
  from public, anon;
grant execute on function public.get_reporting_overview(date, date)
  to authenticated;


-- get_event_program_summary: enrollment/fill ("guests") now counts only
-- active guests, matching "Enrollment/fill = confirmed Members + active
-- Guests". Attendance (attended_count/no_show_count/attendance_marked_count/
-- attendance_rate_pct/no_show_rate_pct) now includes Guest attendance marks
-- alongside Member attendance marks — counted by attendance_status alone,
-- NOT filtered to status = 'active', so a Guest's attendance mark remains
-- reportable even after that Guest is later soft-removed from the active
-- roster. Every other column (standalone/program sessions held, capacity,
-- cancelled counts) is unchanged.
create or replace function public.get_event_program_summary(
  p_start_date date,
  p_end_date   date
)
returns table (
  standalone_sessions_held     bigint,
  program_sessions_held        bigint,
  total_sessions_held          bigint,
  total_capacity                bigint,
  confirmed_members             bigint,
  guests                        bigint,
  total_enrollment              bigint,
  fill_rate_pct                 numeric,
  attended_count                bigint,
  no_show_count                 bigint,
  attendance_marked_count       bigint,
  attendance_rate_pct           numeric,
  no_show_rate_pct              numeric,
  cancelled_standalone_sessions bigint,
  cancelled_program_sessions    bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_range   tstzrange;
begin
  v_club_id := public.current_user_club_id();
  v_role    := public.current_user_role();

  if v_club_id is null then
    raise exception 'not_authenticated';
  end if;

  if v_role <> 'admin' then
    raise exception 'insufficient_role';
  end if;

  v_range := public.club_local_bounds(v_club_id, p_start_date, p_end_date);

  return query
  with sess as (
    select e.id, e.program_id, e.capacity
    from public.events e
    where e.club_id = v_club_id
      and e.starts_at >= lower(v_range)
      and e.starts_at <  upper(v_range)
      and e.starts_at <= now()
      and e.status = 'scheduled'
  ),
  sess_participants as (
    select
      ep.event_id,
      count(*) filter (where ep.status = 'confirmed')                                    as confirmed_count,
      count(*) filter (where ep.status = 'confirmed' and ep.attendance_status = 'attended') as attended_count,
      count(*) filter (where ep.status = 'confirmed' and ep.attendance_status = 'no_show')  as no_show_count
    from public.event_participants ep
    join sess s on s.id = ep.event_id
    group by ep.event_id
  ),
  sess_guests as (
    select
      eg.event_id,
      count(*) filter (where eg.status = 'active')             as guest_count,
      count(*) filter (where eg.attendance_status = 'attended') as guest_attended_count,
      count(*) filter (where eg.attendance_status = 'no_show')  as guest_no_show_count
    from public.event_guests eg
    join sess s on s.id = eg.event_id
    group by eg.event_id
  ),
  sess_totals as (
    select
      (select count(*) filter (where program_id is null)     from sess) as standalone_held,
      (select count(*) filter (where program_id is not null) from sess) as program_held,
      (select count(*)                                        from sess) as total_held,
      (select coalesce(sum(capacity), 0)                      from sess) as total_capacity,
      (select coalesce(sum(confirmed_count), 0) from sess_participants)  as confirmed_members,
      (select coalesce(sum(guest_count), 0)      from sess_guests)       as guests,
      (select coalesce(sum(attended_count), 0)  from sess_participants)
        + (select coalesce(sum(guest_attended_count), 0) from sess_guests) as attended_total,
      (select coalesce(sum(no_show_count), 0)   from sess_participants)
        + (select coalesce(sum(guest_no_show_count), 0) from sess_guests)  as no_show_total
  ),
  cancelled_sess as (
    select
      count(*) filter (where e.program_id is null)     as cancelled_standalone,
      count(*) filter (where e.program_id is not null) as cancelled_program
    from public.events e
    where e.club_id = v_club_id
      and e.status = 'cancelled'
      and e.starts_at >= lower(v_range)
      and e.starts_at <  upper(v_range)
  )
  select
    st.standalone_held,
    st.program_held,
    st.total_held,
    st.total_capacity,
    st.confirmed_members,
    st.guests,
    (st.confirmed_members + st.guests) as total_enrollment,
    case when st.total_capacity = 0 then 0
         else round(100.0 * (st.confirmed_members + st.guests) / st.total_capacity, 2) end,
    st.attended_total,
    st.no_show_total,
    (st.attended_total + st.no_show_total) as attendance_marked_count,
    case when (st.attended_total + st.no_show_total) = 0 then 0
         else round(100.0 * st.attended_total / (st.attended_total + st.no_show_total), 2) end,
    case when (st.attended_total + st.no_show_total) = 0 then 0
         else round(100.0 * st.no_show_total  / (st.attended_total + st.no_show_total), 2) end,
    cs.cancelled_standalone,
    cs.cancelled_program
  from sess_totals st, cancelled_sess cs;
end;
$$;

revoke execute on function public.get_event_program_summary(date, date)
  from public, anon;
grant execute on function public.get_event_program_summary(date, date)
  to authenticated;


-- get_member_engagement_summary: re-keyed from profile_id/owner_user_id +
-- club_memberships joins to roster_member_id + roster_members joins
-- directly. Reservations/event_participants/program_enrollments already
-- carry a durable, structurally-guaranteed roster_member_id (33D1-33D2b),
-- so this unifies a Member's no-account and claimed history under the SAME
-- durable identity with no double counting, and correctly includes
-- no-account Members for the first time (the prior club_memberships-only
-- design could never see them by construction). Guests/Pros/Admins remain
-- excluded via rm.role = 'member'. active_member_snapshot_count now uses
-- the same roster-based active-Member definition as get_reporting_overview
-- above. Live production data confirmed zero ambiguous reservations rows
-- (owner_user_id not null, roster_member_id null, reason='member_booking')
-- — no backfill needed; the inner join to roster_members naturally excludes
-- the only reservations that do lack roster_member_id (staff-owned
-- 'event'/'maintenance' housekeeping rows), which were already excluded
-- from this report for the same reason (staff role) before this change.
create or replace function public.get_member_engagement_summary(
  p_start_date date,
  p_end_date   date
)
returns table (
  active_member_snapshot_count     bigint,
  engaged_member_count             bigint,
  members_with_reservations        bigint,
  members_with_event_participation bigint,
  members_with_program_enrollment  bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_range   tstzrange;
begin
  v_club_id := public.current_user_club_id();
  v_role    := public.current_user_role();

  if v_club_id is null then
    raise exception 'not_authenticated';
  end if;

  if v_role <> 'admin' then
    raise exception 'insufficient_role';
  end if;

  v_range := public.club_local_bounds(v_club_id, p_start_date, p_end_date);

  return query
  with active_members as (
    select count(*) as active_count
    from public.roster_members rm
    where rm.club_id = v_club_id
      and rm.role     = 'member'
      and rm.status   = 'active'
  ),
  reservation_members as (
    select distinct r.roster_member_id
    from public.reservations r
    join public.roster_members rm
      on rm.id      = r.roster_member_id
     and rm.club_id = v_club_id
     and rm.role    = 'member'
    where r.club_id = v_club_id
      and r.status in ('pending', 'confirmed')
      and r.starts_at >= lower(v_range)
      and r.starts_at <  upper(v_range)
  ),
  event_members as (
    select distinct ep.roster_member_id
    from public.event_participants ep
    join public.events e on e.id = ep.event_id
    join public.roster_members rm
      on rm.id      = ep.roster_member_id
     and rm.club_id = v_club_id
     and rm.role    = 'member'
    where e.club_id = v_club_id
      and ep.status = 'confirmed'
      and e.starts_at >= lower(v_range)
      and e.starts_at <  upper(v_range)
  ),
  program_members as (
    select distinct pe.roster_member_id
    from public.program_enrollments pe
    join public.programs p on p.id = pe.program_id
    join public.roster_members rm
      on rm.id      = pe.roster_member_id
     and rm.club_id = v_club_id
     and rm.role    = 'member'
    where p.club_id = v_club_id
      and p.enrollment_model = 'program'
      and pe.status = 'enrolled'
      and p.starts_on <= p_end_date
      and p.ends_on   >= p_start_date
  ),
  engaged as (
    select roster_member_id from reservation_members
    union
    select roster_member_id from event_members
    union
    select roster_member_id from program_members
  )
  select
    am.active_count,
    (select count(*) from engaged),
    (select count(*) from reservation_members),
    (select count(*) from event_members),
    (select count(*) from program_members)
  from active_members am;
end;
$$;

revoke execute on function public.get_member_engagement_summary(date, date)
  from public, anon;
grant execute on function public.get_member_engagement_summary(date, date)
  to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- Schema additions (roster_members.status/removed_at/removed_by,
-- event_guests.status/attendance_status/cancelled_at/cancelled_by) would
-- need explicit ALTER TABLE ... DROP COLUMN statements — not reversible via
-- CREATE OR REPLACE. Every function in sections B-L except get_roster_
-- members kept its exact pre-0117 signature and return shape — restoring
-- pre-0117 bodies is a direct CREATE OR REPLACE FUNCTION for each, using
-- the prior migration's body verbatim (0086 for the three sync hooks; 0107
-- for create_club_invite/resend_club_invite/accept_club_invite; 0115 for
-- get_program_eligible_roster_members; 0061 for admin_add_guest/
-- admin_remove_guest/admin_add_roster_member_to_event — note
-- admin_remove_guest's rollback restores hard-DELETE semantics, which is
-- itself destructive to any soft-cancel history recorded in the interim;
-- 0113 for get_event_roster/advance_waitlist_offer/admin_force_confirm_
-- roster_participant/admin_offer_spot_roster_participant/update_event;
-- 0114 for admin_add_member/join_event/admin_add_roster_participant; 0102
-- for admin_force_confirm/admin_offer_spot; 0095 for get_reporting_overview;
-- 0096 for get_event_program_summary/get_member_engagement_summary). Note
-- rolling back create_club_invite/resend_club_invite/accept_club_invite
-- does NOT un-revoke any club_invites rows remove_roster_member revoked in
-- the interim (that revocation is data, not a function body, and is
-- correct to keep regardless). get_roster_members changed IDENTITY (0056's
-- zero-arg overload was DROPped, not just replaced) — rollback is itself a
-- DROP + CREATE: `drop function if exists public.get_roster_members
-- (boolean);` then recreate the original zero-arg body verbatim from 0056.
-- New functions mark_attendance_guest/remove_roster_member/restore_roster_
-- member would each need an explicit DROP FUNCTION.
