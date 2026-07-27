-- 0084_additional_club_invitation_acceptance.sql
-- Phase 26D1: Additional-Club Invitation Acceptance
--
-- Converts accept_club_invite(text) to support a user who already has an
-- active membership in one club accepting a valid invitation to a
-- different club, while preserving the existing first-ever (no-club)
-- acceptance flow's observable behavior exactly.
--
-- FOCUSED AUDIT FINDINGS (invitation-acceptance path only; the broader
-- Phase 26 architecture audit is not repeated here):
--   • accept_club_invite(text) (0067, search-path-hardened by 0068, never
--     otherwise touched through 0083) is the sole blocker: it hard-rejects
--     any caller whose profiles.club_id is already set —
--     `if v_profile.club_id is not null then raise exception
--     'already_in_club'; end if;` — before even looking at the invite
--     being accepted. This is the only database-level gate preventing a
--     second-club acceptance.
--   • validate_club_invite(text) (0054, anon-safe, used by /join/[code] for
--     invite-detail display) does not reference the caller's own
--     membership state at all — it only validates the invite row itself
--     (not_found/revoked/used/expired) and returns club_name/role/
--     email_restricted. No change needed.
--   • create_club_invite (0032) is unrelated to acceptance and unaffected.
--   • src/app/(auth)/join/[code]/page.tsx contains the one application-
--     layer blocker: `if (user && profileClubId) { ...Already connected...
--     Each account belongs to one club... }` — renders a dead-end screen
--     with no path to accept, for any signed-in user who already has a
--     club, regardless of which club the invite is for.
--   • src/app/(auth)/join/[code]/actions.ts's acceptInviteAction/
--     acceptPendingInviteAction both already just call accept_club_invite
--     and map its error string — neither contains its own "already has a
--     club" assumption; only their shared ERROR_MESSAGES/DEFINITIVE_ERRORS
--     map needs new entries for the two new stable errors this migration
--     introduces.
--   • middleware.ts's ct_invite_pending cookie stamping and
--     (app)/layout.tsx's cookie-redirect (for no-club users only) have no
--     "already has a club" assumption and need no change.
--   • roster_members.claimed_by is a GLOBALLY unique column (flagged in
--     the Phase 26A architecture audit, not previously reachable because
--     no user could ever hold two memberships). This checkpoint's new
--     flow makes it reachable for the first time: a user who already
--     claimed a roster row in Club A whose email also matches an
--     unclaimed roster row in Club B would violate that global uniqueness
--     during Club B's roster auto-link step. Guarded below (see section 1)
--     rather than widening the schema constraint, which is out of this
--     checkpoint's scope.
--
-- No other RPC, RLS policy, or application file needs to change for this
-- checkpoint.
--
-- ATOMICITY: the entire file runs inside one transaction. No exception
-- handler here catches and swallows a migration failure. Within
-- accept_club_invite itself, membership creation, invite consumption, and
-- active-club selection are all statements inside the same implicit RPC
-- transaction — any failure after the membership INSERT (including
-- set_active_club raising, which should never legitimately happen here —
-- see section 1) rolls back the INSERT and the invite's accepted_at/
-- accepted_by update together with it.
--
-- LOCK ORDER: caller's own profiles row (FOR UPDATE) first, then the
-- invite row (FOR UPDATE), then club_memberships (a fresh INSERT — no
-- pre-existing row to lock in the success path), then a nested call to
-- set_active_club (0082), whose own profiles-row and club_memberships-row
-- locks are on rows this function already holds and are therefore harmless
-- re-locks, not new lock acquisitions. This matches the profiles-first
-- ordering already established by set_active_club and every Phase 26C1
-- admin RPC. Locking the caller's own profiles row first also serializes
-- concurrent acceptance attempts by the same user (including two different
-- invite codes for the same destination club): a second concurrent call
-- blocks on that same lock until the first transaction commits or rolls
-- back, at which point it re-reads current state and correctly resolves to
-- invite_used or already_member rather than racing a duplicate insert.
--
-- Independently safe to deploy and leave in production before any further
-- Phase 26D checkpoint: accept_club_invite's signature, return shape, and
-- first-ever-acceptance behavior are unchanged; only a caller-side product
-- decision (whether the join UI still blocks already-clubbed users) governs
-- whether the new flow is actually reachable.
--
-- Apply in Supabase SQL Editor (cloud only). Not applied by this checkpoint.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. accept_club_invite(text) — converted
-- ═══════════════════════════════════════════════════════════════════════════
-- Same name and signature (p_code text) → jsonb, so no application call
-- site needs to change which RPC it calls.
--
-- Supported existing-membership states for the invitation's destination
-- club (per this checkpoint's explicit scope):
--   • none                         -> create the membership (first-ever OR
--                                      additional club, same code path)
--   • active, non-removed          -> 'already_member' (no duplicate, no
--                                      re-consumption of the invite)
--   • inactive/suspended/removed   -> 'membership_state_conflict' (no
--                                      silent reactivation/restoration —
--                                      that is Phase 26D2's job)
create or replace function public.accept_club_invite(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite        public.club_invites%rowtype;
  v_profile       public.profiles%rowtype;
  v_club          public.clubs%rowtype;
  v_auth_email    text;
  v_existing      public.club_memberships%rowtype;
  v_roster_id     uuid;
  v_roster_first  text;
  v_roster_last   text;
  v_roster_phone  text;
begin
  -- Lock order: caller's own profiles row first (see header comment).
  select p.* into v_profile from public.profiles p where p.id = auth.uid() for update;
  if not found then raise exception 'not_authenticated'; end if;

  -- Lock the invite row second, exactly as before.
  select * into v_invite from public.club_invites where code = p_code for update;

  if not found                        then raise exception 'invalid_invite';  end if;
  if v_invite.revoked_at  is not null then raise exception 'invite_revoked';  end if;
  if v_invite.accepted_at is not null then raise exception 'invite_used';     end if;
  if v_invite.expires_at < now()      then raise exception 'invite_expired';  end if;

  -- Email restriction: unchanged normalization (case-insensitive compare).
  if v_invite.email is not null then
    select email into v_auth_email from auth.users where id = auth.uid();
    if lower(v_auth_email) <> lower(v_invite.email) then
      raise exception 'email_mismatch';
    end if;
  end if;

  -- Never a caller-controlled user id: every membership lookup/write below
  -- is scoped to auth.uid(), never to any value derived from p_code or any
  -- other input.
  select cm.* into v_existing
    from public.club_memberships cm
   where cm.user_id = auth.uid()
     and cm.club_id = v_invite.club_id;

  if found then
    if v_existing.status = 'active' and v_existing.removed_at is null then
      raise exception 'already_member';
    else
      raise exception 'membership_state_conflict';
    end if;
  end if;

  -- Create the destination membership. Preserves provenance (invited_by,
  -- source_invite_id) exactly as the schema supports. Never touches any
  -- other club's membership row — an existing membership elsewhere (e.g.
  -- Club A) is not read, written, or referenced anywhere in this function.
  insert into public.club_memberships (
    user_id, club_id, role, status, invited_by, source_invite_id
  ) values (
    auth.uid(), v_invite.club_id, v_invite.role, 'active', v_invite.created_by, v_invite.id
  );

  update public.club_invites
     set accepted_at = now(),
         accepted_by = auth.uid()
   where id = v_invite.id;

  -- Activate the newly created membership in the same transaction, reusing
  -- set_active_club's own validated switch (0082) rather than re-deriving
  -- its logic. The target row is guaranteed to exist and be valid at this
  -- point (just inserted, above, and still locked by this transaction), so
  -- this call cannot legitimately fail. Migration 0081's Trigger C performs
  -- the legacy profiles.club_id/role/status/is_lesson_provider projection
  -- as part of that same call — no direct profiles membership-field write
  -- happens in this function.
  perform public.set_active_club(v_invite.club_id);

  select * into v_club from public.clubs where id = v_invite.club_id;

  -- Audit: invite accepted. Scoped to the destination club only — never
  -- written against any other club the caller may belong to.
  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_invite.club_id,
    auth.uid(),
    'accept_invite',
    'profile',
    auth.uid(),
    jsonb_build_object('role', v_invite.role, 'invite_id', v_invite.id)
  );

  -- Roster auto-link by email — unchanged in shape from the pre-26D1
  -- version, with one added guard. roster_members.claimed_by is a
  -- GLOBALLY unique column (not scoped per club — a pre-existing schema
  -- gap, out of this checkpoint's scope to fix). Without the guard below,
  -- a user who already claimed a roster row in one club and whose email
  -- also matches an unclaimed roster row in THIS destination club would
  -- hit a unique-constraint violation here. The guard simply skips the
  -- claim in that narrow case — this club's roster entry stays unclaimed,
  -- exactly as if no email match had been found, rather than raising an
  -- unrelated constraint-violation error out of an otherwise-successful
  -- acceptance.
  if v_auth_email is null then
    select email into v_auth_email from auth.users where id = auth.uid();
  end if;

  if v_auth_email is not null then
    select rm.id, rm.first_name, rm.last_name, rm.phone
      into v_roster_id, v_roster_first, v_roster_last, v_roster_phone
      from public.roster_members rm
     where rm.club_id     = v_invite.club_id
       and lower(rm.email) = lower(v_auth_email)
       and rm.claimed_by  is null
     limit 1
     for update;

    if v_roster_id is not null
       and not exists (select 1 from public.roster_members where claimed_by = auth.uid())
    then
      update public.roster_members
         set claimed_by = auth.uid(),
             updated_at = now()
       where id = v_roster_id;

      -- Global identity fields only (first_name/last_name/phone) — never
      -- club-scoped, unaffected by which club is being joined.
      update public.profiles
         set first_name = case when btrim(coalesce(first_name, '')) = '' then v_roster_first else first_name end,
             last_name  = case when btrim(coalesce(last_name,  '')) = '' then v_roster_last  else last_name  end,
             phone      = case when btrim(coalesce(phone,      '')) = '' then v_roster_phone else phone      end,
             updated_at = now()
       where id = auth.uid();

      insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
      values (
        v_invite.club_id,
        auth.uid(),
        'claim_roster_member',
        'roster_member',
        v_roster_id,
        jsonb_build_object('invite_id', v_invite.id)
      );
    end if;
  end if;

  return jsonb_build_object(
    'club_id',   v_invite.club_id,
    'role',      v_invite.role,
    'club_name', v_club.name
  );
end;
$$;

revoke execute on function public.accept_club_invite(text) from public, anon;
grant  execute on function public.accept_club_invite(text) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration is created
-- in this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- Rolling back 0084 must NOT roll back 0081, 0082, or 0083. To revert in
-- place, CREATE OR REPLACE FUNCTION public.accept_club_invite(text) back to
-- its pre-0084 body (full text in migration 0067_add_and_invite.sql,
-- search-path setting from 0068_harden_phase22_function_search_path.sql —
-- the two combined are the exact pre-0084 definition). This restores the
-- `already_in_club` hard rejection and removes 'already_member'/
-- 'membership_state_conflict' as reachable error outcomes. No schema object
-- (club_memberships, profiles.active_club_id, any 0081 trigger, any 0082
-- helper) is touched by this migration or needs any rollback action of its
-- own. Any club_memberships rows already created via the new flow before a
-- rollback remain valid, authoritative membership rows — reverting the RPC
-- body does not retroactively invalidate them.
