-- 0029_club_theme.sql
-- Phase 11D: preset color theme selection.
-- Apply in Supabase SQL Editor (cloud only).

-- ---------------------------------------------------------------------------
-- clubs.theme_key
-- ---------------------------------------------------------------------------
alter table clubs
  add column if not exists theme_key text not null default 'classic-gray';

alter table clubs
  add constraint clubs_theme_key_check
  check (theme_key in (
    'classic-gray',
    'forest-green',
    'clay-court',
    'ocean-blue',
    'royal-purple'
  ));

-- ---------------------------------------------------------------------------
-- update_club_theme
-- ---------------------------------------------------------------------------
create or replace function update_club_theme(p_theme_key text)
returns void
language plpgsql security definer as $$
declare
  v_profile profiles%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  if p_theme_key not in (
    'classic-gray', 'forest-green', 'clay-court', 'ocean-blue', 'royal-purple'
  ) then
    raise exception 'invalid_theme';
  end if;

  update clubs set theme_key = p_theme_key where id = v_profile.club_id;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'update_club_theme', 'club', v_profile.club_id,
    jsonb_build_object('theme_key', p_theme_key)
  );
end;
$$;
