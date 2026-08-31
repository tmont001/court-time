-- 0160_fix_lesson_checkout_wrapper_column_ambiguity.sql
-- Phase 34F-A — Runtime QA fix: PL/pgSQL column ambiguity in the two
-- lesson Checkout atomic wrappers introduced by 0159 (already applied,
-- NOT modified by this migration).
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ROOT CAUSE (confirmed via real Member Pay Now runtime log)
-- ═══════════════════════════════════════════════════════════════════════════
-- [lesson-checkout] open_lesson_payment_checkout_attempt {
--   code: '42702',
--   message: 'column reference "status" is ambiguous'
-- }
--
-- Both public.open_lesson_payment_checkout_attempt(uuid, uuid, text,
-- boolean, uuid) and public.supersede_lesson_checkout_attempt_and_open_
-- fresh(uuid, uuid, uuid, text, boolean, uuid) are declared `RETURNS
-- TABLE (action text, id uuid, payment_id uuid, club_id uuid,
-- stripe_account_id text, livemode boolean, stripe_checkout_session_id
-- text, stripe_session_expires_at timestamptz, stripe_payment_intent_id
-- text, amount_expected_cents integer, currency_expected text, status
-- text, created_by uuid, created_at timestamptz, updated_at timestamptz)`
-- — PL/pgSQL implicitly creates an OUT parameter/output variable for
-- EVERY one of those column names, scoped to the entire function body.
-- Their bodies then read `public.lesson_requests`/`public.payments` using
-- BARE column references (`status`, `id`, `club_id`, `domain_type`,
-- `domain_id`, `obligation_cycle`) with no table alias — for `status`,
-- `id`, and `club_id` specifically, Postgres cannot tell whether the
-- reference means the queried table's own column or the function's own
-- RETURNS TABLE output variable of the identical name, and raises 42702
-- ("column reference ... is ambiguous") the instant the query plans.
--
-- This never surfaced during migration review because the .sql text is
-- syntactically valid and the ambiguity is a RUNTIME planner error, only
-- triggered the first time the SELECT actually executes — exactly what
-- the first real Member Pay Now click did.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- FIX
-- ═══════════════════════════════════════════════════════════════════════════
-- Both functions are reproduced VERBATIM from their exact applied 0159
-- bodies, with ONLY table columns qualified by an explicit alias
-- (lesson_requests -> lr, payments -> p) — defensively, on every table
-- column reference in both queries, not merely the one that happened to
-- trigger the error (domain_type/domain_id/obligation_cycle do not
-- collide with any RETURNS TABLE output name today, but are qualified
-- anyway so neither query relies on today's specific output-column set
-- remaining unchanged forever). No other line changes: same signatures,
-- same RETURNS TABLE shape, same service_role-only grants, same SECURITY
-- DEFINER, same search_path, same lesson row locking (`for update`),
-- same confirmed-only lifecycle requirement, same payment resolution,
-- same delegation to the existing, unmodified open_payment_checkout_
-- attempt / supersede_checkout_attempt_and_open_fresh, same lock
-- ordering, same raised error names, no Stripe-facing behavior touched
-- at all (Stripe Checkout Session creation/binding happens entirely in
-- lessonCheckoutActions.ts, untouched by this migration).
--
-- 0159 itself is NOT modified — this is a targeted CREATE OR REPLACE of
-- exactly these two functions, applied on top of the already-live 0159.
--
-- Apply in Supabase SQL Editor (cloud only). NOT YET APPLIED.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. open_lesson_payment_checkout_attempt — column-qualification fix only
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.open_lesson_payment_checkout_attempt(
  p_request_id         uuid,
  p_club_id            uuid,
  p_stripe_account_id  text,
  p_livemode           boolean,
  p_actor_id           uuid
)
returns table (
  action                      text,
  id                          uuid,
  payment_id                  uuid,
  club_id                     uuid,
  stripe_account_id           text,
  livemode                    boolean,
  stripe_checkout_session_id  text,
  stripe_session_expires_at   timestamptz,
  stripe_payment_intent_id    text,
  amount_expected_cents       integer,
  currency_expected           text,
  status                      text,
  created_by                  uuid,
  created_at                  timestamptz,
  updated_at                  timestamptz
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_request_status text;
  v_payment_id     uuid;
begin
  if p_request_id is null or p_club_id is null or p_stripe_account_id is null
     or p_livemode is null or p_actor_id is null then
    raise exception 'invalid_arguments';
  end if;

  -- Runtime QA fix (0160): lr.status/lr.id/lr.club_id — bare status/id/
  -- club_id collided with this function's own RETURNS TABLE output
  -- variables of the identical names (42702, column reference is
  -- ambiguous).
  select lr.status into v_request_status
    from public.lesson_requests lr
   where lr.id = p_request_id and lr.club_id = p_club_id
   for update;

  if not found then
    raise exception 'lesson_not_found';
  end if;

  if v_request_status <> 'confirmed' then
    raise exception 'lesson_not_confirmed';
  end if;

  -- Runtime QA fix (0160): p.id/p.club_id/p.domain_type/p.domain_id/
  -- p.obligation_cycle — qualified defensively on every column, not only
  -- the ones that collide with today's RETURNS TABLE output set.
  select p.id into v_payment_id
    from public.payments p
   where p.club_id = p_club_id and p.domain_type = 'lesson_request' and p.domain_id = p_request_id
   order by p.obligation_cycle desc
   limit 1;

  if v_payment_id is null then
    raise exception 'payment_not_found';
  end if;

  return query
    select * from public.open_payment_checkout_attempt(
      v_payment_id, p_club_id, p_stripe_account_id, p_livemode, p_actor_id
    );
end;
$$;

revoke execute on function public.open_lesson_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) from public, anon, authenticated;
grant  execute on function public.open_lesson_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. supersede_lesson_checkout_attempt_and_open_fresh — column-qualification
--    fix only
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.supersede_lesson_checkout_attempt_and_open_fresh(
  p_request_id         uuid,
  p_stale_attempt_id   uuid,
  p_club_id            uuid,
  p_stripe_account_id  text,
  p_livemode           boolean,
  p_actor_id           uuid
)
returns table (
  action                      text,
  id                          uuid,
  payment_id                  uuid,
  club_id                     uuid,
  stripe_account_id           text,
  livemode                    boolean,
  stripe_checkout_session_id  text,
  stripe_session_expires_at   timestamptz,
  stripe_payment_intent_id    text,
  amount_expected_cents       integer,
  currency_expected           text,
  status                      text,
  created_by                  uuid,
  created_at                  timestamptz,
  updated_at                  timestamptz
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_request_status text;
  v_payment_id     uuid;
begin
  if p_request_id is null or p_stale_attempt_id is null or p_club_id is null
     or p_stripe_account_id is null or p_livemode is null or p_actor_id is null then
    raise exception 'invalid_arguments';
  end if;

  -- Runtime QA fix (0160): identical column-qualification fix as
  -- open_lesson_payment_checkout_attempt above — same RETURNS TABLE shape,
  -- same ambiguity risk.
  select lr.status into v_request_status
    from public.lesson_requests lr
   where lr.id = p_request_id and lr.club_id = p_club_id
   for update;

  if not found then
    raise exception 'lesson_not_found';
  end if;

  if v_request_status <> 'confirmed' then
    raise exception 'lesson_not_confirmed';
  end if;

  select p.id into v_payment_id
    from public.payments p
   where p.club_id = p_club_id and p.domain_type = 'lesson_request' and p.domain_id = p_request_id
   order by p.obligation_cycle desc
   limit 1;

  if v_payment_id is null then
    raise exception 'payment_not_found';
  end if;

  return query
    select * from public.supersede_checkout_attempt_and_open_fresh(
      p_stale_attempt_id, v_payment_id, p_club_id, p_stripe_account_id, p_livemode, p_actor_id
    );
end;
$$;

revoke execute on function public.supersede_lesson_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid) from public, anon, authenticated;
grant  execute on function public.supersede_lesson_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid) to service_role;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created)
-- ═══════════════════════════════════════════════════════════════════════════
-- Restores both functions to their exact applied 0159 bodies (the ones
-- that raise 42702 at runtime) — byte-identical to 0159's own text.
-- begin;
--
-- create or replace function public.open_lesson_payment_checkout_attempt(
--   p_request_id         uuid,
--   p_club_id            uuid,
--   p_stripe_account_id  text,
--   p_livemode           boolean,
--   p_actor_id           uuid
-- )
-- returns table (
--   action                      text,
--   id                          uuid,
--   payment_id                  uuid,
--   club_id                     uuid,
--   stripe_account_id           text,
--   livemode                    boolean,
--   stripe_checkout_session_id  text,
--   stripe_session_expires_at   timestamptz,
--   stripe_payment_intent_id    text,
--   amount_expected_cents       integer,
--   currency_expected           text,
--   status                      text,
--   created_by                  uuid,
--   created_at                  timestamptz,
--   updated_at                  timestamptz
-- )
-- language plpgsql
-- security definer
-- set search_path to 'public', 'pg_temp'
-- as $$
-- declare
--   v_request_status text;
--   v_payment_id     uuid;
-- begin
--   if p_request_id is null or p_club_id is null or p_stripe_account_id is null
--      or p_livemode is null or p_actor_id is null then
--     raise exception 'invalid_arguments';
--   end if;
--
--   select status into v_request_status
--     from public.lesson_requests
--    where id = p_request_id and club_id = p_club_id
--    for update;
--
--   if not found then
--     raise exception 'lesson_not_found';
--   end if;
--
--   if v_request_status <> 'confirmed' then
--     raise exception 'lesson_not_confirmed';
--   end if;
--
--   select id into v_payment_id
--     from public.payments
--    where club_id = p_club_id and domain_type = 'lesson_request' and domain_id = p_request_id
--    order by obligation_cycle desc
--    limit 1;
--
--   if v_payment_id is null then
--     raise exception 'payment_not_found';
--   end if;
--
--   return query
--     select * from public.open_payment_checkout_attempt(
--       v_payment_id, p_club_id, p_stripe_account_id, p_livemode, p_actor_id
--     );
-- end;
-- $$;
--
-- revoke execute on function public.open_lesson_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) from public, anon, authenticated;
-- grant  execute on function public.open_lesson_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) to service_role;
--
-- create or replace function public.supersede_lesson_checkout_attempt_and_open_fresh(
--   p_request_id         uuid,
--   p_stale_attempt_id   uuid,
--   p_club_id            uuid,
--   p_stripe_account_id  text,
--   p_livemode           boolean,
--   p_actor_id           uuid
-- )
-- returns table (
--   action                      text,
--   id                          uuid,
--   payment_id                  uuid,
--   club_id                     uuid,
--   stripe_account_id           text,
--   livemode                    boolean,
--   stripe_checkout_session_id  text,
--   stripe_session_expires_at   timestamptz,
--   stripe_payment_intent_id    text,
--   amount_expected_cents       integer,
--   currency_expected           text,
--   status                      text,
--   created_by                  uuid,
--   created_at                  timestamptz,
--   updated_at                  timestamptz
-- )
-- language plpgsql
-- security definer
-- set search_path to 'public', 'pg_temp'
-- as $$
-- declare
--   v_request_status text;
--   v_payment_id     uuid;
-- begin
--   if p_request_id is null or p_stale_attempt_id is null or p_club_id is null
--      or p_stripe_account_id is null or p_livemode is null or p_actor_id is null then
--     raise exception 'invalid_arguments';
--   end if;
--
--   select status into v_request_status
--     from public.lesson_requests
--    where id = p_request_id and club_id = p_club_id
--    for update;
--
--   if not found then
--     raise exception 'lesson_not_found';
--   end if;
--
--   if v_request_status <> 'confirmed' then
--     raise exception 'lesson_not_confirmed';
--   end if;
--
--   select id into v_payment_id
--     from public.payments
--    where club_id = p_club_id and domain_type = 'lesson_request' and domain_id = p_request_id
--    order by obligation_cycle desc
--    limit 1;
--
--   if v_payment_id is null then
--     raise exception 'payment_not_found';
--   end if;
--
--   return query
--     select * from public.supersede_checkout_attempt_and_open_fresh(
--       p_stale_attempt_id, v_payment_id, p_club_id, p_stripe_account_id, p_livemode, p_actor_id
--     );
-- end;
-- $$;
--
-- revoke execute on function public.supersede_lesson_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid) from public, anon, authenticated;
-- grant  execute on function public.supersede_lesson_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid) to service_role;
--
-- commit;
