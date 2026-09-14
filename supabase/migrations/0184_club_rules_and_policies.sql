-- 0184_club_rules_and_policies.sql
-- Small pre-Phase-39A checkpoint: one club-specific INFORMATIONAL
-- "Club Rules & Policies" document (court etiquette, dress code, court
-- cleanup, ball machine rules, general facility expectations, guest/
-- check-in guidance — examples only). Deliberately NOT an enforceable
-- policy engine: cancellation windows, refund rules, booking restrictions,
-- fees, eligibility, and waiver acceptance remain structured product
-- policy handled in later phases and are never read from this column by
-- any enforcement path.
--
-- Additive only — no existing column, constraint, RLS policy, or RPC is
-- altered. Mirrors update_club_pricing/update_club_timezone's own
-- established shape exactly (single-field, Admin-only, club_settings-
-- scoped RPC), but uses the CURRENT auth convention
-- (current_user_club_id()/current_user_role(), already the authoritative
-- source for this table's own pre-existing club_settings_update_admin RLS
-- policy, 0012) rather than those two older siblings' legacy direct
-- profiles.role read.
--
-- Apply in Supabase SQL Editor (cloud only).

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. club_settings.rules_and_policies — additive, nullable
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.club_settings
  add column if not exists rules_and_policies text;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. update_club_rules_and_policies — Admin-only
-- ═══════════════════════════════════════════════════════════════════════════
-- Trims input; empty/whitespace-only becomes NULL (same normalization
-- idiom as set_member_notes/create_refund_request's v_reason handling).
-- Rejects anything over 10,000 characters AFTER trimming (so a value that
-- is only over-length due to leading/trailing whitespace is not
-- incorrectly rejected). Writes exactly ONE audit_log entry, and only when
-- the value actually changes — lightweight metadata only (booleans +
-- character counts), never the policy text itself, so a large or
-- sensitive-looking document is never duplicated into the audit trail.
--
-- Correction pass — an unchanged Save is a TRUE no-op: the existing row is
-- locked (SELECT ... FOR UPDATE) and its absence is detected via FOUND
-- immediately, BEFORE any comparison or write, so a missing club_settings
-- row can never be mistaken for an existing row with NULL content. The
-- old-vs-new equality check happens next, still before any UPDATE — a
-- no-op returns immediately, touching neither rules_and_policies,
-- updated_at, nor audit_log. Only a genuine change reaches the UPDATE +
-- single audit_log insert below it. The row lock also means two
-- concurrent Admin saves serialize against each other, so before/after
-- audit metadata is never computed from a stale, concurrently-overwritten
-- v_old.
create or replace function public.update_club_rules_and_policies(
  p_rules_and_policies text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_old     text;
  v_new     text;
begin
  v_club_id := public.current_user_club_id();
  v_role    := public.current_user_role();
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  -- `is distinct from`, not `<>` — a NULL role (no active membership) must
  -- be REJECTED, not silently pass (the same null-safety trap this
  -- codebase's own send_announcement_v2/create_refund_request fixes
  -- already document and avoid for this exact class of check).
  if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;

  v_new := nullif(btrim(coalesce(p_rules_and_policies, '')), '');

  if v_new is not null and length(v_new) > 10000 then
    raise exception 'rules_and_policies_too_long';
  end if;

  select rules_and_policies into v_old
    from public.club_settings
   where club_id = v_club_id
     for update;
  if not found then raise exception 'club_settings_not_found'; end if;

  if v_old is not distinct from v_new then
    return;
  end if;

  update public.club_settings
     set rules_and_policies = v_new,
         updated_at         = now()
   where club_id = v_club_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'update_club_rules_and_policies', 'club_settings', v_club_id,
    jsonb_build_object(
      'had_content_before',       v_old is not null,
      'has_content_after',        v_new is not null,
      'previous_character_count', coalesce(length(v_old), 0),
      'new_character_count',      coalesce(length(v_new), 0)
    )
  );
end;
$$;

revoke execute on function public.update_club_rules_and_policies(text) from public, anon;
grant  execute on function public.update_club_rules_and_policies(text) to authenticated;

-- No RLS change: club_settings_select_same_club (0002) already permits any
-- same-club authenticated read of the new column (exactly how /help
-- already reads booking_window_days/cancellation_window_hours today), and
-- club_settings_update_admin (0012) already restricts direct table writes
-- to same-club Admins as a defense-in-depth backstop behind this RPC.

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback (manual, cloud SQL Editor)
-- ═══════════════════════════════════════════════════════════════════════════
-- drop function if exists public.update_club_rules_and_policies(text);
-- alter table public.club_settings drop column if exists rules_and_policies;
