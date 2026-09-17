-- 0196_waiver_pdf_document_foundation.sql
-- Phase 43B-3A — PDF Waiver Document Foundation. BACKEND/DATABASE ONLY.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS / PRODUCT PIVOT
-- ═══════════════════════════════════════════════════════════════════════════
-- Court Time is NOT a waiver-authoring product. Clubs already have their
-- own legal waiver documents. For all NEW waiver revisions (both Member
-- and Guest, independently configurable), the canonical format is now
-- PDF-only. Normal UI will show only a filename + "Last updated" — never
-- "Version N" — though the internal version/revision model is retained
-- for acceptance evidence and history.
--
-- A PRIOR draft of this exact migration number
-- (0196_guest_waiver_invitation_acceptance_foundation.sql) was written,
-- never applied, never committed, and is now ABANDONED along with its
-- focused regression test. It is deleted, not superseded-in-place. Guest
-- invitation/acceptance (bearer links, resolve/accept RPCs) move to a
-- LATER checkpoint (0197+) and are NOT part of this file. This file does
-- NOT create the Guest invitation table, the Guest acceptance-evidence
-- table, or any Guest invitation RPC.
--
-- 0192-0195 are APPLIED and IMMUTABLE — not touched. This migration is
-- purely additive: a new table, an additive nullable-column relaxation,
-- and two new RPCs. No existing table's rows, no existing RPC body, no
-- existing trigger/FK/index from 0192-0195 is altered or dropped.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- TARGETED AUDIT (performed before writing this file)
-- ═══════════════════════════════════════════════════════════════════════════
-- waiver_versions (0192, immutable): title text not null, body text not
-- null, version_number integer not null check (version_number > 0),
-- unique(waiver_id, version_number), status draft|published, a partial
-- unique index enforcing one draft per waiver, and an unconditional-once-
-- published immutability trigger (_reject_published_waiver_version_
-- mutation — fires whenever OLD.status = 'published', blocking every
-- UPDATE/DELETE from that point on, independent of any RPC or caller
-- privilege). waivers.current_version_id is a composite FK to
-- (waiver_versions.id, waiver_versions.waiver_id), proving a version
-- belongs to its own waiver.
--
-- Canonical club-role identity model (0081/0082, widened for staff in
-- 0131): current_user_club_id()/current_user_role() derive from
-- club_memberships via profiles.active_club_id and are AUTH.UID()-BASED —
-- they resolve the CALLING authenticated user's own membership. This RPC
-- (Section G) is called by service_role via createPrivilegedClient() on
-- behalf of a *different* user (the Admin who performed the upload in a
-- prior, separately-authenticated step) — auth.uid() in that context does
-- not represent the Admin, so current_user_role()/current_user_club_id()
-- CANNOT be used here. Instead this RPC independently queries
-- club_memberships directly for the explicitly-supplied p_actor_user_id:
-- role = 'admin' and status = 'active' and removed_at is null and
-- club_id = p_club_id. This is the same active-membership definition
-- _current_user_active_membership() (0082) uses internally, just applied
-- to an explicit actor instead of auth.uid().
--
-- audit_log.actor_id (0005) is NOT NULL, references profiles(id) — the
-- publish RPC audits using p_actor_user_id (the real, verified Admin),
-- never auth.uid() (meaningless here) and never a fabricated actor.
--
-- Storage: per current Supabase guidance, storage.buckets/storage.objects
-- are NOT created or modified via SQL migration in this checkpoint — that
-- is separate infrastructure configuration (Storage API/Dashboard). This
-- file only documents the requirement below; it performs no DML against
-- either table.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- SCOPE (locked)
-- ═══════════════════════════════════════════════════════════════════════════
--   B. waiver_document_files — 1:1 immutable PDF artifact record for a
--      waiver_versions row (waiver_version_id is itself the primary key —
--      structurally 1:1, not just a unique index on a separate id).
--   C. Unconditional immutability trigger (no legitimate mutation path
--      exists for this table at all — a replacement PDF always creates a
--      NEW version + NEW document row, never touches an old one).
--   D. RLS enabled, zero policies, all direct table privileges revoked
--      from public/anon/authenticated. No Member/Admin/Staff direct
--      table access — all access is later, privileged, server-side code.
--   E. waiver_versions.body -> nullable (additive constraint loosening;
--      invalidates no existing row). title remains NOT NULL.
--   G. publish_waiver_pdf_version — service_role ONLY finalization RPC.
--      Explicit actor/club params, independently verified against
--      club_memberships (never auth.uid()). Computes storage_path
--      internally; never accepts it from the caller.
--   K. discard_waiver_draft — authenticated, Admin-only. Deletes ONLY a
--      draft-status waiver_versions row, for the transition away from
--      pre-PDF text drafts.
--
-- NOT in this migration (explicitly out of scope): Admin upload UI,
-- Member/Guest PDF viewing UI, Guest invitation/acceptance (moves to
-- 0197+), any public route, signed URLs, Storage bucket creation, browser
-- upload code, destructive conversion of any existing text waiver.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- REQUIRED FOLLOW-UP INFRASTRUCTURE (43B-3B, NOT created by this file)
-- ═══════════════════════════════════════════════════════════════════════════
-- A Supabase Storage bucket must be created separately (Storage API/
-- Dashboard, not SQL):
--   name:              waiver-documents
--   visibility:        private
--   max file size:     10 MB (10485760 bytes)
--   allowed MIME type: application/pdf
-- Object path convention (enforced by publish_waiver_pdf_version below,
-- computed server-side, never caller-supplied):
--   {club_id}/{audience}/{waiver_version_id}.pdf
--
-- Apply in Supabase SQL Editor (cloud only). Not applied by this checkpoint.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- B. waiver_document_files — 1:1 immutable PDF artifact evidence.
-- ═══════════════════════════════════════════════════════════════════════════
create table public.waiver_document_files (
  waiver_version_id uuid        primary key references public.waiver_versions(id),
  storage_path       text        not null unique,
  original_filename   text        not null,
  mime_type           text        not null check (mime_type = 'application/pdf'),
  file_size_bytes     bigint      not null check (file_size_bytes > 0 and file_size_bytes <= 10485760),
  sha256_digest       text        not null check (sha256_digest ~ '^[0-9a-f]{64}$'),
  uploaded_by         uuid        not null references public.profiles(id),
  uploaded_at         timestamptz not null default now()
);

comment on table public.waiver_document_files is
  'Phase 43B-3A: 1:1 immutable PDF artifact record for a waiver_versions
   row. waiver_version_id is the primary key (not a separate id +
   unique index) — structurally proves at most one document per version.
   No title/body/file-content snapshot here: the file itself, referenced
   by storage_path, IS the evidence. sha256_digest is deliberately NOT
   unique — the same exact PDF may legitimately be reused for Member and
   Guest, across different clubs, and across different internal
   revisions (e.g. re-uploading the identical file to bump the "Last
   updated" date). A replacement PDF always creates a NEW waiver_versions
   row + a NEW waiver_document_files row (via publish_waiver_pdf_version,
   Section G) — this table has no UPDATE path at all.';

-- ═══════════════════════════════════════════════════════════════════════════
-- C. Immutability — unconditional, matching the same append-only,
--    unconditional-trigger rationale the abandoned Guest acceptance-
--    evidence draft used (still valid here): every row in this table is
--    evidence from the moment it exists, so
--    there is no legitimate transition to protect against.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public._reject_waiver_document_file_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'waiver_document_file_immutable';
end;
$$;

comment on function public._reject_waiver_document_file_mutation() is
  'Phase 43B-3A: unconditional DB-level immutability backstop for
   waiver_document_files — rejects every UPDATE and DELETE, for every
   row, regardless of caller privilege. A replacement PDF always inserts
   a new row against a new waiver_versions.id; no RPC in this schema ever
   attempts to update or delete a document row.';

revoke execute on function public._reject_waiver_document_file_mutation()
  from public, anon, authenticated;

create trigger waiver_document_files_block_mutation
  before update or delete on public.waiver_document_files
  for each row execute function public._reject_waiver_document_file_mutation();

-- ═══════════════════════════════════════════════════════════════════════════
-- D. RLS — deny-all. No policy of any kind. All access is later,
--    privileged, server-side code (createPrivilegedClient()-backed) after
--    its own authorization and Storage validation — not created here.
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.waiver_document_files enable row level security;

revoke all on table public.waiver_document_files from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- E. waiver_versions.body -> nullable. Additive constraint loosening:
--    every existing row already satisfies NOT NULL, so this invalidates
--    nothing historical. New PDF-backed versions insert body = NULL
--    (Section H). title remains NOT NULL — kept as an internal label
--    only (Section F); normal UI will not surface it as free text for
--    new PDF revisions.
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.waiver_versions
  alter column body drop not null;

-- ═══════════════════════════════════════════════════════════════════════════
-- G. publish_waiver_pdf_version — service_role ONLY. Finalizes a PDF
--    upload that the future server-side finalize action has ALREADY
--    validated and placed in Storage. Cannot rely on auth.uid() (see the
--    audit note above) — takes explicit actor/club and independently
--    verifies via club_memberships, the canonical per-club membership
--    model (not the legacy profiles.role column, and not current_user_
--    role()/current_user_club_id(), which are auth.uid()-scoped).
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

  -- Actor verification against the CANONICAL per-club membership model.
  -- The helper functions used by every other authenticated waiver RPC
  -- resolve the CALLING session's own identity, which is not meaningful
  -- for a service_role caller acting on a different, already-verified
  -- user's behalf — so this RPC queries the membership table directly
  -- for the explicitly-supplied actor instead, and never the legacy
  -- profiles.role column.
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

  -- Find-or-create, race-safe, same idiom as create_member_waiver_draft
  -- (0192)/create_guest_waiver_draft (0195).
  insert into public.waivers (club_id, audience)
  values (p_club_id, p_audience)
  on conflict (club_id, audience) do nothing;

  select * into v_waiver
    from public.waivers
   where club_id = p_club_id and audience = p_audience
     for update;

  -- A club may already have a pre-PDF text draft in progress — do NOT
  -- silently discard it. An Admin must explicitly call
  -- discard_waiver_draft (Section K) first.
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

  -- No file bytes, signed URLs, tokens, or Storage credentials — and the
  -- digest itself is not duplicated into audit metadata (it already
  -- lives, permanently, in waiver_document_files).
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

  return query select p_version_id, v_next_version_number, v_storage_path, v_published_at;
end;
$$;

revoke execute on function public.publish_waiver_pdf_version(uuid, uuid, text, uuid, text, text, bigint, text)
  from public, anon, authenticated;
grant  execute on function public.publish_waiver_pdf_version(uuid, uuid, text, uuid, text, text, bigint, text)
  to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- K. discard_waiver_draft — authenticated, Admin-only. Transition path for
--    a pre-existing unpublished TEXT draft that would otherwise block
--    publish_waiver_pdf_version with draft_already_exists. A deliberate,
--    explicit Admin action — never invoked implicitly from the publish
--    RPC above.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.discard_waiver_draft(
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
    join public.waivers w
      on w.id = v.waiver_id
     and w.audience in ('member', 'guest')
   where v.id = p_version_id
     and w.club_id = v_club_id
     for update of v;

  if not found then raise exception 'version_not_found'; end if;
  if v_version.status <> 'draft' then raise exception 'version_not_draft'; end if;

  select * into v_waiver from public.waivers where id = v_version.waiver_id;

  delete from public.waiver_versions where id = p_version_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'discard_waiver_draft', 'waiver_version', p_version_id,
    jsonb_build_object(
      'waiver_id',      v_waiver.id,
      'audience',       v_waiver.audience,
      'version_number', v_version.version_number
    )
  );
end;
$$;

revoke execute on function public.discard_waiver_draft(uuid) from public, anon;
grant  execute on function public.discard_waiver_draft(uuid) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- LIVE INVOCATION QA (run after applying, in the Supabase SQL Editor)
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. As a service_role caller, for a test club with a currently ACTIVE
--    club_memberships admin row for some user U:
--      select * from public.publish_waiver_pdf_version(
--        '<U profile id>', '<club id>', 'member', gen_random_uuid(),
--        'club-waiver.pdf', 'Club Waiver', 123456,
--        repeat('a', 64)
--      );
--    Expect: one row, version_number = 1 (first revision), storage_path =
--    '<club id>/member/<version id>.pdf'.
--
-- 2. select body from public.waiver_versions where id = '<the new version id>';
--    Expect: NULL.
--
-- 3. Call again with a DIFFERENT p_version_id for the SAME club+audience.
--    Expect: succeeds, version_number = 2, waivers.current_version_id now
--    points at the new row; the FIRST published row is untouched (still
--    published, title/body/timestamps unchanged) — confirm via:
--      select status, published_at from public.waiver_versions where id = '<first version id>';
--
-- 4. As authenticated (any role) or anon, directly via PostgREST:
--      select * from public.publish_waiver_pdf_version(...);
--    Expect: permission denied.
--
-- 5. Call with p_actor_user_id belonging to a Member (not Admin) of the
--    club. Expect: insufficient_role.
--
-- 6. Attempt to UPDATE or DELETE a waiver_document_files row directly.
--    Expect: waiver_document_file_immutable.
--
-- 7. As Admin (via discard_waiver_draft), create a text draft first
--    (create_member_waiver_draft), then attempt publish_waiver_pdf_version
--    for the same club+audience. Expect: draft_already_exists. Call
--    discard_waiver_draft(<draft version id>) as that Admin — expect:
--    succeeds, the draft row is gone. Retry publish_waiver_pdf_version —
--    expect: succeeds.
--
-- 8. As Admin, attempt discard_waiver_draft on a PUBLISHED version id.
--    Expect: version_not_draft.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created
-- in this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- drop function if exists public.discard_waiver_draft(uuid);
-- drop function if exists public.publish_waiver_pdf_version(uuid, uuid, text, uuid, text, text, bigint, text);
-- alter table public.waiver_versions alter column body set not null;  -- ONLY safe if no PDF-backed row exists yet
-- drop trigger if exists waiver_document_files_block_mutation on public.waiver_document_files;
-- drop function if exists public._reject_waiver_document_file_mutation();
-- drop table if exists public.waiver_document_files;
-- No table, RLS policy, or function outside this migration's own new
-- objects is touched — waivers/waiver_versions, the pre-existing Member
-- acceptance-evidence table, club_memberships, and audit_log are all
-- read-only or additively-altered from this migration's perspective.
