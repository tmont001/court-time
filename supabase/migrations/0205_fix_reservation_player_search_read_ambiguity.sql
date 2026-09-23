-- 0205_fix_reservation_player_search_read_ambiguity.sql
-- Phase 39B-2 — Runtime fix: PL/pgSQL column-vs-output-variable ambiguity
-- in get_reservation_player_search.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- 0204 (APPLIED, immutable — not modified by this migration) is otherwise
-- working correctly, but live Stage A QA surfaced one real runtime defect
-- in public.get_reservation_player_search(uuid, uuid):
--
--   ERROR: 42702: column reference "reservation_id" is ambiguous
--   DETAIL: It could refer to either a PL/pgSQL variable or a table column.
--   QUERY: select *
--            from public.reservation_player_searches
--           where reservation_id = p_reservation_id
--
-- ROOT CAUSE: get_reservation_player_search's own `returns table (
-- reservation_id uuid, ...)` declares `reservation_id` as an OUTPUT
-- COLUMN, which PL/pgSQL treats as an ordinary variable in scope for the
-- entire function body — exactly like a DECLAREd variable. The function's
-- own body then reads `reservation_player_searches.reservation_id`
-- unqualified (`where reservation_id = p_reservation_id`), and Postgres
-- cannot tell whether that bare identifier means the output variable or
-- the table column, so it raises 42702 rather than guessing. This is a
-- pure PL/pgSQL naming collision — 0204's authorization, capacity, and
-- read semantics were never wrong, only this one unqualified reference.
--
-- FIX: alias the table and qualify every column reference against that
-- alias, exactly as get_open_reservation_player_searches (0204, Section
-- 4) already does throughout its own query — this migration does not
-- invent a new convention, it brings get_reservation_player_search in
-- line with the convention its own sibling RPC already followed correctly
-- from the start.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- NARROW SAME-CLASS SCAN — the other PL/pgSQL RETURNS TABLE function 0204
-- introduced, get_open_reservation_player_searches, was inspected for the
-- identical defect class (a bare column reference colliding with one of
-- its own `returns table (reservation_id, court_id, court_name, starts_at,
-- ends_at, format, host_display_name, player_capacity, occupied_seats,
-- remaining_spots)` output names). Direct re-read of its live body (0204,
-- Section 4) confirms every single column reference in its query —
-- SELECT list, JOIN conditions, WHERE clause, the NOT EXISTS subquery, and
-- the ORDER BY — is already alias-qualified (r./s./c./hrm./rp.), with zero
-- bare column references anywhere. It is not touched by this migration and
-- is not redefined here — there is nothing to fix.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- SCOPE
-- ═══════════════════════════════════════════════════════════════════════════
-- CREATE OR REPLACE of exactly one function: public.get_reservation_player_
-- search(uuid, uuid). Every other aspect is reproduced byte-for-byte from
-- its live 0204 body — same signature, same `returns table` shape (column
-- names/order/types unchanged, including the output column literally
-- named reservation_id), same SECURITY DEFINER / search_path, same
-- _authorize_reservation_roster_access(..., false) authorization gate,
-- same zero-row behavior when no search exists, same occupied-seat
-- calculation (_reservation_player_search_occupied_seats, unchanged), same
-- effective_is_open / effective_open_block_reason calculation (both
-- 0204 helpers, unchanged, not touched here), same grants/revokes, still
-- purely read-only (no INSERT/UPDATE/DELETE). Does not touch 0203, does
-- not touch any other 0204 object, does not change authorization,
-- capacity, notifications, or payment behavior in any way.
--
-- Not applied by this checkpoint. Not committed. Does not modify 0001-0204.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace function public.get_reservation_player_search(
  p_reservation_id   uuid,
  p_expected_club_id uuid
)
returns table (
  reservation_id              uuid,
  player_capacity             int,
  is_open                     boolean,
  effective_is_open           boolean,
  effective_open_block_reason text,
  occupied_seats              int,
  remaining_spots             int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reservation public.reservations%rowtype;
  v_search      public.reservation_player_searches%rowtype;
  v_occupied    int;
begin
  v_reservation := public._authorize_reservation_roster_access(p_reservation_id, p_expected_club_id, false);

  -- Fix: table aliased and reservation_id table-qualified (s.reservation_id)
  -- — the bare `reservation_id` in the prior 0204 body was ambiguous
  -- against this function's own `returns table (reservation_id uuid, ...)`
  -- output variable. select s.* (not select *) so the target list is
  -- unambiguous too, matching the alias applied to the WHERE clause.
  select s.* into v_search
    from public.reservation_player_searches s
   where s.reservation_id = p_reservation_id;

  if not found then
    return;
  end if;

  v_occupied := public._reservation_player_search_occupied_seats(p_reservation_id, v_search.host_roster_member_id);

  return query
    select
      p_reservation_id,
      v_search.player_capacity,
      v_search.is_open,
      public._reservation_player_search_is_effective_open(v_reservation, v_search),
      public._reservation_player_search_block_reason(v_reservation, v_search),
      v_occupied,
      v_search.player_capacity - v_occupied;
end;
$$;

revoke execute on function public.get_reservation_player_search(uuid, uuid) from public, anon;
grant  execute on function public.get_reservation_player_search(uuid, uuid) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint). Restores get_reservation_player_search to its exact
-- pre-0205 (0204) body — reproduced verbatim in 0204 itself (the buggy
-- unqualified `where reservation_id = p_reservation_id` form).
-- ═══════════════════════════════════════════════════════════════════════════
--   -- CREATE OR REPLACE public.get_reservation_player_search(uuid, uuid)
--   -- with 0204's own body verbatim.
