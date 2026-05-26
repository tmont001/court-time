-- 0045_upsert_operating_hours_override_rpc.sql
-- Phase 17A: security-definer RPC to add or update a date-specific
-- operating-hours override with a dry-run conflict check.
-- Never cancels or modifies existing reservations; affected_count is
-- informational only — the caller (admin UI) decides whether to warn or abort.
-- Requires 0044_operating_hours_override_rls.sql to be applied first.
-- Apply in Supabase SQL Editor (cloud only).

create or replace function upsert_operating_hours_override(
  p_override_date date,
  p_is_closed     boolean,
  p_opens_at      time    default null,
  p_closes_at     time    default null,
  p_note          text    default null,
  p_dry_run       boolean default true
)
returns jsonb
language plpgsql security definer as $$
declare
  v_actor          profiles%rowtype;
  v_tz             text;
  v_affected_count int := 0;
begin
  -- 1. Load actor profile.
  select * into v_actor from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  -- 2. Actor must be admin.
  if v_actor.role <> 'admin' then raise exception 'insufficient_role'; end if;

  -- 3. Load club timezone.
  select timezone into v_tz from clubs where id = v_actor.club_id;

  -- 4. Validate payload.
  --    Closed overrides: opens_at / closes_at may be null (they are ignored).
  --    Special-hours overrides: both are required and opens_at must be before closes_at.
  if not p_is_closed then
    if p_opens_at is null or p_closes_at is null then
      raise exception 'invalid_override_payload';
    end if;
    if p_opens_at >= p_closes_at then
      raise exception 'invalid_override_payload';
    end if;
  end if;

  -- 5. Count future confirmed/pending reservations on p_override_date that
  --    conflict with the proposed override.
  --    Closed override → all reservations on that date are affected.
  --    Special-hours override → reservations starting before opens_at or ending
  --    after closes_at are affected.
  --    Converts starts_at/ends_at to club local time before comparison, matching
  --    the same pattern used in create_reservation and update_operating_hours.
  select count(*) into v_affected_count
  from   reservations r
  where  r.club_id   = v_actor.club_id
    and  r.status    in ('pending', 'confirmed')
    and  r.starts_at > now()
    and  (r.starts_at at time zone v_tz)::date = p_override_date
    and  (
      p_is_closed
      or (p_opens_at  is not null and (r.starts_at at time zone v_tz)::time < p_opens_at)
      or (p_closes_at is not null and (r.ends_at   at time zone v_tz)::time > p_closes_at)
    );

  -- 6. Dry run: return conflict data without writing anything.
  if p_dry_run then
    return jsonb_build_object('dry_run', true, 'affected_count', v_affected_count);
  end if;

  -- 7a. Upsert the override row.
  --     On conflict (club_id, override_date): update every mutable column.
  insert into operating_hours_override (
    club_id, override_date, is_closed, opens_at, closes_at, note, updated_at
  )
  values (
    v_actor.club_id, p_override_date, p_is_closed,
    p_opens_at, p_closes_at, p_note, now()
  )
  on conflict (club_id, override_date) do update set
    is_closed  = excluded.is_closed,
    opens_at   = excluded.opens_at,
    closes_at  = excluded.closes_at,
    note       = excluded.note,
    updated_at = excluded.updated_at;

  -- 7b. Write audit log.
  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'upsert_operating_hours_override',
    'operating_hours_override',
    v_actor.club_id,
    jsonb_build_object(
      'override_date',  p_override_date,
      'is_closed',      p_is_closed,
      'opens_at',       p_opens_at,
      'closes_at',      p_closes_at,
      'note',           p_note,
      'affected_count', v_affected_count
    )
  );

  return jsonb_build_object('dry_run', false, 'affected_count', v_affected_count);
end;
$$;
