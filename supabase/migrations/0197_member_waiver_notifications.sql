-- 0197_member_waiver_notifications.sql
-- Phase 43B-3F — Member Waiver Notifications. BACKEND/DATABASE ONLY.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Uses Court Time's EXISTING Phase 36 in-app notification system
-- (notifications table, migration 0009) to tell an active Member when the
-- current required Member waiver needs their acceptance. No email/SMS, no
-- Guest-waiver notifications, no second notification system.
--
-- 0009-0196 are APPLIED and IMMUTABLE — not touched. This migration is
-- purely additive: one new notification kind, one new partial unique index
-- (idempotency), two new private helpers (fan-out/reactivation, and
-- closing superseded-version notifications), and CREATE OR REPLACE on
-- three existing functions (publish_waiver_pdf_version, 0196;
-- set_member_waiver_required and accept_member_waiver, 0192) — same exact
-- signatures, existing bodies preserved verbatim, with a small addition
-- appended to each. No table is dropped or altered destructively, no
-- existing RPC's argument shape, return shape, or existing behavior for
-- any pre-existing scenario changes.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- TARGETED AUDIT (performed before writing this file; builds on the fuller
-- notification-system audit already performed in Phase 43B-3C)
-- ═══════════════════════════════════════════════════════════════════════════
-- notifications (0009): id, club_id, user_id, kind, body, is_read,
-- metadata jsonb, created_at. No title column — every non-'announcement'
-- kind's single line of user-facing copy IS its body, exactly the
-- convention this migration follows for its new kind.
--
-- Deep links (src/lib/notification-targets.ts, Phase 36): resolved via
-- NOTIFICATION_TARGET_MAP[kind]. Kinds with no natural per-object id
-- (announcement, refund_request_rejected, refund_request_completed) map to
-- null and the producing RPC writes metadata.target_path directly,
-- validated client-side as same-origin-relative-only. This migration's new
-- kind has a single static destination (/waivers/member, no per-object
-- id) and follows that exact precedent.
--
-- Creation path: no generic create_notification() helper exists anywhere —
-- every kind is inserted inline inside its own producing SECURITY DEFINER
-- RPC. The proven fan-out-to-many-recipients precedent is
-- send_announcement_v2 (0177): insert ... select ... from
-- club_memberships cm where cm.status = 'active' and cm.removed_at is
-- null. This migration's audience is narrower (Member-waiver eligibility
-- is a roster/claimed-identity concept, not a club_memberships-role
-- concept — Pro/Staff/Admin can hold a claimed roster identity subject to
-- the same Member waiver), so it fans out over roster_members instead,
-- using the exact predicate is_active_club_member (0188) already encodes:
-- rm.status = 'active' and rm.membership_status = 'active'. That function
-- itself operates one roster_member_id at a time and was never wired into
-- any RPC as of 0188 ("Not wired into any authorization/pricing decision
-- in this migration") — this migration is its first real caller, via an
-- inlined set-based equivalent of its predicate (calling it once per row
-- would be equivalent but slower; the WHERE clause below is copied
-- verbatim from its body for that reason).
--
-- Dedupe/idempotency: NONE exists anywhere in the notification system
-- today — every insert is unconditional. Rather than inventing a parallel
-- dedupe subsystem, this migration adds ONE partial unique index on the
-- EXISTING metadata jsonb column (the same column every kind already uses
-- to carry its own domain id) keyed on (user_id, metadata->>
-- 'waiver_version_id') scoped to this one kind, and relies on
-- ON CONFLICT ... DO UPDATE at insert time (reactivating is_read = false
-- and refreshing created_at on an existing row rather than leaving it
-- silently un-actionable). This gives an exact, database-enforced
-- guarantee: at most one 'member_waiver_requires_acceptance' notification
-- can ever exist for a given Member + a given waiver_version_id,
-- regardless of how many times publish/toggle is retried or how many
-- times Required cycles OFF and back ON for the same current version.
--
-- Member waiver publish/finalize (publish_waiver_pdf_version, 0196) and
-- Required-toggle (set_member_waiver_required, 0192) and acceptance
-- (accept_member_waiver, 0192) were re-read in full immediately before
-- writing this file — reproduced/extended below via CREATE OR REPLACE,
-- not re-derived from memory.
--
-- Canonical active-Member eligibility: is_active_club_member (0188) —
-- rm.status = 'active' and rm.membership_status = 'active'. Role-agnostic
-- by design (never consults roster_members.role or club_memberships.role).
-- A Guest has no roster_members row at all, so this predicate — combined
-- with requiring claimed_by is not null, since a notification needs a
-- real user_id to notify — naturally excludes the Guest audience with no
-- extra filtering.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- DESIGN DECISIONS
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. ONE kind, not two. The product copy differs by whether the Member has
--    ever accepted any version of this waiver ("Waiver requires your
--    acceptance") vs. only an older one ("Updated waiver requires your
--    acceptance") — but that is BODY TEXT content, computed once at insert
--    time per recipient, not a distinct notification TYPE requiring its
--    own kind/target-map entry/CHECK-constraint value. This mirrors how
--    every existing kind carries its single line of copy in `body`.
--
-- 2. Fan-out/reactivation (_notify_member_waiver_requires_acceptance) and
--    superseded-notification cleanup (_close_prior_member_waiver_
--    notifications) both live inside the two producing RPCs
--    (publish_waiver_pdf_version and set_member_waiver_required) via
--    these two shared private helpers, not a separate follow-up RPC call
--    from a Server Action. A required-waiver notice silently dropped by
--    a second, separate call failing is worse than the larger diff to
--    two proven, already-transactional functions. Retry safety comes for
--    free: publish_waiver_pdf_version's own version_id_already_exists
--    guard means a retried publish never reaches either helper call a
--    second time for the same version, and set_member_waiver_required's
--    own "return if is_required unchanged" guard means a retried toggle
--    never re-runs either helper call twice — the partial unique index
--    is the true, final backstop for every other retry shape (e.g. two
--    concurrent first-time publishes racing).
--
--    publish_waiver_pdf_version, for a Member-audience publish, ALWAYS
--    closes out unread notifications for any prior (now-superseded)
--    version of the same waiver — regardless of whether Required is
--    currently ON or OFF, since a superseded version is never actionable
--    again — and only THEN fans out a notification for the new current
--    version, and only when Required is ON. A Guest-audience publish
--    calls neither helper.
--
-- 3. Mandatory, in-app-only — NOT added to notification_preferences_
--    kind_check. Same reasoning as refund_request_submitted (0183): no
--    email/SMS delivery path exists for this kind, so there is nothing to
--    opt out of, and a compliance-driven waiver requirement should not be
--    silently suppressible via a notification preference row.
--
-- 4. Acceptance cleanup IS implemented (accept_member_waiver, 0192): after
--    a successful (new-row or idempotent-repeat) acceptance of the exact
--    current version, the matching unread notification for that user +
--    that exact waiver_version_id is marked read. This is a single,
--    narrow UPDATE keyed on the same (user_id, kind, metadata->>
--    'waiver_version_id') shape the idempotency index already uses — not
--    a new mechanism, and proportionate to add alongside the function this
--    migration already touches for other reasons. By the time a Member
--    can accept a version, any notification for a PRIOR version of the
--    same waiver has already been closed at replacement-publication time
--    by _close_prior_member_waiver_notifications (Decision 2 above) — so
--    this UPDATE only ever has the current version's own notification
--    left to close, and correctly leaves it untouched for a
--    stale-version accept attempt (rejected earlier in the same
--    function before this UPDATE is ever reached).
--
-- ═══════════════════════════════════════════════════════════════════════════
begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. notifications_kind_check — add member_waiver_requires_acceptance.
--    Same drop/re-add idiom as every prior kind-expansion migration (0183
--    was the last to touch this constraint). All 20 currently-allowed
--    kinds preserved verbatim; adds this one as the 21st.
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.notifications
  drop constraint if exists notifications_kind_check;

alter table public.notifications
  add constraint notifications_kind_check
  check (kind in (
    'reservation_confirmed',
    'reservation_cancelled_by_admin',
    'reservation_cancelled_by_member',
    'reservation_rescheduled',
    'event_cancelled',
    'event_joined',
    'event_updated',
    'waitlist_promoted',
    'waitlist_offer',
    'announcement',
    'lesson_request_received',
    'lesson_request_proposed',
    'lesson_request_confirmed',
    'lesson_request_declined',
    'lesson_cancelled',
    'lesson_provider_reassigned',
    'lesson_admin_requested',
    'refund_request_rejected',
    'refund_request_completed',
    'refund_request_submitted',
    'member_waiver_requires_acceptance'  -- Phase 43B-3F
  ));

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Idempotency — one partial unique index on the EXISTING metadata jsonb
--    column. At most one 'member_waiver_requires_acceptance' notification
--    can ever exist per (user_id, waiver_version_id), regardless of how
--    many times publish/toggle-required runs for the same version.
-- ═══════════════════════════════════════════════════════════════════════════
create unique index if not exists notifications_member_waiver_requires_acceptance_uniq
  on public.notifications (user_id, ((metadata ->> 'waiver_version_id')))
  where kind = 'member_waiver_requires_acceptance';

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. _notify_member_waiver_requires_acceptance — private fan-out helper.
--    Not granted to authenticated/anon; callers are other SECURITY
--    DEFINER functions in this schema owned by the same role (Section 4
--    and 5 below), matching _evaluate_member_waiver_status's own posture.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public._notify_member_waiver_requires_acceptance(
  p_club_id           uuid,
  p_waiver_version_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_waiver_id uuid;
begin
  select waiver_id into v_waiver_id
    from public.waiver_versions
   where id = p_waiver_version_id;

  if v_waiver_id is null then
    return;
  end if;

  insert into public.notifications (club_id, user_id, kind, body, metadata)
  select
    p_club_id,
    rm.claimed_by,
    'member_waiver_requires_acceptance',
    case
      when exists (
        select 1
          from public.waiver_acceptances a
          join public.waiver_versions v on v.id = a.waiver_version_id
         where v.waiver_id        = v_waiver_id
           and a.roster_member_id = rm.id
      ) then 'Updated waiver requires your acceptance'
      else 'Waiver requires your acceptance'
    end,
    jsonb_build_object(
      'waiver_version_id', p_waiver_version_id,
      'target_path',       '/waivers/member'
    )
    from public.roster_members rm
   where rm.club_id           = p_club_id
     -- Canonical active-Member predicate, inlined set-based from
     -- is_active_club_member (0188) — role-agnostic, never consults
     -- roster_members.role or club_memberships.role.
     and rm.status            = 'active'
     and rm.membership_status = 'active'
     and rm.claimed_by is not null
     and not exists (
       select 1 from public.waiver_acceptances a
        where a.waiver_version_id = p_waiver_version_id
          and a.roster_member_id  = rm.id
     )
  -- Pre-apply correction (still unapplied 0197): a prior read of the
  -- SAME (user_id, waiver_version_id) row can only ever exist here for a
  -- Member who has NOT accepted this version (the not-exists guard above
  -- already excludes acceptors from the candidate set), so reactivating
  -- it is always correct — never a stale row for someone who has since
  -- accepted. DO UPDATE (not DO NOTHING) restores is_read = false and
  -- refreshes created_at, so a Required OFF -> ON cycle (Problem 3) makes
  -- an already-existing-but-since-closed notification actionable again
  -- WITHOUT a second row — the partial unique index still guarantees at
  -- most one row per (user_id, waiver_version_id). created_at is
  -- refreshed because NotificationSheet orders by created_at desc
  -- (src/components/NotificationSheet.tsx) — a renewed requirement should
  -- surface as current, not buried under everything read since its
  -- original (now-irrelevant) insert time.
  on conflict (user_id, ((metadata ->> 'waiver_version_id')))
    where kind = 'member_waiver_requires_acceptance'
  do update set
    is_read    = false,
    body       = excluded.body,
    metadata   = excluded.metadata,
    created_at = now();
end;
$$;

revoke execute on function public._notify_member_waiver_requires_acceptance(uuid, uuid)
  from public, anon, authenticated;

comment on function public._notify_member_waiver_requires_acceptance(uuid, uuid) is
  'Phase 43B-3F fan-out: inserts (or reactivates, if a since-closed row
   already exists for the same user + version) a
   member_waiver_requires_acceptance notification for every active,
   claimed Member of p_club_id who has not yet accepted
   p_waiver_version_id. At most one row per (user_id, waiver_version_id)
   via notifications_member_waiver_requires_acceptance_uniq — ON CONFLICT
   DO UPDATE, not DO NOTHING, so a Required OFF -> ON cycle can resurface
   an existing closed notification without duplicating it. Private
   helper — not granted to authenticated; callers are
   publish_waiver_pdf_version and set_member_waiver_required, both owned
   by the same role.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 3b. _close_prior_member_waiver_notifications — private helper (pre-apply
--     correction). Marks read every unread member_waiver_requires_
--     acceptance notification belonging to any version of p_waiver_id
--     OTHER than p_current_version_id — covers accumulated superseded
--     versions in one sweep (V1 unread, then V2 published, then V3
--     published: closes both V1 and V2 in the V3 publish's single call).
--     Compares waiver_version_id as text (never casts metadata to uuid),
--     matching accept_member_waiver's own existing idiom for the same
--     column, so no notification with unexpected metadata shape can ever
--     raise a cast error here.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public._close_prior_member_waiver_notifications(
  p_waiver_id          uuid,
  p_current_version_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.notifications n
     set is_read = true
   where n.kind = 'member_waiver_requires_acceptance'
     and n.is_read = false
     and (n.metadata ->> 'waiver_version_id') <> p_current_version_id::text
     and exists (
       select 1 from public.waiver_versions v
        where v.id::text  = (n.metadata ->> 'waiver_version_id')
          and v.waiver_id = p_waiver_id
     );
end;
$$;

revoke execute on function public._close_prior_member_waiver_notifications(uuid, uuid)
  from public, anon, authenticated;

comment on function public._close_prior_member_waiver_notifications(uuid, uuid) is
  'Phase 43B-3F pre-apply correction: marks read every unread
   member_waiver_requires_acceptance notification for any PRIOR version
   of p_waiver_id (i.e. not p_current_version_id) — an obsolete
   notification for a superseded version is no longer actionable once a
   newer version is current. Private helper — not granted to
   authenticated; sole caller is publish_waiver_pdf_version.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. publish_waiver_pdf_version (0196) — CREATE OR REPLACE, same exact
--    signature and body, plus one call to the helper above when the
--    published audience is 'member' and the waiver is currently required.
--    v_waiver was already selected (with FOR UPDATE) before
--    current_version_id was repointed, so v_waiver.is_required already
--    reflects the value in effect at publish time — no new query needed.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.publish_waiver_pdf_version(
  p_actor_user_id      uuid,
  p_club_id            uuid,
  p_audience           text,
  p_version_id         uuid,
  p_original_filename  text,
  p_title              text,
  p_file_size_bytes    bigint,
  p_sha256_digest      text
)
returns table (
  version_id      uuid,
  version_number  integer,
  storage_path    text,
  published_at    timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_admin      boolean;
  v_title         text;
  v_filename      text;
  v_waiver        public.waivers%rowtype;
  v_next_version_number integer;
  v_storage_path  text;
  v_published_at  timestamptz;
begin
  if p_actor_user_id is null then raise exception 'actor_required'; end if;
  if p_club_id is null then raise exception 'club_required'; end if;
  if p_version_id is null then raise exception 'version_id_required'; end if;
  if p_audience not in ('member', 'guest') then raise exception 'invalid_audience'; end if;

  select exists (
    select 1
      from public.club_memberships cm
     where cm.user_id     = p_actor_user_id
       and cm.club_id      = p_club_id
       and cm.role         = 'admin'
       and cm.status        = 'active'
       and cm.removed_at is null
  ) into v_is_admin;

  if not v_is_admin then raise exception 'insufficient_role'; end if;

  v_title    := nullif(btrim(coalesce(p_title, '')), '');
  v_filename := nullif(btrim(coalesce(p_original_filename, '')), '');

  if v_title is null then raise exception 'title_required'; end if;
  if length(v_title) > 300 then raise exception 'title_too_long'; end if;
  if v_filename is null then raise exception 'filename_required'; end if;

  if p_file_size_bytes is null or p_file_size_bytes <= 0 or p_file_size_bytes > 10485760 then
    raise exception 'invalid_file_size';
  end if;
  if p_sha256_digest is null or p_sha256_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_digest';
  end if;

  if exists (select 1 from public.waiver_versions where id = p_version_id) then
    raise exception 'version_id_already_exists';
  end if;
  if exists (select 1 from public.waiver_document_files where waiver_version_id = p_version_id) then
    raise exception 'version_id_already_exists';
  end if;

  insert into public.waivers (club_id, audience)
  values (p_club_id, p_audience)
  on conflict (club_id, audience) do nothing;

  select * into v_waiver
    from public.waivers
   where club_id = p_club_id and audience = p_audience
     for update;

  if exists (
    select 1 from public.waiver_versions
     where waiver_id = v_waiver.id and status = 'draft'
  ) then
    raise exception 'draft_already_exists';
  end if;

  v_next_version_number := coalesce(
    (
      select max(wv.version_number)
        from public.waiver_versions wv
       where wv.waiver_id = v_waiver.id
    ),
    0
  ) + 1;

  v_storage_path := p_club_id::text || '/' || p_audience || '/' || p_version_id::text || '.pdf';
  v_published_at := now();

  insert into public.waiver_versions (
    id, waiver_id, version_number, title, body, status, published_at, published_by
  ) values (
    p_version_id, v_waiver.id, v_next_version_number, v_title, null, 'published', v_published_at, p_actor_user_id
  );

  insert into public.waiver_document_files (
    waiver_version_id, storage_path, original_filename, mime_type,
    file_size_bytes, sha256_digest, uploaded_by, uploaded_at
  ) values (
    p_version_id, v_storage_path, v_filename, 'application/pdf',
    p_file_size_bytes, p_sha256_digest, p_actor_user_id, v_published_at
  );

  update public.waivers
     set current_version_id = p_version_id,
         updated_at         = now()
   where id = v_waiver.id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    p_club_id, p_actor_user_id, 'publish_waiver_pdf_version', 'waiver_version', p_version_id,
    jsonb_build_object(
      'audience',            p_audience,
      'version_number',      v_next_version_number,
      'original_filename',   v_filename,
      'file_size_bytes',     p_file_size_bytes,
      'previous_version_id', v_waiver.current_version_id
    )
  );

  -- Phase 43B-3F (pre-apply correction): close out notifications for any
  -- PRIOR version of this Member waiver first — they stop being
  -- actionable the moment a newer version becomes current, regardless of
  -- whether Required is currently ON or OFF. Guest publications never
  -- touch notifications at all (no Guest notification system exists
  -- yet).
  if p_audience = 'member' then
    perform public._close_prior_member_waiver_notifications(v_waiver.id, p_version_id);
  end if;

  -- Fan out waiver-required notifications to eligible Members for the
  -- NEW current version. A club that publishes with Required OFF does
  -- not notify — matches "do NOT notify when Required is OFF".
  if p_audience = 'member' and coalesce(v_waiver.is_required, false) then
    perform public._notify_member_waiver_requires_acceptance(p_club_id, p_version_id);
  end if;

  return query select p_version_id, v_next_version_number, v_storage_path, v_published_at;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. set_member_waiver_required (0192) — CREATE OR REPLACE, same exact
--    signature and body, plus one call to the helper above when the
--    Required flag is being turned ON and a current Member waiver version
--    already exists. The pre-existing early return ("is_required is not
--    distinct from p_required then return") already makes a repeated
--    Required=true call a no-op before this new code is ever reached, so
--    no separate idempotency handling is needed for the toggle path
--    itself — the partial unique index is still the backstop for the
--    OFF -> ON case's own fan-out.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.set_member_waiver_required(
  p_required boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_waiver  public.waivers%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;
  if p_required is null then raise exception 'required_flag_required'; end if;

  select * into v_waiver
    from public.waivers
   where club_id = v_club_id and audience = 'member'
     for update;

  if not found then raise exception 'waiver_not_found'; end if;
  if v_waiver.is_required is not distinct from p_required then return; end if;

  update public.waivers
     set is_required = p_required, updated_at = now()
   where id = v_waiver.id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'set_member_waiver_required', 'waiver', v_waiver.id,
    jsonb_build_object('previous_required', v_waiver.is_required, 'new_required', p_required)
  );

  if p_required and v_waiver.current_version_id is not null then
    -- Required OFF -> ON. Create any missing notifications for eligible
    -- Members who have not yet accepted the current version, and
    -- reactivate (not duplicate) any existing notification this same
    -- waiver+user pair already had from before it was closed by the ON ->
    -- OFF transition below (Problem 3) — the helper's own ON CONFLICT DO
    -- UPDATE handles that.
    perform public._notify_member_waiver_requires_acceptance(v_club_id, v_waiver.current_version_id);
  elsif not p_required then
    -- Phase 43B-3F (pre-apply correction): Required ON -> OFF. The
    -- current version is no longer actionable while Required is off —
    -- close its unread notifications without deleting history. Scoped to
    -- exactly the current version (not all versions of this waiver): any
    -- PRIOR version's notifications were already closed at publish time
    -- by _close_prior_member_waiver_notifications, so there is nothing
    -- else unread left to close here in the normal case.
    update public.notifications
       set is_read = true
     where kind = 'member_waiver_requires_acceptance'
       and is_read = false
       and (metadata ->> 'waiver_version_id') = v_waiver.current_version_id::text;
  end if;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. accept_member_waiver (0192) — CREATE OR REPLACE, same exact signature
--    and body, plus acceptance cleanup: after a confirmed acceptance of
--    the exact current version (whether newly inserted or an idempotent
--    repeat), mark matching unread waiver-required notifications read.
--    Scoped to auth.uid() (never a proxy) and to this exact
--    waiver_version_id — an outdated notification for a PRIOR version
--    (already superseded, from before a replacement) is left untouched,
--    same as it already would be, since a stale-version accept is
--    rejected earlier in this same function.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.accept_member_waiver(
  p_waiver_version_id uuid
)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id          uuid;
  v_roster_member_id uuid;
  v_waiver           public.waivers%rowtype;
  v_new_id           uuid;
  v_accepted_at      timestamptz;
begin
  v_club_id := public.current_user_club_id();
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  select id into v_roster_member_id
    from public.roster_members
   where club_id    = v_club_id
     and claimed_by = auth.uid();
  if not found then raise exception 'no_roster_identity'; end if;

  select * into v_waiver
    from public.waivers
   where club_id = v_club_id and audience = 'member'
     for share;
  if not found or v_waiver.current_version_id is null then
    raise exception 'no_current_waiver_version';
  end if;

  if p_waiver_version_id is distinct from v_waiver.current_version_id then
    raise exception 'stale_waiver_version';
  end if;

  insert into public.waiver_acceptances (club_id, waiver_version_id, roster_member_id, accepted_by, accepted_at)
  values (v_club_id, p_waiver_version_id, v_roster_member_id, auth.uid(), now())
  on conflict (waiver_version_id, roster_member_id) do nothing
  returning id, accepted_at into v_new_id, v_accepted_at;

  if not found then
    select accepted_at into v_accepted_at
      from public.waiver_acceptances
     where waiver_version_id = p_waiver_version_id
       and roster_member_id  = v_roster_member_id;
  else
    insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
    values (
      v_club_id, auth.uid(), 'accept_member_waiver', 'waiver_acceptance', v_new_id,
      jsonb_build_object(
        'waiver_id',         v_waiver.id,
        'waiver_version_id', p_waiver_version_id,
        'roster_member_id',  v_roster_member_id
      )
    );
  end if;

  -- Phase 43B-3F: acceptance cleanup. Scoped to auth.uid() (the caller's
  -- own notifications only, never a proxy) and to this exact
  -- waiver_version_id (never a blanket "mark all waiver notifications
  -- read").
  update public.notifications
     set is_read = true
   where user_id = auth.uid()
     and kind    = 'member_waiver_requires_acceptance'
     and (metadata ->> 'waiver_version_id') = p_waiver_version_id::text
     and is_read = false;

  return v_accepted_at;
end;
$$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Manual live/DB QA (to be performed by the user before commit/push)
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. As Admin, with Required ON, publish a first Member waiver PDF version.
--    Expect: every active, claimed Member of the club receives exactly one
--    'member_waiver_requires_acceptance' notification, body "Waiver
--    requires your acceptance", metadata.target_path = '/waivers/member'.
--
-- 2. As one of those Members, accept the current version
--    (acceptMemberWaiverAction). Expect: that Member's matching
--    notification becomes is_read = true. Other Members' notifications are
--    untouched.
--
-- 3. As Admin, publish a REPLACEMENT version, with the V1 notification
--    from step 1 still unread for at least one Member who never accepted
--    it. Expect: that Member's V1 notification is marked is_read = true
--    (closed as an obsolete prior-version notification — it is no longer
--    actionable now that V2 is current), and a NEW, unread V2
--    notification is created for them ("Waiver requires your acceptance"
--    if they never accepted any version, "Updated waiver requires your
--    acceptance" if they had accepted an older one); a Member who already
--    accepted V1 is notified now for V2, correctly, with "Updated waiver
--    requires your acceptance" (they had accepted an older version of
--    this waiver).
--
-- 4. As Admin, retry the SAME publish call is not possible (version ids
--    are client-generated and unique) — instead, verify idempotency by
--    calling set_member_waiver_required(true) twice in a row (already a
--    no-op after the first via the pre-existing early return) and confirm
--    no duplicate notification rows via
--    select count(*) from notifications where kind =
--    'member_waiver_requires_acceptance' group by user_id, metadata ->>
--    'waiver_version_id' having count(*) > 1; -- expect 0 rows.
--
-- 5. As Admin, with a current version already published and NOT yet
--    accepted by some Members, set Required OFF. Expect: those Members'
--    unread current-version notifications are marked is_read = true (no
--    longer actionable while Required is off; the row itself is NOT
--    deleted — history is preserved). Then set Required ON again.
--    Expect: the SAME notification row for each such Member is
--    reactivated (is_read = false again, created_at refreshed so it
--    surfaces as current in NotificationSheet) — confirm via
--    select count(*) from notifications where kind =
--    'member_waiver_requires_acceptance' group by user_id, metadata ->>
--    'waiver_version_id' having count(*) > 1; -- expect 0 rows (no new
--    row was created by the reactivation). Members who already accepted
--    are unaffected by either transition.
--
-- 6. Confirm a Guest (no roster_members row) and an inactive/removed
--    Member never receive this notification kind under any of the above.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created
-- in this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- begin;
--
-- -- Restore the three functions to their pre-0197 bodies (0196's
-- -- publish_waiver_pdf_version, 0192's set_member_waiver_required and
-- -- accept_member_waiver) via CREATE OR REPLACE using those migrations'
-- -- original text.
-- drop function if exists public._notify_member_waiver_requires_acceptance(uuid, uuid);
-- drop function if exists public._close_prior_member_waiver_notifications(uuid, uuid);
-- drop index if exists public.notifications_member_waiver_requires_acceptance_uniq;
-- alter table public.notifications
--   drop constraint if exists notifications_kind_check;
-- alter table public.notifications
--   add constraint notifications_kind_check
--   check (kind in (
--     'reservation_confirmed', 'reservation_cancelled_by_admin',
--     'reservation_cancelled_by_member', 'reservation_rescheduled',
--     'event_cancelled', 'event_joined', 'event_updated',
--     'waitlist_promoted', 'waitlist_offer', 'announcement',
--     'lesson_request_received', 'lesson_request_proposed',
--     'lesson_request_confirmed', 'lesson_request_declined',
--     'lesson_cancelled', 'lesson_provider_reassigned',
--     'lesson_admin_requested', 'refund_request_rejected',
--     'refund_request_completed', 'refund_request_submitted'
--   ));
--
-- commit;
--
-- No table, RLS policy, or function outside this migration's own new
-- objects is touched — notifications' pre-existing rows/columns,
-- notification_preferences, waivers/waiver_versions/waiver_acceptances,
-- roster_members, club_memberships, and audit_log are all read-only or
-- additively-referenced from this migration's perspective.
