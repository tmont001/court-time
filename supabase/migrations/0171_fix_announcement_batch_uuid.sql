-- 0171_fix_announcement_batch_uuid.sql
-- Bug fix — send_announcement_v2 (migration 0102, already applied) fails at
-- runtime with Postgres error 42883: "function uuid_generate_v4() does not
-- exist". Confirmed via a temporary runtime diagnostic in
-- src/app/(app)/admin/communications/communicationsActions.ts:
--
--   [communications/send_announcement_v2] {
--     code: '42883',
--     message: 'function uuid_generate_v4() does not exist',
--     details: null,
--     hint: 'No function matches the given name and argument types. You
--            might need to add explicit type casts.'
--   }
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ROOT CAUSE
-- ═══════════════════════════════════════════════════════════════════════════
-- 0001_initial_schema.sql installs uuid-ossp with a bare
-- `create extension if not exists "uuid-ossp";` (no SCHEMA clause) —
-- Supabase places extensions installed this way into the `extensions`
-- schema, not `public`. send_announcement_v2 is `set search_path = public,
-- pg_temp` (the standard SECURITY DEFINER hardening every RPC since 0082
-- uses, to prevent search_path injection), so its unqualified
-- `v_batch_id uuid := uuid_generate_v4();` cannot resolve — `extensions` is
-- not on that path.
--
-- Every OTHER uuid_generate_v4() call in this repo (0001, 0003, 0004, 0005,
-- 0009, 0019, 0042, 0050) is a table column DEFAULT expression, not a
-- function-body call — a column default's function reference is resolved
-- and bound to a specific function OID once, at DDL time, and is
-- unaffected by any later session's or function's search_path. This one
-- had no working precedent to catch it: send_announcement_v2 (0102) was
-- the first, and remains the only, plpgsql function body anywhere in this
-- repo to call a locally-scoped UUID generator by name.
--
-- gen_random_uuid() is this repo's established, working convention for
-- exactly this need — a core PostgreSQL 13+ builtin (pg_catalog, always on
-- every search_path, no extension required — see 0031_club_invites.sql's
-- own comment: "Tokens are generated using gen_random_uuid() — no pgcrypto
-- required"), already used by 14+ migrations since 0031. This migration
-- changes ONLY the batch-uuid expression to gen_random_uuid() — every other
-- line of send_announcement_v2's body, cloned verbatim from the 0102
-- definition, is unchanged.
--
-- Preserved exactly (unchanged from 0102): function name/signature, jsonb
-- return contract, SECURITY DEFINER, search_path = public, pg_temp,
-- authentication/admin-authorization checks and their exact exception
-- strings, title/body validation, recipient selection (active, same-club,
-- excluding the sender), announcement preference filtering
-- (notification_preferences.kind='announcement', enabled defaults true),
-- the notifications insert and its announcement_batch_id metadata stamp,
-- recipient_count, the exact {notification_id, user_id} returned list, and
-- the audit_log 'send_announcement' entry. EXECUTE privileges reproduced
-- identically: revoked from public/anon, granted to authenticated.
--
-- Does not touch 0170, any table, any RLS policy, or the payment domain.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.send_announcement_v2(
  p_title text,
  p_body  text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile         public.profiles%rowtype;
  v_batch_id        uuid := gen_random_uuid();
  v_notifications   jsonb;
  v_recipient_count integer;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.role <> 'admin' then
    raise exception 'insufficient_role';
  end if;

  if trim(p_title) = '' or trim(p_body) = '' then
    raise exception 'invalid_announcement';
  end if;
  if length(trim(p_title)) > 100 or length(trim(p_body)) > 500 then
    raise exception 'invalid_announcement';
  end if;

  with ins as (
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    select
      v_profile.club_id,
      p.id,
      'announcement',
      trim(p_body),
      jsonb_build_object(
        'title',                trim(p_title),
        'sender_id',             auth.uid(),
        'announcement_batch_id', v_batch_id
      )
    from public.profiles p
    where p.club_id = v_profile.club_id
      and p.status  = 'active'
      and p.id      <> auth.uid()
      and coalesce(
        (select enabled
           from public.notification_preferences
          where user_id = p.id
            and kind    = 'announcement'),
        true
      ) = true
    returning id, user_id
  )
  select
    coalesce(jsonb_agg(jsonb_build_object('notification_id', id, 'user_id', user_id)), '[]'::jsonb),
    count(*)
  into v_notifications, v_recipient_count
  from ins;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'send_announcement',
    'club',
    v_profile.club_id,
    jsonb_build_object(
      'title',           trim(p_title),
      'recipient_count', v_recipient_count,
      'batch_id',        v_batch_id
    )
  );

  return jsonb_build_object(
    'batch_id',        v_batch_id,
    'recipient_count', v_recipient_count,
    'notifications',   v_notifications
  );
end;
$$;

revoke execute on function public.send_announcement_v2(text, text) from public, anon;
grant  execute on function public.send_announcement_v2(text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run manually after applying — NOT executed automatically by
-- this file)
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Confirm the function body no longer references uuid_generate_v4:
--      select prosrc from pg_proc where proname = 'send_announcement_v2';
--    should contain gen_random_uuid() and not uuid_generate_v4.
-- 2. As an Admin, in the app, send a real announcement from
--    /admin/communications (Compose tab). Expect a success message
--    ("Announcement sent to N recipient(s).") — not the generic failure.
-- 3. Confirm a new Activity row appears for that batch with a non-null
--    batch_id (not a legacy row), correct recipient_count, and (once
--    email dispatch completes) accurate email_sent_count/email_failed_count.
-- 4. Confirm EXECUTE privileges: anon/public cannot call this function;
--    authenticated can.
-- 5. Confirm no regression in the exception paths — attempt to call as a
--    non-admin (expect insufficient_role) and with an empty title/body
--    (expect invalid_announcement).
-- ═══════════════════════════════════════════════════════════════════════════
-- End of 0171_fix_announcement_batch_uuid.sql
-- ═══════════════════════════════════════════════════════════════════════════
