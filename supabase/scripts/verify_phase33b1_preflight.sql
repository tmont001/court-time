-- verify_phase33b1_preflight.sql
-- Phase 33B1: Stable Member Identity Foundation — PRE-migration preflight.
--
-- Run in the Supabase SQL Editor BEFORE applying
-- supabase/migrations/0107_roster_identity_foundation.sql. Every query below
-- is a standalone, independent SELECT — no INSERT/UPDATE/DELETE, no DDL, no
-- temporary tables — strictly read-only, safe to run against production.
--
-- ██  DO NOT APPLY 0107 IF SECTION A SHOWS ANY D_CONFLICT ROWS.  ██
-- ██  Resolve every row in Section B's detail listing by hand, then        ██
-- ██  re-run this whole script until Section A's D_CONFLICT count is 0.   ██
--
-- Classification mirrors migration 0107's Section 3 guard and
-- docs/DESIGN_phase33b.md §13 exactly, so a clean preflight guarantees the
-- migration's own independent fail-closed check will also pass.
--
-- Sensitive-data note: these queries select auth.users.email only — never
-- any other auth.users column (no password hash, MFA secret, provider
-- token, etc.) — the minimum needed for an operator to recognize which
-- person a conflict concerns.
--
-- Each section below repeats the same classification CTE chain independently
-- (rather than sharing a temp table) specifically so nothing here writes
-- anything, even transiently, to the database.
--
-- Post-review correction: name_corroborated is now computed with explicit
-- null-safe short-circuiting plus coalesce(...,false), and every consumer
-- tests `is true` / `is not true` rather than a bare boolean — a prior
-- draft could silently classify a real conflict as neither B nor D due to
-- SQL three-valued NULL logic. See 0107's "NULL-SAFETY CORRECTION" header
-- comment for the full worked truth table.
--
-- SUPERSEDED note: an earlier revision of this script flagged invite
-- creation (Send Invite / Resend / bulk Generate Invite Links) as an
-- unclosed, database-unfixable gap. That gap is now closed: club_invites
-- creation is roster-first (0107 Section 2 — create_club_invite requires an
-- existing roster identity; resend_club_invite refuses to perpetuate an
-- invite with none), and accept_club_invite (0107 Section 3) independently
-- RAISEs no_roster_identity/roster_identity_conflict rather than creating a
-- membership without one, regardless of how the invite was created. The
-- ONE remaining risk is historical: invites already sitting in club_invites
-- from BEFORE this migration. Section E below surfaces those explicitly —
-- resolve them (revoke and recreate via the roster-first workflow) before
-- applying 0107, per Section F's explicit READY/NOT READY flag.

-- ── A. Summary counts by classification ─────────────────────────────────────
with membership_identity as (
  select
    cm.club_id, cm.user_id,
    lower(trim(u.email))              as v_email,
    nullif(btrim(p.first_name), '')   as v_first_name,
    nullif(btrim(p.last_name),  '')   as v_last_name
  from public.club_memberships cm
  join public.profiles p  on p.id = cm.user_id
  join auth.users u       on u.id = cm.user_id
  -- No removed_at filter: every membership is classified, including removed
  -- ones — historical activity must resolve to the same stable identity
  -- even after a membership is later removed.
),
candidates as (
  select mi.*,
    exists (
      select 1 from public.roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by = mi.user_id
    ) as is_already_linked,
    exists (
      select 1 from public.roster_members rm
       where rm.club_id     = mi.club_id
         and rm.claimed_by  is not null
         and rm.claimed_by <> mi.user_id
         and lower(rm.email) = mi.v_email
    ) as claimed_by_other_user,
    (select rm.id from public.roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by is null
         and lower(rm.email) = mi.v_email) as email_candidate_id,
    (select nullif(btrim(rm.first_name), '') from public.roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by is null
         and lower(rm.email) = mi.v_email) as candidate_first_name,
    (select nullif(btrim(rm.last_name), '') from public.roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by is null
         and lower(rm.email) = mi.v_email) as candidate_last_name
  from membership_identity mi
),
scored as (
  select c.*,
    -- NULL-safe by construction (matches 0107 Sections 3/4 exactly — see
    -- that migration's "NULL-SAFETY CORRECTION" header comment for the
    -- worked truth table this fixes): each field-level clause short-
    -- circuits to a deterministic FALSE, never NULL, when one side is
    -- populated and the other is null. coalesce(...,false) is a second,
    -- redundant safety layer.
    coalesce(
      ( (candidate_first_name is null
         or (c.v_first_name is not null and lower(candidate_first_name) = lower(c.v_first_name)))
        and (candidate_last_name is null
         or (c.v_last_name is not null and lower(candidate_last_name) = lower(c.v_last_name)))
      ),
      false
    ) as name_corroborated
  from candidates c
),
classified as (
  select s.*,
    case
      when s.is_already_linked                                      then 'A_ALREADY_LINKED'
      when s.claimed_by_other_user                                   then 'D_CONFLICT'
      when s.email_candidate_id is not null and s.name_corroborated is true then 'B_SAFE_AUTO_LINK'
      when s.email_candidate_id is not null                          then 'D_CONFLICT'
      when s.v_first_name is null or s.v_last_name is null           then 'D_CONFLICT'
      else 'C_CREATE_NEW'
    end as classification,
    case
      when s.is_already_linked                                      then null
      when s.claimed_by_other_user                                   then 'claimed_by_other_user'
      when s.email_candidate_id is not null and s.name_corroborated is true then null
      when s.email_candidate_id is not null                          then 'email_name_mismatch'
      when s.v_first_name is null or s.v_last_name is null           then 'missing_required_name'
      else null
    end as conflict_reason
  from scored s
)
select classification, conflict_reason, count(*) as row_count
from classified
group by classification, conflict_reason
order by classification, conflict_reason nulls first;
-- Expect for a clean, apply-ready state: classification is one of
-- A_ALREADY_LINKED / B_SAFE_AUTO_LINK / C_CREATE_NEW only — zero rows with
-- classification = 'D_CONFLICT'. Any D_CONFLICT row here means 0107 MUST NOT
-- be applied yet.

-- ── B. Detail rows for every D_CONFLICT — resolve each by hand ─────────────
with membership_identity as (
  select
    cm.id as membership_id, cm.club_id, cm.user_id, cm.removed_at,
    u.email                           as v_email_raw,
    lower(trim(u.email))              as v_email,
    nullif(btrim(p.first_name), '')   as v_first_name,
    nullif(btrim(p.last_name),  '')   as v_last_name
  from public.club_memberships cm
  join public.profiles p  on p.id = cm.user_id
  join auth.users u       on u.id = cm.user_id
),
candidates as (
  select mi.*,
    exists (
      select 1 from public.roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by = mi.user_id
    ) as is_already_linked,
    (select rm.id from public.roster_members rm
       where rm.club_id     = mi.club_id
         and rm.claimed_by  is not null
         and rm.claimed_by <> mi.user_id
         and lower(rm.email) = mi.v_email) as other_claim_roster_id,
    (select rm.id from public.roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by is null
         and lower(rm.email) = mi.v_email) as email_candidate_id,
    (select nullif(btrim(rm.first_name), '') from public.roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by is null
         and lower(rm.email) = mi.v_email) as candidate_first_name,
    (select nullif(btrim(rm.last_name), '') from public.roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by is null
         and lower(rm.email) = mi.v_email) as candidate_last_name
  from membership_identity mi
),
scored as (
  select c.*,
    -- NULL-safe by construction (matches 0107 Sections 3/4 exactly — see
    -- that migration's "NULL-SAFETY CORRECTION" header comment for the
    -- worked truth table this fixes): each field-level clause short-
    -- circuits to a deterministic FALSE, never NULL, when one side is
    -- populated and the other is null. coalesce(...,false) is a second,
    -- redundant safety layer.
    coalesce(
      ( (candidate_first_name is null
         or (c.v_first_name is not null and lower(candidate_first_name) = lower(c.v_first_name)))
        and (candidate_last_name is null
         or (c.v_last_name is not null and lower(candidate_last_name) = lower(c.v_last_name)))
      ),
      false
    ) as name_corroborated
  from candidates c
)
select
  membership_id,
  club_id,
  user_id           as authenticated_profile_id,
  v_email_raw       as authenticated_email,
  v_first_name      as profile_first_name,
  v_last_name       as profile_last_name,
  removed_at        as membership_removed_at,
  case
    when other_claim_roster_id is not null                    then 'claimed_by_other_user'
    when email_candidate_id is not null and name_corroborated is not true then 'email_name_mismatch'
    when v_first_name is null or v_last_name is null           then 'missing_required_name'
  end as conflict_reason,
  other_claim_roster_id   as conflicting_roster_id_claimed_by_other_user,
  email_candidate_id      as conflicting_roster_id_email_match,
  candidate_first_name    as conflicting_roster_first_name,
  candidate_last_name     as conflicting_roster_last_name
from scored
where not is_already_linked
  and (
    other_claim_roster_id is not null
    or (email_candidate_id is not null and name_corroborated is not true)
    or (email_candidate_id is null and (v_first_name is null or v_last_name is null))
  )
order by club_id, user_id;
-- Expect: zero rows. Every row returned here needs a manual decision before
-- 0107 can be applied:
--   • claimed_by_other_user  -> confirm whether the existing roster row's
--     claimed_by is stale/wrong (correct it via admin tooling) or the two
--     people genuinely share an email (a data problem outside this
--     migration's scope — resolve the email collision first).
--   • email_name_mismatch    -> confirm whether the unclaimed roster row and
--     the authenticated profile are the same person (if so, correct
--     whichever name is wrong so the corroboration check can pass on
--     re-run) or genuinely different people who happen to share an email
--     (leave unlinked and resolve the email collision separately — this
--     migration will not guess).
--   • missing_required_name  -> backfill profiles.first_name/last_name for
--     this user before re-running (roster_members.first_name/last_name are
--     NOT NULL; this migration will not fabricate a placeholder name).

-- ── C. Per-club distribution (informational only, not pass/fail) ───────────
with membership_identity as (
  select
    cm.club_id, cm.user_id,
    lower(trim(u.email))              as v_email,
    nullif(btrim(p.first_name), '')   as v_first_name,
    nullif(btrim(p.last_name),  '')   as v_last_name
  from public.club_memberships cm
  join public.profiles p  on p.id = cm.user_id
  join auth.users u       on u.id = cm.user_id
),
candidates as (
  select mi.*,
    exists (
      select 1 from public.roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by = mi.user_id
    ) as is_already_linked,
    exists (
      select 1 from public.roster_members rm
       where rm.club_id     = mi.club_id
         and rm.claimed_by  is not null
         and rm.claimed_by <> mi.user_id
         and lower(rm.email) = mi.v_email
    ) as claimed_by_other_user,
    (select rm.id from public.roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by is null
         and lower(rm.email) = mi.v_email) as email_candidate_id,
    (select nullif(btrim(rm.first_name), '') from public.roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by is null
         and lower(rm.email) = mi.v_email) as candidate_first_name,
    (select nullif(btrim(rm.last_name), '') from public.roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by is null
         and lower(rm.email) = mi.v_email) as candidate_last_name
  from membership_identity mi
),
scored as (
  select c.*,
    -- NULL-safe by construction (matches 0107 Sections 3/4 exactly — see
    -- that migration's "NULL-SAFETY CORRECTION" header comment for the
    -- worked truth table this fixes): each field-level clause short-
    -- circuits to a deterministic FALSE, never NULL, when one side is
    -- populated and the other is null. coalesce(...,false) is a second,
    -- redundant safety layer.
    coalesce(
      ( (candidate_first_name is null
         or (c.v_first_name is not null and lower(candidate_first_name) = lower(c.v_first_name)))
        and (candidate_last_name is null
         or (c.v_last_name is not null and lower(candidate_last_name) = lower(c.v_last_name)))
      ),
      false
    ) as name_corroborated
  from candidates c
),
classified as (
  select s.*,
    case
      when s.is_already_linked                                      then 'A_ALREADY_LINKED'
      when s.claimed_by_other_user                                   then 'D_CONFLICT'
      when s.email_candidate_id is not null and s.name_corroborated is true then 'B_SAFE_AUTO_LINK'
      when s.email_candidate_id is not null                          then 'D_CONFLICT'
      when s.v_first_name is null or s.v_last_name is null           then 'D_CONFLICT'
      else 'C_CREATE_NEW'
    end as classification
  from scored s
)
select club_id, classification, count(*) as row_count
from classified
group by club_id, classification
order by club_id, classification;

-- ── D. Backfill readiness flag (club_memberships classification only —
--      see Section F below for the COMBINED readiness flag including
--      Section E's legacy-invite check) ────────────────────────────────────
with membership_identity as (
  select
    cm.club_id, cm.user_id,
    lower(trim(u.email))              as v_email,
    nullif(btrim(p.first_name), '')   as v_first_name,
    nullif(btrim(p.last_name),  '')   as v_last_name
  from public.club_memberships cm
  join public.profiles p  on p.id = cm.user_id
  join auth.users u       on u.id = cm.user_id
),
candidates as (
  select mi.*,
    exists (
      select 1 from public.roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by = mi.user_id
    ) as is_already_linked,
    exists (
      select 1 from public.roster_members rm
       where rm.club_id     = mi.club_id
         and rm.claimed_by  is not null
         and rm.claimed_by <> mi.user_id
         and lower(rm.email) = mi.v_email
    ) as claimed_by_other_user,
    (select rm.id from public.roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by is null
         and lower(rm.email) = mi.v_email) as email_candidate_id,
    (select nullif(btrim(rm.first_name), '') from public.roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by is null
         and lower(rm.email) = mi.v_email) as candidate_first_name,
    (select nullif(btrim(rm.last_name), '') from public.roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by is null
         and lower(rm.email) = mi.v_email) as candidate_last_name
  from membership_identity mi
),
scored as (
  select c.*,
    -- NULL-safe by construction (matches 0107 Sections 3/4 exactly — see
    -- that migration's "NULL-SAFETY CORRECTION" header comment for the
    -- worked truth table this fixes): each field-level clause short-
    -- circuits to a deterministic FALSE, never NULL, when one side is
    -- populated and the other is null. coalesce(...,false) is a second,
    -- redundant safety layer.
    coalesce(
      ( (candidate_first_name is null
         or (c.v_first_name is not null and lower(candidate_first_name) = lower(c.v_first_name)))
        and (candidate_last_name is null
         or (c.v_last_name is not null and lower(candidate_last_name) = lower(c.v_last_name)))
      ),
      false
    ) as name_corroborated
  from candidates c
),
classified as (
  select s.*,
    case
      when s.is_already_linked                                      then 'A_ALREADY_LINKED'
      when s.claimed_by_other_user                                   then 'D_CONFLICT'
      when s.email_candidate_id is not null and s.name_corroborated is true then 'B_SAFE_AUTO_LINK'
      when s.email_candidate_id is not null                          then 'D_CONFLICT'
      when s.v_first_name is null or s.v_last_name is null           then 'D_CONFLICT'
      else 'C_CREATE_NEW'
    end as classification
  from scored s
)
select
  case
    when count(*) filter (where classification = 'D_CONFLICT') = 0
      then 'READY — 0107 may be applied'
    else 'NOT READY — resolve Section B conflicts first, then re-run this script'
  end as preflight_result,
  count(*) filter (where classification = 'D_CONFLICT')       as d_conflict_count,
  count(*) filter (where classification = 'A_ALREADY_LINKED') as already_linked_count,
  count(*) filter (where classification = 'B_SAFE_AUTO_LINK') as safe_auto_link_count,
  count(*) filter (where classification = 'C_CREATE_NEW')     as create_new_count
from classified;

-- ── E. Legacy outstanding invites with no safe roster identity ─────────────
-- CORRECTED: this preflight runs BEFORE 0107 is applied, against the
-- PRE-0107 schema. club_invites.roster_member_id does not exist yet — an
-- earlier draft of this section referenced it and would have failed with a
-- missing-column error on real production data. This section now uses only
-- columns that exist on club_invites today (id, code, club_id, role, email,
-- created_by, expires_at, accepted_at, accepted_by, revoked_at, created_at
-- — see 0031_club_invites.sql). Every invite present before 0107 is
-- necessarily a legacy (email-only-or-unrestricted) invite by definition,
-- since roster_member_id cannot exist yet — there is no "roster-first vs.
-- legacy" distinction to make here at all; every row is evaluated the same
-- way, pre-0107-safe predicate:
--   • email IS NULL         -> unsafe. No stable roster identity can be
--     resolved for an unrestricted invite; after 0107, accept_club_invite
--     would RAISE no_roster_identity for any accepter.
--   • email IS NOT NULL and no exact same-club, unclaimed roster_members
--     row matches the normalized email -> unsafe. Same outcome after 0107.
--   • email IS NOT NULL and an exact same-club unclaimed roster match
--     exists -> NOT preflight-unsafe. After 0107, accept_club_invite will
--     still perform its own real-time fail-closed identity/name checks at
--     the moment someone actually accepts (this preflight cannot pre-run
--     that check — no accepting profile exists yet — and is not required
--     to; it only needs to rule out the cases that are unsafe regardless of
--     who eventually accepts).
--
-- Selects only fields already visible on the invite row plus the
-- destination club's name — no auth.users column beyond the invite's own
-- (optional) email restriction is touched.
select
  ci.id                                          as invite_id,
  ci.code,
  ci.club_id,
  cl.name                                        as club_name,
  ci.email,
  ci.role,
  ci.created_at,
  ci.expires_at,
  case
    when ci.email is null then 'unrestricted_no_identity_possible'
    else 'legacy_email_only_no_roster_match'
  end as unsafe_reason
from public.club_invites ci
join public.clubs cl on cl.id = ci.club_id
where ci.accepted_at is null
  and ci.revoked_at  is null
  and ci.expires_at  > now()
  and (
    ci.email is null
    or not exists (
      select 1 from public.roster_members rm
       where rm.club_id      = ci.club_id
         and rm.claimed_by   is null
         and lower(rm.email) = lower(ci.email)
    )
  )
order by ci.club_id, ci.created_at;
-- Expect: zero rows. Every row here needs a manual decision before 0107 is
-- applied: revoke this invite (revoke_club_invite) and recreate it through
-- Add Member + Invite, or Send Invite on an existing roster member (once
-- that workflow exists post-0107).

-- ── F. Combined apply-readiness flag (backfill AND legacy invites) ─────────
with membership_identity as (
  select cm.club_id, cm.user_id,
    lower(trim(u.email))              as v_email,
    nullif(btrim(p.first_name), '')   as v_first_name,
    nullif(btrim(p.last_name),  '')   as v_last_name
  from public.club_memberships cm
  join public.profiles p  on p.id = cm.user_id
  join auth.users u       on u.id = cm.user_id
),
candidates as (
  select mi.*,
    exists (
      select 1 from public.roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by = mi.user_id
    ) as is_already_linked,
    exists (
      select 1 from public.roster_members rm
       where rm.club_id     = mi.club_id
         and rm.claimed_by  is not null
         and rm.claimed_by <> mi.user_id
         and lower(rm.email) = mi.v_email
    ) as claimed_by_other_user,
    (select rm.id from public.roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by is null
         and lower(rm.email) = mi.v_email) as email_candidate_id,
    (select nullif(btrim(rm.first_name), '') from public.roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by is null
         and lower(rm.email) = mi.v_email) as candidate_first_name,
    (select nullif(btrim(rm.last_name), '') from public.roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by is null
         and lower(rm.email) = mi.v_email) as candidate_last_name
  from membership_identity mi
),
scored as (
  select c.*,
    coalesce(
      ( (candidate_first_name is null
         or (c.v_first_name is not null and lower(candidate_first_name) = lower(c.v_first_name)))
        and (candidate_last_name is null
         or (c.v_last_name is not null and lower(candidate_last_name) = lower(c.v_last_name)))
      ),
      false
    ) as name_corroborated
  from candidates c
),
backfill_d_count as (
  select count(*) as n
  from scored s
  where not s.is_already_linked
    and (
      s.claimed_by_other_user
      or (s.email_candidate_id is not null and s.name_corroborated is not true)
      or (s.email_candidate_id is null and (s.v_first_name is null or s.v_last_name is null))
    )
),
legacy_invite_count as (
  -- Same pre-0107-safe predicate as Section E — no roster_member_id
  -- reference, since that column does not exist until 0107 is applied.
  select count(*) as n
  from public.club_invites ci
  where ci.accepted_at is null
    and ci.revoked_at  is null
    and ci.expires_at  > now()
    and (
      ci.email is null
      or not exists (
        select 1 from public.roster_members rm
         where rm.club_id      = ci.club_id
           and rm.claimed_by   is null
           and lower(rm.email) = lower(ci.email)
      )
    )
)
select
  case
    when bd.n = 0 and li.n = 0
      then 'READY — 0107 may be applied'
    else 'NOT READY — resolve Section B (backfill conflicts) and/or Section E (legacy invites) first, then re-run this script'
  end as combined_preflight_result,
  bd.n as backfill_d_conflict_count,
  li.n as legacy_unsafe_invite_count
from backfill_d_count bd, legacy_invite_count li;
