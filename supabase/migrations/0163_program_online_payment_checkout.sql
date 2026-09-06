-- 0163_program_online_payment_checkout.sql
-- Phase 34F-C — Programs Online Payment Expansion.
--
-- Locked product model (approved audit + delta audit, this checkpoint):
--   * applies ONLY to programs.enrollment_model = 'program' (whole-program
--     enrollment). 'per_session' programs already have full Member Pay Now
--     via 34F-B's Event Checkout (each generated session is priced/paid as
--     an ordinary Event); 'admin_managed' programs have no Member self-
--     service path at all. Neither gets any new code here.
--   * payment domain_type = 'program_enrollment', domain_id =
--     program_enrollments.id (NOT program_id) — one row per (Member,
--     Program), matching the fact that whole-program enrollment is ONE
--     purchase for the entire series. Generated session Events remain
--     unpriced for whole-program enrollees (0142) — untouched here.
--   * waitlisted/offered participants never have an obligation and are
--     never eligible for Checkout (0144, untouched).
--   * eligibility ALLOWLIST (delta-audit correction — NOT the broader
--     "status <> 'cancelled'" predicate): programs.status IN ('active',
--     'completed') AND archived_at IS NULL. Active is payable; completed
--     remains legitimately collectible (the Member's debt survives the
--     program running its course, exactly like an already-occurred, still-
--     unpaid Reservation/Lesson/Event remains payable — Court Time has
--     never treated "it already happened" as a reason to block payment,
--     only actual cancellation does that); cancelled and draft are never
--     payable; archived is never payable while archived_at is set
--     (archive can only follow cancelled/completed in the first place, per
--     archive_program's own precondition — see below).
--   * capacity is secured before payment (join_program/accept_program_
--     waitlist_offer, 0144, untouched) — Stripe Checkout is never a seat-
--     reservation system. No payment timeout/automatic release is added.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY complete_program / unarchive_program ARE NOT TOUCHED, AND WHY
-- archive_program MUST BE (correction round — the original delta audit's
-- conclusion that archive_program needed no guard was wrong)
-- ═══════════════════════════════════════════════════════════════════════════
-- complete_program: a pure programs.status flip (active -> completed) —
-- it never reads or writes program_enrollments, payments, or any generated
-- events/reservations row. An enrolled Member's unpaid obligation and any
-- open Checkout attempt can genuinely coexist with completion, and that is
-- CORRECT: completion means the program ran its course, not that the
-- commitment is void, so the debt remains fully legitimate and must stay
-- collectible — this is exactly why the eligibility allowlist above
-- includes 'completed'. No guard is added because guarding would
-- incorrectly block a legitimate payment, not because a guard would be a
-- no-op.
--
-- archive_program: requires status IN ('cancelled', 'completed') as a hard
-- precondition (program_not_archivable otherwise) — an active program can
-- never be archived directly. The ORIGINAL reasoning here claimed this
-- meant archive_program could never be the first opportunity to invalidate
-- anything, since the program must have already passed through either
-- cancel_program (guarded) or complete_program (deliberately unguarded).
-- That reasoning is correct for the cancelled branch but WRONG for the
-- completed branch: complete_program is deliberately unguarded BECAUSE an
-- open Checkout must survive completion — which means a completed Program
-- can reach archive_program still carrying a live, bound, payable Stripe
-- Session that NOTHING has ever invalidated. Once archived, get_program_
-- payment_for_checkout's own eligibility (archived_at IS NULL) makes new
-- Pay Now unavailable — but the OLD remote Session was opened before
-- archiving and is not retroactively affected by a local archived_at flip.
-- archive_program is therefore the first (and only) lifecycle mutation on
-- the completed branch that can invalidate a still-open Checkout, and now
-- carries the identical fan-out guard cancel_program already established
-- (see the new section below). On the cancelled branch this guard is
-- harmless/no-op, since cancel_program's own guard already resolved every
-- blocking Checkout as a precondition of that cancellation succeeding.
--
-- unarchive_program only ever clears archived_at/archived_by — it never
-- restores status to 'active'. Un-archiving a 'completed' program
-- correctly restores get_program_payment_for_checkout's own eligibility
-- (archived_at IS NULL becomes true again, status remains 'completed',
-- still in the allowlist) — a FRESH Checkout may be opened through the
-- normal Program Checkout machinery if eligibility returns; the old,
-- already-archived Session is never resurrected (archive_program's own new
-- guard already invalidated/flagged it, and unarchive_program has no logic
-- to re-bind or reopen a specific prior attempt). Un-archiving a
-- 'cancelled' program does NOT restore eligibility, because status remains
-- 'cancelled' regardless of archived_at. Both outcomes are exactly the
-- locked behavior — no code change needed to achieve either, since
-- eligibility depends only on status + archived_at, and unarchive_program
-- never touches status.
--
-- Because complete_program and unarchive_program need no change, neither
-- is redefined by this migration. archive_program IS redefined — see its
-- own guarded section below.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY generated session Events (update_event / cancel_event) ARE NOT
-- TOUCHED
-- ═══════════════════════════════════════════════════════════════════════════
-- _materialize_program_member_into_future_events (0113, untouched) inserts/
-- updates event_participants rows for a whole-program enrollee directly —
-- never via join_event, and never with a price or payment obligation
-- attached (per 0142's own documented per-domain pricing split: the series
-- is priced once, at the enrollment level; pricing generated sessions again
-- would double-charge). A whole-program enrollee's session-level
-- event_participants rows therefore carry no financial data at all, so
-- 0161's own update_event/cancel_event guards (unmodified, and this
-- migration does not touch 0161) have nothing Program-relevant to ever
-- find or invalidate. One session's court/time change, or even that one
-- session's outright cancellation, is financially inert for whole-program
-- enrollees by construction — never a reason to invalidate the Program-
-- level Checkout.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY set_program_price (0142) IS NOT TOUCHED
-- ═══════════════════════════════════════════════════════════════════════════
-- Only ever updates programs.price_amount_cents — never rewrites an
-- existing program_enrollments.price_amount_cents snapshot, never creates
-- an obligation cycle, never touches payments/payment_events. A price
-- change can never affect an existing enrollment's own obligation, so
-- there is nothing for a stale-Checkout guard to protect against here —
-- confirmed directly from set_program_price's own current body, not
-- assumed.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- FAN-OUT GUARD — same design as 0161's cancel_event, applied to BOTH
-- cancel_program and archive_program
-- ═══════════════════════════════════════════════════════════════════════════
-- A Program can have N simultaneously-enrolled Members, each with their own
-- independent program_enrollments row and potentially their own open
-- Checkout Session — structurally identical to Event's own N-participant
-- case. cancel_program AND archive_program (below) each loop over every
-- CURRENTLY 'enrolled' program_enrollments row for the program, resolve
-- each one's latest payment, and call the same _invalidate_or_flag_open_
-- checkout_attempt helper once per enrollment — any bound, possibly-still-
-- payable Session rolls back the ENTIRE mutation (cancellation OR archive).
-- list_program_blocking_checkout_attempts (new, section 4 below) is the
-- ONE generic Program-level preflight-listing primitive, reused by BOTH
-- cancelProgram's and archiveProgram's own bounded batch-resolve Server
-- Action orchestration (a single shared TS helper — see programsActions.ts)
-- — no separate list RPC per lifecycle action. complete_program still
-- needs none (see above: an open Checkout is deliberately expected to
-- survive completion).
--
-- ═══════════════════════════════════════════════════════════════════════════
-- COLUMN-AMBIGUITY DEFENSE (0159/0160 lesson)
-- ═══════════════════════════════════════════════════════════════════════════
-- Every query below that touches programs/program_enrollments/payments/
-- payment_checkout_attempts qualifies every column reference with a table
-- alias (pr/pe/p/a) from the start, in every new AND every guarded-
-- existing function — the same defensive discipline 0160/0161/0162 already
-- established.
--
-- Apply in Supabase SQL Editor (cloud only). NOT YET APPLIED — this
-- checkpoint stops after implementation + static validation, per explicit
-- instruction. 0159/0160/0161/0162 are applied and immutable and are NOT
-- touched by this migration.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. get_program_payment_for_checkout — Member-owned program read
-- ═══════════════════════════════════════════════════════════════════════════
-- Read-only. Returns at most one row: the CALLER's own latest payment
-- obligation for a Program, only when ALL of the following hold:
--   * the caller's CURRENT role is exactly 'member';
--   * the Program belongs to the caller's current club;
--   * the Program's enrollment_model is exactly 'program';
--   * the Program's status IS IN ('active','completed') AND archived_at
--     IS NULL (the locked eligibility allowlist — never the broader
--     "status <> 'cancelled'" predicate);
--   * the caller has a program_enrollments row for this Program, matched
--     by their own current roster identity (current_user_roster_member_id
--     (), never a client-supplied identity);
--   * that enrollment's CURRENT status is exactly 'enrolled' — waitlisted
--     and offered never have an obligation and never reach the query
--     below.
-- No guest path exists or is intended — Programs have no guest concept
-- anywhere in the schema. Deliberately NOT the sole authority for the
-- money-moving attempt-open step (section 2 below) — a read in one
-- transaction cannot by itself close a race against a concurrent Program
-- mutation in another.
create or replace function public.get_program_payment_for_checkout(
  p_program_id uuid
)
returns table (
  payment_id                uuid,
  club_id                   uuid,
  amount_due_cents          integer,
  amount_paid_cents         integer,
  currency                  text,
  status                    text,
  payment_mode_at_creation  text
)
language plpgsql
security definer
stable
set search_path to 'public', 'pg_temp'
as $$
declare
  v_role                      text;
  v_club_id                   uuid;
  v_roster_member_id          uuid;
  v_program_status            text;
  v_program_archived_at       timestamptz;
  v_program_club_id           uuid;
  v_program_enrollment_model  text;
  v_enrollment_id             uuid;
  v_enrollment_status         text;
begin
  v_role := public.current_user_role();
  if v_role is null then
    raise exception 'not_authenticated';
  end if;
  if v_role <> 'member' then
    raise exception 'insufficient_role';
  end if;

  v_club_id := public.current_user_club_id();
  if v_club_id is null then
    raise exception 'not_authenticated';
  end if;

  v_roster_member_id := public.current_user_roster_member_id();
  if v_roster_member_id is null then
    raise exception 'not_authenticated';
  end if;

  select pr.status, pr.archived_at, pr.club_id, pr.enrollment_model
    into v_program_status, v_program_archived_at, v_program_club_id, v_program_enrollment_model
    from public.programs pr
   where pr.id = p_program_id
     and pr.club_id = v_club_id;

  if not found
     or v_program_enrollment_model <> 'program'
     or v_program_status not in ('active', 'completed')
     or v_program_archived_at is not null then
    return;
  end if;

  select pe.id, pe.status
    into v_enrollment_id, v_enrollment_status
    from public.program_enrollments pe
   where pe.program_id       = p_program_id
     and pe.roster_member_id = v_roster_member_id
   order by pe.updated_at desc
   limit 1;

  if not found or v_enrollment_status <> 'enrolled' then
    return;
  end if;

  return query
    select p.id, p.club_id, p.amount_due_cents, p.amount_paid_cents, p.currency, p.status, p.payment_mode_at_creation
      from public.payments p
     where p.domain_type = 'program_enrollment'
       and p.domain_id = v_enrollment_id
       and p.roster_member_id = v_roster_member_id
       and p.club_id = v_program_club_id
     order by p.obligation_cycle desc
     limit 1;
end;
$$;

revoke execute on function public.get_program_payment_for_checkout(uuid) from public, anon;
grant  execute on function public.get_program_payment_for_checkout(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. open_program_payment_checkout_attempt — atomic program-aware wrapper
-- ═══════════════════════════════════════════════════════════════════════════
-- service_role-only — never callable from an authenticated browser
-- session, exactly like the Lesson/Event wrappers it mirrors. Closes the
-- same TOCTOU window get_program_payment_for_checkout's own read (section
-- 1) cannot close by itself: "verify the caller's own enrollment is still
-- 'enrolled' on a still-payable Program" and "open/reuse the Checkout
-- attempt" happen inside ONE transaction, under ONE lock.
--
-- Lock order: programs FIRST — matching every Program-mutating RPC this
-- migration touches or leaves untouched (join_program, accept_program_
-- waitlist_offer, leave_program, remove_program_member, remove_program_
-- roster_member, cancel_program, complete_program, archive_program,
-- update_program — all already lock programs via `for update` as their
-- first substantive step). Whichever side — this function, or a concurrent
-- Program mutation — acquires that row lock first wins; the other blocks
-- until the first commits, then re-reads post-commit truth.
--
-- Re-derives the caller's own enrollment fresh from p_actor_id (not
-- trusted from an earlier caller-side read) — a Member's own identity
-- cannot race mid-request, so this re-resolution exists purely to
-- re-verify DOMAIN eligibility (program status/archived, enrollment
-- status) that CAN race. p_actor_id/p_stripe_account_id/p_livemode are the
-- Server Action's own already-server-derived values; payment_id itself is
-- resolved HERE, fresh, from the payments table — never accepted as a
-- parameter.
--
-- Delegates the entire remaining algorithm to the existing, UNMODIFIED
-- open_payment_checkout_attempt — never duplicated.
create or replace function public.open_program_payment_checkout_attempt(
  p_program_id         uuid,
  p_club_id            uuid,
  p_stripe_account_id  text,
  p_livemode           boolean,
  p_actor_id           uuid
)
returns table (
  action                      text,
  id                          uuid,
  payment_id                  uuid,
  club_id                     uuid,
  stripe_account_id           text,
  livemode                    boolean,
  stripe_checkout_session_id  text,
  stripe_session_expires_at   timestamptz,
  stripe_payment_intent_id    text,
  amount_expected_cents       integer,
  currency_expected           text,
  status                      text,
  created_by                  uuid,
  created_at                  timestamptz,
  updated_at                  timestamptz
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_program_status            text;
  v_program_archived_at       timestamptz;
  v_program_enrollment_model  text;
  v_roster_member_id          uuid;
  v_enrollment_id             uuid;
  v_enrollment_status         text;
  v_payment_id                uuid;
begin
  if p_program_id is null or p_club_id is null or p_stripe_account_id is null
     or p_livemode is null or p_actor_id is null then
    raise exception 'invalid_arguments';
  end if;

  select pr.status, pr.archived_at, pr.enrollment_model
    into v_program_status, v_program_archived_at, v_program_enrollment_model
    from public.programs pr
   where pr.id = p_program_id and pr.club_id = p_club_id
   for update;

  if not found then
    raise exception 'program_not_found';
  end if;
  if v_program_enrollment_model <> 'program' then
    raise exception 'program_not_whole_enrollment';
  end if;
  if v_program_status not in ('active', 'completed') or v_program_archived_at is not null then
    raise exception 'program_not_payable';
  end if;

  select rm.id into v_roster_member_id
    from public.roster_members rm
   where rm.club_id    = p_club_id
     and rm.claimed_by = p_actor_id;

  if v_roster_member_id is null then
    raise exception 'program_enrollment_not_found';
  end if;

  select pe.id, pe.status
    into v_enrollment_id, v_enrollment_status
    from public.program_enrollments pe
   where pe.program_id       = p_program_id
     and pe.roster_member_id = v_roster_member_id
   order by pe.updated_at desc
   limit 1;

  if not found then
    raise exception 'program_enrollment_not_found';
  end if;
  if v_enrollment_status <> 'enrolled' then
    raise exception 'program_enrollment_not_confirmed';
  end if;

  select p.id into v_payment_id
    from public.payments p
   where p.club_id      = p_club_id
     and p.domain_type   = 'program_enrollment'
     and p.domain_id     = v_enrollment_id
   order by p.obligation_cycle desc
   limit 1;

  if v_payment_id is null then
    raise exception 'payment_not_found';
  end if;

  return query
    select * from public.open_payment_checkout_attempt(
      v_payment_id, p_club_id, p_stripe_account_id, p_livemode, p_actor_id
    );
end;
$$;

revoke execute on function public.open_program_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) from public, anon, authenticated;
grant  execute on function public.open_program_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. supersede_program_checkout_attempt_and_open_fresh — atomic
--    program-aware wrapper (secondary attempt-opening call site)
-- ═══════════════════════════════════════════════════════════════════════════
-- The SAME race section 2 closes for the primary attempt-open call site
-- exists identically at the secondary one: after open_program_payment_
-- checkout_attempt returns action='must_expire_remote' and the Server
-- Action does an out-of-process Stripe round-trip to resolve it, a
-- concurrent Program mutation could change eligibility DURING that
-- round-trip. Closed with the identical lock-program-then-delegate pattern
-- as section 2. Never duplicates supersede_checkout_attempt_and_open_
-- fresh's own algorithm.
create or replace function public.supersede_program_checkout_attempt_and_open_fresh(
  p_program_id         uuid,
  p_stale_attempt_id   uuid,
  p_club_id            uuid,
  p_stripe_account_id  text,
  p_livemode           boolean,
  p_actor_id           uuid
)
returns table (
  action                      text,
  id                          uuid,
  payment_id                  uuid,
  club_id                     uuid,
  stripe_account_id           text,
  livemode                    boolean,
  stripe_checkout_session_id  text,
  stripe_session_expires_at   timestamptz,
  stripe_payment_intent_id    text,
  amount_expected_cents       integer,
  currency_expected           text,
  status                      text,
  created_by                  uuid,
  created_at                  timestamptz,
  updated_at                  timestamptz
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_program_status            text;
  v_program_archived_at       timestamptz;
  v_program_enrollment_model  text;
  v_roster_member_id          uuid;
  v_enrollment_id             uuid;
  v_enrollment_status         text;
  v_payment_id                uuid;
begin
  if p_program_id is null or p_stale_attempt_id is null or p_club_id is null
     or p_stripe_account_id is null or p_livemode is null or p_actor_id is null then
    raise exception 'invalid_arguments';
  end if;

  select pr.status, pr.archived_at, pr.enrollment_model
    into v_program_status, v_program_archived_at, v_program_enrollment_model
    from public.programs pr
   where pr.id = p_program_id and pr.club_id = p_club_id
   for update;

  if not found then
    raise exception 'program_not_found';
  end if;
  if v_program_enrollment_model <> 'program' then
    raise exception 'program_not_whole_enrollment';
  end if;
  if v_program_status not in ('active', 'completed') or v_program_archived_at is not null then
    raise exception 'program_not_payable';
  end if;

  select rm.id into v_roster_member_id
    from public.roster_members rm
   where rm.club_id    = p_club_id
     and rm.claimed_by = p_actor_id;

  if v_roster_member_id is null then
    raise exception 'program_enrollment_not_found';
  end if;

  select pe.id, pe.status
    into v_enrollment_id, v_enrollment_status
    from public.program_enrollments pe
   where pe.program_id       = p_program_id
     and pe.roster_member_id = v_roster_member_id
   order by pe.updated_at desc
   limit 1;

  if not found then
    raise exception 'program_enrollment_not_found';
  end if;
  if v_enrollment_status <> 'enrolled' then
    raise exception 'program_enrollment_not_confirmed';
  end if;

  select p.id into v_payment_id
    from public.payments p
   where p.club_id      = p_club_id
     and p.domain_type   = 'program_enrollment'
     and p.domain_id     = v_enrollment_id
   order by p.obligation_cycle desc
   limit 1;

  if v_payment_id is null then
    raise exception 'payment_not_found';
  end if;

  return query
    select * from public.supersede_checkout_attempt_and_open_fresh(
      p_stale_attempt_id, v_payment_id, p_club_id, p_stripe_account_id, p_livemode, p_actor_id
    );
end;
$$;

revoke execute on function public.supersede_program_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid) from public, anon, authenticated;
grant  execute on function public.supersede_program_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. list_program_blocking_checkout_attempts — service-role-only,
--    read-only, Program-level batch preflight for the cancel_program AND
--    archive_program fan-out guards
-- ═══════════════════════════════════════════════════════════════════════════
-- Minimal-surface listing RPC: for every program_enrollments row currently
-- 'enrolled' on this Program, resolves its LATEST payment obligation cycle
-- and reports that payment's id if — and only if — it has a genuinely
-- blocking attempt: status = 'open' AND a bound Stripe Checkout Session
-- (stripe_checkout_session_id is not null) — the exact same predicate
-- get_blocking_checkout_attempt_for_payment (0151) and list_event_
-- blocking_checkout_attempts (0161) already use, batched here across every
-- enrolled Member on one Program. Returns payment_id ONLY — never a Stripe
-- session id, never any enrollment identity/PII — the Server Action feeds
-- each id straight into the EXISTING, unmodified
-- resolveBlockingCheckoutBeforeMutation helper, which itself resolves the
-- Stripe identity server-side; nothing here is ever exposed to a Member.
-- The ONE generic Program-level listing primitive — reused by BOTH
-- cancelProgram's and archiveProgram's own Server Actions (programsActions.
-- ts), which both call the SAME shared bounded batch-resolution helper
-- (resolveAllBlockingProgramCheckouts) rather than each having their own
-- listing/resolution logic. complete_program needs no fan-out resolution
-- at all — an open Checkout is deliberately expected to remain collectible
-- after completion (see this migration's own header) — so no second list
-- RPC is added for it.
create or replace function public.list_program_blocking_checkout_attempts(
  p_program_id uuid,
  p_club_id    uuid
)
returns table (payment_id uuid)
language plpgsql
security definer
stable
set search_path to 'public', 'pg_temp'
as $$
begin
  if p_program_id is null or p_club_id is null then
    raise exception 'invalid_arguments';
  end if;

  return query
    select distinct p.id
      from public.program_enrollments pe
      join public.payments p
        on p.club_id     = p_club_id
       and p.domain_type = 'program_enrollment'
       and p.domain_id   = pe.id
      join public.payment_checkout_attempts a
        on a.payment_id = p.id
       and a.club_id    = p_club_id
       and a.status     = 'open'
       and a.stripe_checkout_session_id is not null
     where pe.program_id = p_program_id
       and pe.status     = 'enrolled'
       and p.obligation_cycle = (
             select max(p2.obligation_cycle)
               from public.payments p2
              where p2.club_id     = p_club_id
                and p2.domain_type = 'program_enrollment'
                and p2.domain_id   = pe.id
           );
end;
$$;

revoke execute on function public.list_program_blocking_checkout_attempts(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.list_program_blocking_checkout_attempts(uuid, uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. leave_program — CREATE OR REPLACE, ONE new guarded block
-- ═══════════════════════════════════════════════════════════════════════════
-- Reproduced VERBATIM from its latest applied body (0115, lines 551-629)
-- with exactly one addition: the new v_payment_id_for_checkout_guard
-- declaration, and, immediately after the caller's own enrollment row is
-- located (enrollment_not_found already raised for anyone else) and BEFORE
-- the program_enrollments status mutation, a lookup of that enrollment's
-- latest payment (if any) and the SAME pre-mutation _invalidate_or_flag_
-- open_checkout_attempt call already established by 0151/0159/0161 for
-- cancel_lesson/update_member_reservation/admin_update_member_lesson/
-- _leave_event_impl. Runs unconditionally (waitlisted/offered rows simply
-- resolve no payment, a safe no-op) rather than branching only on
-- v_old.status = 'enrolled', matching _leave_event_impl's own
-- unconditional-guard shape exactly. Every other check, computation,
-- mutation, notification, and audit_log entry below is byte-identical to
-- the currently-applied text.
create or replace function public.leave_program(p_program_id uuid)
returns public.program_enrollments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_roster_member_id uuid;
  v_program public.programs%rowtype;
  v_old     public.program_enrollments%rowtype;
  v_result  public.program_enrollments%rowtype;
  -- Phase 34F-C: pre-mutation Stripe Checkout invalidation.
  v_payment_id_for_checkout_guard uuid;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  v_roster_member_id := public.current_user_roster_member_id();
  if v_roster_member_id is null then
    raise exception 'phase33d2_unresolved_member_identity';
  end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id
    for update;
  if not found then raise exception 'program_not_found'; end if;

  if v_program.enrollment_model <> 'program' then
    raise exception 'program_not_whole_enrollment';
  end if;

  -- Phase 33D2b: matched via profile_id OR the caller's own current
  -- roster identity — a claimed Member whose pre-claim enrollment was
  -- staff-added (profile_id null) is recognized here too.
  select * into v_old
    from public.program_enrollments
    where program_id = p_program_id
      and (profile_id = auth.uid() or roster_member_id = v_roster_member_id)
      and status     in ('enrolled', 'waitlisted', 'offered');
  if not found then raise exception 'enrollment_not_found'; end if;

  -- Phase 34F-C — pre-mutation Stripe Checkout invalidation, mirroring
  -- _leave_event_impl's identical guard exactly (0161). Only ever
  -- cancels/flags a Checkout ATTEMPT row — never touches payments.
  -- amount_due_cents/amount_paid_cents/status, never refunds/waives/voids
  -- anything. If a bound Session may still be genuinely payable,
  -- _invalidate_or_flag_open_checkout_attempt raises open_checkout_
  -- requires_resolution and this entire leave rolls back — the calling
  -- Server Action (leaveProgram, programEnrollmentActions.ts) resolves the
  -- remote Session via the established resolveBlockingCheckoutBeforeMutation
  -- handshake, then safely retries this exact call once.
  select p.id into v_payment_id_for_checkout_guard
    from public.payments p
   where p.club_id     = v_club_id
     and p.domain_type  = 'program_enrollment'
     and p.domain_id    = v_old.id
   order by p.obligation_cycle desc
   limit 1;
  if v_payment_id_for_checkout_guard is not null then
    perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);
  end if;

  update public.program_enrollments
    set status           = 'cancelled',
        offer_expires_at = null,
        waitlisted_at    = null,
        updated_at       = now()
    where id = v_old.id
  returning * into v_result;

  if v_old.status in ('enrolled', 'offered') then
    if v_old.status = 'enrolled' then
      perform public._cancel_program_member_future_participation(p_program_id, v_roster_member_id, v_club_id);
    else
      insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
      values (
        v_club_id, auth.uid(), 'leave_program_offered_spot', 'program', p_program_id,
        jsonb_build_object('program_title', v_program.title)
      );
    end if;

    perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);
    perform public._advance_program_waitlist_offer(p_program_id, v_club_id, v_program.title);
  end if;
  -- v_old.status = 'waitlisted': no capacity was freed, no promotion needed.

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'leave_program', 'program', p_program_id,
    jsonb_build_object('previous_status', v_old.status, 'actor_role', v_role)
  );

  return v_result;
end;
$$;

revoke execute on function public.leave_program(uuid) from public, anon;
grant  execute on function public.leave_program(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. remove_program_member — CREATE OR REPLACE, ONE new guarded block
-- ═══════════════════════════════════════════════════════════════════════════
-- Reproduced VERBATIM from its latest applied body (0137, lines 1715-1804)
-- with exactly one addition: the new v_payment_id_for_checkout_guard
-- declaration, and, immediately after the target enrollment is located and
-- BEFORE the status mutation, the same unconditional pre-mutation
-- Checkout-invalidation block as section 5. Every other check,
-- computation, notification, and audit_log entry below is byte-identical
-- to the currently-applied text.
create or replace function public.remove_program_member(p_program_id uuid, p_profile_id uuid)
returns program_enrollments
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_program public.programs%rowtype;
  v_roster_member_id uuid;
  v_old     public.program_enrollments%rowtype;
  v_result  public.program_enrollments%rowtype;
  -- Phase 34F-C: pre-mutation Stripe Checkout invalidation.
  v_payment_id_for_checkout_guard uuid;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  if v_role not in ('admin', 'pro', 'staff') then
    raise exception 'insufficient_role';
  end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id
    for update;
  if not found then raise exception 'program_not_found'; end if;

  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_program.enrollment_model <> 'program' then
    raise exception 'program_not_whole_enrollment';
  end if;

  -- Phase 33D2b: resolve the target's roster identity for matching below.
  -- Deliberately NOT fail-closed here — unchanged from the pre-0115 body's
  -- own precedent of placing no membership-eligibility gate on removal
  -- (0092 header): a target whose account/roster identity has since
  -- become unresolvable for any reason must still be removable from a
  -- program roster they are still enrolled in.
  select id into v_roster_member_id
    from public.roster_members
   where club_id    = v_club_id
     and claimed_by = p_profile_id;

  select * into v_old
    from public.program_enrollments
    where program_id = p_program_id
      and (
        profile_id = p_profile_id
        or (v_roster_member_id is not null and roster_member_id = v_roster_member_id)
      )
      and status in ('enrolled', 'waitlisted', 'offered');
  if not found then raise exception 'enrollment_not_found'; end if;

  -- Phase 34F-C — pre-mutation Stripe Checkout invalidation, mirroring
  -- section 5's identical guard exactly.
  select p.id into v_payment_id_for_checkout_guard
    from public.payments p
   where p.club_id     = v_club_id
     and p.domain_type  = 'program_enrollment'
     and p.domain_id    = v_old.id
   order by p.obligation_cycle desc
   limit 1;
  if v_payment_id_for_checkout_guard is not null then
    perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);
  end if;

  update public.program_enrollments
    set status           = 'cancelled',
        offer_expires_at = null,
        waitlisted_at    = null,
        updated_at       = now()
    where id = v_old.id
  returning * into v_result;

  if v_old.status = 'enrolled' then
    -- Phase 33D2b: propagate by the row's own durable roster_member_id
    -- (guaranteed NOT NULL), not the separately-resolved variable above —
    -- strictly more correct/durable.
    perform public._cancel_program_member_future_participation(p_program_id, v_old.roster_member_id, v_club_id);
  end if;

  if v_old.status in ('enrolled', 'offered') then
    perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);
    perform public._advance_program_waitlist_offer(p_program_id, v_club_id, v_program.title);
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'remove_program_member', 'program', p_program_id,
    jsonb_build_object(
      'target_profile_id', p_profile_id,
      'previous_status',   v_old.status,
      'actor_role',        v_role
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.remove_program_member(uuid, uuid) from public, anon;
grant  execute on function public.remove_program_member(uuid, uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. remove_program_roster_member — CREATE OR REPLACE, ONE new guarded
--    block
-- ═══════════════════════════════════════════════════════════════════════════
-- Reproduced VERBATIM from its latest applied body (0137, lines 1810-1879)
-- with exactly one addition: the same unconditional pre-mutation
-- Checkout-invalidation block as sections 5/6, inserted immediately after
-- the existing lookup (which already captures v_old.id) and before the
-- status UPDATE. Every other check, computation, notification, and
-- audit_log entry below is byte-identical to the currently-applied text.
create or replace function public.remove_program_roster_member(p_program_id uuid, p_expected_club_id uuid, p_roster_member_id uuid)
returns program_enrollments
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_program public.programs%rowtype;
  v_old     public.program_enrollments%rowtype;
  v_result  public.program_enrollments%rowtype;
  -- Phase 34F-C: pre-mutation Stripe Checkout invalidation.
  v_payment_id_for_checkout_guard uuid;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role not in ('admin', 'pro', 'staff') then raise exception 'insufficient_role'; end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id
    for update;
  if not found then raise exception 'program_not_found'; end if;

  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_program.enrollment_model <> 'program' then
    raise exception 'program_not_whole_enrollment';
  end if;

  select * into v_old
    from public.program_enrollments
    where program_id       = p_program_id
      and roster_member_id = p_roster_member_id
      and status            in ('enrolled', 'waitlisted', 'offered');
  if not found then raise exception 'enrollment_not_found'; end if;

  -- Phase 34F-C — pre-mutation Stripe Checkout invalidation, mirroring
  -- sections 5/6's identical guard exactly.
  select p.id into v_payment_id_for_checkout_guard
    from public.payments p
   where p.club_id     = v_club_id
     and p.domain_type  = 'program_enrollment'
     and p.domain_id    = v_old.id
   order by p.obligation_cycle desc
   limit 1;
  if v_payment_id_for_checkout_guard is not null then
    perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);
  end if;

  update public.program_enrollments
    set status           = 'cancelled',
        offer_expires_at = null,
        waitlisted_at    = null,
        updated_at       = now()
    where id = v_old.id
  returning * into v_result;

  if v_old.status = 'enrolled' then
    perform public._cancel_program_member_future_participation(p_program_id, p_roster_member_id, v_club_id);
  end if;

  if v_old.status in ('enrolled', 'offered') then
    perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);
    perform public._advance_program_waitlist_offer(p_program_id, v_club_id, v_program.title);
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'remove_program_roster_member', 'program', p_program_id,
    jsonb_build_object(
      'roster_member_id', p_roster_member_id,
      'previous_status',  v_old.status,
      'actor_role',       v_role
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.remove_program_roster_member(uuid, uuid, uuid) from public, anon;
grant  execute on function public.remove_program_roster_member(uuid, uuid, uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. cancel_program — CREATE OR REPLACE, ONE new fan-out guarded block
-- ═══════════════════════════════════════════════════════════════════════════
-- Reproduced VERBATIM from its latest applied body (0137, lines 626-719)
-- with exactly one addition: immediately after the authorization and
-- cancellability checks pass (program_not_cancellable already raised
-- otherwise) and BEFORE the programs status UPDATE, a loop over every
-- CURRENTLY 'enrolled' program_enrollments row for this program, resolving
-- each one's latest payment and calling the same _invalidate_or_flag_
-- open_checkout_attempt helper — the Program-level fan-out case this
-- migration's own header documents in full. If ANY enrolled Member has a
-- bound, possibly-still-payable Session, the ENTIRE cancellation rolls
-- back before any mutating statement below runs — the calling Server
-- Action (cancelProgram, programsActions.ts) performs the same bounded
-- preflight-list -> resolve-each -> retry flow 0161's cancelEvent
-- established, reusing list_program_blocking_checkout_attempts (section 4)
-- unchanged. Every other check, computation, mutation, and audit_log entry
-- below is byte-identical to the currently-applied text.
create or replace function public.cancel_program(p_program_id uuid)
returns programs
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id             uuid;
  v_role                text;
  v_program             public.programs%rowtype;
  v_result              public.programs%rowtype;
  v_cancelled_event_ids uuid[];
  -- Phase 34F-C: fan-out pre-mutation Stripe Checkout invalidation.
  v_payment_id_for_checkout_guard uuid;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  if v_role not in ('admin', 'pro', 'staff') then
    raise exception 'insufficient_role';
  end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id
    for update;
  if not found then raise exception 'program_not_found'; end if;

  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  -- Only a draft or active program can be cancelled — already-cancelled,
  -- already-completed, and archived programs all raise this same code
  -- (see migration header note on error-code minimalism).
  if v_program.archived_at is not null or v_program.status not in ('draft', 'active') then
    raise exception 'program_not_cancellable';
  end if;

  -- Phase 34F-C — fan-out pre-mutation Stripe Checkout invalidation.
  -- Mirrors cancel_event's identical new block (0161) exactly — see this
  -- migration's own header for the full Program-cancellation-fan-out
  -- design.
  for v_payment_id_for_checkout_guard in
    select distinct on (p.domain_id) p.id
      from program_enrollments pe
      join payments p
        on p.club_id     = v_club_id
       and p.domain_type = 'program_enrollment'
       and p.domain_id   = pe.id
     where pe.program_id = p_program_id
       and pe.status     = 'enrolled'
     order by p.domain_id, p.obligation_cycle desc
  loop
    perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);
  end loop;

  update public.programs
    set status = 'cancelled', updated_at = now()
    where id = p_program_id
    returning * into v_result;

  -- Bulk-cancel every scheduled, non-archived, future generated event under
  -- this program — same field updates as cancel_event (0063), applied
  -- set-based. Past events (starts_at < now()) are never selected here.
  select array_agg(id) into v_cancelled_event_ids
    from public.events
    where program_id  = p_program_id
      and status       = 'scheduled'
      and archived_at is null
      and starts_at   >= now();

  if v_cancelled_event_ids is not null then
    update public.events
      set status = 'cancelled', updated_at = now()
      where id = any(v_cancelled_event_ids);

    update public.reservations
      set status            = 'cancelled',
          cancelled_at      = now(),
          cancelled_by      = auth.uid(),
          cancellation_kind = 'admin',
          updated_at        = now()
      where event_id = any(v_cancelled_event_ids)
        and status   in ('pending', 'confirmed');

    -- Only 'offered' rows are cancelled, mirroring cancel_event exactly —
    -- confirmed/waitlisted event_participants rows are left as historical
    -- record, matching program_enrollments' own preservation below.
    update public.event_participants
      set status           = 'cancelled',
          offer_expires_at = null,
          updated_at       = now()
      where event_id = any(v_cancelled_event_ids)
        and status   = 'offered';
  end if;
  -- program_enrollments is intentionally never touched here — see
  -- migration header.

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'cancel_program', 'program', p_program_id,
    jsonb_build_object(
      'title',                 v_program.title,
      'previous_status',       v_program.status,
      'cancelled_event_count', coalesce(array_length(v_cancelled_event_ids, 1), 0),
      'actor_role',            v_role
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.cancel_program(uuid) from public, anon;
grant  execute on function public.cancel_program(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 9. archive_program — CREATE OR REPLACE, ONE new fan-out guarded block
--    (correction round — the original delta audit's "no guard needed"
--    conclusion for this function was wrong; see this migration's own
--    header for the full defect this closes)
-- ═══════════════════════════════════════════════════════════════════════════
-- Reproduced VERBATIM from its latest applied body (0137, lines 801-852)
-- with exactly one addition: immediately after the authorization and
-- archivability checks pass (already_archived / program_not_archivable
-- already raised otherwise) and BEFORE the programs archived_at/
-- archived_by UPDATE, the IDENTICAL fan-out loop cancel_program (section 8
-- above) already uses — every CURRENTLY 'enrolled' program_enrollments
-- row's latest payment is resolved and passed to _invalidate_or_flag_
-- open_checkout_attempt. If ANY enrolled Member has a bound, possibly-
-- still-payable Session, the ENTIRE archive rolls back before any mutating
-- statement below runs — the calling Server Action (archiveProgram,
-- programsActions.ts) performs the same bounded preflight-list ->
-- resolve-each -> retry flow cancelProgram already established, reusing
-- list_program_blocking_checkout_attempts (section 4) unchanged and the
-- SAME shared TS batch-resolution helper. On a program whose status is
-- 'cancelled' (the other archivable branch), this guard is a harmless
-- no-op: cancel_program's own guard already resolved every blocking
-- Checkout as a precondition of that cancellation succeeding in the first
-- place, so no CURRENTLY 'enrolled' row can still have a bound attempt by
-- the time archive_program runs on a cancelled Program. Every other check,
-- computation, mutation, and audit_log entry below is byte-identical to
-- the currently-applied text.
create or replace function public.archive_program(p_program_id uuid)
returns programs
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_program public.programs%rowtype;
  v_result  public.programs%rowtype;
  -- Phase 34F-C (correction round): fan-out pre-mutation Stripe Checkout
  -- invalidation.
  v_payment_id_for_checkout_guard uuid;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  if v_role not in ('admin', 'pro', 'staff') then
    raise exception 'insufficient_role';
  end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id
    for update;
  if not found then raise exception 'program_not_found'; end if;

  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_program.archived_at is not null then
    raise exception 'already_archived';
  end if;

  if v_program.status not in ('cancelled', 'completed') then
    raise exception 'program_not_archivable';
  end if;

  -- Phase 34F-C (correction round) — fan-out pre-mutation Stripe Checkout
  -- invalidation. Identical loop to cancel_program's own (section 8
  -- above) — see this migration's own header for the full defect this
  -- closes (a completed Program's still-open Checkout, never invalidated
  -- by complete_program on purpose, must not survive archiving).
  for v_payment_id_for_checkout_guard in
    select distinct on (p.domain_id) p.id
      from program_enrollments pe
      join payments p
        on p.club_id     = v_club_id
       and p.domain_type = 'program_enrollment'
       and p.domain_id   = pe.id
     where pe.program_id = p_program_id
       and pe.status     = 'enrolled'
     order by p.domain_id, p.obligation_cycle desc
  loop
    perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);
  end loop;

  update public.programs
    set archived_at = now(), archived_by = auth.uid(), updated_at = now()
    where id = p_program_id
    returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'archive_program', 'program', p_program_id,
    jsonb_build_object('title', v_program.title, 'status', v_program.status, 'actor_role', v_role)
  );

  return v_result;
end;
$$;

revoke execute on function public.archive_program(uuid) from public, anon;
grant  execute on function public.archive_program(uuid) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created)
-- ═══════════════════════════════════════════════════════════════════════════
-- Sections 1-4 are brand new functions — rollback is a straightforward
-- DROP FUNCTION (schema-only; irreversible for any data these functions
-- happen to have written by the time a rollback is needed, exactly like
-- every other Checkout-attempt-creating RPC in this codebase):
--
-- begin;
-- drop function if exists public.get_program_payment_for_checkout(uuid);
-- drop function if exists public.open_program_payment_checkout_attempt(uuid, uuid, text, boolean, uuid);
-- drop function if exists public.supersede_program_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid);
-- drop function if exists public.list_program_blocking_checkout_attempts(uuid, uuid);
-- commit;
--
-- Sections 5-9 restore each function to its EXACT pre-0163 authoritative
-- body — byte-identical to the currently-applied text (0115 for
-- leave_program, 0137 for the other four — remove_program_member,
-- remove_program_roster_member, cancel_program, and archive_program),
-- proving rollback equality against those specific migrations' own text.
--
-- begin;
--
-- create or replace function public.leave_program(p_program_id uuid)
-- returns public.program_enrollments
-- language plpgsql
-- security definer
-- set search_path = public, pg_temp
-- as $$
-- declare
--   v_club_id uuid;
--   v_role    text;
--   v_roster_member_id uuid;
--   v_program public.programs%rowtype;
--   v_old     public.program_enrollments%rowtype;
--   v_result  public.program_enrollments%rowtype;
-- begin
--   select public.current_user_club_id(), public.current_user_role()
--     into v_club_id, v_role;
--   if v_club_id is null then raise exception 'not_authenticated'; end if;
--
--   v_roster_member_id := public.current_user_roster_member_id();
--   if v_roster_member_id is null then
--     raise exception 'phase33d2_unresolved_member_identity';
--   end if;
--
--   select * into v_program
--     from public.programs
--     where id = p_program_id and club_id = v_club_id
--     for update;
--   if not found then raise exception 'program_not_found'; end if;
--
--   if v_program.enrollment_model <> 'program' then
--     raise exception 'program_not_whole_enrollment';
--   end if;
--
--   -- Phase 33D2b: matched via profile_id OR the caller's own current
--   -- roster identity — a claimed Member whose pre-claim enrollment was
--   -- staff-added (profile_id null) is recognized here too.
--   select * into v_old
--     from public.program_enrollments
--     where program_id = p_program_id
--       and (profile_id = auth.uid() or roster_member_id = v_roster_member_id)
--       and status     in ('enrolled', 'waitlisted', 'offered');
--   if not found then raise exception 'enrollment_not_found'; end if;
--
--   update public.program_enrollments
--     set status           = 'cancelled',
--         offer_expires_at = null,
--         waitlisted_at    = null,
--         updated_at       = now()
--     where id = v_old.id
--   returning * into v_result;
--
--   if v_old.status in ('enrolled', 'offered') then
--     if v_old.status = 'enrolled' then
--       perform public._cancel_program_member_future_participation(p_program_id, v_roster_member_id, v_club_id);
--     else
--       insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
--       values (
--         v_club_id, auth.uid(), 'leave_program_offered_spot', 'program', p_program_id,
--         jsonb_build_object('program_title', v_program.title)
--       );
--     end if;
--
--     perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);
--     perform public._advance_program_waitlist_offer(p_program_id, v_club_id, v_program.title);
--   end if;
--   -- v_old.status = 'waitlisted': no capacity was freed, no promotion needed.
--
--   insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
--   values (
--     v_club_id, auth.uid(), 'leave_program', 'program', p_program_id,
--     jsonb_build_object('previous_status', v_old.status, 'actor_role', v_role)
--   );
--
--   return v_result;
-- end;
-- $$;
--
-- revoke execute on function public.leave_program(uuid) from public, anon;
-- grant  execute on function public.leave_program(uuid) to authenticated;
--
-- CREATE OR REPLACE FUNCTION public.remove_program_member(p_program_id uuid, p_profile_id uuid)
--  RETURNS program_enrollments
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public', 'pg_temp'
-- AS $function$
-- declare
--   v_club_id uuid;
--   v_role    text;
--   v_program public.programs%rowtype;
--   v_roster_member_id uuid;
--   v_old     public.program_enrollments%rowtype;
--   v_result  public.program_enrollments%rowtype;
-- begin
--   select public.current_user_club_id(), public.current_user_role()
--     into v_club_id, v_role;
--   if v_club_id is null then raise exception 'not_authenticated'; end if;
--
--   if v_role not in ('admin', 'pro', 'staff') then
--     raise exception 'insufficient_role';
--   end if;
--
--   select * into v_program
--     from public.programs
--     where id = p_program_id and club_id = v_club_id
--     for update;
--   if not found then raise exception 'program_not_found'; end if;
--
--   if v_role = 'pro' and v_program.created_by <> auth.uid() then
--     raise exception 'insufficient_role';
--   end if;
--
--   if v_program.enrollment_model <> 'program' then
--     raise exception 'program_not_whole_enrollment';
--   end if;
--
--   -- Phase 33D2b: resolve the target's roster identity for matching below.
--   -- Deliberately NOT fail-closed here — unchanged from the pre-0115 body's
--   -- own precedent of placing no membership-eligibility gate on removal
--   -- (0092 header): a target whose account/roster identity has since
--   -- become unresolvable for any reason must still be removable from a
--   -- program roster they are still enrolled in.
--   select id into v_roster_member_id
--     from public.roster_members
--    where club_id    = v_club_id
--      and claimed_by = p_profile_id;
--
--   select * into v_old
--     from public.program_enrollments
--     where program_id = p_program_id
--       and (
--         profile_id = p_profile_id
--         or (v_roster_member_id is not null and roster_member_id = v_roster_member_id)
--       )
--       and status in ('enrolled', 'waitlisted', 'offered');
--   if not found then raise exception 'enrollment_not_found'; end if;
--
--   update public.program_enrollments
--     set status           = 'cancelled',
--         offer_expires_at = null,
--         waitlisted_at    = null,
--         updated_at       = now()
--     where id = v_old.id
--   returning * into v_result;
--
--   if v_old.status = 'enrolled' then
--     -- Phase 33D2b: propagate by the row's own durable roster_member_id
--     -- (guaranteed NOT NULL), not the separately-resolved variable above —
--     -- strictly more correct/durable.
--     perform public._cancel_program_member_future_participation(p_program_id, v_old.roster_member_id, v_club_id);
--   end if;
--
--   if v_old.status in ('enrolled', 'offered') then
--     perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);
--     perform public._advance_program_waitlist_offer(p_program_id, v_club_id, v_program.title);
--   end if;
--
--   insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
--   values (
--     v_club_id, auth.uid(), 'remove_program_member', 'program', p_program_id,
--     jsonb_build_object(
--       'target_profile_id', p_profile_id,
--       'previous_status',   v_old.status,
--       'actor_role',        v_role
--     )
--   );
--
--   return v_result;
-- end;
-- $function$;
--
-- revoke execute on function public.remove_program_member(uuid, uuid) from public, anon;
-- grant  execute on function public.remove_program_member(uuid, uuid) to authenticated;
--
-- CREATE OR REPLACE FUNCTION public.remove_program_roster_member(p_program_id uuid, p_expected_club_id uuid, p_roster_member_id uuid)
--  RETURNS program_enrollments
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public', 'pg_temp'
-- AS $function$
-- declare
--   v_club_id uuid;
--   v_role    text;
--   v_program public.programs%rowtype;
--   v_old     public.program_enrollments%rowtype;
--   v_result  public.program_enrollments%rowtype;
-- begin
--   select public.current_user_club_id(), public.current_user_role()
--     into v_club_id, v_role;
--   if v_club_id is null then raise exception 'not_authenticated'; end if;
--   if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
--   if v_role not in ('admin', 'pro', 'staff') then raise exception 'insufficient_role'; end if;
--
--   select * into v_program
--     from public.programs
--     where id = p_program_id and club_id = v_club_id
--     for update;
--   if not found then raise exception 'program_not_found'; end if;
--
--   if v_role = 'pro' and v_program.created_by <> auth.uid() then
--     raise exception 'insufficient_role';
--   end if;
--
--   if v_program.enrollment_model <> 'program' then
--     raise exception 'program_not_whole_enrollment';
--   end if;
--
--   select * into v_old
--     from public.program_enrollments
--     where program_id       = p_program_id
--       and roster_member_id = p_roster_member_id
--       and status            in ('enrolled', 'waitlisted', 'offered');
--   if not found then raise exception 'enrollment_not_found'; end if;
--
--   update public.program_enrollments
--     set status           = 'cancelled',
--         offer_expires_at = null,
--         waitlisted_at    = null,
--         updated_at       = now()
--     where id = v_old.id
--   returning * into v_result;
--
--   if v_old.status = 'enrolled' then
--     perform public._cancel_program_member_future_participation(p_program_id, p_roster_member_id, v_club_id);
--   end if;
--
--   if v_old.status in ('enrolled', 'offered') then
--     perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);
--     perform public._advance_program_waitlist_offer(p_program_id, v_club_id, v_program.title);
--   end if;
--
--   insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
--   values (
--     v_club_id, auth.uid(), 'remove_program_roster_member', 'program', p_program_id,
--     jsonb_build_object(
--       'roster_member_id', p_roster_member_id,
--       'previous_status',  v_old.status,
--       'actor_role',       v_role
--     )
--   );
--
--   return v_result;
-- end;
-- $function$;
--
-- revoke execute on function public.remove_program_roster_member(uuid, uuid, uuid) from public, anon;
-- grant  execute on function public.remove_program_roster_member(uuid, uuid, uuid) to authenticated;
--
-- CREATE OR REPLACE FUNCTION public.cancel_program(p_program_id uuid)
--  RETURNS programs
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public', 'pg_temp'
-- AS $function$
-- declare
--   v_club_id             uuid;
--   v_role                text;
--   v_program             public.programs%rowtype;
--   v_result              public.programs%rowtype;
--   v_cancelled_event_ids uuid[];
-- begin
--   select public.current_user_club_id(), public.current_user_role()
--     into v_club_id, v_role;
--   if v_club_id is null then raise exception 'not_authenticated'; end if;
--
--   if v_role not in ('admin', 'pro', 'staff') then
--     raise exception 'insufficient_role';
--   end if;
--
--   select * into v_program
--     from public.programs
--     where id = p_program_id and club_id = v_club_id
--     for update;
--   if not found then raise exception 'program_not_found'; end if;
--
--   if v_role = 'pro' and v_program.created_by <> auth.uid() then
--     raise exception 'insufficient_role';
--   end if;
--
--   -- Only a draft or active program can be cancelled — already-cancelled,
--   -- already-completed, and archived programs all raise this same code
--   -- (see migration header note on error-code minimalism).
--   if v_program.archived_at is not null or v_program.status not in ('draft', 'active') then
--     raise exception 'program_not_cancellable';
--   end if;
--
--   update public.programs
--     set status = 'cancelled', updated_at = now()
--     where id = p_program_id
--     returning * into v_result;
--
--   -- Bulk-cancel every scheduled, non-archived, future generated event under
--   -- this program — same field updates as cancel_event (0063), applied
--   -- set-based. Past events (starts_at < now()) are never selected here.
--   select array_agg(id) into v_cancelled_event_ids
--     from public.events
--     where program_id  = p_program_id
--       and status       = 'scheduled'
--       and archived_at is null
--       and starts_at   >= now();
--
--   if v_cancelled_event_ids is not null then
--     update public.events
--       set status = 'cancelled', updated_at = now()
--       where id = any(v_cancelled_event_ids);
--
--     update public.reservations
--       set status            = 'cancelled',
--           cancelled_at      = now(),
--           cancelled_by      = auth.uid(),
--           cancellation_kind = 'admin',
--           updated_at        = now()
--       where event_id = any(v_cancelled_event_ids)
--         and status   in ('pending', 'confirmed');
--
--     -- Only 'offered' rows are cancelled, mirroring cancel_event exactly —
--     -- confirmed/waitlisted event_participants rows are left as historical
--     -- record, matching program_enrollments' own preservation below.
--     update public.event_participants
--       set status           = 'cancelled',
--           offer_expires_at = null,
--           updated_at       = now()
--       where event_id = any(v_cancelled_event_ids)
--         and status   = 'offered';
--   end if;
--   -- program_enrollments is intentionally never touched here — see
--   -- migration header.
--
--   insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
--   values (
--     v_club_id, auth.uid(), 'cancel_program', 'program', p_program_id,
--     jsonb_build_object(
--       'title',                 v_program.title,
--       'previous_status',       v_program.status,
--       'cancelled_event_count', coalesce(array_length(v_cancelled_event_ids, 1), 0),
--       'actor_role',            v_role
--     )
--   );
--
--   return v_result;
-- end;
-- $function$;
--
-- revoke execute on function public.cancel_program(uuid) from public, anon;
-- grant  execute on function public.cancel_program(uuid) to authenticated;
--
-- CREATE OR REPLACE FUNCTION public.archive_program(p_program_id uuid)
--  RETURNS programs
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public', 'pg_temp'
-- AS $function$
-- declare
--   v_club_id uuid;
--   v_role    text;
--   v_program public.programs%rowtype;
--   v_result  public.programs%rowtype;
-- begin
--   select public.current_user_club_id(), public.current_user_role()
--     into v_club_id, v_role;
--   if v_club_id is null then raise exception 'not_authenticated'; end if;
--
--   if v_role not in ('admin', 'pro', 'staff') then
--     raise exception 'insufficient_role';
--   end if;
--
--   select * into v_program
--     from public.programs
--     where id = p_program_id and club_id = v_club_id
--     for update;
--   if not found then raise exception 'program_not_found'; end if;
--
--   if v_role = 'pro' and v_program.created_by <> auth.uid() then
--     raise exception 'insufficient_role';
--   end if;
--
--   if v_program.archived_at is not null then
--     raise exception 'already_archived';
--   end if;
--
--   if v_program.status not in ('cancelled', 'completed') then
--     raise exception 'program_not_archivable';
--   end if;
--
--   update public.programs
--     set archived_at = now(), archived_by = auth.uid(), updated_at = now()
--     where id = p_program_id
--     returning * into v_result;
--
--   insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
--   values (
--     v_club_id, auth.uid(), 'archive_program', 'program', p_program_id,
--     jsonb_build_object('title', v_program.title, 'status', v_program.status, 'actor_role', v_role)
--   );
--
--   return v_result;
-- end;
-- $function$;
--
-- revoke execute on function public.archive_program(uuid) from public, anon;
-- grant  execute on function public.archive_program(uuid) to authenticated;
--
-- commit;
