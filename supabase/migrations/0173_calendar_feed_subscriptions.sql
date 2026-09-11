-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 35C — Personal Calendar Subscriptions
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Adds Court Time's FIRST long-lived bearer credential carried in a public
-- URL: an opaque, revocable subscription token that lets a Member or Pro
-- subscribe their personal Court Time schedule into an external calendar
-- app (Apple Calendar, Google Calendar "From URL", etc.), reusing the
-- Phase 35B ICS foundation (src/lib/ics.ts) for serialization.
--
-- CORRECTION PASS 1 (pre-application review, this file never having been
-- applied): five substantive fixes over the first draft, listed here so the
-- per-section comments below don't have to re-explain the "before" state
-- every time:
--   1. REMOVED the separate whole-Program program_enrollments UNION branch.
--      Repository evidence (0091_whole_program_enrollment.sql's
--      _materialize_program_member_into_future_events /
--      _cancel_program_member_future_participation) proves event_participants
--      is ALREADY the sole authoritative occurrence-level source for a
--      whole-Program enrollee — a confirmed whole-Program Member already has
--      a status='confirmed' event_participants row materialized for every
--      applicable future generated Event, and withdrawal already cascades by
--      cancelling only those FUTURE rows, never past ones. Keeping a second
--      branch produced the same event-{id}@court-time.app UID twice. See
--      "Event/Program occurrence model" below.
--   2. event_participants gains confirmed_at (this migration, section 1b) —
--      audited first; no existing durable "was this row ever confirmed"
--      marker was found anywhere in the schema. Without it, a waitlisted or
--      offered row that never became a real commitment and was later
--      cancelled would have been indistinguishable from a genuine confirmed
--      commitment that got cancelled — producing a false STATUS:CANCELLED
--      ghost appointment for something the Member never actually had on
--      their calendar.
--   3. Member Lesson lookup now matches the caller's durable roster identity
--      (OR profile_id), not member_id alone — lesson_requests.member_id is
--      nullable/historical for a staff-created pre-claim Lesson; roster_
--      member_id is the durable identity, exactly like every other domain
--      in this feed already uses.
--   4. get_calendar_feed_rows no longer accepts window-bound parameters at
--      all — at the time this item was written it was the one function
--      granted to `anon` in this codebase (superseded by Correction Pass 4
--      below, which removes that grant entirely), so any parameter it
--      accepted was public input regardless of caller. The candidate
--      window is now derived entirely from the database's own now(),
--      hard-coded to the locked 90-day-back/180-day-forward horizon, with
--      no argument through which a caller could request a wider one.
--   5. token_hash gained a CHECK constraint (exactly 64 lowercase hex
--      characters) — issue_calendar_feed_token already validated this
--      shape in application logic; it is now also a real database
--      invariant, matching this repo's general preference for an explicit
--      DB constraint over trusting application code alone (same reasoning
--      already used for the active-token partial unique index below).
--
-- CORRECTION PASS 2 (still pre-application): four more fixes, found on a
-- second review of the still-unapplied file above:
--   6. Lesson rows now require the SAME confirmed_at-gated lifecycle rule
--      as Event participation (Correction Pass 1 item 2) — reusing the
--      ALREADY-EXISTING lesson_requests.confirmed_at column, not a new
--      marker. Previously `status IN ('confirmed','cancelled')` alone could
--      surface a Lesson that reached 'proposed' (so it had real proposed
--      times) and was then cancelled WITHOUT ever being confirmed, as a
--      false STATUS:CANCELLED ghost. Now: active = status='confirmed';
--      cancelled-commitment = status='cancelled' AND confirmed_at IS NOT
--      NULL; pending/proposed/declined/withdrawn/never-confirmed-cancelled
--      never appear at all. Applies identically to both the Member and Pro
--      branches.
--   7. The candidate historical bound is now exactly 90 days (was 97 —
--      90 + a separate 7-day retention margin). The 7-day cancellation-
--      retention minimum is a FLOOR, not an addition on top of the normal
--      window: 90 days already exceeds it by a wide margin, so the extra
--      7 days only created a mismatch between the database's candidate set
--      and the feed's actual 90-day rendered history, with no correctness
--      benefit. See v_candidate_window_start's own comment below.
--   8. _preserve_event_participant_confirmed_at now fully OWNS
--      confirmed_at — every INSERT/UPDATE explicitly forces it to NULL for
--      any non-'confirmed' status (not merely "leaves it alone if already
--      set"), closing a gap where a future writer could have INSERTed a
--      waitlisted/offered row carrying a caller-supplied confirmed_at that
--      nothing had forced to NULL.
--   9. (Application-layer only, not this file) the conditional-request
--      ETag is now computed from the FINAL rendered feed content (after
--      buildFeedIcsEvents' window/retention decisions), not from the raw
--      SQL candidate rows, and is now a WEAK validator (W/"...") since
--      buildIcsCalendar's DTSTAMP is request-time and would otherwise make
--      two semantically-identical responses byte-differ. See
--      src/app/api/calendar/feed/[token]/route.ts.
--
-- CORRECTION PASS 3 (still pre-application): one execution-order bug found
-- on a third review of the still-unapplied file above:
--   10. Section 1b's confirmed_at BACKFILL now runs BEFORE the trigger is
--       created (previously it ran after). That ordering was a real bug,
--       not cosmetic: once the trigger existed, the backfill's own UPDATE
--       (confirmed_at := created_at, status untouched) would hit the
--       trigger's UPDATE branch with OLD.confirmed_at IS NULL and
--       NEW.status='confirmed' — indistinguishable from a genuine first-
--       time confirmation — so the trigger would have silently overwritten
--       every backfilled row's confirmed_at with now(), contradicting the
--       created_at-based backfill this file's own comments (and the
--       column comment) already claimed. See Section 1b below for the
--       corrected order and the full explanation inline.
--
-- CORRECTION PASS 4 (still pre-application) — SECURITY BOUNDARY FIX, the
-- most significant correction of the four: get_calendar_feed_rows is now
-- service_role ONLY. Passes 1-3 above left it granted to `anon` (and
-- `authenticated`) on the reasoning that the public feed route has no
-- session — true, but that reasoning missed that a stored token_hash
-- value, on its own, would then be a directly usable bearer credential
-- against Supabase's public PostgREST API with nothing more than the
-- public anon key — completely bypassing the reason the raw token is
-- hashed at rest in the first place. Every mention below of
-- get_calendar_feed_rows being "anon-callable" or "the one function
-- granted to anon" describes the NOW-SUPERSEDED design and is retained
-- only as history for why later sections look the way they do — the
-- ACTUAL, final grant is at that function's own GRANT/REVOKE statement
-- near the end of this file. The public HTTP feed is now public
-- exclusively through src/app/api/calendar/feed/[token]/route.ts's use of
-- the existing createPrivilegedClient() (src/lib/supabase/privileged.ts,
-- already used for submit_pilot_inquiry) — never through a direct
-- PostgREST RPC call with any public key. There is now ZERO 35C function
-- reachable by `anon`.
--
-- SECURITY POSTURE (mirrors 0105's pilot_inquiries default-deny pattern,
-- the strongest existing precedent in this codebase for a table that must
-- never be reachable by generic client CRUD):
--   - calendar_feed_tokens: RLS enabled, ZERO policies, all privileges
--     explicitly revoked from public/anon/authenticated. Every read/write
--     goes through a SECURITY DEFINER function below — there is no direct
--     table access from any client role, authenticated or not.
--   - Every function pins `set search_path = public, pg_temp` (the
--     hardened convention established across 0082/0105/0110/0122 — an
--     unpinned search_path on a SECURITY DEFINER function is a privilege-
--     escalation vector via a same-named object earlier in a caller-
--     controlled path).
--   - `_is_active_member_of_club` and `_roster_member_id_for` are private,
--     underscore-prefixed internal helpers (matching the established
--     convention from 0082's `_current_user_active_membership` and
--     0070's `_lesson_check_*` helpers) — EXECUTE revoked from every
--     client role. They are reachable only via a nested call from within
--     another SECURITY DEFINER function, which runs as the function OWNER
--     for privilege-checking purposes — the exact same nested-call pattern
--     `current_club_has_capability` already uses to call the equally
--     zero-grant `club_has_capability` (0122) — never directly callable
--     by any client regardless.
--   - `get_calendar_feed_rows` is service_role ONLY (Correction Pass 4) —
--     NOT granted to `anon` or `authenticated`. It accepts ONLY an opaque
--     token hash — never a window, never a club/profile id — and does
--     EVERYTHING internally: resolves the token, revalidates live role/
--     membership/capability state, and returns only the narrowly-scoped,
--     already-safety-filtered schedule rows for that one token's bound
--     scope, over a horizon it alone controls. The public feed endpoint
--     (GET /api/calendar/feed/[token]) is fetched by external calendar
--     clients with NO Supabase session at all, and reaches this function
--     ONLY through that route's own use of the existing
--     createPrivilegedClient() (src/lib/supabase/privileged.ts,
--     service_role-backed) — never through a direct PostgREST call with
--     any public key. This is deliberate defense against a leaked
--     token_hash value: a hash on its own (e.g. from a database leak) is
--     USELESS against Supabase's public API surface, because no public
--     role can call this function at all — only the raw, high-entropy URL
--     token (never stored anywhere) lets anyone reach real calendar data,
--     and only via this one Next.js route. The calling route never
--     receives a resolved profile_id and then goes on to query other
--     tables with elevated privilege — see that route's own header comment
--     (the privileged client there is used for this ONE RPC call only).
--
-- TOKEN HANDLING: the raw token is generated AND hashed (SHA-256, Node
-- crypto.randomBytes(32) -> 256 bits of entropy) entirely in the
-- application layer (src/lib/calendar/feedToken.ts) — the raw token is
-- NEVER sent to Postgres, not even transiently as a query parameter, and
-- is therefore never at risk of appearing in a SQL log line or
-- pg_stat_statements. Only the 64-lowercase-hex-character SHA-256 digest
-- ever reaches this table or these functions, and the table itself now
-- enforces that shape via a CHECK constraint.
--
-- SCOPE BINDING: a token row is permanently bound to (club_id, profile_id,
-- feed_type) at creation. It is NEVER re-derived from a caller's current
-- "active club" pointer (profiles.active_club_id / current_user_club_id())
-- at fetch time — an existing subscription URL must not silently change
-- clubs or stop working merely because the user later switches their
-- active club in a multi-club UI. Live revalidation instead checks
-- whether the TOKEN'S OWN bound (club_id, profile_id) still has a valid,
-- active, correctly-roled club_memberships row — see
-- `_is_active_member_of_club` below, which is deliberately NOT
-- `current_user_club_id()`/`_current_user_active_membership()` (both of
-- which are single-active-club, session-bound concepts that do not apply
-- here — the public feed route has no session at all, and even the
-- authenticated issue/revoke paths must not let an active-club switch
-- retroactively invalidate a token whose OWN club_id was fixed at issuance,
-- except insofar as the membership in that specific club has genuinely
-- ended or the club's own capability has genuinely changed).
--
-- Apply in Supabase SQL Editor (cloud only). Idempotent — safe to rerun
-- after a partial failure (create table if not exists; every function is
-- create or replace; the trigger drop-then-create guards re-application).
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1a. calendar_feed_tokens
-- ═══════════════════════════════════════════════════════════════════════════
-- feed_type is a narrow, closed allowlist (not an open-ended mechanism):
--   member_personal — a Member's own reservations/Event participation
--                      (standalone, per-session, and whole-Program
--                      materialized alike)/confirmed Lessons.
--   pro_lessons      — a Pro's own confirmed Lessons only.
-- No expires_at (intentionally long-lived until revoked). No last_used_at
-- (a write on every external-calendar poll is unnecessary write
-- amplification this checkpoint does not need). Soft revocation only —
-- regenerating NEVER deletes the prior row, matching club_invites'
-- established revoked_at convention.
create table if not exists public.calendar_feed_tokens (
  id         uuid        primary key default gen_random_uuid(),
  club_id    uuid        not null references public.clubs(id) on delete cascade,
  profile_id uuid        not null references public.profiles(id) on delete cascade,
  feed_type  text        not null check (feed_type in ('member_personal', 'pro_lessons')),
  -- Correction pass: a real database invariant, not merely an application-
  -- layer check — a SHA-256 hex digest is always exactly 64 lowercase hex
  -- characters. issue_calendar_feed_token validates the identical shape
  -- before ever reaching this INSERT, so this constraint is defense in
  -- depth, not the only place the rule is enforced.
  token_hash text        not null check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

comment on table public.calendar_feed_tokens is
  'Phase 35C — opaque, revocable personal calendar subscription credentials. '
  'Only a SHA-256 hash of the token is ever stored (hashed and generated '
  'application-side — the raw token never reaches Postgres). Default-deny '
  'RLS; every read/write goes through a SECURITY DEFINER function.';

-- Defensive uniqueness on the hash itself — a collision is cryptographically
-- infeasible (256 bits of entropy) but costs nothing to also enforce at the
-- database layer, matching this repo's general preference for an explicit
-- DB constraint over trusting application code alone.
create unique index if not exists calendar_feed_tokens_token_hash_idx
  on public.calendar_feed_tokens (token_hash);

-- LOCKED: at most one ACTIVE token per (club, profile, feed type). A
-- regenerate soft-revokes the prior row (revoked_at set) before inserting
-- the new one, so this partial unique index is never violated by the
-- normal issue/regenerate flow — it exists to make that invariant a real
-- database guarantee, not merely an application-level convention.
create unique index if not exists calendar_feed_tokens_active_scope_idx
  on public.calendar_feed_tokens (club_id, profile_id, feed_type)
  where revoked_at is null;

create index if not exists calendar_feed_tokens_profile_idx
  on public.calendar_feed_tokens (profile_id);

alter table public.calendar_feed_tokens enable row level security;

-- Default-deny: zero RLS policies (mirrors 0105_pilot_inquiries.sql's own
-- table posture) plus an explicit blanket revoke — no client role, session
-- or not, may ever read or write this table directly.
revoke all on table public.calendar_feed_tokens from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 1b. event_participants.confirmed_at — minimal lifecycle foundation
-- ═══════════════════════════════════════════════════════════════════════════
-- AUDIT RESULT: no existing durable "was this participant row ever
-- confirmed" marker exists anywhere in the schema. attendance_status
-- (0117) records post-event attended/no-show outcomes for a row that is
-- ALREADY confirmed — a different question. offer_expires_at (0049) is
-- waitlist-offer-specific and is cleared, not preserved, on transition.
-- Neither can stand in for this.
--
-- Semantics (enforced by the trigger below, not by any individual RPC):
--   - INSERT with status='confirmed': confirmed_at set to now() if null.
--   - transition from any non-confirmed status -> confirmed: confirmed_at
--     set to now() if still null.
--   - once set, NEVER cleared by any subsequent write, regardless of what
--     status later becomes (cancelled/waitlisted/offered/anything else).
-- One narrow trigger on event_participants itself means every existing and
-- future writer (join_event, leave_event, admin remove/add, the whole-
-- Program materialize/cancel helpers, waitlist offer advance/accept/
-- decline, etc.) automatically preserves the invariant with no RPC-by-RPC
-- change required.
alter table public.event_participants
  add column if not exists confirmed_at timestamptz;

-- Correction pass (3rd) — EXECUTION ORDER FIX: this backfill now runs
-- BEFORE the trigger below is created (previously it ran after, which was
-- a real bug: once the trigger existed, this exact UPDATE — which changes
-- confirmed_at but leaves status untouched — would have hit the trigger's
-- UPDATE branch with OLD.confirmed_at IS NULL and NEW.status='confirmed',
-- indistinguishable from a genuine first-time confirmation, so the trigger
-- would have silently overwritten created_at with now() on every row this
-- statement touched, contradicting the very backfill semantics documented
-- below and in the column comment). Backfilling first, with no trigger
-- yet in existence to intercept it, is what actually makes created_at the
-- stored value for these rows.
--
-- Backfill: a row that is CURRENTLY status='confirmed' was, by definition,
-- confirmed at some point no later than its own created_at could not
-- precede — created_at is therefore the safest available lower-bound
-- timestamp evidence in the repository for "when might this have been
-- confirmed" (updated_at is NOT used: it can reflect any later, unrelated
-- update — e.g. a price change — and would misrepresent a confirmation
-- moment that may never have coincided with it). The exact value is not
-- load-bearing for feed correctness (only IS NOT NULL is ever checked) —
-- created_at is simply the most honest non-null value available.
-- Already-cancelled/waitlisted/offered historical rows are deliberately
-- LEFT NULL — there is no authoritative evidence in this repository that
-- any specific one of them was ever confirmed, and guessing would risk
-- exactly the false-ghost-cancellation problem this column exists to
-- prevent. This is an accepted, documented limitation: a participation
-- row cancelled before this migration was applied will never surface as a
-- cancelled calendar commitment even if it genuinely once was confirmed —
-- only rows written (or already status='confirmed') at the moment this
-- migration runs, and everything from that point forward via the trigger
-- created below, are guaranteed correct.
update public.event_participants
   set confirmed_at = created_at
 where status = 'confirmed'
   and confirmed_at is null;

-- Correction pass (2nd): the trigger, created only AFTER the backfill
-- above has already run, fully OWNS this derived field going forward —
-- not merely "preserves" it once set — every INSERT/UPDATE explicitly
-- forces confirmed_at to the correct value for the row's OWN incoming
-- status, including forcing it back to NULL for any non-confirmed status.
-- This closes a gap in an earlier draft where a future writer could still
-- INSERT a waitlisted/offered row carrying a caller-supplied confirmed_at
-- value (nothing forced it to NULL on that path) — which would have let
-- such a row later masquerade as a genuine cancelled calendar commitment
-- if its status ever became 'cancelled'.
create or replace function public._preserve_event_participant_confirmed_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'confirmed' then
      new.confirmed_at := coalesce(new.confirmed_at, now());
    else
      new.confirmed_at := null;
    end if;
  elsif tg_op = 'UPDATE' then
    if old.confirmed_at is not null then
      -- Never clear an already-set confirmed_at, regardless of what any
      -- writer's UPDATE statement attempts to set it to or what status
      -- the row is transitioning to.
      new.confirmed_at := old.confirmed_at;
    elsif new.status = 'confirmed' then
      new.confirmed_at := now();
    else
      new.confirmed_at := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists event_participants_preserve_confirmed_at on public.event_participants;
create trigger event_participants_preserve_confirmed_at
  before insert or update on public.event_participants
  for each row execute function public._preserve_event_participant_confirmed_at();

comment on column public.event_participants.confirmed_at is
  'Set the first time this row is observed transitioning to status=''confirmed'' '
  '(or created directly as confirmed); never cleared afterward, regardless of '
  'later status changes — enforced entirely by the event_participants_preserve_'
  'confirmed_at trigger, not by any individual RPC. Rows already status=''confirmed'' '
  'at the moment migration 0173 was applied were backfilled (BEFORE the trigger '
  'existed) from created_at, because no historically exact confirmation timestamp '
  'exists for them — the exact value is not load-bearing for feed/calendar '
  'correctness, which only ever checks IS NOT NULL, never the timestamp''s '
  'precision. A row whose status has never been ''confirmed'' always has '
  'confirmed_at NULL, by trigger construction.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Private internal helpers (zero external grants)
-- ═══════════════════════════════════════════════════════════════════════════

-- Whether p_profile_id currently holds an ACTIVE, correctly-roled
-- club_memberships row in p_club_id — evaluated directly against that
-- specific (club, profile) pair, deliberately independent of whichever
-- club the profile currently has marked "active" elsewhere in the app
-- (see the migration header for why a feed token must not be sensitive to
-- that unrelated pointer).
create or replace function public._is_active_member_of_club(
  p_club_id    uuid,
  p_profile_id uuid,
  p_role       text
)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.club_memberships cm
     where cm.club_id    = p_club_id
       and cm.user_id    = p_profile_id
       and cm.role       = p_role
       and cm.status     = 'active'
       and cm.removed_at is null
  );
$$;

revoke execute on function public._is_active_member_of_club(uuid, uuid, text)
  from public, anon, authenticated;

-- The given profile's own durable roster identity in the given club, or
-- NULL if the profile has never claimed one — same predicate as
-- 0110's current_user_roster_member_id(), generalized to an arbitrary
-- (club, profile) pair since this is called from contexts (the public feed
-- RPC) with no auth.uid() session at all.
create or replace function public._roster_member_id_for(
  p_club_id    uuid,
  p_profile_id uuid
)
returns uuid
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select id
    from public.roster_members
   where club_id    = p_club_id
     and claimed_by = p_profile_id;
$$;

revoke execute on function public._roster_member_id_for(uuid, uuid)
  from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. issue_calendar_feed_token — CREATE and REGENERATE are the SAME
--    operation (revoke-then-insert), so one function serves both.
-- ═══════════════════════════════════════════════════════════════════════════
-- The caller's application layer generates the raw token and its SHA-256
-- hash BEFORE calling this function, and returns the raw token to the
-- browser itself — this function only ever sees and stores the hash.
-- Authenticated only. Validates the caller's CURRENT session identity
-- (current_user_club_id()/current_user_role() — correct here, unlike the
-- public feed RPC, because this call genuinely has a live session) against
-- the requested feed type, atomically revokes any existing active token
-- for this exact (club, profile, feed_type), and stores the new hash.
create or replace function public.issue_calendar_feed_token(
  p_feed_type        text,
  p_token_hash       text,
  p_expected_club_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id        uuid := public.current_user_club_id();
  v_role           text := public.current_user_role();
  v_replaced_count int;
  v_id             uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if v_club_id is null   then raise exception 'no_active_club';   end if;

  -- Stale-club UI guard — same idiom as 0110's update_member_reservation
  -- (p_expected_club_id vs current_user_club_id()). Not itself the
  -- security boundary (that's v_club_id, derived server-side above) — a
  -- safety net against issuing a token bound to a club the client's UI
  -- was showing stale data for.
  if p_expected_club_id is distinct from v_club_id then
    raise exception 'stale_club_context';
  end if;

  -- Correction pass: matches the table's own CHECK constraint exactly
  -- (64 lowercase hex characters), not merely a length check — this
  -- function is the only INSERT path, so this is the first line of
  -- defense; the table CHECK is the second, independent of this code path
  -- ever running correctly.
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_token_hash';
  end if;

  if p_feed_type = 'member_personal' then
    if v_role <> 'member' then raise exception 'insufficient_role'; end if;
    -- LOCKED: revalidated at issuance AND on every subsequent fetch — a
    -- Staff-Managed club's Member may never issue a personal feed.
    if not public.club_has_capability(v_club_id, 'member_self_service') then
      raise exception 'capability_not_available';
    end if;
  elsif p_feed_type = 'pro_lessons' then
    if v_role <> 'pro' then raise exception 'insufficient_role'; end if;
  else
    raise exception 'invalid_feed_type';
  end if;

  update public.calendar_feed_tokens
     set revoked_at = now()
   where club_id    = v_club_id
     and profile_id = auth.uid()
     and feed_type  = p_feed_type
     and revoked_at is null;
  get diagnostics v_replaced_count = row_count;

  insert into public.calendar_feed_tokens (club_id, profile_id, feed_type, token_hash)
  values (v_club_id, auth.uid(), p_feed_type, p_token_hash)
  returning id into v_id;

  -- Audit metadata carries feed_type and whether this replaced an existing
  -- token — never the hash, never anything from which the raw token or
  -- hash could be reconstructed.
  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'calendar_feed_token_issued', 'calendar_feed_token', v_id,
    jsonb_build_object('feed_type', p_feed_type, 'replaced_existing', v_replaced_count > 0)
  );
end;
$$;

revoke execute on function public.issue_calendar_feed_token(text, text, uuid)
  from public, anon;
grant  execute on function public.issue_calendar_feed_token(text, text, uuid)
  to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. revoke_calendar_feed_token
-- ═══════════════════════════════════════════════════════════════════════════
-- A user may revoke ONLY their own feed for their own current club/feed
-- type — no Admin-on-behalf-of-another-user path exists in 35C. Raises
-- 'no_active_token' if there is nothing to revoke (this is only ever
-- called from a UI state that already believes a token is active).
create or replace function public.revoke_calendar_feed_token(
  p_feed_type        text,
  p_expected_club_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid := public.current_user_club_id();
  v_count   int;
  v_id      uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if v_club_id is null   then raise exception 'no_active_club';   end if;
  if p_expected_club_id is distinct from v_club_id then
    raise exception 'stale_club_context';
  end if;

  update public.calendar_feed_tokens
     set revoked_at = now()
   where club_id    = v_club_id
     and profile_id = auth.uid()
     and feed_type  = p_feed_type
     and revoked_at is null
  returning id into v_id;

  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'no_active_token';
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'calendar_feed_token_revoked', 'calendar_feed_token', v_id,
    jsonb_build_object('feed_type', p_feed_type)
  );
end;
$$;

revoke execute on function public.revoke_calendar_feed_token(text, uuid)
  from public, anon;
grant  execute on function public.revoke_calendar_feed_token(text, uuid)
  to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. has_active_calendar_feed_token
-- ═══════════════════════════════════════════════════════════════════════════
-- Lets the Profile UX show "Calendar subscription active" after a page
-- refresh WITHOUT ever being able to redisplay the raw URL (which is never
-- stored anywhere, by design — see the migration header).
create or replace function public.has_active_calendar_feed_token(p_feed_type text)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.calendar_feed_tokens
     where club_id    = public.current_user_club_id()
       and profile_id = auth.uid()
       and feed_type  = p_feed_type
       and revoked_at is null
  );
$$;

revoke execute on function public.has_active_calendar_feed_token(text)
  from public, anon;
grant  execute on function public.has_active_calendar_feed_token(text)
  to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. get_calendar_feed_rows — the single feed-serving entry point,
--    service_role ONLY (Correction Pass 4 — see that pass's own note near
--    the top of this file for why the grant changed from anon)
-- ═══════════════════════════════════════════════════════════════════════════
-- Accepts ONLY the token hash — no window parameters at all. Even though
-- this function is no longer reachable by anon/authenticated at all, the
-- window bound is still hard-coded here rather than parameterized: a
-- future change to its grants must not silently become a way to request
-- an unbounded multi-year feed merely because a parameter existed for it.
-- The candidate window is computed entirely from the database's own
-- now(), hard-coded to the locked 90-day-back/180-day-forward horizon (no
-- separate retention margin — see the v_candidate_window_start
-- declaration below for why 90 days already exceeds the 7-day
-- cancellation-retention floor) — there is no argument through which any
-- caller could widen it.
--
-- Returns NULL for ANY invalid state (unknown/malformed/revoked token, or
-- a currently-unauthorized token — role changed, membership ended,
-- capability downgraded) — the calling route maps NULL to a generic 404
-- indistinguishable from "token never existed". Returns a non-null jsonb
-- object (with a possibly EMPTY "rows" array) for a valid, currently-
-- authorized token — an empty personal schedule is a normal state, never
-- conflated with an invalid token.
--
-- Event/Program occurrence model (correction pass): a generated Program
-- occurrence IS an events row, and event_participants is the SOLE
-- occurrence-level source for standalone Event participation, per-session
-- Program participation, AND whole-Program materialized participation
-- alike — there is no second UNION branch for program_enrollments. See
-- 0091_whole_program_enrollment.sql's _materialize_program_member_into_
-- future_events / _cancel_program_member_future_participation: a confirmed
-- whole-Program enrollee already has a status='confirmed' event_
-- participants row materialized for every applicable future generated
-- Event, and withdrawal already cascades by cancelling only those FUTURE
-- rows — a past, already-occurred occurrence's event_participants row is
-- never touched by that cascade, so it correctly stays exactly as it was
-- (never retroactively becomes a false cancellation).
--
-- is_cancelled derivation:
--   reservation — status = 'cancelled' (the row's own, single status).
--   event       — events.status = 'cancelled' (the whole Event was called
--                 off), OR the participant's own row is status='cancelled'
--                 AND confirmed_at IS NOT NULL (a genuine, previously-real
--                 commitment that was withdrawn/removed — see the
--                 event_participants.confirmed_at foundation above).
--                 A row that is status='cancelled' with confirmed_at NULL
--                 (a waitlisted/offered entry that never became a real
--                 commitment) never appears in the result set at all — see
--                 the WHERE clause below, which is the actual enforcement
--                 point, not merely this comment.
--   lesson      — status = 'cancelled' (and, per the WHERE clause, only
--                 ever reachable there with confirmed_at IS NOT NULL — see
--                 Correction Pass 2 item 6). A Lesson cancelled before ever
--                 being confirmed (e.g. proposed then declined/cancelled)
--                 never appears in the result set at all.
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
  -- Locked horizon, computed from the database's own clock only — no
  -- caller-supplied value is ever involved. Correction pass (3rd): the
  -- historical bound is exactly 90 days, matching the normal rendered
  -- history — NOT 90+7. The locked 7-day cancellation-retention minimum
  -- is a floor, not an addition: 90 days already exceeds it by a wide
  -- margin, so widening the SQL candidate window further only created a
  -- mismatch between what the database considered a candidate and what
  -- the 90-day rendered feed actually shows, with no corresponding
  -- benefit — a cancelled item's ends_at within the last 90 days is
  -- already comfortably within (and typically far past) its 7-day
  -- minimum retention. The precise per-row retention decision is made in
  -- TypeScript (src/lib/calendar/feed.ts), unit-tested against fixed
  -- dates — this function's own job is authorization + a safely bounded
  -- candidate set at the SAME horizon as what is actually rendered, not
  -- the final per-row arithmetic.
  v_candidate_window_start timestamptz := now() - interval '90 days';
  v_candidate_window_end   timestamptz := now() + interval '180 days';
begin
  select * into v_token
    from public.calendar_feed_tokens
   where token_hash = p_token_hash
     and revoked_at is null;

  if not found then
    return null;
  end if;

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
        -- own court reservations
        select
          'reservation'::text as domain, r.id, r.starts_at, r.ends_at,
          (r.status = 'cancelled')      as is_cancelled,
          null::text                    as title,
          c.name                        as court_name,
          null::text                    as description,
          null::text                    as counterparty_name
        from public.reservations r
        join public.courts c on c.id = r.court_id
        where r.club_id = v_token.club_id
          and r.reason  = 'member_booking'
          and r.status in ('confirmed', 'cancelled')
          and (
            r.owner_user_id = v_token.profile_id
            or (v_roster_member_id is not null and r.roster_member_id = v_roster_member_id)
          )
          and r.ends_at   >= v_candidate_window_start
          and r.starts_at <= v_candidate_window_end

        union all

        -- Event participation — the ONE occurrence-level source for
        -- standalone Events, per-session Program occurrences, AND
        -- whole-Program materialized occurrences alike (see this
        -- function's own header for the repository evidence). A row is a
        -- candidate only if it is currently a genuine commitment
        -- (status='confirmed') or was a genuine commitment that was
        -- later withdrawn (status='cancelled' AND confirmed_at IS NOT
        -- NULL) — a waitlisted/offered row, or a cancelled row that never
        -- passed through 'confirmed', matches neither branch and is
        -- correctly excluded entirely.
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
          null::text
        from public.event_participants ep
        join public.events e on e.id = ep.event_id
        where e.club_id = v_token.club_id
          and (
            ep.status = 'confirmed'
            or (ep.status = 'cancelled' and ep.confirmed_at is not null)
          )
          and (
            ep.profile_id = v_token.profile_id
            or (v_roster_member_id is not null and ep.roster_member_id = v_roster_member_id)
          )
          and e.ends_at   >= v_candidate_window_start
          and e.starts_at <= v_candidate_window_end

        union all

        -- Lessons (Member side) — durable identity: matches the caller's
        -- own profile_id OR their own current roster_member_id, exactly
        -- like the reservation branch above. member_id is nullable/
        -- historical for a staff-created pre-claim Lesson; roster_
        -- member_id is the durable identity a claimed Member's Lesson
        -- resolves through even when member_id was never backfilled.
        -- Correction pass (2nd): same confirmed_at-gated lifecycle rule as
        -- the Event branch above, reusing lesson_requests' OWN pre-
        -- existing confirmed_at column — a Lesson that reached 'proposed'
        -- (and so has real proposed times) and was cancelled WITHOUT ever
        -- being confirmed must never surface as a false STATUS:CANCELLED
        -- ghost. pending/proposed/declined/withdrawn are excluded by
        -- construction (neither branch of the OR below matches them).
        select
          'lesson'::text, l.id, l.proposed_starts_at, l.proposed_ends_at,
          (l.status = 'cancelled'),
          null::text, co.name, l.member_note,
          coalesce(nullif(trim(concat_ws(' ', pp.first_name, pp.last_name)), ''), 'Court Time Member')
        from public.lesson_requests l
        left join public.courts co on co.id = l.proposed_court_id
        left join public.profiles pp on pp.id = l.pro_id
        where l.club_id = v_token.club_id
          and (
            l.member_id = v_token.profile_id
            or (v_roster_member_id is not null and l.roster_member_id = v_roster_member_id)
          )
          and (
            l.status = 'confirmed'
            or (l.status = 'cancelled' and l.confirmed_at is not null)
          )
          and l.proposed_starts_at is not null
          and l.proposed_ends_at   is not null
          and l.proposed_ends_at   >= v_candidate_window_start
          and l.proposed_starts_at <= v_candidate_window_end
      ) t;

  else -- pro_lessons
    select coalesce(jsonb_agg(t), '[]'::jsonb) into v_rows
      from (
        select
          'lesson'::text as domain, l.id, l.proposed_starts_at as starts_at, l.proposed_ends_at as ends_at,
          (l.status = 'cancelled') as is_cancelled,
          null::text as title, co.name as court_name, l.member_note as description,
          coalesce(
            nullif(trim(concat_ws(' ', mp.first_name, mp.last_name)), ''),
            nullif(trim(concat_ws(' ', rm.first_name, rm.last_name)), ''),
            'Court Time Member'
          ) as counterparty_name
        from public.lesson_requests l
        left join public.courts co on co.id = l.proposed_court_id
        left join public.profiles mp on mp.id = l.member_id
        left join public.roster_members rm on rm.id = l.roster_member_id
        where l.club_id = v_token.club_id
          and l.pro_id  = v_token.profile_id
          -- Correction pass (2nd): same confirmed_at-gated rule as the
          -- Member branch above — identical lifecycle regardless of which
          -- of the two Lesson parties is fetching.
          and (
            l.status = 'confirmed'
            or (l.status = 'cancelled' and l.confirmed_at is not null)
          )
          and l.proposed_starts_at is not null
          and l.proposed_ends_at   is not null
          and l.proposed_ends_at   >= v_candidate_window_start
          and l.proposed_starts_at <= v_candidate_window_end
      ) t;
  end if;

  return jsonb_build_object('feed_type', v_token.feed_type, 'rows', v_rows);
end;
$$;

-- Correction pass (4th) — SECURITY BOUNDARY FIX: NOT anon/authenticated
-- callable. A stored token_hash, on its own, must never be a usable
-- bearer credential against Supabase's public PostgREST API — anyone who
-- ever obtained a token_hash value (e.g. a database leak, a backup, a log
-- line despite every effort to avoid one) would otherwise be able to call
-- this RPC directly with the public anon key and retrieve calendar data
-- WITHOUT ever needing the original raw URL token, defeating the entire
-- point of hashing it at rest. service_role only — reachable exclusively
-- through src/app/api/calendar/feed/[token]/route.ts's own use of
-- createPrivilegedClient() (src/lib/supabase/privileged.ts, the SAME
-- existing backend-only client already used for submit_pilot_inquiry),
-- never through a direct client-side Supabase call with any public key.
-- The public HTTP feed is public through that Next.js route alone, not
-- through direct RPC access — there is now ZERO 35C function reachable by
-- `anon` in this codebase (a correction from Correction Pass 1's original,
-- now-superseded, "the ONE function granted to anon" design).
revoke execute on function public.get_calendar_feed_rows(text)
  from public, anon, authenticated;
grant  execute on function public.get_calendar_feed_rows(text)
  to service_role;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
--   drop function if exists public.get_calendar_feed_rows(text);
--   drop function if exists public.has_active_calendar_feed_token(text);
--   drop function if exists public.revoke_calendar_feed_token(text, uuid);
--   drop function if exists public.issue_calendar_feed_token(text, text, uuid);
--   drop function if exists public._roster_member_id_for(uuid, uuid);
--   drop function if exists public._is_active_member_of_club(uuid, uuid, text);
--   drop table if exists public.calendar_feed_tokens;
--   drop trigger if exists event_participants_preserve_confirmed_at on public.event_participants;
--   drop function if exists public._preserve_event_participant_confirmed_at();
--   alter table public.event_participants drop column if exists confirmed_at;
