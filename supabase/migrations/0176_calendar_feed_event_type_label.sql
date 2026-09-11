-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 35C — Subscription feed: Event Type label for calendar SUMMARY
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0173, 0174, and 0175 are APPLIED and VERIFIED. This migration does not
-- edit any of them — it redefines get_calendar_feed_rows(text) again via
-- CREATE OR REPLACE (same name, same signature, so the existing
-- service_role-only grant, SECURITY DEFINER, STABLE volatility, and pinned
-- search_path are all preserved automatically — no GRANT/REVOKE/ALTER
-- FUNCTION statements are needed or included here). No table/column/
-- trigger changes, no new helper function.
--
-- ROOT CAUSE: the one-off "Add to Calendar" export (@/lib/calendar/export,
-- @/app/api/calendar/export) was extended this checkpoint to prefix a
-- standalone Event's or Program occurrence's calendar SUMMARY with its
-- human-readable Event Type label (e.g. "Clinic — Advanced Doubles
-- Drill"), via a new pure function, buildEventSummary
-- (@/lib/calendar/export), reused unchanged by the subscription feed's own
-- summary construction (buildFeedIcsEvent, @/lib/calendar/feed). The
-- subscription feed's FeedRow type already carries an OPTIONAL
-- `event_type_label` field for exactly this purpose, but
-- get_calendar_feed_rows never selected it — this migration is the one
-- remaining piece: making the SQL layer supply that field so the
-- already-shipped, already-tested TypeScript summary logic actually
-- receives it for a live subscription.
--
-- FIX: both the member_personal and pro_lessons branches' Event/Program-
-- occurrence SELECT now:
--   1. join public.event_types et on et.id = e.event_type_id (every
--      events row, standalone or Program-generated occurrence, already
--      carries a NOT NULL event_type_id — see 0004_events.sql — so this is
--      an inner join, never introducing a row-dropping risk).
--   2. project et.label as event_type_label (the admin-editable DISPLAY
--      text — never event_types.key, the immutable internal identifier).
--   3. fold et.updated_at into that row's existing revision_at
--      greatest(...) — an Event Type rename changes this row's visible
--      SUMMARY content exactly as much as a court rename changes its
--      visible LOCATION (already covered via courts.updated_at in the
--      same greatest(...)), so it must be able to advance LAST-MODIFIED
--      for the identical reason.
--
-- UNION SHAPE: get_calendar_feed_rows builds two separate 3-way UNION ALLs
-- (one for member_personal: reservation/event/lesson; one for pro_lessons:
-- reservation/event/lesson) — Postgres requires every branch within EACH
-- UNION ALL to return the same column count in the same positional order
-- and compatible types. event_type_label is meaningful ONLY for the event
-- domain, so the reservation and lesson branches in both UNIONs now
-- project `null::text as event_type_label` — a real column, deliberately
-- always null for those two domains, never omitted. To guarantee this
-- migration cannot displace or renumber any EXISTING column (revision_at
-- included), event_type_label is appended as a new column strictly AFTER
-- every other column already returned by 0175 — every column's identity
-- and relative order from 0175 is otherwise byte-for-byte unchanged in
-- this file. This new column carries no additional privacy exposure: the
-- Event Type label is the same admin-editable display text already shown
-- to any club member wherever Events are listed today; it was never
-- gated by anything narrower than the existing per-domain feed
-- authorization this function already enforces before this branch is
-- ever reached.
--
-- Preserves unchanged, exactly as in 0173/0174/0175: member_self_service
-- gate for member_personal, active Pro membership gate for pro_lessons,
-- durable profile/roster OR-match identity logic (both Member and Pro
-- reservation ownership), confirmed Event participation rules, waitlisted/
-- offered exclusions, Program occurrence single-inclusion behavior, Lesson
-- confirmed/cancelled rules, cancellation provenance
-- (cancelled_at >= token.created_at gating), the subscription baseline
-- (greatest(token.created_at, now() - 90d)), the 90-day-back/180-day-
-- forward candidate window, stable UIDs (unaffected — this function
-- returns raw ids; UID construction happens in application code, from
-- @/lib/calendar/export, untouched by this migration), generic null-
-- return behavior for every invalid/unauthorized/revoked token state,
-- service-role-only execution, and the pinned search_path.
--
-- No supabase/scripts verification file is added for this checkpoint —
-- per current team convention, focused structural verification SQL is
-- pasted directly into the Supabase SQL Editor at apply time and behavior
-- is confirmed via real runtime QA, not a permanently-committed synthetic
-- fixture script.
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

  v_roster_member_id := public._roster_member_id_for(v_token.club_id, v_token.profile_id);

  if v_token.feed_type = 'member_personal' then

    select coalesce(jsonb_agg(t), '[]'::jsonb) into v_rows
      from (
        -- own court reservations. revision_at: reservations.updated_at
        -- (covers time/status/court_id/notes-visibility edits — any
        -- UPDATE on this row) joined with courts.updated_at (a court
        -- RENAME changes the exported LOCATION text without touching the
        -- reservation row itself). event_type_label is always null here —
        -- Reservations have no Event Type.
        select
          'reservation'::text as domain, r.id, r.starts_at, r.ends_at,
          (r.status = 'cancelled')      as is_cancelled,
          null::text                    as title,
          c.name                        as court_name,
          null::text                    as description,
          null::text                    as counterparty_name,
          greatest(r.updated_at, c.updated_at) as revision_at,
          null::text                    as event_type_label
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
        -- event_type_label (NEW this migration): every events row carries
        -- a NOT NULL event_type_id, so this is a plain inner join with no
        -- row-dropping risk; et.updated_at is folded into revision_at
        -- below since an Event Type rename changes this row's visible
        -- SUMMARY content.
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
            et.updated_at,
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
          ) as revision_at,
          et.label as event_type_label
        from public.event_participants ep
        join public.events e on e.id = ep.event_id
        join public.event_types et on et.id = e.event_type_id
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
        -- event_type_label is always null here — Lessons have no Event
        -- Type.
        select
          'lesson'::text, l.id, l.proposed_starts_at, l.proposed_ends_at,
          (l.status = 'cancelled'),
          null::text, co.name, l.member_note,
          coalesce(nullif(trim(concat_ws(' ', pp.first_name, pp.last_name)), ''), 'Court Time Member'),
          greatest(
            l.updated_at,
            coalesce(co.updated_at, l.updated_at),
            coalesce(pp.updated_at, l.updated_at)
          ) as revision_at,
          null::text as event_type_label
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
        -- event_type_label is always null here — Reservations have no
        -- Event Type.
        select
          'reservation'::text as domain, r.id, r.starts_at, r.ends_at,
          (r.status = 'cancelled')      as is_cancelled,
          null::text                    as title,
          c.name                        as court_name,
          null::text                    as description,
          null::text                    as counterparty_name,
          greatest(r.updated_at, c.updated_at) as revision_at,
          null::text                    as event_type_label
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
        -- event_type_label (NEW this migration): same join/revision_at
        -- treatment as the member_personal Event branch above.
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
            et.updated_at,
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
          ) as revision_at,
          et.label as event_type_label
        from public.event_participants ep
        join public.events e on e.id = ep.event_id
        join public.event_types et on et.id = e.event_type_id
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

        -- Lessons as the assigned Pro — unchanged from 0174. event_type_
        -- label is always null here — Lessons have no Event Type.
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
          ) as revision_at,
          null::text as event_type_label
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
-- this checkpoint). Restoring get_calendar_feed_rows's PRE-0176 body means
-- reverting to 0175's own definition (see that migration's text) via
-- another CREATE OR REPLACE — do not simply DROP FUNCTION, which would
-- also drop the service_role grant that must be re-created identically.
-- No columns/triggers were added by this migration, so there is nothing
-- else to roll back.
-- ═══════════════════════════════════════════════════════════════════════════
