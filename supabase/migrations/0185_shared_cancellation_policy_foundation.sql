-- 0185_shared_cancellation_policy_foundation.sql
-- Phase 40 — Shared Cancellation Policy Foundation.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- SCOPE (locked)
-- ═══════════════════════════════════════════════════════════════════════════
-- Backend policy foundation only. No new UI, no public/read-only preview
-- RPC, no new Server Actions, no notification kinds. Existing Member
-- late-cancellation behavior remains HARD BLOCKED — the shared evaluator
-- below can classify a policy state as 'late', but nothing in this
-- migration lets a 'late' state proceed. Phase 41 will decide
-- late-cancellation financial/operational behavior.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- TARGETED RESCHEDULE-BYPASS CHECK (performed before writing this migration)
-- ═══════════════════════════════════════════════════════════════════════════
-- Question: can a Member bypass the reservation/lesson cancellation window
-- by rescheduling a late booking to a future time and then cancelling it?
--
-- Reservations: NO bypass exists. update_member_reservation (0151, the
-- current effective body) rejects any caller whose role is not 'admin' or
-- 'staff' (`if v_role not in ('admin', 'staff') then raise exception
-- 'insufficient_role'; end if;`), and its only Server Action caller,
-- updateMemberReservationAdmin (src/app/(app)/calendar/actions.ts), is
-- wired exclusively into EditReservationSheet.tsx, which itself only
-- renders for an admin/staff viewer. A Member has no RPC, Server Action, or
-- UI path that changes a reservation's court/date/time at all — the only
-- mutation a Member can perform on their own reservation is
-- cancel_member_reservation. With no Member-reachable time-change path,
-- there is nothing for a shared evaluator to anchor against; this migration
-- does not add one, and does not touch update_member_reservation.
--
-- Lessons: NO equivalent bypass exists, for the same structural reason.
-- propose_lesson_time (0159, the current effective body) rejects any caller
-- whose role is not 'pro' or 'admin' (`if v_profile.role not in ('pro',
-- 'admin') then raise exception 'insufficient_role'; end if;`) — a Member
-- can only accept_lesson_proposal/decline_lesson_proposal a time the
-- assigned Pro or an Admin already proposed, never initiate one. A Member
-- therefore cannot unilaterally move a lesson to a future time and then
-- cancel it under the relaxed window; the "propose" step that would move
-- the clock is never in the Member's hands. This migration does not touch
-- propose_lesson_time or accept_lesson_proposal.
--
-- Both findings are pinned as regression assertions in this phase's test
-- coverage (the two role checks above must keep reading exactly as quoted)
-- so a future loosening of either check is caught rather than silently
-- reopening this bypass surface.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT THIS MIGRATION DOES
-- ═══════════════════════════════════════════════════════════════════════════
-- A. Adds public._evaluate_cancellation_policy — a single PRIVATE,
--    side-effect-free SQL helper that is the one authoritative
--    cancellation-window/grace arithmetic implementation. Deterministic:
--    takes an explicit p_evaluated_at instead of reading now() internally,
--    so exact boundary behavior is testable. Returns state ('in_policy' |
--    'grace' | 'late'), cutoff_at, and within_grace. Encodes NO
--    Admin/Staff/Pro authorization — policy evaluation and actor
--    authorization remain separate concepts, exactly as instructed.
--
-- B. Redefines cancel_member_reservation (effective body: 0110) — replaces
--    its duplicated v_outside_window/v_within_grace arithmetic with one
--    call to the shared helper. Every other check, computation, mutation,
--    audit row, and notification is byte-identical to 0110's body. Same
--    2-argument signature; grants unchanged (CREATE OR REPLACE preserves
--    existing grants on the function's own OID, same as 0110's own note
--    about 0097).
--
-- C. Redefines cancel_lesson (effective body: 0159) — replaces its
--    duplicated epoch/hours window arithmetic (Member-actor branch only)
--    with one call to the shared helper, called with grace disabled
--    (p_grace_minutes = 0, p_grace_anchor = null) — lessons never get a
--    grace period, and lesson_requests.created_at is deliberately never
--    used as a grace anchor (that timestamp does not represent the same
--    lifecycle event a reservation's created_at does). Every other check,
--    computation, mutation, audit row, and notification is byte-identical
--    to 0159's body, including the pre-mutation Stripe Checkout
--    invalidation call and the admin/staff/pro branches, which never enter
--    the Member-only window check and are therefore untouched by this
--    migration. Same signature; grants unchanged.
--
-- Explicitly OUT OF SCOPE: club_settings (no new columns, no new
-- override/toggle), event/program cancellation or withdrawal, any
-- Stripe/payment/refund mutation, any notification kind, any new RPC or
-- Server Action, any UI.
--
-- Not applied by this checkpoint. Not committed.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- A. public._evaluate_cancellation_policy — private, deterministic,
--    side-effect-free
-- ═══════════════════════════════════════════════════════════════════════════
-- p_window_hours/p_grace_minutes are the CALLER's already-resolved values
-- (e.g. club_settings.cancellation_window_hours with its own existing
-- 24h/5min defaulting already applied by the caller) — this helper does no
-- club/domain lookup of its own, only arithmetic on the values it is given.
--
-- p_grace_anchor is the timestamp grace is measured from (a reservation's
-- created_at) or NULL when the caller's domain has no grace concept
-- (lessons) — grace is only ever considered when p_grace_minutes > 0 AND
-- p_grace_anchor is not null, so a lesson call (p_grace_minutes = 0)
-- structurally can never reach 'grace'.
--
-- Boundary semantics (locked):
--   p_evaluated_at <= cutoff_at                              -> in_policy
--   p_evaluated_at  > cutoff_at, inside grace window          -> grace
--   p_evaluated_at  > cutoff_at, grace disabled or expired    -> late
-- Grace is a HALF-OPEN window: (p_evaluated_at - p_grace_anchor) <
-- make_interval(mins => p_grace_minutes) — strictly less than, so the exact
-- grace-expiration instant is 'late', not 'grace'.
create or replace function public._evaluate_cancellation_policy(
  p_starts_at     timestamptz,
  p_window_hours  integer,
  p_grace_minutes integer,
  p_grace_anchor  timestamptz,
  p_evaluated_at  timestamptz
)
returns table (
  state        text,
  cutoff_at    timestamptz,
  within_grace boolean
)
language sql
immutable
set search_path = public, pg_temp
as $$
  with policy as (
    select
      p_starts_at - make_interval(hours => coalesce(p_window_hours, 0)) as v_cutoff_at,
      coalesce(p_grace_minutes, 0) > 0
        and p_grace_anchor is not null
        and (p_evaluated_at - p_grace_anchor) < make_interval(mins => coalesce(p_grace_minutes, 0))
        as v_grace_eligible
  )
  select
    case
      when p_evaluated_at <= policy.v_cutoff_at then 'in_policy'
      when policy.v_grace_eligible              then 'grace'
      else 'late'
    end as state,
    policy.v_cutoff_at as cutoff_at,
    (p_evaluated_at > policy.v_cutoff_at and policy.v_grace_eligible) as within_grace
  from policy;
$$;

-- Private: no direct role-level invocation. SECURITY DEFINER callers below
-- (owned by the same role that owns this function) reach it via an
-- internal function call, which does not require the invoking role to
-- separately hold EXECUTE — same pattern 0158 already established for
-- this project's other internal helpers.
revoke execute on function public._evaluate_cancellation_policy(timestamptz, integer, integer, timestamptz, timestamptz)
  from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- B. cancel_member_reservation — CREATE OR REPLACE, arithmetic swap only
-- ═══════════════════════════════════════════════════════════════════════════
-- Reproduced verbatim from its currently-applied body (0110) with exactly
-- one change: v_outside_window/v_within_grace are replaced by a single call
-- to public._evaluate_cancellation_policy, evaluated at now(). The
-- club_settings lookup and its existing 24h/5min defaulting are unchanged
-- and still run first, exactly as before — this migration only replaces
-- what happens with those two resolved values, not how they are resolved.
-- Role check, roster-aware ownership match (0110), row lock, exception
-- codes, audit_log row, and notification block are all byte-identical.
create or replace function public.cancel_member_reservation(
  p_reservation_id   uuid,
  p_expected_club_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id                     uuid;
  v_role                        text;
  v_roster_member_id            uuid;
  v_before                      reservations%rowtype;
  v_after                       reservations%rowtype;
  v_cancellation_window_hours   integer;
  v_cancellation_grace_minutes  integer;
  v_tz               text;
  v_policy_state      text;
  v_notification_id  uuid;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  -- Null-safe: NULL NOT IN ('member','pro') evaluates to NULL (not TRUE),
  -- which would silently fail to raise for a null v_role — reject null
  -- explicitly rather than relying on NOT IN alone.
  if v_role is null or v_role not in ('member', 'pro') then
    raise exception 'insufficient_role';
  end if;

  -- Phase 33C3: the caller's own durable Member identity for this club, if
  -- claimed. Server-resolved only — never accepted from the client — and
  -- inherently same-club (see helper definition above). May legitimately
  -- be null; that is not an error here, it only narrows the ownership
  -- match below back to the original owner_user_id-only behavior.
  v_roster_member_id := public.current_user_roster_member_id();

  select * into v_before
    from reservations
    where id = p_reservation_id
      and club_id = v_club_id
      and (
        owner_user_id = auth.uid()
        or (v_roster_member_id is not null and roster_member_id = v_roster_member_id)
      )
    for update;
  if not found then raise exception 'reservation_not_found'; end if;

  if v_before.reason <> 'member_booking' then raise exception 'reservation_not_editable'; end if;
  if v_before.status <> 'confirmed' then raise exception 'reservation_not_editable'; end if;

  -- Cancellation-window/grace resolution unchanged from 0097/0110 — same
  -- club_settings lookup, same 24h/5min defaulting behavior.
  select cancellation_window_hours, cancellation_grace_minutes
    into v_cancellation_window_hours, v_cancellation_grace_minutes
    from club_settings
    where club_id = v_club_id;

  if not found then
    v_cancellation_window_hours  := 24;
    v_cancellation_grace_minutes := 5;
  else
    v_cancellation_window_hours  := coalesce(v_cancellation_window_hours, 24);
    v_cancellation_grace_minutes := coalesce(v_cancellation_grace_minutes, 5);
  end if;

  -- Phase 40: the resolved window/grace values above are now evaluated by
  -- the single shared arithmetic helper instead of this function's own
  -- inline v_outside_window/v_within_grace computation. Same boundary
  -- semantics (see the helper's own header comment) — 'in_policy' and
  -- 'grace' both continue; 'late' remains hard-blocked exactly as before.
  select state into v_policy_state
    from public._evaluate_cancellation_policy(
      v_before.starts_at,
      v_cancellation_window_hours,
      v_cancellation_grace_minutes,
      v_before.created_at,
      now()
    );

  if v_policy_state = 'late' then
    raise exception 'cancellation_window_closed';
  end if;

  update reservations set
    status             = 'cancelled',
    cancelled_at       = now(),
    cancelled_by       = auth.uid(),
    cancellation_kind  = 'member',
    updated_at         = now()
  where id = p_reservation_id
  returning * into v_after;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id,
    auth.uid(),
    'cancel_member_reservation',
    'reservation',
    p_reservation_id,
    jsonb_build_object(
      'court_id',         v_before.court_id,
      'owner_user_id',    v_before.owner_user_id,
      'roster_member_id', v_before.roster_member_id,
      'starts_at',        v_before.starts_at,
      'reason',           v_before.reason
    )
  );

  select timezone into v_tz from clubs where id = v_club_id;

  v_notification_id := null;

  -- Preserved exactly from notify_reservation_cancelled_by_member (0040/0043):
  -- same kind, same preference gating, same body shape. Always addressed to
  -- auth.uid() (the caller performing the cancellation), never to
  -- v_before.owner_user_id — unaffected by the ownership-match change above.
  if user_pref_enabled(auth.uid(), 'reservation_cancelled_by_member') then
    insert into notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id,
      auth.uid(),
      'reservation_cancelled_by_member',
      'Your reservation on '
        || to_char(v_before.starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM')
        || ' was cancelled.',
      jsonb_build_object('reservation_id', p_reservation_id)
    )
    returning id into v_notification_id;
  end if;

  return jsonb_build_object(
    'reservation',     to_jsonb(v_after),
    'notification_id', v_notification_id
  );
end;
$$;

-- Grants unchanged — same signature, CREATE OR REPLACE preserves existing
-- grants on the function's own OID (same reasoning as 0110's own note).

-- ═══════════════════════════════════════════════════════════════════════════
-- C. cancel_lesson — CREATE OR REPLACE, arithmetic swap only, Member branch
-- ═══════════════════════════════════════════════════════════════════════════
-- Reproduced verbatim from its currently-applied body (0159) with exactly
-- one change, confined to the `if v_actor_role = 'member' then ... end if;`
-- block: the inline epoch/hours window comparison is replaced by a call to
-- the shared helper with grace disabled (p_grace_minutes = 0, p_grace_anchor
-- = null) — lessons never get a grace period, and lesson_requests.created_at
-- is deliberately never passed as a grace anchor. The admin/pro/staff
-- branches above and below this block, the pre-mutation Stripe Checkout
-- invalidation guard, the mutations, the audit row, and both notification
-- inserts are all byte-identical to 0159's body.
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
  v_policy_state        text;
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

  -- Phase 40: admin/pro/staff never enter this block — this migration does
  -- not change their behavior at all. Only the Member-actor arithmetic is
  -- replaced, with grace disabled (lessons never get a grace period, and
  -- lesson_requests.created_at is never used as a grace anchor).
  if v_actor_role = 'member' then
    select coalesce(cs.cancellation_window_hours, 24) into v_window_hours
      from public.club_settings cs
     where cs.club_id = v_profile.club_id;

    select state into v_policy_state
      from public._evaluate_cancellation_policy(
        v_effective_starts_at,
        v_window_hours,
        0,
        null,
        now()
      );

    if v_policy_state = 'late' then
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

-- Grants unchanged — same signature, CREATE OR REPLACE preserves existing
-- grants on the function's own OID.

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration is created
-- in this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- All three objects in this migration are drop-safe independently and in
-- either order:
--
-- 1. Restore cancel_member_reservation to its pre-0185 (0110) body via
--    CREATE OR REPLACE FUNCTION: remove the v_policy_state declaration and
--    the _evaluate_cancellation_policy call, and restore the inline
--    v_outside_window/v_within_grace declarations and computation plus the
--    original `if not v_outside_window and not v_within_grace then raise
--    exception 'cancellation_window_closed'; end if;` check. Same
--    signature — a direct CREATE OR REPLACE, no coexistence concern.
--
-- 2. Restore cancel_lesson to its pre-0185 (0159) body via CREATE OR
--    REPLACE FUNCTION: remove the v_policy_state declaration and the
--    _evaluate_cancellation_policy call inside the `v_actor_role =
--    'member'` block, and restore the original `if (extract(epoch from
--    (v_effective_starts_at - now())) / 3600) < v_window_hours then raise
--    exception 'within_cancellation_window'; end if;` check. Same
--    signature.
--
-- 3. Drop the helper, once nothing calls it:
--    `drop function if exists public._evaluate_cancellation_policy(timestamptz, integer, integer, timestamptz, timestamptz);`
--
-- Data impact: none. This migration never writes to any table — it only
-- replaces three function bodies (one new, two redefined). Any reservation
-- or lesson cancelled while this migration is live remains cancelled after
-- rollback; no cancellation-window/grace/late classification is persisted
-- anywhere by this migration, so there is nothing stored to unwind.
