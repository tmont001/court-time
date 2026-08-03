# Phase 30B2 — Remove Reservation Direct-Update Policy — QA

Scope: `supabase/migrations/0098_remove_reservation_direct_update_policy.sql`
only — a single `DROP POLICY IF EXISTS "reservations_cancel_own" ON
public.reservations`. This is the contract half of the Phase 30B1/30B2
expand-deploy-contract sequence (see `docs/QA_phase30b1.md`).

**This migration is being prepared now, not applied now.** Migration `0097`
is already applied and the Phase 30B1 application is already live in
production, but its required production bake period has **not yet been
confirmed complete** as of this writing. Do not apply `0098` until all of
the following are independently confirmed against the target environment,
at apply time:

1. The Phase 30B1 application has been deployed to production.
2. The intended production bake period has elapsed.
3. No cancellation regressions have been observed during that period.
4. A final source audit, run immediately before applying this migration,
   confirms zero application call sites anywhere in the codebase perform a
   raw `reservations` table UPDATE.
5. A final, live `pg_policies` query against the target database confirms
   `reservations_cancel_own` is still the only UPDATE policy on
   `public.reservations` immediately before it is dropped. **Re-run this
   query immediately before applying `0098`, even if it was already
   confirmed while this migration was being prepared** — catalog state can
   drift between preparation and application (e.g. an unrelated later
   migration or a manual hotfix could add or remove a policy in the
   interim), so an earlier snapshot must never be treated as still valid
   at apply time.

No application code, RPC, notification, audit, or authorization behavior
changes in this checkpoint. Run all cases below against a non-production /
staging Supabase project first.

---

## 1. Policy removal takes effect

- [ ] Immediately before applying `0098` (not from an earlier snapshot —
      see the prerequisite list above): query `pg_policies` for
      `tablename = 'reservations'` — confirm exactly three policies exist
      and `reservations_cancel_own` is present among them (one row,
      `cmd = 'UPDATE'`, the only UPDATE policy).
- [ ] Apply migration `0098`.
- [ ] After applying: repeat the `pg_policies` query — confirm
      `reservations_cancel_own` no longer appears. Exactly two policies
      remain on `reservations`: `reservations_select_same_club` (SELECT) and
      `reservations_insert_own` (INSERT) — both untouched, both still
      present.

## 2. Raw client UPDATE is denied

- [ ] As an authenticated `member` (or `pro`) session, attempt a direct
      table update matching the exact shape the old policy used to permit:
      `update reservations set status='cancelled', cancelled_by=auth.uid(),
      cancellation_kind='member' where id=<own reservation id> and
      owner_user_id=auth.uid()` — the statement must either fail outright
      (no matching RLS policy) or affect **zero rows**. Confirm via a
      follow-up `SELECT` that the target row's `status` is unchanged.
- [ ] Repeat the same raw UPDATE attempt against a reservation the caller
      does **not** own — still denied/zero rows (this was already denied
      pre-migration by `owner_user_id = auth.uid()`; confirm it remains
      denied, not newly permitted).
- [ ] Attempt a raw UPDATE as an `admin` session — still denied/zero rows
      (admin never had an UPDATE policy on this table; admin mutation has
      always gone through `admin_cancel_reservation`, unaffected here).
- [ ] Attempt a raw UPDATE that tries to change `starts_at`/`court_id`
      alongside a superficially-valid cancellation shape (the exact gap
      flagged during the Phase 30B1 migration review, where the old
      policy's `WITH CHECK` didn't pin non-cancellation columns) — denied
      entirely now that the policy is gone, closing that gap.

## 3. RPC-backed mutation paths still succeed, unchanged

- [ ] **Member cancellation** — `cancel_member_reservation` still succeeds
      for a member owner outside the cancellation window (or within grace);
      `status` transitions to `cancelled`, `cancellation_kind = 'member'`.
- [ ] **Pro cancellation** — `cancel_member_reservation` still succeeds for
      a pro owner under the same rules.
- [ ] **Admin cancellation** — `admin_cancel_reservation` still succeeds for
      any reservation in the admin's club, regardless of owner, with no
      window/grace enforcement.
- [ ] **Admin reservation edit** — `update_member_reservation` still
      succeeds for an eligible (confirmed, `member_booking`, future)
      reservation — court/date/start-time/duration changes apply in place,
      `changed_fields`/`notification_id` returned as before.
- [ ] All four RPCs above are `SECURITY DEFINER` and were never gated by
      `reservations_cancel_own` — none of their behavior, error codes, or
      return shapes should differ before vs. after this migration. Spot-check
      one full success case for each against the Phase 30B1 QA doc's
      existing assertions (`docs/QA_phase30b1.md` §1–§2) to confirm no
      drift.

## 4. Unrelated behavior remains unchanged

- [ ] **SELECT** — a member/pro/admin can still read all same-club
      reservations exactly as before (`reservations_select_same_club`
      untouched).
- [ ] **INSERT** — `create_reservation` (which never relied on
      `reservations_cancel_own`) still successfully creates a new
      `member_booking` reservation; the separate `reservations_insert_own`
      policy (restricted to `reason = 'member_booking'` direct inserts) is
      untouched and still in place.
- [ ] **Wrong-owner attempt via RPC** — `cancel_member_reservation` called
      for a reservation owned by a different user still returns
      `reservation_not_found` (enforced by the RPC's own row lookup, not by
      RLS — unaffected by this migration).
- [ ] **Wrong-club attempt via RPC** — `cancel_member_reservation` /
      `update_member_reservation` called with a reservation id from another
      club still return `reservation_not_found` / `stale_club_context` as
      appropriate — unaffected by this migration.
- [ ] **Admin editing/cancelling across the club boundary** — still
      correctly denied for a different club's reservation, exactly as
      before (enforced inside the RPCs, not by the removed policy).

## 5. Build/type validation

- [ ] `pnpm tsc --noEmit` passes with no new errors (no application code
      changed in this checkpoint, so none are expected).
- [ ] `pnpm build` completes successfully.
- [ ] `git diff --check` — no whitespace errors.

## 6. Rollback verification (optional, staging only)

- [ ] If a rollback is ever needed, recreate `reservations_cancel_own` using
      the exact definition documented in migration `0098`'s rollback
      comment (verbatim from `0003_reservations.sql`) and confirm the
      §2 raw-UPDATE test that was denied is now permitted again — proving
      the rollback restores the prior (pre-30B2) behavior exactly, gap
      included.
