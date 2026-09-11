-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 35C — Runtime Correction: subscription baseline + revision metadata
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0173 is APPLIED and VERIFIED. This migration does not edit 0173 — it adds
-- new schema/lifecycle state and redefines get_calendar_feed_rows(text) via
-- CREATE OR REPLACE (same name, same signature, so its existing
-- service_role-only grant from 0173 is preserved automatically — no
-- REVOKE/GRANT statements are needed or included here).
--
-- ROOT CAUSES (runtime QA on the applied 0173):
--
--   1. A newly-created subscription immediately backfilled months of old
--      history. 0173's candidate window was a pure rolling 90-day-back/
--      180-day-forward horizon with no awareness of WHEN the subscription
--      itself was created — correct for an established subscription's
--      ongoing behavior, wrong for the very first fetch after issuance.
--      FIX: an ACTIVE item's lower candidate bound is now
--      greatest(token.created_at, now() - interval '90 days') — a brand
--      new token's bound is effectively "now" (no backfill); as the token
--      ages past 90 days old, the bound reverts to the normal rolling
--      window. An item currently in progress at token-creation time still
--      qualifies (its ends_at is necessarily >= token.created_at).
--
--   2. A closely-related failure mode: a Member who joined an Event next
--      month and cancelled yesterday, then created a subscription TODAY,
--      must not see that cancelled Event appear as a fresh
--      STATUS:CANCELLED ghost — they never had it in this calendar to
--      begin with. A cancellation may only appear if BOTH (a) it was a
--      genuine previously-confirmed commitment (already enforced via
--      confirmed_at, 0173) AND (b) the cancellation itself happened at or
--      after this token's own created_at. This required an authoritative
--      cancellation timestamp per domain:
--        - reservations.cancelled_at            — ALREADY EXISTS (0003).
--        - lesson_requests.cancelled_at          — ALREADY EXISTS (0069).
--        - event_participants.cancelled_at       — DID NOT EXIST. Added
--          below, trigger-maintained exactly like confirmed_at (0173).
--        - events.cancelled_at (whole-Event cancellation) — DID NOT
--          EXIST. Audited cancel_event's actual writers (0063 -> 0099 ->
--          0102 -> 0113 -> 0161, latest body inspected): every version
--          only ever sets `status = 'cancelled', updated_at = now()` — no
--          dedicated cancellation timestamp. events.updated_at is NOT a
--          safe substitute: it is bumped by ANY later UPDATE to the row
--          (e.g. archival, per the existing archived_at/archived_by
--          columns and archive_event's own writer, could touch a
--          cancelled event's updated_at again after the actual
--          cancellation moment), which is exactly the "ambiguous later
--          updated_at" this correction was told to avoid. Added
--          events.cancelled_at below, trigger-maintained the same way.
--
--   3. Edited Events were observed staying stale in subscribed calendars.
--      0173 gave calendar clients no signal that content had changed
--      besides the fields themselves — no LAST-MODIFIED, and a client
--      that already cached a VEVENT for a given UID has no standards-based
--      reason to re-render it just because DTSTART changed under an
--      unmodified ETag-driven fetch cycle (the semantic ETag DOES change
--      end-to-end, but per-VEVENT revision metadata is what RFC 5545
--      actually specifies for this purpose, and what real calendar
--      clients are more likely to honor at the per-event level). FIX:
--      every domain branch of get_calendar_feed_rows now computes and
--      returns revision_at — a MAX() over every source column that can
--      affect this row's feed-visible content — and the application layer
--      (src/lib/calendar/feed.ts, src/lib/ics.ts) emits it as LAST-
--      MODIFIED on every VEVENT. See each branch below for its exact
--      revision_at formula and the audit backing it.
--
-- SEQUENCE was evaluated and remains deliberately omitted — see
-- src/lib/ics.ts's own updated header comment for the full rationale
-- (no domain carries a genuine monotonic revision counter, and deriving
-- one from a timestamp would be exactly the brittle, direction-unstable
-- arithmetic this correction was told to avoid). LAST-MODIFIED + stable
-- UID + changed DTSTART/DTEND/SUMMARY/LOCATION/STATUS + the semantic ETag
-- are judged sufficient; revisit only if real Apple/Google client behavior
-- proves otherwise.
--
-- CORRECTION (this file never having been applied): both new cancelled_at
-- triggers below (_preserve_event_cancelled_at, and the cancelled_at half
-- of _preserve_event_participant_confirmed_at) originally set cancelled_at
-- := now() on ANY update where new.status = 'cancelled', with no check
-- that OLD.status was actually something else first. That meant an
-- unrelated later update to a row that was ALREADY 'cancelled' before AND
-- after — most notably one of this very migration's own intentionally-
-- NULL historical rows — would manufacture a fresh, wrong cancellation
-- timestamp the next time anything on that row changed, recreating
-- exactly the "ambiguous provenance" problem this column exists to avoid.
-- Both triggers now require `old.status is distinct from 'cancelled'` in
-- addition to `new.status = 'cancelled'` before stamping cancelled_at —
-- see each trigger's own comment below for the corrected logic.
--
-- Apply in Supabase SQL Editor (cloud only). Idempotent — safe to rerun
-- after a partial failure (add column if not exists; every function is
-- create or replace; every trigger is drop-then-create).
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. events.cancelled_at — minimal, trigger-maintained, no backfill
-- ═══════════════════════════════════════════════════════════════════════════
-- Same accepted-limitation posture as event_participants.confirmed_at's own
-- backfill decision (0173): rows already status='cancelled' before this
-- migration runs are left with cancelled_at NULL — there is no
-- authoritative evidence in this repository of exactly when they were
-- cancelled, and guessing would risk exactly the false-baseline problem
-- this column exists to prevent. Only cancellations that occur FROM this
-- migration forward are guaranteed correct, via the trigger below.
alter table public.events
  add column if not exists cancelled_at timestamptz;

create or replace function public._preserve_event_cancelled_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.cancelled_at := case when new.status = 'cancelled' then coalesce(new.cancelled_at, now()) else null end;
  elsif tg_op = 'UPDATE' then
    -- Correction pass: cancelled_at records the first OBSERVED TRANSITION
    -- INTO 'cancelled' — not merely "any UPDATE while the row happens to
    -- already be cancelled". The prior body's `elsif new.status =
    -- 'cancelled'` branch (with no check on OLD.status) fired for EVERY
    -- update to an already-cancelled row whose cancelled_at was still
    -- NULL — including a historical row deliberately left NULL by this
    -- migration's own no-backfill policy — manufacturing a fresh, wrong
    -- cancellation timestamp the moment ANY unrelated field (e.g. title,
    -- via a later archive/edit) was next touched. The added
    -- `old.status is distinct from 'cancelled'` guard requires a GENUINE
    -- transition; an unrelated update to a row that was already
    -- 'cancelled' before AND after now correctly falls to the final
    -- `else` branch, which (correctly) leaves cancelled_at exactly as it
    -- was if already set, or NULL if it wasn't.
    if old.cancelled_at is not null then
      new.cancelled_at := old.cancelled_at;
    elsif old.status is distinct from 'cancelled' and new.status = 'cancelled' then
      new.cancelled_at := now();
    else
      new.cancelled_at := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists events_preserve_cancelled_at on public.events;
create trigger events_preserve_cancelled_at
  before insert or update on public.events
  for each row execute function public._preserve_event_cancelled_at();

comment on column public.events.cancelled_at is
  'Set the first time this row is OBSERVED TRANSITIONING INTO status=''cancelled'' '
  '(i.e. OLD.status was something else and NEW.status is ''cancelled'') — never '
  'merely "the row happens to be cancelled during an update", and never cleared '
  'afterward. Enforced by the events_preserve_cancelled_at trigger, not by '
  'cancel_event or any other individual RPC. Rows already status=''cancelled'' '
  'before migration 0174 was applied are left NULL (no authoritative historical '
  'evidence of when they were cancelled) and STAY NULL even across later '
  'unrelated updates to the same row — this is an accepted, documented '
  'limitation, matching the identical backfill decision already made for '
  'event_participants.confirmed_at in migration 0173.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. event_participants.cancelled_at — minimal, trigger-maintained, no
--    backfill (folded into the SAME trigger function 0173 already created
--    for confirmed_at — one trigger, one function, both lifecycle fields)
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.event_participants
  add column if not exists cancelled_at timestamptz;

create or replace function public._preserve_event_participant_confirmed_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'confirmed' then
      new.confirmed_at := coalesce(new.confirmed_at, now());
      new.cancelled_at := null;
    elsif new.status = 'cancelled' then
      -- A row inserted directly as cancelled was never a genuine
      -- commitment (it never passed through 'confirmed') — confirmed_at
      -- stays NULL, which is what actually keeps it out of the feed's
      -- cancelled-commitment set (0173/0174's WHERE clauses below both
      -- require confirmed_at IS NOT NULL); cancelled_at is still recorded
      -- for completeness/consistency but is inert without confirmed_at.
      new.confirmed_at := null;
      new.cancelled_at := coalesce(new.cancelled_at, now());
    else
      new.confirmed_at := null;
      new.cancelled_at := null;
    end if;
  elsif tg_op = 'UPDATE' then
    -- confirmed_at: once set, forever preserved (unchanged from 0173).
    if old.confirmed_at is not null then
      new.confirmed_at := old.confirmed_at;
    elsif new.status = 'confirmed' then
      new.confirmed_at := now();
    else
      new.confirmed_at := null;
    end if;

    -- cancelled_at: records the first OBSERVED TRANSITION INTO
    -- 'cancelled' — same correction as events.cancelled_at above, and for
    -- the identical reason: without the `old.status is distinct from
    -- 'cancelled'` guard, ANY update to a row already status='cancelled'
    -- with cancelled_at still NULL (a pre-0174 historical row, left NULL
    -- on purpose) would have manufactured a fresh, wrong cancellation
    -- timestamp the next time that row was touched for any unrelated
    -- reason (e.g. attendance_status). Once genuinely set, still preserved
    -- forever regardless of later status changes — no RPC in this
    -- codebase currently reinstates a cancelled event_participants row
    -- back to 'confirmed' and then cancels it again; if one is ever
    -- added, this preserved-forever value would keep referring to the
    -- FIRST cancellation cycle, the same known, accepted limitation
    -- confirmed_at's own "preserve forever" rule already carries.
    if old.cancelled_at is not null then
      new.cancelled_at := old.cancelled_at;
    elsif old.status is distinct from 'cancelled' and new.status = 'cancelled' then
      new.cancelled_at := now();
    else
      new.cancelled_at := null;
    end if;
  end if;
  return new;
end;
$$;

-- The trigger itself (name, timing, function it calls) is unchanged from
-- 0173 — only the function body above changed — so no DROP/CREATE TRIGGER
-- is needed here. Left as a comment for anyone auditing this file in
-- isolation: `create trigger event_participants_preserve_confirmed_at
-- before insert or update on public.event_participants for each row
-- execute function public._preserve_event_participant_confirmed_at();`
-- (defined in 0173, still in effect, now calling this updated body).

comment on column public.event_participants.cancelled_at is
  'Set the first time this row is OBSERVED TRANSITIONING INTO status=''cancelled'' '
  '(OLD.status was something else and NEW.status is ''cancelled'') — never merely '
  '"the row happens to be cancelled during an update", and never cleared '
  'afterward. Enforced by the SAME trigger that maintains confirmed_at '
  '(event_participants_preserve_confirmed_at, 0173/0174). Only meaningful for the '
  'calendar feed''s "cancelled calendar commitment" determination when '
  'confirmed_at IS ALSO NOT NULL (a row that never passed through ''confirmed'' is '
  'never a calendar commitment regardless of this column). Rows already '
  'status=''cancelled'' before migration 0174 was applied are left NULL — no '
  'authoritative historical evidence of when they were cancelled — and STAY NULL '
  'even across later unrelated updates to the same row; an accepted, documented '
  'limitation.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. get_calendar_feed_rows — subscription baseline + cancellation-
--    timestamp gating + per-row revision_at (LAST-MODIFIED source)
-- ═══════════════════════════════════════════════════════════════════════════
-- Same signature as 0173 (p_token_hash text) — CREATE OR REPLACE preserves
-- the existing service_role-only grant automatically.
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
  -- Unchanged from 0173: the general rolling safety horizon.
  v_candidate_window_start timestamptz := now() - interval '90 days';
  v_candidate_window_end   timestamptz := now() + interval '180 days';
  -- NEW: the subscription baseline. A brand-new token's active-item lower
  -- bound is effectively "now" (no backfill); once the token is older than
  -- 90 days, this reverts to the plain rolling window. Computed AFTER the
  -- token lookup below, since it depends on v_token.created_at.
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

  if v_token.feed_type = 'member_personal' then
    v_roster_member_id := public._roster_member_id_for(v_token.club_id, v_token.profile_id);

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
        --
        -- Three mutually-exclusive inclusion branches:
        --   (a) ACTIVE — a currently-confirmed commitment on a still-
        --       scheduled Event, baseline-adjusted (no backfill).
        --   (b) CANCELLED via whole-Event cancellation — this
        --       participant's row was a genuine commitment
        --       (confirmed_at IS NOT NULL) and the EVENT's own
        --       cancellation happened at/after this token's creation.
        --   (c) CANCELLED via this participant individually leaving/
        --       being removed while the Event stays scheduled — a
        --       genuine commitment whose OWN cancellation happened
        --       at/after this token's creation.
        -- A row that never passed through 'confirmed' (waitlisted/
        -- offered, confirmed_at NULL) matches none of the three branches
        -- and is correctly excluded entirely, regardless of its current
        -- or historical status.
        --
        -- revision_at: events.updated_at, this participant's OWN
        -- event_participants.updated_at (their participation lifecycle),
        -- the max(reservation, court) updated_at across the Event's
        -- currently-linked court reservations (LOCATION source), and — if
        -- this occurrence belongs to a Program — the parent Program's own
        -- updated_at (DESCRIPTION source).
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
        -- Active/cancelled split mirrors the reservation branch exactly,
        -- reusing lesson_requests' OWN pre-existing confirmed_at AND
        -- cancelled_at columns (0069) — no new column needed here.
        -- revision_at: lesson_requests.updated_at, the joined court's
        -- updated_at (LOCATION source), and the counterparty Pro's own
        -- profiles.updated_at (their displayed name is exported as part
        -- of SUMMARY).
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

  else -- pro_lessons
    select coalesce(jsonb_agg(t), '[]'::jsonb) into v_rows
      from (
        -- revision_at: lesson_requests.updated_at, the joined court's
        -- updated_at, and the counterparty Member's own profiles.updated_at
        -- OR roster_members.updated_at (whichever identity resolved the
        -- displayed name) — a no-account Member's roster name edit is
        -- just as feed-visible as a claimed Member's profile name edit.
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
-- this checkpoint). Restoring get_calendar_feed_rows's PRE-0174 body means
-- reverting to 0173's own definition (see that migration's text) via
-- another CREATE OR REPLACE — do not simply DROP FUNCTION, which would
-- also drop the service_role grant that must be re-created identically.
-- ═══════════════════════════════════════════════════════════════════════════
--   -- restore get_calendar_feed_rows to the 0173 body (see 0173's own text)
--   drop trigger if exists events_preserve_cancelled_at on public.events;
--   drop function if exists public._preserve_event_cancelled_at();
--   alter table public.events drop column if exists cancelled_at;
--   alter table public.event_participants drop column if exists cancelled_at;
--   -- restore _preserve_event_participant_confirmed_at to its 0173 body
