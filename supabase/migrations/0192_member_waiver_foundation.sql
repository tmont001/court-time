-- 0192_member_waiver_foundation.sql
-- Phase 43A-1 — Member Waiver Backend Foundation.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Court Time has never had a durable, versioned record of "this Member
-- agreed to this exact wording." This migration adds that: a club-scoped
-- Member waiver document that can be drafted, published, and versioned,
-- plus an append-only acceptance record tied to the exact version accepted.
-- Publishing a new version never rewrites what an earlier acceptance meant.
--
-- Backend/schema only. No UI, no Server Action, no application code touched.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- LOCKED PRODUCT DECISIONS (43A architecture review)
-- ═══════════════════════════════════════════════════════════════════════════
--   1. Exactly ONE Member waiver document per club — enforced by
--      unique(club_id, audience) on waivers, audience constrained to
--      'member' only. A second audience value (e.g. 'guest') is a future
--      43B migration, not this one.
--   2. Reacceptance is VERSION-BASED only. No expiry/cadence column exists
--      anywhere in this schema — the evaluator only ever compares against
--      waivers.current_version_id.
--   3. Admin-only compliance visibility in 43A. No 'staff' branch exists in
--      any RLS policy or RPC role check below. Staff visibility is a
--      deliberate future decision, not an oversight.
--   4. NO booking/lesson/event enforcement. This migration does not
--      reference reservations, lessons, events, or programs anywhere —
--      the evaluator and RPCs below are read/accept surfaces only.
--   5. NO Admin proxy acceptance. accept_member_waiver has no p_roster_
--      member_id / p_user_id parameter of any kind — it can only ever act
--      on the CALLER's own claimed roster identity. There is no second
--      "accept on behalf of" RPC.
--   6. Any authenticated claimed roster identity may accept THEIR OWN
--      waiver, regardless of application role. accept_member_waiver (and
--      get_my_member_waiver_status) contain no role check of any kind —
--      only an active-club check and a claimed-roster-identity resolution.
--   7. Guest waiver acceptance is out of scope (Phase 43B). waiver_
--      acceptances.roster_member_id is NOT NULL — no guest identity shape
--      is introduced here.
--   8. Disabling/re-enabling the requirement (waivers.is_required) never
--      touches waiver_acceptances — historical acceptance rows are never
--      updated or deleted by any RPC in this file. Evaluation always
--      reflects the CURRENT published version via waivers.current_
--      version_id, never a point-in-time snapshot.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- NOT IN SCOPE FOR THIS MIGRATION
-- ═══════════════════════════════════════════════════════════════════════════
-- No 'retired' version status (explicitly excluded — an old published
-- version simply stops being current_version_id; its row is never touched
-- again). No unpublish path. No draft body/title snapshot on acceptance
-- (the immutable waiver_versions row IS the historical evidence — see
-- Section C below). No IP/user-agent capture. No Admin member-detail UI,
-- no Settings UI, no /profile UI — those are later 43A checkpoints.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- CORRECTION PASS (post-review, before first apply — this file has never
-- been applied to any database, so all three corrections are edited
-- directly in place rather than shipped as a follow-up migration)
-- ═══════════════════════════════════════════════════════════════════════════
--   1. accept_member_waiver now takes a FOR SHARE lock on the club's
--      waivers row before reading current_version_id — closes a race
--      where a concurrent publish_member_waiver_version (which takes
--      FOR UPDATE on the same row) could repoint current_version_id
--      between an unlocked read and the acceptance insert, letting a
--      Member "accept" a version that was no longer current the instant
--      the row was committed. FOR SHARE (not FOR UPDATE) so concurrent
--      Member acceptances never serialize against each other — only
--      against an in-flight publish.
--   2. waivers.current_version_id is now a composite FK (current_version_
--      id, id) -> waiver_versions(id, waiver_id), backed by a new
--      unique(id, waiver_id) on waiver_versions. This structurally proves
--      the current version belongs to THIS waiver, not merely that the
--      version id exists somewhere — impossible to violate even via
--      direct/privileged SQL. NULL current_version_id remains fully valid
--      (Postgres' default MATCH SIMPLE short-circuits a multi-column FK
--      when any referencing column is NULL).
--   3. A new BEFORE UPDATE OR DELETE trigger on waiver_versions
--      (_reject_published_waiver_version_mutation) rejects any UPDATE or
--      DELETE once OLD.status = 'published' — a DB-level backstop behind
--      update_member_waiver_draft's existing RPC-level check. The
--      draft -> published transition itself is unaffected (OLD.status is
--      still 'draft' at the moment that UPDATE fires), and the trigger
--      never touches NEW.updated_at, so trigger_set_updated_at's own
--      BEFORE UPDATE trigger on the same table is unaffected.
--
-- Apply in Supabase SQL Editor (cloud only). Not applied by this checkpoint.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- A. waivers — one row per (club, audience). Mutable pointer only: which
--    version is current, and whether it's required. Never holds wording.
-- ═══════════════════════════════════════════════════════════════════════════
create table public.waivers (
  id                  uuid        primary key default gen_random_uuid(),
  club_id             uuid        not null references public.clubs(id) on delete cascade,
  audience            text        not null default 'member'
                         check (audience = 'member'),
  -- FK to waiver_versions added below (Section B) once that table exists —
  -- circular reference, standard two-step pattern.
  current_version_id  uuid,
  is_required         boolean     not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (club_id, audience)
);

comment on table public.waivers is
  'Phase 43A: one row per (club_id, audience). audience is constrained to
   ''member'' only in 43A — a second value (e.g. ''guest'') is a future,
   additive 43B migration. current_version_id points at the single
   currently-required waiver_versions row; NULL means no version has ever
   been published. is_required=false disables the requirement without
   erasing current_version_id or any acceptance history.';

create trigger waivers_updated_at
  before update on public.waivers
  for each row execute function public.trigger_set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- B. waiver_versions — IMMUTABLE once published. title/body are never
--    updated by any RPC once status = 'published' (enforced in Section I),
--    and a DB-level trigger below rejects any UPDATE/DELETE once
--    OLD.status = 'published', independent of any RPC.
-- ═══════════════════════════════════════════════════════════════════════════
create table public.waiver_versions (
  id             uuid        primary key default gen_random_uuid(),
  waiver_id      uuid        not null references public.waivers(id) on delete cascade,
  version_number integer     not null check (version_number > 0),
  title          text        not null,
  body           text        not null,
  status         text        not null default 'draft'
                    check (status in ('draft', 'published')),
  published_at   timestamptz,
  published_by   uuid        references public.profiles(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  unique (waiver_id, version_number)
);

comment on table public.waiver_versions is
  'Phase 43A: immutable-once-published wording. No ''retired'' status
   exists by design — publishing a newer version only repoints waivers.
   current_version_id; an old published row is never updated or deleted.
   title/body may only be edited by update_member_waiver_draft while
   status = ''draft''; a DB-level trigger
   (_reject_published_waiver_version_mutation) additionally rejects any
   UPDATE/DELETE once a row''s status is ''published'', independent of
   any RPC.';

create trigger waiver_versions_updated_at
  before update on public.waiver_versions
  for each row execute function public.trigger_set_updated_at();

-- DB-level backstop (defense in depth alongside the RPC-level check in
-- create_member_waiver_draft): at most one 'draft' row per waiver_id.
create unique index waiver_versions_one_draft_per_waiver
  on public.waiver_versions (waiver_id)
  where status = 'draft';

-- Composite uniqueness backing the same-waiver FK completed below: id
-- alone is already unique (primary key), so this adds nothing on its own
-- — it exists purely so waivers.current_version_id can be constrained to
-- a version belonging to itself, not merely to some version that exists.
alter table public.waiver_versions
  add constraint waiver_versions_id_waiver_id_uniq unique (id, waiver_id);

-- DB-level published-immutability backstop (defense in depth alongside
-- update_member_waiver_draft's RPC-level status check): once a row's
-- status is 'published', no UPDATE or DELETE may ever touch it again —
-- structurally, independent of any RPC. Fires only when OLD.status is
-- ALREADY 'published', so the one legitimate transition (draft ->
-- published, where OLD.status = 'draft') is unaffected, and this never
-- assigns NEW.updated_at itself, so trigger_set_updated_at's own BEFORE
-- UPDATE trigger on this same table is unaffected.
create or replace function public._reject_published_waiver_version_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if OLD.status = 'published' then
    raise exception 'published_waiver_version_immutable';
  end if;
  if TG_OP = 'DELETE' then
    return OLD;
  end if;
  return NEW;
end;
$$;

comment on function public._reject_published_waiver_version_mutation() is
  'Phase 43A-1 DB-level backstop: once a waiver_versions row is published,
   no UPDATE or DELETE may ever touch it again, independent of any RPC-
   level check. Allows the one legitimate transition (OLD.status =
   ''draft'' -> NEW.status = ''published'') because the guard only fires
   when OLD.status is already ''published''.';

revoke execute on function public._reject_published_waiver_version_mutation()
  from public, anon, authenticated;

create trigger waiver_versions_block_published_mutation
  before update or delete on public.waiver_versions
  for each row execute function public._reject_published_waiver_version_mutation();

-- Complete the circular reference from Section A. Composite FK (not just
-- current_version_id -> id): structurally proves the referenced version's
-- own waiver_id equals THIS waiver's id — one waiver can never point at
-- another waiver's version, even via direct/privileged SQL. NULL
-- current_version_id remains fully valid: Postgres' default MATCH SIMPLE
-- short-circuits a multi-column FK whenever any referencing column
-- (current_version_id here) is NULL, regardless of the other column.
alter table public.waivers
  add constraint waivers_current_version_id_fkey
  foreign key (current_version_id, id) references public.waiver_versions(id, waiver_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- C. waiver_acceptances — append-only. No updated_at column, no update/
--    delete RPC anywhere in this file. Deliberately stores NO body/title/
--    name snapshot, no IP, no user agent — the immutable waiver_versions
--    row (Section B) IS the historical evidence; duplicating its wording
--    here would only create a second, driftable copy to keep in sync.
-- ═══════════════════════════════════════════════════════════════════════════
create table public.waiver_acceptances (
  id                 uuid        primary key default gen_random_uuid(),
  club_id            uuid        not null references public.clubs(id) on delete cascade,
  waiver_version_id  uuid        not null references public.waiver_versions(id),
  roster_member_id   uuid        not null references public.roster_members(id),
  accepted_by        uuid        not null references public.profiles(id),
  accepted_at        timestamptz not null default now(),

  unique (waiver_version_id, roster_member_id)
);

comment on table public.waiver_acceptances is
  'Phase 43A: append-only. roster_member_id is the durable club identity
   that owes the waiver (Phase 42A convention); accepted_by is the auth
   user who was logged in when the click happened — evidence of who acted,
   not the identity being evaluated. roster_member_id is NOT NULL: guest
   (unclaimed-identity) acceptance is explicitly out of scope (Phase 43B),
   and reusing this table for guests would require weakening this
   constraint for every Member row too. No Admin-proxy insert path exists
   anywhere in this schema.';

create index waiver_acceptances_roster_member_idx
  on public.waiver_acceptances (roster_member_id);

create index waiver_acceptances_club_idx
  on public.waiver_acceptances (club_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- D. RLS — same posture as audit_log (0005): admin-only SELECT, zero
--    insert/update/delete policies anywhere. Every write goes through a
--    SECURITY DEFINER RPC below, which bypasses RLS for its own writes.
--    Member-side reads are RPC-mediated (Sections F) rather than a second,
--    narrower SELECT policy — smaller and safer than expressing "current
--    published version only" as an RLS predicate, and it keeps drafts
--    structurally unreachable by any Member, not just filtered out.
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.waivers            enable row level security;
alter table public.waiver_versions    enable row level security;
alter table public.waiver_acceptances enable row level security;

create policy "waivers_select_admin"
  on public.waivers for select
  using (
    club_id = public.current_user_club_id()
    and public.current_user_role() = 'admin'
  );

create policy "waiver_versions_select_admin"
  on public.waiver_versions for select
  using (
    exists (
      select 1 from public.waivers w
       where w.id = waiver_versions.waiver_id
         and w.club_id = public.current_user_club_id()
    )
    and public.current_user_role() = 'admin'
  );

create policy "waiver_acceptances_select_admin"
  on public.waiver_acceptances for select
  using (
    club_id = public.current_user_club_id()
    and public.current_user_role() = 'admin'
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- E. _evaluate_member_waiver_status — the ONE canonical evaluator. Private:
--    revoked from public/anon/authenticated, exactly matching is_active_
--    club_member's (0188) posture. Every other caller in this file (and
--    any future caller) must use this function, never re-derive the logic.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public._evaluate_member_waiver_status(
  p_roster_member_id uuid,
  p_club_id          uuid
)
returns text
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select case
        -- not_required: requirement disabled, or nothing has ever been
        -- published, or no waiver document exists at all for this club
        -- (the outer coalesce below covers the "no row" case).
        when w.is_required is false        then 'not_required'
        when w.current_version_id is null  then 'not_required'
        when exists (
          select 1 from public.waiver_acceptances a
           where a.waiver_version_id = w.current_version_id
             and a.roster_member_id  = p_roster_member_id
        ) then 'current'
        when exists (
          select 1
            from public.waiver_acceptances a
            join public.waiver_versions v on v.id = a.waiver_version_id
           where v.waiver_id        = w.id
             and a.roster_member_id = p_roster_member_id
        ) then 'outdated'
        else 'never_accepted'
      end
      from public.waivers w
      where w.club_id  = p_club_id
        and w.audience = 'member'
    ),
    'not_required'
  );
$$;

comment on function public._evaluate_member_waiver_status(uuid, uuid) is
  'Phase 43A canonical Member-waiver status predicate. Returns exactly one
   of: not_required, current, outdated, never_accepted. Role-agnostic by
   design — never consults roster_members.role or club_memberships.role.
   Private helper — not granted to authenticated; callers are other
   SECURITY DEFINER functions in this schema owned by the same role.';

revoke execute on function public._evaluate_member_waiver_status(uuid, uuid)
  from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- F. get_my_member_waiver_status — authenticated, role-agnostic (decision
--    6). Resolves the CALLER's own claimed roster identity in their active
--    club. Exposes only PUBLISHED version fields — a draft's title/body
--    can never reach this return shape because the join below requires
--    cv.status = 'published'.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.get_my_member_waiver_status()
returns table (
  status              text,
  waiver_id           uuid,
  current_version_id  uuid,
  version_number      integer,
  title               text,
  body                text,
  published_at        timestamptz,
  accepted_at         timestamptz,
  is_required         boolean
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_club_id             uuid;
  v_roster_member_id    uuid;
  v_status              text;
  v_waiver_id           uuid;
  v_current_version_id  uuid;
  v_version_number      integer;
  v_title               text;
  v_body                text;
  v_published_at        timestamptz;
  v_is_required         boolean;
  v_accepted_at         timestamptz;
begin
  v_club_id := public.current_user_club_id();
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  -- Role-agnostic (decision 6): resolved purely from claimed_by, no role
  -- check of any kind — a Member, Pro, Staff, or Admin's own roster
  -- identity resolves identically.
  select id into v_roster_member_id
    from public.roster_members
   where club_id    = v_club_id
     and claimed_by = auth.uid();
  if not found then raise exception 'no_roster_identity'; end if;

  v_status := public._evaluate_member_waiver_status(v_roster_member_id, v_club_id);

  select w.id, w.current_version_id, cv.version_number, cv.title, cv.body,
         cv.published_at, coalesce(w.is_required, false)
    into v_waiver_id, v_current_version_id, v_version_number, v_title, v_body,
         v_published_at, v_is_required
    from public.waivers w
    left join public.waiver_versions cv
      on cv.id = w.current_version_id and cv.status = 'published'
   where w.club_id = v_club_id and w.audience = 'member';

  if v_status = 'current' then
    select accepted_at into v_accepted_at
      from public.waiver_acceptances
     where waiver_version_id = v_current_version_id
       and roster_member_id  = v_roster_member_id;
  end if;

  return query
    select v_status, v_waiver_id, v_current_version_id, v_version_number,
           v_title, v_body, v_published_at, v_accepted_at,
           coalesce(v_is_required, false);
end;
$$;

revoke execute on function public.get_my_member_waiver_status() from public, anon;
grant  execute on function public.get_my_member_waiver_status() to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- G. get_member_waiver_status — Admin-only, same-club enforced. Narrower
--    shape than F (no body) — a compliance-status lookup, not an
--    acceptance surface.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.get_member_waiver_status(
  p_roster_member_id uuid
)
returns table (
  status              text,
  waiver_id           uuid,
  current_version_id  uuid,
  version_number      integer,
  title               text,
  published_at        timestamptz,
  accepted_at         timestamptz,
  is_required         boolean
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_club_id             uuid;
  v_role                text;
  v_status              text;
  v_waiver_id           uuid;
  v_current_version_id  uuid;
  v_version_number      integer;
  v_title               text;
  v_published_at        timestamptz;
  v_is_required         boolean;
  v_accepted_at         timestamptz;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;

  if not exists (
    select 1 from public.roster_members
     where id = p_roster_member_id and club_id = v_club_id
  ) then
    raise exception 'roster_member_not_found';
  end if;

  v_status := public._evaluate_member_waiver_status(p_roster_member_id, v_club_id);

  select w.id, w.current_version_id, cv.version_number, cv.title,
         cv.published_at, coalesce(w.is_required, false)
    into v_waiver_id, v_current_version_id, v_version_number, v_title,
         v_published_at, v_is_required
    from public.waivers w
    left join public.waiver_versions cv
      on cv.id = w.current_version_id and cv.status = 'published'
   where w.club_id = v_club_id and w.audience = 'member';

  if v_status = 'current' then
    select accepted_at into v_accepted_at
      from public.waiver_acceptances
     where waiver_version_id = v_current_version_id
       and roster_member_id  = p_roster_member_id;
  end if;

  return query
    select v_status, v_waiver_id, v_current_version_id, v_version_number,
           v_title, v_published_at, v_accepted_at, coalesce(v_is_required, false);
end;
$$;

revoke execute on function public.get_member_waiver_status(uuid) from public, anon;
grant  execute on function public.get_member_waiver_status(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- H. create_member_waiver_draft — Admin-only. Race-safe find-or-create of
--    the club's one waivers row, then a locked, checked draft insert.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.create_member_waiver_draft(
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

  -- Find-or-create, race-safe: ON CONFLICT DO NOTHING makes concurrent
  -- first-time creation a no-op for every transaction but one; the
  -- SELECT ... FOR UPDATE immediately after always locks whatever row now
  -- exists (this transaction's own insert, or a concurrent transaction's —
  -- FOR UPDATE simply blocks until that transaction commits, then reads
  -- its committed row).
  insert into public.waivers (club_id, audience)
  values (v_club_id, 'member')
  on conflict (club_id, audience) do nothing;

  select * into v_waiver
    from public.waivers
   where club_id = v_club_id and audience = 'member'
     for update;

  -- RPC-level guard (defense in depth alongside the partial unique index
  -- from Section B) — a clean, specific error instead of a raw constraint
  -- violation.
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
    v_club_id, auth.uid(), 'create_member_waiver_draft', 'waiver_version', v_new_version_id,
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

revoke execute on function public.create_member_waiver_draft(text, text) from public, anon;
grant  execute on function public.create_member_waiver_draft(text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- I. update_member_waiver_draft — Admin-only. Published immutability is
--    enforced HERE: any status other than 'draft' is rejected outright.
-- ═══════════════════════════════════════════════════════════════════════════
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

revoke execute on function public.update_member_waiver_draft(uuid, text, text) from public, anon;
grant  execute on function public.update_member_waiver_draft(uuid, text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- J. publish_member_waiver_version — Admin-only. Atomic within this single
--    function invocation: draft -> published, then repoint current_
--    version_id, both before the one audit_log insert. No unpublish path
--    exists anywhere in this file.
-- ═══════════════════════════════════════════════════════════════════════════
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

revoke execute on function public.publish_member_waiver_version(uuid) from public, anon;
grant  execute on function public.publish_member_waiver_version(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- K. set_member_waiver_required — Admin-only toggle. Never touches waiver_
--    versions or waiver_acceptances — disable/re-enable preserves all
--    history (decision 8).
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
end;
$$;

revoke execute on function public.set_member_waiver_required(boolean) from public, anon;
grant  execute on function public.set_member_waiver_required(boolean) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- L. accept_member_waiver — authenticated, ROLE-AGNOSTIC (decision 6), NO
--    proxy path (decision 5: no p_roster_member_id/p_user_id parameter of
--    any kind — only the caller's own claimed identity is ever resolved).
--    Idempotent via ON CONFLICT DO NOTHING + FOUND check; append-only.
--    Locks the waivers row FOR SHARE before validating/inserting, closing
--    the accept-vs-publish race against publish_member_waiver_version's
--    FOR UPDATE (see the CORRECTION PASS note at the top of this file).
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

  -- Role-agnostic (decision 6): no role check anywhere in this function.
  -- Resolved purely from the caller's own claimed_by row — a Member, Pro,
  -- Staff, or Admin's own roster identity is treated identically, and no
  -- other identity can ever be supplied.
  select id into v_roster_member_id
    from public.roster_members
   where club_id    = v_club_id
     and claimed_by = auth.uid();
  if not found then raise exception 'no_roster_identity'; end if;

  -- FOR SHARE (not FOR UPDATE): closes the accept-vs-publish race —
  -- publish_member_waiver_version takes FOR UPDATE on this same row, so a
  -- concurrent publish cannot repoint current_version_id while this
  -- acceptance is validating/inserting against it (and vice versa: an
  -- in-flight acceptance defers a concurrent publish until it commits).
  -- FOR SHARE specifically — not FOR UPDATE — so multiple Members
  -- accepting at the same time never serialize against EACH OTHER, only
  -- against a publisher.
  select * into v_waiver
    from public.waivers
   where club_id = v_club_id and audience = 'member'
     for share;
  if not found or v_waiver.current_version_id is null then
    raise exception 'no_current_waiver_version';
  end if;

  -- Stale-version rejection: the client must be accepting the version that
  -- is current RIGHT NOW, not a version it fetched earlier that a
  -- concurrent publish has since superseded. Safe against the race above:
  -- the FOR SHARE lock guarantees v_waiver.current_version_id reflects a
  -- value that cannot change underneath this transaction before it commits.
  if p_waiver_version_id is distinct from v_waiver.current_version_id then
    raise exception 'stale_waiver_version';
  end if;

  insert into public.waiver_acceptances (club_id, waiver_version_id, roster_member_id, accepted_by, accepted_at)
  values (v_club_id, p_waiver_version_id, v_roster_member_id, auth.uid(), now())
  on conflict (waiver_version_id, roster_member_id) do nothing
  returning id, accepted_at into v_new_id, v_accepted_at;

  if not found then
    -- Idempotent repeat acceptance: no new row, no new audit entry.
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

  return v_accepted_at;
end;
$$;

revoke execute on function public.accept_member_waiver(uuid) from public, anon;
grant  execute on function public.accept_member_waiver(uuid) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- drop function if exists public.accept_member_waiver(uuid);
-- drop function if exists public.set_member_waiver_required(boolean);
-- drop function if exists public.publish_member_waiver_version(uuid);
-- drop function if exists public.update_member_waiver_draft(uuid, text, text);
-- drop function if exists public.create_member_waiver_draft(text, text);
-- drop function if exists public.get_member_waiver_status(uuid);
-- drop function if exists public.get_my_member_waiver_status();
-- drop function if exists public._evaluate_member_waiver_status(uuid, uuid);
-- drop table if exists public.waiver_acceptances;
-- alter table public.waivers drop constraint if exists waivers_current_version_id_fkey;
-- drop trigger if exists waiver_versions_block_published_mutation on public.waiver_versions;
-- drop function if exists public._reject_published_waiver_version_mutation();
-- alter table public.waiver_versions drop constraint if exists waiver_versions_id_waiver_id_uniq;
-- drop table if exists public.waiver_versions;
-- drop table if exists public.waivers;
-- No other table, policy, or function is touched by this migration.
-- Nothing in reservations/lessons/events/programs is read or written here.
