-- 0132_staff_operational_authorization.sql
-- Phase 34A4: Staff Operational Authorization.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- 0131 (Phase 34A3) made 'staff' a valid stored role with ZERO operational
-- authority — a Staff account could exist but could not do anything an
-- Admin, Pro, or Member couldn't already do for themselves. This migration
-- gives Staff its deliberate, positively-scoped OPERATIONAL authority:
-- generic day-to-day front-desk club operations, modeled as "Admin OR
-- Staff" (a club OPERATOR), kept strictly separate from:
--   • Pro's teaching/provider identity (is_lesson_provider) — untouched,
--     never implied by role='staff' alone.
--   • Admin's CONTROL-PLANE authority (settings, court configuration,
--     event-type configuration, commercial tier, audit log, reports,
--     broad announcements, role/employee-authority changes) — every one
--     of those RPCs/pages keeps its existing admin-only gate, verbatim,
--     untouched by this migration.
--   • The 0131 Member-facing self-service entitlement gate
--     (create_reservation, join_event, join_program,
--     submit_lesson_request) — NOT touched here. Staff's OWN member-style
--     self-service use of those four functions remains governed by
--     member_self_service exactly as 0131 established. Staff's
--     OPERATIONAL authority for reservations/lessons on behalf of OTHER
--     people comes exclusively through the separate operator RPCs widened
--     below, never by loosening those four functions.
--
-- Phase 34A4A correction: the entire migration — the new helper below, its
-- REVOKE/GRANT, every recreated RPC, and all RLS policy changes — now runs
-- inside a single `begin;`/`commit;` transaction, opened immediately below.
-- Previously the helper was created BEFORE `begin;`, which contradicted
-- this file's own single-transaction claim: a failure partway through the
-- rest of the migration would have left the helper installed on its own,
-- an inconsistent partial-apply state. No nested transaction is used.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- NEW HELPER: current_user_is_operator()
-- ═══════════════════════════════════════════════════════════════════════════
-- `Admin OR Staff` is repeated across roughly a dozen RPC gates and RLS
-- policies below — a genuine, non-hidden shared concept (unlike Pro, whose
-- access is either provider-scoped or a separate, narrower case handled
-- individually per function — see each section for the specific reasoning).
-- Mirrors current_user_is_lesson_provider()'s exact shape: SQL language,
-- SECURITY DEFINER, STABLE, fixed search_path, coalesced to a concrete
-- `false`, revoked from public/anon, granted to authenticated (required so
-- RLS USING clauses — evaluated as the querying `authenticated` role — can
-- call it directly).
--
-- NOT used inside PL/pgSQL RPC bodies below that already capture
-- current_user_club_id()/current_user_role() together in one statement
-- (get_members, admin_create_member_reservation, admin_create_member_lesson,
-- etc.) — those functions' own documented rationale (0083) is that
-- capturing club+role in ONE snapshot prevents a concurrent
-- set_active_club() in another session from pairing an Admin role from one
-- club with a different now-active club. Calling this helper as a SEPARATE
-- statement inside those functions would reintroduce exactly that race.
-- Each such function instead tests its own already-captured v_role/
-- v_actor_role/v_profile.role variable directly (`... not in ('admin',
-- 'staff')`) — this helper is for RLS policies and any future call site
-- that has no such existing single-snapshot capture to protect.
create or replace function public.current_user_is_operator()
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select coalesce(public.current_user_role() in ('admin', 'staff'), false);
$$;

revoke execute on function public.current_user_is_operator() from public, anon;
grant  execute on function public.current_user_is_operator() to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- SCOPE OF THIS MIGRATION — what is and is not covered
-- ═══════════════════════════════════════════════════════════════════════════
-- Covered, each reproduced from its current effective body:
--   Members/Roster:   get_members, get_admin_member_detail,
--                      get_member_upcoming_activity,
--                      get_member_activity_history, get_member_notes,
--                      get_roster_members, add_roster_member,
--                      update_roster_member
--   Invitations:       create_club_invite, resend_club_invite,
--                      revoke_club_invite, get_club_invites
--   Reservations:      admin_create_member_reservation,
--                      update_member_reservation, admin_cancel_reservation_v2
--   Lessons:            admin_create_member_lesson, get_lesson_roster_members,
--                      reassign_lesson_provider, get_club_pros,
--                      get_admin_club_pros, submit_lesson_request,
--                      get_pro_lesson_requests, mark_lesson_outcome,
--                      cancel_lesson
--   RLS:                roster_members_select_admin,
--                      lesson_requests_select_admin,
--                      reservations_select_same_club, events_select_same_club,
--                      event_participants_select_same_club,
--                      programs_select_same_club
--
-- DELIBERATELY DEFERRED (not touched by this migration — a positive,
-- documented scope decision, not an oversight):
--   • Event/Program CRUD (create_event, update_event, cancel_event,
--     create_program, update_program, cancel_program,
--     generate_program_sessions) and the 0051-family event-participant/
--     guest/waitlist-offer admin actions (admin_add_member,
--     admin_remove_participant, admin_force_confirm, admin_offer_spot,
--     admin_expire_offer, admin_add_guest, admin_remove_guest) and
--     mark_attendance. Verified (not assumed) that the 0051 family already
--     grants Pro identical, non-provider-scoped access to Admin
--     (`role not in ('admin','pro')`, no further per-event ownership
--     restriction) — so widening that family to admit Staff is the same
--     low-risk, verified pattern used throughout this migration, but the
--     full set (7 event-participant functions + 5 Program functions +
--     event CRUD + attendance, each needing its own latest-effective-body
--     confirmation) is large enough that rushing it within this checkpoint
--     would risk exactly the "copy a stale historical body" mistake this
--     migration's own instructions warn against. Recommended as a focused
--     follow-up checkpoint (e.g. 34A4B), using the identical verified
--     pattern established here.
--   • admin_update_member_lesson (0120) — editing/rescheduling an existing
--     CONFIRMED lesson's time/court. A single very large (278-line)
--     admin-only function; deferred for the same reason as above. Lesson
--     CREATE, ASSIGN/REASSIGN provider, and CANCEL (the higher-frequency
--     front-desk actions) are fully covered below.
--   • Communications: audited, no change needed. send_announcement_rpc
--     (broad club-wide announcements) remains admin-only, untouched —
--     Staff must never gain broadcast authority. Workflow-driven
--     notifications inside every widened function below (reservation/
--     lesson confirmations, cancellations, etc.) already fire
--     unconditionally regardless of actor role — none of them were ever
--     gated by caller role, so Staff-triggered operational actions
--     continue to notify exactly as an Admin-triggered one does today,
--     with zero code change required.
--   • Settings, court configuration, Event Type configuration, commercial
--     tier/entitlement configuration, Audit Log, Reports, set_member_role,
--     set_member_status, set_lesson_provider_status, delete_roster_member:
--     verified untouched — every one keeps its existing admin-only gate,
--     unwidened, per this checkpoint's explicit control-plane boundary.
--   • remove_club_member, restore_club_member, remove_roster_member,
--     restore_roster_member (destructive removal / suspend-reactivate),
--     add_member_note/update_member_note/archive_member_note (note
--     authorship — Staff may READ notes via get_member_notes above, not
--     author them), mark_attendance (Events-domain, deferred with the rest
--     of Step 7): all verified present, all deliberately left admin-only
--     and unwidened, matching this checkpoint's explicit identity-control
--     boundary (Step 3) and the Events-domain deferral above.
--   • KNOWN LIMITATION: the Members/Roster and Lessons RPC lists above were
--     built by tracing every RPC call site on the specific pages this
--     migration's frontend changes open to Staff (admin/members,
--     admin/members/[id], admin/lessons) — not by an exhaustive sweep of
--     every RPC in the codebase. It is possible a further, narrower gap
--     of the same shape (a page Staff can now reach calling one more
--     admin-only RPC not identified here) surfaces in manual QA after this
--     migration lands; the runtime QA plan in the Phase 34A4 report is
--     designed to catch exactly that.
--
-- Not applied by this checkpoint — see the Phase 34A4 report's pre-apply
-- preflight checklist. Apply in Supabase SQL Editor (cloud only).
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════
-- MEMBERS / ROSTER
-- ═══════════════════════════════════════════════════════════════════════════

-- get_members — Phase 34A4A correction: the previous 0132 draft's
-- RETURNS TABLE contract was stale (missing removed_at, and excluded
-- removed memberships from the result entirely via `cm.removed_at is
-- null`). PRODUCTION pg_get_functiondef is the verified source of truth
-- here, not 0083 — production has since added removed_at to the return
-- contract and now returns EVERY membership (removed ones sorted last via
-- `order by (cm.removed_at is not null) asc, ...`), not just active ones.
-- Applying the previous draft's stale 9-column contract against a live
-- 10-column function is exactly what produced the Production 42P13 error
-- ("cannot change return type of existing function"). Copied verbatim
-- from Production below; the ONLY change is the caller-authorization
-- line, preserving Production's existing null-safe `is distinct from`
-- idiom rather than switching to a non-null-safe `not in`: `if
-- v_actor_role is distinct from 'admin' then` -> `if v_actor_role is
-- distinct from 'admin' and v_actor_role is distinct from 'staff' then`.
CREATE OR REPLACE FUNCTION public.get_members()
 RETURNS TABLE(id uuid, first_name text, last_name text, phone text, role text, status text, created_at timestamp with time zone, email text, is_lesson_provider boolean, removed_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor_club_id uuid;
  v_actor_role    text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  select public.current_user_club_id(), public.current_user_role()
    into v_actor_club_id, v_actor_role;

  if v_actor_role is distinct from 'admin' and v_actor_role is distinct from 'staff' then
    raise exception 'insufficient_role';
  end if;

  return query
    select
      p.id,
      p.first_name,
      p.last_name,
      p.phone,
      cm.role,
      cm.status,
      p.created_at,
      u.email::text as email,
      cm.is_lesson_provider,
      cm.removed_at
    from public.club_memberships cm
    join public.profiles p on p.id = cm.user_id
    left join auth.users u on u.id = p.id
   where cm.club_id = v_actor_club_id
   order by (cm.removed_at is not null) asc,
            p.last_name asc nulls last, p.first_name asc nulls last;
end;
$function$;

revoke execute on function public.get_members() from public, anon;
grant  execute on function public.get_members() to authenticated;


-- get_admin_member_detail — Phase 34A4A correction: the previous 0132
-- draft's RETURNS TABLE contract was stale (missing removed_at) and its
-- target-membership lookup incorrectly excluded removed memberships
-- (`and cm.removed_at is null`), which Production does not do — copied
-- verbatim from Production below, source of truth, not 0083. The ONLY
-- change is the caller-authorization line, preserving Production's
-- existing null-safe `is distinct from` idiom: `if v_actor_role is
-- distinct from 'admin' then` -> `if v_actor_role is distinct from
-- 'admin' and v_actor_role is distinct from 'staff' then`.
CREATE OR REPLACE FUNCTION public.get_admin_member_detail(p_member_id uuid)
 RETURNS TABLE(id uuid, first_name text, last_name text, phone text, role text, status text, created_at timestamp with time zone, email text, is_lesson_provider boolean, removed_at timestamp with time zone, attended_event_count bigint, event_no_show_count bigint, completed_lesson_count bigint, member_lesson_no_show_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor_club_id uuid;
  v_actor_role    text;
  v_membership    public.club_memberships%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  select public.current_user_club_id(), public.current_user_role()
    into v_actor_club_id, v_actor_role;

  if v_actor_role is distinct from 'admin' and v_actor_role is distinct from 'staff' then
    raise exception 'insufficient_role';
  end if;

  select cm.* into v_membership
    from public.club_memberships cm
   where cm.user_id = p_member_id
     and cm.club_id = v_actor_club_id;

  if not found then
    raise exception 'member_not_found';
  end if;

  return query
    select
      p.id,
      p.first_name,
      p.last_name,
      p.phone,
      v_membership.role,
      v_membership.status,
      p.created_at,
      u.email::text as email,
      v_membership.is_lesson_provider,
      v_membership.removed_at,
      (
        select count(*) from public.event_participants ep
          join public.events ev on ev.id = ep.event_id
         where ep.profile_id        = p_member_id
           and ep.attendance_status = 'attended'
           and ev.club_id           = v_actor_club_id
      ) as attended_event_count,
      (
        select count(*) from public.event_participants ep
          join public.events ev on ev.id = ep.event_id
         where ep.profile_id        = p_member_id
           and ep.attendance_status = 'no_show'
           and ev.club_id           = v_actor_club_id
      ) as event_no_show_count,
      (
        select count(*) from public.lesson_requests lr
         where lr.member_id      = p_member_id
           and lr.club_id        = v_actor_club_id
           and lr.lesson_outcome = 'completed'
      ) as completed_lesson_count,
      (
        select count(*) from public.lesson_requests lr
         where lr.member_id      = p_member_id
           and lr.club_id        = v_actor_club_id
           and lr.lesson_outcome = 'member_no_show'
      ) as member_lesson_no_show_count
    from public.profiles p
    left join auth.users u on u.id = p.id
   where p.id = p_member_id;
end;
$function$;

revoke execute on function public.get_admin_member_detail(uuid) from public, anon;
grant  execute on function public.get_admin_member_detail(uuid) to authenticated;


-- get_member_upcoming_activity / get_member_activity_history /
-- get_member_notes — the three supplementary data sources
-- src/app/(app)/admin/members/[id]/page.tsx also calls alongside
-- get_admin_member_detail (verified via direct grep) — widening only the
-- page gate and get_admin_member_detail without these would let a Staff
-- caller open the Member Detail page and then hit `insufficient_role` on
-- its upcoming-activity, history, and notes sections. Caller gate widened
-- from admin-only to operator on all three read RPCs. add_member_note
-- (and its sibling archive/update note actions) are DELIBERATELY left
-- admin-only and unwidened — Staff may VIEW notes for context (this is
-- what makes the page not partially break) but may not author them; notes
-- are free-text admin commentary about a member, a narrower case than
-- "ordinary contact/profile information."
--
-- None of the three match 0076/0077's committed bodies: PRODUCTION
-- pg_get_functiondef is the verified source of truth for all three, not
-- any migration file — copied verbatim below, each with only its single
-- caller-authorization line changed.

-- get_member_upcoming_activity — Phase 34A4A correction: the previous
-- 0132 draft was a stale 14-column court/pro-name-columns contract that
-- MUST NOT remain; Production has since moved to a 9-column
-- activity_type/details-jsonb shape spanning reservations, events, AND
-- lessons (the stale draft's lesson branch only covered
-- pending/proposed/soon-confirmed statuses via two separate union
-- members with no reservation branch at all). Copied verbatim from
-- Production; the ONLY change is the caller-authorization line: `if
-- v_actor.role <> 'admin' then` -> `if v_actor.role not in ('admin',
-- 'staff') then`.
CREATE OR REPLACE FUNCTION public.get_member_upcoming_activity(p_member_id uuid)
 RETURNS TABLE(activity_id uuid, activity_type text, title text, starts_at timestamp with time zone, ends_at timestamp with time zone, status text, attendance_status text, outcome text, details jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor public.profiles%rowtype;
begin
  select pr.* into v_actor from public.profiles pr where pr.id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_actor.role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;

  if not exists (
    select 1 from public.profiles tgt
     where tgt.id = p_member_id and tgt.club_id = v_actor.club_id
  ) then
    raise exception 'member_not_found';
  end if;

  return query
    select
      r.id::uuid                      as activity_id,
      'reservation'::text             as activity_type,
      coalesce(c.name, 'Court')::text as title,
      r.starts_at,
      r.ends_at,
      r.status::text                  as status,
      null::text                      as attendance_status,
      null::text                      as outcome,
      jsonb_build_object(
        'court_id',   r.court_id,
        'court_name', c.name,
        'format',     r.format,
        'notes',      r.notes
      )                               as details
    from public.reservations r
    left join public.courts c on c.id = r.court_id
    where r.owner_user_id = p_member_id
      and r.club_id       = v_actor.club_id
      and r.starts_at     > now()
      and r.status        = 'confirmed'
      and r.reason        = 'member_booking'

    union all

    select
      e.id::uuid                       as activity_id,
      'event'::text                    as activity_type,
      e.title::text                    as title,
      e.starts_at,
      e.ends_at,
      ep.status::text                  as status,
      ep.attendance_status::text       as attendance_status,
      null::text                       as outcome,
      jsonb_build_object(
        'event_type',  et.label,
        'event_color', et.color,
        'ep_role',     ep.role
      )                                as details
    from public.event_participants ep
    join public.events e       on e.id  = ep.event_id
    join public.event_types et on et.id = e.event_type_id
    where ep.profile_id = p_member_id
      and e.club_id     = v_actor.club_id
      and e.starts_at   > now()
      and ep.status     = 'confirmed'
      and e.status      = 'scheduled'

    union all

    select
      lr.id::uuid                          as activity_id,
      'lesson'::text                       as activity_type,
      coalesce(lt.name, 'Lesson')::text    as title,
      lr.proposed_starts_at                as starts_at,
      lr.proposed_ends_at                  as ends_at,
      lr.status::text                      as status,
      null::text                           as attendance_status,
      lr.lesson_outcome::text              as outcome,
      jsonb_build_object(
        'pro_id',           lr.pro_id,
        'pro_name',         coalesce(
          nullif(trim(concat_ws(' ', pro.first_name, pro.last_name)), ''),
          'Pro'
        ),
        'lesson_type',      lt.name,
        'duration_minutes', lr.duration_minutes
      )                                    as details
    from public.lesson_requests lr
    left join public.lesson_types lt on lt.id = lr.lesson_type_id
    left join public.profiles pro    on pro.id = lr.pro_id
    where lr.member_id          = p_member_id
      and lr.club_id            = v_actor.club_id
      and lr.proposed_starts_at > now()
      and lr.status             = 'confirmed'

    order by starts_at asc
    limit 50;
end;
$function$;

revoke execute on function public.get_member_upcoming_activity(uuid) from public, anon;
grant  execute on function public.get_member_upcoming_activity(uuid) to authenticated;


-- get_member_activity_history — Phase 34A4A correction (final pass): the
-- body below is the exact Production pg_get_functiondef output, supplied
-- and verified during the Phase 34A4A preflight, copied verbatim — not
-- reconstructed, not inferred, not normalized to this repo's usual lower-
-- case/`$$`-delimiter style. Repo migration history (0076/0077) is
-- stale for this function's signature, return contract, and body, and is
-- not the source here. The ONLY change from the Production text is the
-- single authorization line: `if v_actor.role <> 'admin' then` ->
-- `if v_actor.role not in ('admin', 'staff') then`. Every filter,
-- jsonb detail, and sort_ts formula (including the separate event-status-
-- vs-participant-status cancellation sort_ts, and the per-status lesson
-- sort_ts) is exactly as Production has it. The defensive DROP below
-- targets only the never-actually-live `(uuid, timestamptz, text, uuid,
-- int)` parameter order and does not touch the live `(uuid, int,
-- timestamptz, text, uuid)` signature this CREATE OR REPLACE targets.
drop function if exists public.get_member_activity_history(uuid, timestamptz, text, uuid, int);

CREATE OR REPLACE FUNCTION public.get_member_activity_history(p_member_id uuid, p_limit integer DEFAULT 20, p_cursor_ts timestamp with time zone DEFAULT NULL::timestamp with time zone, p_cursor_type text DEFAULT NULL::text, p_cursor_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(activity_id uuid, activity_type text, title text, starts_at timestamp with time zone, ends_at timestamp with time zone, status text, attendance_status text, outcome text, details jsonb, sort_ts timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor public.profiles%rowtype;
  v_limit int;
begin
  select pr.* into v_actor from public.profiles pr where pr.id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_actor.role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;

  if not exists (
    select 1 from public.profiles tgt
     where tgt.id = p_member_id and tgt.club_id = v_actor.club_id
  ) then
    raise exception 'member_not_found';
  end if;

  if (p_cursor_ts is null or p_cursor_type is null or p_cursor_id is null)
     and not (p_cursor_ts is null and p_cursor_type is null and p_cursor_id is null) then
    raise exception 'invalid_cursor';
  end if;

  v_limit := least(greatest(coalesce(p_limit, 20), 1), 100) + 1;

  return query
    with history as (
      select
        r.id::uuid                      as activity_id,
        'reservation'::text             as activity_type,
        coalesce(c.name, 'Court')::text as title,
        r.starts_at,
        r.ends_at,
        r.status::text                  as status,
        null::text                      as attendance_status,
        null::text                      as outcome,
        jsonb_build_object(
          'court_id',     r.court_id,
          'court_name',   c.name,
          'format',       r.format,
          'cancelled_at', r.cancelled_at
        )                               as details,
        case
          when r.status = 'cancelled'
            then coalesce(r.cancelled_at, r.updated_at, r.starts_at)
          else r.starts_at
        end                             as sort_ts
      from public.reservations r
      left join public.courts c on c.id = r.court_id
      where r.owner_user_id = p_member_id
        and r.club_id       = v_actor.club_id
        and r.reason        = 'member_booking'
        and (r.starts_at <= now() or r.status = 'cancelled')

      union all

      select
        e.id::uuid                       as activity_id,
        'event'::text                    as activity_type,
        e.title::text                    as title,
        e.starts_at,
        e.ends_at,
        ep.status::text                  as status,
        ep.attendance_status::text       as attendance_status,
        null::text                       as outcome,
        jsonb_build_object(
          'event_type',   et.label,
          'event_color',  et.color,
          'ep_role',      ep.role,
          'event_status', e.status
        )                                as details,
        case
          when e.status = 'cancelled'
            then coalesce(e.updated_at, e.starts_at)
          when ep.status = 'cancelled'
            then coalesce(ep.updated_at, e.starts_at)
          else e.starts_at
        end                              as sort_ts
      from public.event_participants ep
      join public.events e       on e.id  = ep.event_id
      join public.event_types et on et.id = e.event_type_id
      where ep.profile_id = p_member_id
        and e.club_id     = v_actor.club_id
        and ep.status     not in ('waitlisted', 'offered')
        and (
          (ep.status = 'confirmed' and e.starts_at < now())
          or ep.status = 'cancelled'
          or e.status  = 'cancelled'
        )

      union all

      select
        lr.id::uuid                         as activity_id,
        'lesson'::text                      as activity_type,
        coalesce(lt.name, 'Lesson')::text   as title,
        lr.proposed_starts_at               as starts_at,
        lr.proposed_ends_at                 as ends_at,
        lr.status::text                     as status,
        null::text                          as attendance_status,
        lr.lesson_outcome::text             as outcome,
        jsonb_build_object(
          'pro_id',           lr.pro_id,
          'pro_name',         coalesce(
            nullif(trim(concat_ws(' ', pro.first_name, pro.last_name)), ''),
            'Pro'
          ),
          'lesson_type',      lt.name,
          'duration_minutes', lr.duration_minutes,
          'cancelled_at',     lr.cancelled_at
        )                                   as details,
        case
          when lr.status = 'cancelled'
            then coalesce(lr.cancelled_at, lr.updated_at)
          when lr.status = 'declined'
            then coalesce(lr.declined_at, lr.updated_at)
          when lr.status = 'withdrawn'
            then lr.updated_at
          else lr.proposed_starts_at
        end                                 as sort_ts
      from public.lesson_requests lr
      left join public.lesson_types lt on lt.id = lr.lesson_type_id
      left join public.profiles pro    on pro.id = lr.pro_id
      where lr.member_id = p_member_id
        and lr.club_id   = v_actor.club_id
        and (
          lr.status in ('declined', 'withdrawn', 'cancelled')
          or (lr.status = 'confirmed' and lr.proposed_starts_at < now())
        )
    )
    select
      h.activity_id,
      h.activity_type,
      h.title,
      h.starts_at,
      h.ends_at,
      h.status,
      h.attendance_status,
      h.outcome,
      h.details,
      h.sort_ts
    from history h
    where (
      p_cursor_ts is null
      or h.sort_ts < p_cursor_ts
      or (h.sort_ts = p_cursor_ts and h.activity_type < p_cursor_type)
      or (h.sort_ts = p_cursor_ts and h.activity_type = p_cursor_type
          and h.activity_id::text < p_cursor_id::text)
    )
    order by h.sort_ts desc, h.activity_type desc, h.activity_id::text desc
    limit v_limit;
end;
$function$;

revoke execute on function public.get_member_activity_history(uuid, int, timestamptz, text, uuid) from public, anon;
grant  execute on function public.get_member_activity_history(uuid, int, timestamptz, text, uuid) to authenticated;


-- get_member_notes — Phase 34A4A correction: the previous 0132 draft used
-- a stale note contract (`content` instead of `body`, no `author_name`/
-- `is_archived`/`archived_by`, and it excluded archived notes entirely
-- via `mn.archived_at is null`). PRODUCTION pg_get_functiondef is the
-- verified source of truth, not 0077 — production resolves a live
-- author_name (falling back to the historical author_name_snapshot) and
-- returns every note including archived ones, tagged via `is_archived`,
-- for the client to decide how to render. The stale draft's extra `if
-- v_actor.club_id is null then raise exception 'no_club'` check is also
-- removed — Production does not have it (current_user_club_id-derived
-- v_actor.club_id being null is already unreachable given the
-- member_not_found check that follows it uses the same club_id).
-- Copied verbatim from Production; the ONLY change is the caller-
-- authorization line: `if v_actor.role <> 'admin' then` -> `if
-- v_actor.role not in ('admin', 'staff') then`. Staff remains READ-ONLY
-- here — add_member_note/update_member_note/archive_member_note are
-- untouched, still admin-only, per the section header above.
CREATE OR REPLACE FUNCTION public.get_member_notes(p_member_id uuid)
 RETURNS TABLE(id uuid, member_id uuid, author_id uuid, author_name text, author_name_snapshot text, body text, is_archived boolean, created_at timestamp with time zone, updated_at timestamp with time zone, archived_at timestamp with time zone, archived_by uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor public.profiles%rowtype;
begin
  select pr.* into v_actor from public.profiles pr where pr.id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_actor.role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;

  if not exists (
    select 1 from public.profiles tgt
     where tgt.id = p_member_id and tgt.club_id = v_actor.club_id
  ) then
    raise exception 'member_not_found';
  end if;

  return query
    select
      n.id,
      n.member_id,
      n.author_id,
      coalesce(
        nullif(trim(concat_ws(' ', a.first_name, a.last_name)), ''),
        n.author_name_snapshot
      )::text          as author_name,
      n.author_name_snapshot,
      n.body,
      n.is_archived,
      n.created_at,
      n.updated_at,
      n.archived_at,
      n.archived_by
    from public.member_notes n
    left join public.profiles a on a.id = n.author_id
    where n.member_id = p_member_id
      and n.club_id   = v_actor.club_id
    order by n.created_at desc;
end;
$function$;

revoke execute on function public.get_member_notes(uuid) from public, anon;
grant  execute on function public.get_member_notes(uuid) to authenticated;


-- get_roster_members — Phase 34A4A correction: latest effective body is
-- 0117 (durable_member_guest_lifecycle_and_attendance), NOT 0056. 0117
-- itself performed a signature change from 0056's zero-argument version
-- (drop + recreate, since adding a parameter is a distinct Postgres
-- overload, not a replacement) to add p_include_inactive boolean default
-- false — active-only by default for picker use (EventRosterSheet's bare
-- call), opt-in to include inactive unclaimed identities for the Admin
-- Members CRM listing (which calls with p_include_inactive: true) — plus
-- status/removed_at added to the return contract, and search_path
-- hardening (0117 closed that gap itself; there is no remaining hardening
-- gap here to fix, unlike add_roster_member/update_roster_member in
-- 0131/34A3, which genuinely never had it). Confirmed via Production
-- preflight that this one-argument signature is what is actually live
-- today — reproducing 0056's stale zero-argument shape here, as an
-- earlier draft of this migration incorrectly did, would have created a
-- SECOND, ambiguous overload rather than replacing the live function.
--
-- Reproduced verbatim from 0117, including its explicit, deliberate
-- absence of any REVOKE/GRANT statement (0117's own header: "Grants are
-- preserved exactly as they are today: none has ever been added for this
-- function [implicit PUBLIC EXECUTE, gated entirely by its own internal
-- admin-role check] — not changed here, including on the recreated
-- function") and its unqualified `get_roster_members` (not
-- `public.get_roster_members`) function-name style, matching 0117 exactly
-- rather than introducing an unrelated schema-qualification change.
--
-- Change for THIS checkpoint is the single authorization line only:
-- `v_profile.role <> 'admin'` -> `v_profile.role not in ('admin', 'staff')`.
-- Every other line — the p_include_inactive filter, active-first/
-- inactive-second ordering, status/removed_at columns, club/claimed_by
-- scoping — reproduced verbatim from 0117.
--
-- No DROP is required here: this CREATE OR REPLACE targets the exact same
-- (name, one-boolean-argument) identity 0117 established and Production
-- preflight confirmed is still live, so it replaces in place — it does
-- NOT recreate the drop-then-create 0056->0117 signature change itself.
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
  if v_profile.role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;

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


-- add_roster_member / update_roster_member — latest effective body: 0131
-- (which itself reproduced 0056 verbatim except for the p_role widening and
-- search_path hardening). Caller gate widened from admin-only to operator.
-- NEW: a Staff caller may only assign p_role = 'member' on add_roster_member
-- (a brand-new row has no prior role to protect). update_roster_member
-- additionally requires (Phase 34A4A correction) that the EXISTING row's
-- role already be 'member' — a Staff caller may not touch an
-- employee-intent (pro/staff/admin) roster row at all, in either
-- direction, not even to "correct" it back to member. Staff must never use
-- ordinary roster editing to create or manage an employee-intent entry —
-- that remains an Admin-only judgment call, matching the identical
-- restriction placed on create_club_invite/resend_club_invite/
-- revoke_club_invite/get_club_invites below. roster_members.role remains
-- "display/intent only — does not grant app permissions" (0056) — the real
-- enforcement point is create_club_invite, which independently
-- re-validates and restricts p_role for a Staff caller regardless of what
-- a roster row's own `role` column says. These RPC-level restrictions are
-- defense in depth / UX correctness, not the sole enforcement boundary.
create or replace function public.add_roster_member(
  p_first_name text,
  p_last_name  text,
  p_email      text    default null,
  p_phone      text    default null,
  p_role       text    default 'member',
  p_notes      text    default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile   profiles%rowtype;
  v_first     text;
  v_last      text;
  v_email     text;
  v_phone     text;
  v_notes     text;
  v_new_id    uuid;
  v_dup_count int;
begin
  -- 1. Auth / operator gate.
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  -- 2. Validate role.
  if p_role not in ('member', 'pro', 'staff', 'admin') then
    raise exception 'invalid_role';
  end if;

  -- Phase 34A4: a Staff caller may only create ordinary Member roster entries.
  if v_profile.role = 'staff' and p_role <> 'member' then
    raise exception 'insufficient_role';
  end if;

  -- 3. Trim and normalise — empty strings become null.
  v_first := nullif(btrim(p_first_name), '');
  v_last  := nullif(btrim(p_last_name), '');
  v_email := nullif(btrim(coalesce(p_email, '')), '');
  v_phone := nullif(btrim(coalesce(p_phone, '')), '');
  v_notes := nullif(btrim(coalesce(p_notes, '')), '');

  if v_first is null then raise exception 'first_name_required'; end if;
  if v_last  is null then raise exception 'last_name_required';  end if;

  -- 4. Duplicate email check (only when email is provided).
  if v_email is not null then
    -- Against unclaimed roster members in same club.
    select count(*) into v_dup_count
      from roster_members
     where club_id      = v_profile.club_id
       and lower(email)  = lower(v_email)
       and claimed_by   is null;

    if v_dup_count > 0 then
      raise exception 'email_already_on_roster';
    end if;

    -- Against existing auth-linked profiles in same club.
    select count(*) into v_dup_count
      from profiles p
      join auth.users u on u.id = p.id
     where p.club_id      = v_profile.club_id
       and lower(u.email)  = lower(v_email);

    if v_dup_count > 0 then
      raise exception 'email_already_a_member';
    end if;
  end if;

  -- 5. Insert.
  insert into roster_members (club_id, first_name, last_name, email, phone, role, notes, created_by)
  values (v_profile.club_id, v_first, v_last, v_email, v_phone, p_role, v_notes, auth.uid())
  returning id into v_new_id;

  -- 6. Audit.
  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'add_roster_member',
    'roster_member',
    v_new_id,
    jsonb_build_object(
      'first_name', v_first,
      'last_name',  v_last,
      'email',      v_email,
      'role',       p_role
    )
  );

  return v_new_id;
end;
$$;

create or replace function public.update_roster_member(
  p_id         uuid,
  p_first_name text,
  p_last_name  text,
  p_email      text    default null,
  p_phone      text    default null,
  p_role       text    default 'member',
  p_notes      text    default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile   profiles%rowtype;
  v_roster    roster_members%rowtype;
  v_first     text;
  v_last      text;
  v_email     text;
  v_phone     text;
  v_notes     text;
  v_dup_count int;
begin
  -- 1. Auth / operator gate.
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;

  -- 2. Load target, scoped to caller's club.
  select * into v_roster
    from roster_members
   where id      = p_id
     and club_id = v_profile.club_id;
  if not found then raise exception 'roster_member_not_found'; end if;

  -- 3. Cannot update a claimed entry (manage via profiles instead).
  if v_roster.claimed_by is not null then
    raise exception 'roster_member_already_claimed';
  end if;

  -- 4. Validate role.
  if p_role not in ('member', 'pro', 'staff', 'admin') then
    raise exception 'invalid_role';
  end if;

  -- Phase 34A4A correction: a Staff caller may edit a roster row only when
  -- BOTH the existing row's role AND the requested role are 'member' —
  -- not merely the requested role. roster_members.role is not an
  -- authorization boundary (0056), but Staff must still not be able to
  -- touch an employee-intent (pro/staff/admin) roster row at all, even to
  -- "correct" it back to member — that judgment call stays with Admin.
  -- This also closes the gap where a Staff caller could target an
  -- existing pro/staff/admin-intent row and resubmit it with
  -- p_role='member', which the requested-role-only check above would have
  -- permitted.
  if v_profile.role = 'staff' and (v_roster.role <> 'member' or p_role <> 'member') then
    raise exception 'insufficient_role';
  end if;

  -- 5. Trim and normalise.
  v_first := nullif(btrim(p_first_name), '');
  v_last  := nullif(btrim(p_last_name), '');
  v_email := nullif(btrim(coalesce(p_email, '')), '');
  v_phone := nullif(btrim(coalesce(p_phone, '')), '');
  v_notes := nullif(btrim(coalesce(p_notes, '')), '');

  if v_first is null then raise exception 'first_name_required'; end if;
  if v_last  is null then raise exception 'last_name_required';  end if;

  -- 6. Duplicate email check if email changed.
  if v_email is not null
     and (v_roster.email is null or lower(v_email) <> lower(v_roster.email))
  then
    select count(*) into v_dup_count
      from roster_members
     where club_id      = v_profile.club_id
       and lower(email)  = lower(v_email)
       and id           <> p_id
       and claimed_by   is null;

    if v_dup_count > 0 then
      raise exception 'email_already_on_roster';
    end if;

    select count(*) into v_dup_count
      from profiles p
      join auth.users u on u.id = p.id
     where p.club_id      = v_profile.club_id
       and lower(u.email)  = lower(v_email);

    if v_dup_count > 0 then
      raise exception 'email_already_a_member';
    end if;
  end if;

  -- 7. Update.
  update roster_members
     set first_name = v_first,
         last_name  = v_last,
         email      = v_email,
         phone      = v_phone,
         role       = p_role,
         notes      = v_notes
   where id = p_id;

  -- 8. Audit.
  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'update_roster_member',
    'roster_member',
    p_id,
    jsonb_build_object(
      'first_name', v_first,
      'last_name',  v_last,
      'email',      v_email,
      'role',       p_role
    )
  );
end;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- MEMBER INVITATIONS — Staff restricted to role='member' invitations only
-- ═══════════════════════════════════════════════════════════════════════════

-- create_club_invite — latest effective body: 0131 (itself a verbatim
-- reproduction of 0123 plus the 0131 p_role widening). Caller gate widened
-- to operator. NEW: a Staff caller may only create p_role='member'
-- invitations — Admin remains solely responsible for inviting Pro/Staff/
-- Admin employees. The member_self_service entitlement gate is UNCHANGED
-- and stays scoped to p_role='member' regardless of caller — a
-- Staff-Managed club still cannot create a new Member invitation via a
-- Staff caller any more than via an Admin caller.
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
  if v_profile.role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  if p_role not in ('member', 'pro', 'staff', 'admin') then
    raise exception 'invalid_role';
  end if;

  -- Phase 34A4: a Staff caller may only create Member-role invitations.
  if v_profile.role = 'staff' and p_role <> 'member' then
    raise exception 'insufficient_role';
  end if;

  -- Phase 33F3B: a Staff-Managed club may not create a NEW Member-role
  -- invitation. Admin/Pro/Staff-role invitations are unaffected.
  if p_role = 'member' and not public.current_club_has_capability('member_self_service') then
    raise exception 'capability_not_available';
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
  if v_roster.status is distinct from 'active' then raise exception 'roster_member_inactive'; end if;

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


-- resend_club_invite — latest effective body: 0117. Caller gate widened to
-- operator. No separate staff-role restriction is added here: this
-- function reuses create_club_invite(v_old_invite.role, ...) internally
-- (unchanged call) for the actual insert — a Staff caller attempting to
-- resend a pro/staff/admin invite is already rejected by
-- create_club_invite's own new restriction (above) inside that same call,
-- in the same transaction. Every other line unchanged from 0117.
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
  if v_profile.role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;

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
  if not exists (
    select 1 from public.roster_members
     where id     = v_roster_member_id
       and status = 'active'
  ) then
    raise exception 'roster_member_inactive';
  end if;

  -- Revoke the old invite. Idempotent.
  update public.club_invites
     set revoked_at = coalesce(revoked_at, now())
   where id = v_old_invite.id;

  -- Reuse create_club_invite — same roster identity, same role as the
  -- original invite. Its own operator gate, invalid_role check, and (new)
  -- Staff member-role restriction all apply here automatically.
  v_new_code := public.create_club_invite(v_old_invite.role, v_roster_member_id, p_expires_at);

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'resend_invite',
    'club_invite',
    v_old_invite.id,
    jsonb_build_object('old_code', p_old_code, 'role', v_old_invite.role)
  );

  return v_new_code;
end;
$$;

revoke execute on function public.resend_club_invite(text, timestamptz) from public, anon;
grant  execute on function public.resend_club_invite(text, timestamptz) to authenticated;


-- revoke_club_invite — latest effective body: 0032, never redefined since.
-- Caller gate widened to operator. NEW: a Staff caller may only revoke a
-- Member-role invitation. SEARCH_PATH HARDENING (same pattern as
-- add_roster_member/update_roster_member in 0131/34A3): confirmed via
-- repo-wide grep this function was never covered by 0068 or any later
-- `alter function` — corrected here alongside the role widening already
-- required.
create or replace function public.revoke_club_invite(p_code text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile profiles%rowtype;
  v_invite  club_invites%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;

  select * into v_invite
    from club_invites
   where code = p_code
     and club_id = v_profile.club_id;

  if not found                        then raise exception 'invalid_invite';          end if;
  if v_invite.accepted_at is not null then raise exception 'invite_already_accepted'; end if;
  if v_invite.revoked_at  is not null then raise exception 'invite_already_revoked';  end if;

  -- Phase 34A4: a Staff caller may only revoke Member-role invitations.
  if v_profile.role = 'staff' and v_invite.role <> 'member' then
    raise exception 'insufficient_role';
  end if;

  update club_invites
     set revoked_at = now()
   where id = v_invite.id;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'revoke_invite',
    'club_invite',
    v_invite.id,
    jsonb_build_object('role', v_invite.role, 'email', v_invite.email)
  );
end;
$$;


-- get_club_invites — latest (and only) effective body: 0032, never
-- redefined. This is the data source the admin/members page uses to list
-- pending invitations (verified via direct grep of
-- src/app/(app)/admin/members/page.tsx) — needed for the Staff invitation
-- workflows above to have anything to display. Caller gate widened from
-- admin-only to operator. Phase 34A4A correction: the read IS now filtered
-- by invite role for a Staff caller — an Admin sees every invitation
-- (unchanged); a Staff caller sees ONLY role='member' invitations. Staff
-- must never receive the code/email/details of a pro/staff/admin
-- invitation through this RPC, even read-only — least privilege, enforced
-- in the query itself, not left to frontend filtering. SEARCH_PATH
-- HARDENING (same pattern as add_roster_member/update_roster_member in
-- 0131/34A3, and revoke_club_invite above): confirmed never covered by
-- 0068 or any later `alter function` — corrected here alongside the role
-- widening.
create or replace function public.get_club_invites()
returns table (
  id          uuid,
  code        text,
  role        text,
  email       text,
  expires_at  timestamptz,
  accepted_at timestamptz,
  accepted_by uuid,
  revoked_at  timestamptz,
  created_at  timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile profiles%rowtype;
begin
  select p.* into v_profile from profiles p where p.id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;

  return query
    select
      ci.id,
      ci.code,
      ci.role,
      ci.email,
      ci.expires_at,
      ci.accepted_at,
      ci.accepted_by,
      ci.revoked_at,
      ci.created_at
    from club_invites ci
   where ci.club_id = v_profile.club_id
     and (v_profile.role = 'admin' or ci.role = 'member')
   order by ci.created_at desc;
end;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- RESERVATIONS — front-desk operator authority, on behalf of Members/
-- no-account Members. The 0131 self-service gate on create_reservation
-- itself is NOT touched anywhere in this section.
-- ═══════════════════════════════════════════════════════════════════════════

-- admin_create_member_reservation — latest (and only) effective body:
-- 0108. Caller gate widened to operator. Every scheduling/court/
-- operating-hours/duration rule, roster-identity resolution, and audit
-- write reproduced verbatim — none of it is role-differentiated to begin
-- with, so widening the single top-level gate is the complete change.
create or replace function public.admin_create_member_reservation(
  p_court_id          uuid,
  p_starts_at         timestamptz,
  p_ends_at           timestamptz,
  p_roster_member_id  uuid,
  p_expected_club_id  uuid,
  p_format            text    default null,
  p_player_count      int     default null,
  p_guest_names       text[]  default null,
  p_notes             text    default null
)
returns reservations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id  uuid;
  v_role     text;
  v_court    public.courts%rowtype;
  v_roster   public.roster_members%rowtype;
  v_owner_id uuid;
  v_tz       text;
  v_date     date;
  v_dow      int;
  v_override public.operating_hours_override%rowtype;
  v_hours    public.operating_hours%rowtype;
  v_result   public.reservations%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;

  if p_roster_member_id is null then raise exception 'roster_identity_required'; end if;

  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_club_id;
  if not found then raise exception 'roster_member_not_found'; end if;

  v_owner_id := v_roster.claimed_by;

  select * into v_court
    from public.courts
   where id        = p_court_id
     and club_id   = v_club_id
     and is_active = true;
  if not found then raise exception 'court_not_found'; end if;

  select timezone into v_tz from public.clubs where id = v_club_id;

  if p_starts_at < now() then
    raise exception 'cannot_book_past';
  end if;

  if p_ends_at <= p_starts_at then
    raise exception 'invalid_duration';
  end if;

  if extract(epoch from (p_ends_at - p_starts_at)) / 60 not in (30, 60, 90, 120) then
    raise exception 'invalid_duration';
  end if;

  v_date := (p_starts_at at time zone v_tz)::date;
  v_dow  := extract(dow from p_starts_at at time zone v_tz)::int;

  select * into v_override
    from public.operating_hours_override
   where club_id       = v_club_id
     and override_date = v_date;

  if found then
    if v_override.is_closed then
      raise exception 'club_closed_this_day';
    end if;
    if v_override.opens_at is not null and v_override.closes_at is not null then
      if (p_starts_at at time zone v_tz)::time < v_override.opens_at
         or (p_ends_at at time zone v_tz)::time > v_override.closes_at then
        raise exception 'outside_operating_hours';
      end if;
    end if;
  else
    select * into v_hours
      from public.operating_hours
     where club_id     = v_club_id
       and day_of_week = v_dow;

    if not found or v_hours.is_closed then
      raise exception 'club_closed_this_day';
    end if;

    if (p_starts_at at time zone v_tz)::time < v_hours.opens_at
       or (p_ends_at at time zone v_tz)::time > v_hours.closes_at then
      raise exception 'outside_operating_hours';
    end if;
  end if;

  insert into public.reservations (
    club_id, court_id, owner_user_id, roster_member_id,
    starts_at, ends_at, status, reason,
    format, player_count, guest_names, notes, created_by
  ) values (
    v_club_id, p_court_id, v_owner_id, p_roster_member_id,
    p_starts_at, p_ends_at, 'confirmed', 'member_booking',
    p_format, p_player_count, p_guest_names, p_notes, auth.uid()
  )
  returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id,
    auth.uid(),
    'admin_create_member_reservation',
    'reservation',
    v_result.id,
    jsonb_build_object(
      'roster_member_id', p_roster_member_id,
      'owner_user_id',    v_owner_id,
      'court_id',         p_court_id,
      'starts_at',        p_starts_at,
      'ends_at',          p_ends_at
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.admin_create_member_reservation(
  uuid, timestamptz, timestamptz, uuid, uuid, text, int, text[], text
) from public, anon;
grant  execute on function public.admin_create_member_reservation(
  uuid, timestamptz, timestamptz, uuid, uuid, text, int, text[], text
) to authenticated;


-- update_member_reservation — latest effective body: 0109 (the 11-argument
-- overload; the 10-argument overload was dropped by 0130 and is not
-- reproduced). Caller gate widened to operator. Every scheduling/capacity/
-- Member-reassignment/optimistic-concurrency/audit/notification line
-- reproduced verbatim — none of it is role-differentiated.
create or replace function public.update_member_reservation(
  p_reservation_id       uuid,
  p_expected_club_id     uuid,
  p_expected_updated_at  timestamptz,
  p_court_id             uuid,
  p_starts_at            timestamptz,
  p_ends_at              timestamptz,
  p_roster_member_id     uuid,
  p_format               text    default null,
  p_player_count         int     default null,
  p_guest_names          text[]  default null,
  p_notes                text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id             uuid;
  v_role                text;
  v_before               reservations%rowtype;
  v_after                reservations%rowtype;
  v_court                courts%rowtype;
  v_tz                   text;
  v_date                 date;
  v_dow                  int;
  v_override             operating_hours_override%rowtype;
  v_hours                operating_hours%rowtype;
  v_scheduling_changed   boolean;
  v_changed_fields       text[] := '{}';
  v_notification_id      uuid;
  v_roster               public.roster_members%rowtype;
  v_member_changed       boolean;
  v_new_owner_id         uuid;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;

  if p_court_id is null then raise exception 'invalid_court'; end if;
  if p_starts_at is null or p_ends_at is null then raise exception 'invalid_duration'; end if;

  select * into v_before
    from reservations
    where id = p_reservation_id and club_id = v_club_id
    for update;
  if not found then raise exception 'reservation_not_found'; end if;

  if v_before.reason <> 'member_booking' then raise exception 'reservation_not_editable'; end if;
  if v_before.status <> 'confirmed' then raise exception 'reservation_not_editable'; end if;

  if v_before.starts_at <= now() then raise exception 'cannot_edit_started_reservation'; end if;

  if v_before.updated_at is distinct from p_expected_updated_at then
    raise exception 'stale_edit_conflict';
  end if;

  if p_starts_at <= now() then raise exception 'cannot_book_past'; end if;
  if p_ends_at <= p_starts_at then raise exception 'invalid_duration'; end if;

  if p_roster_member_id is null then
    raise exception 'roster_identity_required';
  end if;

  v_member_changed := p_roster_member_id is distinct from v_before.roster_member_id;

  if v_member_changed then
    select * into v_roster
      from public.roster_members
     where id      = p_roster_member_id
       and club_id = v_club_id;
    if not found then raise exception 'roster_member_not_found'; end if;
    v_new_owner_id := v_roster.claimed_by;
  else
    v_new_owner_id := v_before.owner_user_id;
  end if;

  v_scheduling_changed :=
    p_court_id  is distinct from v_before.court_id
    or p_starts_at is distinct from v_before.starts_at
    or p_ends_at   is distinct from v_before.ends_at;

  if v_scheduling_changed then
    select * into v_court
      from courts
      where id = p_court_id and club_id = v_club_id and is_active = true;
    if not found then raise exception 'invalid_court'; end if;

    if extract(epoch from (p_ends_at - p_starts_at)) / 60 not in (30, 60, 90, 120) then
      raise exception 'invalid_duration';
    end if;

    select timezone into v_tz from clubs where id = v_club_id;

    v_date := (p_starts_at at time zone v_tz)::date;
    v_dow  := extract(dow from p_starts_at at time zone v_tz)::int;

    select * into v_override
      from operating_hours_override
      where club_id = v_club_id and override_date = v_date;

    if found then
      if v_override.is_closed then
        raise exception 'club_closed_this_day';
      end if;
      if v_override.opens_at is not null and v_override.closes_at is not null then
        if (p_starts_at at time zone v_tz)::time < v_override.opens_at
           or (p_ends_at at time zone v_tz)::time > v_override.closes_at then
          raise exception 'outside_operating_hours';
        end if;
      end if;
    else
      select * into v_hours
        from operating_hours
        where club_id = v_club_id and day_of_week = v_dow;

      if not found or v_hours.is_closed then
        raise exception 'club_closed_this_day';
      end if;

      if (p_starts_at at time zone v_tz)::time < v_hours.opens_at
         or (p_ends_at at time zone v_tz)::time > v_hours.closes_at then
        raise exception 'outside_operating_hours';
      end if;
    end if;
  end if;

  if p_court_id is distinct from v_before.court_id then
    v_changed_fields := array_append(v_changed_fields, 'court_id');
  end if;
  if p_starts_at is distinct from v_before.starts_at then
    v_changed_fields := array_append(v_changed_fields, 'starts_at');
  end if;
  if p_ends_at is distinct from v_before.ends_at then
    v_changed_fields := array_append(v_changed_fields, 'ends_at');
  end if;
  if v_member_changed then
    v_changed_fields := array_append(v_changed_fields, 'roster_member_id');
  end if;
  if p_format is distinct from v_before.format then
    v_changed_fields := array_append(v_changed_fields, 'format');
  end if;
  if p_player_count is distinct from v_before.player_count then
    v_changed_fields := array_append(v_changed_fields, 'player_count');
  end if;
  if p_guest_names is distinct from v_before.guest_names then
    v_changed_fields := array_append(v_changed_fields, 'guest_names');
  end if;
  if p_notes is distinct from v_before.notes then
    v_changed_fields := array_append(v_changed_fields, 'notes');
  end if;

  if array_length(v_changed_fields, 1) is null then
    return jsonb_build_object(
      'reservation',     to_jsonb(v_before),
      'changed_fields',  to_jsonb(v_changed_fields),
      'notification_id', null
    );
  end if;

  update reservations set
    court_id          = p_court_id,
    starts_at         = p_starts_at,
    ends_at           = p_ends_at,
    roster_member_id  = p_roster_member_id,
    owner_user_id     = v_new_owner_id,
    format            = p_format,
    player_count      = p_player_count,
    guest_names       = p_guest_names,
    notes             = p_notes,
    updated_at        = now()
  where id = p_reservation_id
  returning * into v_after;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id,
    auth.uid(),
    'update_member_reservation',
    'reservation',
    p_reservation_id,
    jsonb_build_object(
      'owner_user_id',     v_before.owner_user_id,
      'changed_fields',    v_changed_fields,
      'member_reassigned', v_member_changed,
      'before', jsonb_build_object(
        'court_id',         v_before.court_id,
        'starts_at',        v_before.starts_at,
        'ends_at',          v_before.ends_at,
        'format',           v_before.format,
        'player_count',     v_before.player_count,
        'guest_names',      v_before.guest_names,
        'notes',            v_before.notes,
        'roster_member_id', v_before.roster_member_id,
        'owner_user_id',    v_before.owner_user_id
      ),
      'after', jsonb_build_object(
        'court_id',         v_after.court_id,
        'starts_at',        v_after.starts_at,
        'ends_at',          v_after.ends_at,
        'format',           v_after.format,
        'player_count',     v_after.player_count,
        'guest_names',      v_after.guest_names,
        'notes',            v_after.notes,
        'roster_member_id', v_after.roster_member_id,
        'owner_user_id',    v_after.owner_user_id
      )
    )
  );

  v_notification_id := null;

  if v_scheduling_changed and v_after.owner_user_id is not null then
    if v_tz is null then
      select timezone into v_tz from clubs where id = v_club_id;
    end if;

    insert into notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id,
      v_after.owner_user_id,
      'reservation_rescheduled',
      'Your booking was moved to ' || v_court.name || ' on '
        || to_char(v_after.starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM')
        || ' – ' || to_char(v_after.ends_at at time zone v_tz, 'HH12:MI AM') || '.',
      jsonb_build_object('reservation_id', v_after.id, 'court_id', v_after.court_id)
    )
    returning id into v_notification_id;
  end if;

  return jsonb_build_object(
    'reservation',     to_jsonb(v_after),
    'changed_fields',  to_jsonb(v_changed_fields),
    'notification_id', v_notification_id
  );
end;
$$;

revoke execute on function public.update_member_reservation(
  uuid, uuid, timestamptz, uuid, timestamptz, timestamptz, uuid, text, int, text[], text
) from public, anon;
grant  execute on function public.update_member_reservation(
  uuid, uuid, timestamptz, uuid, timestamptz, timestamptz, uuid, text, int, text[], text
) to authenticated;


-- admin_cancel_reservation_v2 — latest effective body: 0119. Caller gate
-- widened to operator. Every other line — target scope, cancellation_kind
-- (still the fixed 'admin' literal, correct for any operator regardless of
-- whether Admin or Staff performed it, matching the existing precedent
-- that maps every non-member operational actor to the same 'admin'
-- cancellation_kind bucket), audit, and the no-account-Member operational
-- email carve-out — reproduced verbatim.
create or replace function public.admin_cancel_reservation_v2(
  p_reservation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile         public.profiles%rowtype;
  v_res             public.reservations%rowtype;
  v_result          public.reservations%rowtype;
  v_tz              text;
  v_notification_id uuid;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.role not in ('admin', 'staff') then
    raise exception 'insufficient_role';
  end if;

  select * into v_res
    from public.reservations
    where id      = p_reservation_id
      and club_id = v_profile.club_id
      and status in ('pending', 'confirmed');
  if not found then raise exception 'reservation_not_found'; end if;

  update public.reservations set
    status            = 'cancelled',
    cancelled_at      = now(),
    cancelled_by      = auth.uid(),
    cancellation_kind = 'admin',
    updated_at        = now()
  where id = p_reservation_id
  returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'admin_cancel_reservation',
    'reservation',
    p_reservation_id,
    jsonb_build_object(
      'court_id',      v_res.court_id,
      'owner_user_id', v_res.owner_user_id,
      'starts_at',     v_res.starts_at,
      'reason',        v_res.reason
    )
  );

  select timezone into v_tz from public.clubs where id = v_profile.club_id;

  if v_res.owner_user_id is not null then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_profile.club_id,
      v_res.owner_user_id,
      'reservation_cancelled_by_admin',
      'Your reservation on '
        || to_char(v_res.starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM')
        || ' was cancelled by the club.',
      jsonb_build_object('reservation_id', p_reservation_id)
    )
    returning id into v_notification_id;
  end if;

  return jsonb_build_object(
    'reservation',     to_jsonb(v_result),
    'notification_id', v_notification_id
  );
end;
$$;

revoke execute on function public.admin_cancel_reservation_v2(uuid) from public, anon;
grant  execute on function public.admin_cancel_reservation_v2(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- LESSONS + PROVIDER ELIGIBILITY
-- ═══════════════════════════════════════════════════════════════════════════

-- admin_create_member_lesson — latest effective body: 0128. Caller gate
-- widened from ('admin','pro') to ('admin','pro','staff'). VERIFIED (not
-- assumed) that this is safe: the function's only role-differentiated
-- behavior after the gate is `if v_role = 'pro' and p_pro_id <> auth.uid()
-- then raise exception 'insufficient_role'` — a check keyed EXACTLY to
-- `v_role = 'pro'`, never to "anything that isn't admin". Adding 'staff'
-- to the outer gate does not touch this line and does not trigger it for
-- staff — a Staff caller automatically gets the same unrestricted
-- provider-selection behavior Admin already has, with zero additional
-- code. Provider-eligibility filter widened from `role in ('pro','admin')`
-- to `role in ('pro','admin','staff')` so a Staff·Pro account
-- (role='staff', is_lesson_provider=true) is a valid assignable provider
-- — this does NOT make plain Staff (is_lesson_provider=false) eligible;
-- the is_lesson_provider=true condition is unchanged and still required.
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
  if v_role is null or v_role not in ('admin', 'pro', 'staff') then raise exception 'insufficient_role'; end if;

  -- A Pro may only book themselves as the lesson provider — assigning a
  -- different Pro remains an admin/staff-only action. Unchanged: this
  -- check is keyed to role='pro' specifically, so it never applies to a
  -- Staff caller (see this section's header above).
  if v_role = 'pro' and p_pro_id <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_club_id;
  if not found then raise exception 'roster_member_not_found'; end if;

  v_member_id   := v_roster.claimed_by;
  v_member_name := trim(coalesce(v_roster.first_name, '') || ' ' || coalesce(v_roster.last_name, ''));

  -- Validate pro: active, same club, role pro/admin/staff, is_lesson_provider = true
  select * into v_pro
    from public.profiles
   where id                 = p_pro_id
     and club_id            = v_club_id
     and status              = 'active'
     and role                in ('pro', 'admin', 'staff')
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

  if exists (
    select 1 from public.reservations r
     where r.court_id = p_court_id
       and r.status   in ('pending', 'confirmed')
       and tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')
  ) then
    raise exception 'court_conflict';
  end if;

  select timezone into v_tz from public.clubs where id = v_club_id;
  perform public._lesson_check_operating_hours(v_club_id, p_starts_at, p_ends_at, v_tz);

  perform public._lesson_check_pro_availability(p_pro_id, p_starts_at, p_ends_at, null);

  perform public._lesson_check_member_availability(v_member_id, p_roster_member_id, p_starts_at, p_ends_at, null);

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
    auth.uid(), v_role
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
      'duration_minutes', v_duration_minutes,
      'actor_role',       v_role
    )
  );

  if p_pro_id <> auth.uid() then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id, p_pro_id, 'lesson_request_confirmed',
      'Lesson with ' || v_member_name || ' confirmed for ' ||
        to_char(p_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM') || '.',
      jsonb_build_object('request_id', v_result.id, 'reservation_id', v_res_id)
    );
  end if;

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


-- get_lesson_roster_members — latest effective body: 0128. Caller gate
-- widened from ('admin','pro') to ('admin','pro','staff').
create or replace function public.get_lesson_roster_members()
returns table (
  id         uuid,
  first_name text,
  last_name  text,
  claimed_by uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role is null or v_role not in ('admin', 'pro', 'staff') then raise exception 'insufficient_role'; end if;

  return query
    select rm.id, rm.first_name, rm.last_name, rm.claimed_by
      from public.roster_members rm
     where rm.club_id = v_club_id
       and rm.status   = 'active'
     order by rm.last_name nulls last, rm.first_name nulls last;
end;
$$;

revoke execute on function public.get_lesson_roster_members() from public, anon;
grant  execute on function public.get_lesson_roster_members() to authenticated;


-- reassign_lesson_provider — latest effective body: 0101. Caller gate
-- widened from admin-only to operator (this function never had a Pro
-- path at all — reassigning to a DIFFERENT provider has always been
-- admin-only; Staff joins that same admin-only tier, not a new Pro-like
-- tier). Provider-eligibility filter widened from `role in ('pro','admin')`
-- to `role in ('pro','admin','staff')`, identical reasoning to
-- admin_create_member_lesson above. Phase 34A4A correction: last_actor_role
-- now writes the caller's ACTUAL role (`v_actor.role`) instead of a
-- hardcoded 'admin' literal — a Staff caller is correctly recorded as
-- 'staff', never silently folded into 'admin' merely because Staff uses
-- admin-like operator authority to call this function. (Unlike this
-- function, reservations.cancellation_kind's fixed 'admin' bucket in
-- admin_cancel_reservation_v2 above is NOT a last_actor_role-style
-- historical-identity column — cancellation_kind's vocabulary is only
-- ever member/admin/system, so mapping any non-member operator to its
-- 'admin' bucket there is correct and unchanged, not the same class of
-- inaccuracy this correction fixes here.)
create or replace function public.reassign_lesson_provider(
  p_request_id  uuid,
  p_new_pro_id  uuid
)
returns public.lesson_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      public.profiles%rowtype;
  v_request    public.lesson_requests%rowtype;
  v_new_pro    public.profiles%rowtype;
  v_member     public.profiles%rowtype;
  v_result     public.lesson_requests%rowtype;
  v_old_pro_id uuid;
  v_old_status text;
begin
  select pr.* into v_actor from public.profiles pr where pr.id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_actor.club_id is null then raise exception 'no_club'; end if;
  if v_actor.role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;

  select lr.* into v_request
    from public.lesson_requests lr
   where lr.id      = p_request_id
     and lr.club_id = v_actor.club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  if v_request.status not in ('pending', 'proposed')
     or (v_request.status = 'proposed' and v_request.linked_reservation_id is not null)
  then
    raise exception 'invalid_status_for_reassign';
  end if;

  select pr.* into v_new_pro from public.profiles pr
   where pr.id                 = p_new_pro_id
     and pr.club_id            = v_actor.club_id
     and pr.status             = 'active'
     and pr.role               in ('pro', 'admin', 'staff')
     and pr.is_lesson_provider = true;
  if not found then raise exception 'pro_not_found'; end if;

  if v_request.pro_id = p_new_pro_id then
    raise exception 'same_pro';
  end if;

  if v_request.member_id = p_new_pro_id then
    raise exception 'cannot_assign_to_self';
  end if;

  v_old_pro_id := v_request.pro_id;
  v_old_status := v_request.status;

  select pr.* into v_member from public.profiles pr where pr.id = v_request.member_id;

  update public.lesson_requests
     set pro_id             = p_new_pro_id,
         status             = 'pending',
         proposed_starts_at = null,
         proposed_ends_at   = null,
         proposed_court_id  = null,
         last_actor_id      = auth.uid(),
         -- Phase 34A4A correction: the ACTUAL caller role, not a hardcoded
         -- 'admin' literal — v_actor.role is 'admin' for an Admin caller
         -- (identical result to before) and correctly 'staff' for a Staff
         -- caller, never silently recorded as 'admin' merely because Staff
         -- is using admin-like operator authority here.
         last_actor_role    = v_actor.role,
         updated_at         = now()
   where id = p_request_id
  returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id, auth.uid(), 'reassign_lesson_provider', 'lesson_request', p_request_id,
    jsonb_build_object(
      'old_pro_id',  v_old_pro_id,
      'new_pro_id',  p_new_pro_id,
      'old_status',  v_old_status,
      'new_status',  'pending'
    )
  );

  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_actor.club_id,
    p_new_pro_id,
    'lesson_request_received',
    trim(coalesce(v_member.first_name, '') || ' ' || coalesce(v_member.last_name, ''))
      || ' has a ' || v_request.duration_minutes || '-minute lesson request (reassigned to you).',
    jsonb_build_object(
      'request_id',  p_request_id,
      'member_id',   v_request.member_id,
      'target_path', '/events?tab=lessons'
    )
  );

  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_actor.club_id,
    v_old_pro_id,
    'lesson_provider_reassigned',
    'A lesson request from '
      || trim(coalesce(v_member.first_name, '') || ' ' || coalesce(v_member.last_name, ''))
      || ' has been reassigned to another provider.',
    jsonb_build_object(
      'request_id',  p_request_id,
      'member_id',   v_request.member_id,
      'target_path', '/events?tab=lessons'
    )
  );

  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_actor.club_id,
    v_request.member_id,
    'lesson_provider_reassigned',
    'Your lesson request has been reassigned to '
      || trim(coalesce(v_new_pro.first_name, '') || ' ' || coalesce(v_new_pro.last_name, ''))
      || '.',
    jsonb_build_object(
      'request_id',  p_request_id,
      'new_pro_id',  p_new_pro_id,
      'target_path', '/lessons'
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.reassign_lesson_provider(uuid, uuid) from public, anon;
grant  execute on function public.reassign_lesson_provider(uuid, uuid) to authenticated;


-- get_club_pros — latest effective body: 0071. Member-facing (no caller
-- role gate — every authenticated club member may call this to pick a
-- lesson provider). ONLY the eligibility filter changes, from
-- `role in ('pro','admin')` to `role in ('pro','admin','staff')` — this is
-- what makes a Staff·Pro account visible/selectable by a Member submitting
-- a lesson request. Self-exclusion (`p.id <> auth.uid()`) unchanged.
create or replace function public.get_club_pros()
returns table (
  id                 uuid,
  first_name         text,
  last_name          text,
  role               text,
  is_lesson_provider boolean
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

  return query
    select p.id, p.first_name, p.last_name, p.role, p.is_lesson_provider
      from public.profiles p
     where p.club_id            = v_profile.club_id
       and p.status             = 'active'
       and p.id                 <> auth.uid()
       and p.role               in ('pro', 'admin', 'staff')
       and p.is_lesson_provider = true
     order by p.last_name nulls last, p.first_name nulls last;
end;
$$;


-- get_admin_club_pros — latest effective body: 0080. Caller gate widened
-- to operator; eligibility filter widened identically to get_club_pros.
create or replace function public.get_admin_club_pros()
returns table (
  id                 uuid,
  first_name         text,
  last_name          text,
  role               text,
  is_lesson_provider boolean
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
  if v_profile.role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;

  return query
    select p.id, p.first_name, p.last_name, p.role, p.is_lesson_provider
      from public.profiles p
     where p.club_id            = v_profile.club_id
       and p.status             = 'active'
       and p.role               in ('pro', 'admin', 'staff')
       and p.is_lesson_provider = true
     order by p.last_name nulls last, p.first_name nulls last;
end;
$$;

revoke execute on function public.get_admin_club_pros() from public, anon;
grant  execute on function public.get_admin_club_pros() to authenticated;


-- submit_lesson_request — latest effective body: 0131 (applied,
-- Production-live). Phase 34A4A correction: 0132 widened get_club_pros()
-- so a Staff·Pro account can appear as a selectable provider in the
-- Member-facing picker — without this fix, selecting them here would
-- succeed at the picker but then fail with `pro_not_found`, since this
-- function independently re-validates the target. ONLY the provider
-- eligibility filter changes, from `role in ('pro', 'admin')` to
-- `role in ('pro', 'admin', 'staff')` — `is_lesson_provider = true` stays
-- required unconditionally, so plain Staff (is_lesson_provider=false)
-- remains invalid. Every other line reproduced verbatim from 0131,
-- including the member_self_service entitlement guard (`role not in
-- ('admin', 'pro') and not current_club_has_capability(...)` — untouched,
-- still does not admit 'staff' to the exemption, exactly as the 34A3
-- self-service lock requires), roster identity resolution, duration/type
-- validation, notification, audit, SECURITY DEFINER, search_path, and
-- revoke/grant. The hardcoded `last_actor_role` literal 'member' on
-- insert is also left exactly as-is — this is a pre-existing (pre-34A)
-- characteristic unrelated to Staff (it already did not reflect an
-- Admin/Pro self-requester's actual role either) and does not match the
-- hardcoded-'admin' pattern this checkpoint's last_actor_role correction
-- targets (see the cancel_lesson/reassign_lesson_provider sections below).
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

  -- Phase 34A3: restated as an explicit admin/pro allowlist rather than a
  -- member-exclusion — see this section's header above.
  if v_profile.role not in ('admin', 'pro') and not public.current_club_has_capability('member_self_service') then
    raise exception 'capability_not_available';
  end if;

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

  -- Validate pro: active, same club, role pro/admin/staff, is_lesson_provider = true
  select * into v_pro
    from public.profiles
   where id      = p_pro_id
     and club_id = v_profile.club_id
     and status  = 'active'
     and role    in ('pro', 'admin', 'staff')
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


-- get_pro_lesson_requests — latest effective body: 0111. This is the data
-- source the admin/lessons page actually calls (verified via direct grep
-- of src/app/(app)/admin/lessons/page.tsx) — widening the page's route
-- gate without also widening this RPC would let a Staff caller reach the
-- page and then hit `insufficient_role` on load. Caller gate widened from
-- `role not in ('pro', 'admin')` to also admit 'staff'. The existing
-- Pro self-only filter (`v_profile.role = 'pro' and p_pro_filter is not
-- null and p_pro_filter <> auth.uid()`) is untouched — it is keyed
-- exactly to role='pro', never triggered for staff, identical reasoning
-- to admin_create_member_lesson above. The WHERE clause's two-branch OR
-- (`role='pro' and pro_id=self` / `role='admin' and optional filter`)
-- gets a third branch for 'staff', matching admin's unrestricted
-- (optionally filtered) visibility — a Staff caller sees the same
-- club-wide lesson-request list an Admin does, not a self-scoped one.
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

  if v_profile.role not in ('pro', 'admin', 'staff') then raise exception 'insufficient_role'; end if;

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
       or
       (v_profile.role = 'staff' and (p_pro_filter is null or lr.pro_id = p_pro_filter))
     )
     and (p_status is null or lr.status = p_status)
   order by lr.created_at desc;
end;
$$;

revoke execute on function public.get_pro_lesson_requests(uuid, text) from public, anon;
grant  execute on function public.get_pro_lesson_requests(uuid, text) to authenticated;


-- mark_lesson_outcome — latest effective body: 0077, never redefined
-- since. Reachable from the Member Detail page (verified via direct grep
-- of src/app/(app)/admin/members/[id]/actions.ts). Relationship-scoped
-- gate, same shape as cancel_lesson: `pro_id = auth.uid() OR role='admin'`.
-- Widened to `pro_id = auth.uid() OR role in ('admin','staff')` — a Staff
-- operator may record any lesson's outcome, matching Step 6's "manage
-- Lesson requests as appropriate"; the assigned-Pro's own path is
-- untouched.
create or replace function public.mark_lesson_outcome(
  p_request_id uuid,
  p_outcome    text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_request public.lesson_requests%rowtype;
begin
  select pr.* into v_profile from public.profiles pr where pr.id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  if p_outcome not in ('completed', 'member_no_show', 'pro_no_show') then
    raise exception 'invalid_outcome';
  end if;

  select lr.* into v_request
    from public.lesson_requests lr
   where lr.id      = p_request_id
     and lr.club_id = v_profile.club_id;
  if not found then raise exception 'request_not_found'; end if;

  if v_request.status <> 'confirmed' then
    raise exception 'invalid_status_for_outcome';
  end if;

  if v_request.pro_id <> auth.uid() and v_profile.role not in ('admin', 'staff') then
    raise exception 'insufficient_role';
  end if;

  if v_request.proposed_starts_at > now() + interval '15 minutes' then
    raise exception 'lesson_not_yet_started';
  end if;

  update public.lesson_requests
     set lesson_outcome = p_outcome,
         updated_at     = now()
   where id = p_request_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'mark_lesson_outcome', 'lesson_request', p_request_id,
    jsonb_build_object('outcome', p_outcome, 'member_id', v_request.member_id)
  );
end;
$$;

revoke execute on function public.mark_lesson_outcome(uuid, text) from public, anon;
grant  execute on function public.mark_lesson_outcome(uuid, text) to authenticated;


-- cancel_lesson — latest effective body: 0111. FOUR precise, additive
-- changes, each preserving 100% of existing Admin/Pro/Member behavior
-- (verified by construction — see inline comments at each site):
--
-- (1) Entry gate: adds `or v_profile.role = 'staff'` to the existing
-- relationship-based allowlist, so a Staff caller may act as a generic
-- operator on ANY lesson in their club, not only one where they happen to
-- be the member/pro. Every existing admitted case (member-by-history,
-- member-by-roster, assigned pro, admin) is untouched.
--
-- (2) Already-started guard: `role <> 'admin'` -> `role not in ('admin',
-- 'staff')` — Staff gets the same front-desk correction authority Admin
-- already has for an already-started/missed lesson.
--
-- (3) v_actor_role classification (BEHAVIORAL — cancellation-window check
-- and reservations.cancellation_kind mapping only): a NEW third WHEN
-- clause is inserted AFTER the existing admin and pro branches (both
-- untouched, same position, same condition — cannot change Admin or Pro
-- classification) and BEFORE the `else 'member'` fallback: `when
-- v_profile.role = 'staff' and not (v_is_member_by_history or
-- v_is_member_by_roster) then 'admin'`. This distinguishes Staff-acting-
-- as-operator (classified 'admin' for these two behavioral purposes only
-- — cancellation_kind='admin', no cancellation-window enforcement,
-- matching every other operator action in this migration) from
-- Staff-acting-as-the-member-on-their-own-lesson (falls through to the
-- unchanged `else 'member'` branch — cancellation-window enforcement
-- applies, exactly as for any Member, per the 0131 self-service-parity
-- rule extended to this continuity path).
--
-- (4) Phase 34A4A correction — v_persisted_actor_role (HISTORICAL IDENTITY
-- — the only value ever written to lesson_requests.last_actor_role): a
-- SEPARATE variable, same branch structure as v_actor_role, differing in
-- exactly the staff-operator branch (-> 'staff', not 'admin'). Principle
-- A (operational behavior classification, v_actor_role) and principle B
-- (actual actor role, v_persisted_actor_role) are computed independently
-- so a Staff operator's audit trail correctly says 'staff', never
-- silently 'admin', while the window/cancellation_kind behavior for that
-- same action still correctly treats them as an operator.
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
  -- Phase 34A4A correction: the value actually persisted to
  -- lesson_requests.last_actor_role — deliberately kept separate from
  -- v_actor_role (a BEHAVIORAL classification used only for the
  -- cancellation-window check and the reservations.cancellation_kind
  -- mapping below, both unchanged). Same branch structure as v_actor_role,
  -- differing in exactly one place: a Staff operator resolves to 'staff'
  -- here (their actual role) rather than v_actor_role's 'admin' bucket.
  v_persisted_actor_role text;
  v_result            public.lesson_requests%rowtype;
  v_member             public.profiles%rowtype;
  v_pro                public.profiles%rowtype;
  v_window_hours       int;
  v_old_reservation    public.reservations%rowtype;
  v_effective_starts_at timestamptz;
  v_caller_roster_id    uuid;
  v_is_member_by_history boolean;
  v_is_member_by_roster  boolean;
  v_is_pro               boolean;
  v_is_admin             boolean;
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

  v_is_member_by_history := v_request.member_id is not null and v_request.member_id = auth.uid();
  v_is_member_by_roster  := v_caller_roster_id is not null and v_request.roster_member_id = v_caller_roster_id;
  v_is_pro                := v_request.pro_id = auth.uid();
  v_is_admin               := v_profile.role = 'admin';

  -- Phase 34A4: Staff joins this allowlist as a generic operator — every
  -- other admitted case above is unchanged.
  if not (v_is_member_by_history or v_is_member_by_roster or v_is_pro or v_is_admin or v_profile.role = 'staff') then
    raise exception 'not_authorised_to_cancel';
  end if;

  if not (
    v_request.status = 'confirmed'
    or (v_request.status = 'proposed' and v_request.linked_reservation_id is not null)
  ) then
    raise exception 'invalid_status_for_cancel';
  end if;

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

  -- Phase 34A4: Staff gets the same already-started correction exemption
  -- Admin already has.
  if v_effective_starts_at <= now() and v_profile.role not in ('admin', 'staff') then
    raise exception 'lesson_already_started';
  end if;

  -- Phase 34A4: NEW third branch inserted after the unchanged admin/pro
  -- branches, before the unchanged `else 'member'` fallback — see this
  -- section's header above for the full non-regression argument. Purely
  -- BEHAVIORAL from here down (cancellation-window check,
  -- reservations.cancellation_kind mapping) — never written to
  -- lesson_requests.last_actor_role directly (see v_persisted_actor_role
  -- below, Phase 34A4A correction).
  v_actor_role := case
    when v_profile.role = 'admin' then 'admin'
    when auth.uid() = v_request.pro_id then 'pro'
    when v_profile.role = 'staff' and not (v_is_member_by_history or v_is_member_by_roster) then 'admin'
    else 'member'
  end;

  -- Phase 34A4A correction: identical branch structure/conditions to
  -- v_actor_role above — admin, pro-as-assigned-provider, and the
  -- else-'member' fallback (which also covers a non-staff, non-pro-here
  -- club member such as a Pro taking a lesson from another Pro — unchanged
  -- pre-existing behavior, not touched by this correction) all resolve
  -- identically to v_actor_role. Differs in exactly one branch: a Staff
  -- operator resolves to 'staff' (their actual role), not v_actor_role's
  -- 'admin' bucket — this is the only value ever written to
  -- lesson_requests.last_actor_role.
  v_persisted_actor_role := case
    when v_profile.role = 'admin' then 'admin'
    when auth.uid() = v_request.pro_id then 'pro'
    when v_profile.role = 'staff' and not (v_is_member_by_history or v_is_member_by_roster) then 'staff'
    else 'member'
  end;

  if v_actor_role = 'member' then
    select coalesce(cs.cancellation_window_hours, 24) into v_window_hours
      from public.club_settings cs
     where cs.club_id = v_profile.club_id;
    if (extract(epoch from (v_effective_starts_at - now())) / 3600) < v_window_hours then
      raise exception 'within_cancellation_window';
    end if;
  end if;

  if v_request.linked_reservation_id is not null then
    update public.reservations
       set status            = 'cancelled',
           cancelled_at      = now(),
           cancelled_by      = auth.uid(),
           cancellation_kind = case when v_actor_role = 'member' then 'member' else 'admin' end
     where id = v_request.linked_reservation_id;
  end if;

  update public.lesson_requests
     set status            = 'cancelled',
         lesson_outcome    = 'cancelled',
         cancellation_reason = p_reason,
         cancelled_at        = now(),
         last_actor_id        = auth.uid(),
         -- Phase 34A4A correction: v_persisted_actor_role, not v_actor_role
         -- — see its declaration/computation above. Admin, Pro-as-assigned-
         -- provider, and every pre-existing else-'member' case (including
         -- a Pro taking a lesson from another Pro, unchanged) resolve
         -- identically to before; only a Staff operator now correctly
         -- resolves to 'staff' instead of v_actor_role's 'admin' bucket.
         last_actor_role      = v_persisted_actor_role,
         proposed_starts_at   = null,
         proposed_ends_at     = null,
         proposed_court_id    = null,
         updated_at           = now()
   where id = p_request_id
  returning * into v_result;

  select * into v_member from public.profiles where id = v_current_member_id;
  select * into v_pro     from public.profiles where id = v_request.pro_id;

  if v_actor_role <> 'pro' and v_request.pro_id is not null then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_profile.club_id,
      v_request.pro_id,
      'lesson_cancelled',
      'Your lesson with '
        || trim(coalesce(v_member.first_name, '') || ' ' || coalesce(v_member.last_name, ''))
        || ' was cancelled.',
      jsonb_build_object('request_id', p_request_id)
    );
  end if;

  if v_actor_role <> 'member' and v_current_member_id is not null then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_profile.club_id,
      v_current_member_id,
      'lesson_cancelled',
      'Your lesson with '
        || trim(coalesce(v_pro.first_name, '') || ' ' || coalesce(v_pro.last_name, ''))
        || ' was cancelled.',
      jsonb_build_object('request_id', p_request_id)
    );
  end if;

  return v_result;
end;
$$;

revoke execute on function public.cancel_lesson(uuid, text) from public, anon;
grant  execute on function public.cancel_lesson(uuid, text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- RLS — narrow, verified additions only. Every widened RPC above is
-- SECURITY DEFINER and already bypasses RLS via function ownership
-- (the same mechanism every existing admin-only RPC has always relied on)
-- — none of the RLS changes below are required to make those RPCs work.
-- These four SELECT-policy widenings and one operator-visibility widening
-- exist for a different, narrower reason: giving an already-RPC-authorized
-- Staff operator the DIRECT READ visibility their operational UI needs
-- (the Calendar, the Members roster claim-status lookup) — confirmed via
-- direct grep of the pages this migration's frontend changes touch, not
-- granted speculatively. No INSERT/UPDATE/DELETE policy is touched — every
-- mutation continues to go exclusively through the SECURITY DEFINER RPCs
-- above, which is the sole write path for every domain covered here.
-- ═══════════════════════════════════════════════════════════════════════════

-- roster_members_select_admin — latest effective body: 0056, never
-- redefined. Widened from admin-only to operator. INSERT/UPDATE/DELETE
-- policies on roster_members are deliberately NOT touched — they remain
-- admin-only, a defense-in-depth measure so a Staff session's direct
-- PostgREST client can never bypass add_roster_member/update_roster_
-- member's own role-restriction logic via a raw table write, even though
-- no UI path attempts this today.
alter policy "roster_members_select_admin" on roster_members
  using (
    club_id = current_user_club_id()
    and public.current_user_is_operator()
  );

-- lesson_requests_select_admin — latest effective body: 0083. Widened from
-- admin-only to operator. Member and Pro lesson-request policies untouched.
alter policy "lesson_requests_select_admin" on public.lesson_requests
  using (
    club_id = public.current_user_club_id()
    and public.current_user_is_operator()
  );

-- reservations_select_same_club / events_select_same_club /
-- event_participants_select_same_club / programs_select_same_club —
-- latest effective bodies: 0123. Each widened from
-- `current_user_role() in ('admin', 'pro')` to `current_user_role() in
-- ('admin', 'pro', 'staff')` in the full-club-visibility branch — Pro's
-- inclusion in this branch already reflects unrestricted, non-provider-
-- scoped club-wide read visibility (identical reasoning to the Lessons
-- provider-eligibility widenings above: Pro's access here was never
-- narrowed to "only Pro's own events/reservations" to begin with), so
-- extending the same visibility to Staff is consistent, not a new kind of
-- grant. The member_self_service and own-row/own-participation/own-
-- enrollment branches are entirely unchanged — a Staff-Managed club's
-- Member-tier visibility restriction is untouched for a plain Member.
drop policy if exists "reservations_select_same_club" on reservations;
create policy "reservations_select_same_club"
  on reservations for select
  using (
    club_id = current_user_club_id()
    and (
      current_user_role() in ('admin', 'pro', 'staff')
      or current_club_has_capability('member_self_service')
      or owner_user_id = auth.uid()
      or roster_member_id = current_user_roster_member_id()
    )
  );

drop policy if exists "events_select_same_club" on events;
create policy "events_select_same_club"
  on events for select
  using (
    club_id = current_user_club_id()
    and (
      current_user_role() in ('admin', 'pro', 'staff')
      or current_club_has_capability('member_self_service')
      or current_user_participates_in_event(id)
    )
  );

drop policy if exists "event_participants_select_same_club" on event_participants;
create policy "event_participants_select_same_club"
  on event_participants for select
  using (
    exists (
      select 1 from events
      where events.id        = event_participants.event_id
        and events.club_id   = current_user_club_id()
    )
    and (
      current_user_role() in ('admin', 'pro', 'staff')
      or current_club_has_capability('member_self_service')
      or profile_id = auth.uid()
      or roster_member_id = current_user_roster_member_id()
    )
  );

drop policy if exists "programs_select_same_club" on public.programs;
create policy "programs_select_same_club"
  on public.programs for select
  using (
    club_id = public.current_user_club_id()
    and (
      current_user_role() in ('admin', 'pro', 'staff')
      or current_club_has_capability('member_self_service')
      or current_user_enrolled_in_program(id)
    )
  );

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- Functions — restore the prior CREATE OR REPLACE body from its cited
-- source migration:
--   get_members, get_admin_member_detail, get_member_upcoming_activity,
--   get_member_notes, get_member_activity_history -> NOT any migration file
--                                             (0083/0077 are all stale for these five
--                                             functions' signatures/RETURNS TABLE
--                                             contracts/bodies). Restore each by
--                                             re-querying its live Production function
--                                             definition (pg_get_functiondef)
--                                             immediately before rolling back, the same
--                                             way this migration's own bodies were sourced.
--   get_roster_members                    -> 0117 (one-argument p_include_inactive signature; do NOT restore 0056's zero-argument body)
--   add_roster_member, update_roster_member -> 0131
--   create_club_invite                     -> 0131
--   resend_club_invite                     -> 0117
--   revoke_club_invite                     -> 0032 (reverts search_path hardening too)
--   get_club_invites                       -> 0032 (reverts search_path hardening too)
--   admin_create_member_reservation        -> 0108
--   update_member_reservation              -> 0109
--   admin_cancel_reservation_v2            -> 0119
--   admin_create_member_lesson             -> 0128
--   get_lesson_roster_members              -> 0128
--   reassign_lesson_provider               -> 0101
--   get_club_pros                          -> 0071
--   get_admin_club_pros                    -> 0080
--   submit_lesson_request                  -> 0131
--   get_pro_lesson_requests                -> 0111
--   mark_lesson_outcome                    -> 0077
--   cancel_lesson                          -> 0111
--   drop function if exists public.current_user_is_operator();
--     (only after reverting the RLS policies below, which reference it)
-- Policies — restore the prior definition from its cited source migration:
--   roster_members_select_admin           -> 0056
--   lesson_requests_select_admin          -> 0083
--   reservations_select_same_club, events_select_same_club,
--   event_participants_select_same_club, programs_select_same_club -> 0123
