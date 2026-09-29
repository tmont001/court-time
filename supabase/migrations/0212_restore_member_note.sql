-- 0212_restore_member_note.sql
-- Phase 45C1A2 — Member Note Archive Lifecycle UX.
--
-- Product decision: Member Notes lifecycle is ACTIVE -> ARCHIVED -> RESTORED
-- TO ACTIVE. There is no normal hard-delete action; Archive (0211's
-- archive_member_note) is the normal removal mechanism, and this migration
-- adds the missing other half of that lifecycle: restoring an archived note
-- back to active.
--
-- Mirrors archive_member_note's own contract pattern exactly — admin-only,
-- same-club scoped, SECURITY DEFINER, explicit ACL, audit_log row. The only
-- differences are:
--   - the lifecycle guard is inverted (must currently BE archived, raising
--     note_not_archived otherwise, rather than must NOT be archived)
--   - which fields the UPDATE touches: only is_archived/archived_at/
--     archived_by/updated_at are cleared. body, author_id,
--     author_name_snapshot, created_at, member_id, and club_id are never
--     touched by this function.
--
-- This is a brand-new function (nothing to DROP), so CREATE OR REPLACE is
-- used directly, matching this project's established convention for
-- introducing a new RPC (e.g. 0075's add_member_note/update_member_note/
-- archive_member_note themselves all used CREATE OR REPLACE on first
-- creation, not CREATE).
--
-- Created by this checkpoint. Do NOT apply until reviewed.

begin;

create or replace function public.restore_member_note(
  p_note_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.profiles%rowtype;
  v_note  public.member_notes%rowtype;
begin
  select pr.* into v_actor from public.profiles pr where pr.id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_actor.role <> 'admin' then raise exception 'insufficient_role'; end if;

  select mn.* into v_note from public.member_notes mn
   where mn.id      = p_note_id
     and mn.club_id = v_actor.club_id;
  if not found then raise exception 'note_not_found'; end if;
  if not v_note.is_archived then raise exception 'note_not_archived'; end if;

  update public.member_notes
     set is_archived = false,
         archived_at = null,
         archived_by = null,
         updated_at  = now()
   where id = p_note_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id, auth.uid(), 'restore_member_note', 'member_note', p_note_id,
    jsonb_build_object('member_id', v_note.member_id)
  );
end;
$$;

alter function public.restore_member_note(uuid) owner to postgres;
revoke execute on function public.restore_member_note(uuid) from public, anon;
grant  execute on function public.restore_member_note(uuid) to authenticated;
grant  execute on function public.restore_member_note(uuid) to service_role;

-- restore_member_note is a brand-new RPC name PostgREST has never seen
-- before, so its schema cache must be told about it explicitly — same
-- standard, documented directive 0211 used for the same reason (new/
-- changed RPC argument names).
NOTIFY pgrst, 'reload schema';

commit;
