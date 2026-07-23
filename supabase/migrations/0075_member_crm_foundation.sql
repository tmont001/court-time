-- 0075_member_crm_foundation.sql
-- Phase 24A: Member CRM foundation.
-- • Tighten profiles SELECT privacy (table-level REVOKE + column-level GRANT)
-- • member_notes table with add/update/archive/get RPCs
-- • Backfill existing admin_notes values to audit_log
-- • set_member_notes: REVOKE (deprecated — use member_notes RPCs)
-- • get_members: remove admin_notes from return type
-- • mark_attendance: harden with public. schema prefix + set search_path
-- • mark_lesson_outcome: add member_id to audit metadata

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Admin-notes privacy
-- Revoke the table-level SELECT grant that was added by Phase 1 bootstrap,
-- then re-grant only the columns safe for all authenticated users to read.
-- Column-level REVOKE alone is insufficient when a table-level grant exists.
-- ═══════════════════════════════════════════════════════════════════════════

revoke select on public.profiles from authenticated;
grant select (
  id, club_id, role, first_name, last_name, status, phone, created_at, updated_at
) on public.profiles to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. member_notes table
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.member_notes (
  id                   uuid        primary key default gen_random_uuid(),
  club_id              uuid        not null references public.clubs(id) on delete cascade,
  member_id            uuid        not null references public.profiles(id),
  author_id            uuid        references public.profiles(id) on delete set null,
  author_name_snapshot text        not null default '',
  content              text        not null check (length(btrim(content)) > 0),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  archived_at          timestamptz
);

create index if not exists member_notes_member_idx  on public.member_notes (member_id);
create index if not exists member_notes_club_idx    on public.member_notes (club_id);
create index if not exists member_notes_created_idx on public.member_notes (created_at desc);

alter table public.member_notes enable row level security;

-- Admins only; SECURITY DEFINER RPCs bypass RLS anyway, but RLS is defence-in-depth.
drop policy if exists member_notes_admin_only on public.member_notes;
create policy member_notes_admin_only on public.member_notes
  for all to authenticated
  using (
    exists (
      select 1 from public.profiles pr
       where pr.id      = auth.uid()
         and pr.club_id = member_notes.club_id
         and pr.role    = 'admin'
    )
  );

drop trigger if exists member_notes_updated_at on public.member_notes;
create trigger member_notes_updated_at
  before update on public.member_notes
  for each row execute function public.trigger_set_updated_at();


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Backfill: copy existing admin_notes values into audit_log
-- Self-attributed (no original actor info available).
-- ═══════════════════════════════════════════════════════════════════════════

insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
select
  p.club_id,
  p.id,
  'admin_notes_backfill',
  'profile',
  p.id,
  jsonb_build_object('notes', p.admin_notes, 'source', 'migration_0075')
from public.profiles p
where p.admin_notes is not null
  and p.club_id    is not null;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. add_member_note
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.add_member_note(
  p_member_id uuid,
  p_content   text
)
returns public.member_notes
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  public.profiles%rowtype;
  v_target public.profiles%rowtype;
  v_result public.member_notes%rowtype;
begin
  select pr.* into v_actor from public.profiles pr where pr.id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_actor.club_id is null then raise exception 'no_club'; end if;
  if v_actor.role <> 'admin' then raise exception 'insufficient_role'; end if;

  if length(btrim(coalesce(p_content, ''))) = 0 then
    raise exception 'content_required';
  end if;
  if length(btrim(p_content)) > 1000 then
    raise exception 'content_too_long';
  end if;

  select pr.* into v_target from public.profiles pr
   where pr.id      = p_member_id
     and pr.club_id = v_actor.club_id;
  if not found then raise exception 'member_not_found'; end if;

  insert into public.member_notes (
    club_id, member_id, author_id, author_name_snapshot, content
  ) values (
    v_actor.club_id,
    p_member_id,
    auth.uid(),
    btrim(coalesce(v_actor.first_name, '') || ' ' || coalesce(v_actor.last_name, '')),
    btrim(p_content)
  ) returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id, auth.uid(), 'add_member_note', 'member_notes', v_result.id,
    jsonb_build_object('member_id', p_member_id)
  );

  return v_result;
end;
$$;

revoke execute on function public.add_member_note(uuid, text) from public, anon;
grant  execute on function public.add_member_note(uuid, text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. update_member_note
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.update_member_note(
  p_note_id uuid,
  p_content text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.profiles%rowtype;
  v_note  public.member_notes%rowtype;
begin
  select pr.* into v_actor from public.profiles pr where pr.id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_actor.role <> 'admin' then raise exception 'insufficient_role'; end if;

  if length(btrim(coalesce(p_content, ''))) = 0 then
    raise exception 'content_required';
  end if;
  if length(btrim(p_content)) > 1000 then
    raise exception 'content_too_long';
  end if;

  select mn.* into v_note from public.member_notes mn
   where mn.id      = p_note_id
     and mn.club_id = v_actor.club_id;
  if not found then raise exception 'note_not_found'; end if;
  if v_note.archived_at is not null then raise exception 'note_archived'; end if;

  update public.member_notes
     set content    = btrim(p_content),
         updated_at = now()
   where id = p_note_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id, auth.uid(), 'update_member_note', 'member_notes', p_note_id, '{}'::jsonb
  );
end;
$$;

revoke execute on function public.update_member_note(uuid, text) from public, anon;
grant  execute on function public.update_member_note(uuid, text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. archive_member_note
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.archive_member_note(
  p_note_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.profiles%rowtype;
  v_note  public.member_notes%rowtype;
begin
  select pr.* into v_actor from public.profiles pr where pr.id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_actor.role <> 'admin' then raise exception 'insufficient_role'; end if;

  select mn.* into v_note from public.member_notes mn
   where mn.id      = p_note_id
     and mn.club_id = v_actor.club_id;
  if not found then raise exception 'note_not_found'; end if;
  if v_note.archived_at is not null then raise exception 'note_already_archived'; end if;

  update public.member_notes
     set archived_at = now(),
         updated_at  = now()
   where id = p_note_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id, auth.uid(), 'archive_member_note', 'member_notes', p_note_id, '{}'::jsonb
  );
end;
$$;

revoke execute on function public.archive_member_note(uuid) from public, anon;
grant  execute on function public.archive_member_note(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. get_member_notes (RETURNS TABLE)
-- Uses explicit alias mn.* to avoid SQLSTATE 42702 column-name ambiguity
-- between RETURNS TABLE output columns (id, member_id, …) and table columns.
-- ═══════════════════════════════════════════════════════════════════════════

drop function if exists public.get_member_notes(uuid);
create or replace function public.get_member_notes(
  p_member_id uuid
)
returns table (
  id                   uuid,
  member_id            uuid,
  author_id            uuid,
  author_name_snapshot text,
  content              text,
  created_at           timestamptz,
  updated_at           timestamptz,
  archived_at          timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.profiles%rowtype;
begin
  select pr.* into v_actor from public.profiles pr where pr.id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_actor.club_id is null then raise exception 'no_club'; end if;
  if v_actor.role <> 'admin' then raise exception 'insufficient_role'; end if;

  if not exists (
    select 1 from public.profiles tgt
     where tgt.id      = p_member_id
       and tgt.club_id = v_actor.club_id
  ) then
    raise exception 'member_not_found';
  end if;

  return query
    select
      mn.id,
      mn.member_id,
      mn.author_id,
      mn.author_name_snapshot,
      mn.content,
      mn.created_at,
      mn.updated_at,
      mn.archived_at
    from public.member_notes mn
   where mn.member_id  = p_member_id
     and mn.club_id    = v_actor.club_id
     and mn.archived_at is null
   order by mn.created_at desc;
end;
$$;

revoke execute on function public.get_member_notes(uuid) from public, anon;
grant  execute on function public.get_member_notes(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 8. set_member_notes: REVOKE (deprecated — replaced by member_notes RPCs)
-- The function still exists for backwards-compat; access is removed.
-- ═══════════════════════════════════════════════════════════════════════════

revoke execute on function public.set_member_notes(uuid, text) from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 9. get_members: remove admin_notes column
-- admin_notes is no longer returned to clients; use get_member_notes instead.
-- DROP required because changing RETURNS TABLE output columns requires it.
-- ═══════════════════════════════════════════════════════════════════════════

drop function if exists public.get_members();
create or replace function public.get_members()
returns table (
  id         uuid,
  first_name text,
  last_name  text,
  phone      text,
  role       text,
  status     text,
  created_at timestamptz,
  email      text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
begin
  select pr.* into v_profile from public.profiles pr where pr.id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  return query
    select
      p.id          as id,
      p.first_name  as first_name,
      p.last_name   as last_name,
      p.phone       as phone,
      p.role        as role,
      p.status      as status,
      p.created_at  as created_at,
      u.email::text as email
    from public.profiles p
    left join auth.users u on u.id = p.id
   where p.club_id = v_profile.club_id
   order by p.last_name asc nulls last, p.first_name asc nulls last;
end;
$$;

revoke execute on function public.get_members() from public, anon;
grant  execute on function public.get_members() to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 10. mark_attendance: harden with public. prefix + set search_path
-- Replaces 0017 and 0061 versions.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.mark_attendance(
  p_event_id          uuid,
  p_profile_id        uuid,
  p_attendance_status text   -- 'attended' | 'no_show' | null (clears)
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile      public.profiles%rowtype;
  v_event        public.events%rowtype;
  v_rows_updated int;
begin
  select pr.* into v_profile from public.profiles pr where pr.id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.role not in ('admin', 'pro') then
    raise exception 'insufficient_role';
  end if;

  if p_attendance_status is not null
     and p_attendance_status not in ('attended', 'no_show') then
    raise exception 'invalid_attendance_status';
  end if;

  select ev.* into v_event
    from public.events ev
   where ev.id      = p_event_id
     and ev.club_id = v_profile.club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  update public.event_participants
     set attendance_status = p_attendance_status,
         updated_at        = now()
   where event_id   = p_event_id
     and profile_id = p_profile_id
     and status     = 'confirmed';

  get diagnostics v_rows_updated = row_count;
  if v_rows_updated = 0 then raise exception 'participant_not_found'; end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'mark_attendance',
    'event_participant',
    p_profile_id,
    jsonb_build_object(
      'event_id',          p_event_id,
      'attendance_status', p_attendance_status
    )
  );
end;
$$;

revoke execute on function public.mark_attendance(uuid, uuid, text) from public, anon;
grant  execute on function public.mark_attendance(uuid, uuid, text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 11. mark_lesson_outcome: add member_id to audit metadata
-- Replaces 0070 version; identical logic, richer audit trail.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.mark_lesson_outcome(
  p_request_id uuid,
  p_outcome    text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_request public.lesson_requests%rowtype;
begin
  select pr.* into v_profile from public.profiles pr where pr.id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  -- 'cancelled' is not a valid input: use cancel_lesson for that.
  if p_outcome not in ('completed', 'member_no_show', 'pro_no_show') then
    raise exception 'invalid_outcome';
  end if;

  select lr.* into v_request
    from public.lesson_requests lr
   where lr.id      = p_request_id
     and lr.club_id = v_profile.club_id;
  if not found then raise exception 'request_not_found'; end if;

  if v_request.status <> 'confirmed' then
    raise exception 'invalid_status_for_outcome';
  end if;

  if v_request.pro_id <> auth.uid() and v_profile.role <> 'admin' then
    raise exception 'insufficient_role';
  end if;

  if v_request.proposed_starts_at > now() + interval '15 minutes' then
    raise exception 'lesson_not_yet_started';
  end if;

  update public.lesson_requests
     set lesson_outcome = p_outcome,
         updated_at     = now()
   where id = p_request_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'mark_lesson_outcome', 'lesson_request', p_request_id,
    jsonb_build_object('outcome', p_outcome, 'member_id', v_request.member_id)
  );
end;
$$;

revoke execute on function public.mark_lesson_outcome(uuid, text) from public, anon;
grant  execute on function public.mark_lesson_outcome(uuid, text) to authenticated;
