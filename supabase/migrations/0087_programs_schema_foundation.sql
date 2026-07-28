-- 0087_programs_schema_foundation.sql
-- Phase 27B1: Programs schema foundation.
--
-- Schema-only checkpoint for recurring Programs (clinics, camps, leagues,
-- etc.). Locked architecture: generated program occurrences ARE events —
-- there is no parallel session/participant/guest/attendance/waitlist/
-- notification system. This migration adds:
--
--   1. programs                 — the parent recurring offering
--   2. program_schedule_rules   — weekly day/time rule(s) belonging to a program
--   3. program_rule_courts      — normalized court assignment per rule
--   4. program_enrollments      — whole-program signup (enrollment_model='program')
--   5. events.program_id / program_schedule_rule_id / program_occurrence_date /
--      is_program_exception     — nullable series metadata on the existing
--                                 events table, plus an idempotency guard
--                                 against duplicate generated occurrences
--
-- Explicitly NOT included in this checkpoint (by design — later checkpoints):
--   • No program_sessions table, no parallel participant/guest/attendance
--     table of any kind. event_participants/event_guests/reservations remain
--     the only tables that ever represent a member/guest/court at a specific
--     occurrence.
--   • No generation RPC (preview_program_sessions / generate_program_sessions).
--   • No enrollment/materialization RPC (enroll_program /
--     withdraw_program_enrollment / admin_remove_program_enrollment).
--   • No cancel_program_from RPC.
--   • No UI.
--   • No existing events/event_participants/event_guests/reservations/
--     notifications table, RLS policy, or RPC body is touched. Every
--     existing standalone-event code path is unaffected: the four new
--     events columns are nullable with no default beyond
--     is_program_exception (false), and the all-or-none check constraint
--     added below guarantees a standalone event (all four NULL/false) is
--     unconditionally valid.
--
-- Permission model: every SELECT policy below is authorized exclusively via
-- current_user_club_id()/current_user_role() (Phase 26B2, redefined in
-- 0082 to derive from club_memberships/active_club_id) — no new policy or
-- constraint in this file reads profiles.club_id, profiles.role,
-- profiles.status, or profiles.is_lesson_provider.
--
-- Direct-write posture: RLS is enabled on all four new tables with SELECT
-- policies only — no INSERT/UPDATE/DELETE policy is defined for any of
-- them, so RLS's default-deny rule blocks every write command outright for
-- every role. This checkpoint additionally hardens the table-privilege
-- layer explicitly (section 7 below), rather than relying on RLS alone:
-- each table gets `revoke all ... from public, anon, authenticated` followed
-- by `grant select ... to authenticated` — authenticated gets SELECT and
-- nothing else (no INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER grant
-- reaches it), anon gets nothing at all. This is a belt-and-suspenders
-- pairing with RLS, not a substitute for it: RLS still independently blocks
-- every write regardless of what the privilege layer allows. Writes arrive
-- exclusively through the SECURITY DEFINER RPCs built in 27B2/27C.
--
-- ATOMICITY: the entire file runs inside one transaction (BEGIN ... COMMIT
-- below). If anything fails, the whole migration rolls back — nothing here
-- installs an exception handler that would swallow a failure and let a
-- partial result commit.
--
-- See supabase/scripts/verify_phase27b1.sql for the full read-only
-- verification pass, and supabase/scripts/QA_phase27b1.md for manual QA
-- steps.
--
-- Apply in Supabase SQL Editor (cloud only). Not applied by this checkpoint.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. programs
-- ═══════════════════════════════════════════════════════════════════════════
-- The parent recurring offering. event_type_id reuses the existing per-club
-- event_types catalog rather than forking a parallel taxonomy (a clinic/
-- camp/league is still just an event_type key).
--
-- default_court_count is intentionally NOT a column here — court count for
-- a program is derived from program_rule_courts (one row per court per
-- rule), which is the authoritative source per the locked architecture.

create table public.programs (
  id                uuid        primary key default gen_random_uuid(),
  club_id           uuid        not null references public.clubs(id) on delete cascade,
  event_type_id     uuid        not null references public.event_types(id),
  title             text        not null,
  description       text,
  enrollment_model  text        not null
                       check (enrollment_model in ('program', 'per_session', 'admin_managed')),
  status            text        not null default 'draft'
                       check (status in ('draft', 'active', 'cancelled', 'completed')),
  starts_on         date        not null,
  ends_on           date        not null,
  default_capacity  int         not null,
  created_by        uuid        not null references public.profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  archived_at       timestamptz,
  archived_by       uuid        references public.profiles(id) on delete set null,

  constraint programs_ends_on_after_starts_on check (ends_on >= starts_on),
  constraint programs_default_capacity_positive check (default_capacity > 0)
);

comment on table public.programs is
  'Parent recurring offering (clinic, camp, league, etc.). Generated '
  'occurrences are rows in the existing events table, linked back via '
  'events.program_id — see 0087 migration header for the full architecture.';

create trigger programs_updated_at
  before update on public.programs
  for each row execute function public.trigger_set_updated_at();

-- Every RLS policy and future RPC scopes by (club_id) and often filters by
-- status/created_by — a single covering index keeps that cheap at any scale
-- this app is likely to reach.
create index programs_club_id_idx
  on public.programs (club_id);

create index programs_created_by_idx
  on public.programs (created_by);


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. program_schedule_rules
-- ═══════════════════════════════════════════════════════════════════════════
-- One or more weekly day/time rules per program (e.g. Tue+Thu clinic = two
-- rows). Shape mirrors the existing operating_hours/pro_availability_windows
-- day_of_week idiom rather than an RRULE string — see the Phase 27
-- architecture lock.
--
-- capacity_override, when set, overrides programs.default_capacity for
-- events generated from this specific rule. It MUST remain null when the
-- owning program's enrollment_model = 'program' (a whole-program enrollee's
-- seat is not scoped to a single rule's capacity) — this is a cross-table
-- rule that cannot be expressed as a plain CHECK constraint on this table
-- alone; it is documented here and will be enforced by the create/update
-- RPCs built in 27B2, not by the database schema in this checkpoint.
--
-- unique (id, program_id) exists solely so events can carry a composite FK
-- (program_schedule_rule_id, program_id) -> (id, program_id) that guarantees
-- a generated event's rule and program never disagree — see section 5.

create table public.program_schedule_rules (
  id                 uuid        primary key default gen_random_uuid(),
  program_id         uuid        not null references public.programs(id) on delete cascade,
  day_of_week        int         not null check (day_of_week between 0 and 6),
  start_time         time        not null,
  duration_minutes   int         not null check (duration_minutes > 0),
  capacity_override  int         check (capacity_override is null or capacity_override > 0),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint program_schedule_rules_id_program_id_unique unique (id, program_id),
  constraint program_schedule_rules_program_day_start_unique
    unique (program_id, day_of_week, start_time)
);

comment on column public.program_schedule_rules.capacity_override is
  'Must remain NULL when the owning program.enrollment_model = ''program''. '
  'Enforced by the create/update RPCs added in Phase 27B2, not by a DB '
  'constraint (requires a cross-table read this table cannot express alone).';

create trigger program_schedule_rules_updated_at
  before update on public.program_schedule_rules
  for each row execute function public.trigger_set_updated_at();

create index program_schedule_rules_program_id_idx
  on public.program_schedule_rules (program_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. program_rule_courts
-- ═══════════════════════════════════════════════════════════════════════════
-- Normalized court assignment per rule — the authoritative source for both
-- "which courts" and "how many courts" a rule's generated events use.
-- Deliberately not a uuid[] column on program_schedule_rules.

create table public.program_rule_courts (
  id                        uuid        primary key default gen_random_uuid(),
  program_schedule_rule_id  uuid        not null references public.program_schedule_rules(id) on delete cascade,
  court_id                  uuid        not null references public.courts(id) on delete cascade,
  created_at                timestamptz not null default now(),

  unique (program_schedule_rule_id, court_id)
);

comment on table public.program_rule_courts is
  'Authoritative court assignment (and court count) per program_schedule_rule. '
  'A court''s club must match the owning program''s club — enforced by the '
  'create/update RPCs added in Phase 27B2, not by a DB constraint (courts '
  'has no composite key exposing club_id for an FK to target).';

create index program_rule_courts_rule_id_idx
  on public.program_rule_courts (program_schedule_rule_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. program_enrollments
-- ═══════════════════════════════════════════════════════════════════════════
-- Whole-program signup, used only when the owning program's
-- enrollment_model = 'program'. Mirrors event_participants' offer/expiry
-- shape (status vocabulary + offer_expires_at) so the eventual promotion/
-- accept/decline RPCs (27C) can reuse the same FIFO offer-window pattern
-- already proven for events (advance_waitlist_offer et al., 0049) — no new
-- state machine is invented here, only its future table.

create table public.program_enrollments (
  id                uuid        primary key default gen_random_uuid(),
  program_id        uuid        not null references public.programs(id) on delete cascade,
  profile_id        uuid        not null references public.profiles(id),
  status            text        not null
                       check (status in ('enrolled', 'waitlisted', 'offered', 'cancelled')),
  offer_expires_at  timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (program_id, profile_id),

  -- offer_expires_at is set if and only if status = 'offered' — matches the
  -- shape event_participants enforces only at the RPC layer (0049); made an
  -- explicit DB constraint here since this table has no equivalent RPC yet
  -- to guard it.
  constraint program_enrollments_offer_expiry_consistency check (
    (status = 'offered' and offer_expires_at is not null)
    or (status <> 'offered' and offer_expires_at is null)
  )
);

create trigger program_enrollments_updated_at
  before update on public.program_enrollments
  for each row execute function public.trigger_set_updated_at();

create index program_enrollments_program_id_idx
  on public.program_enrollments (program_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. events — nullable program-series metadata
-- ═══════════════════════════════════════════════════════════════════════════
-- Purely additive. A standalone event (the only kind that exists today)
-- keeps all four columns at their default (three NULL, is_program_exception
-- false) and remains valid under every constraint added here — no existing
-- event, RPC, or RLS policy changes behavior.

alter table public.events
  add column program_id                uuid references public.programs(id),
  add column program_schedule_rule_id  uuid,
  add column program_occurrence_date   date,
  add column is_program_exception      boolean not null default false;

comment on column public.events.program_occurrence_date is
  'The calendar slot (club-local date) this generated event fulfills. Set '
  'once at generation time and never rewritten by a later edit — an '
  'exception that moves starts_at to a different date keeps its original '
  'occurrence_date so regeneration still treats that slot as filled. NULL '
  'for a standalone (non-program) event.';

comment on column public.events.is_program_exception is
  'True once a generated event has been hand-edited (time/court/capacity/'
  'title). Exception rows are never touched or overwritten by regeneration.';

-- All-or-none linkage, plus is_program_exception tied to the standalone
-- branch:
--   • Standalone event: program_id, program_schedule_rule_id, and
--     program_occurrence_date are all NULL, AND is_program_exception is
--     false. Every event that exists before this migration runs satisfies
--     this — NULL/NULL/NULL/false is exactly today's implicit shape, now
--     made explicit. A standalone event can never be flagged as an
--     exception; exception status only has meaning for a generated
--     occurrence.
--   • Generated program event: program_id, program_schedule_rule_id, and
--     program_occurrence_date are all NOT NULL. is_program_exception may be
--     either false (untouched, regeneration-owned) or true (hand-edited,
--     regeneration-exempt) — both are valid for a linked event.
alter table public.events
  add constraint events_program_linkage_all_or_none check (
    (program_id is null and program_schedule_rule_id is null and program_occurrence_date is null
       and is_program_exception = false)
    or
    (program_id is not null and program_schedule_rule_id is not null and program_occurrence_date is not null)
  );

-- Composite FK: guarantees a generated event's rule always belongs to the
-- same program the event itself is stamped with — a rule can never be
-- attached to an event under the wrong program_id.
alter table public.events
  add constraint events_program_rule_fkey
  foreign key (program_schedule_rule_id, program_id)
  references public.program_schedule_rules (id, program_id);

-- Idempotency guard: at most one event may ever occupy a given
-- (rule, occurrence_date) slot, regardless of that event's status
-- (scheduled/cancelled) or archived_at — a cancelled or archived row still
-- counts as "this slot is filled," so a generation RPC re-run over an
-- overlapping range can never insert a duplicate.
create unique index events_program_slot_unique_idx
  on public.events (program_schedule_rule_id, program_occurrence_date)
  where program_schedule_rule_id is not null;

-- Series listing / regeneration diffing.
create index events_program_id_occurrence_idx
  on public.events (program_id, program_occurrence_date);


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. RLS
-- ═══════════════════════════════════════════════════════════════════════════
-- SELECT-only on all four tables. No INSERT/UPDATE/DELETE policy is added
-- anywhere in this section — writes arrive exclusively through future
-- SECURITY DEFINER RPCs (27B2/27C), exactly as every write to events/
-- event_participants/event_guests already does. Section 7 below adds the
-- matching explicit table-privilege revokes/grants.

alter table public.programs               enable row level security;
alter table public.program_schedule_rules  enable row level security;
alter table public.program_rule_courts     enable row level security;
alter table public.program_enrollments     enable row level security;

-- programs: visible to any member of the same active club — matches
-- events_select_same_club (0004).
create policy "programs_select_same_club"
  on public.programs for select
  using (club_id = public.current_user_club_id());

-- program_schedule_rules: visible if the owning program is in the caller's
-- active club.
create policy "program_schedule_rules_select_same_club"
  on public.program_schedule_rules for select
  using (
    exists (
      select 1 from public.programs pr
      where pr.id = program_schedule_rules.program_id
        and pr.club_id = public.current_user_club_id()
    )
  );

-- program_rule_courts: visible if the owning rule's program is in the
-- caller's active club.
create policy "program_rule_courts_select_same_club"
  on public.program_rule_courts for select
  using (
    exists (
      select 1
      from public.program_schedule_rules psr
      join public.programs pr on pr.id = psr.program_id
      where psr.id = program_rule_courts.program_schedule_rule_id
        and pr.club_id = public.current_user_club_id()
    )
  );

-- program_enrollments: club-scoped first, then row-level visibility —
--   • a member sees only their own enrollment row;
--   • an admin sees every enrollment row in their active club;
--   • a pro sees enrollment rows only for programs they created.
create policy "program_enrollments_select"
  on public.program_enrollments for select
  using (
    exists (
      select 1 from public.programs pr
      where pr.id = program_enrollments.program_id
        and pr.club_id = public.current_user_club_id()
        and (
          program_enrollments.profile_id = auth.uid()
          or public.current_user_role() = 'admin'
          or (public.current_user_role() = 'pro' and pr.created_by = auth.uid())
        )
    )
  );


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. Table privileges
-- ═══════════════════════════════════════════════════════════════════════════
-- Explicit, belt-and-suspenders privilege grants alongside RLS (section 6).
-- For each of the four new tables: revoke every privilege from PUBLIC, anon,
-- and authenticated first, then grant back exactly SELECT to authenticated.
-- End state — authenticated: SELECT only (no INSERT/UPDATE/DELETE/TRUNCATE/
-- REFERENCES/TRIGGER); anon: nothing at all; PUBLIC: nothing at all. Reads
-- are still additionally scoped by the section 6 RLS policies — this section
-- controls which commands are available at all, RLS controls which rows are
-- visible/writable once a command is available. Future SECURITY DEFINER
-- RPCs (27B2/27C) perform all writes and are unaffected by these revokes,
-- since a SECURITY DEFINER function runs as its owner, not as the calling
-- role.

revoke all on public.programs from public, anon, authenticated;
grant select on public.programs to authenticated;

revoke all on public.program_schedule_rules from public, anon, authenticated;
grant select on public.program_schedule_rules to authenticated;

revoke all on public.program_rule_courts from public, anon, authenticated;
grant select on public.program_rule_courts to authenticated;

revoke all on public.program_enrollments from public, anon, authenticated;
grant select on public.program_enrollments to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════════
-- Safe to roll back at any point before 27B2 introduces any RPC or row that
-- references these structures (this checkpoint creates none — every new
-- table is empty and every new events column is NULL/false on every
-- existing row). Run as a single transaction:
--
--   begin;
--
--   drop policy if exists "program_enrollments_select"            on public.program_enrollments;
--   drop policy if exists "program_rule_courts_select_same_club"   on public.program_rule_courts;
--   drop policy if exists "program_schedule_rules_select_same_club" on public.program_schedule_rules;
--   drop policy if exists "programs_select_same_club"              on public.programs;
--
--   drop index if exists public.events_program_id_occurrence_idx;
--   drop index if exists public.events_program_slot_unique_idx;
--   alter table public.events drop constraint if exists events_program_rule_fkey;
--   alter table public.events drop constraint if exists events_program_linkage_all_or_none;
--   alter table public.events drop column if exists is_program_exception;
--   alter table public.events drop column if exists program_occurrence_date;
--   alter table public.events drop column if exists program_schedule_rule_id;
--   alter table public.events drop column if exists program_id;
--
--   drop table if exists public.program_enrollments;
--   drop table if exists public.program_rule_courts;
--   drop table if exists public.program_schedule_rules;
--   drop table if exists public.programs;
--
--   commit;
--
-- Dropping public.programs/public.program_schedule_rules cascades nothing
-- unexpected: program_rule_courts and program_enrollments are both
-- ON DELETE CASCADE from a rule/program respectively, but they are dropped
-- explicitly above regardless, and events' composite FK/columns are dropped
-- first so no event row is ever left pointing at a table mid-removal.
