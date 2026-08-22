-- 0145_payment_state_rpc_ambiguity_fix.sql
-- Phase 34C — Production hotfix.
--
-- get_payment_states_for_domains (0143) is a RETURNS TABLE PL/pgSQL
-- function, so `domain_id` (one of its output columns) is also an
-- implicitly-declared variable in scope throughout the function body. The
-- prior_unresolved CTE referenced `domain_id` unqualified (both in its
-- SELECT list and its GROUP BY), which PostgreSQL cannot resolve against
-- the CTE's own `ranked` column vs. the function's output variable of the
-- identical name — raising 42702 "column reference is ambiguous" on every
-- call, so no payment state ever rendered anywhere in the UI.
--
-- Fix: alias `ranked` as `r` inside prior_unresolved and qualify every
-- column reference in that CTE. No other change — same signature, same
-- RETURNS TABLE shape/order/types, same SECURITY DEFINER/search_path, same
-- role authorization, same Member/Pro restrictions, same ranking and
-- unresolved-prior semantics, same grants.
--
-- Apply in Supabase SQL Editor (cloud only).

begin;

create or replace function public.get_payment_states_for_domains(
  p_domain_type text,
  p_domain_ids  uuid[]
)
returns table (
  domain_id                  uuid,
  current_payment_id         uuid,
  current_obligation_cycle   integer,
  current_amount_due_cents   integer,
  current_amount_paid_cents  integer,
  current_status             text,
  current_currency           text,
  unresolved_prior           jsonb
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id          uuid;
  v_role             text;
  v_roster_member_id uuid;
begin
  v_club_id := public.current_user_club_id();
  v_role    := public.current_user_role();
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  if v_role in ('admin', 'staff') then
    null;
  elsif v_role = 'pro' then
    if p_domain_type <> 'lesson_request' then
      raise exception 'insufficient_role';
    end if;
  elsif v_role = 'member' then
    v_roster_member_id := public.current_user_roster_member_id();
    if v_roster_member_id is null then raise exception 'not_authenticated'; end if;
  else
    raise exception 'insufficient_role';
  end if;

  return query
    with ranked as (
      select p.*,
             row_number() over (partition by p.domain_id order by p.obligation_cycle desc) as rn
        from public.payments p
       where p.club_id = v_club_id
         and p.domain_type = p_domain_type
         and p.domain_id = any(p_domain_ids)
         and (
           v_role in ('admin', 'staff')
           or (v_role = 'pro' and exists (
                 select 1 from public.lesson_requests lr
                  where lr.id = p.domain_id and lr.pro_id = auth.uid()
               ))
           or (v_role = 'member' and p.roster_member_id = v_roster_member_id)
         )
    ),
    current_rows as (
      select * from ranked where rn = 1
    ),
    -- Every reference qualified with the `r` alias — `ranked.domain_id`
    -- (and every other column here) would otherwise collide with this
    -- function's own `domain_id` OUT parameter (42702 ambiguous column).
    prior_unresolved as (
      select r.domain_id,
             jsonb_agg(
               jsonb_build_object(
                 'payment_id', r.id,
                 'obligation_cycle', r.obligation_cycle,
                 'amount_due_cents', r.amount_due_cents,
                 'amount_paid_cents', r.amount_paid_cents,
                 'currency', r.currency,
                 'status', r.status
               )
               order by r.obligation_cycle desc
             ) as items
        from ranked r
       where r.rn > 1
         and r.status not in ('paid', 'refunded', 'waived', 'void')
         and not (r.amount_due_cents = 0 and r.amount_paid_cents = 0)
       group by r.domain_id
    )
    select
      c.domain_id,
      c.id,
      c.obligation_cycle,
      c.amount_due_cents,
      c.amount_paid_cents,
      c.status,
      c.currency,
      -- Pro gets current operational Lesson payment state only — never
      -- prior financial-cycle visibility, regardless of what the CTEs
      -- above computed. Admin/Staff/Member get real prior-cycle data.
      case when v_role = 'pro' then '[]'::jsonb else coalesce(u.items, '[]'::jsonb) end
    from current_rows c
    left join prior_unresolved u on u.domain_id = c.domain_id;
end;
$$;

revoke execute on function public.get_payment_states_for_domains(text, uuid[]) from public, anon;
grant  execute on function public.get_payment_states_for_domains(text, uuid[]) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback (manual, cloud SQL Editor)
-- ═══════════════════════════════════════════════════════════════════════════
-- Not applicable as a DROP — restores the exact pre-0145 (ambiguous) body
-- by re-running 0143's own CREATE OR REPLACE for this function. No
-- signature or return-contract change was made, so there is nothing to
-- structurally undo.
