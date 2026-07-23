-- 0077_fix_phase24_rpc_ambiguities.sql
-- Phase 24A: Fix SQLSTATE 42702 column-reference ambiguity in Phase 24 RPCs.
--
-- In PL/pgSQL, every RETURNS TABLE output column name becomes an implicit
-- variable in the function body. Unqualified references like
--   WHERE id = auth.uid()
-- are ambiguous when the function also returns a column named "id" — PostgreSQL
-- raises 42702 (ambiguous column reference).
--
-- Fix: add explicit table aliases to every SELECT that touches a column whose
-- name matches an output column (id, member_id, author_id, …).
--
-- Affected functions (9 total):
--   get_admin_member_detail, get_member_notes, add_member_note,
--   update_member_note, archive_member_note,
--   get_member_upcoming_activity, get_member_activity_history,
--   mark_attendance (output id via trigger), mark_lesson_outcome
--
-- All functions below are CREATE OR REPLACE — idempotent and safe to re-apply.

-- ─── get_admin_member_detail ────────────────────────────────────────────────

drop function if exists public.get_admin_member_detail(uuid);
create or replace function public.get_admin_member_detail(
  p_member_id uuid
)
returns table (
  id                          uuid,
  first_name                  text,
  last_name                   text,
  phone                       text,
  role                        text,
  status                      text,
  created_at                  timestamptz,
  email                       text,
  attended_event_count        bigint,
  event_no_show_count         bigint,
  completed_lesson_count      bigint,
  member_lesson_no_show_count bigint
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
      p.id                                                  as id,
      p.first_name                                          as first_name,
      p.last_name                                           as last_name,
      p.phone                                               as phone,
      p.role                                                as role,
      p.status                                              as status,
      p.created_at                                          as created_at,
      u.email::text                                         as email,
      (
        select count(*) from public.event_participants ep
          join public.events ev on ev.id = ep.event_id
         where ep.profile_id        = p_member_id
           and ep.attendance_status = 'attended'
           and ev.club_id           = v_actor.club_id
      )                                                     as attended_event_count,
      (
        select count(*) from public.event_participants ep
          join public.events ev on ev.id = ep.event_id
         where ep.profile_id        = p_member_id
           and ep.attendance_status = 'no_show'
           and ev.club_id           = v_actor.club_id
      )                                                     as event_no_show_count,
      (
        select count(*) from public.lesson_requests lr
         where lr.member_id      = p_member_id
           and lr.club_id        = v_actor.club_id
           and lr.lesson_outcome = 'completed'
      )                                                     as completed_lesson_count,
      (
        select count(*) from public.lesson_requests lr
         where lr.member_id      = p_member_id
           and lr.club_id        = v_actor.club_id
           and lr.lesson_outcome = 'member_no_show'
      )                                                     as member_lesson_no_show_count
    from public.profiles p
    left join auth.users u on u.id = p.id
   where p.id = p_member_id;
end;
$$;

revoke execute on function public.get_admin_member_detail(uuid) from public, anon;
grant  execute on function public.get_admin_member_detail(uuid) to authenticated;


-- ─── get_member_notes ───────────────────────────────────────────────────────

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
   where mn.member_id   = p_member_id
     and mn.club_id     = v_actor.club_id
     and mn.archived_at is null
   order by mn.created_at desc;
end;
$$;

revoke execute on function public.get_member_notes(uuid) from public, anon;
grant  execute on function public.get_member_notes(uuid) to authenticated;


-- ─── add_member_note ────────────────────────────────────────────────────────

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


-- ─── update_member_note ─────────────────────────────────────────────────────

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


-- ─── archive_member_note ────────────────────────────────────────────────────

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


-- ─── get_member_upcoming_activity ───────────────────────────────────────────

drop function if exists public.get_member_upcoming_activity(uuid);
create or replace function public.get_member_upcoming_activity(
  p_member_id uuid
)
returns table (
  activity_id          uuid,
  activity_type        text,
  sort_ts              timestamptz,
  status               text,
  title                text,
  starts_at            timestamptz,
  ends_at              timestamptz,
  court_name           text,
  pro_first_name       text,
  pro_last_name        text,
  duration_minutes     int,
  proposed_starts_at   timestamptz,
  proposed_ends_at     timestamptz,
  proposed_court_name  text
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
      ep.id, 'event'::text, ev.starts_at, ep.status,
      ev.title, ev.starts_at, ev.ends_at, null::text,
      null::text, null::text, null::int,
      null::timestamptz, null::timestamptz, null::text
    from public.event_participants ep
    join public.events ev on ev.id = ep.event_id
   where ep.profile_id  = p_member_id
     and ev.club_id     = v_actor.club_id
     and ev.starts_at   > now()
     and ev.archived_at is null
     and ep.status      = 'confirmed'

  union all
    select
      lr.id, 'lesson'::text,
      coalesce(lr.proposed_starts_at, lr.created_at),
      lr.status, null::text, null::timestamptz, null::timestamptz,
      null::text, pro.first_name, pro.last_name, lr.duration_minutes,
      lr.proposed_starts_at, lr.proposed_ends_at, pc.name
    from public.lesson_requests lr
    join public.profiles pro on pro.id = lr.pro_id
    left join public.courts pc on pc.id = lr.proposed_court_id
   where lr.member_id = p_member_id
     and lr.club_id   = v_actor.club_id
     and lr.status    in ('pending', 'proposed')

  union all
    select
      lr.id, 'lesson'::text, lr.proposed_starts_at,
      lr.status, null::text, lr.proposed_starts_at, lr.proposed_ends_at,
      null::text, pro.first_name, pro.last_name, lr.duration_minutes,
      lr.proposed_starts_at, lr.proposed_ends_at, pc.name
    from public.lesson_requests lr
    join public.profiles pro on pro.id = lr.pro_id
    left join public.courts pc on pc.id = lr.proposed_court_id
   where lr.member_id          = p_member_id
     and lr.club_id            = v_actor.club_id
     and lr.status             = 'confirmed'
     and lr.proposed_starts_at > now()

  union all
    select
      r.id, 'reservation'::text, r.starts_at,
      r.status, null::text, r.starts_at, r.ends_at, c.name,
      null::text, null::text, null::int,
      null::timestamptz, null::timestamptz, null::text
    from public.reservations r
    join public.courts c on c.id = r.court_id
   where r.owner_user_id = p_member_id
     and r.club_id       = v_actor.club_id
     and r.reason        = 'member_booking'
     and r.status        = 'confirmed'
     and r.ends_at       > now()
     and r.event_id      is null

  order by sort_ts asc;
end;
$$;

revoke execute on function public.get_member_upcoming_activity(uuid) from public, anon;
grant  execute on function public.get_member_upcoming_activity(uuid) to authenticated;


-- ─── get_member_activity_history ────────────────────────────────────────────

drop function if exists public.get_member_activity_history(uuid, timestamptz, text, uuid, int);
create or replace function public.get_member_activity_history(
  p_member_id   uuid,
  p_cursor_ts   timestamptz default null,
  p_cursor_type text        default null,
  p_cursor_id   uuid        default null,
  p_limit       int         default 20
)
returns table (
  activity_id       uuid,
  activity_type     text,
  sort_ts           timestamptz,
  status            text,
  starts_at         timestamptz,
  ends_at           timestamptz,
  title             text,
  attendance_status text,
  pro_first_name    text,
  pro_last_name     text,
  duration_minutes  int,
  lesson_outcome    text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  public.profiles%rowtype;
  v_limit  int := least(greatest(coalesce(p_limit, 20), 1), 50);
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

  if (p_cursor_ts is null) <> (p_cursor_type is null)
  or (p_cursor_ts is null) <> (p_cursor_id   is null) then
    raise exception 'invalid_cursor';
  end if;

  return query
    select *
    from (
      select
        ep.id, 'event'::text, ev.starts_at,
        ep.status, ev.starts_at, ev.ends_at, ev.title,
        ep.attendance_status,
        null::text, null::text, null::int, null::text
      from public.event_participants ep
      join public.events ev on ev.id = ep.event_id
     where ep.profile_id  = p_member_id
       and ev.club_id     = v_actor.club_id
       and ev.starts_at   < now()
       and ep.status      = 'confirmed'

      union all

      select
        lr.id, 'lesson'::text,
        coalesce(lr.proposed_starts_at, lr.created_at),
        lr.status,
        lr.proposed_starts_at, lr.proposed_ends_at,
        null::text, null::text,
        pro.first_name, pro.last_name, lr.duration_minutes, lr.lesson_outcome
      from public.lesson_requests lr
      join public.profiles pro on pro.id = lr.pro_id
     where lr.member_id = p_member_id
       and lr.club_id   = v_actor.club_id
       and lr.status    in ('confirmed', 'declined', 'withdrawn', 'cancelled')
       and (
         lr.status <> 'confirmed'
         or lr.proposed_starts_at < now()
       )
    ) combined
   where (
     p_cursor_ts is null
     or (combined.sort_ts, combined.activity_type, combined.activity_id)
        < (p_cursor_ts, p_cursor_type, p_cursor_id)
   )
   order by combined.sort_ts desc, combined.activity_type desc, combined.activity_id desc
   limit v_limit;
end;
$$;

revoke execute on function public.get_member_activity_history(uuid, timestamptz, text, uuid, int) from public, anon;
grant  execute on function public.get_member_activity_history(uuid, timestamptz, text, uuid, int) to authenticated;


-- ─── mark_attendance ────────────────────────────────────────────────────────
-- Re-create with explicit aliases to prevent any 42702 risk from future schema
-- changes, and to ensure search_path is set consistently with Phase 24 style.

create or replace function public.mark_attendance(
  p_event_id          uuid,
  p_profile_id        uuid,
  p_attendance_status text
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
    v_profile.club_id, auth.uid(), 'mark_attendance', 'event_participant', p_profile_id,
    jsonb_build_object('event_id', p_event_id, 'attendance_status', p_attendance_status)
  );
end;
$$;

revoke execute on function public.mark_attendance(uuid, uuid, text) from public, anon;
grant  execute on function public.mark_attendance(uuid, uuid, text) to authenticated;


-- ─── mark_lesson_outcome ────────────────────────────────────────────────────

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
