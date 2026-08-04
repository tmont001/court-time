-- 0102_communications_delivery_identity.sql
-- Phase 31B: Communications Delivery Identity Foundation.
-- Apply in Supabase SQL Editor (cloud only). Additive/compatible — see
-- "Compatibility with the currently deployed app" below. Do not apply until
-- this migration has been reviewed; Phase 31C (app code) is a separate,
-- later checkpoint.
--
-- This is the corrected draft of 0102. Four issues found in the first draft
-- are fixed here (each documented in detail in its own section below):
--   1. get_waitlist_offer_notification_id_for_leave (a "newest matching
--      notification" lookup) is REMOVED. leave_event's waitlist_offer path
--      now gets true exact identity from the mutation chain itself, via a
--      shared internal implementation and a new leave_event_v2 entry point.
--   2. cancel_event's original draft cancelled 'offered' participants
--      BEFORE selecting recipients for the notification insert, silently
--      excluding them. Fixed by capturing the exact affected recipient set
--      before any status mutation runs.
--   3. admin_force_confirm / admin_offer_spot now stamp 'triggered_by' =
--      auth.uid() on their waitlist notifications, so a Pro actor (already
--      authorized to perform these actions) can also fetch delivery
--      context for the notification they just created, without widening
--      access to unrelated Pros.
--   4. advance_waitlist_offer (and the two other internal-only helpers it
--      now shares its identity-passing design with) has EXECUTE revoked
--      from authenticated as well as public/anon — it is never called
--      directly by the app, only from inside other SECURITY DEFINER
--      functions, which retain the ability to call it regardless (see
--      "INTERNAL-ONLY PRIVILEGE" below).
--   5. A new get_waitlist_recipient_email RPC is added: the audit below
--      confirms get_user_email_for_notification cannot resolve a
--      Member-to-Member waitlist_offer recipient's email, the same gap the
--      lesson subsystem already solved for its own domain.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 31A (communications audit) found that `notifications` has exactly one
-- SELECT policy, unchanged since 0009_notifications.sql:
--
--   create policy "own_select" on notifications for select
--     using (user_id = auth.uid());
--
-- Every email/SMS dispatch helper in calendar/actions.ts, admin/events/
-- actions.ts, and admin/settings/actions.ts fetches its notification row via
-- a plain client-side `supabase.from("notifications").select(...)` call —
-- which runs under the caller's own authenticated session (RLS-enforced, not
-- service-role). Whenever the acting user (the Server Action's caller) is
-- not the notification's own `user_id` — i.e. every admin-initiated action,
-- and the leave_event → waitlist_offer peer-notification path — that SELECT
-- silently returns zero rows, the dispatch function's `if (!notification)
-- return;` guard exits early, and no email, no SMS, and no
-- notification_deliveries row are ever written. No error surfaces anywhere.
-- This is true even where the Phase 30 "exact notification_id" fix already
-- shipped (update_member_reservation, update_event): fetching the row by its
-- exact id is still subject to the same `user_id = auth.uid()` filter, so
-- exact identity alone does not fix cross-user delivery — the fetch itself
-- must run as a security-definer lookup, scoped to the specific delivery
-- context, not a broad SELECT.
--
-- The lesson-request subsystem (0069_lesson_requests.sql) independently hit
-- this exact wall and solved it correctly with two narrowly-scoped
-- security-definer RPCs (get_lesson_notification_id, get_lesson_recipient_
-- email), each authorizing by lesson-party membership. That fix is NOT
-- touched by this migration and remains the correct pattern for lessons —
-- and, per section 5 below, is the direct model for this migration's new
-- get_waitlist_recipient_email.
--
-- Why notifications' SELECT RLS is not widened: a broader policy (e.g. "same
-- club" or "admin can read any club notification") would let any
-- authenticated club member or every admin read the full body/metadata of
-- every other member's notifications directly from the client, which is a
-- strictly worse exposure than the current one-row-per-purpose,
-- server-only, security-definer lookups below. RLS on `notifications` stays
-- exactly `user_id = auth.uid()` for both SELECT and UPDATE. Every
-- cross-user read this migration enables goes through a narrowly authorized
-- SECURITY DEFINER function, never a widened policy.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- DESIGN: DOMAIN-SCOPED DELIVERY-CONTEXT RPCs, NOT ONE BROAD LOOKUP
-- ═══════════════════════════════════════════════════════════════════════════
-- A single generalized get_notification_for_dispatch(notification_id) that
-- authorized "any same-club Pro" (or any same-club Admin, for every kind)
-- was considered and rejected: it would let a Pro pull the delivery context
-- of, say, another Pro's lesson dispute or a Member's private reservation
-- edit, just because they share a club — a real widening of exposure versus
-- today's per-workflow reality (Pros currently see nothing of another
-- party's notification at all). Instead this migration adds domain-scoped
-- SECURITY DEFINER RPCs, each accepting an exact notification id (never a
-- kind/time-window/recipient-only lookup) and enforcing its own narrow
-- authorization rule:
--
--   get_reservation_delivery_context(notification_id)
--     recipient (self) always; same-club Admin only for the two
--     Admin-driven kinds (reservation_cancelled_by_admin,
--     reservation_rescheduled); Pro never.
--
--   get_event_delivery_context(notification_id)
--     recipient (self) always; same-club Admin always; a Pro only when
--     events.created_by = caller (creator-Pro, mirroring cancel_event's own
--     existing Pro-ownership check); unrelated Pro denied.
--
--   get_waitlist_delivery_context(notification_id)
--     recipient (self) always; same-club Admin always; otherwise only the
--     exact triggering actor recorded in the notification's own metadata
--     (metadata->>'triggered_by'). That actor may be a Member (leave_event)
--     or a Pro (admin_force_confirm / admin_offer_spot, since those RPCs
--     have always allowed role in ('admin','pro') — see section 3 below).
--     Nobody else, including any other same-club Member or an unrelated
--     Pro, is authorized.
--
--   get_waitlist_recipient_email(notification_id)  -- NEW, section 5
--     same authorization rule as get_waitlist_delivery_context. Resolves
--     auth.users.email for the notification's recipient — the one piece of
--     contact information get_user_email_for_notification cannot supply
--     for a Member-triggered waitlist_offer (see section 5).
--
--   get_announcement_batch_delivery_context(batch_id)
--     same-club Admin only, never a Pro. Scoped to notifications carrying
--     that batch's `announcement_batch_id` in metadata, filtered to the
--     caller's own club_id in the query itself — a foreign club's batch id
--     simply returns zero rows rather than raising, so existence is never
--     disclosed cross-club.
--
-- Every new RPC uses current_user_club_id()/current_user_role() (0082) to
-- resolve the CALLER's own club/role — the active-membership-aware helpers
-- — rather than reading profiles.club_id/role directly. This is safe and
-- correct for brand-new functions with no legacy caller to preserve. The
-- EXISTING mutation RPCs modified below (admin_cancel_reservation's clone,
-- cancel_event, send_announcement's clone, leave_event and its internal
-- implementation, admin_force_confirm, admin_offer_spot,
-- advance_waitlist_offer, expire_stale_offers_for_event) intentionally keep
-- reading profiles.club_id/role directly, exactly as they always have —
-- Phase 26 (0083) already documented that this remains correct only because
-- 0081's compatibility triggers keep profiles.club_id/role synchronized
-- with the active membership, and changing that posture is out of scope
-- for a delivery-identity migration.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. EXACT LEAVE_EVENT IDENTITY DESIGN (replaces the removed resolver)
-- ═══════════════════════════════════════════════════════════════════════════
-- The first draft of this migration added
-- get_waitlist_offer_notification_id_for_leave(event_id, recipient_user_id),
-- justified as "deterministic, not a race-prone latest-of-many" because
-- advance_waitlist_offer's idempotency guard limits an event to at most one
-- live offer at a time. That justification does not hold up: it is still an
-- `order by created_at desc limit 1` query — a newest-matching-notification
-- lookup by another name, exactly the pattern this whole migration exists
-- to eliminate. It has been deleted outright. No created_at window,
-- newest-row query, kind-only lookup, or event+recipient post-hoc lookup
-- remains anywhere in this migration.
--
-- The real fix requires threading exact identity through the actual call
-- chain leave_event triggers, because a confirmed Member leaving can cause
-- an offer via EITHER of two different paths in the same transaction:
--   (a) leave_event calls expire_stale_offers_for_event first, which may
--       itself advance the queue internally (if it expired a stale offer
--       and a slot is now free) — see 0049_waitlist_offer_rpcs.sql lines
--       130-178, "Only advance the queue if we actually freed a slot via
--       expiry."
--   (b) leave_event's own direct call to advance_waitlist_offer, which is a
--       no-op (returns no identity) if (a) already created the one
--       permitted active offer, thanks to advance_waitlist_offer's own
--       idempotency guard.
-- The original leave_event body never trusted either return value for this
-- reason — it re-queried "whoever is currently offered" after both calls.
-- That re-query is itself imprecise (in a narrow concurrent-action edge
-- case it can return an unrelated, pre-existing offer untouched by this
-- call) and, more importantly, gives no notification id at all.
--
-- Fix: both expire_stale_offers_for_event and advance_waitlist_offer are
-- changed to return the exact {offered_profile_id, notification_id} pair
-- they themselves created (nulls if they created nothing), and both gain a
-- trailing p_actor_id uuid default null parameter, threaded from
-- auth.uid() at the leave_event call site. A private, security-definer
-- implementation, _leave_event_impl(event_id), holds the ONE copy of the
-- full leave_event business logic (guards, participant-status update, the
-- expire-then-advance sequence, audit_log write), calls both helpers,
-- coalesces to whichever one actually produced a non-null
-- offered_profile_id (only one can, by construction of the idempotency
-- guard), and returns that exact pair — no re-query of any kind.
--
-- Two public entry points call _leave_event_impl and share its single
-- implementation, so old and new consumers execute identical business
-- rules with zero drift:
--   leave_event(p_event_id uuid) returns uuid                 -- UNCHANGED
--     Deployed contract preserved exactly: extracts and returns only
--     offered_profile_id, byte-for-byte the same value the old
--     post-hoc-query version would return in every case that matters
--     (single confirmed/offered Member leaving with at most one
--     concurrent waitlist action in flight — the only case the currently
--     deployed app's dispatch helpers exercise). The narrow edge case
--     where the old re-query could return an unrelated pre-existing
--     offer's profile_id (untouched by this call) is not reproduced —
--     that was never a notification this call caused, and the existing
--     email_already_delivered duplicate-send guard already prevented it
--     from ever producing a second real delivery. Existing callers
--     (calendar/actions.ts's leaveEvent) require zero code changes.
--   leave_event_v2(p_event_id uuid) returns jsonb                -- NEW
--     { offered_profile_id: uuid | null, notification_id: uuid | null }
--     Phase 31C will switch the Server Action to this entry point once
--     the dispatch helpers are rewritten to use get_waitlist_delivery_
--     context / get_waitlist_recipient_email with this exact id, instead
--     of any client-side notifications query.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 2. CANCEL_EVENT OFFERED-RECIPIENT CORRECTION
-- ═══════════════════════════════════════════════════════════════════════════
-- The first draft's cancel_event ran, in this order: (i) UPDATE
-- event_participants SET status='cancelled' WHERE status='offered', then
-- (ii) INSERT ... SELECT ... FROM event_participants WHERE status IN
-- ('confirmed','waitlisted','offered'). By the time (ii) ran, every row
-- that had been 'offered' was already 'cancelled' from (i), so the WHERE
-- clause in (ii) could never match an offered participant — they silently
-- received no event_cancelled notification and therefore no email/SMS,
-- reproducing exactly the class of silent-delivery-loss bug this whole
-- migration exists to fix, this time self-inflicted by ordering.
--
-- Fixed by capturing the exact affected profile_id set — everyone
-- confirmed, waitlisted, or offered — into an array BEFORE any
-- event_participants status mutation runs, then driving the notification
-- INSERT from that captured array via unnest(), not from a live re-query
-- of event_participants.status after it has changed. event_participants
-- has at most one row per (event_id, profile_id) (every join/offer/promote
-- path in this schema upserts on that pair), so array_agg(profile_id) over
-- this pre-mutation snapshot cannot contain duplicates and each of
-- confirmed/waitlisted/offered participants receives exactly one
-- notification, matching the pre-existing intended behavior (18A's
-- addition of 'offered' to this notification set) for the first time
-- since 18A shipped it. All other cancel_event behavior — event/
-- reservation/participant mutation, audit_log action name and metadata,
-- creator-Pro authorization (v_event.created_by check) — is unchanged.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 3. PRO-TRIGGERED WAITLIST AUTHORIZATION
-- ═══════════════════════════════════════════════════════════════════════════
-- admin_force_confirm and admin_offer_spot have always allowed
-- `v_actor.role in ('admin', 'pro')` — that authorization is NOT changed by
-- this migration. What was missing is that a Pro who legitimately performs
-- either action had no way to subsequently fetch delivery context for the
-- waitlist notification they just created: get_waitlist_delivery_context's
-- rule set (recipient / same-club Admin / exact triggered_by actor) had no
-- triggered_by to check, since neither RPC stamped one. Both now insert
-- 'triggered_by', auth.uid() into the notification's metadata
-- unconditionally (harmless when the actor is an Admin, who is already
-- separately and always authorized; load-bearing when the actor is a Pro).
-- This lets the specific Pro who ran the action dispatch its notification,
-- without granting any OTHER, unrelated Pro access to it — the same
-- narrow-actor model leave_event already uses.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 4. INTERNAL-ONLY PRIVILEGE CORRECTION
-- ═══════════════════════════════════════════════════════════════════════════
-- grep across every src/**/*.ts confirms advance_waitlist_offer and
-- expire_stale_offers_for_event are never called via supabase.rpc(...) —
-- only leave_event is (calendar/actions.ts:858). Both helpers, plus the new
-- _leave_event_impl, are purely internal: called only via `perform` or
-- `select ... into` from inside OTHER SECURITY DEFINER functions in this
-- same schema. All three now have EXECUTE revoked from public, anon, AND
-- authenticated — not granted back to authenticated at all.
--
-- This does not break their internal callers. Postgres evaluates privilege
-- checks for a function called from inside a SECURITY DEFINER function
-- against that function's OWNER, not the original invoking role — and the
-- owner (whichever role ran this migration, e.g. postgres/supabase_admin
-- in the SQL Editor) implicitly has EXECUTE on every function it owns
-- regardless of GRANT/REVOKE state. Every existing call site of
-- advance_waitlist_offer / expire_stale_offers_for_event (leave_event,
-- admin_remove_participant, decline_waitlist_offer, mark_attendance,
-- set_event_member_joinable, admin_expire_offer, update_event, and others —
-- none of which this migration touches) is itself SECURITY DEFINER, so
-- every one of those internal calls continues to succeed unchanged.
--
-- The actor identity these helpers stamp into notification metadata is
-- never client-supplied: p_actor_id is populated exclusively from
-- auth.uid() inside a trusted, already-authenticated, SECURITY DEFINER
-- caller (_leave_event_impl). No public entry point accepts an arbitrary
-- actor id as a parameter.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 5. WAITLIST RECIPIENT-CONTACT RESOLUTION
-- ═══════════════════════════════════════════════════════════════════════════
-- Inspected: sendEmailNotification (src/lib/email.ts), get_user_email_for_
-- notification (0055_expand_notification_preferences.sql), the waitlist SMS
-- recipient lookup (dispatchWaitlistOfferSms in calendar/actions.ts), and
-- the leave_event email/SMS dispatch path.
--
-- Email: get_user_email_for_notification's authorization is "caller is the
-- notification recipient OR has role admin/pro" (0055, unchanged by this
-- migration). In the leave_event scenario, the caller is a Member (not
-- admin, not pro) and the recipient is a DIFFERENT Member — this
-- authorization denies the call and returns null. Confirmed: a Member who
-- leaves an event cannot resolve the offered Member's email through the
-- existing helper. Fixed with get_waitlist_recipient_email (Section A4
-- below), modeled directly on the lesson subsystem's get_lesson_recipient_
-- email (0069_lesson_requests.sql): exact notification id in; kind
-- restricted to waitlist_offer/waitlist_promoted; same club_id required;
-- authorized only for the recipient, a same-club Admin, or the exact
-- triggered_by actor (Member or Pro) recorded on that notification —
-- identical to get_waitlist_delivery_context's rule; returns only
-- auth.users.email, nothing else.
--
-- SMS (REVISED — this section originally concluded profiles' same-club RLS
-- was an acceptable basis for SMS contact resolution and needed no new RPC.
-- That is corrected here): profiles_select_same_club (0082) — `id =
-- auth.uid() or club_id = current_user_club_id()` — does let any
-- authenticated same-club user read any other same-club profile's
-- phone/sms_opt_in today, so dispatchWaitlistOfferSms's raw
-- `.from("profiles").select("sms_opt_in, phone").eq("id", offeredProfileId)`
-- does not currently fail. But that broad row visibility is not the target
-- communications architecture this migration is building: every OTHER
-- cross-user contact/context read in this migration goes through a
-- narrowly-scoped, exact-identity, SECURITY DEFINER RPC, specifically so
-- dispatch does not depend on incidentally-broad table RLS that exists for
-- unrelated reasons (roster visibility, not communications). Riding on that
-- broad policy here would leave the waitlist SMS path as the one exception
-- to this migration's own design principle, and would silently break (or
-- silently need a redesign) the moment profiles_select_same_club is ever
-- narrowed for unrelated privacy reasons — which Phase 31A's own
-- compliance/safety findings flag as a plausible future direction.
--
-- Fixed with get_waitlist_recipient_sms_contact (Section A5 below), the
-- same authorization rule as get_waitlist_delivery_context / get_waitlist_
-- recipient_email (recipient / same-club Admin / exact triggered_by
-- actor), returning only `phone` and `sms_opt_in` — no other profile
-- column. Phase 31C must replace dispatchWaitlistOfferSms's raw profiles
-- query with this RPC; see "EXACT RESULT CONTRACTS" below. This migration
-- does NOT change profiles_select_same_club or any other profiles RLS
-- policy — broader profiles-visibility hardening is an explicitly separate,
-- deferred privacy concern; this section only stops the new communications
-- dispatch architecture from being built on top of that broad access.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 6. NOTIFICATION METADATA TRUST BOUNDARY (UPDATE PRIVILEGE HARDENING)
-- ═══════════════════════════════════════════════════════════════════════════
-- Every delivery-context and recipient-contact RPC added by this migration
-- trusts values read directly off notifications.metadata — event_id
-- (get_event_delivery_context), triggered_by (get_waitlist_delivery_
-- context, get_waitlist_recipient_email, get_waitlist_recipient_sms_
-- contact), and announcement_batch_id (get_announcement_batch_delivery_
-- context). Before trusting that, this migration verifies the recipient
-- cannot rewrite those values.
--
-- notifications' only UPDATE policy, own_update (0009_notifications.sql,
-- unchanged since):
--   using (user_id = auth.uid()) with check (user_id = auth.uid())
-- restricts which ROWS may be updated (only the caller's own), but RLS
-- USING/WITH CHECK clauses do not restrict which COLUMNS may be written.
-- No migration in this repository's history has ever issued a REVOKE or a
-- column-scoped GRANT against notifications — grep confirms zero matches
-- for `grant`/`revoke` combined with `notifications` anywhere in
-- supabase/migrations/ prior to this one. Supabase provisions every
-- public-schema table with table-wide `GRANT ALL` (full-column SELECT/
-- INSERT/UPDATE/DELETE) to `anon` and `authenticated` at project-creation
-- time, as a platform default outside this repository's migration history
-- entirely — that default is never overridden here. The conclusion,
-- verified against every piece of migration evidence available (the
-- absence of any restricting grant/revoke, plus the platform default that
-- would otherwise apply): an authenticated recipient can, today, issue an
-- update against their own notification row that sets kind, body,
-- metadata, club_id, or any other column, not only is_read — because both
-- the row-level RLS check and the table-level grant permit it. created_at
-- has no default-preventing constraint either, though its practical value
-- to a forger is low compared to metadata/kind/club_id.
--
-- This directly threatens the authorization design above: a recipient
-- could rewrite their own waitlist_offer notification's metadata to set
-- triggered_by to their own id (redundant — they're already the recipient)
-- or, more usefully, forge event_id on an event_cancelled/event_joined/
-- event_updated notification to claim creator-Pro standing over an
-- unrelated event, or forge announcement_batch_id to attach their row to
-- another club's batch for get_announcement_batch_delivery_context (though
-- that RPC's own club_id filter independently blocks any cross-club
-- benefit from this specific forgery).
--
-- Hardened (Section I, near the end of this migration) to the minimum the
-- deployed app actually needs: grep confirms NotificationSheet.tsx's two
-- writes — `update({is_read: true})` for a single row, and for mark-all-
-- read — are the ONLY client writes to this table anywhere in src/.
--   revoke update on notifications from anon, authenticated, public;
--   grant  update (is_read) on notifications to authenticated;
-- No trigger is added — Postgres column-level privileges are enforced by
-- PostgREST's underlying SQL UPDATE exactly as for any direct SQL client,
-- which is sufficient and is Supabase's own documented pattern for
-- column-scoped write access; a trigger would be a redundant second
-- enforcement mechanism for the same boundary. Security-definer INSERTs
-- (every notification-creating RPC in this codebase, including all new
-- ones in this migration) are unaffected: SECURITY DEFINER functions
-- execute with the owning role's privileges, not the invoking role's
-- grants, so this REVOKE/GRANT change to `authenticated` never constrains
-- them.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 7. METADATA TRUST INVARIANT (holds after this migration)
-- ═══════════════════════════════════════════════════════════════════════════
-- Notification identity and authorization metadata (club_id, user_id, kind,
-- metadata — event_id / triggered_by / announcement_batch_id within it) is
-- written only by trusted SECURITY DEFINER mutation functions at INSERT
-- time and cannot be altered afterward by the notification recipient or
-- any other authenticated user. The only column any authenticated user can
-- write, on any notification row, is is_read — and, per own_update RLS,
-- only on their own row. This protects:
--   get_event_delivery_context's event_id-derived creator-Pro authorization;
--   get_waitlist_delivery_context's triggered_by authorization;
--   get_waitlist_recipient_email's triggered_by authorization;
--   get_waitlist_recipient_sms_contact's triggered_by authorization;
--   get_announcement_batch_delivery_context's announcement_batch_id
--     integrity (defense in depth — that RPC's own club_id filter already
--     independently prevents cross-club disclosure regardless).
-- Without Section I's privilege hardening, this invariant would not hold
-- and every one of the above authorization rules would be forgeable by the
-- recipient of the row being forged.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EXACT NOTIFICATION IDENTITY FROM MUTATION RPCs
-- ═══════════════════════════════════════════════════════════════════════════
-- update_member_reservation (0097) and update_event (0099) already return
-- jsonb bundles including exact notification_id(s) — neither is touched by
-- this migration; they are the precedent this migration extends elsewhere.
--
-- Mutation RPCs addressed:
--
--   admin_cancel_reservation  — return shape (reservations row) IS consumed
--     directly by the deployed app (adminCancelReservation in calendar/
--     actions.ts reads `reservation.owner_user_id` off the raw return).
--     Changing its return type in place would break that until Phase 31C
--     ships. Per the compatibility rule below: a new function,
--     admin_cancel_reservation_v2, is added instead. The original is left
--     completely untouched (not even re-declared) and remains callable
--     exactly as today until 31C cuts the Server Action over.
--
--   send_announcement  — return shape (bare integer recipient count) IS
--     consumed directly (`recipientCount ?? 0`, interpolated into the
--     confirmation message and returned to the UI). Same treatment: a new
--     function, send_announcement_v2, is added; the original is untouched.
--
--   cancel_event, admin_force_confirm, admin_offer_spot  — verified against
--     every current call site (admin/events/actions.ts, calendar/
--     actions.ts): all three call these RPCs and read only `{ error }` from
--     the result; the `data` payload is discarded unconditionally in the
--     currently deployed code. Changing their return type is therefore safe
--     under the same name — no deployed caller depends on the old shape.
--     Each is explicitly DROPped (Postgres does not allow CREATE OR REPLACE
--     to change a function's return type) and recreated under the identical
--     name and input signature, now returning a jsonb bundle that includes
--     exact notification identity.
--
--   leave_event  — see section 1 above. External signature and return type
--     are completely unchanged; a new leave_event_v2 carries exact
--     identity for Phase 31C.
--
--   advance_waitlist_offer, expire_stale_offers_for_event  — internal
--     helpers (see section 4), confirmed to have their return values
--     discarded at every one of their existing call sites (all `perform`).
--     Both explicitly DROPped and recreated with one new trailing
--     parameter, p_actor_id uuid default null, so every existing call site
--     (none of which are touched by this migration) continues to compile
--     and behave identically, defaulting p_actor_id to null. Both also
--     change return type from their original (uuid / void) to jsonb,
--     since nothing reads their return value today. Only
--     _leave_event_impl's two call sites pass auth.uid() explicitly and
--     consume the returned identity.
--
-- Bulk mutations (cancel_event, send_announcement_v2) return an exact array
-- of {notification_id, recipient user_id} pairs for every row actually
-- inserted, built via `insert ... returning id, user_id` inside a CTE (or,
-- for cancel_event, via unnest() over a pre-mutation snapshot array — see
-- section 2) — never a post-hoc time-window or kind-only re-query.
--
-- Announcement batch identity: send_announcement_v2 generates one
-- uuid_generate_v4() batch id per call, stores it as
-- metadata->>'announcement_batch_id' on every notification the call
-- creates, and returns it as `batch_id` alongside the exact per-recipient
-- notification list — durable, not a 5-second created_at window.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- FUNCTIONS ADDED, REMOVED, DROPPED, AND RECREATED
-- ═══════════════════════════════════════════════════════════════════════════
-- Explicitly DROPped and recreated (return type or parameter list changed):
--   public.cancel_event(uuid)                              events -> jsonb
--   public.admin_force_confirm(uuid, uuid)          event_participants -> jsonb
--   public.admin_offer_spot(uuid, uuid)             event_participants -> jsonb
--   public.advance_waitlist_offer(uuid,uuid,text)          uuid -> jsonb, +1 param
--   public.expire_stale_offers_for_event(uuid,uuid,text)   void -> jsonb, +1 param
--
-- CREATE OR REPLACE only (signature and return type unchanged):
--   public.leave_event(uuid)                     now delegates to _leave_event_impl
--
-- NEW functions (no prior signature to preserve):
--   public._leave_event_impl(uuid)                   internal only, see section 1
--   public.leave_event_v2(uuid)                       jsonb, see section 1
--   public.get_reservation_delivery_context(uuid)
--   public.get_event_delivery_context(uuid)
--   public.get_waitlist_delivery_context(uuid)
--   public.get_waitlist_recipient_email(uuid)         see section 5
--   public.get_waitlist_recipient_sms_contact(uuid)   NEW, see section 5
--   public.get_announcement_batch_delivery_context(uuid)
--   public.admin_cancel_reservation_v2(uuid)
--   public.send_announcement_v2(text, text)
--
-- REMOVED from this migration's first draft (never applied to any
-- database, so there is nothing to drop in production — it simply does not
-- appear below):
--   public.get_waitlist_offer_notification_id_for_leave(uuid, uuid)
--     — a newest-matching-notification lookup; see section 1.
--
-- TABLE PRIVILEGES CHANGED (not a function — see section 6, Section I):
--   public.notifications — UPDATE revoked (table-wide) from anon,
--   authenticated, public; UPDATE (is_read) re-granted to authenticated.
--   RLS (own_select / own_update) is unchanged; this is a column-privilege
--   change layered on top of the existing row-level policy, not a policy
--   change.
--
-- UNTOUCHED (left exactly as-is, deliberately, for app-deploy-window safety):
--   public.admin_cancel_reservation(uuid)
--   public.send_announcement(text, text)
--   public.update_member_reservation(...)         (0097 precedent)
--   public.update_event(...)                      (0099 precedent)
--   public.cancel_member_reservation(...)          (0097 precedent)
--   every lesson-request RPC and lookup (0069/0072/0073/0078/0101)
--   notifications RLS policies (own_select / own_update, both unchanged —
--     only table/column privileges change, per section 6)
--   profiles RLS policies (unchanged — profiles_select_same_club is
--     deliberately NOT narrowed in this checkpoint; see revised section 5)
--
-- ═══════════════════════════════════════════════════════════════════════════
-- COMPATIBILITY WITH THE CURRENTLY DEPLOYED APP
-- ═══════════════════════════════════════════════════════════════════════════
-- cancel_event / admin_force_confirm / admin_offer_spot: verified safe to
-- change in place (deployed app discards `data`, keeps reading `error`
-- exactly as before — no behavior change for the current app).
-- advance_waitlist_offer / expire_stale_offers_for_event: verified safe —
-- never called directly by the app; every internal caller uses `perform`
-- and discards the return value regardless of its type.
-- leave_event: verified safe — external signature, return type, and return
-- value are unchanged for the case the deployed dispatch helpers rely on.
-- admin_cancel_reservation / send_announcement: left byte-for-byte
-- untouched; the deployed app keeps calling them exactly as today. The new
-- _v2 functions, leave_event_v2, and every delivery-context /
-- recipient-contact RPC are inert additions until Phase 31C's Server
-- Actions are written to call them — this migration alone changes no
-- user-visible behavior in the currently deployed app.
-- notifications UPDATE hardening (section 6, Section I): verified safe —
-- grep confirms is_read is the only column any client write in src/ ever
-- sets on this table (NotificationSheet.tsx, both call sites). Mark-one-
-- read and mark-all-read continue to work unchanged; no other client code
-- writes to notifications at all.
-- All mutation, audit_log, and notification-insert behavior (guard order,
-- error codes raised, audit_log action names and metadata shape, preference
-- gating, notification body text) is preserved verbatim from each
-- function's current deployed definition, except the two corrections
-- documented in sections 2 and 3 above (both are bug fixes to behavior that
-- was never live in production, since nothing in this migration has been
-- applied); only identity-capture and (for new/_v2 functions) grants are
-- otherwise added.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EXACT RESULT CONTRACTS PHASE 31C WILL CONSUME
-- ═══════════════════════════════════════════════════════════════════════════
--   admin_cancel_reservation_v2(p_reservation_id uuid) returns jsonb
--     { reservation: <reservations row>, notification_id: uuid | null }
--
--   cancel_event(p_event_id uuid) returns jsonb
--     { event: <events row>,
--       notifications: [ { notification_id: uuid, user_id: uuid }, ... ] }
--     -- one entry per participant who was confirmed, waitlisted, or
--     -- offered immediately before this call, captured pre-mutation.
--
--   send_announcement_v2(p_title text, p_body text) returns jsonb
--     { batch_id: uuid, recipient_count: int,
--       notifications: [ { notification_id: uuid, user_id: uuid }, ... ] }
--
--   admin_force_confirm(p_event_id uuid, p_profile_id uuid) returns jsonb
--     { participant: <event_participants row>, notification_id: uuid }
--     -- notification metadata includes triggered_by = auth.uid().
--
--   admin_offer_spot(p_event_id uuid, p_profile_id uuid) returns jsonb
--     { participant: <event_participants row>, notification_id: uuid }
--     -- notification metadata includes triggered_by = auth.uid().
--
--   leave_event(p_event_id uuid) returns uuid                    -- UNCHANGED
--     offered participant's profile_id, or null
--
--   leave_event_v2(p_event_id uuid) returns jsonb                     -- NEW
--     { offered_profile_id: uuid | null, notification_id: uuid | null }
--
--   get_reservation_delivery_context(p_notification_id uuid) returns jsonb
--   get_event_delivery_context(p_notification_id uuid)       returns jsonb
--   get_waitlist_delivery_context(p_notification_id uuid)    returns jsonb
--     each: { notification_id, recipient_user_id, club_id, kind, body,
--             metadata } | null (null on any authorization failure)
--
--   get_waitlist_recipient_email(p_notification_id uuid) returns text | null
--
--   get_waitlist_recipient_sms_contact(p_notification_id uuid) returns jsonb | null
--     { phone: text | null, sms_opt_in: boolean }
--     -- Phase 31C MUST replace dispatchWaitlistOfferSms's raw
--     -- `.from("profiles").select("sms_opt_in, phone").eq("id", ...)` query
--     -- with this RPC — see revised section 5 above. Do not carry the raw
--     -- profiles query forward into the rewritten dispatch helper.
--
--   get_announcement_batch_delivery_context(p_batch_id uuid)
--     returns table (notification_id uuid, recipient_user_id uuid, body text)
--     -- zero rows on any authorization failure or foreign-club batch id
--
-- Delivery-log/retry scope: unchanged. notification_deliveries remains the
-- only delivery-attempt log; no new table, queue, outbox, retry, or
-- scheduling infrastructure is added. No service-role application code is
-- introduced — every new function is SECURITY DEFINER, callable only by the
-- `authenticated` role (or, for the internal-only helpers in section 4, by
-- no client role at all), exactly like every existing notification-adjacent
-- RPC in this codebase.


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION A — domain-scoped delivery-context and recipient-contact RPCs
-- ═══════════════════════════════════════════════════════════════════════════

-- ---------------------------------------------------------------------------
-- A1. get_reservation_delivery_context
-- ---------------------------------------------------------------------------
create or replace function public.get_reservation_delivery_context(
  p_notification_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_caller_id   uuid := auth.uid();
  v_caller_club uuid;
  v_caller_role text;
  v_notif       public.notifications%rowtype;
begin
  if v_caller_id is null then return null; end if;

  select public.current_user_club_id(), public.current_user_role()
    into v_caller_club, v_caller_role;
  if v_caller_club is null then return null; end if;

  select * into v_notif from public.notifications where id = p_notification_id;
  if not found then return null; end if;

  -- Domain guard: reject any notification id that isn't a reservation kind.
  if v_notif.kind not in (
    'reservation_confirmed',
    'reservation_cancelled_by_admin',
    'reservation_cancelled_by_member',
    'reservation_rescheduled'
  ) then
    return null;
  end if;

  -- Club isolation.
  if v_notif.club_id is distinct from v_caller_club then return null; end if;

  -- Authorization: recipient always; same-club Admin only for the two
  -- Admin-driven kinds; Pro never.
  if v_caller_id = v_notif.user_id then
    null;
  elsif v_caller_role = 'admin'
        and v_notif.kind in ('reservation_cancelled_by_admin', 'reservation_rescheduled') then
    null;
  else
    return null;
  end if;

  return jsonb_build_object(
    'notification_id',   v_notif.id,
    'recipient_user_id', v_notif.user_id,
    'club_id',            v_notif.club_id,
    'kind',                v_notif.kind,
    'body',                v_notif.body,
    'metadata',              v_notif.metadata
  );
end;
$$;

revoke execute on function public.get_reservation_delivery_context(uuid) from public, anon;
grant  execute on function public.get_reservation_delivery_context(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- A2. get_event_delivery_context
-- ---------------------------------------------------------------------------
create or replace function public.get_event_delivery_context(
  p_notification_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_caller_id   uuid := auth.uid();
  v_caller_club uuid;
  v_caller_role text;
  v_notif       public.notifications%rowtype;
  v_event_id    uuid;
  v_event       public.events%rowtype;
begin
  if v_caller_id is null then return null; end if;

  select public.current_user_club_id(), public.current_user_role()
    into v_caller_club, v_caller_role;
  if v_caller_club is null then return null; end if;

  select * into v_notif from public.notifications where id = p_notification_id;
  if not found then return null; end if;

  if v_notif.kind not in ('event_cancelled', 'event_joined', 'event_updated') then
    return null;
  end if;

  if v_notif.club_id is distinct from v_caller_club then return null; end if;

  if v_caller_id = v_notif.user_id then
    -- recipient, always allowed
    null;
  elsif v_caller_role = 'admin' then
    -- same-club Admin, always allowed
    null;
  elsif v_caller_role = 'pro' then
    -- creator-Pro only — mirrors cancel_event's own Pro-ownership check
    -- (events.created_by = auth.uid()). Unrelated Pro is denied.
    v_event_id := nullif(v_notif.metadata->>'event_id', '')::uuid;
    if v_event_id is null then return null; end if;

    select * into v_event from public.events
      where id = v_event_id and club_id = v_caller_club;
    if not found then return null; end if;

    if v_event.created_by is distinct from v_caller_id then
      return null;
    end if;
  else
    return null;
  end if;

  return jsonb_build_object(
    'notification_id',   v_notif.id,
    'recipient_user_id', v_notif.user_id,
    'club_id',            v_notif.club_id,
    'kind',                v_notif.kind,
    'body',                v_notif.body,
    'metadata',              v_notif.metadata
  );
end;
$$;

revoke execute on function public.get_event_delivery_context(uuid) from public, anon;
grant  execute on function public.get_event_delivery_context(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- A3. get_waitlist_delivery_context
-- Authorizes: recipient; same-club Admin; or the exact triggering actor
-- recorded in metadata->>'triggered_by'. That actor is stamped by
-- advance_waitlist_offer (leave_event's path — a Member) or by
-- admin_force_confirm / admin_offer_spot (an Admin or a Pro — see section 3
-- above; harmless when the actor is an Admin, since same-club Admin is
-- already separately and always authorized).
-- ---------------------------------------------------------------------------
create or replace function public.get_waitlist_delivery_context(
  p_notification_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_caller_id    uuid := auth.uid();
  v_caller_club  uuid;
  v_caller_role  text;
  v_notif        public.notifications%rowtype;
  v_triggered_by uuid;
begin
  if v_caller_id is null then return null; end if;

  select public.current_user_club_id(), public.current_user_role()
    into v_caller_club, v_caller_role;
  if v_caller_club is null then return null; end if;

  select * into v_notif from public.notifications where id = p_notification_id;
  if not found then return null; end if;

  if v_notif.kind not in ('waitlist_offer', 'waitlist_promoted') then
    return null;
  end if;

  if v_notif.club_id is distinct from v_caller_club then return null; end if;

  v_triggered_by := nullif(v_notif.metadata->>'triggered_by', '')::uuid;

  if v_caller_id = v_notif.user_id then
    null;
  elsif v_caller_role = 'admin' then
    null;
  elsif v_triggered_by is not null and v_caller_id = v_triggered_by then
    null;
  else
    return null;
  end if;

  return jsonb_build_object(
    'notification_id',   v_notif.id,
    'recipient_user_id', v_notif.user_id,
    'club_id',            v_notif.club_id,
    'kind',                v_notif.kind,
    'body',                v_notif.body,
    'metadata',              v_notif.metadata
  );
end;
$$;

revoke execute on function public.get_waitlist_delivery_context(uuid) from public, anon;
grant  execute on function public.get_waitlist_delivery_context(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- A4. get_waitlist_recipient_email
-- NEW (section 5). Modeled directly on get_lesson_recipient_email
-- (0069_lesson_requests.sql): get_user_email_for_notification cannot serve
-- this path because it requires the caller to be the recipient or have role
-- admin/pro, and the common case here is Member (leave_event) -> different
-- Member (the offered participant) — neither admin nor pro. Same
-- authorization rule as get_waitlist_delivery_context, applied before the
-- email is revealed. Returns only auth.users.email — no other column, no
-- broader grant, no RLS change.
-- ---------------------------------------------------------------------------
create or replace function public.get_waitlist_recipient_email(
  p_notification_id uuid
)
returns text
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_caller_id    uuid := auth.uid();
  v_caller_club  uuid;
  v_caller_role  text;
  v_notif        public.notifications%rowtype;
  v_triggered_by uuid;
begin
  if v_caller_id is null then return null; end if;

  select public.current_user_club_id(), public.current_user_role()
    into v_caller_club, v_caller_role;
  if v_caller_club is null then return null; end if;

  select * into v_notif from public.notifications where id = p_notification_id;
  if not found then return null; end if;

  if v_notif.kind not in ('waitlist_offer', 'waitlist_promoted') then
    return null;
  end if;

  if v_notif.club_id is distinct from v_caller_club then return null; end if;

  v_triggered_by := nullif(v_notif.metadata->>'triggered_by', '')::uuid;

  if v_caller_id = v_notif.user_id then
    null;
  elsif v_caller_role = 'admin' then
    null;
  elsif v_triggered_by is not null and v_caller_id = v_triggered_by then
    null;
  else
    return null;
  end if;

  return (select email from auth.users where id = v_notif.user_id);
end;
$$;

revoke execute on function public.get_waitlist_recipient_email(uuid) from public, anon;
grant  execute on function public.get_waitlist_recipient_email(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- A5. get_waitlist_recipient_sms_contact
-- NEW (revised section 5). Same authorization rule as
-- get_waitlist_delivery_context / get_waitlist_recipient_email. Does NOT
-- rely on profiles_select_same_club's broad same-club visibility — this is
-- a purpose-built, exact-identity, narrowly-authorized path so waitlist SMS
-- dispatch is architecturally consistent with every other cross-user
-- contact/context read added by this migration, and does not silently
-- depend on unrelated roster-visibility RLS. Returns only phone and
-- sms_opt_in — no other profiles column, no notifications column beyond
-- what's needed to authorize. Phase 31C must replace
-- dispatchWaitlistOfferSms's raw profiles query with this RPC.
-- ---------------------------------------------------------------------------
create or replace function public.get_waitlist_recipient_sms_contact(
  p_notification_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_caller_id    uuid := auth.uid();
  v_caller_club  uuid;
  v_caller_role  text;
  v_notif        public.notifications%rowtype;
  v_triggered_by uuid;
  v_phone        text;
  v_sms_opt_in   boolean;
begin
  if v_caller_id is null then return null; end if;

  select public.current_user_club_id(), public.current_user_role()
    into v_caller_club, v_caller_role;
  if v_caller_club is null then return null; end if;

  select * into v_notif from public.notifications where id = p_notification_id;
  if not found then return null; end if;

  if v_notif.kind not in ('waitlist_offer', 'waitlist_promoted') then
    return null;
  end if;

  if v_notif.club_id is distinct from v_caller_club then return null; end if;

  v_triggered_by := nullif(v_notif.metadata->>'triggered_by', '')::uuid;

  if v_caller_id = v_notif.user_id then
    null;
  elsif v_caller_role = 'admin' then
    null;
  elsif v_triggered_by is not null and v_caller_id = v_triggered_by then
    null;
  else
    return null;
  end if;

  select phone, sms_opt_in into v_phone, v_sms_opt_in
    from public.profiles
    where id = v_notif.user_id;

  return jsonb_build_object('phone', v_phone, 'sms_opt_in', coalesce(v_sms_opt_in, false));
end;
$$;

revoke execute on function public.get_waitlist_recipient_sms_contact(uuid) from public, anon;
grant  execute on function public.get_waitlist_recipient_sms_contact(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- A6. get_announcement_batch_delivery_context
-- Same-club Admin only, never a Pro. Club-scoped in the query itself, so a
-- foreign-club batch id returns zero rows rather than raising — existence
-- is never disclosed cross-club.
-- ---------------------------------------------------------------------------
create or replace function public.get_announcement_batch_delivery_context(
  p_batch_id uuid
)
returns table (
  notification_id   uuid,
  recipient_user_id uuid,
  body              text
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_caller_id   uuid := auth.uid();
  v_caller_club uuid;
  v_caller_role text;
begin
  if v_caller_id is null then return; end if;

  select public.current_user_club_id(), public.current_user_role()
    into v_caller_club, v_caller_role;

  if v_caller_club is null or v_caller_role <> 'admin' then
    return;
  end if;

  return query
    select n.id, n.user_id, n.body
      from public.notifications n
     where n.club_id = v_caller_club
       and n.kind    = 'announcement'
       and (n.metadata->>'announcement_batch_id') = p_batch_id::text;
end;
$$;

revoke execute on function public.get_announcement_batch_delivery_context(uuid) from public, anon;
grant  execute on function public.get_announcement_batch_delivery_context(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION B — advance_waitlist_offer: internal-only, returns exact identity
-- Full mutation logic preserved verbatim from 0050_event_guests.sql except:
-- (1) one new trailing parameter p_actor_id uuid default null, so all
-- existing `perform advance_waitlist_offer(event_id, club_id, title)` call
-- sites elsewhere in the schema continue to compile and behave identically
-- (defaulting to null); (2) 'triggered_by' added to the waitlist_offer
-- notification's metadata only when p_actor_id is not null; (3) return type
-- changed from uuid to jsonb {offered_profile_id, notification_id} — safe,
-- since every existing call site discards the return value via `perform`.
-- Explicit DROP required both for the parameter-list change (to avoid an
-- ambiguous overload against 3-argument callers) and the return-type
-- change (CREATE OR REPLACE cannot alter it). EXECUTE is revoked from
-- public, anon, AND authenticated — see section 4 above.
-- ═══════════════════════════════════════════════════════════════════════════
drop function if exists public.advance_waitlist_offer(uuid, uuid, text);

create or replace function public.advance_waitlist_offer(
  p_event_id    uuid,
  p_club_id     uuid,
  p_event_title text,
  p_actor_id    uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_next_profile       uuid;
  v_offer_window_hours int;
  v_offer_expires_at   timestamptz;
  v_tz                 text;
  v_expires_label      text;
  v_slot_count         int;
  v_capacity           int;
  v_notification_id    uuid;
  v_no_result           jsonb := jsonb_build_object('offered_profile_id', null, 'notification_id', null);
begin
  -- Idempotency guard: if a non-expired offered row already exists, do nothing.
  if exists (
    select 1 from public.event_participants
    where event_id        = p_event_id
      and status          = 'offered'
      and offer_expires_at > now()
  ) then
    return v_no_result;
  end if;

  -- Capacity guard: only offer if there is actually a free slot.
  select
    (select count(*)
       from public.event_participants
       where event_id = p_event_id
         and status   in ('confirmed', 'offered')
         and role     = 'participant')
    +
    (select count(*)
       from public.event_guests
       where event_id = p_event_id)
    into v_slot_count;

  select capacity into v_capacity from public.events where id = p_event_id;

  if v_slot_count >= coalesce(v_capacity, 0) then
    return v_no_result;
  end if;

  -- Find the oldest waitlisted participant (FIFO order by created_at).
  select profile_id into v_next_profile
    from public.event_participants
    where event_id = p_event_id
      and status   = 'waitlisted'
    order by created_at asc
    limit 1;

  if not found then
    return v_no_result;
  end if;

  select waitlist_offer_window_hours into v_offer_window_hours
    from public.club_settings
    where club_id = p_club_id;

  if not found then
    v_offer_window_hours := 2;
  end if;

  v_offer_expires_at := now() + (v_offer_window_hours || ' hours')::interval;

  select timezone into v_tz from public.clubs where id = p_club_id;

  v_expires_label := to_char(
    v_offer_expires_at at time zone coalesce(v_tz, 'UTC'),
    'Mon DD "at" HH12:MI AM'
  );

  update public.event_participants
    set status           = 'offered',
        offer_expires_at = v_offer_expires_at,
        updated_at       = now()
    where event_id   = p_event_id
      and profile_id = v_next_profile;

  -- Insert waitlist_offer notification (mandatory — no preference gate).
  -- 'triggered_by' records the exact actor who caused this advance (e.g.
  -- the Member who called leave_event), when known, so
  -- get_waitlist_delivery_context / get_waitlist_recipient_email can
  -- authorize that specific actor without widening access to every
  -- same-club Member or Pro.
  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    p_club_id,
    v_next_profile,
    'waitlist_offer',
    'A spot opened in "' || p_event_title || '"! Accept by ' || v_expires_label || '.',
    case when p_actor_id is null then
      jsonb_build_object(
        'event_id',         p_event_id,
        'offer_expires_at', v_offer_expires_at
      )
    else
      jsonb_build_object(
        'event_id',         p_event_id,
        'offer_expires_at', v_offer_expires_at,
        'triggered_by',     p_actor_id
      )
    end
  )
  returning id into v_notification_id;

  return jsonb_build_object(
    'offered_profile_id', v_next_profile,
    'notification_id',    v_notification_id
  );
end;
$$;

revoke execute on function public.advance_waitlist_offer(uuid, uuid, text, uuid) from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION B2 — expire_stale_offers_for_event: internal-only, returns
-- exact identity of any offer IT advances internally
-- Full mutation logic preserved verbatim from 0049_waitlist_offer_rpcs.sql
-- except: (1) one new trailing parameter p_actor_id uuid default null,
-- threaded straight through to its own internal advance_waitlist_offer
-- call; (2) return type changed from void to jsonb (the identity pair
-- returned by that internal call, or nulls if it never advanced) — safe,
-- since every existing call site discards the return value via `perform`.
-- Needed so _leave_event_impl (Section C) can capture exact identity
-- regardless of whether the offer was created by this function's own
-- internal advance or by the caller's separate, subsequent advance call —
-- see section 1 above for why both paths must be accounted for.
-- ═══════════════════════════════════════════════════════════════════════════
drop function if exists public.expire_stale_offers_for_event(uuid, uuid, text);

create or replace function public.expire_stale_offers_for_event(
  p_event_id    uuid,
  p_club_id     uuid,
  p_event_title text,
  p_actor_id    uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row             record;
  v_expired_count   int := 0;
  v_advance_result  jsonb := jsonb_build_object('offered_profile_id', null, 'notification_id', null);
begin
  for v_row in
    select profile_id
      from public.event_participants
      where event_id        = p_event_id
        and status          = 'offered'
        and offer_expires_at < now()
  loop
    update public.event_participants
      set status           = 'cancelled',
          offer_expires_at = null,
          updated_at       = now()
      where event_id   = p_event_id
        and profile_id = v_row.profile_id;

    -- Audit each expiry. auth.uid() is the authenticated caller of the parent RPC.
    insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
    values (
      p_club_id,
      auth.uid(),
      'waitlist_offer_expired',
      'event',
      p_event_id,
      jsonb_build_object(
        'profile_id',  v_row.profile_id,
        'event_title', p_event_title
      )
    );

    v_expired_count := v_expired_count + 1;
  end loop;

  -- Only advance the queue if we actually freed a slot via expiry.
  if v_expired_count > 0 then
    select public.advance_waitlist_offer(p_event_id, p_club_id, p_event_title, p_actor_id)
      into v_advance_result;
  end if;

  return v_advance_result;
end;
$$;

revoke execute on function public.expire_stale_offers_for_event(uuid, uuid, text, uuid) from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION C — leave_event: one internal implementation, two public entry
-- points sharing it exactly (no diverging waitlist logic)
-- ═══════════════════════════════════════════════════════════════════════════

-- ---------------------------------------------------------------------------
-- C1. _leave_event_impl — internal only, not a public RPC surface.
-- Full leave_event business logic from 0063_member_rpc_lifecycle_guards.sql
-- preserved verbatim (guards, participant-status update, the expire-then-
-- advance sequence, the audit_log write on the 'offered' branch), with two
-- changes: (1) both expire_stale_offers_for_event and advance_waitlist_offer
-- are now called with auth.uid() as the trusted actor and their exact
-- {offered_profile_id, notification_id} results are captured instead of
-- discarded; (2) the old defensive post-hoc "whoever is currently offered"
-- re-query is removed — v_final_result is coalesced from whichever of the
-- two calls actually produced a non-null offered_profile_id (at most one
-- can, by advance_waitlist_offer's own idempotency guard), which is both
-- exact and, unlike the old re-query, cannot pick up an offer unrelated to
-- this call.
-- ---------------------------------------------------------------------------
create or replace function public._leave_event_impl(p_event_id uuid)
returns jsonb   -- { offered_profile_id: uuid | null, notification_id: uuid | null }
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile        public.profiles%rowtype;
  v_event          public.events%rowtype;
  v_old_status     text;
  v_expire_result  jsonb;
  v_advance_result jsonb;
  v_final_result   jsonb := jsonb_build_object('offered_profile_id', null, 'notification_id', null);
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  select * into v_event
    from public.events
    where id      = p_event_id
      and club_id = v_profile.club_id;
  if found and v_event.archived_at is not null then
    raise exception 'event_archived';
  end if;

  select status into v_old_status
    from public.event_participants
    where event_id   = p_event_id
      and profile_id = auth.uid()
      and status     in ('confirmed', 'waitlisted', 'offered');
  if not found then raise exception 'not_joined'; end if;

  update public.event_participants
    set status           = 'cancelled',
        offer_expires_at = null,
        updated_at       = now()
    where event_id   = p_event_id
      and profile_id = auth.uid()
      and status     in ('confirmed', 'waitlisted', 'offered');

  if v_old_status = 'confirmed' then
    -- A confirmed spot was freed. Expire other stale offers, then advance.
    select * into v_event
      from public.events
      where id      = p_event_id
        and club_id = v_profile.club_id
        and status  = 'scheduled';

    if found then
      select public.expire_stale_offers_for_event(p_event_id, v_profile.club_id, v_event.title, auth.uid())
        into v_expire_result;
      select public.advance_waitlist_offer(p_event_id, v_profile.club_id, v_event.title, auth.uid())
        into v_advance_result;

      v_final_result := case
        when (v_expire_result->>'offered_profile_id') is not null then v_expire_result
        else v_advance_result
      end;
    end if;

  elsif v_old_status = 'offered' then
    -- Caller is implicitly declining their offer by leaving the event entirely.
    select * into v_event
      from public.events
      where id      = p_event_id
        and club_id = v_profile.club_id
        and status  = 'scheduled';

    if found then
      insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
      values (
        v_profile.club_id,
        auth.uid(),
        'leave_offered_spot',
        'event',
        p_event_id,
        jsonb_build_object('event_title', v_event.title)
      );

      select public.expire_stale_offers_for_event(p_event_id, v_profile.club_id, v_event.title, auth.uid())
        into v_expire_result;
      select public.advance_waitlist_offer(p_event_id, v_profile.club_id, v_event.title, auth.uid())
        into v_advance_result;

      v_final_result := case
        when (v_expire_result->>'offered_profile_id') is not null then v_expire_result
        else v_advance_result
      end;
    end if;

  else
    -- Caller was waitlisted: no confirmed slot was freed, no advance needed.
    return v_final_result;
  end if;

  return v_final_result;
end;
$$;

revoke execute on function public._leave_event_impl(uuid) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- C2. leave_event — UNCHANGED external contract.
-- Thin wrapper over _leave_event_impl, extracting only offered_profile_id
-- as a bare uuid — byte-for-byte the same return type and value shape as
-- before. calendar/actions.ts's leaveEvent Server Action requires no code
-- change for this migration to apply safely.
-- ---------------------------------------------------------------------------
create or replace function public.leave_event(p_event_id uuid)
returns uuid   -- offered profile_id, or null if no offer was made
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  v_result := public._leave_event_impl(p_event_id);
  return nullif(v_result->>'offered_profile_id', '')::uuid;
end;
$$;

revoke execute on function public.leave_event(uuid) from public, anon;
grant  execute on function public.leave_event(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- C3. leave_event_v2 — NEW. Same wrapper pattern as leave_event, returning
-- the full exact identity pair instead of just the profile id. Phase 31C
-- will switch calendar/actions.ts's leaveEvent Server Action to call this
-- instead of leave_event.
-- ---------------------------------------------------------------------------
create or replace function public.leave_event_v2(p_event_id uuid)
returns jsonb   -- { offered_profile_id: uuid | null, notification_id: uuid | null }
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public._leave_event_impl(p_event_id);
end;
$$;

revoke execute on function public.leave_event_v2(uuid) from public, anon;
grant  execute on function public.leave_event_v2(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION D — admin_cancel_reservation_v2 (new; original left untouched)
-- Full mutation/audit/notification body cloned verbatim from
-- admin_cancel_reservation (0010_notification_rpc_updates.sql, the current
-- and only version). The only addition is capturing the notification's own
-- id and returning it alongside the reservation. admin_cancel_reservation
-- itself is NOT modified — the deployed app keeps calling it exactly as
-- today until Phase 31C's Server Action is written against this v2.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.admin_cancel_reservation_v2(
  p_reservation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile         public.profiles%rowtype;
  v_res             public.reservations%rowtype;
  v_result          public.reservations%rowtype;
  v_tz              text;
  v_notification_id uuid;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.role <> 'admin' then
    raise exception 'insufficient_role';
  end if;

  select * into v_res
    from public.reservations
    where id      = p_reservation_id
      and club_id = v_profile.club_id
      and status in ('pending', 'confirmed');
  if not found then raise exception 'reservation_not_found'; end if;

  update public.reservations set
    status            = 'cancelled',
    cancelled_at      = now(),
    cancelled_by      = auth.uid(),
    cancellation_kind = 'admin',
    updated_at        = now()
  where id = p_reservation_id
  returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'admin_cancel_reservation',
    'reservation',
    p_reservation_id,
    jsonb_build_object(
      'court_id',      v_res.court_id,
      'owner_user_id', v_res.owner_user_id,
      'starts_at',     v_res.starts_at,
      'reason',        v_res.reason
    )
  );

  select timezone into v_tz from public.clubs where id = v_profile.club_id;

  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    v_res.owner_user_id,
    'reservation_cancelled_by_admin',
    'Your reservation on '
      || to_char(v_res.starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM')
      || ' was cancelled by the club.',
    jsonb_build_object('reservation_id', p_reservation_id)
  )
  returning id into v_notification_id;

  return jsonb_build_object(
    'reservation',     to_jsonb(v_result),
    'notification_id', v_notification_id
  );
end;
$$;

revoke execute on function public.admin_cancel_reservation_v2(uuid) from public, anon;
grant  execute on function public.admin_cancel_reservation_v2(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION E — cancel_event: drop + recreate, same name, jsonb return,
-- offered-recipient capture bug fixed (see section 2 above)
-- Full body preserved verbatim from 0099_event_edit_foundation.sql (the
-- current and only relevant version, including the 18A 'offered' status
-- addition and the 30C1 creator-Pro ownership check), except: the exact
-- affected participant set (confirmed/waitlisted/offered) is now captured
-- into an array BEFORE the 'offered' -> 'cancelled' status UPDATE runs, and
-- the notification INSERT is driven from that captured array via unnest()
-- rather than re-querying event_participants.status afterward. Verified
-- safe to change under the same name: every current call site
-- (calendar/actions.ts's cancelEvent) destructures only `{ error }` from
-- this RPC's result and discards `data` entirely.
-- ═══════════════════════════════════════════════════════════════════════════
drop function if exists public.cancel_event(uuid);

create or replace function public.cancel_event(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile              public.profiles%rowtype;
  v_event                public.events%rowtype;
  v_result                public.events%rowtype;
  v_affected_profile_ids  uuid[];
  v_notifications         jsonb;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  select * into v_event
    from public.events
    where id      = p_event_id
      and club_id = v_profile.club_id
      and status  = 'scheduled';
  if not found then raise exception 'event_not_found'; end if;

  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  if v_profile.role is distinct from 'admin' and v_profile.role is distinct from 'pro' then
    raise exception 'insufficient_role';
  end if;

  if v_profile.role = 'pro' and v_event.created_by is distinct from auth.uid() then
    raise exception 'insufficient_role';
  end if;

  -- Capture the exact affected recipient set BEFORE any participant status
  -- mutation runs. The initial draft of this migration selected recipients
  -- for the notification insert AFTER flipping 'offered' rows to
  -- 'cancelled', which meant offered participants could never match and
  -- silently received nothing. Capturing here, first, makes that ordering
  -- bug structurally impossible: event_participants has at most one row per
  -- (event_id, profile_id), so this array_agg cannot contain duplicates and
  -- every confirmed/waitlisted/offered participant is captured exactly
  -- once, before anything about their status changes.
  select coalesce(array_agg(profile_id), '{}') into v_affected_profile_ids
    from public.event_participants
    where event_id = p_event_id
      and status   in ('confirmed', 'waitlisted', 'offered');

  update public.events
    set status = 'cancelled', updated_at = now()
    where id = p_event_id
    returning * into v_result;

  update public.reservations set
    status            = 'cancelled',
    cancelled_at      = now(),
    cancelled_by      = auth.uid(),
    cancellation_kind = 'admin',
    updated_at        = now()
  where event_id = p_event_id
    and status in ('pending', 'confirmed');

  update public.event_participants
    set status           = 'cancelled',
        offer_expires_at = null,
        updated_at       = now()
    where event_id = p_event_id
      and status   = 'offered';

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'cancel_event',
    'event',
    p_event_id,
    jsonb_build_object('title', v_event.title, 'starts_at', v_event.starts_at)
  );

  -- Notify every participant captured above — confirmed, waitlisted, and
  -- offered alike, exactly once each. Exact {notification_id, user_id}
  -- pairs captured via `returning` inside the same statement, instead of a
  -- caller re-querying live event_participants.status (which had already
  -- changed by the time such a re-query could run) or a created_at time
  -- window.
  with ins as (
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    select
      v_event.club_id,
      pid,
      'event_cancelled',
      '"' || v_event.title || '" has been cancelled.',
      jsonb_build_object('event_id', p_event_id)
    from unnest(v_affected_profile_ids) as pid
    returning id, user_id
  )
  select coalesce(
    jsonb_agg(jsonb_build_object('notification_id', id, 'user_id', user_id)),
    '[]'::jsonb
  )
  into v_notifications
  from ins;

  return jsonb_build_object(
    'event',         to_jsonb(v_result),
    'notifications', v_notifications
  );
end;
$$;

revoke execute on function public.cancel_event(uuid) from public, anon;
grant  execute on function public.cancel_event(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION F — send_announcement_v2 (new; original left untouched)
-- Full mutation/audit/notification body cloned verbatim from
-- send_announcement (0043_preference_aware_notification_rpcs.sql, the
-- current and only relevant version, including its preference-filtered
-- bulk insert). Adds a durable per-send batch id (announcement_batch_id)
-- stamped into every recipient's notification metadata, and returns the
-- exact {notification_id, user_id} set actually inserted — never a
-- 5-second created_at window. send_announcement itself is NOT modified —
-- the deployed app keeps calling it exactly as today until Phase 31C's
-- Server Action is written against this v2.
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
  v_batch_id        uuid := uuid_generate_v4();
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
-- SECTION G — admin_force_confirm: drop + recreate, same name, jsonb
-- return, now stamps triggered_by (see section 3 above)
-- Full body preserved verbatim from 0061_archive_roster_guard.sql (the
-- current and only relevant version), including its existing
-- `v_actor.role not in ('admin', 'pro')` authorization — NOT changed by
-- this migration. Two additions: the mandatory notification insert now
-- captures its own id, and its metadata now includes
-- 'triggered_by', auth.uid() unconditionally (harmless for an Admin actor,
-- who is already separately and always authorized by
-- get_waitlist_delivery_context; load-bearing for a Pro actor). Verified
-- safe to change under the same name: admin/events/actions.ts's
-- adminForceConfirm destructures only `{ error }` and discards `data`
-- entirely.
-- ═══════════════════════════════════════════════════════════════════════════
drop function if exists public.admin_force_confirm(uuid, uuid);

create or replace function public.admin_force_confirm(
  p_event_id   uuid,
  p_profile_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor            public.profiles%rowtype;
  v_event            public.events%rowtype;
  v_old_status       text;
  v_occupied         int;
  v_was_over_cap     boolean;
  v_result           public.event_participants%rowtype;
  v_notification_id  uuid;
begin
  select * into v_actor from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_actor.role not in ('admin', 'pro') then
    raise exception 'admin_required';
  end if;

  select * into v_event
    from public.events
    where id      = p_event_id
      and club_id = v_actor.club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  if not exists (
    select 1 from public.profiles
    where id      = p_profile_id
      and club_id = v_actor.club_id
      and status  = 'active'
  ) then
    if not exists (select 1 from public.profiles where id = p_profile_id and club_id = v_actor.club_id) then
      raise exception 'member_not_found';
    end if;
    raise exception 'member_inactive';
  end if;

  select status into v_old_status
    from public.event_participants
    where event_id   = p_event_id
      and profile_id = p_profile_id;
  if not found then raise exception 'participant_not_found'; end if;
  if v_old_status = 'confirmed' then raise exception 'already_joined'; end if;

  select
    (select count(*)
       from public.event_participants
       where event_id = p_event_id
         and status   in ('confirmed', 'offered')
         and role     = 'participant')
    +
    (select count(*)
       from public.event_guests
       where event_id = p_event_id)
    into v_occupied;

  v_was_over_cap := v_occupied >= v_event.capacity;

  update public.event_participants
    set status           = 'confirmed',
        offer_expires_at = null,
        updated_at       = now()
    where event_id   = p_event_id
      and profile_id = p_profile_id
  returning * into v_result;

  -- Mandatory notification: target member is now confirmed. triggered_by
  -- lets the specific actor (Admin or Pro) who ran this action fetch
  -- delivery context / recipient email for the notification they just
  -- created, via get_waitlist_delivery_context / get_waitlist_recipient_
  -- email — without granting access to any other, unrelated Pro.
  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_actor.club_id,
    p_profile_id,
    'waitlist_promoted',
    'An admin confirmed your spot in "' || v_event.title || '".',
    jsonb_build_object('event_id', p_event_id, 'triggered_by', auth.uid())
  )
  returning id into v_notification_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'admin_force_confirm',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_title',       v_event.title,
      'profile_id',        p_profile_id,
      'previous_status',   v_old_status,
      'was_over_capacity', v_was_over_cap
    )
  );

  return jsonb_build_object(
    'participant',      to_jsonb(v_result),
    'notification_id',  v_notification_id
  );
end;
$$;

revoke execute on function public.admin_force_confirm(uuid, uuid) from public, anon;
grant  execute on function public.admin_force_confirm(uuid, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION H — admin_offer_spot: drop + recreate, same name, jsonb return,
-- now stamps triggered_by (see section 3 above)
-- Full body preserved verbatim from 0061_archive_roster_guard.sql (the
-- current and only relevant version), including its existing
-- `v_actor.role not in ('admin', 'pro')` authorization — NOT changed by
-- this migration. Two additions: the mandatory waitlist_offer notification
-- insert now captures its own id, and its metadata now includes
-- 'triggered_by', auth.uid() unconditionally, for the same reason as
-- admin_force_confirm above. Verified safe to change under the same name:
-- admin/events/actions.ts's adminOfferSpot destructures only `{ error }`
-- and discards `data` entirely.
-- ═══════════════════════════════════════════════════════════════════════════
drop function if exists public.admin_offer_spot(uuid, uuid);

create or replace function public.admin_offer_spot(
  p_event_id   uuid,
  p_profile_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor              public.profiles%rowtype;
  v_event              public.events%rowtype;
  v_target_row         public.event_participants%rowtype;
  v_slot_count         int;
  v_offer_window_hours int;
  v_offer_expires_at   timestamptz;
  v_tz                 text;
  v_expires_label      text;
  v_skipped_ids        uuid[];
  v_result             public.event_participants%rowtype;
  v_notification_id    uuid;
begin
  select * into v_actor from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_actor.role not in ('admin', 'pro') then
    raise exception 'admin_required';
  end if;

  select * into v_event
    from public.events
    where id      = p_event_id
      and club_id = v_actor.club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  select * into v_target_row
    from public.event_participants
    where event_id   = p_event_id
      and profile_id = p_profile_id
      and status     = 'waitlisted';
  if not found then raise exception 'participant_not_found'; end if;

  if exists (
    select 1 from public.event_participants
    where event_id        = p_event_id
      and status          = 'offered'
      and offer_expires_at > now()
  ) then raise exception 'offer_already_active'; end if;

  select
    (select count(*)
       from public.event_participants
       where event_id = p_event_id
         and status   in ('confirmed', 'offered')
         and role     = 'participant')
    +
    (select count(*)
       from public.event_guests
       where event_id = p_event_id)
    into v_slot_count;

  if v_slot_count >= v_event.capacity then
    raise exception 'no_capacity_for_offer';
  end if;

  select coalesce(array_agg(profile_id order by created_at asc), '{}') into v_skipped_ids
    from public.event_participants
    where event_id   = p_event_id
      and status     = 'waitlisted'
      and profile_id <> p_profile_id
      and created_at < v_target_row.created_at;

  select waitlist_offer_window_hours into v_offer_window_hours
    from public.club_settings
    where club_id = v_actor.club_id;

  if not found then
    v_offer_window_hours := 2;
  end if;

  v_offer_expires_at := now() + (v_offer_window_hours || ' hours')::interval;

  select timezone into v_tz from public.clubs where id = v_actor.club_id;

  v_expires_label := to_char(
    v_offer_expires_at at time zone coalesce(v_tz, 'UTC'),
    'Mon DD "at" HH12:MI AM'
  );

  update public.event_participants
    set status           = 'offered',
        offer_expires_at = v_offer_expires_at,
        updated_at       = now()
    where event_id   = p_event_id
      and profile_id = p_profile_id
  returning * into v_result;

  -- Mandatory waitlist_offer notification (same kind as advance_waitlist_offer).
  -- triggered_by lets the specific actor (Admin or Pro) who ran this action
  -- fetch delivery context / recipient email for the notification they just
  -- created — without granting access to any other, unrelated Pro.
  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_actor.club_id,
    p_profile_id,
    'waitlist_offer',
    'A spot opened in "' || v_event.title || '"! Accept by ' || v_expires_label || '.',
    jsonb_build_object(
      'event_id',         p_event_id,
      'offer_expires_at', v_offer_expires_at,
      'triggered_by',     auth.uid()
    )
  )
  returning id into v_notification_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'admin_offer_spot',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_title',         v_event.title,
      'profile_id',          p_profile_id,
      'offer_expires_at',    v_offer_expires_at,
      'skipped_profile_ids', v_skipped_ids
    )
  );

  return jsonb_build_object(
    'participant',     to_jsonb(v_result),
    'notification_id', v_notification_id
  );
end;
$$;

revoke execute on function public.admin_offer_spot(uuid, uuid) from public, anon;
grant  execute on function public.admin_offer_spot(uuid, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION I — notifications UPDATE privilege hardening (see section 6 above)
-- ═══════════════════════════════════════════════════════════════════════════
-- Supabase provisions every public-schema table with table-wide GRANT ALL
-- (full-column SELECT/INSERT/UPDATE/DELETE) to anon and authenticated at
-- project-creation time — a platform default outside this repository's
-- migration history, never overridden by any prior migration (grep across
-- supabase/migrations/ for `grant`/`revoke` combined with `notifications`
-- returns zero matches before this one). notifications' own_update RLS
-- policy (0009) restricts which ROWS an authenticated user may update
-- (user_id = auth.uid()) but does not and cannot restrict which COLUMNS —
-- RLS USING/WITH CHECK clauses operate on rows, not columns. Combined, an
-- authenticated recipient can today update kind, body, metadata, club_id,
-- or any other column on their own notification row, not only is_read.
--
-- This is hardened to the minimum the deployed app needs. Confirmed via
-- grep across every src/**/*.ts file that NotificationSheet.tsx's two
-- calls — `update({is_read: true})` for a single row (mark-one-read) and
-- for `is_read = false` (mark-all-read) — are the ONLY client writes to
-- this table anywhere in the application. No other column is ever written
-- by any client.
--
-- No trigger is added: PostgREST issues a real SQL UPDATE under the
-- caller's role, so Postgres column-level privileges are enforced exactly
-- as they would be for any direct SQL client — this is Supabase's own
-- documented mechanism for column-scoped write access and needs no
-- additional enforcement layer. A trigger here would be a second,
-- redundant mechanism enforcing the same boundary.
--
-- anon receives no UPDATE privilege at all (it has no auth.uid(), so
-- own_update's RLS check could never pass for it regardless — revoked here
-- explicitly anyway, as defense in depth rather than relying on RLS alone).
-- PUBLIC is revoked for the same reason. Security-definer INSERTs (every
-- notification-creating RPC in this codebase, including every one added by
-- this migration) are unaffected: SECURITY DEFINER functions execute with
-- the owning role's privileges, not the invoking role's grants, so this
-- change to `authenticated`'s privileges never constrains them.
-- ═══════════════════════════════════════════════════════════════════════════
revoke update on public.notifications from anon, authenticated, public;
grant  update (is_read) on public.notifications to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- End of 0102_communications_delivery_identity.sql
-- ═══════════════════════════════════════════════════════════════════════════
