-- 0161_event_online_payment_checkout.sql
-- Phase 34F-B — Event Online Payment Expansion.
--
-- Locked product model (approved audit, this checkpoint):
--   * confirmed event_participant + parent Event scheduled/non-archived +
--     a collectible payment obligation => Member may Pay Now.
--   * waitlisted/offered participants never have an obligation and are
--     never eligible for Checkout.
--   * Event Guest remains structurally excluded (0149's court_time_payments
--     + event_guest carve-out in _create_payment_obligation is untouched by
--     this migration).
--   * Capacity is NOT a Checkout concern — join_event/accept_waitlist_offer
--     (0144, untouched here) already secure capacity synchronously, before
--     any Checkout step exists. Nothing in this migration changes capacity
--     semantics.
--   * Cancellation/withdrawal/removal never refund/waive/void/alter
--     amount_paid_cents or fabricate a ledger event — every guard added
--     below only ever cancels/flags a Checkout ATTEMPT row (never touches
--     payments.amount_due_cents/amount_paid_cents/status), exactly like the
--     existing _invalidate_or_flag_open_checkout_attempt (0151) it reuses
--     verbatim.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- MATERIAL vs NON-MATERIAL EVENT EDIT — evidence
-- ═══════════════════════════════════════════════════════════════════════════
-- Audited src/lib/stripe/paymentsConfig.ts's existing buildReservationChecko
-- utSessionParams/buildLessonCheckoutSessionParams before writing
-- buildEventCheckoutSessionParams (below, TypeScript layer): BOTH existing
-- domains use a FIXED, generic Stripe line-item product name ("Court
-- reservation payment" / "Tennis lesson payment") — never the booking's own
-- title, date/time, or court. Stripe's own Checkout-hosted page therefore
-- never displays an Event's title, date/time, or court to the Member either
-- (buildEventCheckoutSessionParams below uses "Event payment", the same
-- convention) — client_reference_id/metadata carry those facts but are
-- never rendered to the payer, only visible in the Stripe Dashboard.
--
-- Materiality here is therefore NOT about what Stripe visually displays —
-- it is about whether the previously-purchased COMMITMENT is still the same
-- one, exactly the same reasoning 0159 already used for Lesson (whose own
-- Stripe display is equally generic, yet 0159 still treats a scheduling/
-- court/provider change as material). Per the locked correction:
--   MATERIAL   — starts_at, ends_at, court set, event_type_id.
--   NON-MATERIAL — title (never Stripe-displayed, confirmed above),
--     description, capacity, member_joinable, internal notes, and an Event
--     price override that only affects FUTURE joiners (set_event_price_
--     override, 0141, already never rewrites an existing participant's own
--     price_amount_cents snapshot — untouched by this migration, no guard
--     needed there at all).
-- update_event (section 8 below) computes exactly this predicate from its
-- own pre-existing v_time_changed/v_court_set_changed locals plus one new
-- event_type_id comparison — no new field-tracking mechanism invented.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EVENT CANCELLATION FAN-OUT — design
-- ═══════════════════════════════════════════════════════════════════════════
-- Unlike Lesson/Reservation (one domain row, one payment), an Event can have
-- N confirmed participants, each with their own payment and potentially
-- their own open Stripe Checkout attempt. cancel_event (section 9) and
-- update_event's material-edit path (section 8) both loop over every
-- CURRENTLY confirmed participant's latest payment and call the existing
-- _invalidate_or_flag_open_checkout_attempt once each — if ANY has a bound,
-- possibly-still-payable Session, the whole transaction (the entire
-- cancellation/edit) rolls back, per the locked "must not finish cancelling
-- while ANY confirmed participant has a possibly-payable Session" rule.
--
-- To avoid forcing an Admin through one-attempt-at-a-time error/retry
-- roundtrips, a new tiny service-role-only preflight/listing RPC (section
-- 4, list_event_blocking_checkout_attempts) lets the Server Action discover
-- every genuinely blocking (bound + open) attempt for the event UP FRONT,
-- resolve each one via the EXISTING, unmodified, generic
-- resolveBlockingCheckoutBeforeMutation helper (src/lib/stripe/
-- checkoutInvalidation.ts — reused per-attempt, never duplicated), and only
-- then call/retry cancel_event or updateEventAdmin. The loop inside
-- cancel_event/update_event themselves remains the final, atomic,
-- lock-held authority — a race that reintroduces a new bound Session
-- between the preflight list and the retry still fails closed (the guard
-- raises again; the Server Action performs one bounded second resolve+retry
-- pass, never an unbounded loop; the Event is left scheduled/unmodified on
-- any resolution failure rather than risk charging for a cancelled Event).
--
-- ═══════════════════════════════════════════════════════════════════════════
-- COLUMN-AMBIGUITY DEFENSE (0159/0160 lesson)
-- ═══════════════════════════════════════════════════════════════════════════
-- 0159 originally shipped open_lesson_payment_checkout_attempt /
-- supersede_lesson_checkout_attempt_and_open_fresh with bare column
-- references that collided with their own RETURNS TABLE output-variable
-- names (fixed only after a runtime 42702 in 0160). Every query below that
-- touches events/event_participants/payments/payment_checkout_attempts
-- qualifies EVERY column reference with a table alias (e/ep/p/a) from the
-- start, in every new AND every guarded-existing function, regardless of
-- whether today's specific RETURNS TABLE/OUT-parameter set would actually
-- collide — the same defensive discipline 0160 established, applied
-- proactively instead of reactively.
--
-- Apply in Supabase SQL Editor (cloud only). NOT YET APPLIED — this
-- checkpoint stops after implementation + static validation, per explicit
-- instruction. 0159/0160 are applied and immutable and are NOT touched by
-- this migration.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. get_event_payment_for_checkout — Member-owned event read
-- ═══════════════════════════════════════════════════════════════════════════
-- Read-only. Returns at most one row: the CALLER's own latest payment
-- obligation for an Event, only when ALL of the following hold:
--   * the caller's CURRENT role is exactly 'member';
--   * the Event belongs to the caller's current club;
--   * the Event is 'scheduled' and not archived;
--   * the caller has an event_participants row for this Event, matched by
--     their own current roster identity (current_user_roster_member_id(),
--     never a client-supplied identity) — mirrors get_reservation_payment_
--     for_checkout/get_lesson_payment_for_checkout's own roster_member_id-
--     only matching convention exactly (event_participants.roster_member_id
--     is NOT NULL, Phase 33D2a durable identity);
--   * that participant's CURRENT status is exactly 'confirmed' — waitlisted
--     and offered never have an obligation and never reach the query below.
-- No guest path exists or is intended: event_guest has no roster identity
-- to match against current_user_roster_member_id() at all, so it is
-- structurally unreachable through this function regardless of input,
-- exactly like get_reservation_payment_for_checkout's own event_guest
-- exclusion (0150's own header comment).
--
-- Additionally returns event_starts_at (new relative to the Lesson/
-- Reservation siblings) — /calendar is date-navigated like Reservation's
-- own surface (unlike /my-schedule's flat lesson list), so
-- eventCheckoutActions.ts needs the Event's own date to build a return URL
-- that lands the Member back on the correct day, mirroring
-- buildReservationCheckoutReturnUrls's own reservationDateISO parameter.
--
-- Deliberately NOT the sole authority for the money-moving attempt-open
-- step (section 2 below) — a read in one transaction cannot by itself close
-- a race against a concurrent Event mutation in another.
create or replace function public.get_event_payment_for_checkout(
  p_event_id uuid
)
returns table (
  payment_id                uuid,
  club_id                   uuid,
  amount_due_cents          integer,
  amount_paid_cents         integer,
  currency                  text,
  status                    text,
  payment_mode_at_creation  text,
  event_starts_at           timestamptz
)
language plpgsql
security definer
stable
set search_path to 'public', 'pg_temp'
as $$
declare
  v_role                text;
  v_club_id             uuid;
  v_roster_member_id    uuid;
  v_event_status        text;
  v_event_archived_at   timestamptz;
  v_event_club_id       uuid;
  v_event_starts_at     timestamptz;
  v_participant_id      uuid;
  v_participant_status  text;
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

  select e.status, e.archived_at, e.club_id, e.starts_at
    into v_event_status, v_event_archived_at, v_event_club_id, v_event_starts_at
    from public.events e
   where e.id = p_event_id
     and e.club_id = v_club_id;

  if not found or v_event_status <> 'scheduled' or v_event_archived_at is not null then
    return;
  end if;

  select ep.id, ep.status
    into v_participant_id, v_participant_status
    from public.event_participants ep
   where ep.event_id         = p_event_id
     and ep.roster_member_id = v_roster_member_id
   order by ep.updated_at desc
   limit 1;

  if not found or v_participant_status <> 'confirmed' then
    return;
  end if;

  return query
    select p.id, p.club_id, p.amount_due_cents, p.amount_paid_cents, p.currency, p.status, p.payment_mode_at_creation, v_event_starts_at
      from public.payments p
     where p.domain_type = 'event_participant'
       and p.domain_id = v_participant_id
       and p.roster_member_id = v_roster_member_id
       and p.club_id = v_event_club_id
     order by p.obligation_cycle desc
     limit 1;
end;
$$;

revoke execute on function public.get_event_payment_for_checkout(uuid) from public, anon;
grant  execute on function public.get_event_payment_for_checkout(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. open_event_payment_checkout_attempt — atomic event-aware wrapper
-- ═══════════════════════════════════════════════════════════════════════════
-- service_role-only — never callable from an authenticated browser session,
-- exactly like the Lesson/Reservation wrappers it mirrors. Closes the same
-- TOCTOU window get_event_payment_for_checkout's own read (section 1)
-- cannot close by itself: "verify the caller's own participant is still
-- confirmed on a still-scheduled Event" and "open/reuse the Checkout
-- attempt" happen inside ONE transaction, under ONE lock.
--
-- Lock order: events FIRST — matching every Event-mutating RPC in this
-- migration (_leave_event_impl, admin_remove_participant, admin_remove_
-- roster_participant, update_event, cancel_event, all below) and every
-- pre-existing Event RPC's own established `for update` on events
-- (join_event, accept_waitlist_offer, cancel_event, update_event, 0144/
-- 0136). Whichever side — this function, or a concurrent Event mutation —
-- acquires the events row lock first wins; the other blocks until the
-- first commits, then re-reads post-commit truth, exactly like the Lesson
-- wrapper's own header comment describes for lesson_requests.
--
-- Re-derives the caller's own participant fresh from p_actor_id (not
-- trusted from an earlier caller-side read) — a Member's own identity
-- cannot race mid-request, so this re-resolution exists purely to
-- re-verify DOMAIN eligibility (event status, participant status) that
-- CAN race, not to re-verify ownership. p_actor_id/p_stripe_account_id/
-- p_livemode are the Server Action's own already-server-derived values,
-- identical in shape to the Lesson/Reservation wrappers; payment_id itself
-- is resolved HERE, fresh, from the payments table — never accepted as a
-- parameter, so a caller can never substitute a different payment.
--
-- Delegates the entire remaining algorithm to the existing, UNMODIFIED
-- open_payment_checkout_attempt — never duplicated.
create or replace function public.open_event_payment_checkout_attempt(
  p_event_id           uuid,
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
  v_event_status        text;
  v_event_archived_at   timestamptz;
  v_roster_member_id    uuid;
  v_participant_id      uuid;
  v_participant_status  text;
  v_payment_id          uuid;
begin
  if p_event_id is null or p_club_id is null or p_stripe_account_id is null
     or p_livemode is null or p_actor_id is null then
    raise exception 'invalid_arguments';
  end if;

  select e.status, e.archived_at
    into v_event_status, v_event_archived_at
    from public.events e
   where e.id = p_event_id and e.club_id = p_club_id
   for update;

  if not found then
    raise exception 'event_not_found';
  end if;
  if v_event_status <> 'scheduled' or v_event_archived_at is not null then
    raise exception 'event_not_scheduled';
  end if;

  select rm.id into v_roster_member_id
    from public.roster_members rm
   where rm.club_id    = p_club_id
     and rm.claimed_by = p_actor_id;

  if v_roster_member_id is null then
    raise exception 'event_participant_not_found';
  end if;

  select ep.id, ep.status
    into v_participant_id, v_participant_status
    from public.event_participants ep
   where ep.event_id         = p_event_id
     and ep.roster_member_id = v_roster_member_id
   order by ep.updated_at desc
   limit 1;

  if not found then
    raise exception 'event_participant_not_found';
  end if;
  if v_participant_status <> 'confirmed' then
    raise exception 'event_participant_not_confirmed';
  end if;

  select p.id into v_payment_id
    from public.payments p
   where p.club_id      = p_club_id
     and p.domain_type   = 'event_participant'
     and p.domain_id     = v_participant_id
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

revoke execute on function public.open_event_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) from public, anon, authenticated;
grant  execute on function public.open_event_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. supersede_event_checkout_attempt_and_open_fresh — atomic event-aware
--    wrapper (secondary attempt-opening call site)
-- ═══════════════════════════════════════════════════════════════════════════
-- The SAME race section 2 closes for the primary attempt-open call site
-- exists identically at the secondary one: after open_event_payment_
-- checkout_attempt returns action='must_expire_remote' and the Server
-- Action does an out-of-process Stripe round-trip to resolve it, a
-- concurrent Event mutation could change eligibility DURING that
-- round-trip, before supersede_checkout_attempt_and_open_fresh is called.
-- Closed with the identical lock-event-then-delegate pattern as section 2 —
-- not a new mechanism, the same one applied to the one other attempt-
-- opening call site. Never duplicates supersede_checkout_attempt_and_open_
-- fresh's own algorithm.
create or replace function public.supersede_event_checkout_attempt_and_open_fresh(
  p_event_id           uuid,
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
  v_event_status        text;
  v_event_archived_at   timestamptz;
  v_roster_member_id    uuid;
  v_participant_id      uuid;
  v_participant_status  text;
  v_payment_id          uuid;
begin
  if p_event_id is null or p_stale_attempt_id is null or p_club_id is null
     or p_stripe_account_id is null or p_livemode is null or p_actor_id is null then
    raise exception 'invalid_arguments';
  end if;

  select e.status, e.archived_at
    into v_event_status, v_event_archived_at
    from public.events e
   where e.id = p_event_id and e.club_id = p_club_id
   for update;

  if not found then
    raise exception 'event_not_found';
  end if;
  if v_event_status <> 'scheduled' or v_event_archived_at is not null then
    raise exception 'event_not_scheduled';
  end if;

  select rm.id into v_roster_member_id
    from public.roster_members rm
   where rm.club_id    = p_club_id
     and rm.claimed_by = p_actor_id;

  if v_roster_member_id is null then
    raise exception 'event_participant_not_found';
  end if;

  select ep.id, ep.status
    into v_participant_id, v_participant_status
    from public.event_participants ep
   where ep.event_id         = p_event_id
     and ep.roster_member_id = v_roster_member_id
   order by ep.updated_at desc
   limit 1;

  if not found then
    raise exception 'event_participant_not_found';
  end if;
  if v_participant_status <> 'confirmed' then
    raise exception 'event_participant_not_confirmed';
  end if;

  select p.id into v_payment_id
    from public.payments p
   where p.club_id      = p_club_id
     and p.domain_type   = 'event_participant'
     and p.domain_id     = v_participant_id
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

revoke execute on function public.supersede_event_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid) from public, anon, authenticated;
grant  execute on function public.supersede_event_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. list_event_blocking_checkout_attempts — service-role-only, read-only,
--    Event-level batch preflight for the cancel_event / update_event
--    fan-out guard
-- ═══════════════════════════════════════════════════════════════════════════
-- Minimal-surface listing RPC: for every event_participants row currently
-- 'confirmed' on this Event, resolves its LATEST payment obligation cycle
-- and reports that payment's id if — and only if — it has a genuinely
-- blocking attempt: status = 'open' AND a bound Stripe Checkout Session
-- (stripe_checkout_session_id is not null) — the exact same predicate
-- get_blocking_checkout_attempt_for_payment (0151) already uses for the
-- single-payment case, batched here across every confirmed participant on
-- one Event. Returns payment_id ONLY — never a Stripe session id, never any
-- participant identity/PII — the Server Action feeds each id straight into
-- the EXISTING, unmodified resolveBlockingCheckoutBeforeMutation helper
-- (src/lib/stripe/checkoutInvalidation.ts), which itself resolves the
-- Stripe identity server-side; nothing here is ever exposed to a Member.
create or replace function public.list_event_blocking_checkout_attempts(
  p_event_id uuid,
  p_club_id  uuid
)
returns table (payment_id uuid)
language plpgsql
security definer
stable
set search_path to 'public', 'pg_temp'
as $$
begin
  if p_event_id is null or p_club_id is null then
    raise exception 'invalid_arguments';
  end if;

  return query
    select distinct p.id
      from public.event_participants ep
      join public.payments p
        on p.club_id     = p_club_id
       and p.domain_type = 'event_participant'
       and p.domain_id   = ep.id
      join public.payment_checkout_attempts a
        on a.payment_id  = p.id
       and a.club_id     = p_club_id
       and a.status      = 'open'
       and a.stripe_checkout_session_id is not null
     where ep.event_id = p_event_id
       and ep.status   = 'confirmed'
       and p.obligation_cycle = (
             select max(p2.obligation_cycle)
               from public.payments p2
              where p2.club_id     = p_club_id
                and p2.domain_type = 'event_participant'
                and p2.domain_id   = ep.id
           );
end;
$$;

revoke execute on function public.list_event_blocking_checkout_attempts(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.list_event_blocking_checkout_attempts(uuid, uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. _leave_event_impl — CREATE OR REPLACE, ONE new guarded block
-- ═══════════════════════════════════════════════════════════════════════════
-- Reproduced VERBATIM from its latest applied body (0127, lines 1036-1139 —
-- 0102's original body was itself superseded there, before this migration
-- was written; every declaration, check, computation, mutation, and
-- notification/audit call below is byte-identical to that 0127 text) with
-- exactly one addition: the new v_payment_id_for_checkout_guard
-- declaration, and, immediately after the participant row is located
-- (v_participant_id/v_old_status) and BEFORE the event_participants status
-- mutation, a lookup of that participant's latest payment (if any) and the
-- SAME pre-mutation _invalidate_or_flag_open_checkout_attempt call already
-- established by 0151/0159 for cancel_lesson/update_member_reservation/
-- admin_update_member_lesson. Runs unconditionally (waitlisted/offered
-- rows simply resolve no payment, and the guard is a safe no-op with
-- nothing to invalidate) rather than branching only on v_old_status =
-- 'confirmed', matching cancel_lesson's own unconditional-guard shape
-- exactly. A single participant per call — no fan-out needed here, unlike
-- cancel_event/update_event.
create or replace function public._leave_event_impl(p_event_id uuid)
returns jsonb   -- { offered_profile_id: uuid | null, notification_id: uuid | null }
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile        public.profiles%rowtype;
  v_event          public.events%rowtype;
  v_old_status     text;
  v_participant_id uuid;
  v_roster_member_id uuid;
  v_expire_result  jsonb;
  v_advance_result jsonb;
  v_final_result   jsonb := jsonb_build_object('offered_profile_id', null, 'notification_id', null);
  -- Phase 34F-B: pre-mutation Stripe Checkout invalidation.
  v_payment_id_for_checkout_guard uuid;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  select * into v_event
    from public.events
    where id      = p_event_id
      and club_id = v_profile.club_id
    for update;
  if found and v_event.archived_at is not null then
    raise exception 'event_archived';
  end if;

  select id into v_roster_member_id
    from public.roster_members
   where club_id    = v_profile.club_id
     and claimed_by = auth.uid();

  select id, status into v_participant_id, v_old_status
    from public.event_participants
    where event_id = p_event_id
      and status    in ('confirmed', 'waitlisted', 'offered')
      and (
        profile_id = auth.uid()
        or (v_roster_member_id is not null and roster_member_id = v_roster_member_id)
      );
  if not found then raise exception 'not_joined'; end if;

  -- Phase 34F-B — pre-mutation Stripe Checkout invalidation, mirroring
  -- cancel_lesson's identical guard exactly (0159). Only ever cancels/flags
  -- a Checkout ATTEMPT row — never touches payments.amount_due_cents/
  -- amount_paid_cents/status, never refunds/waives/voids anything. If a
  -- bound Session may still be genuinely payable, _invalidate_or_flag_
  -- open_checkout_attempt raises open_checkout_requires_resolution and this
  -- entire leave rolls back — the calling Server Action (leaveEvent,
  -- calendar/actions.ts) resolves the remote Session via the established
  -- resolveBlockingCheckoutBeforeMutation handshake, then safely retries
  -- this exact call once.
  select p.id into v_payment_id_for_checkout_guard
    from public.payments p
   where p.club_id     = v_profile.club_id
     and p.domain_type  = 'event_participant'
     and p.domain_id    = v_participant_id
   order by p.obligation_cycle desc
   limit 1;
  if v_payment_id_for_checkout_guard is not null then
    perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);
  end if;

  update public.event_participants
    set status           = 'cancelled',
        offer_expires_at = null,
        updated_at       = now()
    where id = v_participant_id;

  if v_old_status = 'confirmed' then
    select * into v_event
      from public.events
      where id      = p_event_id
        and club_id = v_profile.club_id
        and status  = 'scheduled';

    if found then
      select public.expire_stale_offers_for_event(p_event_id, v_profile.club_id, v_event.title, auth.uid())
        into v_expire_result;
      select public.advance_waitlist_offer(p_event_id, v_profile.club_id, v_event.title, auth.uid())
        into v_advance_result;

      v_final_result := case
        when (v_expire_result->>'offered_profile_id') is not null then v_expire_result
        else v_advance_result
      end;
    end if;

  elsif v_old_status = 'offered' then
    select * into v_event
      from public.events
      where id      = p_event_id
        and club_id = v_profile.club_id
        and status  = 'scheduled';

    if found then
      insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
      values (
        v_profile.club_id,
        auth.uid(),
        'leave_offered_spot',
        'event',
        p_event_id,
        jsonb_build_object('event_title', v_event.title)
      );

      select public.expire_stale_offers_for_event(p_event_id, v_profile.club_id, v_event.title, auth.uid())
        into v_expire_result;
      select public.advance_waitlist_offer(p_event_id, v_profile.club_id, v_event.title, auth.uid())
        into v_advance_result;

      v_final_result := case
        when (v_expire_result->>'offered_profile_id') is not null then v_expire_result
        else v_advance_result
      end;
    end if;

  else
    return v_final_result;
  end if;

  return v_final_result;
end;
$$;

revoke execute on function public._leave_event_impl(uuid) from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. admin_remove_participant — CREATE OR REPLACE, ONE new guarded block
-- ═══════════════════════════════════════════════════════════════════════════
-- Reproduced VERBATIM from its latest (and only) applied body (0136, lines
-- 1153-1213) with two additions: (a) the existing `select status into
-- v_old_status` is widened to also capture the participant row's own id
-- (`select id, status into v_participant_id, v_old_status`) — necessary
-- because the guard's domain_id is event_participants.id, not profile_id,
-- and this function's original body never selected it; (b) the same
-- unconditional pre-mutation Checkout-invalidation block as section 5,
-- inserted immediately after that lookup and before the status UPDATE.
-- Every other check, computation, notification, and audit_log entry is
-- byte-identical to the currently-applied text.
create or replace function public.admin_remove_participant(p_event_id uuid, p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor      profiles%rowtype;
  v_event      events%rowtype;
  v_old_status text;
  -- Phase 34F-B: widened capture (see header) + pre-mutation Stripe
  -- Checkout invalidation.
  v_participant_id uuid;
  v_payment_id_for_checkout_guard uuid;
begin
  select * into v_actor from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_actor.role not in ('admin', 'pro', 'staff') then
    raise exception 'admin_required';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_actor.club_id
    for update;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  select id, status into v_participant_id, v_old_status
    from event_participants
    where event_id   = p_event_id
      and profile_id = p_profile_id
      and status     in ('confirmed', 'offered', 'waitlisted');
  if not found then raise exception 'participant_not_found'; end if;

  -- Phase 34F-B — pre-mutation Stripe Checkout invalidation, mirroring
  -- section 5's identical guard exactly.
  select p.id into v_payment_id_for_checkout_guard
    from public.payments p
   where p.club_id     = v_actor.club_id
     and p.domain_type  = 'event_participant'
     and p.domain_id    = v_participant_id
   order by p.obligation_cycle desc
   limit 1;
  if v_payment_id_for_checkout_guard is not null then
    perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);
  end if;

  update event_participants
    set status           = 'cancelled',
        offer_expires_at = null,
        updated_at       = now()
    where event_id   = p_event_id
      and profile_id = p_profile_id;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'admin_remove_participant',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_title',        v_event.title,
      'removed_profile_id', p_profile_id,
      'previous_status',    v_old_status
    )
  );

  if v_old_status in ('confirmed', 'offered') then
    perform expire_stale_offers_for_event(p_event_id, v_actor.club_id, v_event.title);
    perform advance_waitlist_offer(p_event_id, v_actor.club_id, v_event.title);
  end if;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. admin_remove_roster_participant — CREATE OR REPLACE, ONE new guarded
--    block
-- ═══════════════════════════════════════════════════════════════════════════
-- Reproduced VERBATIM from its latest applied body (0136, lines 1219-1279)
-- with exactly one addition: the same unconditional pre-mutation Checkout-
-- invalidation block as sections 5/6, inserted immediately after the
-- existing lookup (which already captures v_participant_id) and before the
-- status UPDATE. No widening needed here — this function's body already
-- selects the participant's own id. Every other check, computation,
-- notification, and audit_log entry is byte-identical to the
-- currently-applied text.
create or replace function public.admin_remove_roster_participant(p_event_id uuid, p_expected_club_id uuid, p_roster_member_id uuid)
returns event_participants
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id      uuid;
  v_role         text;
  v_event        public.events%rowtype;
  v_participant_id uuid;
  v_old_status   text;
  v_result       public.event_participants%rowtype;
  -- Phase 34F-B: pre-mutation Stripe Checkout invalidation.
  v_payment_id_for_checkout_guard uuid;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is null or v_role not in ('admin', 'pro', 'staff') then raise exception 'admin_required'; end if;

  select * into v_event
    from public.events
   where id      = p_event_id
     and club_id = v_club_id
   for update;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  select id, status into v_participant_id, v_old_status
    from public.event_participants
   where event_id         = p_event_id
     and roster_member_id = p_roster_member_id
     and status            in ('confirmed', 'waitlisted', 'offered');
  if not found then raise exception 'participant_not_found'; end if;

  -- Phase 34F-B — pre-mutation Stripe Checkout invalidation, mirroring
  -- sections 5/6's identical guard exactly.
  select p.id into v_payment_id_for_checkout_guard
    from public.payments p
   where p.club_id     = v_club_id
     and p.domain_type  = 'event_participant'
     and p.domain_id    = v_participant_id
   order by p.obligation_cycle desc
   limit 1;
  if v_payment_id_for_checkout_guard is not null then
    perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);
  end if;

  update public.event_participants
     set status           = 'cancelled',
         offer_expires_at = null,
         updated_at       = now()
   where id = v_participant_id
  returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'admin_remove_roster_participant', 'event', p_event_id,
    jsonb_build_object(
      'roster_member_id', p_roster_member_id,
      'previous_status',  v_old_status
    )
  );

  if v_old_status in ('confirmed', 'offered') then
    perform public.expire_stale_offers_for_event(p_event_id, v_club_id, v_event.title, auth.uid());
    perform public.advance_waitlist_offer(p_event_id, v_club_id, v_event.title, auth.uid());
  end if;

  return v_result;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. update_event — CREATE OR REPLACE, ONE new fan-out guarded block
-- ═══════════════════════════════════════════════════════════════════════════
-- Reproduced VERBATIM from its latest applied body (0136, lines 151-431)
-- with exactly one addition: a new v_payment_material_change local and,
-- immediately after v_changed_fields/v_court_set_changed/v_time_changed are
-- computed AND the existing "no fields changed -> early return" check has
-- already passed (so a genuine no-op edit never even reaches the guard),
-- BEFORE the first mutating statement (the reservations UPDATE for
-- v_time_changed), a loop over every CURRENTLY confirmed participant's
-- latest payment calling the same _invalidate_or_flag_open_checkout_attempt
-- helper sections 5-7 use — the Event-level fan-out case this migration's
-- own header documents. Material per the locked rule: starts_at, ends_at,
-- the court SET (v_court_set_changed, already computed), or event_type_id.
-- Deliberately excludes title/capacity/description — none of those are
-- ever displayed on the Stripe-hosted Checkout page (see this file's own
-- header), and set_event_price_override (0141, untouched) already never
-- reprices an existing participant's own snapshot, so there is no price
-- dimension to guard here at all. If ANY confirmed participant has a
-- bound, possibly-still-payable Session, the ENTIRE edit rolls back before
-- any of the mutating statements below run — the calling Server Action
-- (updateEventAdmin, admin/events/actions.ts) performs the bounded
-- preflight-list -> resolve-each -> retry flow this migration's header
-- describes, reusing list_event_blocking_checkout_attempts (section 4) and
-- the existing resolveBlockingCheckoutBeforeMutation helper unchanged.
-- Every other check, computation, mutation, notification, and audit_log
-- entry below is byte-identical to the currently-applied text.
create or replace function public.update_event(p_event_id uuid, p_expected_club_id uuid, p_expected_updated_at timestamp with time zone, p_title text, p_event_type_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_court_ids uuid[], p_capacity integer, p_description text DEFAULT NULL::text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
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
  -- Phase 34F-B: material-edit fan-out Stripe Checkout invalidation.
  v_payment_material_change boolean;
  v_payment_id_for_checkout_guard uuid;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is distinct from 'admin' and v_role is distinct from 'staff' then raise exception 'insufficient_role'; end if;

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

  -- Phase 34F-B — material-edit fan-out Stripe Checkout invalidation. Only
  -- starts_at/ends_at/court-set/event_type_id count as material (see this
  -- file's own header for the Stripe-display evidence behind excluding
  -- title/capacity/description). Runs BEFORE any mutating statement below
  -- — an invalid edit must never expire a legitimate Checkout Session
  -- before Court Time even knows the requested edit would fail.
  v_payment_material_change :=
    v_time_changed
    or v_court_set_changed
    or (p_event_type_id is distinct from v_before.event_type_id);

  if v_payment_material_change then
    for v_payment_id_for_checkout_guard in
      select distinct on (p.domain_id) p.id
        from event_participants ep
        join payments p
          on p.club_id     = v_club_id
         and p.domain_type = 'event_participant'
         and p.domain_id   = ep.id
       where ep.event_id = p_event_id
         and ep.status   = 'confirmed'
       order by p.domain_id, p.obligation_cycle desc
    loop
      perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);
    end loop;
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

-- ═══════════════════════════════════════════════════════════════════════════
-- 9. cancel_event — CREATE OR REPLACE, TWO intentional deltas from its
--    latest applied body (0136, lines 438-545) — reproduced VERBATIM
--    otherwise; every other check, computation, mutation, notification,
--    and audit_log entry below is byte-identical to the currently-applied
--    text.
-- ═══════════════════════════════════════════════════════════════════════════
-- DELTA 1 — FOR UPDATE added to the authoritative Event lookup (runtime QA
-- correction, this round). The 0136 body never locked the events row here
-- at all — a real gap once delta 2 (below) exists: every OTHER Event
-- mutation this migration touches (open_event_payment_checkout_attempt,
-- supersede_event_checkout_attempt_and_open_fresh, update_event,
-- _leave_event_impl, admin_remove_participant, admin_remove_roster_
-- participant) already locks events FIRST, before doing anything else.
-- Without this lock, a concurrent open_event_payment_checkout_attempt
-- could acquire the events lock, open a fresh Checkout attempt, and commit
-- AFTER delta 2's own fan-out scan already found nothing blocking but
-- BEFORE the events UPDATE below — cancelling the Event while leaving a
-- genuinely payable Session live, silently violating the very invariant
-- delta 2 exists to enforce. See the lock statement's own inline comment
-- for the full race-ordering proof (both directions).
--
-- DELTA 2 — fan-out pre-mutation Stripe Checkout invalidation: immediately
-- after v_affected_roster_ids is captured (which already, pre-mutation,
-- selects every confirmed/waitlisted/offered participant) and BEFORE the
-- events status UPDATE, a loop over every CURRENTLY confirmed
-- participant's latest payment, identical in shape to update_event's own
-- new block (section 8). If ANY confirmed participant has a bound,
-- possibly-still-payable Session, the ENTIRE cancellation rolls back
-- before any mutating statement below runs — the calling Server Action
-- (cancelEvent, calendar/actions.ts) performs the same bounded preflight-
-- list -> resolve-each -> retry flow as updateEventAdmin (section 8's own
-- comment), reusing list_event_blocking_checkout_attempts (section 4)
-- unchanged.
--
-- The rollback documentation at the bottom of this file restores the
-- EXACT pre-0161 body — WITHOUT either delta — proving rollback equality
-- against authoritative 0136, not against this round's corrected forward
-- definition.
create or replace function public.cancel_event(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_profile               public.profiles%rowtype;
  v_event                 public.events%rowtype;
  v_result                public.events%rowtype;
  v_affected_roster_ids   uuid[];
  v_affected_member_ids   uuid[];
  v_notifications         jsonb;
  -- Phase 34F-B: fan-out pre-mutation Stripe Checkout invalidation.
  v_payment_id_for_checkout_guard uuid;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  -- Phase 34F-B delta 1 of 2 (concurrency correction) — FOR UPDATE added to
  -- this authoritative Event lookup. The pre-0161 body (see this file's own
  -- rollback documentation below, restored WITHOUT this lock) never held
  -- the Event row lock here at all. Every OTHER Event mutation this
  -- migration touches or introduces (open_event_payment_checkout_attempt,
  -- supersede_event_checkout_attempt_and_open_fresh, update_event,
  -- _leave_event_impl, admin_remove_participant, admin_remove_roster_
  -- participant) already locks events FIRST, before doing anything else —
  -- cancel_event's own fan-out stale-Checkout guard (delta 2 of 2,
  -- immediately below) is meaningless without the SAME lock: without it, a
  -- concurrent open_event_payment_checkout_attempt could acquire the Event
  -- lock, open a fresh Checkout attempt, and commit AFTER this function's
  -- own fan-out scan already found nothing blocking but BEFORE the events
  -- UPDATE below — cancelling the Event while leaving a genuinely payable
  -- Session live. Locking here first makes the two races resolve exactly
  -- like every sibling guard's own header already documents: whichever
  -- side wins the events row lock first, the other blocks and then either
  -- observes the now-cancelled Event (Checkout wrapper's own event_not_
  -- scheduled check) or observes the newly-opened attempt (this function's
  -- fan-out scan, running after re-acquiring the lock) and fails closed via
  -- _invalidate_or_flag_open_checkout_attempt's own open_checkout_
  -- requires_resolution path.
  select * into v_event
    from public.events
    where id      = p_event_id
      and club_id = v_profile.club_id
      and status  = 'scheduled'
    for update;
  if not found then raise exception 'event_not_found'; end if;

  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  if v_profile.role is distinct from 'admin' and v_profile.role is distinct from 'pro' and v_profile.role is distinct from 'staff' then
    raise exception 'insufficient_role';
  end if;

  if v_profile.role = 'pro' and v_event.created_by is distinct from auth.uid() then
    raise exception 'insufficient_role';
  end if;

  -- Capture the exact affected roster identity set BEFORE any participant
  -- status mutation runs — same ordering-safety reasoning as before
  -- (0102), now keyed by the durable roster_member_id (NOT NULL) rather
  -- than the possibly-null profile_id.
  select coalesce(array_agg(roster_member_id), '{}') into v_affected_roster_ids
    from public.event_participants
    where event_id = p_event_id
      and status   in ('confirmed', 'waitlisted', 'offered');

  -- Phase 34F-B delta 2 of 2 — fan-out pre-mutation Stripe Checkout
  -- invalidation. Mirrors update_event's identical new block (section 8)
  -- exactly — see this migration's own header for the full event-
  -- cancellation-fan-out design. Now genuinely serialized against a
  -- concurrent Checkout attempt-open by the events row lock acquired
  -- above (delta 1 of 2) — see that lock's own comment for the exact race
  -- this closes.
  for v_payment_id_for_checkout_guard in
    select distinct on (p.domain_id) p.id
      from event_participants ep
      join payments p
        on p.club_id     = v_profile.club_id
       and p.domain_type = 'event_participant'
       and p.domain_id   = ep.id
     where ep.event_id = p_event_id
       and ep.status   = 'confirmed'
     order by p.domain_id, p.obligation_cycle desc
  loop
    perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);
  end loop;

  update public.events
    set status = 'cancelled', updated_at = now()
    where id = p_event_id
    returning * into v_result;

  update public.reservations set
    status            = 'cancelled',
    cancelled_at      = now(),
    cancelled_by      = auth.uid(),
    cancellation_kind = 'admin',
    updated_at        = now()
  where event_id = p_event_id
    and status in ('pending', 'confirmed');

  update public.event_participants
    set status           = 'cancelled',
        offer_expires_at = null,
        updated_at       = now()
    where event_id = p_event_id
      and status   = 'offered';

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'cancel_event',
    'event',
    p_event_id,
    jsonb_build_object('title', v_event.title, 'starts_at', v_event.starts_at)
  );

  -- Phase 33D2: resolve CURRENT accounts fresh via roster_members.
  -- claimed_by, filtering out still-unclaimed identities BEFORE the
  -- notification insert — this is what makes the NULL-user_id crash
  -- structurally impossible, rather than relying on a NOT NULL roster_
  -- member_id guarantee upstream alone.
  select coalesce(array_agg(claimed_by), '{}') into v_affected_member_ids
    from public.roster_members
    where id = any(v_affected_roster_ids)
      and claimed_by is not null;

  with ins as (
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    select
      v_event.club_id,
      mid,
      'event_cancelled',
      '"' || v_event.title || '" has been cancelled.',
      jsonb_build_object('event_id', p_event_id)
    from unnest(v_affected_member_ids) as mid
    returning id, user_id
  )
  select coalesce(
    jsonb_agg(jsonb_build_object('notification_id', id, 'user_id', user_id)),
    '[]'::jsonb
  )
  into v_notifications
  from ins;

  return jsonb_build_object(
    'event',         to_jsonb(v_result),
    'notifications', v_notifications
  );
end;
$$;

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
-- drop function if exists public.get_event_payment_for_checkout(uuid);
-- drop function if exists public.open_event_payment_checkout_attempt(uuid, uuid, text, boolean, uuid);
-- drop function if exists public.supersede_event_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid);
-- drop function if exists public.list_event_blocking_checkout_attempts(uuid, uuid);
-- commit;
--
-- Sections 5-9 restore each function to its EXACT pre-0161 authoritative
-- body — byte-identical to the currently-applied text (0127 for section 5,
-- 0136 for sections 6-9), proving rollback equality against those specific
-- migrations' own text.
--
-- begin;
--
-- create or replace function public._leave_event_impl(p_event_id uuid)
-- returns jsonb   -- { offered_profile_id: uuid | null, notification_id: uuid | null }
-- language plpgsql
-- security definer
-- set search_path = public, pg_temp
-- as $$
-- declare
--   v_profile        public.profiles%rowtype;
--   v_event          public.events%rowtype;
--   v_old_status     text;
--   v_participant_id uuid;
--   v_roster_member_id uuid;
--   v_expire_result  jsonb;
--   v_advance_result jsonb;
--   v_final_result   jsonb := jsonb_build_object('offered_profile_id', null, 'notification_id', null);
-- begin
--   select * into v_profile from public.profiles where id = auth.uid();
--   if not found then raise exception 'not_authenticated'; end if;
--
--   select * into v_event
--     from public.events
--     where id      = p_event_id
--       and club_id = v_profile.club_id
--     for update;
--   if found and v_event.archived_at is not null then
--     raise exception 'event_archived';
--   end if;
--
--   select id into v_roster_member_id
--     from public.roster_members
--    where club_id    = v_profile.club_id
--      and claimed_by = auth.uid();
--
--   select id, status into v_participant_id, v_old_status
--     from public.event_participants
--     where event_id = p_event_id
--       and status    in ('confirmed', 'waitlisted', 'offered')
--       and (
--         profile_id = auth.uid()
--         or (v_roster_member_id is not null and roster_member_id = v_roster_member_id)
--       );
--   if not found then raise exception 'not_joined'; end if;
--
--   update public.event_participants
--     set status           = 'cancelled',
--         offer_expires_at = null,
--         updated_at       = now()
--     where id = v_participant_id;
--
--   if v_old_status = 'confirmed' then
--     select * into v_event
--       from public.events
--       where id      = p_event_id
--         and club_id = v_profile.club_id
--         and status  = 'scheduled';
--
--     if found then
--       select public.expire_stale_offers_for_event(p_event_id, v_profile.club_id, v_event.title, auth.uid())
--         into v_expire_result;
--       select public.advance_waitlist_offer(p_event_id, v_profile.club_id, v_event.title, auth.uid())
--         into v_advance_result;
--
--       v_final_result := case
--         when (v_expire_result->>'offered_profile_id') is not null then v_expire_result
--         else v_advance_result
--       end;
--     end if;
--
--   elsif v_old_status = 'offered' then
--     select * into v_event
--       from public.events
--       where id      = p_event_id
--         and club_id = v_profile.club_id
--         and status  = 'scheduled';
--
--     if found then
--       insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
--       values (
--         v_profile.club_id,
--         auth.uid(),
--         'leave_offered_spot',
--         'event',
--         p_event_id,
--         jsonb_build_object('event_title', v_event.title)
--       );
--
--       select public.expire_stale_offers_for_event(p_event_id, v_profile.club_id, v_event.title, auth.uid())
--         into v_expire_result;
--       select public.advance_waitlist_offer(p_event_id, v_profile.club_id, v_event.title, auth.uid())
--         into v_advance_result;
--
--       v_final_result := case
--         when (v_expire_result->>'offered_profile_id') is not null then v_expire_result
--         else v_advance_result
--       end;
--     end if;
--
--   else
--     return v_final_result;
--   end if;
--
--   return v_final_result;
-- end;
-- $$;
--
-- revoke execute on function public._leave_event_impl(uuid) from public, anon, authenticated;
--
-- CREATE OR REPLACE FUNCTION public.admin_remove_participant(p_event_id uuid, p_profile_id uuid)
--  RETURNS void
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public', 'pg_temp'
-- AS $function$
-- declare
--   v_actor      profiles%rowtype;
--   v_event      events%rowtype;
--   v_old_status text;
-- begin
--   select * into v_actor from profiles where id = auth.uid();
--   if not found then raise exception 'not_authenticated'; end if;
--
--   if v_actor.role not in ('admin', 'pro', 'staff') then
--     raise exception 'admin_required';
--   end if;
--
--   select * into v_event
--     from events
--     where id      = p_event_id
--       and club_id = v_actor.club_id
--     for update;
--   if not found then raise exception 'event_not_found'; end if;
--   if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
--   if v_event.archived_at is not null then raise exception 'event_archived'; end if;
--
--   select status into v_old_status
--     from event_participants
--     where event_id   = p_event_id
--       and profile_id = p_profile_id
--       and status     in ('confirmed', 'offered', 'waitlisted');
--   if not found then raise exception 'participant_not_found'; end if;
--
--   update event_participants
--     set status           = 'cancelled',
--         offer_expires_at = null,
--         updated_at       = now()
--     where event_id   = p_event_id
--       and profile_id = p_profile_id;
--
--   insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
--   values (
--     v_actor.club_id,
--     auth.uid(),
--     'admin_remove_participant',
--     'event',
--     p_event_id,
--     jsonb_build_object(
--       'event_title',        v_event.title,
--       'removed_profile_id', p_profile_id,
--       'previous_status',    v_old_status
--     )
--   );
--
--   if v_old_status in ('confirmed', 'offered') then
--     perform expire_stale_offers_for_event(p_event_id, v_actor.club_id, v_event.title);
--     perform advance_waitlist_offer(p_event_id, v_actor.club_id, v_event.title);
--   end if;
-- end;
-- $function$;
--
-- CREATE OR REPLACE FUNCTION public.admin_remove_roster_participant(p_event_id uuid, p_expected_club_id uuid, p_roster_member_id uuid)
--  RETURNS event_participants
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public', 'pg_temp'
-- AS $function$
-- declare
--   v_club_id      uuid;
--   v_role         text;
--   v_event        public.events%rowtype;
--   v_participant_id uuid;
--   v_old_status   text;
--   v_result       public.event_participants%rowtype;
-- begin
--   select public.current_user_club_id(), public.current_user_role()
--     into v_club_id, v_role;
--
--   if v_club_id is null then raise exception 'not_authenticated'; end if;
--   if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
--   if v_role is null or v_role not in ('admin', 'pro', 'staff') then raise exception 'admin_required'; end if;
--
--   select * into v_event
--     from public.events
--    where id      = p_event_id
--      and club_id = v_club_id
--    for update;
--   if not found then raise exception 'event_not_found'; end if;
--   if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
--   if v_event.archived_at is not null then raise exception 'event_archived'; end if;
--
--   select id, status into v_participant_id, v_old_status
--     from public.event_participants
--    where event_id         = p_event_id
--      and roster_member_id = p_roster_member_id
--      and status            in ('confirmed', 'waitlisted', 'offered');
--   if not found then raise exception 'participant_not_found'; end if;
--
--   update public.event_participants
--      set status           = 'cancelled',
--          offer_expires_at = null,
--          updated_at       = now()
--    where id = v_participant_id
--   returning * into v_result;
--
--   insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
--   values (
--     v_club_id, auth.uid(), 'admin_remove_roster_participant', 'event', p_event_id,
--     jsonb_build_object(
--       'roster_member_id', p_roster_member_id,
--       'previous_status',  v_old_status
--     )
--   );
--
--   if v_old_status in ('confirmed', 'offered') then
--     perform public.expire_stale_offers_for_event(p_event_id, v_club_id, v_event.title, auth.uid());
--     perform public.advance_waitlist_offer(p_event_id, v_club_id, v_event.title, auth.uid());
--   end if;
--
--   return v_result;
-- end;
-- $function$;
--
-- CREATE OR REPLACE FUNCTION public.update_event(p_event_id uuid, p_expected_club_id uuid, p_expected_updated_at timestamp with time zone, p_title text, p_event_type_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_court_ids uuid[], p_capacity integer, p_description text DEFAULT NULL::text)
--  RETURNS jsonb
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public', 'pg_temp'
-- AS $function$
-- declare
--   v_club_id              uuid;
--   v_role                 text;
--   v_before                events%rowtype;
--   v_after                 events%rowtype;
--   v_existing_court_ids    uuid[];
--   v_retained_ids          uuid[];
--   v_removed_ids           uuid[];
--   v_added_ids             uuid[];
--   v_court_id              uuid;
--   v_dup_count             int;
--   v_distinct_count        int;
--   v_time_changed          boolean;
--   v_court_set_changed     boolean;
--   v_occupied              int;
--   v_changed_fields        text[] := '{}';
--   v_canonical_notes       text;
--   v_audit_before          jsonb;
--   v_audit_after           jsonb;
--   v_notifications         jsonb := '[]'::jsonb;
--   v_notify_roster_member_id uuid;
--   v_notify_member_id     uuid;
--   v_new_notification_id   uuid;
--   v_exception_transitioned boolean;
-- begin
--   select public.current_user_club_id(), public.current_user_role()
--     into v_club_id, v_role;
--
--   if v_club_id is null then raise exception 'not_authenticated'; end if;
--   if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
--   if v_role is distinct from 'admin' and v_role is distinct from 'staff' then raise exception 'insufficient_role'; end if;
--
--   select * into v_before
--     from events
--     where id = p_event_id and club_id = v_club_id
--     for update;
--   if not found then raise exception 'event_not_found'; end if;
--
--   if v_before.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
--   if v_before.archived_at is not null then raise exception 'event_archived'; end if;
--   if v_before.starts_at <= now() then raise exception 'event_started'; end if;
--
--   if v_before.updated_at is distinct from p_expected_updated_at then
--     raise exception 'stale_edit_conflict';
--   end if;
--
--   if v_before.program_id is not null then
--     if p_title is distinct from v_before.title
--        or p_event_type_id is distinct from v_before.event_type_id
--        or p_description is distinct from v_before.description
--     then
--       raise exception 'program_session_field_not_editable';
--     end if;
--   end if;
--
--   if p_title is null or length(btrim(p_title)) = 0 then raise exception 'invalid_title'; end if;
--   if p_event_type_id is null then raise exception 'event_type_not_found'; end if;
--   if p_starts_at is null or p_ends_at is null then raise exception 'invalid_duration'; end if;
--
--   if p_court_ids is null or array_length(p_court_ids, 1) is null then
--     raise exception 'court_required';
--   end if;
--
--   select count(*), count(distinct c) into v_dup_count, v_distinct_count
--     from unnest(p_court_ids) as c;
--   if v_dup_count <> v_distinct_count then
--     raise exception 'duplicate_court_in_event';
--   end if;
--
--   if p_ends_at <= p_starts_at then raise exception 'invalid_duration'; end if;
--   if p_capacity is null or p_capacity <= 0 then raise exception 'invalid_capacity'; end if;
--
--   -- Capacity floor: confirmed/offered participants (role='participant') +
--   -- active guests only (Phase 33E2).
--   select
--     (select count(*) from event_participants
--        where event_id = p_event_id and status in ('confirmed', 'offered') and role = 'participant')
--     + (select count(*) from event_guests where event_id = p_event_id and status = 'active')
--     into v_occupied;
--
--   if p_capacity < v_occupied then raise exception 'capacity_below_participants'; end if;
--
--   if exists (
--     select 1 from unnest(p_court_ids) as t(id)
--     where not exists (
--       select 1 from courts c
--       where c.id = t.id and c.club_id = v_club_id and c.is_active = true
--     )
--   ) then
--     raise exception 'invalid_court';
--   end if;
--
--   with locked_res as (
--     select * from reservations
--     where event_id = p_event_id and reason = 'event' and status in ('pending', 'confirmed')
--     for update
--   )
--   select array_agg(court_id) into v_existing_court_ids from locked_res;
--   v_existing_court_ids := coalesce(v_existing_court_ids, '{}');
--
--   select notes into v_canonical_notes
--     from reservations
--     where event_id = p_event_id and reason = 'event' and status in ('pending', 'confirmed')
--     order by (notes is null), court_id
--     limit 1;
--
--   select coalesce(array_agg(c), '{}') into v_retained_ids
--     from unnest(v_existing_court_ids) c where c = any(p_court_ids);
--   select coalesce(array_agg(c), '{}') into v_removed_ids
--     from unnest(v_existing_court_ids) c where not (c = any(p_court_ids));
--   select coalesce(array_agg(c), '{}') into v_added_ids
--     from unnest(p_court_ids) c where not (c = any(v_existing_court_ids));
--
--   v_time_changed      := p_starts_at is distinct from v_before.starts_at
--                           or p_ends_at is distinct from v_before.ends_at;
--   v_court_set_changed := array_length(v_removed_ids, 1) is not null
--                           or array_length(v_added_ids, 1) is not null;
--
--   if p_title is distinct from v_before.title then
--     v_changed_fields := array_append(v_changed_fields, 'title');
--   end if;
--   if p_event_type_id is distinct from v_before.event_type_id then
--     v_changed_fields := array_append(v_changed_fields, 'event_type_id');
--   end if;
--   if p_starts_at is distinct from v_before.starts_at then
--     v_changed_fields := array_append(v_changed_fields, 'starts_at');
--   end if;
--   if p_ends_at is distinct from v_before.ends_at then
--     v_changed_fields := array_append(v_changed_fields, 'ends_at');
--   end if;
--   if p_capacity is distinct from v_before.capacity then
--     v_changed_fields := array_append(v_changed_fields, 'capacity');
--   end if;
--   if p_description is distinct from v_before.description then
--     v_changed_fields := array_append(v_changed_fields, 'description');
--   end if;
--   if v_court_set_changed then
--     v_changed_fields := array_append(v_changed_fields, 'court_ids');
--   end if;
--
--   if array_length(v_changed_fields, 1) is null then
--     return jsonb_build_object(
--       'event',          to_jsonb(v_before),
--       'changed_fields', to_jsonb(v_changed_fields),
--       'notifications',  '[]'::jsonb
--     );
--   end if;
--
--   if v_time_changed then
--     update reservations
--       set starts_at = p_starts_at, ends_at = p_ends_at, updated_at = now()
--       where event_id = p_event_id and reason = 'event' and status in ('pending', 'confirmed')
--         and court_id = any(v_retained_ids);
--   end if;
--
--   update reservations
--     set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
--         cancellation_kind = 'system', updated_at = now()
--     where event_id = p_event_id and reason = 'event' and status in ('pending', 'confirmed')
--       and court_id = any(v_removed_ids);
--
--   foreach v_court_id in array v_added_ids loop
--     insert into reservations (
--       club_id, court_id, owner_user_id, starts_at, ends_at, status, reason,
--       event_id, created_by, notes
--     ) values (
--       v_club_id, v_court_id, v_before.created_by, p_starts_at, p_ends_at, 'confirmed',
--       'event', p_event_id, v_before.created_by, v_canonical_notes
--     );
--   end loop;
--
--   v_exception_transitioned := (v_before.program_id is not null and v_before.is_program_exception = false);
--
--   if p_event_type_id is distinct from v_before.event_type_id then
--     update events set
--       title                 = p_title,
--       event_type_id         = p_event_type_id,
--       starts_at             = p_starts_at,
--       ends_at               = p_ends_at,
--       capacity              = p_capacity,
--       description           = p_description,
--       court_count           = array_length(p_court_ids, 1),
--       is_program_exception  = case when v_before.program_id is not null then true else v_before.is_program_exception end,
--       updated_at            = now()
--     where id = p_event_id
--     returning * into v_after;
--   else
--     update events set
--       title                 = p_title,
--       starts_at             = p_starts_at,
--       ends_at               = p_ends_at,
--       capacity              = p_capacity,
--       description           = p_description,
--       court_count           = array_length(p_court_ids, 1),
--       is_program_exception  = case when v_before.program_id is not null then true else v_before.is_program_exception end,
--       updated_at            = now()
--     where id = p_event_id
--     returning * into v_after;
--   end if;
--
--   v_audit_before := jsonb_build_object(
--     'title', v_before.title, 'event_type_id', v_before.event_type_id,
--     'starts_at', v_before.starts_at, 'ends_at', v_before.ends_at,
--     'capacity', v_before.capacity, 'description', v_before.description
--   );
--   v_audit_after := jsonb_build_object(
--     'title', v_after.title, 'event_type_id', v_after.event_type_id,
--     'starts_at', v_after.starts_at, 'ends_at', v_after.ends_at,
--     'capacity', v_after.capacity, 'description', v_after.description
--   );
--
--   insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
--   values (
--     v_club_id,
--     auth.uid(),
--     'update_event',
--     'event',
--     p_event_id,
--     jsonb_build_object(
--       'changed_fields',              v_changed_fields,
--       'before',                      v_audit_before,
--       'after',                       v_audit_after,
--       'program_id',                  v_before.program_id,
--       'is_program_exception_set',    v_exception_transitioned,
--       'old_court_ids',               to_jsonb(v_existing_court_ids),
--       'new_court_ids',               to_jsonb(p_court_ids)
--     )
--   );
--
--   if p_capacity > v_before.capacity then
--     perform expire_stale_offers_for_event(p_event_id, v_club_id, v_after.title);
--     perform advance_waitlist_offer(p_event_id, v_club_id, v_after.title);
--   end if;
--
--   if 'title' = any(v_changed_fields)
--      or 'event_type_id' = any(v_changed_fields)
--      or 'starts_at' = any(v_changed_fields)
--      or 'ends_at' = any(v_changed_fields)
--      or 'court_ids' = any(v_changed_fields)
--      or 'capacity' = any(v_changed_fields)
--   then
--     for v_notify_roster_member_id in
--       select roster_member_id from event_participants
--       where event_id = p_event_id and status in ('confirmed', 'waitlisted', 'offered')
--     loop
--       select claimed_by into v_notify_member_id
--         from roster_members
--        where id = v_notify_roster_member_id;
--
--       if v_notify_member_id is not null then
--         insert into notifications (club_id, user_id, kind, body, metadata)
--         values (
--           v_club_id,
--           v_notify_member_id,
--           'event_updated',
--           '"' || v_after.title || '" was updated — check the calendar for the latest details.',
--           jsonb_build_object('event_id', p_event_id)
--         )
--         returning id into v_new_notification_id;
--
--         v_notifications := v_notifications || jsonb_build_object(
--           'notification_id', v_new_notification_id,
--           'user_id',          v_notify_member_id
--         );
--       end if;
--     end loop;
--   end if;
--
--   return jsonb_build_object(
--     'event',          to_jsonb(v_after),
--     'changed_fields', to_jsonb(v_changed_fields),
--     'notifications',  v_notifications
--   );
-- end;
-- $function$;
--
-- CREATE OR REPLACE FUNCTION public.cancel_event(p_event_id uuid)
--  RETURNS jsonb
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public', 'pg_temp'
-- AS $function$
-- declare
--   v_profile               public.profiles%rowtype;
--   v_event                 public.events%rowtype;
--   v_result                public.events%rowtype;
--   v_affected_roster_ids   uuid[];
--   v_affected_member_ids   uuid[];
--   v_notifications         jsonb;
-- begin
--   select * into v_profile from public.profiles where id = auth.uid();
--   if not found then raise exception 'not_authenticated'; end if;
--
--   select * into v_event
--     from public.events
--     where id      = p_event_id
--       and club_id = v_profile.club_id
--       and status  = 'scheduled';
--   if not found then raise exception 'event_not_found'; end if;
--
--   if v_event.archived_at is not null then raise exception 'event_archived'; end if;
--
--   if v_profile.role is distinct from 'admin' and v_profile.role is distinct from 'pro' and v_profile.role is distinct from 'staff' then
--     raise exception 'insufficient_role';
--   end if;
--
--   if v_profile.role = 'pro' and v_event.created_by is distinct from auth.uid() then
--     raise exception 'insufficient_role';
--   end if;
--
--   -- Capture the exact affected roster identity set BEFORE any participant
--   -- status mutation runs — same ordering-safety reasoning as before
--   -- (0102), now keyed by the durable roster_member_id (NOT NULL) rather
--   -- than the possibly-null profile_id.
--   select coalesce(array_agg(roster_member_id), '{}') into v_affected_roster_ids
--     from public.event_participants
--     where event_id = p_event_id
--       and status   in ('confirmed', 'waitlisted', 'offered');
--
--   update public.events
--     set status = 'cancelled', updated_at = now()
--     where id = p_event_id
--     returning * into v_result;
--
--   update public.reservations set
--     status            = 'cancelled',
--     cancelled_at      = now(),
--     cancelled_by      = auth.uid(),
--     cancellation_kind = 'admin',
--     updated_at        = now()
--   where event_id = p_event_id
--     and status in ('pending', 'confirmed');
--
--   update public.event_participants
--     set status           = 'cancelled',
--         offer_expires_at = null,
--         updated_at       = now()
--     where event_id = p_event_id
--       and status   = 'offered';
--
--   insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
--   values (
--     v_profile.club_id,
--     auth.uid(),
--     'cancel_event',
--     'event',
--     p_event_id,
--     jsonb_build_object('title', v_event.title, 'starts_at', v_event.starts_at)
--   );
--
--   -- Phase 33D2: resolve CURRENT accounts fresh via roster_members.
--   -- claimed_by, filtering out still-unclaimed identities BEFORE the
--   -- notification insert — this is what makes the NULL-user_id crash
--   -- structurally impossible, rather than relying on a NOT NULL roster_
--   -- member_id guarantee upstream alone.
--   select coalesce(array_agg(claimed_by), '{}') into v_affected_member_ids
--     from public.roster_members
--     where id = any(v_affected_roster_ids)
--       and claimed_by is not null;
--
--   with ins as (
--     insert into public.notifications (club_id, user_id, kind, body, metadata)
--     select
--       v_event.club_id,
--       mid,
--       'event_cancelled',
--       '"' || v_event.title || '" has been cancelled.',
--       jsonb_build_object('event_id', p_event_id)
--     from unnest(v_affected_member_ids) as mid
--     returning id, user_id
--   )
--   select coalesce(
--     jsonb_agg(jsonb_build_object('notification_id', id, 'user_id', user_id)),
--     '[]'::jsonb
--   )
--   into v_notifications
--   from ins;
--
--   return jsonb_build_object(
--     'event',         to_jsonb(v_result),
--     'notifications', v_notifications
--   );
-- end;
-- $function$;
--
-- commit;
