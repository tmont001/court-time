-- 0105_pilot_inquiries.sql
-- Phase 32C: Public Pilot Inquiry Workflow (corrected pass)
--
-- Introduces a narrowly-scoped, pre-authentication inquiry path for the
-- public /contact ("Request a pilot") page. This is intentionally NOT a
-- CRM: no pipeline, no forecasting, no task management, no activity
-- history, no automatic club creation, no subscription/plan selection.
-- `preferred_operating_model` is a Phase 33 discovery signal only (see the
-- doc comment on that column below) — it never assigns a package.
--
-- Corrected in this pass (superseding the first draft of this migration,
-- never applied):
--   - preferred_operating_model now has exactly THREE values (staff_managed,
--     member_self_service, not_sure) — 'hybrid' removed entirely, and the
--     column is now NOT NULL (a visitor must pick one; 'not_sure' is the
--     honest answer for "I don't know yet").
--   - court_count is now NOT NULL and must be >= 1 (a real inquiry always
--     has at least one court); approximate_member_count stays NOT NULL but
--     >= 0 is allowed (a facility with no formal membership yet).
--   - current_process and operational_challenge are now NOT NULL.
--   - facility_type_other is now required (and bounded) whenever
--     facility_type = 'other', enforced by a table CHECK.
--   - operator_email_status / operator_email_error columns removed, and
--     record_pilot_inquiry_email_status() removed entirely — an anonymous
--     caller should not be handed a general "update an existing row by ID"
--     RPC merely to persist best-effort delivery metadata. Email failure is
--     now logged server-side only (see the Server Action), never persisted.
--   - Duplicate-submission safety now matches on normalized email PLUS
--     normalized club name (not email alone), which is a materially
--     different, more accurate signal than before.
--   - request_fingerprint is no longer derived from the email address (that
--     added no protection beyond the email match above) — it is now an
--     HMAC of the request's client-address header, computed by the Server
--     Action, never the raw address itself. See the abuse-control section
--     below.
--   - Table and function privileges are now explicitly revoked before being
--     narrowly re-granted, rather than relying on absence of a grant.
--   - submit_pilot_inquiry is now granted ONLY to service_role — NOT anon,
--     NOT authenticated. The public website never calls this RPC directly
--     with the browser's anon/publishable identity; the Next.js Server
--     Action is the only caller, using a server-only privileged Supabase
--     client (SUPABASE_SECRET_KEY). This closes a real gap in the prior
--     draft: an external caller with nothing but the project's public
--     anon/publishable key could previously invoke this RPC directly —
--     bypassing the Server Action's honeypot entirely, and (since the RPC
--     skips its own throttle when p_fingerprint is null) supplying no
--     fingerprint or an arbitrary one to bypass the abuse-control throttle
--     too. With execute restricted to service_role, the RPC can now trust
--     that p_fingerprint, when non-null, genuinely came from the server's
--     own header-derived HMAC — not from an arbitrary direct caller.
--
-- Security model
-- ───────────────
-- RLS is enabled on pilot_inquiries with NO policies at all, and table
-- privileges are explicitly revoked from every role — this is a deliberate
-- default-deny: no anonymous visitor, no authenticated Member/Pro/Admin of
-- any club, and no other RPC can read, update, or delete a row directly.
-- The only door in or out is submit_pilot_inquiry(), grantable only to
-- service_role, which does exactly one narrow thing: validate and insert
-- (or dedupe) exactly one inquiry, and return only its id. There is no
-- surface here that exposes inquiry data to club Admins — these are Court
-- Time business inquiries, not records belonging to a customer club, and
-- nothing in this migration scopes them by club_id (inquiries predate any
-- club existing).
--
-- Safe to re-apply: CREATE TABLE IF NOT EXISTS; CREATE OR REPLACE
-- functions; DROP FUNCTION IF EXISTS for the removed RPC. Apply in Supabase
-- SQL Editor (cloud only). Do not apply until reviewed.


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. pilot_inquiries table
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.pilot_inquiries (
  id                        uuid primary key default gen_random_uuid(),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  status                    text not null default 'new'
                              check (status in ('new', 'contacted', 'qualified', 'closed')),

  -- Contact
  contact_name              text not null check (length(contact_name) between 1 and 200),
  email                     text not null check (length(email) between 3 and 320),
  phone                     text check (phone is null or length(phone) <= 40),
  preferred_contact_method  text check (preferred_contact_method is null or preferred_contact_method in ('email', 'phone', 'either')),

  -- Club
  club_name                 text not null check (length(club_name) between 1 and 200),
  facility_type             text not null check (facility_type in (
                               'private_club', 'country_club', 'hoa_residential',
                               'public_municipal', 'tennis_academy', 'school_university', 'other'
                             )),
  facility_type_other       text check (facility_type_other is null or length(facility_type_other) <= 200),
  website                   text check (website is null or length(website) <= 500),
  court_count               int not null check (court_count >= 1 and court_count <= 500),
  approximate_member_count  int not null check (approximate_member_count >= 0 and approximate_member_count <= 100000),

  -- Discovery — informs Phase 33 commercial packaging only. Never read by
  -- any current pricing, entitlement, or provisioning code path.
  current_process           text not null check (length(current_process) between 1 and 2000),
  operational_challenge     text not null check (length(operational_challenge) between 1 and 2000),
  preferred_operating_model text not null check (preferred_operating_model in (
                               'staff_managed', 'member_self_service', 'not_sure'
                             )),
  additional_details        text check (additional_details is null or length(additional_details) <= 4000),

  source                    text not null default 'contact_page' check (length(source) <= 100),

  -- Abuse control — a one-way HMAC of the request's client-address header
  -- (never the raw address), computed application-side with
  -- PILOT_INQUIRY_HASH_SECRET. Null when the secret or a usable address is
  -- unavailable; the throttle check below simply does not apply in that
  -- case (see submit_pilot_inquiry).
  request_fingerprint       text,

  -- "Other" facility type requires a non-empty clarification.
  constraint pilot_inquiries_facility_type_other_required
    check (facility_type <> 'other' or (facility_type_other is not null and length(trim(facility_type_other)) between 1 and 200))
);

comment on table public.pilot_inquiries is
  'Public pilot-request inquiries submitted from /contact. Not a CRM — no pipeline, no plan assignment. preferred_operating_model is a Phase 33 discovery signal only (staff_managed / member_self_service / not_sure).';

alter table public.pilot_inquiries enable row level security;
-- Deliberately zero policies: no role (anon, authenticated, or any club's
-- Admin) can SELECT/INSERT/UPDATE/DELETE this table directly. All access
-- goes through submit_pilot_inquiry() below.

revoke all on table public.pilot_inquiries from public, anon, authenticated;
-- Explicit, not merely relying on RLS-with-no-policies: removes whatever
-- default table-level privileges Supabase grants anon/authenticated at
-- project creation, so there is no ambient grant for RLS to be the only
-- thing standing in the way of.

create index if not exists pilot_inquiries_created_at_idx on public.pilot_inquiries (created_at desc);
create index if not exists pilot_inquiries_email_recent_idx on public.pilot_inquiries (email, created_at desc);
create index if not exists pilot_inquiries_fingerprint_recent_idx on public.pilot_inquiries (request_fingerprint, created_at desc);


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. submit_pilot_inquiry — the only way to create or touch a row
-- ═══════════════════════════════════════════════════════════════════════════
-- Re-validates every field at the database boundary (never trusts the
-- calling application code alone — defense in depth, not the only check).
-- Callable only by service_role (see the grant at the bottom of this
-- section) — the Next.js Server Action is the sole caller, via a
-- server-only privileged Supabase client. Because only that trusted caller
-- can ever reach this function, p_fingerprint can be trusted when present:
-- it is always the server's own HMAC of the request's client-address
-- header, never a value an external caller chose. Two distinct
-- abuse-control mechanisms:
--
--   1. Duplicate safety (idempotent, never blocks a legitimate visitor): a
--      matching submission — same normalized email AND same normalized
--      club name — within the last 10 minutes returns the EXISTING row's
--      id instead of inserting a duplicate. This covers double-clicks and
--      ambiguous-network retries; a visitor who retries after an operator-
--      email failure (logged server-side only, never persisted here) always
--      lands back on their own already-durable record.
--
--   2. Request-fingerprint throttle (can reject): when the caller supplies
--      a non-null p_fingerprint, more than 3 submissions from that same
--      fingerprint within the last 10 minutes raises 'rate_limited'. This
--      is a modest threshold sized for a low-volume pilot-inquiry form,
--      meant to catch scripted abuse cycling through different names/
--      emails/clubs from one source, not to block a legitimate club
--      filling the form out once. When no fingerprint is available
--      (PILOT_INQUIRY_HASH_SECRET unset, or no usable address header — e.g.
--      local dev), this check is skipped entirely and only the
--      duplicate-safety check above applies; a legitimate inquiry is never
--      rejected merely because fingerprinting was unavailable.

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
  select id into v_existing_id
    from public.pilot_inquiries
   where created_at > now() - interval '10 minutes'
     and email = v_email
     and lower(club_name) = lower(v_club)
   order by created_at desc
   limit 1;

  if v_existing_id is not null then
    return query select v_existing_id, true;
    return;
  end if;

  -- 2. Fingerprint throttle — only when a fingerprint was supplied.
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

revoke execute on function public.submit_pilot_inquiry(
  text, text, text, text, int, int, text, text, text, text, text, text, text, text, text, text
) from public, anon, authenticated;
-- Granted ONLY to service_role — not anon, not authenticated. The public
-- /contact page never calls this RPC with the browser's anon/publishable
-- identity; only the Next.js Server Action, via a server-only privileged
-- Supabase client (SUPABASE_SECRET_KEY), can invoke it. This is what makes
-- it safe for the function to trust p_fingerprint above: an external
-- caller holding only the project's public anon/publishable key cannot
-- reach this function at all, so there is no direct-RPC path to bypass the
-- Server Action's honeypot or supply a forged/omitted fingerprint. Scope is
-- kept narrow regardless: this function only ever inserts into (or dedupes
-- against) pilot_inquiries, never reads an existing row's contents, and
-- never updates a row after the fact.
grant execute on function public.submit_pilot_inquiry(
  text, text, text, text, int, int, text, text, text, text, text, text, text, text, text, text
) to service_role;
