-- 0129_deprecate_private_lesson_event_type.sql
-- Phase 33G3: deprecate the legacy "Private Lesson" Event type from NEW
-- Event creation, now that Book Lesson (0111/0128) is the canonical Lesson
-- workflow.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Every club's `event_types` table has a per-club seeded row (key='lesson',
-- label='Private Lesson') inserted by bootstrap_new_club at club-creation
-- time (0035, superseded by 0074's CREATE OR REPLACE — the effective
-- version this migration itself supersedes). This is a wholly separate
-- domain from Lesson (lesson_requests/reservations reason='pro_lesson') —
-- an event_types row with key='lesson' has never been read or written by
-- any Lesson-domain code; it only ever produced a plain `events` row like
-- any other event type, with no Pro/negotiation semantics at all. Book
-- Lesson (Phase 33G2) is now the one canonical way to schedule a lesson.
--
-- event_types.is_active already exists (0065) and is already the sole
-- mechanism that gates an event type out of new-Event creation —
-- CreateEventSheet.tsx and EditEventSheet.tsx both already filter
-- `.eq("is_active", true)` when fetching the selectable list, and
-- create_event/update_event already raise 'inactive_event_type' server-side
-- for an inactive type id (0065, checked again independently of the UI
-- filter — this is data-integrity enforcement already in place, not new
-- authorization). Deactivating this one row is therefore the smallest
-- durable deprecation available for keeping it out of new-Event creation:
-- no new column, no new RPC, no UI branch for "hidden but still
-- selectable."
--
-- CORRECTION (same unapplied migration, amended in place — 33G3 final
-- review): merely deactivating is not retirement — is_active is a
-- perfectly ordinary, admin-reversible toggle, and both
-- set_event_type_active (RPC) AND event_types' own RLS
-- (event_types_update_admin, 0065 — permits a direct same-club-admin
-- UPDATE with no other restriction, independent of any RPC) would let an
-- admin reactivate 'lesson' the same way they could reactivate any other
-- deactivated type. Book Lesson is the canonical Lesson workflow now, and
-- this key must not be reactivatable through normal application behavior
-- at all. Section 3 (new) closes this with ONE authoritative guard at the
-- database boundary — a BEFORE INSERT OR UPDATE trigger on event_types
-- itself — rather than only in set_event_type_active, precisely because
-- that RPC is not the only write path RLS permits. This is deliberately a
-- single trigger, not a duplicated check in the RPC too: the trigger's
-- exception already propagates up through set_event_type_active's own
-- UPDATE statement, so callers of that RPC see the exact same
-- 'event_type_retired' error without a second, redundant guard to keep in
-- sync. No new schema column — the retired key ('lesson') is checked
-- directly, the same way EventTypesSection.tsx's frontend already
-- special-cases seeded keys via a hardcoded SEEDED_KEYS set.
--
-- What this migration deliberately does NOT do:
--   - does not delete the event_types row (existing/historical Events'
--     event_type_id foreign key stays valid; label/color continue to
--     resolve exactly as before for any historical "Private Lesson" Event)
--   - does not touch any existing `events` row
--   - does not repurpose the 'lesson' key/row into the Lesson domain
--   - does not change event_types RLS policies themselves, or any other
--     event-type RPC (create_event_type/update_event_type/delete_event_type
--     are untouched — the guard is scoped to the one column transition that
--     matters, is_active becoming true for this one key)
--   - does not add a column, a special "retired" status, or a second
--     lifecycle state — is_active stays a plain boolean; retirement is
--     "is_active can change freely, except this one key can never become
--     true again"
--
-- Sections:
--   1. Deactivate the existing 'lesson' event_types row for every club that
--      currently has it active (idempotent — WHERE is_active = true).
--   2. CREATE OR REPLACE bootstrap_new_club (0074's effective body,
--      reproduced verbatim except the event_types insert, which now
--      explicitly lists is_active and sets it to false only for the
--      'lesson' row) so every NEW club is seeded with this type already
--      inactive, instead of relying on a second post-creation step.
--   3. New BEFORE INSERT OR UPDATE trigger on event_types — the
--      authoritative, un-bypassable guard: rejects any write (via RPC or
--      direct RLS-permitted client UPDATE) that would leave key='lesson'
--      with is_active=true, for any club, now or in the future.

begin;

-- ─── Section 1: deactivate the existing row for every current club ────────

update event_types
   set is_active = false,
       updated_at = now()
 where key = 'lesson'
   and is_active = true;

-- ─── Section 2: bootstrap_new_club — seed 'lesson' as inactive going forward ─

create or replace function public.bootstrap_new_club(
  p_name                       text,
  p_slug                       text,
  p_timezone                   text,
  p_court_count                int,
  p_operator_user_id           uuid,
  p_court_names                text[]  default null,
  p_opens_at                   time    default '08:00',
  p_closes_at                  time    default '20:00',
  p_booking_window_days        int     default 14,
  p_cancellation_window_hours  int     default 24,
  p_cancellation_grace_minutes int     default 5
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reserved    text[] := array[
    'admin', 'api', 'auth', 'join', 'sign-in', 'setup', 'operator',
    'app', 'www', 'mail', 'help', 'support', 'booking', 'dashboard'
  ];
  v_club        clubs%rowtype;
  v_code        text;
  v_dow         int;
  v_i           int;
  v_court_name  text;
begin
  if trim(p_name) is null or char_length(trim(p_name)) < 2 then
    raise exception 'invalid_name: club name must be at least 2 characters';
  end if;

  if char_length(trim(p_name)) > 80 then
    raise exception 'invalid_name: club name must be 80 characters or fewer';
  end if;

  if p_slug is null or p_slug = '' then
    raise exception 'invalid_slug: slug is required';
  end if;

  if p_slug !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' then
    raise exception
      'invalid_slug: slug must contain only lowercase letters, digits, and '
      'hyphens, and must start and end with a letter or digit';
  end if;

  if p_slug = any(v_reserved) then
    raise exception 'invalid_slug: "%" is a reserved slug', p_slug;
  end if;

  if exists (select 1 from clubs where slug = p_slug) then
    raise exception
      'slug_already_exists: a club with slug "%" already exists', p_slug;
  end if;

  if p_court_count is null or p_court_count < 1 or p_court_count > 20 then
    raise exception 'invalid_court_count: court count must be between 1 and 20';
  end if;

  if p_court_names is not null then
    if array_length(p_court_names, 1) is null or
       array_length(p_court_names, 1) <> p_court_count then
      raise exception
        'invalid_court_names: p_court_names must contain exactly % '
        'elements to match p_court_count', p_court_count;
    end if;
  end if;

  if p_closes_at <= p_opens_at then
    raise exception 'invalid_hours: closes_at must be after opens_at';
  end if;

  if p_booking_window_days < 1 or p_booking_window_days > 365 then
    raise exception
      'invalid_booking_window: booking_window_days must be between 1 and 365';
  end if;

  if p_cancellation_window_hours < 0 or p_cancellation_window_hours > 168 then
    raise exception
      'invalid_cancellation_window: cancellation_window_hours must be between 0 and 168';
  end if;

  if p_cancellation_grace_minutes < 0 or p_cancellation_grace_minutes > 60 then
    raise exception
      'invalid_grace_period: cancellation_grace_minutes must be between 0 and 60';
  end if;

  if p_operator_user_id is null then
    raise exception 'invalid_operator_user: p_operator_user_id is required';
  end if;

  if not exists (select 1 from auth.users where id = p_operator_user_id) then
    raise exception
      'invalid_operator_user: user % does not exist in auth.users',
      p_operator_user_id;
  end if;

  insert into clubs (name, slug, timezone, theme_key)
  values (trim(p_name), p_slug, p_timezone, 'graphite')
  returning * into v_club;

  insert into club_settings (
    club_id,
    booking_window_days,
    cancellation_window_hours,
    cancellation_grace_minutes
  ) values (
    v_club.id,
    p_booking_window_days,
    p_cancellation_window_hours,
    p_cancellation_grace_minutes
  );

  for v_i in 1..p_court_count loop
    if p_court_names is not null then
      v_court_name := p_court_names[v_i];
    else
      v_court_name := 'Court ' || v_i::text;
    end if;

    insert into courts (club_id, name, display_order, is_active)
    values (v_club.id, v_court_name, v_i - 1, true);
  end loop;

  for v_dow in 0..6 loop
    insert into operating_hours (club_id, day_of_week, opens_at, closes_at, is_closed)
    values (v_club.id, v_dow, p_opens_at, p_closes_at, false);
  end loop;

  -- Phase 33G3: 'lesson' ("Private Lesson") is seeded inactive from day
  -- one — Book Lesson is the canonical Lesson workflow; this row is kept
  -- (not omitted) only so the club still has a stable event_types row
  -- under this key if ever needed, exactly mirroring what an admin could
  -- already do themselves via /admin/settings for any other type.
  insert into event_types (
    club_id, key, label, color,
    default_capacity, default_duration_minutes, default_court_count,
    shows_participant_names, is_active
  ) values
    (v_club.id, 'lesson',     'Private Lesson', '#3B7DD8',  1,  60, 1, false, false),
    (v_club.id, 'clinic',     'Group Clinic',   '#2E9B5E',  8,  90, 1, false, true),
    (v_club.id, 'social',     'Open Social',    '#E68433', 12, 120, 2, true,  true),
    (v_club.id, 'league',     'League Match',   '#7B4FB5',  4,  90, 1, true,  true),
    (v_club.id, 'tournament', 'Tournament',     '#C44545', 32, 240, 4, true,  true);

  insert into club_invites (club_id, role, email, created_by, expires_at)
  values (v_club.id, 'admin', null, p_operator_user_id, now() + interval '14 days')
  returning code into v_code;

  return jsonb_build_object(
    'club_id',     v_club.id,
    'slug',        v_club.slug,
    'invite_code', v_code
  );
end;
$$;

-- ─── Section 3: retirement guard — event_types can never reactivate 'lesson' ─
--
-- Fires on every INSERT and every UPDATE (not just is_active changes — a
-- cheap check, and simplest to reason about as "always true for this
-- table," rather than trying to scope the trigger to only fire when
-- is_active is part of the changed columns). INSERT is covered too even
-- though create_event_type can never produce key='lesson' today (its key
-- is server-derived from the label, never caller-supplied) — this is the
-- authoritative boundary, so it should not depend on that remaining true.
--
-- Only blocks the one transition that matters: NEW.key = 'lesson' AND
-- NEW.is_active = true. Every other column change (label, color,
-- deactivating it again, any other key's activate/deactivate/edit) is
-- completely unaffected.
create or replace function public.enforce_event_type_lesson_retired()
returns trigger
language plpgsql
as $$
begin
  if new.key = 'lesson' and new.is_active then
    raise exception 'event_type_retired';
  end if;
  return new;
end;
$$;

drop trigger if exists event_types_lesson_retirement_guard on public.event_types;
create trigger event_types_lesson_retirement_guard
  before insert or update on public.event_types
  for each row
  execute function public.enforce_event_type_lesson_retired();

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- Reversing retirement for a specific club (requires dropping the guard
-- first — it is unconditional by design):
--   drop trigger event_types_lesson_retirement_guard on event_types;
--   drop function enforce_event_type_lesson_retired();
--   update event_types set is_active = true where club_id = '<club>' and key = 'lesson';
-- bootstrap_new_club: CREATE OR REPLACE using 0074's body verbatim (drops
-- the explicit is_active column/false value, reverting to the implicit
-- default-true insert for all five seeded types).
