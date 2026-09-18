-- 0198_guest_waiver_invitation_acceptance.sql
-- Phase 43B-4A — Guest Waiver Invitation + Acceptance BACKEND FOUNDATION.
-- BACKEND/DATABASE ONLY. No public page, no PDF review UX, no browser UI
-- of any kind — those are Phase 43B-4B.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- A "Guest" in Court Time is a participation-scoped Guest attached to an
-- existing reservation or event (Phase 37) — never a roster identity, a
-- former Member, a global Guest/CRM record, or membership_status =
-- 'non_member'. This migration lets a club invite ONE such existing Guest
-- slot to review and accept the club's current Guest waiver, via an
-- opaque bearer token whose plaintext never touches Postgres. It does NOT
-- create a Guest identity of any kind — every new row here is a pointer
-- to an existing reservation_guests/event_guests row, never a substitute
-- for one.
--
-- 0009-0197 are APPLIED and IMMUTABLE — not touched. This migration is
-- purely additive: two new tables (guest_waiver_invitations, guest_waiver_
-- acceptances), their supporting indexes, and five new functions (one
-- shared private mint helper, two authenticated per-domain mint entry
-- points, one service_role-only resolve function, one service_role-only
-- accept function). No existing table, column, RPC, or grant is altered.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- TARGETED AUDIT (performed before writing this file)
-- ═══════════════════════════════════════════════════════════════════════════
-- reservation_guests (0178): id, reservation_id, display_name, status
-- ('active'|'removed'), removed_at, removed_by, added_by, created_at,
-- updated_at. Durable soft-remove ONLY — no `delete from
-- reservation_guests` exists anywhere in this repo's migration history;
-- remove_reservation_guest (0179) sets status='removed' and never deletes
-- the row. reservation_id has ON DELETE CASCADE from reservations, but
-- reservations themselves are never hard-deleted anywhere either (no
-- `delete from reservations` in this repo) — cancellation is
-- reservations.status = 'cancelled', a separate, non-destructive state.
--
-- event_guests (0050, extended by 0117/0136): id, event_id, display_name,
-- added_by, created_at, plus (0117) status ('active'|'cancelled'),
-- attendance_status, cancelled_at, cancelled_by. The ORIGINAL 0050/0051/
-- 0061 hard `delete from event_guests` bodies are dead code — 0117 and
-- then 0136 each redefined admin_remove_guest via CREATE OR REPLACE, and
-- the CURRENT (0136) definition soft-cancels only (status='cancelled',
-- cancelled_at, cancelled_by) and never issues a DELETE. event_id has ON
-- DELETE CASCADE from events, but events are never hard-deleted anywhere
-- in this repo's migration history either.
--
-- CONCLUSION: both source domains' CURRENT lifecycle is durable soft-
-- remove only, in normal operation. A plain FK (default NO ACTION, no ON
-- DELETE CASCADE) from guest_waiver_invitations/guest_waiver_acceptances
-- to reservation_guests/event_guests is therefore safe AND is the
-- defensively correct choice: it costs nothing today (these rows are
-- never actually hard-deleted) and, if that ever changed, NO ACTION would
-- BLOCK the delete rather than silently cascading away invitation/
-- acceptance history — the opposite failure mode of ON DELETE CASCADE.
-- No Guest-slot snapshot/denormalization is added: since the row itself
-- is never destroyed, reservation_guests.display_name/event_guests.
-- display_name remain readable through the FK forever, so a duplicate
-- snapshot would only be redundant state to keep in sync, not additional
-- safety.
--
-- Authorization — reservation Guest: reused verbatim.
-- _authorize_reservation_roster_access (0179, private, already the sole
-- authorization gate for add_reservation_guest/remove_reservation_guest)
-- allows Admin/Staff unconditionally, or the reservation's owner_user_id,
-- or a Member whose own claimed roster identity holds that reservation's
-- roster_member_id (Member additionally gated by the member_self_service
-- capability) — with p_require_not_cancelled=true, matching the exact
-- posture add_reservation_guest/remove_reservation_guest already use.
-- This migration calls that SAME private function for
-- mint_reservation_guest_waiver_invitation, rather than re-deriving any
-- ownership logic — "If Members currently manage Guests on their own
-- reservations, preserve that exact ownership boundary" is satisfied by
-- literal reuse, not reimplementation.
--
-- Authorization — event Guest: reused verbatim. admin_add_guest/
-- admin_remove_guest's CURRENT (0136) authorization is role in ('admin',
-- 'pro', 'staff') via profiles.role/profiles.club_id (the established,
-- still-live legacy pattern for these two specific functions — NOT
-- current_user_role()/current_user_club_id(), which 0136 did not migrate
-- them to). mint_event_guest_waiver_invitation reproduces that identical
-- check/lookup shape (same role allowlist, same profiles-based club
-- scoping, same event.status='scheduled'/archived_at guard
-- admin_add_guest already enforces) rather than inventing a new
-- authorization abstraction or silently widening/narrowing who may act.
--
-- Guest waiver document state (0195/0196, untouched): waivers row keyed
-- by (club_id, audience='guest') carries is_required and current_
-- version_id; waiver_versions/waiver_document_files carry the PDF
-- metadata. Guest acceptance was explicitly deferred by 0195's own header
-- comment ("Guest ACCEPTANCE/invitations are explicitly a later
-- checkpoint and must never reuse waiver_acceptances — that table's
-- roster_member_id is NOT NULL by design — a Guest has no durable roster
-- identity") — this migration is that later checkpoint, and
-- guest_waiver_acceptances below is intentionally its own table, never a
-- widening of waiver_acceptances.
--
-- Token/signed-URL precedent — reused verbatim. calendar_feed_tokens
-- (0173): raw token generated+hashed entirely in TypeScript
-- (src/lib/calendar/feedToken.ts: randomBytes(32) -> base64url raw,
-- SHA-256 lowercase hex hash), only the hash ever reaches Postgres, a
-- partial unique index enforces "at most one ACTIVE token per scope",
-- issue_calendar_feed_token atomically revokes-then-inserts for rotation,
-- and the resolving function (get_calendar_feed_rows) is granted ONLY to
-- service_role, called exclusively via createPrivilegedClient() from a
-- Next.js route handler, never reachable by anon/authenticated directly.
-- src/lib/waivers/guestWaiverToken.ts (this checkpoint) mirrors feedToken.
-- ts's exact technique; resolve_guest_waiver_invitation/accept_guest_
-- waiver below mirror get_calendar_feed_rows' exact grant posture
-- (service_role only). For the SIGNED PDF URL itself, no new plumbing is
-- added here at all: src/lib/waivers/pdfViewUrl.ts's existing
-- resolveWaiverPdfViewUrl(waiverVersionId) helper is already audience-
-- agnostic (used today by both Admin Settings and the Member acceptance
-- page) and needs only a version_id — which resolve_guest_waiver_
-- invitation already returns — so Phase 43B-4B can call it unchanged;
-- this migration does not duplicate storage_path/original_filename into
-- its own return shape.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- DESIGN DECISIONS
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Token is SLOT-scoped, not waiver-version-scoped (locked). The
--    invitation row never stores a waiver_version_id at all — resolve and
--    accept both re-derive the CURRENT Guest waiver dynamically from
--    (club_id, audience='guest') every time. Replacing V1 with V2 never
--    requires minting a new link; a Guest who already accepted V1 can
--    later accept V2 through the SAME still-valid token.
--
-- 2. Two real nullable FK columns (reservation_guest_id, event_guest_id)
--    on both new tables, not a polymorphic (domain, id) text pair — the
--    task's own explicit preference, and consistent with this schema's
--    general avoidance of unchecked polymorphic ids. A CHECK constraint
--    enforces exactly one of the two is populated on every row.
--
-- 3. At most one ACTIVE invitation per Guest slot, enforced by two
--    partial unique indexes (one per source column) — the same idiom as
--    calendar_feed_tokens_active_scope_idx (0173). Minting revokes the
--    slot's existing active invitation (if any) and inserts the new row
--    inside the SAME transaction, after taking a row lock on the source
--    Guest row (SELECT ... FOR UPDATE, in both per-domain mint entry
--    points) to serialize concurrent mints for the same slot — the
--    partial unique index remains the final, unconditional backstop even
--    if two transactions somehow still raced past that lock.
--
-- 4. guest_waiver_acceptances is entirely separate from waiver_
--    acceptances (0192) — never widened, never reused — per 0195's own
--    explicit deferral note quoted above. One row per (Guest slot, exact
--    waiver_version_id), immutable: no UPDATE/DELETE statement is ever
--    issued against it by any function in this file, and no grant to any
--    client role exists that could issue one either. Accepting V2 never
--    touches the V1 row. Token rotation never touches any acceptance row
--    (mint's revoke/insert operates only on guest_waiver_invitations).
--
-- 5. accept_guest_waiver writes NO audit_log entry. audit_log.actor_id is
--    NOT NULL, foreign-keyed to profiles(id) (0005) — a Guest has no
--    account and no profiles row, so there is no actor_id this function
--    could ever legitimately supply, and inventing one (e.g. the
--    inviting Admin, or a Guest-shaped uuid) would misattribute the
--    acceptance to someone who did not perform it. The guest_waiver_
--    acceptances row itself is the durable, immutable evidence of
--    acceptance — mint_*_guest_waiver_invitation, by contrast, DOES have
--    a real authenticated actor and writes audit_log normally.
--
-- 6. PRE-APPLY CORRECTION (superseding this decision's original text —
--    still unapplied at the time of the correction, edited in place, not
--    superseded via a second migration): Guest-slot validity (resolve
--    and accept) requires BOTH the slot's own status column
--    (reservation_guests.status = 'active' / event_guests.status =
--    'active') AND its PARENT reservation's/event's own lifecycle state.
--    The original design here deliberately checked only the slot's own
--    status, reasoning that a Guest waiver invitation should track only
--    the "Guest participation has not been removed/cancelled" signal —
--    but a Guest waiver invitation is PARTICIPATION-scoped: once the
--    parent participation is no longer live, the bearer token must stop
--    authorizing acceptance even though cancelling a reservation/event
--    never cascades onto the Guest row's own status (confirmed in the
--    audit above; still true). The parent-validity predicate is REUSED,
--    not invented, in both domains:
--      - Reservation: reservations.status <> 'cancelled' — the exact
--        branch _authorize_reservation_roster_access already enforces
--        with p_require_not_cancelled=true, plus a club_id match against
--        the invitation (defense in depth; structurally guaranteed to
--        already hold, since a reservation's club_id is immutable and
--        was already validated at mint time).
--      - Event: event.status = 'scheduled' and event.archived_at is
--        null — the exact guard admin_add_guest/admin_remove_guest (and
--        this migration's own mint_event_guest_waiver_invitation) already
--        enforce, plus the same club_id match.
--    MINT already enforced this "for free" via reuse of the same
--    functions (unchanged by this correction). RESOLVE now applies the
--    identical predicate as an additional read-only check, failing
--    closed (zero rows) exactly like an inactive Guest slot — no new
--    distinction is rendered. ACCEPT applies it under lock — see the
--    LOCK ORDER note on accept_guest_waiver itself (Section 7 below) for
--    the full Problem 2 correction this same pass makes. Historical
--    invitation rows are never deleted or revoked by a parent becoming
--    invalid — they remain history; they simply stop authorizing
--    resolution/acceptance while the parent participation is invalid.
--
-- 7. resolve_guest_waiver_invitation does NOT fail closed on "no current
--    Guest waiver" or "not required" — it returns those as VALUES
--    (waiver_id/current_version_id null, is_required false) so a future
--    public page can render an accurate "nothing to accept right now"
--    state. It DOES fail closed (return zero rows) on a malformed/
--    unknown/revoked token hash, a missing/inactive Guest slot, or an
--    invalid PARENT participation (Decision 6 above) — those are "this
--    link does not work at all" cases with nothing useful to render.
--    accept_guest_waiver, by contrast, hard-fails (raises) on
--    "no current Guest waiver" and "not required" — an acceptance action
--    with nothing valid to accept against is always an error, never a
--    renderable state.
--
-- ═══════════════════════════════════════════════════════════════════════════
begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. guest_waiver_invitations
-- ═══════════════════════════════════════════════════════════════════════════
create table public.guest_waiver_invitations (
  id                    uuid        primary key default gen_random_uuid(),
  club_id               uuid        not null references public.clubs(id) on delete cascade,
  reservation_guest_id  uuid        references public.reservation_guests(id),
  event_guest_id        uuid        references public.event_guests(id),
  -- SHA-256 hex digest only — the plaintext bearer token is generated and
  -- hashed entirely in TypeScript (src/lib/waivers/guestWaiverToken.ts)
  -- and never reaches this table or any SQL statement parameter beyond
  -- its hash.
  token_hash            text        not null check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at            timestamptz not null default now(),
  created_by            uuid        not null references public.profiles(id),
  revoked_at            timestamptz,
  revoked_by            uuid        references public.profiles(id),

  constraint guest_waiver_invitations_exactly_one_source_check
    check (
      (reservation_guest_id is not null and event_guest_id is null)
      or
      (reservation_guest_id is null and event_guest_id is not null)
    ),

  constraint guest_waiver_invitations_revoked_consistency_check
    check (
      (revoked_at is null and revoked_by is null)
      or
      (revoked_at is not null and revoked_by is not null)
    )
);

comment on table public.guest_waiver_invitations is
  'Phase 43B-4A: a slot-scoped bearer-token invitation to review and accept
   the club''s CURRENT Guest waiver. Tied to exactly one existing
   reservation_guests/event_guests row — never a Guest identity of its
   own. Only a SHA-256 hash of the token is ever stored. Default-deny RLS;
   every read/write goes through a SECURITY DEFINER function.';

-- Defensive uniqueness on the hash itself — a collision is
-- cryptographically infeasible (256 bits of entropy) but costs nothing to
-- also enforce at the database layer (same posture as
-- calendar_feed_tokens_token_hash_idx, 0173).
create unique index guest_waiver_invitations_token_hash_idx
  on public.guest_waiver_invitations (token_hash);

-- LOCKED: at most one ACTIVE invitation per Guest slot, one index per
-- source column (never both, since exactly one is populated per row).
create unique index guest_waiver_invitations_active_reservation_guest_idx
  on public.guest_waiver_invitations (reservation_guest_id)
  where revoked_at is null and reservation_guest_id is not null;

create unique index guest_waiver_invitations_active_event_guest_idx
  on public.guest_waiver_invitations (event_guest_id)
  where revoked_at is null and event_guest_id is not null;

create index guest_waiver_invitations_club_id_idx
  on public.guest_waiver_invitations (club_id);

alter table public.guest_waiver_invitations enable row level security;

-- Default-deny: zero RLS policies (mirrors calendar_feed_tokens', 0173)
-- plus an explicit blanket revoke — no client role, session or not, may
-- ever read or write this table directly.
revoke all on table public.guest_waiver_invitations from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. guest_waiver_acceptances
-- ═══════════════════════════════════════════════════════════════════════════
create table public.guest_waiver_acceptances (
  id                    uuid        primary key default gen_random_uuid(),
  club_id               uuid        not null references public.clubs(id) on delete cascade,
  reservation_guest_id  uuid        references public.reservation_guests(id),
  event_guest_id        uuid        references public.event_guests(id),
  waiver_version_id     uuid        not null references public.waiver_versions(id),
  -- Provenance only — which invitation was used, if any. Nullable and
  -- never required for validity: acceptance authority comes from having
  -- resolved a currently-active token at the moment of accept, not from
  -- this column, which exists purely for evidentiary/debugging value.
  invitation_id         uuid        references public.guest_waiver_invitations(id),
  accepted_at           timestamptz not null default now(),

  constraint guest_waiver_acceptances_exactly_one_source_check
    check (
      (reservation_guest_id is not null and event_guest_id is null)
      or
      (reservation_guest_id is null and event_guest_id is not null)
    )
);

comment on table public.guest_waiver_acceptances is
  'Phase 43B-4A: immutable acceptance evidence for the Guest waiver,
   scoped to an existing reservation_guests/event_guests row and an exact
   waiver_version_id. Entirely separate from waiver_acceptances (0192,
   Member-only, roster_member_id NOT NULL) per that migration''s own
   explicit deferral note. No UPDATE/DELETE path exists anywhere in this
   schema for this table. Default-deny RLS; every read/write goes through
   a SECURITY DEFINER function.';

-- One acceptance per Guest slot + exact waiver_version_id — one partial
-- unique index per source column, mirroring the invitations table above.
create unique index guest_waiver_acceptances_reservation_guest_version_uniq
  on public.guest_waiver_acceptances (reservation_guest_id, waiver_version_id)
  where reservation_guest_id is not null;

create unique index guest_waiver_acceptances_event_guest_version_uniq
  on public.guest_waiver_acceptances (event_guest_id, waiver_version_id)
  where event_guest_id is not null;

create index guest_waiver_acceptances_club_id_idx
  on public.guest_waiver_acceptances (club_id);

alter table public.guest_waiver_acceptances enable row level security;
revoke all on table public.guest_waiver_acceptances from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. _mint_guest_waiver_invitation — shared private helper. Validates the
--    CURRENT Guest waiver (must exist, published, and required),
--    atomically revokes the Guest slot's existing active invitation (if
--    any), inserts the new row, and audits. Not granted to authenticated/
--    anon — callers are the two per-domain entry points below, each of
--    which has ALREADY authorized the actor for this exact Guest slot and
--    locked its row (SELECT ... FOR UPDATE) before calling here.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public._mint_guest_waiver_invitation(
  p_club_id              uuid,
  p_actor_user_id        uuid,
  p_reservation_guest_id uuid,
  p_event_guest_id       uuid,
  p_token_hash           text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_waiver        public.waivers%rowtype;
  v_new_id        uuid;
  v_revoked_count int;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_token_hash';
  end if;

  select * into v_waiver
    from public.waivers
   where club_id = p_club_id and audience = 'guest';

  if not found or v_waiver.current_version_id is null then
    raise exception 'no_current_guest_waiver';
  end if;
  if not coalesce(v_waiver.is_required, false) then
    raise exception 'guest_waiver_not_required';
  end if;

  if p_reservation_guest_id is not null then
    update public.guest_waiver_invitations
       set revoked_at = now(), revoked_by = p_actor_user_id
     where reservation_guest_id = p_reservation_guest_id
       and revoked_at is null;
  else
    update public.guest_waiver_invitations
       set revoked_at = now(), revoked_by = p_actor_user_id
     where event_guest_id = p_event_guest_id
       and revoked_at is null;
  end if;
  get diagnostics v_revoked_count = row_count;

  insert into public.guest_waiver_invitations
    (club_id, reservation_guest_id, event_guest_id, token_hash, created_by)
  values
    (p_club_id, p_reservation_guest_id, p_event_guest_id, p_token_hash, p_actor_user_id)
  returning id into v_new_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    p_club_id, p_actor_user_id, 'mint_guest_waiver_invitation', 'guest_waiver_invitation', v_new_id,
    jsonb_build_object(
      'reservation_guest_id', p_reservation_guest_id,
      'event_guest_id',       p_event_guest_id,
      'replaced_existing',    v_revoked_count > 0
    )
  );

  return v_new_id;
end;
$$;

revoke execute on function public._mint_guest_waiver_invitation(uuid, uuid, uuid, uuid, text)
  from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. mint_reservation_guest_waiver_invitation — authenticated entry point.
--    Authorization reused verbatim from add_reservation_guest/
--    remove_reservation_guest (0179): _authorize_reservation_roster_
--    access, p_require_not_cancelled = true.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.mint_reservation_guest_waiver_invitation(
  p_reservation_id   uuid,
  p_expected_club_id uuid,
  p_guest_id         uuid,
  p_token_hash       text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reservation public.reservations%rowtype;
  v_guest       public.reservation_guests%rowtype;
begin
  v_reservation := public._authorize_reservation_roster_access(p_reservation_id, p_expected_club_id, true);

  -- Row lock serializes a concurrent mint for the SAME Guest slot — the
  -- partial unique index above is the unconditional backstop either way.
  select * into v_guest
    from public.reservation_guests
   where id             = p_guest_id
     and reservation_id = p_reservation_id
     and status          = 'active'
     for update;
  if not found then raise exception 'reservation_guest_not_found'; end if;

  return public._mint_guest_waiver_invitation(
    v_reservation.club_id, auth.uid(), p_guest_id, null, p_token_hash
  );
end;
$$;

revoke execute on function public.mint_reservation_guest_waiver_invitation(uuid, uuid, uuid, text)
  from public, anon;
grant  execute on function public.mint_reservation_guest_waiver_invitation(uuid, uuid, uuid, text)
  to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. mint_event_guest_waiver_invitation — authenticated entry point.
--    Authorization reused verbatim from admin_add_guest/admin_remove_
--    guest's CURRENT (0136) definition: role in ('admin', 'pro', 'staff')
--    via profiles.role/profiles.club_id, plus the same event.status=
--    'scheduled'/archived_at guard.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.mint_event_guest_waiver_invitation(
  p_event_id   uuid,
  p_guest_id   uuid,
  p_token_hash text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.profiles%rowtype;
  v_event public.events%rowtype;
  v_guest public.event_guests%rowtype;
begin
  select * into v_actor from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_actor.role not in ('admin', 'pro', 'staff') then
    raise exception 'admin_required';
  end if;

  select * into v_event
    from public.events
   where id      = p_event_id
     and club_id = v_actor.club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  select * into v_guest
    from public.event_guests
   where id       = p_guest_id
     and event_id = p_event_id
     and status    = 'active'
     for update;
  if not found then raise exception 'guest_not_found'; end if;

  return public._mint_guest_waiver_invitation(
    v_actor.club_id, auth.uid(), null, p_guest_id, p_token_hash
  );
end;
$$;

revoke execute on function public.mint_event_guest_waiver_invitation(uuid, uuid, text)
  from public, anon;
grant  execute on function public.mint_event_guest_waiver_invitation(uuid, uuid, text)
  to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. resolve_guest_waiver_invitation — service_role ONLY (same grant
--    posture as get_calendar_feed_rows, 0173). STABLE, read-only — no row
--    locks are taken here (accept_guest_waiver below is the actual
--    security boundary that re-validates under lock). Validity requires
--    BOTH the Guest slot's own status AND its PARENT reservation/event's
--    own lifecycle state (pre-apply correction, Problem 1) — a token
--    minted while participation was valid must stop resolving once the
--    parent is cancelled/archived, even though that never cascades onto
--    the Guest row's own status. Returns the minimal context a future
--    public page needs: no unrelated participant/member data, no other
--    Guests, no reservation/event content beyond the Guest's own display
--    name. See Design Decision 7 above for exactly
--    which failures return zero rows vs. a row with null/false waiver
--    fields.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.resolve_guest_waiver_invitation(
  p_token_hash text
)
returns table (
  invitation_id         uuid,
  club_id               uuid,
  club_name             text,
  reservation_guest_id  uuid,
  event_guest_id        uuid,
  guest_display_name    text,
  waiver_id             uuid,
  current_version_id    uuid,
  version_title         text,
  is_required           boolean,
  is_current_accepted   boolean,
  accepted_at           timestamptz
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_invitation     public.guest_waiver_invitations%rowtype;
  v_reservation    public.reservations%rowtype;
  v_event          public.events%rowtype;
  v_waiver         public.waivers%rowtype;
  v_reservation_id uuid;
  v_event_id       uuid;
  v_guest_name     text;
  v_slot_active    boolean;
  v_club_name      text;
  v_title          text;
  v_accepted_at    timestamptz;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return;
  end if;

  select * into v_invitation
    from public.guest_waiver_invitations
   where token_hash = p_token_hash
     and revoked_at is null;
  if not found then
    return;
  end if;

  -- Pre-apply correction (Problem 1): a Guest slot's own status can stay
  -- 'active' even after its PARENT reservation/event is cancelled/
  -- archived — cancellation never cascades onto reservation_guests.
  -- status/event_guests.status (confirmed in this migration's own audit
  -- header above). Once the parent participation is no longer live, the
  -- token must stop authorizing resolution — same fail-closed shape
  -- (return zero rows) as an inactive Guest slot, not a new distinction.
  if v_invitation.reservation_guest_id is not null then
    select rg.reservation_id, rg.display_name, (rg.status = 'active')
      into v_reservation_id, v_guest_name, v_slot_active
      from public.reservation_guests rg
     where rg.id = v_invitation.reservation_guest_id;

    if not found or not coalesce(v_slot_active, false) then
      return;
    end if;

    -- Parent-validity predicate reused verbatim from
    -- _authorize_reservation_roster_access's own p_require_not_cancelled
    -- = true branch (status <> 'cancelled') — not reinvented — plus the
    -- club-match this correction explicitly requires.
    select * into v_reservation
      from public.reservations
     where id = v_reservation_id;

    if not found or v_reservation.status = 'cancelled' or v_reservation.club_id <> v_invitation.club_id then
      return;
    end if;
  else
    select eg.event_id, eg.display_name, (eg.status = 'active')
      into v_event_id, v_guest_name, v_slot_active
      from public.event_guests eg
     where eg.id = v_invitation.event_guest_id;

    if not found or not coalesce(v_slot_active, false) then
      return;
    end if;

    -- Parent-validity predicate matches the exact event.status=
    -- 'scheduled'/archived_at guard mint_event_guest_waiver_invitation
    -- (and admin_add_guest/admin_remove_guest) already enforce — the
    -- existing event Guest mint boundary, reused here for resolve.
    select * into v_event
      from public.events
     where id = v_event_id;

    if not found or v_event.status <> 'scheduled' or v_event.archived_at is not null or v_event.club_id <> v_invitation.club_id then
      return;
    end if;
  end if;

  -- w.club_id (not bare club_id): resolve_guest_waiver_invitation's own
  -- RETURNS TABLE declares an OUT parameter also named club_id, which
  -- PL/pgSQL treats as an implicit variable in scope — an unqualified
  -- `club_id` here would be ambiguous between that OUT parameter and
  -- waivers.club_id (same bug class caught and fixed in 0196's own
  -- publish_waiver_pdf_version via wv.version_number).
  select w.* into v_waiver
    from public.waivers w
   where w.club_id = v_invitation.club_id and w.audience = 'guest';

  if v_waiver.current_version_id is not null then
    select cv.title into v_title
      from public.waiver_versions cv
     where cv.id = v_waiver.current_version_id and cv.status = 'published';

    if v_invitation.reservation_guest_id is not null then
      select a.accepted_at into v_accepted_at
        from public.guest_waiver_acceptances a
       where a.reservation_guest_id = v_invitation.reservation_guest_id
         and a.waiver_version_id    = v_waiver.current_version_id;
    else
      select a.accepted_at into v_accepted_at
        from public.guest_waiver_acceptances a
       where a.event_guest_id    = v_invitation.event_guest_id
         and a.waiver_version_id = v_waiver.current_version_id;
    end if;
  end if;

  select c.name into v_club_name from public.clubs c where c.id = v_invitation.club_id;

  return query select
    v_invitation.id,
    v_invitation.club_id,
    v_club_name,
    v_invitation.reservation_guest_id,
    v_invitation.event_guest_id,
    v_guest_name,
    v_waiver.id,
    v_waiver.current_version_id,
    v_title,
    coalesce(v_waiver.is_required, false),
    (v_accepted_at is not null),
    v_accepted_at;
end;
$$;

revoke execute on function public.resolve_guest_waiver_invitation(text)
  from public, anon, authenticated;
grant  execute on function public.resolve_guest_waiver_invitation(text)
  to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. accept_guest_waiver — service_role ONLY. Takes ONLY the token hash
--    (never a guest id) — the Guest slot is entirely derived from the
--    resolved invitation row, so an arbitrary guest id can never be
--    supplied without a valid, currently-active token to resolve it
--    through. Idempotent for the same slot + exact version (ON CONFLICT
--    DO NOTHING against the partial unique indexes above, same idiom as
--    accept_member_waiver, 0192). No audit_log entry — see Design
--    Decision 5 above.
--
--    LOCK ORDER (pre-apply correction, Problem 2): participation FIRST,
--    invitation SECOND — the exact same relative order mint already uses
--    (mint_reservation_guest_waiver_invitation/mint_event_guest_waiver_
--    invitation each lock the Guest child row FOR UPDATE BEFORE
--    _mint_guest_waiver_invitation revokes the slot's prior invitation
--    and inserts the new one). Concretely:
--      1. Read the invitation by token_hash UNLOCKED, only far enough to
--         discover which slot it names. This row can only become STALE
--         by this point, never wrong — reservation_guest_id/event_
--         guest_id are set once at INSERT and never updated by anything
--         in this schema; only revoked_at/revoked_by ever change later.
--      2. Lock + revalidate the Guest child row (FOR SHARE — the
--         weakest lock sufficient to block a concurrent removal/
--         cancellation's own exclusive lock without itself blocking
--         other concurrent readers or unrelated Guests), THEN lock +
--         revalidate its PARENT (reservation/event) row, also FOR SHARE.
--      3. Re-read + lock the INVITATION row by id (not by hash again),
--         FOR SHARE, AFTER the participation locks — re-verify the same
--         token_hash and revoked_at IS NULL. This is what actually
--         catches a rotation that revoked the token in the window
--         between step 1's unlocked read and now.
--      4. Only after all of the above proceed to the waiver FOR SHARE
--         check, stale-version check, and the acceptance insert
--         (unchanged from before this correction).
--    Because both accept_guest_waiver and every mutation that could
--    invalidate it (mint/rotate, remove_reservation_guest, admin_remove_
--    guest, cancel_member_reservation/admin_cancel_reservation_v2, all
--    audited above/in the header) request "participation row(s), then
--    (if at all) the invitation row" in that SAME order, two concurrent
--    transactions can only ever block on one another — never form a
--    cycle — so no deadlock is possible. If the invalidating mutation's
--    lock commits first, this function's own re-check in step 3 fails
--    closed; if this function acquires the locks first, it may complete
--    before the invalidating mutation proceeds. Two unrelated Guests'
--    acceptances never contend with each other (FOR SHARE on
--    row-specific, unrelated ids), and the existing waivers FOR SHARE
--    protection against a concurrent publish/replacement/Required-toggle
--    is untouched, still acquired last.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.accept_guest_waiver(
  p_token_hash        text,
  p_waiver_version_id uuid
)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invitation     public.guest_waiver_invitations%rowtype;
  v_reservation    public.reservations%rowtype;
  v_event          public.events%rowtype;
  v_waiver         public.waivers%rowtype;
  v_reservation_id uuid;
  v_event_id       uuid;
  v_slot_active    boolean;
  v_new_id         uuid;
  v_accepted_at    timestamptz;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_token';
  end if;
  if p_waiver_version_id is null then
    raise exception 'waiver_version_id_required';
  end if;

  -- Step 1: discover the source slot only — deliberately unlocked (see
  -- the function header above for why this is safe).
  select * into v_invitation
    from public.guest_waiver_invitations
   where token_hash = p_token_hash
     and revoked_at is null;
  if not found then
    raise exception 'invalid_token';
  end if;

  -- Step 2: lock + revalidate the Guest child row, THEN its parent —
  -- both FOR SHARE, both BEFORE the invitation re-check in Step 3.
  if v_invitation.reservation_guest_id is not null then
    select rg.reservation_id, (rg.status = 'active')
      into v_reservation_id, v_slot_active
      from public.reservation_guests rg
     where rg.id = v_invitation.reservation_guest_id
       for share;
    if not found or not coalesce(v_slot_active, false) then
      raise exception 'guest_slot_invalid';
    end if;

    -- Parent-validity predicate reused verbatim from
    -- _authorize_reservation_roster_access's own p_require_not_cancelled
    -- = true branch (status <> 'cancelled'), plus the club-match this
    -- correction explicitly requires.
    select * into v_reservation
      from public.reservations
     where id = v_reservation_id
       for share;
    if not found or v_reservation.status = 'cancelled' or v_reservation.club_id <> v_invitation.club_id then
      raise exception 'guest_slot_invalid';
    end if;
  else
    select eg.event_id, (eg.status = 'active')
      into v_event_id, v_slot_active
      from public.event_guests eg
     where eg.id = v_invitation.event_guest_id
       for share;
    if not found or not coalesce(v_slot_active, false) then
      raise exception 'guest_slot_invalid';
    end if;

    -- Parent-validity predicate matches admin_add_guest/admin_remove_
    -- guest's own event.status='scheduled'/archived_at guard.
    select * into v_event
      from public.events
     where id = v_event_id
       for share;
    if not found or v_event.status <> 'scheduled' or v_event.archived_at is not null or v_event.club_id <> v_invitation.club_id then
      raise exception 'guest_slot_invalid';
    end if;
  end if;

  -- Step 3: re-read + lock the invitation row BY ID, FOR SHARE, AFTER the
  -- participation locks above — re-verify it is still the exact same,
  -- still-active token. This is the check that actually catches a
  -- concurrent rotation.
  select * into v_invitation
    from public.guest_waiver_invitations
   where id = v_invitation.id
     for share;
  if not found or v_invitation.token_hash <> p_token_hash or v_invitation.revoked_at is not null then
    raise exception 'invalid_token';
  end if;

  -- Step 4: unchanged — FOR SHARE (not FOR UPDATE) closes the accept-vs-
  -- publish race exactly like accept_member_waiver (0192) — a concurrent
  -- publish_waiver_pdf_version/set_guest_waiver_required cannot repoint
  -- current_version_id while this acceptance is validating/inserting
  -- against it, while multiple Guests accepting at once never serialize
  -- against each other.
  select * into v_waiver
    from public.waivers
   where club_id = v_invitation.club_id and audience = 'guest'
     for share;
  if not found or v_waiver.current_version_id is null then
    raise exception 'no_current_guest_waiver';
  end if;
  if not coalesce(v_waiver.is_required, false) then
    raise exception 'guest_waiver_not_required';
  end if;

  -- Stale-version rejection: the caller must be accepting the version
  -- that is current RIGHT NOW.
  if p_waiver_version_id is distinct from v_waiver.current_version_id then
    raise exception 'stale_waiver_version';
  end if;

  insert into public.guest_waiver_acceptances (
    club_id, reservation_guest_id, event_guest_id, waiver_version_id, invitation_id, accepted_at
  ) values (
    v_invitation.club_id, v_invitation.reservation_guest_id, v_invitation.event_guest_id,
    p_waiver_version_id, v_invitation.id, now()
  )
  on conflict do nothing
  returning id, accepted_at into v_new_id, v_accepted_at;

  if not found then
    -- Idempotent repeat acceptance: no new row.
    if v_invitation.reservation_guest_id is not null then
      select a.accepted_at into v_accepted_at
        from public.guest_waiver_acceptances a
       where a.reservation_guest_id = v_invitation.reservation_guest_id
         and a.waiver_version_id    = p_waiver_version_id;
    else
      select a.accepted_at into v_accepted_at
        from public.guest_waiver_acceptances a
       where a.event_guest_id    = v_invitation.event_guest_id
         and a.waiver_version_id = p_waiver_version_id;
    end if;
  end if;

  return v_accepted_at;
end;
$$;

revoke execute on function public.accept_guest_waiver(text, uuid)
  from public, anon, authenticated;
grant  execute on function public.accept_guest_waiver(text, uuid)
  to service_role;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Manual live/DB QA (to be performed by the user before commit/push).
-- Per this checkpoint's instructions, the user will apply this migration
-- and perform a small live invocation of the new RPCs before broader QA.
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. As a Member who owns a reservation with an active Guest, with the
--    club's Guest waiver current + Required, call
--    mint_reservation_guest_waiver_invitation(reservation_id,
--    expected_club_id, guest_id, sha256_hex_of_a_test_token). Expect: a
--    new invitation id back, one row in guest_waiver_invitations, one
--    audit_log row (action='mint_guest_waiver_invitation').
--
-- 2. Call resolve_guest_waiver_invitation(that_same_hash) (as service_
--    role, e.g. via the SQL editor). Expect: one row, guest_display_name
--    matching the Guest, current_version_id populated, is_required=true,
--    is_current_accepted=false, accepted_at=null.
--
-- 3. Call accept_guest_waiver(that_same_hash, the_current_version_id).
--    Expect: a timestamptz back, one row in guest_waiver_acceptances.
--    Call it again with the SAME arguments — expect: the SAME accepted_at
--    back, still only one row (idempotent).
--
-- 4. Call resolve_guest_waiver_invitation(that_same_hash) again. Expect:
--    is_current_accepted=true, accepted_at populated.
--
-- 5. Mint again for the SAME Guest (rotate). Expect: the OLD hash's
--    resolve_guest_waiver_invitation call now returns zero rows; a NEW
--    hash resolves; guest_waiver_acceptances still has the earlier
--    acceptance row, untouched.
--
-- 6. As Admin/Staff/Pro, mint for an event Guest
--    (mint_event_guest_waiver_invitation) and repeat 2-3 for that domain.
--
-- 7. Attempt mint_reservation_guest_waiver_invitation for a reservation/
--    club the caller does not own/belong to. Expect: an authorization
--    exception (reservation_not_found or insufficient_role, per
--    _authorize_reservation_roster_access), no row created.
--
-- 8. PARENT-INVALIDITY CORRECTION (Problem 1). Mint a reservation-Guest
--    invitation while the reservation is still active, confirm resolve/
--    accept both work (steps 1-3 above), THEN cancel the reservation
--    (cancel_member_reservation or admin_cancel_reservation_v2) WITHOUT
--    touching the Guest row itself. Expect: resolve_guest_waiver_
--    invitation(that_hash) now returns zero rows; accept_guest_waiver
--    now raises guest_slot_invalid. Confirm the reservation_guests row
--    itself is untouched (still status='active') and the invitation row
--    is untouched (still not revoked) — only resolve/accept behavior
--    changed, nothing was deleted/revoked automatically.
--
-- 9. PARENT-INVALIDITY CORRECTION, event domain. Mint an event-Guest
--    invitation, confirm resolve/accept both work, then cancel the event
--    (cancel_event) without touching the event_guests row. Expect the
--    same fail-closed behavior as step 8. Separately, confirm an
--    archived event (archived_at set, status left 'scheduled') produces
--    the same fail-closed result.
--
-- 10. LOCK-ORDER CORRECTION (Problem 2). With a valid, current invitation
--     and a valid current Guest waiver version, open two concurrent
--     sessions: in session A, begin a transaction and call
--     remove_reservation_guest (or admin_remove_guest for the event
--     domain) but do not commit yet; in session B, call accept_guest_
--     waiver for the same slot's token. Expect: session B blocks until
--     session A commits or rolls back — never a deadlock error from
--     either session. If A commits, B's accept then fails with
--     guest_slot_invalid; if A rolls back, B's accept proceeds normally.
--     Repeat with mint_*_guest_waiver_invitation (rotation) in session A
--     in place of removal — same expected blocking/outcome shape,
--     confirming accept never resolves a token a concurrent rotation is
--     in the middle of revoking.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created
-- in this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- begin;
--
-- drop function if exists public.accept_guest_waiver(text, uuid);
-- drop function if exists public.resolve_guest_waiver_invitation(text);
-- drop function if exists public.mint_event_guest_waiver_invitation(uuid, uuid, text);
-- drop function if exists public.mint_reservation_guest_waiver_invitation(uuid, uuid, uuid, text);
-- drop function if exists public._mint_guest_waiver_invitation(uuid, uuid, uuid, uuid, text);
-- drop table if exists public.guest_waiver_acceptances;
-- drop table if exists public.guest_waiver_invitations;
--
-- commit;
--
-- No table, RLS policy, or function outside this migration's own new
-- objects is touched — reservation_guests, event_guests, waivers/
-- waiver_versions/waiver_document_files, waiver_acceptances,
-- club_memberships, profiles, and audit_log are all read-only or
-- additively-referenced (new FKs pointing at them) from this migration's
-- perspective.
