-- 0159_lesson_online_payment_checkout.sql
-- Phase 34F-A — Lesson Online Payment Expansion.
--
-- REWRITE following a THIRD round of external review (0159 has never been
-- applied, so it is rewritten in place rather than superseded by a new
-- migration). The FIRST review round (already incorporated below,
-- unchanged) added the lesson_requests.status = 'confirmed' lifecycle gate
-- to get_lesson_payment_for_checkout and the pre-mutation Checkout
-- invalidation guard to cancel_lesson. The SECOND round closed two further
-- gaps:
--
--   BLOCKER 1 — a TOCTOU race between the eligibility READ (get_lesson_
--   payment_for_checkout) and the domain-agnostic, intentionally lesson-
--   unaware ATTEMPT-OPEN step (open_payment_checkout_attempt): a lesson
--   could be cancelled/rescheduled by a concurrent Pro/Admin action in the
--   gap between those two calls, letting a Stripe Checkout Session be
--   created for a lesson that is no longer confirmed. Fixed with two new,
--   tiny, service_role-only atomic wrappers (open_lesson_payment_checkout_
--   attempt / supersede_lesson_checkout_attempt_and_open_fresh) that lock
--   the lesson_requests row FIRST, re-verify status = 'confirmed' under
--   that lock, and only then delegate to the existing, UNMODIFIED
--   open_payment_checkout_attempt / supersede_checkout_attempt_and_open_
--   fresh for everything else — the shared attempt algorithm is reused
--   verbatim, never duplicated.
--
--   BLOCKER 2 — the full lifecycle-mutation audit (this migration's own
--   header, below) found propose_lesson_time (confirmed -> proposed, a
--   reschedule) was completely unguarded, and admin_update_member_lesson's
--   EXISTING 0151 guard omitted a pure Pro reassignment (v_pro_changed)
--   from its condition. Both fixed with the SAME established pattern:
--   reproduce the latest applied body exactly, add the minimal targeted
--   guard.
--
-- THIS (third) round closes one final gap in that same admin_update_
-- member_lesson guard: it still omitted v_scheduling_changed (court/
-- starts_at/ends_at). A direct admin edit that changes ONLY the court
-- and/or time of an already-'confirmed', already-Checkout-eligible lesson
-- (price unchanged) previously skipped the guard entirely, even though
-- date/time and court are material confirmed-lesson terms exactly like
-- price and instructor. Fixed the same way: one more condition added to
-- the same existing guard, in the same location, calling the same
-- _invalidate_or_flag_open_checkout_attempt helper. Not a pricing
-- change — the locked time/court/provider-only-edits-never-reprice
-- invariant is untouched.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- COMPLETE obligation-bearing lesson mutation audit (verified against the
-- LATEST applied definition of every RPC that can touch a lesson_requests
-- row already at, or leaving, 'confirmed' — not assumed)
-- ═══════════════════════════════════════════════════════════════════════════
-- A lesson_request's payment obligation is created EXACTLY ONCE, at first
-- confirmation (0144: admin_create_member_lesson, or accept_lesson_
-- proposal's non-reschedule branch) — never at pending/first-proposed.
--
--   * cancel_lesson (latest: 0132) — accepts 'confirmed' or 'proposed'-
--     with-linked-reservation, always ends 'cancelled'. GUARDED (prior
--     review round, unchanged here).
--   * decline_lesson_proposal (latest: 0111) — its reschedule branch
--     REVERTS status back to 'confirmed' (never cancels, never leaves a
--     confirmed lesson non-payable); its non-reschedule branch only ever
--     applies to a first-time 'proposed' request (no obligation exists
--     yet). No guard needed — directly re-verified this round.
--   * propose_lesson_time (latest: 0111) — accepts 'pending', 'proposed',
--     OR 'confirmed'; the 'confirmed' entry case is a genuine reschedule
--     (v_is_reschedule becomes true whenever linked_reservation_id is
--     set, which it always is once a lesson reaches 'confirmed') and ends
--     in 'proposed'. THIS is an obligation-bearing transition away from
--     Member-payable. GUARDED — new this round.
--   * reassign_lesson_provider (latest: 0132) — its own status gate is
--     `status not in ('pending','proposed') OR (status='proposed' AND
--     linked_reservation_id is not null)` -> raises invalid_status_for_
--     reassign. This STRUCTURALLY REJECTS both 'confirmed' and the
--     reschedule-flavored 'proposed' — the only two statuses that can
--     ever have an obligation. It is therefore unreachable for any
--     obligation-bearing lesson at all — proven by direct inspection, not
--     assumed. NOT modified; a regression test asserts this status gate
--     stays exactly this shape.
--   * admin_update_member_lesson (latest: 0151) — the ONLY way to directly
--     change the court, start/end time, or assigned Pro on an already-
--     'confirmed' lesson while it stays 'confirmed'. 0151's own guard was
--     `v_member_changed or price changed` — omitting BOTH v_pro_changed
--     (a pure provider-only reassignment) AND v_scheduling_changed (a pure
--     court/time-only edit), each independently reachable while price
--     stays unchanged (time/court/provider-only edits never reprice, per
--     0140's own locked pricing rule — confirmed by direct inspection).
--     Court, date/time, instructor, and price are ALL material confirmed-
--     lesson terms a Member's payment obligation depends on being
--     settled. FIXED — v_scheduling_changed and v_pro_changed both added
--     to the existing condition; the guard's location, the helper it
--     calls, and every other line of this function are unchanged.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply in Supabase SQL Editor (cloud only). NOT YET APPLIED.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. get_lesson_payment_for_checkout — Member-owned lesson_request read
-- ═══════════════════════════════════════════════════════════════════════════
-- UNCHANGED from the prior review round. Read-only. Returns at most one
-- row: the CALLER's own latest payment obligation for a lesson_request,
-- only when ALL of the following hold:
--   * the caller's CURRENT role is exactly 'member';
--   * the lesson_request's CURRENT status is exactly 'confirmed';
--   * the lesson_request and the resolved payment agree on club_id;
--   * its snapshotted roster_member_id matches the caller's own current
--     roster identity.
-- This remains a cheap, UI-facing eligibility gate and ownership read — it
-- is deliberately NOT the sole authority for the money-moving attempt-open
-- step (see section 3 below, BLOCKER 1's fix) precisely because a read in
-- one transaction cannot, by itself, close a race against a concurrent
-- write in another.
create or replace function public.get_lesson_payment_for_checkout(
  p_request_id uuid
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
  v_role              text;
  v_club_id           uuid;
  v_roster_member_id  uuid;
  v_request_status    text;
  v_request_club_id   uuid;
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

  select lr.status, lr.club_id into v_request_status, v_request_club_id
    from public.lesson_requests lr
   where lr.id      = p_request_id
     and lr.club_id = v_club_id;

  if not found or v_request_status <> 'confirmed' then
    return;
  end if;

  return query
    select p.id, p.club_id, p.amount_due_cents, p.amount_paid_cents, p.currency, p.status, p.payment_mode_at_creation
      from public.payments p
     where p.domain_type = 'lesson_request'
       and p.domain_id = p_request_id
       and p.roster_member_id = v_roster_member_id
       and p.club_id = v_request_club_id
     order by p.obligation_cycle desc
     limit 1;
end;
$$;

revoke execute on function public.get_lesson_payment_for_checkout(uuid) from public, anon;
grant  execute on function public.get_lesson_payment_for_checkout(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. open_lesson_payment_checkout_attempt — atomic lesson-aware wrapper
--    (BLOCKER 1 fix)
-- ═══════════════════════════════════════════════════════════════════════════
-- service_role-only, exactly like the underlying open_payment_checkout_
-- attempt it wraps — never callable from an authenticated browser session.
-- Closes the TOCTOU window between get_lesson_payment_for_checkout's own
-- read (above) and the actual attempt-opening step by making "verify
-- status = 'confirmed'" and "open/reuse the Checkout attempt" happen
-- inside ONE transaction, under ONE lock, rather than two separate calls a
-- concurrent mutation could interleave between.
--
-- Lock ordering matches every lesson-mutating RPC in this same migration
-- (cancel_lesson, propose_lesson_time, admin_update_member_lesson): lock
-- lesson_requests FIRST, exactly as their own `for update` select already
-- does as their first substantive step. Whichever side — this function, or
-- a concurrent lesson mutation — acquires that row lock first wins; the
-- other blocks until the first commits, then re-reads post-commit truth:
--   * If this function wins first: it opens/reuses the attempt and
--     commits (releasing the lesson_requests lock). A blocked concurrent
--     cancel_lesson/propose_lesson_time then proceeds, re-reads the
--     lesson (still 'confirmed' — this function never changes lesson
--     status), and its OWN existing guard correctly sees and invalidates
--     the just-opened attempt.
--   * If a concurrent mutation wins first: it changes the lesson's status
--     and commits. This function then proceeds, re-reads the lesson under
--     its own fresh lock, finds status <> 'confirmed', and raises
--     lesson_not_confirmed — no attempt is ever opened for a lesson that
--     is no longer eligible.
--
-- The underlying open_payment_checkout_attempt is NOT duplicated — this
-- function locks lesson_requests, resolves payment_id, then delegates the
-- entire remaining algorithm (fresh eligibility/amount re-derivation,
-- existing-open-attempt reuse/supersede-detection) to a single `select *
-- from public.open_payment_checkout_attempt(...)` call, still inside this
-- same transaction (its own `for update` lock on the payments row is
-- acquired on top of, not instead of, the lesson_requests lock already
-- held here — canonical order: lesson_request -> payment/checkout
-- machinery).
--
-- Never trusts client amount/currency/payment identity/lifecycle — every
-- argument here mirrors open_payment_checkout_attempt's own server-derived
-- parameter set exactly (p_stripe_account_id/p_livemode/p_actor_id are the
-- Server Action's own already-verified values, identical to the
-- reservation Checkout call site); payment_id itself is resolved HERE,
-- fresh, from the payments table — never accepted as a parameter, so a
-- caller cannot substitute a different payment for a given lesson.
create or replace function public.open_lesson_payment_checkout_attempt(
  p_request_id         uuid,
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
  v_request_status text;
  v_payment_id     uuid;
begin
  if p_request_id is null or p_club_id is null or p_stripe_account_id is null
     or p_livemode is null or p_actor_id is null then
    raise exception 'invalid_arguments';
  end if;

  select status into v_request_status
    from public.lesson_requests
   where id = p_request_id and club_id = p_club_id
   for update;

  if not found then
    raise exception 'lesson_not_found';
  end if;

  if v_request_status <> 'confirmed' then
    raise exception 'lesson_not_confirmed';
  end if;

  select id into v_payment_id
    from public.payments
   where club_id = p_club_id and domain_type = 'lesson_request' and domain_id = p_request_id
   order by obligation_cycle desc
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

revoke execute on function public.open_lesson_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) from public, anon, authenticated;
grant  execute on function public.open_lesson_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. supersede_lesson_checkout_attempt_and_open_fresh — atomic lesson-aware
--    wrapper (BLOCKER 1 fix, secondary attempt-opening call site)
-- ═══════════════════════════════════════════════════════════════════════════
-- The SAME race BLOCKER 1 closes for the primary attempt-open call site
-- (section 2) exists identically at the secondary one: after open_lesson_
-- payment_checkout_attempt returns action='must_expire_remote' (a stale
-- competing attempt exists) and the Server Action does an out-of-process
-- Stripe round-trip to resolve it, a concurrent mutation could cancel/
-- reschedule the lesson DURING that round-trip, before supersede_
-- checkout_attempt_and_open_fresh is called. Closed with the identical
-- lock-lesson-then-delegate pattern as section 2 — not a new mechanism,
-- the same one applied to the one other call site that opens/replaces an
-- attempt. Never duplicates supersede_checkout_attempt_and_open_fresh's
-- own algorithm.
create or replace function public.supersede_lesson_checkout_attempt_and_open_fresh(
  p_request_id         uuid,
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
  v_request_status text;
  v_payment_id     uuid;
begin
  if p_request_id is null or p_stale_attempt_id is null or p_club_id is null
     or p_stripe_account_id is null or p_livemode is null or p_actor_id is null then
    raise exception 'invalid_arguments';
  end if;

  select status into v_request_status
    from public.lesson_requests
   where id = p_request_id and club_id = p_club_id
   for update;

  if not found then
    raise exception 'lesson_not_found';
  end if;

  if v_request_status <> 'confirmed' then
    raise exception 'lesson_not_confirmed';
  end if;

  select id into v_payment_id
    from public.payments
   where club_id = p_club_id and domain_type = 'lesson_request' and domain_id = p_request_id
   order by obligation_cycle desc
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

revoke execute on function public.supersede_lesson_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid) from public, anon, authenticated;
grant  execute on function public.supersede_lesson_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. cancel_lesson — CREATE OR REPLACE, ONE new guarded block
-- ═══════════════════════════════════════════════════════════════════════════
-- UNCHANGED from the prior review round. Reproduced VERBATIM from its
-- latest applied body (0132) — every declaration, check, computation,
-- mutation, notification, and audit_log entry below is byte-identical to
-- the currently-applied text, with exactly one addition: the new v_
-- payment_id_for_checkout_guard declaration, and, immediately before the
-- first mutating UPDATE (after every existing status/window validation has
-- already passed), the same pre-mutation Stripe Checkout invalidation call
-- 0151 already wired into update_member_reservation/admin_update_member_
-- lesson.
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
  -- Phase 34F-A (external review correction): pre-mutation Stripe
  -- Checkout invalidation.
  v_payment_id_for_checkout_guard uuid;
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

  -- Phase 34F-A (external review correction) — pre-mutation Stripe
  -- Checkout invalidation, mirroring 0151's admin_update_member_lesson/
  -- update_member_reservation guard exactly. Reachable from BOTH of this
  -- function's two admitted entry statuses ('confirmed', and 'proposed'
  -- with a linked reservation — a reschedule proposal on an already-
  -- confirmed lesson); either can have an existing payment obligation
  -- (created once, at first confirmation, by accept_lesson_proposal/
  -- admin_create_member_lesson, 0144) and, on the confirmed path, a
  -- genuinely open Stripe Checkout attempt a Member started before this
  -- cancellation. Runs only after every status/window validation above has
  -- passed — an invalid cancel request must never expire a legitimate
  -- Stripe Checkout Session before Court Time even knows the requested
  -- action would fail. Still a pure DOMAIN mutation, never a money
  -- mutation: this call only ever cancels/flags a Checkout ATTEMPT row —
  -- it never touches payments.amount_due_cents/amount_paid_cents, never
  -- inserts a payment_events row, never refunds/waives/voids anything. If
  -- a bound Session may still be genuinely payable, _invalidate_or_flag_
  -- open_checkout_attempt raises open_checkout_requires_resolution and
  -- this entire cancellation rolls back — the calling Server Action
  -- (cancelLesson, lessons/actions.ts) resolves the remote Session via the
  -- established resolveBlockingCheckoutBeforeMutation handshake, then
  -- safely retries this exact call once.
  select id into v_payment_id_for_checkout_guard
    from public.payments
   where club_id = v_profile.club_id and domain_type = 'lesson_request' and domain_id = p_request_id
   order by obligation_cycle desc
   limit 1
   for update;
  if v_payment_id_for_checkout_guard is not null then
    perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);
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
-- 5. propose_lesson_time — CREATE OR REPLACE, ONE new guarded block
--    (BLOCKER 2 fix)
-- ═══════════════════════════════════════════════════════════════════════════
-- Reproduced VERBATIM from its latest applied body (0111 — no migration
-- after 0111 touches it; confirmed by direct inspection) — every
-- declaration, check, computation, mutation, notification, and audit_log
-- entry below is byte-identical to the currently-applied text, with
-- exactly one addition: the new v_payment_id_for_checkout_guard
-- declaration, and, immediately before the first mutating UPDATE (after
-- every existing status/optimistic-concurrency/scheduling/availability
-- validation has already passed), the SAME pre-mutation Stripe Checkout
-- invalidation call used in cancel_lesson/admin_update_member_lesson. Only
-- reachable at all when v_request.status was 'confirmed' at entry (the
-- 'pending'/first-time-'proposed' entry cases have no obligation yet, so
-- the guard is a harmless no-op for them — no per-entry-status branching
-- needed, matching cancel_lesson's own identical single-lookup design).
create or replace function public.propose_lesson_time(
  p_request_id            uuid,
  p_expected_updated_at   timestamptz,
  p_starts_at             timestamptz,
  p_ends_at               timestamptz,
  p_court_id              uuid default null
)
returns public.lesson_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile        public.profiles%rowtype;
  v_request        public.lesson_requests%rowtype;
  v_result         public.lesson_requests%rowtype;
  v_old_reservation public.reservations%rowtype;
  v_is_reschedule  boolean;
  v_tz             text;
  -- Phase 33D1 correction: the lesson's CURRENT roster claim state — never
  -- read from historical v_request.member_id, which is a point-in-time
  -- snapshot that is not rewritten when the underlying identity is later
  -- claimed.
  v_current_member_id uuid;
  -- Phase 34F-A (external review correction): pre-mutation Stripe
  -- Checkout invalidation.
  v_payment_id_for_checkout_guard uuid;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;
  if v_profile.role not in ('pro', 'admin') then raise exception 'insufficient_role'; end if;

  select * into v_request
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_profile.club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  -- Phase 33D1 correction: resolve the lesson's roster identity fresh and
  -- use ITS CURRENT claimed_by, not the historical v_request.member_id
  -- snapshot. A lesson created for a no-account Member who has since
  -- claimed their account is now correctly eligible for this negotiation
  -- cycle; one that is still genuinely unclaimed correctly is not. This
  -- RPC's negotiation cycle (propose → member accepts/declines)
  -- structurally requires an authenticated Member to respond — a Member
  -- with no CURRENT account has no session and can never call accept_
  -- lesson_proposal/decline_lesson_proposal — proceeding here would either
  -- strand the request in 'proposed' forever, or (see accept/decline's own
  -- fix) let a stale-vs-current identity mismatch admit the wrong caller.
  -- Direct edits for a still-unclaimed Member's lesson go through admin_
  -- update_member_lesson instead (Section F2).
  select claimed_by into v_current_member_id
    from public.roster_members
   where id = v_request.roster_member_id;

  if v_current_member_id is null then
    raise exception 'member_has_no_account';
  end if;

  if v_profile.role = 'pro' and v_request.pro_id <> auth.uid() then
    raise exception 'not_assigned_pro';
  end if;

  -- 'confirmed' begins a reschedule; a 'proposed' request whose
  -- linked_reservation_id is already set is an in-flight reschedule that
  -- may be revised again before the member responds.
  if v_request.status not in ('pending', 'proposed', 'confirmed') then
    raise exception 'invalid_status_for_propose';
  end if;

  -- Optimistic concurrency.
  if v_request.updated_at is distinct from p_expected_updated_at then
    raise exception 'stale_edit_conflict';
  end if;

  v_is_reschedule := v_request.linked_reservation_id is not null;

  -- Authoritative original confirmed lesson. Once a reschedule is pending,
  -- lesson_requests.proposed_starts_at holds the *new* candidate, not the
  -- original — the still-active linked reservation is the only reliable
  -- source of the currently-confirmed court/time.
  if v_is_reschedule then
    select * into v_old_reservation
      from public.reservations
     where id      = v_request.linked_reservation_id
       and club_id = v_profile.club_id
       and reason  = 'pro_lesson'
       and status  = 'confirmed'
     for update;
    if not found then raise exception 'linked_reservation_not_found'; end if;

    if v_old_reservation.starts_at <= now() then
      raise exception 'cannot_reschedule_started_lesson';
    end if;
  end if;

  if p_starts_at <= now() then raise exception 'cannot_propose_past_time'; end if;
  if p_ends_at   <= p_starts_at then raise exception 'invalid_duration'; end if;

  if round(extract(epoch from (p_ends_at - p_starts_at)) / 60)::int <> v_request.duration_minutes then
    raise exception 'duration_mismatch';
  end if;

  -- ── Preflight conflict validation ─────────────────────────────────────────
  -- The still-active original lesson (and only that reservation) is excluded
  -- from every check below, so it never conflicts with its own proposed
  -- replacement. No other reservation is excluded. This is a preflight
  -- convenience only — acceptance re-validates via the GiST exclusion
  -- constraint, which remains the final authority.

  if p_court_id is not null then
    if not exists (
      select 1 from public.courts
       where id        = p_court_id
         and club_id   = v_profile.club_id
         and is_active = true
    ) then
      raise exception 'court_not_found';
    end if;

    if exists (
      select 1 from public.reservations r
       where r.court_id = p_court_id
         and r.status   in ('pending', 'confirmed')
         and tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')
         and (r.id is distinct from v_request.linked_reservation_id)
    ) then
      raise exception 'court_conflict';
    end if;
  end if;

  -- Operating hours
  select timezone into v_tz from public.clubs where id = v_profile.club_id;
  perform public._lesson_check_operating_hours(
    v_profile.club_id,
    p_starts_at,
    p_ends_at,
    v_tz
  );

  -- Pro conflicts — excludes this request's own linked reservation (the
  -- pro's own currently-confirmed lesson) so a reschedule never
  -- self-conflicts.
  perform public._lesson_check_pro_availability(
    v_request.pro_id,
    p_starts_at,
    p_ends_at,
    v_request.id
  );

  -- Member conflicts — same self-exclusion. Phase 33D1 correction: uses
  -- v_current_member_id (the lesson's CURRENT roster claimed_by, resolved
  -- above — guaranteed non-null past the guard) rather than historical
  -- member_id, plus the durable roster_member_id for the widened,
  -- roster-aware conflict categories (Section M).
  perform public._lesson_check_member_availability(
    v_current_member_id,
    v_request.roster_member_id,
    p_starts_at,
    p_ends_at,
    v_request.id
  );

  -- Phase 34F-A (external review correction, BLOCKER 2) — pre-mutation
  -- Stripe Checkout invalidation, mirroring cancel_lesson's own identical
  -- pattern exactly. Runs only after every existing status/optimistic-
  -- concurrency/scheduling/operating-hours/pro/member-availability
  -- validation above has passed — an invalid proposal must never expire a
  -- legitimate Stripe Checkout Session before Court Time even knows the
  -- action would fail. A no-op when no payment obligation exists yet
  -- (the 'pending'/first-time-'proposed' entry cases). Still a pure
  -- DOMAIN mutation: never touches amount_due_cents/amount_paid_cents,
  -- never inserts a payment_events row, never refunds/waives/voids
  -- anything.
  select id into v_payment_id_for_checkout_guard
    from public.payments
   where club_id = v_profile.club_id and domain_type = 'lesson_request' and domain_id = p_request_id
   order by obligation_cycle desc
   limit 1
   for update;
  if v_payment_id_for_checkout_guard is not null then
    perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);
  end if;

  -- ── Commit ────────────────────────────────────────────────────────────────
  -- linked_reservation_id and confirmed_at are never in this SET list —
  -- the original confirmed reservation and its confirmation history are
  -- preserved untouched throughout the pending-proposal window.

  update public.lesson_requests
     set status             = 'proposed',
         proposed_starts_at = p_starts_at,
         proposed_ends_at   = p_ends_at,
         proposed_court_id  = p_court_id,
         last_actor_id      = auth.uid(),
         last_actor_role    = v_profile.role,
         updated_at         = now()
   where id = p_request_id
  returning * into v_result;

  -- Phase 33D1 correction: addressed to v_current_member_id (the CURRENT
  -- claimed_by, resolved above), not historical v_request.member_id —
  -- required for claim continuity (a lesson claimed after creation must
  -- notify the now-current account, and this is also what avoids a
  -- NOT NULL user_id crash for a still-unclaimed row, which the guard
  -- above already prevents reaching this point at all).
  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    v_current_member_id,
    'lesson_request_proposed',
    trim(coalesce(v_profile.first_name, '') || ' ' || coalesce(v_profile.last_name, '')) ||
      case when v_is_reschedule
           then ' proposed a new time for your confirmed lesson. Please review and respond.'
           else ' proposed a time for your lesson. Please review and respond.'
      end,
    jsonb_build_object('request_id', p_request_id, 'target_path', '/lessons')
  );

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'propose_lesson_time', 'lesson_request', p_request_id,
    jsonb_build_object(
      'proposed_starts_at', p_starts_at,
      'proposed_ends_at',   p_ends_at,
      'court_id',           p_court_id,
      'is_reschedule',      v_is_reschedule
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.propose_lesson_time(uuid, timestamptz, timestamptz, timestamptz, uuid) from public, anon;
grant  execute on function public.propose_lesson_time(uuid, timestamptz, timestamptz, timestamptz, uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. admin_update_member_lesson — CREATE OR REPLACE, guard condition
--    widened to cover scheduling + provider changes (BLOCKER 2 + final
--    delta)
-- ═══════════════════════════════════════════════════════════════════════════
-- Reproduced VERBATIM from its latest applied body (0151, itself already a
-- reproduction of 0144's body with the member/price Checkout-invalidation
-- guard added) — every declaration, check, computation, mutation,
-- notification, and audit_log entry below is byte-identical to the
-- currently-applied text, with exactly the existing pre-mutation Checkout-
-- invalidation guard's condition changed:
--   `if v_member_changed or v_price_amount_cents is distinct from v_before.price_amount_cents then`
-- becomes
--   `if v_scheduling_changed or v_member_changed or v_pro_changed or v_price_amount_cents is distinct from v_before.price_amount_cents then`
-- A pure court/time-only edit (v_scheduling_changed) or a pure Pro-only
-- reassignment (v_pro_changed) — either alone, price otherwise unchanged —
-- previously skipped this guard entirely. Court, date/time, and instructor
-- are all material confirmed-lesson terms a Member's payment obligation
-- depends on being settled, exactly like the priced amount already
-- guarded here — 0151's own comment already documented the broader intent
-- ("Runs whenever this edit is about to reassign the Member or change the
-- priced amount") but its actual condition implemented neither the
-- scheduling nor the Pro-reassignment half of that intent. This is NOT a
-- pricing change: the existing time/court/provider-only-edits-never-
-- reprice invariant above is completely untouched — this guard only ever
-- invalidates/flags a Checkout ATTEMPT. Nothing else about this function
-- changes: the guard still runs in the exact same place (after every
-- existing validation, before the reservation/lesson_requests UPDATEs),
-- still resolves the SAME payment id the SAME way, still calls the SAME
-- _invalidate_or_flag_open_checkout_attempt helper.
create or replace function public.admin_update_member_lesson(p_request_id uuid, p_expected_club_id uuid, p_expected_updated_at timestamp with time zone, p_roster_member_id uuid, p_pro_id uuid, p_court_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_lesson_type_id uuid DEFAULT NULL::uuid, p_member_note text DEFAULT NULL::text)
 RETURNS lesson_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id           uuid;
  v_role              text;
  v_before            public.lesson_requests%rowtype;
  v_old_reservation   public.reservations%rowtype;
  v_roster            public.roster_members%rowtype;
  v_member_id         uuid;
  v_pro               public.profiles%rowtype;
  v_duration_minutes  int;
  v_tz                text;
  v_scheduling_changed boolean;
  v_member_changed     boolean;
  v_pro_changed        boolean;
  v_res_id             uuid;
  v_member_name        text;
  v_result             public.lesson_requests%rowtype;
  -- FINAL LESSON PRICING REFINEMENT: lesson-type-change re-snapshot, plus
  -- duration-only recompute for an hourly-priced Lesson whose type is
  -- unchanged.
  v_lesson_type_changed boolean;
  v_duration_changed     boolean;
  v_pricing_basis            text;
  v_unit_price_amount_cents  integer;
  v_price_amount_cents       integer;
  -- Phase 34E-A: pre-mutation Stripe Checkout invalidation.
  v_payment_id_for_checkout_guard uuid;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is null or v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;

  select * into v_before
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  if v_before.status <> 'confirmed' then raise exception 'invalid_status_for_edit'; end if;
  if v_before.updated_at is distinct from p_expected_updated_at then raise exception 'stale_edit_conflict'; end if;
  if v_before.linked_reservation_id is null then raise exception 'linked_reservation_not_found'; end if;

  select * into v_old_reservation
    from public.reservations
   where id      = v_before.linked_reservation_id
     and club_id = v_club_id
     and reason  = 'pro_lesson'
     and status  = 'confirmed'
   for update;
  if not found then raise exception 'linked_reservation_not_found'; end if;

  if v_old_reservation.starts_at <= now() then
    raise exception 'cannot_reschedule_started_lesson';
  end if;

  -- Resolve and validate the (possibly reassigned) target roster Member.
  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_club_id;
  if not found then raise exception 'roster_member_not_found'; end if;

  v_member_id   := v_roster.claimed_by;
  v_member_name := trim(coalesce(v_roster.first_name, '') || ' ' || coalesce(v_roster.last_name, ''));

  -- Validate (possibly reassigned) pro.
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

  -- FINAL LESSON PRICING REFINEMENT — full A/B/C-style edit invariants:
  --
  --  * lesson_type_id UNCHANGED, duration UNCHANGED (time/court/provider/
  --    member-only edits): preserve pricing_basis, unit price, and total
  --    exactly.
  --  * lesson_type_id UNCHANGED, duration CHANGED: preserve the existing
  --    pricing_basis + unit price snapshot. flat -> total stays exactly
  --    what it was (a flat Lesson price does not scale with duration).
  --    hourly -> recompute total from the PRESERVED unit rate times the
  --    NEW duration. A NULL preserved unit price always keeps the total
  --    NULL — never silently adopt today's Lesson Type rate merely because
  --    an existing Lesson's duration changed.
  --  * lesson_type_id CHANGES: snapshot the NEW type's CURRENT
  --    pricing_basis + unit price, and calculate a fresh total from the
  --    Lesson's current (possibly also-changed) duration — changing what
  --    is priced re-resolves from its current configuration, exactly like
  --    the reservation court-change rule. Changing to no Lesson Type at
  --    all (NULL) clears all three snapshot fields to NULL.
  v_lesson_type_changed := p_lesson_type_id is distinct from v_before.lesson_type_id;
  v_duration_changed    := v_duration_minutes is distinct from v_before.duration_minutes;

  if v_lesson_type_changed then
    if p_lesson_type_id is not null then
      select pricing_basis, unit_price_amount_cents
        into v_pricing_basis, v_unit_price_amount_cents
        from public.lesson_types where id = p_lesson_type_id;

      if v_pricing_basis = 'hourly' then
        if v_unit_price_amount_cents is not null then
          v_price_amount_cents := round(v_unit_price_amount_cents * v_duration_minutes / 60.0)::integer;
        else
          v_price_amount_cents := null;
        end if;
      else
        v_price_amount_cents := v_unit_price_amount_cents;
      end if;
    else
      v_pricing_basis           := null;
      v_unit_price_amount_cents := null;
      v_price_amount_cents      := null;
    end if;
  else
    v_pricing_basis           := v_before.pricing_basis;
    v_unit_price_amount_cents := v_before.unit_price_amount_cents;

    if v_duration_changed and v_pricing_basis = 'hourly' and v_unit_price_amount_cents is not null then
      v_price_amount_cents := round(v_unit_price_amount_cents * v_duration_minutes / 60.0)::integer;
    else
      v_price_amount_cents := v_before.price_amount_cents;
    end if;
  end if;

  if length(p_member_note) > 500 then raise exception 'note_too_long'; end if;

  v_scheduling_changed := (p_court_id, p_starts_at, p_ends_at)
    is distinct from (v_old_reservation.court_id, v_old_reservation.starts_at, v_old_reservation.ends_at);
  v_member_changed := p_roster_member_id is distinct from v_before.roster_member_id;
  v_pro_changed     := p_pro_id is distinct from v_before.pro_id;

  -- Phase 34C: a reassignment must not silently abandon or transfer an
  -- unresolved obligation. Checked before any mutation below.
  if v_member_changed then
    perform public._check_member_reassignment_allowed(v_club_id, 'lesson_request', p_request_id);
  end if;

  select timezone into v_tz from public.clubs where id = v_club_id;

  if v_scheduling_changed or v_pro_changed then

    -- Phase 33E3 fix: court-conflict pre-check, excluding this lesson's
    -- own currently-linked reservation — mirrors propose_lesson_time's
    -- already-live pattern. Without this, a genuine court double-book was
    -- only ever caught by the raw GiST EXCLUDE constraint on reservations,
    -- whose untranslated error text mapLessonError() cannot match, so the
    -- UI showed a generic "Something went wrong" instead of the friendly,
    -- already-mapped court_conflict message.
    if exists (
      select 1 from public.reservations r
       where r.court_id = p_court_id
         and r.status   in ('pending', 'confirmed')
         and tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')
         and r.id is distinct from v_old_reservation.id
    ) then
      raise exception 'court_conflict';
    end if;

    -- Time and/or pro changed — re-validate operating hours / pro /
    -- member conflicts, excluding this lesson's own still-active
    -- reservation, exactly like a self-service reschedule. Member check
    -- is unconditional (correction pass — see admin_create_member_
    -- lesson's header note above); p_roster_member_id always supplied.
    perform public._lesson_check_operating_hours(v_club_id, p_starts_at, p_ends_at, v_tz);
    perform public._lesson_check_pro_availability(p_pro_id, p_starts_at, p_ends_at, p_request_id);
    perform public._lesson_check_member_availability(v_member_id, p_roster_member_id, p_starts_at, p_ends_at, p_request_id);
  end if;

  -- Phase 34E-A (correction pass): pre-mutation Stripe Checkout
  -- invalidation. Moved here, AFTER every validation above (including the
  -- scheduling-conflict/operating-hours/pro/member-availability checks
  -- just above, which the original 34E-A placement ran BEFORE — an
  -- invalid edit that would go on to fail court_conflict or an
  -- availability check must never expire a legitimate Stripe Checkout
  -- Session first), but still strictly BEFORE any local mutation
  -- (reservation soft-cancel/insert/update, lesson_requests UPDATE)
  -- below.
  --
  -- Phase 34F-A (external review correction, BLOCKER 2 + final delta):
  -- v_scheduling_changed and v_pro_changed both added to this condition —
  -- a pure court/time-only edit or a pure Pro-only reassignment previously
  -- skipped this guard entirely, even though instructor, date/time, and
  -- court are all material confirmed-lesson terms a Member's payment
  -- obligation depends on being settled, exactly like the priced amount
  -- already guarded here. This is NOT a pricing change — the existing
  -- pricing invariants above (time/court/provider-only edits never
  -- reprice) are untouched; this guard only ever invalidates/flags a
  -- Checkout ATTEMPT, never adjusts amount_due_cents/amount_paid_cents.
  -- These four conditions (scheduling, member, pro, price) are the ONLY
  -- changes to this function versus its 0151 body.
  if v_scheduling_changed
     or v_member_changed
     or v_pro_changed
     or v_price_amount_cents is distinct from v_before.price_amount_cents
  then
    select id into v_payment_id_for_checkout_guard
      from public.payments
     where club_id = v_club_id and domain_type = 'lesson_request' and domain_id = p_request_id
     order by obligation_cycle desc
     limit 1
     for update;
    if v_payment_id_for_checkout_guard is not null then
      perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);
    end if;
  end if;

  if v_scheduling_changed then
    -- Soft-cancel the old reservation and insert a new one — mirrors
    -- accept_lesson_proposal's own reschedule pattern exactly. The new
    -- row's created_by is this admin: it is a genuinely new row, not a
    -- rewrite of the old one's created_by (which stays untouched on the
    -- now-cancelled row).
    update public.reservations
       set status            = 'cancelled',
           cancelled_at      = now(),
           cancelled_by      = auth.uid(),
           cancellation_kind = 'system',
           updated_at        = now()
     where id = v_old_reservation.id;

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
  elsif v_member_changed or v_pro_changed then
    -- Nothing time-related changed — update the existing reservation row
    -- directly in place (no history-losing replace) rather than the
    -- soft-cancel-and-reinsert pattern above, which is reserved for an
    -- actual scheduling change.
    update public.reservations
       set owner_user_id    = p_pro_id,
           roster_member_id = p_roster_member_id,
           notes            = 'Pro lesson with ' || v_member_name,
           updated_at       = now()
     where id = v_old_reservation.id;
    v_res_id := v_old_reservation.id;
  else
    v_res_id := v_old_reservation.id;
  end if;

  update public.lesson_requests
     set roster_member_id    = p_roster_member_id,
         member_id           = v_member_id,
         pro_id              = p_pro_id,
         duration_minutes    = v_duration_minutes,
         member_note         = btrim(coalesce(p_member_note, '')),
         lesson_type_id      = p_lesson_type_id,
         proposed_starts_at  = p_starts_at,
         proposed_ends_at    = p_ends_at,
         proposed_court_id   = p_court_id,
         linked_reservation_id = v_res_id,
         last_actor_id       = auth.uid(),
         last_actor_role     = v_role,
         pricing_basis           = v_pricing_basis,
         unit_price_amount_cents = v_unit_price_amount_cents,
         price_amount_cents      = v_price_amount_cents,
         updated_at          = now()
   where id = p_request_id
  returning * into v_result;

  -- Phase 34C: payment wiring, after the mutation, mirroring
  -- update_member_reservation's rule exactly, including the Phase 34C
  -- lifecycle correction: p_roster_member_id is passed as the CURRENT
  -- identity into _adjust_payment_obligation, which no-ops if the latest
  -- cycle belongs to a prior Member (reassigned while unpriced) rather
  -- than silently adjusting their historical payment. Member reassignment
  -- always gets an explicit new cycle for the new Member; otherwise a
  -- price change adjusts the current cycle (if any, and if the new total
  -- is not NULL) and ensures one exists.
  if v_member_changed then
    perform public._create_payment_obligation(
      v_club_id, 'lesson_request', p_request_id, p_roster_member_id,
      v_price_amount_cents, auth.uid(), true
    );
  elsif v_price_amount_cents is distinct from v_before.price_amount_cents then
    if v_price_amount_cents is not null then
      perform public._adjust_payment_obligation(v_club_id, 'lesson_request', p_request_id, p_roster_member_id, v_price_amount_cents, auth.uid());
    end if;
    perform public._create_payment_obligation(
      v_club_id, 'lesson_request', p_request_id, p_roster_member_id,
      v_price_amount_cents, auth.uid()
    );
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'admin_update_member_lesson', 'lesson_request', p_request_id,
    jsonb_build_object(
      'before', jsonb_build_object(
        'roster_member_id', v_before.roster_member_id,
        'member_id',        v_before.member_id,
        'pro_id',           v_before.pro_id,
        'court_id',         v_old_reservation.court_id,
        'starts_at',        v_old_reservation.starts_at,
        'ends_at',          v_old_reservation.ends_at,
        'lesson_type_id',   v_before.lesson_type_id,
        'pricing_basis',    v_before.pricing_basis,
        'unit_price_amount_cents', v_before.unit_price_amount_cents,
        'price_amount_cents', v_before.price_amount_cents
      ),
      'after', jsonb_build_object(
        'roster_member_id', p_roster_member_id,
        'member_id',        v_member_id,
        'pro_id',           p_pro_id,
        'court_id',         p_court_id,
        'starts_at',        p_starts_at,
        'ends_at',          p_ends_at,
        'lesson_type_id',   p_lesson_type_id,
        'pricing_basis',    v_pricing_basis,
        'unit_price_amount_cents', v_unit_price_amount_cents,
        'price_amount_cents', v_price_amount_cents
      ),
      'scheduling_changed', v_scheduling_changed,
      'member_changed',     v_member_changed,
      'pro_changed',        v_pro_changed,
      'lesson_type_changed', v_lesson_type_changed,
      'duration_changed',    v_duration_changed,
      'reservation_id',     v_res_id,
      'old_reservation_id', case when v_scheduling_changed then v_old_reservation.id else null end
    )
  );

  -- Notify pro — always, when the pro or the schedule changed (always has
  -- an account). Notify member only if claimed and something material
  -- changed. Reuses the existing lesson_request_confirmed kind — no new
  -- notification kind is introduced.
  if v_scheduling_changed or v_pro_changed then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id, p_pro_id, 'lesson_request_confirmed',
      'Lesson with ' || v_member_name || ' updated — now ' ||
        to_char(p_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM') || '.',
      jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id)
    );
  end if;

  if v_member_id is not null and (v_scheduling_changed or v_pro_changed or v_member_changed) then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id, v_member_id, 'lesson_request_confirmed',
      'Your lesson with ' ||
        trim(coalesce(v_pro.first_name, '') || ' ' || coalesce(v_pro.last_name, '')) ||
        ' is confirmed for ' || to_char(p_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM') || '.',
      jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id)
    );
  end if;

  return v_result;
end;
$function$;

-- admin_update_member_lesson carries no revoke/grant lines here, matching
-- both its 0144 and 0151 predecessors' own text — no migration in this
-- chain touches its permissions, established earlier and left untouched by
-- CREATE OR REPLACE.

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created)
-- ═══════════════════════════════════════════════════════════════════════════
-- begin;
--
-- drop function if exists public.get_lesson_payment_for_checkout(uuid);
-- drop function if exists public.open_lesson_payment_checkout_attempt(uuid, uuid, text, boolean, uuid);
-- drop function if exists public.supersede_lesson_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid);
--
-- -- Restores cancel_lesson to its exact pre-0159 (0132) body — byte-
-- -- identical to the reproduction above, minus the v_payment_id_for_
-- -- checkout_guard declaration and its guarded block.
-- create or replace function public.cancel_lesson(
--   p_request_id uuid,
--   p_reason     text default null
-- )
-- returns public.lesson_requests
-- language plpgsql
-- security definer
-- set search_path = public, pg_temp
-- as $$
-- declare
--   v_profile          public.profiles%rowtype;
--   v_request          public.lesson_requests%rowtype;
--   v_actor_role        text;
--   v_persisted_actor_role text;
--   v_result            public.lesson_requests%rowtype;
--   v_member             public.profiles%rowtype;
--   v_pro                public.profiles%rowtype;
--   v_window_hours       int;
--   v_old_reservation    public.reservations%rowtype;
--   v_effective_starts_at timestamptz;
--   v_caller_roster_id    uuid;
--   v_is_member_by_history boolean;
--   v_is_member_by_roster  boolean;
--   v_is_pro               boolean;
--   v_is_admin             boolean;
--   v_roster              public.roster_members%rowtype;
--   v_current_member_id   uuid;
-- begin
--   select * into v_profile from public.profiles where id = auth.uid();
--   if not found then raise exception 'not_authenticated'; end if;
--   if v_profile.club_id is null then raise exception 'no_club'; end if;
--
--   select * into v_request
--     from public.lesson_requests
--    where id      = p_request_id
--      and club_id = v_profile.club_id
--    for update;
--   if not found then raise exception 'request_not_found'; end if;
--
--   select id into v_caller_roster_id
--     from public.roster_members
--    where club_id    = v_profile.club_id
--      and claimed_by = auth.uid();
--
--   select * into v_roster from public.roster_members where id = v_request.roster_member_id;
--   v_current_member_id := v_roster.claimed_by;
--
--   v_is_member_by_history := v_request.member_id is not null and v_request.member_id = auth.uid();
--   v_is_member_by_roster  := v_caller_roster_id is not null and v_request.roster_member_id = v_caller_roster_id;
--   v_is_pro                := v_request.pro_id = auth.uid();
--   v_is_admin               := v_profile.role = 'admin';
--
--   if not (v_is_member_by_history or v_is_member_by_roster or v_is_pro or v_is_admin or v_profile.role = 'staff') then
--     raise exception 'not_authorised_to_cancel';
--   end if;
--
--   if not (
--     v_request.status = 'confirmed'
--     or (v_request.status = 'proposed' and v_request.linked_reservation_id is not null)
--   ) then
--     raise exception 'invalid_status_for_cancel';
--   end if;
--
--   if v_request.linked_reservation_id is not null then
--     select * into v_old_reservation
--       from public.reservations
--      where id      = v_request.linked_reservation_id
--        and club_id = v_profile.club_id
--        and reason  = 'pro_lesson'
--        and status  = 'confirmed'
--      for update;
--     if not found then raise exception 'linked_reservation_not_found'; end if;
--     v_effective_starts_at := v_old_reservation.starts_at;
--   else
--     v_effective_starts_at := v_request.proposed_starts_at;
--   end if;
--
--   if v_effective_starts_at <= now() and v_profile.role not in ('admin', 'staff') then
--     raise exception 'lesson_already_started';
--   end if;
--
--   v_actor_role := case
--     when v_profile.role = 'admin' then 'admin'
--     when auth.uid() = v_request.pro_id then 'pro'
--     when v_profile.role = 'staff' and not (v_is_member_by_history or v_is_member_by_roster) then 'admin'
--     else 'member'
--   end;
--
--   v_persisted_actor_role := case
--     when v_profile.role = 'admin' then 'admin'
--     when auth.uid() = v_request.pro_id then 'pro'
--     when v_profile.role = 'staff' and not (v_is_member_by_history or v_is_member_by_roster) then 'staff'
--     else 'member'
--   end;
--
--   if v_actor_role = 'member' then
--     select coalesce(cs.cancellation_window_hours, 24) into v_window_hours
--       from public.club_settings cs
--      where cs.club_id = v_profile.club_id;
--     if (extract(epoch from (v_effective_starts_at - now())) / 3600) < v_window_hours then
--       raise exception 'within_cancellation_window';
--     end if;
--   end if;
--
--   if v_request.linked_reservation_id is not null then
--     update public.reservations
--        set status            = 'cancelled',
--            cancelled_at      = now(),
--            cancelled_by      = auth.uid(),
--            cancellation_kind = case when v_actor_role = 'member' then 'member' else 'admin' end
--      where id = v_request.linked_reservation_id;
--   end if;
--
--   update public.lesson_requests
--      set status            = 'cancelled',
--          lesson_outcome    = 'cancelled',
--          cancellation_reason = p_reason,
--          cancelled_at        = now(),
--          last_actor_id        = auth.uid(),
--          last_actor_role      = v_persisted_actor_role,
--          proposed_starts_at   = null,
--          proposed_ends_at     = null,
--          proposed_court_id    = null,
--          updated_at           = now()
--    where id = p_request_id
--   returning * into v_result;
--
--   select * into v_member from public.profiles where id = v_current_member_id;
--   select * into v_pro     from public.profiles where id = v_request.pro_id;
--
--   if v_actor_role <> 'pro' and v_request.pro_id is not null then
--     insert into public.notifications (club_id, user_id, kind, body, metadata)
--     values (
--       v_profile.club_id,
--       v_request.pro_id,
--       'lesson_cancelled',
--       'Your lesson with '
--         || trim(coalesce(v_member.first_name, '') || ' ' || coalesce(v_member.last_name, ''))
--         || ' was cancelled.',
--       jsonb_build_object('request_id', p_request_id)
--     );
--   end if;
--
--   if v_actor_role <> 'member' and v_current_member_id is not null then
--     insert into public.notifications (club_id, user_id, kind, body, metadata)
--     values (
--       v_profile.club_id,
--       v_current_member_id,
--       'lesson_cancelled',
--       'Your lesson with '
--         || trim(coalesce(v_pro.first_name, '') || ' ' || coalesce(v_pro.last_name, ''))
--         || ' was cancelled.',
--       jsonb_build_object('request_id', p_request_id)
--     );
--   end if;
--
--   return v_result;
-- end;
-- $$;
--
-- revoke execute on function public.cancel_lesson(uuid, text) from public, anon;
-- grant  execute on function public.cancel_lesson(uuid, text) to authenticated;
--
-- -- Restores propose_lesson_time to its exact pre-0159 (0111) body — byte-
-- -- identical to the reproduction above, minus the v_payment_id_for_
-- -- checkout_guard declaration and its guarded block.
-- create or replace function public.propose_lesson_time(
--   p_request_id            uuid,
--   p_expected_updated_at   timestamptz,
--   p_starts_at             timestamptz,
--   p_ends_at               timestamptz,
--   p_court_id              uuid default null
-- )
-- returns public.lesson_requests
-- language plpgsql
-- security definer
-- set search_path = public, pg_temp
-- as $$
-- declare
--   v_profile        public.profiles%rowtype;
--   v_request        public.lesson_requests%rowtype;
--   v_result         public.lesson_requests%rowtype;
--   v_old_reservation public.reservations%rowtype;
--   v_is_reschedule  boolean;
--   v_tz             text;
--   v_current_member_id uuid;
-- begin
--   select * into v_profile from public.profiles where id = auth.uid();
--   if not found then raise exception 'not_authenticated'; end if;
--   if v_profile.club_id is null then raise exception 'no_club'; end if;
--   if v_profile.role not in ('pro', 'admin') then raise exception 'insufficient_role'; end if;
--
--   select * into v_request
--     from public.lesson_requests
--    where id      = p_request_id
--      and club_id = v_profile.club_id
--    for update;
--   if not found then raise exception 'request_not_found'; end if;
--
--   select claimed_by into v_current_member_id
--     from public.roster_members
--    where id = v_request.roster_member_id;
--
--   if v_current_member_id is null then
--     raise exception 'member_has_no_account';
--   end if;
--
--   if v_profile.role = 'pro' and v_request.pro_id <> auth.uid() then
--     raise exception 'not_assigned_pro';
--   end if;
--
--   if v_request.status not in ('pending', 'proposed', 'confirmed') then
--     raise exception 'invalid_status_for_propose';
--   end if;
--
--   if v_request.updated_at is distinct from p_expected_updated_at then
--     raise exception 'stale_edit_conflict';
--   end if;
--
--   v_is_reschedule := v_request.linked_reservation_id is not null;
--
--   if v_is_reschedule then
--     select * into v_old_reservation
--       from public.reservations
--      where id      = v_request.linked_reservation_id
--        and club_id = v_profile.club_id
--        and reason  = 'pro_lesson'
--        and status  = 'confirmed'
--      for update;
--     if not found then raise exception 'linked_reservation_not_found'; end if;
--
--     if v_old_reservation.starts_at <= now() then
--       raise exception 'cannot_reschedule_started_lesson';
--     end if;
--   end if;
--
--   if p_starts_at <= now() then raise exception 'cannot_propose_past_time'; end if;
--   if p_ends_at   <= p_starts_at then raise exception 'invalid_duration'; end if;
--
--   if round(extract(epoch from (p_ends_at - p_starts_at)) / 60)::int <> v_request.duration_minutes then
--     raise exception 'duration_mismatch';
--   end if;
--
--   if p_court_id is not null then
--     if not exists (
--       select 1 from public.courts
--        where id        = p_court_id
--          and club_id   = v_profile.club_id
--          and is_active = true
--     ) then
--       raise exception 'court_not_found';
--     end if;
--
--     if exists (
--       select 1 from public.reservations r
--        where r.court_id = p_court_id
--          and r.status   in ('pending', 'confirmed')
--          and tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')
--          and (r.id is distinct from v_request.linked_reservation_id)
--     ) then
--       raise exception 'court_conflict';
--     end if;
--   end if;
--
--   select timezone into v_tz from public.clubs where id = v_profile.club_id;
--   perform public._lesson_check_operating_hours(
--     v_profile.club_id,
--     p_starts_at,
--     p_ends_at,
--     v_tz
--   );
--
--   perform public._lesson_check_pro_availability(
--     v_request.pro_id,
--     p_starts_at,
--     p_ends_at,
--     v_request.id
--   );
--
--   perform public._lesson_check_member_availability(
--     v_current_member_id,
--     v_request.roster_member_id,
--     p_starts_at,
--     p_ends_at,
--     v_request.id
--   );
--
--   update public.lesson_requests
--      set status             = 'proposed',
--          proposed_starts_at = p_starts_at,
--          proposed_ends_at   = p_ends_at,
--          proposed_court_id  = p_court_id,
--          last_actor_id      = auth.uid(),
--          last_actor_role    = v_profile.role,
--          updated_at         = now()
--    where id = p_request_id
--   returning * into v_result;
--
--   insert into public.notifications (club_id, user_id, kind, body, metadata)
--   values (
--     v_profile.club_id,
--     v_current_member_id,
--     'lesson_request_proposed',
--     trim(coalesce(v_profile.first_name, '') || ' ' || coalesce(v_profile.last_name, '')) ||
--       case when v_is_reschedule
--            then ' proposed a new time for your confirmed lesson. Please review and respond.'
--            else ' proposed a time for your lesson. Please review and respond.'
--       end,
--     jsonb_build_object('request_id', p_request_id, 'target_path', '/lessons')
--   );
--
--   insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
--   values (
--     v_profile.club_id, auth.uid(), 'propose_lesson_time', 'lesson_request', p_request_id,
--     jsonb_build_object(
--       'proposed_starts_at', p_starts_at,
--       'proposed_ends_at',   p_ends_at,
--       'court_id',           p_court_id,
--       'is_reschedule',      v_is_reschedule
--     )
--   );
--
--   return v_result;
-- end;
-- $$;
--
-- revoke execute on function public.propose_lesson_time(uuid, timestamptz, timestamptz, timestamptz, uuid) from public, anon;
-- grant  execute on function public.propose_lesson_time(uuid, timestamptz, timestamptz, timestamptz, uuid) to authenticated;
--
-- -- Restores admin_update_member_lesson to its exact pre-0159 (0151) body
-- -- — byte-identical to the reproduction above, with the guard condition
-- -- reverted to its 0151 form (no v_scheduling_changed, no v_pro_changed):
-- create or replace function public.admin_update_member_lesson(p_request_id uuid, p_expected_club_id uuid, p_expected_updated_at timestamp with time zone, p_roster_member_id uuid, p_pro_id uuid, p_court_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_lesson_type_id uuid DEFAULT NULL::uuid, p_member_note text DEFAULT NULL::text)
--  RETURNS lesson_requests
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public', 'pg_temp'
-- AS $function$
-- declare
--   v_club_id           uuid;
--   v_role              text;
--   v_before            public.lesson_requests%rowtype;
--   v_old_reservation   public.reservations%rowtype;
--   v_roster            public.roster_members%rowtype;
--   v_member_id         uuid;
--   v_pro               public.profiles%rowtype;
--   v_duration_minutes  int;
--   v_tz                text;
--   v_scheduling_changed boolean;
--   v_member_changed     boolean;
--   v_pro_changed        boolean;
--   v_res_id             uuid;
--   v_member_name        text;
--   v_result             public.lesson_requests%rowtype;
--   -- FINAL LESSON PRICING REFINEMENT: lesson-type-change re-snapshot, plus
--   -- duration-only recompute for an hourly-priced Lesson whose type is
--   -- unchanged.
--   v_lesson_type_changed boolean;
--   v_duration_changed     boolean;
--   v_pricing_basis            text;
--   v_unit_price_amount_cents  integer;
--   v_price_amount_cents       integer;
--   -- Phase 34E-A: pre-mutation Stripe Checkout invalidation.
--   v_payment_id_for_checkout_guard uuid;
-- begin
--   select public.current_user_club_id(), public.current_user_role()
--     into v_club_id, v_role;
--
--   if v_club_id is null then raise exception 'not_authenticated'; end if;
--   if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
--   if v_role is null or v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;
--
--   select * into v_before
--     from public.lesson_requests
--    where id      = p_request_id
--      and club_id = v_club_id
--    for update;
--   if not found then raise exception 'request_not_found'; end if;
--
--   if v_before.status <> 'confirmed' then raise exception 'invalid_status_for_edit'; end if;
--   if v_before.updated_at is distinct from p_expected_updated_at then raise exception 'stale_edit_conflict'; end if;
--   if v_before.linked_reservation_id is null then raise exception 'linked_reservation_not_found'; end if;
--
--   select * into v_old_reservation
--     from public.reservations
--    where id      = v_before.linked_reservation_id
--      and club_id = v_club_id
--      and reason  = 'pro_lesson'
--      and status  = 'confirmed'
--    for update;
--   if not found then raise exception 'linked_reservation_not_found'; end if;
--
--   if v_old_reservation.starts_at <= now() then
--     raise exception 'cannot_reschedule_started_lesson';
--   end if;
--
--   -- Resolve and validate the (possibly reassigned) target roster Member.
--   select * into v_roster
--     from public.roster_members
--    where id      = p_roster_member_id
--      and club_id = v_club_id;
--   if not found then raise exception 'roster_member_not_found'; end if;
--
--   v_member_id   := v_roster.claimed_by;
--   v_member_name := trim(coalesce(v_roster.first_name, '') || ' ' || coalesce(v_roster.last_name, ''));
--
--   -- Validate (possibly reassigned) pro.
--   select * into v_pro
--     from public.profiles
--    where id                 = p_pro_id
--      and club_id            = v_club_id
--      and status              = 'active'
--      and role                in ('pro', 'admin', 'staff')
--      and is_lesson_provider  = true;
--   if not found then raise exception 'pro_not_found'; end if;
--
--   if v_member_id is not null and v_member_id = p_pro_id then
--     raise exception 'cannot_request_yourself';
--   end if;
--
--   if p_starts_at < now() then raise exception 'cannot_propose_past_time'; end if;
--   if p_ends_at  <= p_starts_at then raise exception 'invalid_duration'; end if;
--
--   v_duration_minutes := round(extract(epoch from (p_ends_at - p_starts_at)) / 60)::int;
--   if v_duration_minutes < 30 or v_duration_minutes % 15 <> 0 then
--     raise exception 'invalid_duration';
--   end if;
--
--   if not exists (
--     select 1 from public.courts
--      where id        = p_court_id
--        and club_id   = v_club_id
--        and is_active = true
--   ) then
--     raise exception 'court_not_found';
--   end if;
--
--   if p_lesson_type_id is not null then
--     if not exists (
--       select 1 from public.lesson_types lt
--        where lt.id        = p_lesson_type_id
--          and lt.club_id   = v_club_id
--          and lt.is_active = true
--     ) then
--       raise exception 'lesson_type_not_found';
--     end if;
--
--     if exists (
--       select 1 from public.lesson_types lt
--        where lt.id               = p_lesson_type_id
--          and lt.allowed_durations is not null
--          and array_length(lt.allowed_durations, 1) > 0
--          and not (v_duration_minutes = any(lt.allowed_durations))
--     ) then
--       raise exception 'duration_not_allowed_for_type';
--     end if;
--   end if;
--
--   -- FINAL LESSON PRICING REFINEMENT — full A/B/C-style edit invariants:
--   --
--   --  * lesson_type_id UNCHANGED, duration UNCHANGED (time/court/provider/
--   --    member-only edits): preserve pricing_basis, unit price, and total
--   --    exactly.
--   --  * lesson_type_id UNCHANGED, duration CHANGED: preserve the existing
--   --    pricing_basis + unit price snapshot. flat -> total stays exactly
--   --    what it was (a flat Lesson price does not scale with duration).
--   --    hourly -> recompute total from the PRESERVED unit rate times the
--   --    NEW duration. A NULL preserved unit price always keeps the total
--   --    NULL — never silently adopt today's Lesson Type rate merely because
--   --    an existing Lesson's duration changed.
--   --  * lesson_type_id CHANGES: snapshot the NEW type's CURRENT
--   --    pricing_basis + unit price, and calculate a fresh total from the
--   --    Lesson's current (possibly also-changed) duration — changing what
--   --    is priced re-resolves from its current configuration, exactly like
--   --    the reservation court-change rule. Changing to no Lesson Type at
--   --    all (NULL) clears all three snapshot fields to NULL.
--   v_lesson_type_changed := p_lesson_type_id is distinct from v_before.lesson_type_id;
--   v_duration_changed    := v_duration_minutes is distinct from v_before.duration_minutes;
--
--   if v_lesson_type_changed then
--     if p_lesson_type_id is not null then
--       select pricing_basis, unit_price_amount_cents
--         into v_pricing_basis, v_unit_price_amount_cents
--         from public.lesson_types where id = p_lesson_type_id;
--
--       if v_pricing_basis = 'hourly' then
--         if v_unit_price_amount_cents is not null then
--           v_price_amount_cents := round(v_unit_price_amount_cents * v_duration_minutes / 60.0)::integer;
--         else
--           v_price_amount_cents := null;
--         end if;
--       else
--         v_price_amount_cents := v_unit_price_amount_cents;
--       end if;
--     else
--       v_pricing_basis           := null;
--       v_unit_price_amount_cents := null;
--       v_price_amount_cents      := null;
--     end if;
--   else
--     v_pricing_basis           := v_before.pricing_basis;
--     v_unit_price_amount_cents := v_before.unit_price_amount_cents;
--
--     if v_duration_changed and v_pricing_basis = 'hourly' and v_unit_price_amount_cents is not null then
--       v_price_amount_cents := round(v_unit_price_amount_cents * v_duration_minutes / 60.0)::integer;
--     else
--       v_price_amount_cents := v_before.price_amount_cents;
--     end if;
--   end if;
--
--   if length(p_member_note) > 500 then raise exception 'note_too_long'; end if;
--
--   v_scheduling_changed := (p_court_id, p_starts_at, p_ends_at)
--     is distinct from (v_old_reservation.court_id, v_old_reservation.starts_at, v_old_reservation.ends_at);
--   v_member_changed := p_roster_member_id is distinct from v_before.roster_member_id;
--   v_pro_changed     := p_pro_id is distinct from v_before.pro_id;
--
--   -- Phase 34C: a reassignment must not silently abandon or transfer an
--   -- unresolved obligation. Checked before any mutation below.
--   if v_member_changed then
--     perform public._check_member_reassignment_allowed(v_club_id, 'lesson_request', p_request_id);
--   end if;
--
--   select timezone into v_tz from public.clubs where id = v_club_id;
--
--   if v_scheduling_changed or v_pro_changed then
--
--     -- Phase 33E3 fix: court-conflict pre-check, excluding this lesson's
--     -- own currently-linked reservation — mirrors propose_lesson_time's
--     -- already-live pattern. Without this, a genuine court double-book was
--     -- only ever caught by the raw GiST EXCLUDE constraint on reservations,
--     -- whose untranslated error text mapLessonError() cannot match, so the
--     -- UI showed a generic "Something went wrong" instead of the friendly,
--     -- already-mapped court_conflict message.
--     if exists (
--       select 1 from public.reservations r
--        where r.court_id = p_court_id
--          and r.status   in ('pending', 'confirmed')
--          and tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')
--          and r.id is distinct from v_old_reservation.id
--     ) then
--       raise exception 'court_conflict';
--     end if;
--
--     -- Time and/or pro changed — re-validate operating hours / pro /
--     -- member conflicts, excluding this lesson's own still-active
--     -- reservation, exactly like a self-service reschedule. Member check
--     -- is unconditional (correction pass — see admin_create_member_
--     -- lesson's header note above); p_roster_member_id always supplied.
--     perform public._lesson_check_operating_hours(v_club_id, p_starts_at, p_ends_at, v_tz);
--     perform public._lesson_check_pro_availability(p_pro_id, p_starts_at, p_ends_at, p_request_id);
--     perform public._lesson_check_member_availability(v_member_id, p_roster_member_id, p_starts_at, p_ends_at, p_request_id);
--   end if;
--
--   -- Phase 34E-A (correction pass): pre-mutation Stripe Checkout
--   -- invalidation. Moved here, AFTER every validation above (including the
--   -- scheduling-conflict/operating-hours/pro/member-availability checks
--   -- just above, which the original 34E-A placement ran BEFORE — an
--   -- invalid edit that would go on to fail court_conflict or an
--   -- availability check must never expire a legitimate Stripe Checkout
--   -- Session first), but still strictly BEFORE any local mutation
--   -- (reservation soft-cancel/insert/update, lesson_requests UPDATE)
--   -- below. Runs whenever this edit is about to reassign the Member or
--   -- change the priced amount — see this migration's own header comment
--   -- for why reassignment needs no independent guard beyond this (it is
--   -- included here purely as defense in depth).
--   if v_member_changed or v_price_amount_cents is distinct from v_before.price_amount_cents then
--     select id into v_payment_id_for_checkout_guard
--       from public.payments
--      where club_id = v_club_id and domain_type = 'lesson_request' and domain_id = p_request_id
--      order by obligation_cycle desc
--      limit 1
--      for update;
--     if v_payment_id_for_checkout_guard is not null then
--       perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);
--     end if;
--   end if;
--
--   if v_scheduling_changed then
--     -- Soft-cancel the old reservation and insert a new one — mirrors
--     -- accept_lesson_proposal's own reschedule pattern exactly. The new
--     -- row's created_by is this admin: it is a genuinely new row, not a
--     -- rewrite of the old one's created_by (which stays untouched on the
--     -- now-cancelled row).
--     update public.reservations
--        set status            = 'cancelled',
--            cancelled_at      = now(),
--            cancelled_by      = auth.uid(),
--            cancellation_kind = 'system',
--            updated_at        = now()
--      where id = v_old_reservation.id;
--
--     insert into public.reservations (
--       club_id, court_id, owner_user_id, roster_member_id,
--       starts_at, ends_at, status, reason,
--       notes, show_notes_to_members, created_by
--     ) values (
--       v_club_id, p_court_id, p_pro_id, p_roster_member_id,
--       p_starts_at, p_ends_at, 'confirmed', 'pro_lesson',
--       'Pro lesson with ' || v_member_name,
--       false,
--       auth.uid()
--     ) returning id into v_res_id;
--   elsif v_member_changed or v_pro_changed then
--     -- Nothing time-related changed — update the existing reservation row
--     -- directly in place (no history-losing replace) rather than the
--     -- soft-cancel-and-reinsert pattern above, which is reserved for an
--     -- actual scheduling change.
--     update public.reservations
--        set owner_user_id    = p_pro_id,
--            roster_member_id = p_roster_member_id,
--            notes            = 'Pro lesson with ' || v_member_name,
--            updated_at       = now()
--      where id = v_old_reservation.id;
--     v_res_id := v_old_reservation.id;
--   else
--     v_res_id := v_old_reservation.id;
--   end if;
--
--   update public.lesson_requests
--      set roster_member_id    = p_roster_member_id,
--          member_id           = v_member_id,
--          pro_id              = p_pro_id,
--          duration_minutes    = v_duration_minutes,
--          member_note         = btrim(coalesce(p_member_note, '')),
--          lesson_type_id      = p_lesson_type_id,
--          proposed_starts_at  = p_starts_at,
--          proposed_ends_at    = p_ends_at,
--          proposed_court_id   = p_court_id,
--          linked_reservation_id = v_res_id,
--          last_actor_id       = auth.uid(),
--          last_actor_role     = v_role,
--          pricing_basis           = v_pricing_basis,
--          unit_price_amount_cents = v_unit_price_amount_cents,
--          price_amount_cents      = v_price_amount_cents,
--          updated_at          = now()
--    where id = p_request_id
--   returning * into v_result;
--
--   -- Phase 34C: payment wiring, after the mutation, mirroring
--   -- update_member_reservation's rule exactly, including the Phase 34C
--   -- lifecycle correction: p_roster_member_id is passed as the CURRENT
--   -- identity into _adjust_payment_obligation, which no-ops if the latest
--   -- cycle belongs to a prior Member (reassigned while unpriced) rather
--   -- than silently adjusting their historical payment. Member reassignment
--   -- always gets an explicit new cycle for the new Member; otherwise a
--   -- price change adjusts the current cycle (if any, and if the new total
--   -- is not NULL) and ensures one exists.
--   if v_member_changed then
--     perform public._create_payment_obligation(
--       v_club_id, 'lesson_request', p_request_id, p_roster_member_id,
--       v_price_amount_cents, auth.uid(), true
--     );
--   elsif v_price_amount_cents is distinct from v_before.price_amount_cents then
--     if v_price_amount_cents is not null then
--       perform public._adjust_payment_obligation(v_club_id, 'lesson_request', p_request_id, p_roster_member_id, v_price_amount_cents, auth.uid());
--     end if;
--     perform public._create_payment_obligation(
--       v_club_id, 'lesson_request', p_request_id, p_roster_member_id,
--       v_price_amount_cents, auth.uid()
--     );
--   end if;
--
--   insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
--   values (
--     v_club_id, auth.uid(), 'admin_update_member_lesson', 'lesson_request', p_request_id,
--     jsonb_build_object(
--       'before', jsonb_build_object(
--         'roster_member_id', v_before.roster_member_id,
--         'member_id',        v_before.member_id,
--         'pro_id',           v_before.pro_id,
--         'court_id',         v_old_reservation.court_id,
--         'starts_at',        v_old_reservation.starts_at,
--         'ends_at',          v_old_reservation.ends_at,
--         'lesson_type_id',   v_before.lesson_type_id,
--         'pricing_basis',    v_before.pricing_basis,
--         'unit_price_amount_cents', v_before.unit_price_amount_cents,
--         'price_amount_cents', v_before.price_amount_cents
--       ),
--       'after', jsonb_build_object(
--         'roster_member_id', p_roster_member_id,
--         'member_id',        v_member_id,
--         'pro_id',           p_pro_id,
--         'court_id',         p_court_id,
--         'starts_at',        p_starts_at,
--         'ends_at',          p_ends_at,
--         'lesson_type_id',   p_lesson_type_id,
--         'pricing_basis',    v_pricing_basis,
--         'unit_price_amount_cents', v_unit_price_amount_cents,
--         'price_amount_cents', v_price_amount_cents
--       ),
--       'scheduling_changed', v_scheduling_changed,
--       'member_changed',     v_member_changed,
--       'pro_changed',        v_pro_changed,
--       'lesson_type_changed', v_lesson_type_changed,
--       'duration_changed',    v_duration_changed,
--       'reservation_id',     v_res_id,
--       'old_reservation_id', case when v_scheduling_changed then v_old_reservation.id else null end
--     )
--   );
--
--   -- Notify pro — always, when the pro or the schedule changed (always has
--   -- an account). Notify member only if claimed and something material
--   -- changed. Reuses the existing lesson_request_confirmed kind — no new
--   -- notification kind is introduced.
--   if v_scheduling_changed or v_pro_changed then
--     insert into public.notifications (club_id, user_id, kind, body, metadata)
--     values (
--       v_club_id, p_pro_id, 'lesson_request_confirmed',
--       'Lesson with ' || v_member_name || ' updated — now ' ||
--         to_char(p_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM') || '.',
--       jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id)
--     );
--   end if;
--
--   if v_member_id is not null and (v_scheduling_changed or v_pro_changed or v_member_changed) then
--     insert into public.notifications (club_id, user_id, kind, body, metadata)
--     values (
--       v_club_id, v_member_id, 'lesson_request_confirmed',
--       'Your lesson with ' ||
--         trim(coalesce(v_pro.first_name, '') || ' ' || coalesce(v_pro.last_name, '')) ||
--         ' is confirmed for ' || to_char(p_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM') || '.',
--       jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id)
--     );
--   end if;
--
--   return v_result;
-- end;
-- $function$;
--
-- -- No revoke/grant lines here, matching 0144/0151's own text — this
-- -- rollback restores the function body only; permissions were never
-- -- touched by any migration in this chain.
--
-- commit;
