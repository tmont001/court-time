-- 0106_fix_pilot_inquiry_ambiguous_id.sql
-- Phase 32C runtime-defect correction. 0105 is applied and immutable — this
-- migration only replaces the function body, via CREATE OR REPLACE.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- The first real /contact submission against the applied 0105 failed with:
--
--   submit_pilot_inquiry failed { code: '42702', message: 'column
--   reference "id" is ambiguous' }
--
-- (The Server Action correctly converted this to the existing generic
-- visitor-facing form error, so POST /contact still returned 200 — no
-- inquiry was lost, none was silently miscreated; it simply never reached
-- the insert.)
--
-- Root cause: public.submit_pilot_inquiry is declared
-- `returns table (id uuid, deduped boolean)`, which creates an implicit
-- OUT parameter named `id` in the function's PL/pgSQL namespace. The
-- duplicate-safety lookup then ran:
--
--   select id into v_existing_id from public.pilot_inquiries ...
--
-- `id` here is ambiguous between that OUT parameter and
-- pilot_inquiries.id — Postgres cannot infer which one is meant, hence
-- 42702. (The function's other `id` reference, in
-- `returning pilot_inquiries.id into v_new_id`, was already correctly
-- table-qualified and never hit this bug. No other column reference in the
-- function collides with either OUT parameter name, `id` or `deduped`.)
--
-- Fix: qualify the duplicate-safety lookup with an explicit table alias.
-- Nothing else changes — same signature, same RETURNS TABLE shape, same
-- SECURITY DEFINER / search_path, same validation, same duplicate-window
-- and matching semantics, same fingerprint throttle, same insert, same
-- privileges. Diff the function body against 0105 to confirm: the only
-- change is the FROM/WHERE/ORDER BY of the duplicate-safety SELECT gaining
-- a `pi` alias and qualifying its columns with it.
--
-- Safe to re-apply: CREATE OR REPLACE FUNCTION. Apply in Supabase SQL
-- Editor (cloud only).


create or replace function public.submit_pilot_inquiry(
  p_contact_name              text,
  p_email                     text,
  p_club_name                 text,
  p_facility_type              text,
  p_court_count                int,
  p_approximate_member_count   int,
  p_current_process            text,
  p_operational_challenge      text,
  p_preferred_operating_model  text,
  p_facility_type_other        text    default null,
  p_phone                      text    default null,
  p_preferred_contact_method   text    default null,
  p_website                    text    default null,
  p_additional_details         text    default null,
  p_source                     text    default 'contact_page',
  p_fingerprint                text    default null
)
returns table (id uuid, deduped boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email          text := lower(trim(coalesce(p_email, '')));
  v_name           text := trim(coalesce(p_contact_name, ''));
  v_club           text := trim(coalesce(p_club_name, ''));
  v_current        text := trim(coalesce(p_current_process, ''));
  v_challenge      text := trim(coalesce(p_operational_challenge, ''));
  v_facility_other text := nullif(trim(coalesce(p_facility_type_other, '')), '');
  v_existing_id    uuid;
  v_new_id         uuid;
  v_recent_count   int;
begin
  if v_name = '' or length(v_name) > 200 then
    raise exception 'invalid_contact_name';
  end if;

  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or length(v_email) > 320 then
    raise exception 'invalid_email';
  end if;

  if v_club = '' or length(v_club) > 200 then
    raise exception 'invalid_club_name';
  end if;

  if p_facility_type not in (
    'private_club', 'country_club', 'hoa_residential',
    'public_municipal', 'tennis_academy', 'school_university', 'other'
  ) then
    raise exception 'invalid_facility_type';
  end if;

  if p_facility_type = 'other' and (v_facility_other is null or length(v_facility_other) > 200) then
    raise exception 'invalid_facility_type_other';
  end if;

  if p_preferred_operating_model not in ('staff_managed', 'member_self_service', 'not_sure') then
    raise exception 'invalid_operating_model';
  end if;

  if p_preferred_contact_method is not null
     and p_preferred_contact_method not in ('email', 'phone', 'either') then
    raise exception 'invalid_contact_method';
  end if;

  if p_court_count is null or p_court_count < 1 or p_court_count > 500 then
    raise exception 'invalid_court_count';
  end if;

  if p_approximate_member_count is null or p_approximate_member_count < 0 or p_approximate_member_count > 100000 then
    raise exception 'invalid_member_count';
  end if;

  if v_current = '' or length(v_current) > 2000 then
    raise exception 'invalid_current_process';
  end if;

  if v_challenge = '' or length(v_challenge) > 2000 then
    raise exception 'invalid_operational_challenge';
  end if;

  if p_website is not null and length(trim(p_website)) > 0
     and trim(p_website) !~ '^https?://[^[:space:]]+$' then
    raise exception 'invalid_website';
  end if;

  if length(coalesce(p_phone, '')) > 40
     or length(coalesce(p_additional_details, '')) > 4000
     or length(coalesce(p_source, '')) > 100 then
    raise exception 'value_too_long';
  end if;

  -- 1. Duplicate safety — same email AND same club name, last 10 minutes.
  --    FIX (0106): qualified with the `pi` alias — `id` alone is ambiguous
  --    against this function's own `returns table (id uuid, ...)` OUT
  --    parameter (PostgreSQL 42702). The other columns referenced here
  --    (created_at, email, club_name) don't collide with anything and
  --    didn't need qualifying, but are qualified via the same alias for
  --    consistency within this one corrected query.
  select pi.id into v_existing_id
    from public.pilot_inquiries as pi
   where pi.created_at > now() - interval '10 minutes'
     and pi.email = v_email
     and lower(pi.club_name) = lower(v_club)
   order by pi.created_at desc
   limit 1;

  if v_existing_id is not null then
    return query select v_existing_id, true;
    return;
  end if;

  -- 2. Fingerprint throttle — only when a fingerprint was supplied.
  --    Unchanged: no reference here collides with either OUT parameter.
  if p_fingerprint is not null then
    select count(*) into v_recent_count
      from public.pilot_inquiries
     where request_fingerprint = p_fingerprint
       and created_at > now() - interval '10 minutes';

    if v_recent_count >= 3 then
      raise exception 'rate_limited';
    end if;
  end if;

  insert into public.pilot_inquiries (
    contact_name, email, phone, preferred_contact_method,
    club_name, facility_type, facility_type_other, website,
    court_count, approximate_member_count,
    current_process, operational_challenge, preferred_operating_model, additional_details,
    source, request_fingerprint
  ) values (
    v_name, v_email, nullif(trim(coalesce(p_phone, '')), ''), p_preferred_contact_method,
    v_club, p_facility_type, v_facility_other, nullif(trim(coalesce(p_website, '')), ''),
    p_court_count, p_approximate_member_count,
    v_current, v_challenge, p_preferred_operating_model,
    nullif(trim(coalesce(p_additional_details, '')), ''),
    coalesce(nullif(trim(p_source), ''), 'contact_page'),
    p_fingerprint
  )
  returning pilot_inquiries.id into v_new_id;

  return query select v_new_id, false;
end;
$$;

-- Explicit revoke/grant restated here (not merely assumed carried over from
-- 0105) so this migration's security result is self-evident on its own —
-- CREATE OR REPLACE FUNCTION preserves the target's existing privileges,
-- so these statements are a no-op against an already-correct grant, and a
-- correcting statement if anything ever drifted.
revoke execute on function public.submit_pilot_inquiry(
  text, text, text, text, int, int, text, text, text, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.submit_pilot_inquiry(
  text, text, text, text, int, int, text, text, text, text, text, text, text, text, text, text
) to service_role;
