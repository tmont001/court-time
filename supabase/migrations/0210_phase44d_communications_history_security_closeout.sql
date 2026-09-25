-- 0210_phase44d_communications_history_security_closeout.sql
-- Phase 44D — Communications v2 Final Closeout: Activity/history,
-- durable body storage, temporary-wrapper retirement, and
-- user_pref_enabled security hardening.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY
-- ═══════════════════════════════════════════════════════════════════════════
-- Four independent, narrowly-scoped closeout items, bundled into one
-- migration because none requires the others to be split across separate
-- transactions and PostgreSQL dependency mechanics don't force otherwise:
--
--   1. send_announcement_v2(text, text, text, uuid[]) — same signature,
--      CREATE OR REPLACE — additionally persists the announcement body in
--      its own audit_log.metadata, alongside the title/recipient_count/
--      batch_id/audience_mode it already writes (0209). This is what makes
--      audit_log a recipient-count-independent, always-present source for
--      "what did we actually send" going forward — a zero-recipient ALL
--      send (always legal, 0177's unmodified original behavior) still
--      gets a durable body record, which notifications-based
--      reconstruction alone could never guarantee.
--
--   2. send_announcement_v2(text, text) — DROPPED. Phase 44B's own
--      dependency audit (this file's own migration history) found zero
--      DB-level dependents; a fresh audit repeated for this checkpoint
--      confirms the same, and additionally confirms the deployed,
--      committed, pushed application (as of Phase 44C) now calls only the
--      four-argument form — the temporary bridge this wrapper existed for
--      has been crossed. Not kept as a permanent duplicate overload.
--
--   3. get_communications_activity(int, int) — return shape changes
--      (adds audience_mode, body), which CREATE OR REPLACE cannot express
--      for a RETURNS TABLE function — requires DROP + CREATE. Dependency
--      audit (this file's own history): pg_depend has zero rows
--      referencing its oid — no view/rule/trigger/policy depends on it.
--      Safe to drop without CASCADE.
--
--   4. user_pref_enabled(uuid, text) — live-confirmed EXECUTE grants
--      before this migration: anon=true, authenticated=true, public=true,
--      service_role=true — genuinely PUBLIC- and anon-executable today,
--      including by an unauthenticated caller with only the public anon
--      key, to query ANY user's preference for ANY notification kind.
--      Also lacks a pinned search_path. Live dependency audit: exactly
--      three SQL callers (create_reservation, cancel_member_reservation,
--      join_event — the three originally-configurable notification kinds;
--      'announcement' has always gated inline in send_announcement_v2,
--      never through this helper) and exactly two TypeScript call sites
--      (src/lib/email.ts's sendEmailNotification — the shared gate behind
--      EVERY notification-email path in this app, including
--      Communications' own send — and src/app/(app)/lessons/actions.ts).
--      Both TypeScript call sites run through a per-request, session/
--      cookie-based Supabase client — i.e. as the real signed-in caller's
--      own `authenticated` JWT, never a service-role key. Revoking
--      `authenticated` would break real, currently-necessary application
--      behavior across multiple domains — out of this migration's narrow
--      Communications-closeout scope to refactor. This migration
--      therefore revokes EXECUTE from PUBLIC and anon only — closing the
--      unauthenticated disclosure vector — and pins search_path, while
--      deliberately leaving a residual, DOCUMENTED risk: any authenticated
--      user of any role in any club can still query an arbitrary other
--      user's preference state cross-club. That residual is explicitly
--      OUT OF SCOPE for Phase 44D and deferred to a future, broader
--      notification-system security pass — it is not solved here.
--
-- No table, column, or RLS policy is touched anywhere in this file. No
-- notification-kind or preference-schema change. No Communications UI
-- audience-editing/resend/scheduling/SMS/chat capability is added — this
-- migration is read/history/security only.
--
-- Apply in Supabase SQL Editor (cloud only). Not applied by this
-- checkpoint — prepared for migration review only. 0207-0209 remain
-- immutable and are not edited by this file.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Canonical four-argument send — durable body history
-- ═══════════════════════════════════════════════════════════════════════════
-- Byte-identical to 0209's body (auth/role checks, title/body validation,
-- audience validation, shared-helper recipient resolution, deterministic
-- ORDER BY on the recipient-id aggregation, the specific-mode zero-
-- survivor fail-closed path, notification metadata shape, batch id
-- generation, returned jsonb shape, grants) with exactly one addition:
-- 'body', trim(p_body) added to the existing audit_log.metadata object,
-- alongside the title/recipient_count/batch_id/audience_mode it already
-- writes. This insert is UNCONDITIONAL — it runs whether recipient_count
-- is positive or zero (ALL mode's own pre-existing, unmodified zero-
-- recipient behavior), which is exactly what makes it a reliable source
-- regardless of who — if anyone — ended up eligible.
create or replace function public.send_announcement_v2(
  p_title               text,
  p_body                text,
  p_audience_mode       text,
  p_recipient_user_ids  uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id         uuid;
  v_role            text;
  v_batch_id        uuid := gen_random_uuid();
  v_notifications   jsonb;
  v_recipient_count integer;
  v_recipient_ids   uuid[];
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_role is distinct from 'admin' then
    raise exception 'insufficient_role';
  end if;

  if trim(p_title) = '' or trim(p_body) = '' then
    raise exception 'invalid_announcement';
  end if;
  if length(trim(p_title)) > 100 or length(trim(p_body)) > 500 then
    raise exception 'invalid_announcement';
  end if;

  if p_audience_mode is distinct from 'all' and p_audience_mode is distinct from 'specific' then
    raise exception 'invalid_audience';
  end if;

  if p_audience_mode = 'all'
     and p_recipient_user_ids is not null
     and array_length(p_recipient_user_ids, 1) > 0
  then
    raise exception 'invalid_audience';
  end if;

  if p_audience_mode = 'specific'
     and (p_recipient_user_ids is null or array_length(p_recipient_user_ids, 1) is null or array_length(p_recipient_user_ids, 1) = 0)
  then
    raise exception 'invalid_audience';
  end if;

  select coalesce(array_agg(c.user_id order by c.user_id), '{}'::uuid[])
    into v_recipient_ids
    from public._announcement_recipient_candidates(
           v_club_id,
           auth.uid(),
           case when p_audience_mode = 'specific' then p_recipient_user_ids else null end
         ) c
   where c.announcement_enabled = true;

  if p_audience_mode = 'specific' and array_length(v_recipient_ids, 1) is null then
    raise exception 'no_eligible_recipients';
  end if;

  with ins as (
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    select
      v_club_id,
      uid,
      'announcement',
      trim(p_body),
      jsonb_build_object(
        'title',                trim(p_title),
        'sender_id',             auth.uid(),
        'announcement_batch_id', v_batch_id
      )
    from unnest(v_recipient_ids) as uid
    returning id, user_id
  )
  select
    coalesce(jsonb_agg(jsonb_build_object('notification_id', id, 'user_id', user_id)), '[]'::jsonb),
    count(*)
  into v_notifications, v_recipient_count
  from ins;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id,
    auth.uid(),
    'send_announcement',
    'club',
    v_club_id,
    jsonb_build_object(
      'title',           trim(p_title),
      'body',            trim(p_body),
      'recipient_count', v_recipient_count,
      'batch_id',        v_batch_id,
      'audience_mode',   p_audience_mode
    )
  );

  return jsonb_build_object(
    'batch_id',        v_batch_id,
    'recipient_count', v_recipient_count,
    'notifications',   v_notifications
  );
end;
$$;

-- Same signature as 0209 — CREATE OR REPLACE carries its existing grants
-- forward unchanged. No GRANT/REVOKE statement needed or included here.


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Retire the temporary two-argument compatibility wrapper
-- ═══════════════════════════════════════════════════════════════════════════
-- Confirmed (this migration's own header, and independently before it was
-- written): zero pg_depend rows, zero SQL callers, zero application call
-- sites as of the Phase 44C deployment. No CASCADE — a bare DROP is
-- sufficient and the absence of CASCADE is itself a check: if any
-- dependent were ever found to exist unexpectedly, this statement would
-- fail loudly rather than silently taking something else down with it.
drop function public.send_announcement_v2(text, text);


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Recreate get_communications_activity — audience_mode + body
-- ═══════════════════════════════════════════════════════════════════════════
-- Return-shape change (two new output columns) — PostgreSQL does not allow
-- CREATE OR REPLACE to change a function's return type, so the existing
-- signature is dropped first. Zero pg_depend dependents (verified before
-- writing this migration) — safe without CASCADE.
--
-- Every existing concern is preserved byte-for-byte: Admin/current-club
-- authorization (fails closed to an empty result set for a non-admin or
-- clubless caller, not an exception — unchanged), the notification_
-- outcomes CTE and its retry-safe bool_or reduction, the sent-supersedes-
-- failed priority rule, limit/offset clamping, and newest-first ordering.
--
-- audience_mode: coalesce(al.metadata->>'audience_mode', 'all'). Every
-- batch predating migration 0209 lacks this key by construction —
-- send_announcement_v2 had no capability whatsoever to target anything
-- but the full eligible club membership before 0209 introduced the
-- audience_mode/p_recipient_user_ids parameters. This default is a
-- structural fact about the code that produced those historical rows, not
-- a guess — no third "unknown" mode is introduced.
--
-- body precedence:
--   A. al.metadata->>'body' — present on every batch sent by THIS
--      migration's own redefined send_announcement_v2 (section 1 above),
--      unconditionally, including a zero-recipient ALL send.
--   B. historical fallback — one notification.body belonging to the same
--      caller club, kind='announcement', and matching
--      metadata->>'announcement_batch_id', for any 0209/pre-0210 batch
--      that has recipients (every notification in a batch was inserted
--      with the identical trim(p_body) value in one statement, so which
--      one is picked is immaterial to correctness — but the selection
--      itself is still made deterministic: ORDER BY n.created_at, n.id
--      LIMIT 1, never a bare unordered LIMIT 1).
--   C. NULL — a batch with no metadata.body AND zero notification rows
--      (a historical zero-recipient send, or a legacy pre-0102 batch-id-
--      null row for which no join key exists at all). Never inferred from
--      title/timing; never fabricated. The Activity UI shows "Message
--      unavailable" for exactly this case.
drop function public.get_communications_activity(integer, integer);

create or replace function public.get_communications_activity(
  p_limit  int default 20,
  p_offset int default 0
)
returns table (
  batch_id           uuid,
  title              text,
  sent_at            timestamptz,
  recipient_count    integer,
  email_sent_count   integer,
  email_failed_count integer,
  audience_mode      text,
  body               text
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_caller_club uuid;
  v_caller_role text;
  v_limit       int := greatest(1, least(coalesce(p_limit, 20), 100));
  v_offset      int := greatest(0, coalesce(p_offset, 0));
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_caller_club, v_caller_role;

  if v_caller_club is null or v_caller_role <> 'admin' then
    return;
  end if;

  return query
    with notification_outcomes as (
      select
        n.id                                  as notification_id,
        n.metadata->>'announcement_batch_id'  as batch_id_text,
        bool_or(nd.channel = 'email' and nd.status = 'sent')   as email_sent,
        bool_or(nd.channel = 'email' and nd.status = 'failed') as email_failed_attempt
      from public.notifications n
      left join public.notification_deliveries nd
        on nd.notification_id = n.id
      where n.club_id = v_caller_club
        and n.kind    = 'announcement'
      group by n.id
    )
    select
      (al.metadata->>'batch_id')::uuid                  as batch_id,
      al.metadata->>'title'                             as title,
      al.created_at                                     as sent_at,
      (al.metadata->>'recipient_count')::integer        as recipient_count,
      coalesce(sum(case when o.email_sent then 1 else 0 end), 0)::integer
        as email_sent_count,
      coalesce(sum(case when o.email_failed_attempt and not o.email_sent then 1 else 0 end), 0)::integer
        as email_failed_count,
      coalesce(al.metadata->>'audience_mode', 'all')     as audience_mode,
      coalesce(
        al.metadata->>'body',
        (
          select n2.body
            from public.notifications n2
           where n2.club_id = v_caller_club
             and n2.kind    = 'announcement'
             and n2.metadata->>'announcement_batch_id' = (al.metadata->>'batch_id')
           order by n2.created_at, n2.id
           limit 1
        )
      )                                                  as body
    from public.audit_log al
    left join notification_outcomes o
      on o.batch_id_text = (al.metadata->>'batch_id')
    where al.club_id = v_caller_club
      and al.action  = 'send_announcement'
    group by al.id
    order by al.created_at desc
    limit v_limit offset v_offset;
end;
$$;

-- DROP + CREATE does NOT preserve privileges — explicitly restore the
-- exact same posture 0170 established (never rely on default grants).
revoke execute on function public.get_communications_activity(int, int) from public, anon;
grant  execute on function public.get_communications_activity(int, int) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. user_pref_enabled — search_path pin + PUBLIC/anon revocation
-- ═══════════════════════════════════════════════════════════════════════════
-- Same signature (uuid, text), same LANGUAGE SQL/SECURITY DEFINER/STABLE,
-- same preference-lookup semantics (missing row = enabled, unchanged) —
-- CREATE OR REPLACE, no signature change, no DROP needed. The only body
-- change is the added SET search_path clause; the query itself is
-- untouched.
--
-- Grants: REVOKE from PUBLIC and anon closes the unauthenticated
-- disclosure vector confirmed live before this migration. `authenticated`
-- is deliberately NOT revoked — src/lib/email.ts's sendEmailNotification
-- (the shared gate behind every notification-email path in this app,
-- Communications' own send included) and src/app/(app)/lessons/actions.ts
-- both call this RPC through a real per-request, session-based
-- `authenticated` client, not a service-role key; revoking authenticated
-- would break that real, currently load-bearing behavior across multiple
-- domains outside this migration's Communications-closeout scope.
--
-- RESIDUAL RISK, DOCUMENTED AND DEFERRED: an authenticated caller of any
-- role, in any club, can still invoke this RPC with an arbitrary p_user_id
-- and learn that user's opt-in/opt-out state for an arbitrary kind — nothing
-- in this function scopes the query to the caller's own row or the
-- caller's own club. Fixing this properly requires either narrowing the
-- function's own contract or moving email.ts's/lessons/actions.ts's call
-- sites behind a differently-scoped mechanism — a broader, cross-domain
-- notification-system security change, intentionally NOT attempted here.
create or replace function public.user_pref_enabled(p_user_id uuid, p_kind text)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    (select enabled
       from notification_preferences
      where user_id = p_user_id
        and kind    = p_kind),
    true
  );
$$;

revoke execute on function public.user_pref_enabled(uuid, text) from public, anon;
grant  execute on function public.user_pref_enabled(uuid, text) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run manually after applying — NOT executed automatically by
-- this file)
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. select proname, pg_get_function_identity_arguments(oid) from pg_proc
--    where proname = 'send_announcement_v2'; -- must return exactly ONE
--    row: "p_title text, p_body text, p_audience_mode text,
--    p_recipient_user_ids uuid[]".
--
-- 2. As an Admin, send a real ALL-mode test announcement. Confirm:
--    select metadata from audit_log where action = 'send_announcement'
--    order by created_at desc limit 1;
--    contains title, body, recipient_count, batch_id, AND audience_mode.
--
-- 3. As an Admin, call get_communications_activity(20, 0). Confirm:
--    - the just-sent batch shows audience_mode = 'all' and body equal to
--      the exact text just sent.
--    - a historical batch from before this migration (0209-era, real
--      recipients) shows the same body via the notification-fallback
--      path, and its audience_mode reflects whatever was actually stored
--      (or 'all' if absent).
--    - a legacy batch-id-null row (if one exists for this club) shows
--      audience_mode = 'all' and body = NULL.
--
-- 4. As a non-admin, call get_communications_activity(20, 0) — must
--    return zero rows, not an error (unchanged fail-closed behavior).
--
-- 5. select has_function_privilege('anon',
--    'get_communications_activity(int,int)'::regprocedure, 'execute');
--    -- must be false. Same check with 'authenticated' -- must be true.
--
-- 6. select has_function_privilege('anon',
--    'user_pref_enabled(uuid,text)'::regprocedure, 'execute'); -- must be
--    false. Same check with 'authenticated' -- must be true.
--
-- 7. Send a real reservation/event/lesson action that dispatches a
--    notification email as a real Member (not Admin) — confirm delivery
--    still succeeds, proving sendEmailNotification's authenticated-role
--    call to user_pref_enabled still works post-revocation.
-- ═══════════════════════════════════════════════════════════════════════════
-- End of 0210_phase44d_communications_history_security_closeout.sql
-- ═══════════════════════════════════════════════════════════════════════════
