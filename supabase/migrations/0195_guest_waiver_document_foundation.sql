-- 0195_guest_waiver_document_foundation.sql
-- Phase 43B-2A — Guest Waiver Document Foundation.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Court Time will support two independently versioned waiver documents per
-- club: audience='member' (0192/0193/0194, untouched) and, starting here,
-- audience='guest'. Both reuse the SAME waivers/waiver_versions tables,
-- the same published-version immutability trigger, the same same-waiver
-- composite FK, the same one-draft-per-waiver partial unique index, and
-- the same Admin-only authoring posture — a second content ROW per club,
-- not a second parallel system. Guest ACCEPTANCE/invitations are
-- explicitly a later checkpoint and must never reuse waiver_acceptances
-- (that table's roster_member_id is NOT NULL by design — a Guest has no
-- durable roster identity — see 0192's own header comment on this exact
-- point).
--
-- 0192, 0193, and 0194 are APPLIED and IMMUTABLE — not touched by this
-- file. Seven of the nine existing Member waiver RPCs (create_member_
-- waiver_draft, set_member_waiver_required, accept_member_waiver, get_my_
-- member_waiver_status, get_member_waiver_status, get_club_member_waiver_
-- compliance, _evaluate_member_waiver_status) are FROZEN — untouched,
-- unreferenced by any new object here, and not widened into a generic
-- audience-parameterized API. Deliberate, locked decision: a small amount
-- of duplication (four near-identical Guest RPCs below) is preferred over
-- risking regression to the already-proven, already-applied Member flow.
--
-- CORRECTION PASS (post-review, before first apply — this file has never
-- been applied to any database, so this is edited in place rather than
-- shipped as 0196): the remaining two Member RPCs — update_member_waiver_
-- draft and publish_member_waiver_version — are ALSO redefined here, via
-- CREATE OR REPLACE, unchanged signatures. This is a narrow, deliberate
-- exception to the freeze above, not a reopening of it. Root cause: both
-- functions resolve their p_version_id argument by joining waiver_
-- versions to waivers and checking `w.club_id = v_club_id` only — they
-- never checked `w.audience = 'member'`, because until THIS migration
-- widens the CHECK constraint (Section A below), audience could not
-- contain anything else, making that predicate correct by construction
-- with no explicit check needed. The moment 0195 makes audience='guest'
-- possible, that prior assumption silently stops holding: an Admin could
-- pass a Guest waiver_version_id into either Member RPC and have it
-- accepted, producing a cross-audience mutation path and a misleading
-- 'update_member_waiver_draft'/'publish_member_waiver_version' audit
-- entry against what is actually the Guest document. Both bodies below
-- are otherwise byte-identical to their exact currently-applied 0192
-- text (re-verified directly against that file, not from paraphrase,
-- immediately before writing this correction) — the only line added to
-- each is `and w.audience = 'member'` in the existing version-lookup
-- WHERE clause. No signature change, so no privilege change either:
-- CREATE OR REPLACE on an unchanged signature preserves the existing
-- 0192 grants automatically (same established precedent as 0193's own
-- accepted_at fix) — no REVOKE/GRANT follows either redefinition.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- SCOPE (locked, as corrected)
-- ═══════════════════════════════════════════════════════════════════════════
--   A. Widen ONLY waivers.audience's CHECK domain from `audience = 'member'`
--      to `audience in ('member', 'guest')`. NOT NULL, the 'member'
--      default, and unique(club_id, audience) are all preserved exactly —
--      no column, index, or other constraint is touched. No backfill: every
--      existing row is already 'member', which satisfies the widened
--      check trivially.
--   C-G. Four NEW Guest-specific Admin authoring RPCs — create/update/
--      publish_guest_waiver_version, set_guest_waiver_required — each the
--      audience='guest' mirror of its Member counterpart, with an explicit
--      `w.audience = 'guest'` filter on every version lookup so a Member
--      waiver_version_id is structurally rejected (waiver_version_not_
--      found), never mutated.
--   H. Two EXISTING Member RPCs hardened in place (see CORRECTION PASS
--      above) — update_member_waiver_draft and publish_member_waiver_
--      version each gain the single `and w.audience = 'member'` predicate
--      their version lookup was always implicitly relying on. This
--      migration therefore contains six total CREATE OR REPLACE FUNCTION
--      statements: four new, two hardened — not four.
--
-- NOT in this migration (explicitly out of scope): guest_waiver_
-- invitations, guest_waiver_acceptances, any bearer token/hashing, any
-- createPrivilegedClient change, /waivers/guest/[token] or any other
-- public/unauthenticated route, reservation_guests/event_guests/
-- guest_names changes, delivery (email/SMS/QR), Guest compliance pills,
-- Staff Guest-link generation, any booking/event enforcement, Settings
-- UI. All of that is later 43B-2B+ work.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- PRE-IMPLEMENTATION VERIFY (done directly against 0192's applied text
-- before writing this file, not from paraphrase)
-- ═══════════════════════════════════════════════════════════════════════════
-- waivers.audience was declared as an INLINE, unnamed column CHECK:
--   `audience text not null default 'member' check (audience = 'member')`
-- Postgres auto-names an inline unnamed CHECK `<table>_<column>_check` —
-- confirmed against this exact repo's own established convention for
-- widening an inline check via `drop constraint if exists <table>_
-- <column>_check` (reservations_reason_check 0004/0069, notification_
-- preferences_kind_check 0055/0069/0078, lesson_requests_outcome_check
-- 0070, clubs_theme_key_check 0074, event_types_key_check 0065,
-- notifications_kind_check 0078/0069) — so the live name here is
-- waivers_audience_check. Every other invariant this checkpoint must
-- preserve (current_version_id's composite FK, waiver_versions'
-- unique(id, waiver_id) and one-draft partial unique index, and the
-- _reject_published_waiver_version_mutation BEFORE UPDATE OR DELETE
-- trigger) is defined at the table/waiver_id level, not hardcoded to any
-- specific audience value — so all of them already, automatically cover
-- a future audience='guest' row with zero changes required here.
--
-- Apply in Supabase SQL Editor (cloud only). Not applied by this checkpoint.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- A. Widen waivers.audience's CHECK domain — the only schema change in
--    this migration.
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.waivers
  drop constraint if exists waivers_audience_check;

alter table public.waivers
  add constraint waivers_audience_check
  check (audience in ('member', 'guest'));

comment on column public.waivers.audience is
  'Phase 43B-2A: widened from a single fixed ''member'' value to
   ''member''|''guest''. NOT NULL and default ''member'' are unchanged —
   every pre-existing row remains audience=''member'' with no backfill.
   unique(club_id, audience) (0192, untouched) is what actually enforces
   at most one waiver document per club per audience — this CHECK only
   constrains which audience values may ever exist.';

-- ═══════════════════════════════════════════════════════════════════════════
-- C/D. create_guest_waiver_draft — audience='guest' mirror of
--      create_member_waiver_draft (0192). Admin-only, race-safe find-or-
--      create, one-draft-at-a-time (RPC-level check here, DB-level
--      partial unique index backstop already exists and needs no change).
--      The Member waiver row for this club, if any, is never read or
--      written — the only waivers row this function ever touches is
--      (club_id, 'guest').
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.create_guest_waiver_draft(
  p_title text,
  p_body  text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id  uuid;
  v_role     text;
  v_title    text;
  v_body     text;
  v_waiver   public.waivers%rowtype;
  v_next_version_number integer;
  v_new_version_id      uuid;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;

  v_title := nullif(btrim(coalesce(p_title, '')), '');
  v_body  := nullif(btrim(coalesce(p_body, '')), '');

  if v_title is null then raise exception 'title_required'; end if;
  if v_body  is null then raise exception 'body_required'; end if;
  if length(v_title) > 300   then raise exception 'title_too_long'; end if;
  if length(v_body)  > 20000 then raise exception 'body_too_long'; end if;

  -- Find-or-create, race-safe — identical pattern to create_member_
  -- waiver_draft: ON CONFLICT DO NOTHING makes concurrent first-time
  -- creation a no-op for every transaction but one; the SELECT ... FOR
  -- UPDATE immediately after always locks whatever row now exists.
  insert into public.waivers (club_id, audience)
  values (v_club_id, 'guest')
  on conflict (club_id, audience) do nothing;

  select * into v_waiver
    from public.waivers
   where club_id = v_club_id and audience = 'guest'
     for update;

  if exists (
    select 1 from public.waiver_versions
     where waiver_id = v_waiver.id and status = 'draft'
  ) then
    raise exception 'draft_already_exists';
  end if;

  v_next_version_number := coalesce(
    (select max(version_number) from public.waiver_versions where waiver_id = v_waiver.id),
    0
  ) + 1;

  insert into public.waiver_versions (waiver_id, version_number, title, body, status)
  values (v_waiver.id, v_next_version_number, v_title, v_body, 'draft')
  returning id into v_new_version_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'create_guest_waiver_draft', 'waiver_version', v_new_version_id,
    jsonb_build_object(
      'waiver_id',      v_waiver.id,
      'version_number', v_next_version_number,
      'title_length',   length(v_title),
      'body_length',    length(v_body)
    )
  );

  return v_new_version_id;
end;
$$;

revoke execute on function public.create_guest_waiver_draft(text, text) from public, anon;
grant  execute on function public.create_guest_waiver_draft(text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- E. update_guest_waiver_draft — audience='guest' mirror of update_
--    member_waiver_draft. The `and w.audience = 'guest'` predicate is the
--    cross-audience guard: a Member waiver_version_id simply fails to
--    match this lookup (waiver_version_not_found), so it can never be
--    read or mutated through this function. Published immutability is
--    enforced twice, exactly as the Member RPC does: the RPC-level
--    `status <> 'draft'` check here, backstopped by the unchanged
--    _reject_published_waiver_version_mutation trigger (0192) as the
--    final, DB-level guarantee.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.update_guest_waiver_draft(
  p_version_id uuid,
  p_title      text,
  p_body       text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_title   text;
  v_body    text;
  v_version public.waiver_versions%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;

  select v.* into v_version
    from public.waiver_versions v
    join public.waivers w on w.id = v.waiver_id
   where v.id = p_version_id
     and w.club_id = v_club_id
     and w.audience = 'guest'
     for update of v;

  if not found then raise exception 'waiver_version_not_found'; end if;
  if v_version.status <> 'draft' then raise exception 'version_not_editable'; end if;

  v_title := nullif(btrim(coalesce(p_title, '')), '');
  v_body  := nullif(btrim(coalesce(p_body, '')), '');

  if v_title is null then raise exception 'title_required'; end if;
  if v_body  is null then raise exception 'body_required'; end if;
  if length(v_title) > 300   then raise exception 'title_too_long'; end if;
  if length(v_body)  > 20000 then raise exception 'body_too_long'; end if;

  if v_version.title is not distinct from v_title
     and v_version.body is not distinct from v_body then
    return;
  end if;

  update public.waiver_versions
     set title = v_title, body = v_body, updated_at = now()
   where id = p_version_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'update_guest_waiver_draft', 'waiver_version', p_version_id,
    jsonb_build_object(
      'waiver_id',      v_version.waiver_id,
      'version_number', v_version.version_number,
      'title_length',   length(v_title),
      'body_length',    length(v_body)
    )
  );
end;
$$;

revoke execute on function public.update_guest_waiver_draft(uuid, text, text) from public, anon;
grant  execute on function public.update_guest_waiver_draft(uuid, text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- F. publish_guest_waiver_version — audience='guest' mirror of publish_
--    member_waiver_version. Same `and w.audience = 'guest'` cross-audience
--    guard on the initial lookup; because v_version is only ever resolved
--    from that already-guest-scoped query, the second SELECT (`where id =
--    v_version.waiver_id`) is guaranteed to be the SAME guest waivers row
--    — the Member waiver row for this club is never read, locked, or
--    repointed. Atomic within this one function invocation: draft ->
--    published, then repoint current_version_id, both before the one
--    audit_log insert. No 'retired' state, no unpublish path — identical
--    to the Member RPC.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.publish_guest_waiver_version(
  p_version_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_version public.waiver_versions%rowtype;
  v_waiver  public.waivers%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;

  select v.* into v_version
    from public.waiver_versions v
    join public.waivers w on w.id = v.waiver_id
   where v.id = p_version_id
     and w.club_id = v_club_id
     and w.audience = 'guest'
     for update of v;

  if not found then raise exception 'waiver_version_not_found'; end if;
  -- Rejects re-publishing an already-published version outright (no
  -- silent no-op — publishing is a deliberate act with a real side effect
  -- on waivers.current_version_id).
  if v_version.status <> 'draft' then raise exception 'version_not_draft'; end if;

  select * into v_waiver
    from public.waivers
   where id = v_version.waiver_id
     for update;

  update public.waiver_versions
     set status       = 'published',
         published_at = now(),
         published_by = auth.uid(),
         updated_at   = now()
   where id = p_version_id;

  update public.waivers
     set current_version_id = p_version_id,
         updated_at         = now()
   where id = v_waiver.id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'publish_guest_waiver_version', 'waiver_version', p_version_id,
    jsonb_build_object(
      'waiver_id',           v_waiver.id,
      'version_number',      v_version.version_number,
      'previous_version_id', v_waiver.current_version_id
    )
  );
end;
$$;

revoke execute on function public.publish_guest_waiver_version(uuid) from public, anon;
grant  execute on function public.publish_guest_waiver_version(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- G. set_guest_waiver_required — audience='guest' mirror of set_member_
--    waiver_required. Touches only waivers.is_required on the (club_id,
--    'guest') row — never waiver_versions/waiver_acceptances, never the
--    Member waivers row. Disable/re-enable preserves current_version_id
--    and all published history exactly as the Member RPC does.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.set_guest_waiver_required(
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
   where club_id = v_club_id and audience = 'guest'
     for update;

  if not found then raise exception 'waiver_not_found'; end if;
  if v_waiver.is_required is not distinct from p_required then return; end if;

  update public.waivers
     set is_required = p_required, updated_at = now()
   where id = v_waiver.id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'set_guest_waiver_required', 'waiver', v_waiver.id,
    jsonb_build_object('previous_required', v_waiver.is_required, 'new_required', p_required)
  );
end;
$$;

revoke execute on function public.set_guest_waiver_required(boolean) from public, anon;
grant  execute on function public.set_guest_waiver_required(boolean) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- H. Cross-audience hardening of the two existing Member RPCs whose
--    version lookup could otherwise resolve a Guest waiver_version_id now
--    that Section A makes audience='guest' possible. See the CORRECTION
--    PASS note at the top of this file for the full root-cause
--    explanation. Both bodies below are byte-identical to their exact
--    currently-applied 0192 text — re-verified directly against that
--    file immediately before writing this section — with exactly ONE
--    line added to each: `and w.audience = 'member'` in the existing
--    version-lookup WHERE clause. Nothing else differs: not one comment,
--    not one variable name, not one error code, not the locking, not the
--    audit action name or metadata shape. Same signature both directions
--    (no argument added, removed, renamed, or retyped), so CREATE OR
--    REPLACE preserves the existing 0192 grants automatically — no
--    REVOKE/GRANT follows either redefinition (same established
--    precedent as 0193's own accepted_at fix).
-- ═══════════════════════════════════════════════════════════════════════════

-- H1. update_member_waiver_draft — hardened. Published immutability is
--     still enforced HERE exactly as before: any status other than
--     'draft' is rejected outright. The only change from 0192's applied
--     body is the added `and w.audience = 'member'` line below.
create or replace function public.update_member_waiver_draft(
  p_version_id uuid,
  p_title      text,
  p_body       text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_title   text;
  v_body    text;
  v_version public.waiver_versions%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;

  select v.* into v_version
    from public.waiver_versions v
    join public.waivers w on w.id = v.waiver_id
   where v.id = p_version_id
     and w.club_id = v_club_id
     and w.audience = 'member'
     for update of v;

  if not found then raise exception 'waiver_version_not_found'; end if;
  -- Published-immutability gate — the only place in this schema a
  -- published title/body could ever be changed, and it is closed.
  if v_version.status <> 'draft' then raise exception 'version_not_editable'; end if;

  v_title := nullif(btrim(coalesce(p_title, '')), '');
  v_body  := nullif(btrim(coalesce(p_body, '')), '');

  if v_title is null then raise exception 'title_required'; end if;
  if v_body  is null then raise exception 'body_required'; end if;
  if length(v_title) > 300   then raise exception 'title_too_long'; end if;
  if length(v_body)  > 20000 then raise exception 'body_too_long'; end if;

  if v_version.title is not distinct from v_title
     and v_version.body is not distinct from v_body then
    return;
  end if;

  update public.waiver_versions
     set title = v_title, body = v_body, updated_at = now()
   where id = p_version_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'update_member_waiver_draft', 'waiver_version', p_version_id,
    jsonb_build_object(
      'waiver_id',      v_version.waiver_id,
      'version_number', v_version.version_number,
      'title_length',   length(v_title),
      'body_length',    length(v_body)
    )
  );
end;
$$;

-- H2. publish_member_waiver_version — hardened. Atomic within this single
--     function invocation exactly as before: draft -> published, then
--     repoint current_version_id, both before the one audit_log insert.
--     No unpublish path. The only change from 0192's applied body is the
--     added `and w.audience = 'member'` line below.
create or replace function public.publish_member_waiver_version(
  p_version_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_version public.waiver_versions%rowtype;
  v_waiver  public.waivers%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;

  select v.* into v_version
    from public.waiver_versions v
    join public.waivers w on w.id = v.waiver_id
   where v.id = p_version_id
     and w.club_id = v_club_id
     and w.audience = 'member'
     for update of v;

  if not found then raise exception 'waiver_version_not_found'; end if;
  -- Rejects re-publishing an already-published version outright (no silent
  -- no-op here — publishing is a deliberate act with a real side effect on
  -- waivers.current_version_id, not a value-equality save).
  if v_version.status <> 'draft' then raise exception 'version_not_draft'; end if;

  select * into v_waiver
    from public.waivers
   where id = v_version.waiver_id
     for update;

  update public.waiver_versions
     set status       = 'published',
         published_at = now(),
         published_by = auth.uid(),
         updated_at   = now()
   where id = p_version_id;

  update public.waivers
     set current_version_id = p_version_id,
         updated_at         = now()
   where id = v_waiver.id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'publish_member_waiver_version', 'waiver_version', p_version_id,
    jsonb_build_object(
      'waiver_id',           v_waiver.id,
      'version_number',      v_version.version_number,
      'previous_version_id', v_waiver.current_version_id
    )
  );
end;
$$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- LIVE INVOCATION QA (run after applying, in the Supabase SQL Editor)
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. As Admin, in a test club that already has a Member waiver:
--      select public.create_guest_waiver_draft('Guest Waiver', 'Guest body text');
--    Expect: succeeds, returns a new version id. Confirm the Member
--    waiver's current_version_id/is_required are unchanged:
--      select audience, is_required, current_version_id from public.waivers
--       where club_id = '<club_id>' order by audience;
--    Expect exactly two rows: member (unchanged) and guest (new draft, no
--    current_version_id yet).
--
-- 2. select public.create_guest_waiver_draft('x','y'); again in the same
--    club. Expect: error draft_already_exists.
--
-- 3. Two-way cross-audience rejection — both directions must now fail
--    identically with waiver_version_not_found:
--      select public.update_member_waiver_draft('<the guest draft''s version id>', 'x', 'y');
--      select public.publish_member_waiver_version('<the guest draft''s version id>');
--      select public.update_guest_waiver_draft('<a MEMBER draft''s version id>', 'x', 'y');
--      select public.publish_guest_waiver_version('<a MEMBER draft''s version id>');
--    Expect: all four raise waiver_version_not_found. If any of the first
--    two succeeds, STOP — the hardening in Section H did not take effect
--    and this migration must not be treated as safe to apply.
--
-- 4. select public.publish_guest_waiver_version('<the guest draft''s version id>');
--    Expect: succeeds. Re-check the two-row query from step 1 — only the
--    guest row's current_version_id should now be set; member's must be
--    byte-identical to before.
--
-- 5. As Staff or Member:
--      select public.create_guest_waiver_draft('x','y');
--    Expect: error insufficient_role (or not_authenticated for a fully
--    unauthenticated session).
--
-- 6. Confirm the hardening changed nothing else for genuine Member use:
--      select public.update_member_waiver_draft('<a real MEMBER draft''s version id>', 'New title', 'New body');
--      select public.publish_member_waiver_version('<a real MEMBER draft''s version id>');
--    Expect: both behave exactly as they did before this migration —
--    same success path, same audit_log rows, same error codes for every
--    pre-existing failure case (not_authenticated, insufficient_role,
--    waiver_version_not_found for a truly nonexistent id, version_not_
--    editable/version_not_draft for an already-published version).
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created
-- in this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- drop function if exists public.set_guest_waiver_required(boolean);
-- drop function if exists public.publish_guest_waiver_version(uuid);
-- drop function if exists public.update_guest_waiver_draft(uuid, text, text);
-- drop function if exists public.create_guest_waiver_draft(text, text);
-- CREATE OR REPLACE update_member_waiver_draft and publish_member_
-- waiver_version back to their exact pre-0195 (0192-applied) bodies —
-- remove the single `and w.audience = 'member'` line from each. No
-- signature change either direction, so no DROP is ever required for
-- either function, and no grant needs restoring (CREATE OR REPLACE never
-- touched them).
-- alter table public.waivers drop constraint if exists waivers_audience_check;
-- alter table public.waivers add constraint waivers_audience_check check (audience = 'member');
-- (Rolling back the CHECK is only safe if no audience='guest' row exists
-- yet — drop any such waivers/waiver_versions rows first if this is ever
-- actually rolled back after Guest drafts were created.) No table is
-- recreated and no RLS policy or trigger is changed. The two Member RPCs
-- above are intentionally redefined only for cross-audience hardening.