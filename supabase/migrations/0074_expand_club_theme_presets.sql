-- 0074_expand_club_theme_presets.sql
-- Replaces the five original theme presets with eight curated presets:
--   graphite, cobalt, teal, sage, plum, rose, terracotta, gold
--
-- Safe migration order:
--   1. Drop old CHECK constraint (removes the allowlist enforcement temporarily)
--   2. Migrate existing rows to the new keys
--   3. Update column default
--   4. Add new CHECK constraint
--   5. Replace update_club_theme RPC with updated allowlist + security hardening
--   6. Patch bootstrap_new_club (0035) to use 'graphite' instead of 'classic-gray'

-- ── 1. Drop existing CHECK constraint ────────────────────────────────────────

alter table public.clubs
  drop constraint if exists clubs_theme_key_check;

-- ── 2. Migrate existing theme_key values ─────────────────────────────────────
-- Covers original five values plus any values from the uncommitted 0074 draft
-- that may have been applied manually in a staging environment.

update public.clubs set theme_key = 'graphite'   where theme_key = 'classic-gray';
update public.clubs set theme_key = 'cobalt'     where theme_key in ('ocean-blue', 'sky');
update public.clubs set theme_key = 'sage'       where theme_key in ('forest-green', 'emerald');
update public.clubs set theme_key = 'plum'       where theme_key in ('royal-purple', 'violet');
update public.clubs set theme_key = 'terracotta' where theme_key = 'clay-court';
update public.clubs set theme_key = 'gold'       where theme_key = 'amber';
-- 'teal' and 'rose' keys are unchanged; no migration needed.

-- ── 3. Update column default ─────────────────────────────────────────────────

alter table public.clubs
  alter column theme_key set default 'graphite';

-- ── 4. Add new CHECK constraint ───────────────────────────────────────────────

alter table public.clubs
  add constraint clubs_theme_key_check
  check (theme_key in (
    'graphite',
    'cobalt',
    'teal',
    'sage',
    'plum',
    'rose',
    'terracotta',
    'gold'
  ));

-- ── 5. Replace update_club_theme ─────────────────────────────────────────────
-- Adds set search_path and REVOKE/GRANT missing from 0029.

create or replace function public.update_club_theme(p_theme_key text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  if p_theme_key not in (
    'graphite', 'cobalt', 'teal', 'sage', 'plum', 'rose', 'terracotta', 'gold'
  ) then
    raise exception 'invalid_theme';
  end if;

  update public.clubs
     set theme_key = p_theme_key
   where id = v_profile.club_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'update_club_theme',
    'club',
    v_profile.club_id,
    jsonb_build_object('theme_key', p_theme_key)
  );
end;
$$;

revoke execute on function public.update_club_theme(text) from public, anon;
grant  execute on function public.update_club_theme(text) to authenticated;

-- ── 6. Patch bootstrap_new_club ──────────────────────────────────────────────
-- The clubs insert in 0035 hardcodes 'classic-gray', which is no longer a
-- valid theme_key value.  This replace updates it to 'graphite'.
-- All validation logic and REVOKE/GRANT are unchanged from 0035.

create or replace function public.bootstrap_new_club(
  p_name                       text,
  p_slug                       text,
  p_timezone                   text,
  p_court_count                int,
  p_operator_user_id           uuid,
  p_court_names                text[]  default null,
  p_opens_at                   time    default '08:00',
  p_closes_at                  time    default '20:00',
  p_booking_window_days        int     default 14,
  p_cancellation_window_hours  int     default 24,
  p_cancellation_grace_minutes int     default 5
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reserved    text[] := array[
    'admin', 'api', 'auth', 'join', 'sign-in', 'setup', 'operator',
    'app', 'www', 'mail', 'help', 'support', 'booking', 'dashboard'
  ];
  v_club        clubs%rowtype;
  v_code        text;
  v_dow         int;
  v_i           int;
  v_court_name  text;
begin
  if trim(p_name) is null or char_length(trim(p_name)) < 2 then
    raise exception 'invalid_name: club name must be at least 2 characters';
  end if;

  if char_length(trim(p_name)) > 80 then
    raise exception 'invalid_name: club name must be 80 characters or fewer';
  end if;

  if p_slug is null or p_slug = '' then
    raise exception 'invalid_slug: slug is required';
  end if;

  if p_slug !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' then
    raise exception
      'invalid_slug: slug must contain only lowercase letters, digits, and '
      'hyphens, and must start and end with a letter or digit';
  end if;

  if p_slug = any(v_reserved) then
    raise exception 'invalid_slug: "%" is a reserved slug', p_slug;
  end if;

  if exists (select 1 from clubs where slug = p_slug) then
    raise exception
      'slug_already_exists: a club with slug "%" already exists', p_slug;
  end if;

  if p_court_count is null or p_court_count < 1 or p_court_count > 20 then
    raise exception 'invalid_court_count: court count must be between 1 and 20';
  end if;

  if p_court_names is not null then
    if array_length(p_court_names, 1) is null or
       array_length(p_court_names, 1) <> p_court_count then
      raise exception
        'invalid_court_names: p_court_names must contain exactly % '
        'elements to match p_court_count', p_court_count;
    end if;
  end if;

  if p_closes_at <= p_opens_at then
    raise exception 'invalid_hours: closes_at must be after opens_at';
  end if;

  if p_booking_window_days < 1 or p_booking_window_days > 365 then
    raise exception
      'invalid_booking_window: booking_window_days must be between 1 and 365';
  end if;

  if p_cancellation_window_hours < 0 or p_cancellation_window_hours > 168 then
    raise exception
      'invalid_cancellation_window: cancellation_window_hours must be between 0 and 168';
  end if;

  if p_cancellation_grace_minutes < 0 or p_cancellation_grace_minutes > 60 then
    raise exception
      'invalid_grace_period: cancellation_grace_minutes must be between 0 and 60';
  end if;

  if p_operator_user_id is null then
    raise exception 'invalid_operator_user: p_operator_user_id is required';
  end if;

  if not exists (select 1 from auth.users where id = p_operator_user_id) then
    raise exception
      'invalid_operator_user: user % does not exist in auth.users',
      p_operator_user_id;
  end if;

  insert into clubs (name, slug, timezone, theme_key)
  values (trim(p_name), p_slug, p_timezone, 'graphite')
  returning * into v_club;

  insert into club_settings (
    club_id,
    booking_window_days,
    cancellation_window_hours,
    cancellation_grace_minutes
  ) values (
    v_club.id,
    p_booking_window_days,
    p_cancellation_window_hours,
    p_cancellation_grace_minutes
  );

  for v_i in 1..p_court_count loop
    if p_court_names is not null then
      v_court_name := p_court_names[v_i];
    else
      v_court_name := 'Court ' || v_i::text;
    end if;

    insert into courts (club_id, name, display_order, is_active)
    values (v_club.id, v_court_name, v_i - 1, true);
  end loop;

  for v_dow in 0..6 loop
    insert into operating_hours (club_id, day_of_week, opens_at, closes_at, is_closed)
    values (v_club.id, v_dow, p_opens_at, p_closes_at, false);
  end loop;

  insert into event_types (
    club_id, key, label, color,
    default_capacity, default_duration_minutes, default_court_count,
    shows_participant_names
  ) values
    (v_club.id, 'lesson',     'Private Lesson', '#3B7DD8',  1,  60, 1, false),
    (v_club.id, 'clinic',     'Group Clinic',   '#2E9B5E',  8,  90, 1, false),
    (v_club.id, 'social',     'Open Social',    '#E68433', 12, 120, 2, true),
    (v_club.id, 'league',     'League Match',   '#7B4FB5',  4,  90, 1, true),
    (v_club.id, 'tournament', 'Tournament',     '#C44545', 32, 240, 4, true);

  insert into club_invites (club_id, role, email, created_by, expires_at)
  values (v_club.id, 'admin', null, p_operator_user_id, now() + interval '14 days')
  returning code into v_code;

  return jsonb_build_object(
    'club_id',     v_club.id,
    'slug',        v_club.slug,
    'invite_code', v_code
  );
end;
$$;

revoke execute
  on function public.bootstrap_new_club(text, text, text, int, uuid, text[], time, time, int, int, int)
  from public;

grant execute
  on function public.bootstrap_new_club(text, text, text, int, uuid, text[], time, time, int, int, int)
  to service_role;
