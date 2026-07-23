-- 0076_member_activity_queries.sql
-- Phase 24A: Admin member-detail CRM queries.
-- • get_admin_member_detail — full profile + 4 lifetime stats
-- • get_member_upcoming_activity — future events, active lessons, court bookings
-- • get_member_activity_history — composite-cursor paginated history

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. get_admin_member_detail
-- All RETURNS TABLE output columns use explicit aliases in the body to prevent
-- SQLSTATE 42702 column-name ambiguity (output column "id" vs profiles.id, etc.).
-- ═══════════════════════════════════════════════════════════════════════════

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


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. get_member_upcoming_activity
-- Returns future events, active lesson requests, and member court bookings.
-- reason='member_booking' filter excludes maintenance/admin_block reservations.
-- ═══════════════════════════════════════════════════════════════════════════

drop function if exists public.get_member_upcoming_activity(uuid);
create or replace function public.get_member_upcoming_activity(
  p_member_id uuid
)
returns table (
  activity_id          uuid,
  activity_type        text,         -- 'event' | 'lesson' | 'reservation'
  sort_ts              timestamptz,
  status               text,         -- participant status / lesson status / 'confirmed'
  title                text,         -- event title (null for lesson/reservation)
  starts_at            timestamptz,
  ends_at              timestamptz,
  court_name           text,         -- reservation court name (null for events/lessons)
  pro_first_name       text,         -- lesson pro (null for event/reservation)
  pro_last_name        text,
  duration_minutes     int,          -- lesson duration (null for event/reservation)
  proposed_starts_at   timestamptz,  -- for proposed/confirmed lessons
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

    -- Events: confirmed participant in a future event
    select
      ep.id                           as activity_id,
      'event'::text                   as activity_type,
      ev.starts_at                    as sort_ts,
      ep.status                       as status,
      ev.title                        as title,
      ev.starts_at                    as starts_at,
      ev.ends_at                      as ends_at,
      null::text                      as court_name,
      null::text                      as pro_first_name,
      null::text                      as pro_last_name,
      null::int                       as duration_minutes,
      null::timestamptz               as proposed_starts_at,
      null::timestamptz               as proposed_ends_at,
      null::text                      as proposed_court_name
    from public.event_participants ep
    join public.events ev on ev.id = ep.event_id
   where ep.profile_id  = p_member_id
     and ev.club_id     = v_actor.club_id
     and ev.starts_at   > now()
     and ev.archived_at is null
     and ep.status      = 'confirmed'

  union all

    -- Active lesson requests (pending / proposed / confirmed upcoming)
    select
      lr.id                           as activity_id,
      'lesson'::text                  as activity_type,
      coalesce(lr.proposed_starts_at, lr.created_at) as sort_ts,
      lr.status                       as status,
      null::text                      as title,
      null::timestamptz               as starts_at,
      null::timestamptz               as ends_at,
      null::text                      as court_name,
      pro.first_name                  as pro_first_name,
      pro.last_name                   as pro_last_name,
      lr.duration_minutes             as duration_minutes,
      lr.proposed_starts_at           as proposed_starts_at,
      lr.proposed_ends_at             as proposed_ends_at,
      pc.name                         as proposed_court_name
    from public.lesson_requests lr
    join public.profiles pro on pro.id = lr.pro_id
    left join public.courts pc on pc.id = lr.proposed_court_id
   where lr.member_id   = p_member_id
     and lr.club_id     = v_actor.club_id
     and lr.status      in ('pending', 'proposed')

  union all

    -- Confirmed future lesson requests
    select
      lr.id                           as activity_id,
      'lesson'::text                  as activity_type,
      lr.proposed_starts_at           as sort_ts,
      lr.status                       as status,
      null::text                      as title,
      lr.proposed_starts_at           as starts_at,
      lr.proposed_ends_at             as ends_at,
      null::text                      as court_name,
      pro.first_name                  as pro_first_name,
      pro.last_name                   as pro_last_name,
      lr.duration_minutes             as duration_minutes,
      lr.proposed_starts_at           as proposed_starts_at,
      lr.proposed_ends_at             as proposed_ends_at,
      pc.name                         as proposed_court_name
    from public.lesson_requests lr
    join public.profiles pro on pro.id = lr.pro_id
    left join public.courts pc on pc.id = lr.proposed_court_id
   where lr.member_id           = p_member_id
     and lr.club_id             = v_actor.club_id
     and lr.status              = 'confirmed'
     and lr.proposed_starts_at  > now()

  union all

    -- Member court reservations (reason='member_booking' filter)
    select
      r.id                            as activity_id,
      'reservation'::text             as activity_type,
      r.starts_at                     as sort_ts,
      r.status                        as status,
      null::text                      as title,
      r.starts_at                     as starts_at,
      r.ends_at                       as ends_at,
      c.name                          as court_name,
      null::text                      as pro_first_name,
      null::text                      as pro_last_name,
      null::int                       as duration_minutes,
      null::timestamptz               as proposed_starts_at,
      null::timestamptz               as proposed_ends_at,
      null::text                      as proposed_court_name
    from public.reservations r
    join public.courts c on c.id = r.court_id
   where r.owner_user_id = p_member_id
     and r.club_id       = v_actor.club_id
     and r.reason        = 'member_booking'
     and r.status        = 'confirmed'
     and r.ends_at       > now()
     and r.event_id      is null    -- exclude event-linked reservations

  order by sort_ts asc;
end;
$$;

revoke execute on function public.get_member_upcoming_activity(uuid) from public, anon;
grant  execute on function public.get_member_upcoming_activity(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. get_member_activity_history
-- Composite cursor pagination: (sort_ts DESC, activity_type DESC, activity_id DESC)
-- Excludes waitlisted/offered event participants (they never confirmed).
-- Includes only terminal lesson statuses: confirmed (past), declined, withdrawn, cancelled.
-- ═══════════════════════════════════════════════════════════════════════════

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
  activity_type     text,         -- 'event' | 'lesson'
  sort_ts           timestamptz,
  status            text,
  starts_at         timestamptz,
  ends_at           timestamptz,
  title             text,         -- event title (null for lesson)
  attendance_status text,         -- event attendance (null for lesson)
  pro_first_name    text,         -- lesson pro (null for event)
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

  -- Cursor must be all-null or all-non-null
  if (p_cursor_ts is null) <> (p_cursor_type is null)
  or (p_cursor_ts is null) <> (p_cursor_id is null) then
    raise exception 'invalid_cursor';
  end if;

  return query
    select *
    from (
      -- Past events (confirmed participant, event has ended)
      select
        ep.id                 as activity_id,
        'event'::text         as activity_type,
        ev.starts_at          as sort_ts,
        ep.status             as status,
        ev.starts_at          as starts_at,
        ev.ends_at            as ends_at,
        ev.title              as title,
        ep.attendance_status  as attendance_status,
        null::text            as pro_first_name,
        null::text            as pro_last_name,
        null::int             as duration_minutes,
        null::text            as lesson_outcome
      from public.event_participants ep
      join public.events ev on ev.id = ep.event_id
     where ep.profile_id   = p_member_id
       and ev.club_id      = v_actor.club_id
       and ev.starts_at    < now()
       and ep.status       = 'confirmed'   -- exclude waitlisted/offered

      union all

      -- Terminal lesson requests (all terminal statuses)
      select
        lr.id                                           as activity_id,
        'lesson'::text                                  as activity_type,
        coalesce(lr.proposed_starts_at, lr.created_at) as sort_ts,
        lr.status                                       as status,
        lr.proposed_starts_at                           as starts_at,
        lr.proposed_ends_at                             as ends_at,
        null::text                                      as title,
        null::text                                      as attendance_status,
        pro.first_name                                  as pro_first_name,
        pro.last_name                                   as pro_last_name,
        lr.duration_minutes                             as duration_minutes,
        lr.lesson_outcome                               as lesson_outcome
      from public.lesson_requests lr
      join public.profiles pro on pro.id = lr.pro_id
     where lr.member_id = p_member_id
       and lr.club_id   = v_actor.club_id
       and lr.status    in ('confirmed', 'declined', 'withdrawn', 'cancelled')
       -- For 'confirmed' lessons, only include if the lesson time has passed
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
