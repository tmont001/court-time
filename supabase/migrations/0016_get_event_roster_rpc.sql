-- 0016_get_event_roster_rpc.sql
-- Phase 7E: attendance_status column + get_event_roster RPC.
-- Requires 0015_waitlist_rpcs.sql first.
-- Apply in Supabase SQL Editor (cloud only).

-- ---------------------------------------------------------------------------
-- 1. attendance_status column on event_participants
-- Nullable. No default. Writable only via mark_attendance RPC (Phase 7G).
-- No direct-write RLS policy is added here.
-- ---------------------------------------------------------------------------
alter table event_participants
  add column if not exists attendance_status text
    check (attendance_status in ('attended', 'no_show'));

-- ---------------------------------------------------------------------------
-- 2. get_event_roster
-- Admin or pro only. Returns confirmed and waitlisted participants with
-- their display name and attendance state. Cancelled rows are excluded —
-- they are not active roster members and need no attendance tracking.
-- waitlist_position is 1-based for waitlisted rows; null for confirmed rows.
-- ---------------------------------------------------------------------------
create or replace function get_event_roster(p_event_id uuid)
returns table (
  profile_id        uuid,
  display_name      text,
  role              text,
  status            text,
  attendance_status text,
  waitlist_position int
)
language plpgsql security definer as $$
declare
  v_profile profiles%rowtype;
  v_event   events%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.role not in ('admin', 'pro') then
    raise exception 'insufficient_role';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_profile.club_id;
  if not found then raise exception 'event_not_found'; end if;

  return query
    with ranked as (
      select
        ep.profile_id,
        ep.role,
        ep.status,
        ep.attendance_status,
        ep.created_at,
        row_number() over (
          partition by ep.status
          order by ep.created_at asc
        ) as pos
      from event_participants ep
      where ep.event_id = p_event_id
        and ep.status   in ('confirmed', 'waitlisted')
    )
    select
      r.profile_id,
      coalesce(
        nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''),
        'Unknown'
      )::text                                                   as display_name,
      r.role::text,
      r.status::text,
      r.attendance_status::text,
      case when r.status = 'waitlisted' then r.pos::int else null end
                                                                as waitlist_position
    from   ranked r
    left join profiles p on p.id = r.profile_id
    order by
      case r.status
        when 'confirmed'  then 1
        when 'waitlisted' then 2
        else 3
      end,
      r.created_at asc;
end;
$$;
