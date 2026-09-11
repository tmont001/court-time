-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 35C — Pro feed gap: personal reservations + Event/Program
-- participation missing from feed_type='pro_lessons'
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0173 and 0174 are APPLIED and VERIFIED. This migration does not edit
-- either — it redefines get_calendar_feed_rows(text) again via
-- CREATE OR REPLACE (same name, same signature, so the existing
-- service_role-only grant is preserved automatically — no REVOKE/GRANT
-- statements are needed or included here). No table/column/trigger changes
-- are needed: every column this fix reads (events.cancelled_at,
-- event_participants.confirmed_at/cancelled_at/roster_member_id,
-- reservations.cancelled_at/roster_member_id) already exists from 0108,
-- 0113, 0173 and 0174.
--
-- ROOT CAUSE (runtime QA on the applied 0173/0174):
--
--   feed_type='pro_lessons' only ever selected from lesson_requests
--   (l.pro_id = token.profile_id). A Pro subscription is meant to answer
--   "where do I personally need to be?" — but a Pro's own personal court
--   reservations (booked via create_reservation, same as any Member,
--   reason='member_booking' — see 0131_staff_role_identity_foundation.sql,
--   which explicitly allows admin/pro self-booking) and a Pro's own
--   confirmed participation in an Event or Program occurrence (via
--   event_participants, exactly like a Member's) were both silently
--   dropped, because the pro_lessons branch never queried either table.
--
-- FIX: the pro_lessons branch now UNIONs in the SAME two branches the
-- member_personal branch already uses for reservations and Event/Program
-- participation — reused verbatim (same reason='member_booking' filter,
-- same event_participants confirmed/cancelled inclusion logic, same
-- baseline/cancellation-timestamp gating from 0174, same revision_at
-- formulas) — scoped to the Pro's own identity
-- (profile_id = token.profile_id OR roster_member_id = the Pro's own
-- durable roster identity, via the existing role-agnostic
-- _roster_member_id_for helper). This is the exact same durable-identity
-- OR-match pattern already used everywhere else in this function; no new
-- ownership model, no new column, no new helper.
--
-- Because event_participants is the sole occurrence-level participation
-- source (unchanged architecture decision from 0173), a Pro is included
-- ONLY when they hold a genuinely confirmed event_participants row for
-- that occurrence. This means:
--   - An Event the Pro created or administers, but is not personally
--     registered in, is correctly EXCLUDED (no ownership/admin/creator
--     check exists anywhere in this branch — events has no pro/instructor
--     column at all; participation is solely via event_participants).
--   - A waitlisted/offered Pro registration (confirmed_at IS NULL) is
--     correctly EXCLUDED, identical to the Member branch's own rule.
--   - A whole-Program occurrence is included exactly once, through the
--     same single event_participants UNION branch already used for
--     standalone Events and per-session Program occurrences alike — no
--     separate Program branch, so no duplication risk is introduced.
--
-- pro_lessons itself is NOT renamed. It is a persisted, storage-level
-- calendar_feed_tokens.feed_type value (CHECK-constrained by 0173) and is
-- also referenced by profile UX plumbing (page.tsx's calendarFeedType,
-- issue/revoke Server Actions). It has always meant "this Pro's personal
-- calendar," never literally "Lessons only" — the CHECK constraint,
-- column comment, and every caller already treat it as an opaque scope
-- identifier, not a user-facing label. Renaming it would be a pure
-- storage-compatibility break for zero product benefit, so it is
-- preserved unchanged; only the ROWS it produces are corrected.
--
-- Preserves unchanged, exactly as in 0173/0174: active Pro membership
-- gate (_is_active_member_of_club(..., 'pro')), secret token/hash
-- architecture, service-role-only execution, generic 404 for every
-- invalid/unauthorized/revoked state, no raw-token logging anywhere in
-- this function (it only ever sees the hash), stable UIDs (this function
-- returns raw ids; UID construction happens in application code, from
-- @/lib/calendar/export, untouched by this migration), LAST-MODIFIED/
-- revision_at behavior (each new branch uses the identical revision_at
-- formula already used by the corresponding member_personal branch), and
-- cancellation provenance/baseline behavior (identical
-- greatest(token.created_at, now() - 90d) baseline and
-- cancelled_at >= token.created_at gating, reused verbatim).
--
-- Apply in Supabase SQL Editor (cloud only). Idempotent — CREATE OR
-- REPLACE only, safe to rerun.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace function public.get_calendar_feed_rows(
  p_token_hash text
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_token                  public.calendar_feed_tokens%rowtype;
  v_roster_member_id       uuid;
  v_authorized             boolean := false;
  v_rows                   jsonb;
  v_candidate_window_start timestamptz := now() - interval '90 days';
  v_candidate_window_end   timestamptz := now() + interval '180 days';
  v_active_window_start    timestamptz;
begin
  select * into v_token
    from public.calendar_feed_tokens
   where token_hash = p_token_hash
     and revoked_at is null;

  if not found then
    return null;
  end if;

  v_active_window_start := greatest(v_token.created_at, v_candidate_window_start);

  if v_token.feed_type = 'member_personal' then
    v_authorized :=
      public._is_active_member_of_club(v_token.club_id, v_token.profile_id, 'member')
      and public.club_has_capability(v_token.club_id, 'member_self_service');
  elsif v_token.feed_type = 'pro_lessons' then
    v_authorized := public._is_active_member_of_club(v_token.club_id, v_token.profile_id, 'pro');
  else
    v_authorized := false;
  end if;

  if not v_authorized then
    return null;
  end if;

  -- Moved above the branch split (was previously computed only inside the
  -- member_personal branch): both feed types now need the caller's own
  -- durable roster identity for the OR-match ownership/participation
  -- predicates below. Role-agnostic — resolves a Pro's own claimed roster
  -- row exactly the same way it resolves a Member's.
  v_roster_member_id := public._roster_member_id_for(v_token.club_id, v_token.profile_id);

  if v_token.feed_type = 'member_personal' then

    select coalesce(jsonb_agg(t), '[]'::jsonb) into v_rows
      from (
        -- own court reservations. revision_at: reservations.updated_at
        -- (covers time/status/court_id/notes-visibility edits — any
        -- UPDATE on this row) joined with courts.updated_at (a court
        -- RENAME changes the exported LOCATION text without touching the
        -- reservation row itself).
        select
          'reservation'::text as domain, r.id, r.starts_at, r.ends_at,
          (r.status = 'cancelled')      as is_cancelled,
          null::text                    as title,
          c.name                        as court_name,
          null::text                    as description,
          null::text                    as counterparty_name,
          greatest(r.updated_at, c.updated_at) as revision_at
        from public.reservations r
        join public.courts c on c.id = r.court_id
        where r.club_id = v_token.club_id
          and r.reason  = 'member_booking'
          and (
            (r.status = 'confirmed' and r.ends_at >= v_active_window_start)
            or
            (
              r.status = 'cancelled'
              and r.cancelled_at is not null
              and r.cancelled_at >= v_token.created_at
              and r.ends_at >= v_candidate_window_start
            )
          )
          and (
            r.owner_user_id = v_token.profile_id
            or (v_roster_member_id is not null and r.roster_member_id = v_roster_member_id)
          )
          and r.starts_at <= v_candidate_window_end

        union all

        -- Event participation — the ONE occurrence-level source for
        -- standalone Events, per-session Program occurrences, AND
        -- whole-Program materialized occurrences alike (unchanged
        -- architecture decision from 0173's own correction pass).
        select
          'event'::text, e.id, e.starts_at, e.ends_at,
          (e.status = 'cancelled' or ep.status = 'cancelled') as is_cancelled,
          e.title,
          (
            select string_agg(distinct co.name, ', ' order by co.name)
            from public.reservations er
            join public.courts co on co.id = er.court_id
            where er.event_id = e.id and er.reason = 'event' and er.status = 'confirmed'
          ),
          case when e.program_id is not null
               then (select pr.description from public.programs pr where pr.id = e.program_id)
               else null end,
          null::text,
          greatest(
            e.updated_at,
            ep.updated_at,
            coalesce(
              (select max(greatest(er.updated_at, co.updated_at))
                 from public.reservations er
                 join public.courts co on co.id = er.court_id
                where er.event_id = e.id and er.reason = 'event' and er.status = 'confirmed'),
              e.updated_at
            ),
            case when e.program_id is not null
                 then coalesce((select pr.updated_at from public.programs pr where pr.id = e.program_id), e.updated_at)
                 else e.updated_at end
          ) as revision_at
        from public.event_participants ep
        join public.events e on e.id = ep.event_id
        where e.club_id = v_token.club_id
          and (
            ep.profile_id = v_token.profile_id
            or (v_roster_member_id is not null and ep.roster_member_id = v_roster_member_id)
          )
          and e.starts_at <= v_candidate_window_end
          and (
            (ep.status = 'confirmed' and e.status = 'scheduled' and e.ends_at >= v_active_window_start)
            or
            (
              e.status = 'cancelled'
              and ep.confirmed_at is not null
              and e.cancelled_at is not null
              and e.cancelled_at >= v_token.created_at
              and e.ends_at >= v_candidate_window_start
            )
            or
            (
              e.status = 'scheduled'
              and ep.status = 'cancelled'
              and ep.confirmed_at is not null
              and ep.cancelled_at is not null
              and ep.cancelled_at >= v_token.created_at
              and e.ends_at >= v_candidate_window_start
            )
          )

        union all

        -- Lessons (Member side) — durable identity unchanged from 0173.
        select
          'lesson'::text, l.id, l.proposed_starts_at, l.proposed_ends_at,
          (l.status = 'cancelled'),
          null::text, co.name, l.member_note,
          coalesce(nullif(trim(concat_ws(' ', pp.first_name, pp.last_name)), ''), 'Court Time Member'),
          greatest(
            l.updated_at,
            coalesce(co.updated_at, l.updated_at),
            coalesce(pp.updated_at, l.updated_at)
          ) as revision_at
        from public.lesson_requests l
        left join public.courts co on co.id = l.proposed_court_id
        left join public.profiles pp on pp.id = l.pro_id
        where l.club_id = v_token.club_id
          and (
            l.member_id = v_token.profile_id
            or (v_roster_member_id is not null and l.roster_member_id = v_roster_member_id)
          )
          and l.proposed_starts_at is not null
          and l.proposed_ends_at   is not null
          and l.proposed_starts_at <= v_candidate_window_end
          and (
            (l.status = 'confirmed' and l.proposed_ends_at >= v_active_window_start)
            or
            (
              l.status = 'cancelled'
              and l.confirmed_at is not null
              and l.cancelled_at is not null
              and l.cancelled_at >= v_token.created_at
              and l.proposed_ends_at >= v_candidate_window_start
            )
          )
      ) t;

  else -- pro_lessons: "where do I personally need to be?"

    select coalesce(jsonb_agg(t), '[]'::jsonb) into v_rows
      from (
        -- own court reservations (personal booking, reason='member_booking'
        -- — create_reservation explicitly permits admin/pro self-booking,
        -- see 0131_staff_role_identity_foundation.sql). Structurally
        -- IDENTICAL to the member_personal branch above, scoped to this
        -- Pro's own identity — never a parallel ownership model.
        select
          'reservation'::text as domain, r.id, r.starts_at, r.ends_at,
          (r.status = 'cancelled')      as is_cancelled,
          null::text                    as title,
          c.name                        as court_name,
          null::text                    as description,
          null::text                    as counterparty_name,
          greatest(r.updated_at, c.updated_at) as revision_at
        from public.reservations r
        join public.courts c on c.id = r.court_id
        where r.club_id = v_token.club_id
          and r.reason  = 'member_booking'
          and (
            (r.status = 'confirmed' and r.ends_at >= v_active_window_start)
            or
            (
              r.status = 'cancelled'
              and r.cancelled_at is not null
              and r.cancelled_at >= v_token.created_at
              and r.ends_at >= v_candidate_window_start
            )
          )
          and (
            r.owner_user_id = v_token.profile_id
            or (v_roster_member_id is not null and r.roster_member_id = v_roster_member_id)
          )
          and r.starts_at <= v_candidate_window_end

        union all

        -- Event/Program occurrence participation as a confirmed
        -- participant. Structurally IDENTICAL to the member_personal
        -- branch above. Deliberately NOT gated by any Event
        -- creator/administrator relationship — events carries no
        -- pro/instructor column at all, so an Event the Pro merely
        -- created or manages is correctly excluded unless this Pro also
        -- holds a genuinely confirmed event_participants row for it.
        select
          'event'::text, e.id, e.starts_at, e.ends_at,
          (e.status = 'cancelled' or ep.status = 'cancelled') as is_cancelled,
          e.title,
          (
            select string_agg(distinct co.name, ', ' order by co.name)
            from public.reservations er
            join public.courts co on co.id = er.court_id
            where er.event_id = e.id and er.reason = 'event' and er.status = 'confirmed'
          ),
          case when e.program_id is not null
               then (select pr.description from public.programs pr where pr.id = e.program_id)
               else null end,
          null::text,
          greatest(
            e.updated_at,
            ep.updated_at,
            coalesce(
              (select max(greatest(er.updated_at, co.updated_at))
                 from public.reservations er
                 join public.courts co on co.id = er.court_id
                where er.event_id = e.id and er.reason = 'event' and er.status = 'confirmed'),
              e.updated_at
            ),
            case when e.program_id is not null
                 then coalesce((select pr.updated_at from public.programs pr where pr.id = e.program_id), e.updated_at)
                 else e.updated_at end
          ) as revision_at
        from public.event_participants ep
        join public.events e on e.id = ep.event_id
        where e.club_id = v_token.club_id
          and (
            ep.profile_id = v_token.profile_id
            or (v_roster_member_id is not null and ep.roster_member_id = v_roster_member_id)
          )
          and e.starts_at <= v_candidate_window_end
          and (
            (ep.status = 'confirmed' and e.status = 'scheduled' and e.ends_at >= v_active_window_start)
            or
            (
              e.status = 'cancelled'
              and ep.confirmed_at is not null
              and e.cancelled_at is not null
              and e.cancelled_at >= v_token.created_at
              and e.ends_at >= v_candidate_window_start
            )
            or
            (
              e.status = 'scheduled'
              and ep.status = 'cancelled'
              and ep.confirmed_at is not null
              and ep.cancelled_at is not null
              and ep.cancelled_at >= v_token.created_at
              and e.ends_at >= v_candidate_window_start
            )
          )

        union all

        -- Lessons as the assigned Pro — unchanged from 0174.
        select
          'lesson'::text as domain, l.id, l.proposed_starts_at as starts_at, l.proposed_ends_at as ends_at,
          (l.status = 'cancelled') as is_cancelled,
          null::text as title, co.name as court_name, l.member_note as description,
          coalesce(
            nullif(trim(concat_ws(' ', mp.first_name, mp.last_name)), ''),
            nullif(trim(concat_ws(' ', rm.first_name, rm.last_name)), ''),
            'Court Time Member'
          ) as counterparty_name,
          greatest(
            l.updated_at,
            coalesce(co.updated_at, l.updated_at),
            coalesce(mp.updated_at, l.updated_at),
            coalesce(rm.updated_at, l.updated_at)
          ) as revision_at
        from public.lesson_requests l
        left join public.courts co on co.id = l.proposed_court_id
        left join public.profiles mp on mp.id = l.member_id
        left join public.roster_members rm on rm.id = l.roster_member_id
        where l.club_id = v_token.club_id
          and l.pro_id  = v_token.profile_id
          and l.proposed_starts_at is not null
          and l.proposed_ends_at   is not null
          and l.proposed_starts_at <= v_candidate_window_end
          and (
            (l.status = 'confirmed' and l.proposed_ends_at >= v_active_window_start)
            or
            (
              l.status = 'cancelled'
              and l.confirmed_at is not null
              and l.cancelled_at is not null
              and l.cancelled_at >= v_token.created_at
              and l.proposed_ends_at >= v_candidate_window_start
            )
          )
      ) t;
  end if;

  return jsonb_build_object('feed_type', v_token.feed_type, 'rows', v_rows);
end;
$$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint). Restoring get_calendar_feed_rows's PRE-0175 body means
-- reverting to 0174's own definition (see that migration's text) via
-- another CREATE OR REPLACE — do not simply DROP FUNCTION, which would
-- also drop the service_role grant that must be re-created identically.
-- No columns/triggers were added by this migration, so there is nothing
-- else to roll back.
-- ═══════════════════════════════════════════════════════════════════════════
