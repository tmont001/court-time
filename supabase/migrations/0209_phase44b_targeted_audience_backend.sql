-- 0209_phase44b_targeted_audience_backend.sql
-- Phase 44B — Targeted Audience Backend + Recipient Preview.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY / DEPLOYMENT SAFETY
-- ═══════════════════════════════════════════════════════════════════════════
-- Communications v2 needs a second audience mode ("specific people")
-- alongside today's "all active club users" default, plus a server-
-- authoritative preview before send. PostgreSQL function identity includes
-- the argument signature — CREATE OR REPLACE cannot turn
-- send_announcement_v2(text, text) into a four-argument function; that
-- would be a DIFFERENT function that merely shares a name. The live pilot
-- app is still calling the two-argument form until the updated application
-- (which calls the four-argument form explicitly) is deployed, so this
-- migration cannot drop or reshape the two-argument signature.
--
-- Live dependency audit performed before writing this migration (against
-- the applied project, not assumed):
--   - pg_depend: zero rows reference send_announcement_v2(text, text)'s oid
--     (no view/rule/trigger/policy dependency of any kind).
--   - No other function's body CALLS it — a text search across every
--     public function's prosrc found four functions that merely mention
--     "send_announcement_v2" in a comment (citing 0177's fix as precedent
--     for their own, unrelated bug fixes): update_club_rules_and_policies,
--     cancel_event, create_refund_request, admin_reassign_confirmed_lesson_
--     pro. None of the four actually invoke it.
--   - No RLS policy qual/with_check references it; no view definition
--     references it.
--   - Its only real dependency is the deployed application itself
--     (communicationsActions.ts's sendAnnouncementAction, calling
--     supabase.rpc("send_announcement_v2", { p_title, p_body })) — exactly
--     why it is kept, not dropped, here.
--
-- STRATEGY: two co-existing overloads, one business-logic implementation.
--   A. send_announcement_v2(text, text, text, uuid[]) — NEW, the sole
--      canonical implementation. No defaults (every caller must be
--      explicit about audience).
--   B. send_announcement_v2(text, text) — CREATE OR REPLACE'd to a thin
--      delegating wrapper: `return public.send_announcement_v2(p_title,
--      p_body, 'all', null);` and nothing else. No independent recipient-
--      resolution logic of any kind. This is the exact signature already
--      deployed, so its existing EXECUTE grants (authenticated only,
--      confirmed live: anon=false, public=false, authenticated=true) carry
--      forward unchanged via CREATE OR REPLACE — no new GRANT/REVOKE
--      needed for it.
-- The two-argument wrapper is TEMPORARY. Phase 44D retires it once the
-- application that calls the four-argument form directly has been deployed
-- and proven — tracked there, not here.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- SCOPE
-- ═══════════════════════════════════════════════════════════════════════════
--   1. public._announcement_recipient_candidates(...) — new private helper,
--      the single canonical eligibility definition every other function
--      below calls. Never becomes a client-callable capability.
--   2. public.send_announcement_v2(text, text, text, uuid[]) — new,
--      canonical send implementation.
--   3. public.send_announcement_v2(text, text) — redefined as a
--      compatibility wrapper over (2).
--   4. public.preview_announcement_recipients(text, uuid[]) — new,
--      read-only, Admin-only.
--   5. public.get_announcement_recipient_candidates() — new, read-only,
--      Admin-only, narrow selector-listing RPC.
--
-- No table, column, RLS policy, notification-kind, or preference-schema
-- change of any kind. get_communications_activity and
-- get_announcement_batch_delivery_context (0170, 0102) are NOT redefined —
-- both already reconstruct their output from real notifications/audit_log
-- rows and need no change to keep working for a targeted send; Phase 44D
-- will surface audience_mode in Activity/history. No Communications UI,
-- Phase 39, payment, reservation, or waiver code is touched.
--
-- Apply in Supabase SQL Editor (cloud only). Not applied by this
-- checkpoint — prepared for migration review only.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Private helper — public._announcement_recipient_candidates(...)
-- ═══════════════════════════════════════════════════════════════════════════
-- The single canonical eligibility definition for "who may receive an
-- announcement," shared by send, preview, and the selector-listing RPC
-- below so the three can never drift from one another. Underscore-prefixed
-- per this repository's existing convention for internal, non-client-
-- facing helpers (_current_user_active_membership, 0082;
-- _lesson_check_pro_availability_for_club, 0070). EXECUTE is revoked from
-- PUBLIC, anon, AND authenticated — this helper never becomes a callable
-- RPC endpoint; it is reachable only from inside another SECURITY DEFINER
-- function already running as this same trusted role.
--
-- p_club_id is ALWAYS a server-derived value (current_user_club_id()) at
-- every call site below — never a client-supplied parameter of any public
-- RPC. This is what makes cross-club leakage structurally impossible
-- regardless of what a client puts in p_recipient_user_ids: that array can
-- only ever narrow the result WITHIN p_club_id, never widen it.
--
-- Candidate rule, identical to send_announcement_v2's existing (0177)
-- recipient query: an active, non-removed club_memberships row in the
-- given club — never profiles.club_id/role/status, which stay frozen at
-- their last known value once a membership is removed or deactivated
-- (0081). Deliberately returns candidates even when
-- announcement_enabled = false — preference filtering is a decision for
-- the CONSUMING function (send/preview filter it out before use;
-- get_announcement_recipient_candidates deliberately does NOT, so an
-- opted-out active person can still be shown, transparently, as a
-- visible-but-not-selectable option in a future 44C selector).
create or replace function public._announcement_recipient_candidates(
  p_club_id             uuid,
  p_exclude_user_id     uuid,
  p_recipient_user_ids  uuid[] default null
)
returns table (
  user_id              uuid,
  announcement_enabled boolean
)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select distinct
    cm.user_id,
    coalesce(
      (select np.enabled
         from public.notification_preferences np
        where np.user_id = cm.user_id
          and np.kind    = 'announcement'),
      true
    ) as announcement_enabled
    from public.club_memberships cm
   where cm.club_id    = p_club_id
     and cm.status     = 'active'
     and cm.removed_at is null
     and (p_exclude_user_id    is null or cm.user_id <> p_exclude_user_id)
     and (p_recipient_user_ids is null or cm.user_id = any(p_recipient_user_ids));
$$;

revoke execute on function public._announcement_recipient_candidates(uuid, uuid, uuid[])
  from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Canonical send — public.send_announcement_v2(text, text, text, uuid[])
-- ═══════════════════════════════════════════════════════════════════════════
-- Reproduces 0177's send_announcement_v2 body byte-for-byte for every
-- preserved concern (auth/role check shape, title/body validation and
-- limits, batch id generation, notification metadata shape, audit_log
-- shape, return jsonb shape, sender exclusion) — the only substantive
-- changes are: (a) recipient resolution now delegates to the shared helper
-- instead of its own inline club_memberships query, adding the audience-
-- mode/recipient-id dimension; (b) audience_mode validation;
-- (c) send-time revalidation with a fail-closed no_eligible_recipients
-- path for 'specific' mode only; (d) 'audience_mode' added to the existing
-- audit_log metadata object. No defaults on p_audience_mode/
-- p_recipient_user_ids — every caller (including the compatibility
-- wrapper below) must be explicit.
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

  -- Audience validation. NULL-safe (`is distinct from`, matching this
  -- repository's own established idiom, e.g. 0177's role check) so a NULL
  -- p_audience_mode is rejected exactly like any other unrecognized value,
  -- rather than silently falling through both branches below.
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

  -- Recipient resolution — the SAME canonical helper preview uses, called
  -- fresh HERE, at send time. Preview's own earlier result (if any) is
  -- never read, trusted, or reused: a person who was eligible when
  -- previewed but is no longer eligible now (removed, deactivated, opted
  -- out since) is excluded here independently, because this query runs
  -- again from scratch. Only ANNOUNCEMENT_ENABLED = true candidates ever
  -- become recipients.
  select coalesce(array_agg(c.user_id order by c.user_id), '{}'::uuid[])
    into v_recipient_ids
    from public._announcement_recipient_candidates(
           v_club_id,
           auth.uid(),
           case when p_audience_mode = 'specific' then p_recipient_user_ids else null end
         ) c
   where c.announcement_enabled = true;

  -- SPECIFIC zero-survivor rule: the submitted array was valid/non-empty,
  -- but every one of those ids is now wrong-club, removed, inactive, the
  -- sender, or opted out. Fail closed BEFORE any insert — no notification
  -- row, no audit_log row, no batch. ALL mode is deliberately exempt: a
  -- club with zero eligible announcement recipients today already
  -- silently produces a zero-recipient send with its own audit_log entry
  -- (0177's unmodified pre-existing behavior) — that is preserved exactly,
  -- not newly restricted.
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

revoke execute on function public.send_announcement_v2(text, text, text, uuid[]) from public, anon;
grant  execute on function public.send_announcement_v2(text, text, text, uuid[]) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Compatibility wrapper — public.send_announcement_v2(text, text)
-- ═══════════════════════════════════════════════════════════════════════════
-- TEMPORARY. Same exact signature as the currently-deployed function, so
-- CREATE OR REPLACE keeps its existing EXECUTE grants unchanged (confirmed
-- live: authenticated only, not anon/public) — no GRANT/REVOKE statement
-- is included or needed here. Contains NO recipient-resolution logic of
-- its own, independent or otherwise — it does exactly one thing: delegate
-- to the four-argument canonical implementation with audience_mode='all',
-- p_recipient_user_ids=null, and return whatever that call returns,
-- unmodified. Every validation, error, and side effect (title/body checks,
-- notification insert, audit_log insert, return shape) is entirely the
-- four-argument function's — this wrapper cannot diverge from it because
-- it contains no independent logic to diverge with.
--
-- Retired in Phase 44D once the application calling the four-argument
-- form directly has been deployed and proven. Not retired here.
create or replace function public.send_announcement_v2(
  p_title text,
  p_body  text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.send_announcement_v2(p_title, p_body, 'all', null);
end;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Preview — public.preview_announcement_recipients(text, uuid[])
-- ═══════════════════════════════════════════════════════════════════════════
-- Read-only (STABLE, no mutation of any kind), Admin-only. Calls the SAME
-- helper send uses, with the SAME audience-mode validation rules, so
-- preview and send can never disagree about what "eligible" means at the
-- moment either one runs — they share one definition, not two
-- independently-maintained copies of it. This is informational only: it
-- is never treated as an authorization token by send, which independently
-- re-evaluates eligibility from scratch (see section 2's own comment).
--
-- ALL mode: returns eligible_count only. eligible_user_ids is always NULL
-- for this mode — a preview endpoint must never become a way to enumerate
-- an entire club's active membership roster; "This will send to 7 people"
-- needs a number, not a list.
-- SPECIFIC mode: returns the deduped, eligible subset of exactly what the
-- caller submitted — bounded by the size of their own selection, so
-- returning it discloses nothing beyond what that Admin already named.
-- A submitted, non-empty array that resolves to zero eligible ids is a
-- SUCCESSFUL preview with eligible_count = 0 and an empty array — not an
-- error. (Only SEND fails closed on that same condition — see section 2.)
create or replace function public.preview_announcement_recipients(
  p_audience_mode       text,
  p_recipient_user_ids  uuid[]
)
returns table (
  eligible_count    integer,
  eligible_user_ids uuid[]
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_club_id    uuid;
  v_role       text;
  v_candidates uuid[];
  v_result_ids uuid[];
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'no_club'; end if;
  if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;

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
    into v_candidates
    from public._announcement_recipient_candidates(
           v_club_id,
           auth.uid(),
           case when p_audience_mode = 'specific' then p_recipient_user_ids else null end
         ) c
   where c.announcement_enabled = true;

  v_result_ids := case when p_audience_mode = 'specific' then v_candidates else null end;

  return query select coalesce(array_length(v_candidates, 1), 0), v_result_ids;
end;
$$;

revoke execute on function public.preview_announcement_recipients(text, uuid[]) from public, anon;
grant  execute on function public.preview_announcement_recipients(text, uuid[]) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Selector listing — public.get_announcement_recipient_candidates()
-- ═══════════════════════════════════════════════════════════════════════════
-- Read-only, Admin-only (matching send_announcement_v2's own caller gate —
-- Communications compose is Admin-only, not Admin-or-Staff). A NARROW,
-- purpose-built RPC rather than a reuse or widening of get_members()
-- (0190, Admin-or-Staff, returns phone/email/membership-type/every
-- removed row for the Members-admin page) — matching this repository's
-- own established precedent of adding a second narrow RPC rather than
-- broadening an existing admin-management one for a differently-shaped
-- consumer (0180's get_confirmed_lesson_reassignment_pros alongside
-- get_admin_club_pros is the identical pattern). Returns only currently-
-- ELIGIBLE club-membership candidates (never a removed/inactive/wrong-club
-- person) with exactly the fields a people-picker needs: no phone, no
-- email, no membership-type/roster data. Deliberately DOES include an
-- opted-out active person (announcement_enabled = false) rather than
-- hiding them — the point is transparency: a future 44C selector can show
-- them as "Announcements off" and prevent their selection, rather than
-- silently omitting them with no explanation. role comes from
-- club_memberships (membership-derived), never profiles.role.
create or replace function public.get_announcement_recipient_candidates()
returns table (
  id                   uuid,
  first_name           text,
  last_name            text,
  role                 text,
  announcement_enabled boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'no_club'; end if;
  if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;

  return query
    select p.id, p.first_name, p.last_name, cm.role, c.announcement_enabled
      from public._announcement_recipient_candidates(v_club_id, auth.uid()) c
      join public.club_memberships cm on cm.user_id = c.user_id and cm.club_id = v_club_id
      join public.profiles p           on p.id       = c.user_id
     order by
       p.last_name nulls last,
       p.first_name nulls last,
       p.id;
end;
$$;

revoke execute on function public.get_announcement_recipient_candidates() from public, anon;
grant  execute on function public.get_announcement_recipient_candidates() to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run manually after applying — NOT executed automatically by
-- this file)
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. select proname, pg_get_function_identity_arguments(oid) from pg_proc
--    where proname = 'send_announcement_v2'; -- must return TWO rows: one
--    "p_title text, p_body text", one "p_title text, p_body text,
--    p_audience_mode text, p_recipient_user_ids uuid[]".
--
-- 2. As an Admin, call the two-argument form (matching the currently
--    deployed app exactly) — must succeed exactly as before, and the new
--    audit_log row's metadata must now additionally contain
--    "audience_mode": "all".
--
-- 3. As an Admin, remove/deactivate a test Member, then call
--    preview_announcement_recipients('specific', array[<that member's
--    id>]) — must succeed with eligible_count = 0, eligible_user_ids = '{}'.
--    Then call send_announcement_v2(<title>, <body>, 'specific',
--    array[<that member's id>]) — must raise no_eligible_recipients, and
--    select * from notifications where metadata->>'announcement_batch_id'
--    is not null order by created_at desc limit 5; must show NO new rows
--    for this attempt.
--
-- 4. As an Admin, call preview then send with a mixed array of one
--    eligible Member id and one removed/foreign-club id — preview and
--    send must each independently return/insert for exactly the eligible
--    one, silently excluding the other, with no error.
--
-- 5. As a Member (non-admin), call get_announcement_recipient_candidates()
--    — must raise insufficient_role.
--
-- 6. select has_function_privilege('authenticated',
--    '_announcement_recipient_candidates(uuid,uuid,uuid[])'::regprocedure,
--    'execute'); -- must be false.
-- ═══════════════════════════════════════════════════════════════════════════
-- End of 0209_phase44b_targeted_audience_backend.sql
-- ═══════════════════════════════════════════════════════════════════════════
