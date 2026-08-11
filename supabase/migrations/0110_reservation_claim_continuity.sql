-- 0110_reservation_claim_continuity.sql
-- Phase 33C3: Reservation Claim Continuity + Regression Closeout
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Core promise: a staff-created reservation for a no-account Member must
-- remain the SAME reservation after that Member later claims their roster
-- identity — no history rewrite, no owner_user_id backfill on claim.
--
-- The focused audit for this checkpoint found two concrete gaps this
-- promise depends on, both of which need a database change to close:
--
-- 1. cancel_member_reservation (0097, untouched since, not touched by 0108)
--    resolves "is this my reservation?" with a single condition:
--    `owner_user_id = auth.uid()`. A staff-created no-account-Member
--    reservation has owner_user_id = null by design (0108's locked
--    identity model) and is NEVER rewritten to carry an owner_user_id
--    merely because the Member later claims their account (that would BE
--    the history rewrite this phase exists to avoid). Once claimed, that
--    Member has no way to self-cancel a reservation that is unambiguously
--    theirs by roster_member_id, because the RPC's own ownership match
--    never looks at roster_member_id at all. This is a straight CREATE OR
--    REPLACE of cancel_member_reservation's body — the signature (2 args)
--    is unchanged, so this is not a production-compatibility concern the
--    way 0109's update_member_reservation change was; there is only ever
--    one deployed caller of a given signature, and that caller's inputs
--    and outputs are unaffected by this change.
--
-- 2. There is no way for an authenticated, non-admin Member to discover
--    their OWN roster_member_id. roster_members SELECT is admin-only
--    (0056's roster_members_select_admin — deliberately, so a Member can
--    never browse the full roster or see another Member's contact/notes
--    fields). That is correct and is NOT relaxed here. But without some
--    narrow way to resolve "my own roster identity," neither /my-schedule
--    (server-rendered reservation list) nor /calendar (client-rendered
--    ownership/cancel-eligibility) can determine that a roster-linked,
--    owner_user_id-null reservation belongs to the signed-in Member. This
--    is a concrete database blocker, not a preference — the alternative
--    (widening roster_members SELECT with a "claimed_by = auth.uid()"
--    policy) would also expose that Member's own notes/email/phone
--    columns to themselves via any ad-hoc client query shape, which is a
--    larger surface than this checkpoint needs. Instead this migration
--    adds current_user_roster_member_id() — a single-value SECURITY
--    DEFINER helper, following the exact existing pattern of
--    current_user_club_id()/current_user_role() (0082) — that returns
--    only the caller's own roster_members.id for their active club, or
--    null if none. It bypasses RLS internally (SECURITY DEFINER) but
--    exposes nothing beyond that one uuid.
--
-- Locked architecture (unchanged, restated):
--   - roster_members.id = permanent club-scoped Member business identity.
--   - reservations.roster_member_id = durable Member attribution for
--     reason = 'member_booking'. Never touched by this migration.
--   - reservations.owner_user_id = optional authenticated compatibility
--     field. This migration NEVER writes to it, backfills it, or derives
--     it live for any query — it is read-only from this migration's
--     perspective, exactly preserving the "no history rewrite" promise.
--   - club_memberships = authorization/role/status only, never identity.
--
-- Explicitly OUT OF SCOPE for this migration:
--   - No change to create_reservation, admin_create_member_reservation, or
--     update_member_reservation (0108/0109) — all already correctly
--     roster-aware for their own concerns (creation, admin booking, admin
--     edit/reassignment); none of them has an "is this my own reservation"
--     ownership-matching problem, only cancel_member_reservation does.
--   - No change to 0108's reservations_member_booking_identity_guard
--     trigger or enforce_member_booking_roster_identity() — untouched.
--   - No widening of roster_members RLS — current_user_roster_member_id()
--     is a narrower, purpose-built alternative, not a workaround for one.
--   - No new notification kind or path — cancel_member_reservation's
--     existing notification block (recipient auth.uid(), gated by
--     user_pref_enabled) is preserved verbatim; it was never keyed off
--     owner_user_id in the first place, so the ownership-match fix does
--     not touch it.
--   - No change to the cancellation-window/grace-period computation.
--   - No change to lessons, events, programs, reporting, payments/pricing.
--   - Not applied by this checkpoint. Not committed.
--
-- TRANSACTION BOUNDARY: both the new helper function and the
-- cancel_member_reservation replacement run inside one BEGIN/COMMIT, per
-- the standing Phase 33 discipline (0107/0108 both moved BEGIN ahead of
-- all schema/function changes after the same gap was found and fixed
-- twice already in this phase).
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- A. current_user_roster_member_id() — new helper, same pattern as
--    current_user_club_id() / current_user_role() (0082)
-- ═══════════════════════════════════════════════════════════════════════════
-- Returns the caller's own roster_members.id for their active club, or
-- null if none exists. SECURITY DEFINER so it can read roster_members
-- (admin-only SELECT, 0056) on the caller's behalf without widening RLS —
-- the function itself only ever returns the caller's own single id value,
-- never any other column or any other Member's row.
create or replace function public.current_user_roster_member_id()
returns uuid
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select id
    from public.roster_members
   where club_id    = public.current_user_club_id()
     and claimed_by = auth.uid();
$$;

revoke execute on function public.current_user_roster_member_id() from public, anon;
grant  execute on function public.current_user_roster_member_id() to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- B. cancel_member_reservation — ownership match becomes roster-aware
-- ═══════════════════════════════════════════════════════════════════════════
-- Same 2-argument signature as 0097 (p_reservation_id, p_expected_club_id)
-- — CREATE OR REPLACE is safe here with no expand/contract concern, unlike
-- 0109's update_member_reservation, because no argument list is changing.
--
-- The ONLY behavioral change from the 0097 body: the ownership match on
-- the target reservation is widened from a single `owner_user_id =
-- auth.uid()` condition to `owner_user_id = auth.uid() OR (a roster
-- identity match)`. The roster identity used is resolved server-side via
-- current_user_roster_member_id() — never a client-supplied value of any
-- kind — and is inherently same-club, since that helper derives the club
-- from current_user_club_id() (the caller's own active membership), the
-- same source v_club_id below already comes from. A Member with no
-- claimed roster identity yet (should not be reachable in practice — every
-- active membership has one after 33B1's backfill and accept_club_invite's
-- fail-closed resolution — but handled defensively) simply falls back to
-- the original owner_user_id-only match, matching requirement 1's
-- "preserve compatibility for existing owner_user_id-based rows."
--
-- Every other behavioral path — role check, window/grace computation,
-- notification kind/gating/recipient — is unchanged from 0097.
-- Audit metadata additionally records roster_member_id for identity
-- traceability.
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
  v_outside_window   boolean;
  v_within_grace     boolean;
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

  -- Verbatim from 0097 — not touched by this migration. Phase 33C3's scope
  -- is claim-continuity ownership matching only; the cancellation-window/
  -- grace calculation (including its existing 24h/5min defaulting
  -- behavior) is preserved exactly as-is here, not revisited or corrected.
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

  v_outside_window := (v_before.starts_at - now())
    >= make_interval(hours => v_cancellation_window_hours);
  v_within_grace := v_cancellation_grace_minutes > 0
    and (now() - v_before.created_at)
        < make_interval(mins => v_cancellation_grace_minutes);

  if not v_outside_window and not v_within_grace then
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

-- Grants unchanged from 0097 — same signature, no new revoke/grant needed
-- (CREATE OR REPLACE preserves existing grants on a function's own OID).
-- Confirmed explicitly rather than assumed: see verify_phase33c3.sql
-- Section A.

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration is created
-- in this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- Both objects in this migration are drop-safe independently and in either
-- order — neither has a dependent added elsewhere in this migration or in
-- any later one at the time of writing:
--
-- 1. Restore cancel_member_reservation to its pre-0110 (0097) body via
--    CREATE OR REPLACE FUNCTION with the single `owner_user_id =
--    auth.uid()` ownership condition (remove the `v_roster_member_id`
--    declaration/assignment and the `or (...)` clause; remove the
--    `roster_member_id` key from the audit_log metadata). Same signature,
--    so this is a direct CREATE OR REPLACE, not a DROP — no coexistence
--    concern.
--
-- 2. Drop the helper function, once nothing calls it:
--    `drop function if exists public.current_user_roster_member_id();`
--
-- Data impact: none. This migration never wrote to any table — it only
-- replaced two function bodies and added one new function. Any
-- reservation that was cancelled via the widened roster-aware match while
-- this migration was live remains cancelled after rollback (status =
-- 'cancelled' is a normal row value, not something this rollback touches
-- or needs to touch). No no-account-Member reservation's owner_user_id or
-- roster_member_id is created, changed, or cleared by this migration or
-- by this rollback.
