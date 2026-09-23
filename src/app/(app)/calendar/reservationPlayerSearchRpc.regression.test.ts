import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 39B-2 — regression coverage for migration 0204 (Looking-for-Players
// RPC / authorization / capacity layer), using this repository's
// established source-inspection style. 0204 is NOT applied to Supabase by
// this checkpoint — these tests verify the migration FILE's content only.
// 0203 is APPLIED and immutable and is asserted here to be untouched.
//
// This revision reflects the three pre-apply corrections: (1) a
// reservation-scoped advisory transaction lock closing the no-search-row
// concurrency gap, (2) dynamic host roster eligibility folded into the
// effective-open predicate plus an explicit open/reopen-time check, and
// (3) the notification recipient resolved from roster_members.claimed_by
// (never reservations.owner_user_id) with no user_pref_enabled gate and no
// touch to notification_preferences_kind_check/update_notification_
// preference.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

const MIGRATION_PATH = "supabase/migrations/0204_reservation_player_search_rpc_layer.sql";
const FOUNDATION_MIGRATION_PATH = "supabase/migrations/0203_reservation_player_search_foundation.sql";
const ROSTER_RPC_MIGRATION_PATH = "supabase/migrations/0179_reservation_roster_rpc_layer.sql";

function migrationSql(): string {
  return codeOnly(readSource(MIGRATION_PATH));
}

function rawMigrationSql(): string {
  return readSource(MIGRATION_PATH);
}

function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, `function public.${name} not found`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n$$;", start);
  expect(end, `terminator not found for ${name}`).toBeGreaterThan(start);
  return sql.slice(start, end + "\n$$;".length);
}

// ═══════════════════════════════════════════════════════════════════════════
// PRE-IMPLEMENTATION FINDING DOCUMENTED (not silently resolved)
// ═══════════════════════════════════════════════════════════════════════════

describe("0204 documents the guest_names pre-implementation finding", () => {
  it("the migration header states the exact conflict and locked resolution", () => {
    const raw = rawMigrationSql();
    expect(raw).toMatch(/PRE-IMPLEMENTATION FINDING/);
    expect(raw).toContain("reservations.guest_names");
    expect(raw).toContain("is NOT legacy");
    expect(raw).toMatch(/LOCKED RESOLUTION/);
    expect(raw).toMatch(/reservation_has_legacy_guest_names/);
  });

  it("the migration header documents all three pre-apply corrections", () => {
    const raw = rawMigrationSql();
    expect(raw).toMatch(/PRE-APPLY REVIEW CORRECTIONS/);
    expect(raw).toMatch(/CONCURRENCY GAP/);
    expect(raw).toMatch(/HOST ELIGIBILITY/);
    expect(raw).toMatch(/NOTIFICATION RECIPIENT/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CORRECTION 1 — CONCURRENCY: reservation-scoped advisory lock (new items 1-3)
// ═══════════════════════════════════════════════════════════════════════════

describe("0204 correction 1 — no-search-row concurrency gap closed", () => {
  it("1. a transaction-scoped reservation lock helper exists, uses pg_advisory_xact_lock/hashtextextended, and is internal-only", () => {
    const body = functionBody(migrationSql(), "_lock_reservation_player_search_scope");
    expect(body).toContain("perform pg_advisory_xact_lock(hashtextextended('reservation_player_search:' || p_reservation_id::text, 0));");
    const sql = migrationSql();
    expect(sql).toMatch(
      /revoke execute on function public\._lock_reservation_player_search_scope\(uuid\)\s+from public, anon, authenticated;/,
    );
  });

  it("2a. set_reservation_player_search acquires the scope lock before checking whether a search row exists", () => {
    const body = functionBody(migrationSql(), "set_reservation_player_search");
    const scopeLockIdx = body.indexOf("perform public._lock_reservation_player_search_scope(p_reservation_id);");
    const selectExistingIdx = body.indexOf("select * into v_existing\n    from public.reservation_player_searches\n   where reservation_id = p_reservation_id\n   for update;");
    expect(scopeLockIdx).toBeGreaterThan(0);
    expect(selectExistingIdx).toBeGreaterThan(scopeLockIdx);
  });

  it("2b. add_reservation_participant acquires the scope lock (non-host branch only) before the search-row lock", () => {
    const body = functionBody(migrationSql(), "add_reservation_participant");
    const guardIdx = body.indexOf("if p_roster_member_id <> v_reservation.roster_member_id then\n    perform public._lock_reservation_player_search_scope(p_reservation_id);");
    expect(guardIdx).toBeGreaterThan(0);
    const rowLockIdx = body.indexOf("v_search := public._lock_reservation_player_search_row(p_reservation_id);", guardIdx);
    expect(rowLockIdx).toBeGreaterThan(guardIdx);
  });

  it("2c. add_reservation_guest acquires the scope lock unconditionally before the search-row lock", () => {
    const body = functionBody(migrationSql(), "add_reservation_guest");
    const scopeLockIdx = body.indexOf("perform public._lock_reservation_player_search_scope(p_reservation_id);");
    const rowLockIdx = body.indexOf("v_search := public._lock_reservation_player_search_row(p_reservation_id);");
    expect(scopeLockIdx).toBeGreaterThan(0);
    expect(rowLockIdx).toBeGreaterThan(scopeLockIdx);
  });

  it("2d. join_reservation_player_search acquires the scope lock before the search-row lock", () => {
    const body = functionBody(migrationSql(), "join_reservation_player_search");
    const scopeLockIdx = body.indexOf("perform public._lock_reservation_player_search_scope(p_reservation_id);");
    const rowLockIdx = body.indexOf("v_search := public._lock_reservation_player_search_row(p_reservation_id);");
    expect(scopeLockIdx).toBeGreaterThan(0);
    expect(rowLockIdx).toBeGreaterThan(scopeLockIdx);
  });

  it("3. host-participant addition remains seat-neutral — no scope lock acquired on that branch (only inside the non-host if-block)", () => {
    const body = functionBody(migrationSql(), "add_reservation_participant");
    const scopeLockLines = body.match(/perform public\._lock_reservation_player_search_scope\(p_reservation_id\);/g) ?? [];
    expect(scopeLockLines.length).toBe(1); // exactly one call site, inside the non-host guard
    const idx = body.indexOf("perform public._lock_reservation_player_search_scope(p_reservation_id);");
    const precedingLine = body.slice(Math.max(0, idx - 90), idx);
    expect(precedingLine).toContain("if p_roster_member_id <> v_reservation.roster_member_id then");
  });

  it("leave_reservation_participation never acquires the scope lock — removal only decreases occupancy, nothing to serialize", () => {
    const body = functionBody(migrationSql(), "leave_reservation_participation");
    expect(body).not.toMatch(/_lock_reservation_player_search_scope/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CORRECTION 2 — HOST ELIGIBILITY (new items 4-7)
// ═══════════════════════════════════════════════════════════════════════════

describe("0204 correction 2 — dynamic host roster eligibility", () => {
  it("4. set_reservation_player_search rejects an inactive/removed current host with roster_member_inactive", () => {
    const body = functionBody(migrationSql(), "set_reservation_player_search");
    expect(body).toContain("select * into v_host_roster\n    from public.roster_members\n   where id = v_reservation.roster_member_id;");
    expect(body).toContain("if v_host_roster.status is distinct from 'active' or v_host_roster.removed_at is not null then");
    // Exactly two roster_member_inactive raises expected in this file: here, and in join/discovery for the CALLER's own eligibility — count occurrences specific to this function.
    const raises = body.match(/raise exception 'roster_member_inactive';/g) ?? [];
    expect(raises.length).toBe(1);
  });

  it("5. the shared effective-open predicate dynamically requires the CURRENT host's roster identity to be active and not removed", () => {
    const body = functionBody(migrationSql(), "_reservation_player_search_is_effective_open");
    expect(body).toMatch(/exists \(\s*\n\s*select 1\s*\n\s*from public\.roster_members rm\s*\n\s*where rm\.id\s*=\s*p_reservation\.roster_member_id\s*\n\s*and rm\.status\s*=\s*'active'\s*\n\s*and rm\.removed_at is null\s*\n\s*\)/);
  });

  it("uses the SAME status='active' AND removed_at IS NULL semantics already established by get_reservation_eligible_roster_members (0179) — no new membership/rating/status system", () => {
    const existingEligibility = functionBody(codeOnly(readSource(ROSTER_RPC_MIGRATION_PATH)), "get_reservation_eligible_roster_members");
    expect(existingEligibility).toContain("and rm.status      = 'active'");
    expect(existingEligibility).toContain("and rm.removed_at is null");
    const newPredicate = functionBody(migrationSql(), "_reservation_player_search_is_effective_open");
    expect(newPredicate).toContain("and rm.status      = 'active'");
    expect(newPredicate).toContain("and rm.removed_at is null");
  });

  it("6. host_inactive is the only newly-added block reason — the taxonomy now holds exactly three non-null values", () => {
    const body = functionBody(migrationSql(), "_reservation_player_search_block_reason");
    const literals = body.match(/'[a-z_]+'/g) ?? [];
    const nonKeywordLiterals = literals.filter((l) => l !== "'active'");
    expect(nonKeywordLiterals).toEqual(["'stale_host'", "'host_inactive'", "'legacy_guest_names'"]);
  });

  it("7a. discovery inherits host-inactive fail-closed behavior via the shared predicate — no separate host-eligibility filter duplicated in the query", () => {
    const body = functionBody(migrationSql(), "get_open_reservation_player_searches");
    expect(body).toContain("public._reservation_player_search_is_effective_open(r, s)");
    expect(body).not.toMatch(/rm\.status\s*=\s*'active'[\s\S]*host/i);
  });

  it("7b. join inherits host-inactive fail-closed behavior via the same shared predicate", () => {
    const body = functionBody(migrationSql(), "join_reservation_player_search");
    expect(body).toContain("if not public._reservation_player_search_is_effective_open(v_reservation, v_search) then");
    expect(body).toContain("raise exception 'reservation_player_search_not_open';");
  });

  it("host eligibility check in set_reservation_player_search runs after the roster_member_id null-check and before the guest_names check", () => {
    const body = functionBody(migrationSql(), "set_reservation_player_search");
    const nullCheckIdx = body.indexOf("if v_reservation.roster_member_id is null then");
    const hostEligibilityIdx = body.indexOf("if v_host_roster.status is distinct from 'active' or v_host_roster.removed_at is not null then");
    const guestNamesIdx = body.indexOf("if v_reservation.guest_names is not null and array_length(v_reservation.guest_names, 1) is not null then");
    expect(nullCheckIdx).toBeGreaterThan(0);
    expect(hostEligibilityIdx).toBeGreaterThan(nullCheckIdx);
    expect(guestNamesIdx).toBeGreaterThan(hostEligibilityIdx);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CORRECTION 3 — NOTIFICATION RECIPIENT + IN-APP SEMANTICS (new items 8-14)
// ═══════════════════════════════════════════════════════════════════════════

describe("0204 correction 3 — notification recipient and in-app preference semantics", () => {
  it("8. join notification targets the CURRENT host's roster_members.claimed_by, resolved fresh by reservation.roster_member_id", () => {
    const body = functionBody(migrationSql(), "join_reservation_player_search");
    expect(body).toContain("select claimed_by into v_host_claimed_by\n      from public.roster_members\n     where id = v_reservation.roster_member_id;");
    expect(body).toContain("v_host_claimed_by,\n        'reservation_player_activity',");
  });

  it("9. leave notification targets the CURRENT host's roster_members.claimed_by, resolved fresh by reservation.roster_member_id", () => {
    const body = functionBody(migrationSql(), "leave_reservation_participation");
    expect(body).toContain("select claimed_by into v_host_claimed_by\n    from public.roster_members\n   where id = v_reservation.roster_member_id;");
    expect(body).toContain("v_host_claimed_by,\n      'reservation_player_activity',");
  });

  it("10. owner_user_id is NEVER used as the player-activity notification target anywhere in this migration", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/owner_user_id/);
  });

  it("11. user_pref_enabled is NEVER called anywhere in this migration — the in-app row is unconditional for a claimed host", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/user_pref_enabled/);
  });

  it("12. reservation_player_activity remains in notifications_kind_check, appended last, all 21 existing kinds preserved in order", () => {
    const start = migrationSql().indexOf("add constraint notifications_kind_check");
    const end = migrationSql().indexOf(");", start);
    const block = migrationSql().slice(start, end);
    const expectedOrder = [
      "reservation_confirmed", "reservation_cancelled_by_admin", "reservation_cancelled_by_member",
      "reservation_rescheduled", "event_cancelled", "event_joined", "event_updated",
      "waitlist_promoted", "waitlist_offer", "announcement",
      "lesson_request_received", "lesson_request_proposed", "lesson_request_confirmed",
      "lesson_request_declined", "lesson_cancelled", "lesson_provider_reassigned",
      "lesson_admin_requested", "refund_request_rejected", "refund_request_completed",
      "refund_request_submitted", "member_waiver_requires_acceptance", "reservation_player_activity",
    ];
    let cursor = -1;
    for (const kind of expectedOrder) {
      const idx = block.indexOf(`'${kind}'`);
      expect(idx, `${kind} missing or out of order`).toBeGreaterThan(cursor);
      cursor = idx;
    }
  });

  it("13. notification_preferences_kind_check is NOT touched by 0204 at all", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/notification_preferences_kind_check/);
    expect(sql).not.toMatch(/alter table public\.notification_preferences/);
  });

  it("14. update_notification_preference is NOT redefined by 0204", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/create or replace function public\.update_notification_preference/);
  });

  it("15. a duplicate active join still emits no second notification — the recipient lookup and insert sit inside the same genuine-activation gate the audit row does", () => {
    const body = functionBody(migrationSql(), "join_reservation_player_search");
    const gateIdx = body.indexOf("if v_reactivated or not v_existing_found then");
    const claimedByIdx = body.indexOf("select claimed_by into v_host_claimed_by");
    expect(gateIdx).toBeGreaterThan(0);
    expect(claimedByIdx).toBeGreaterThan(gateIdx);
  });

  it("16. an already-removed leave still emits no second notification — the idempotent 'already removed' branch returns before the update/audit/notification block", () => {
    const body = functionBody(migrationSql(), "leave_reservation_participation");
    const idempotentIdx = body.indexOf("if v_existing.status = 'removed' then");
    const returnIdx = body.indexOf("return v_existing.id;", idempotentIdx);
    const updateIdx = body.indexOf("update public.reservation_participants\n     set status     = 'removed',");
    expect(idempotentIdx).toBeGreaterThan(0);
    expect(returnIdx).toBeGreaterThan(idempotentIdx);
    expect(updateIdx).toBeGreaterThan(returnIdx);
  });

  it("notification body copy is unchanged: '<Display Name> joined your reservation.' / '<Display Name> left your reservation.'", () => {
    const joinBody = functionBody(migrationSql(), "join_reservation_player_search");
    const leaveBody = functionBody(migrationSql(), "leave_reservation_participation");
    expect(joinBody).toContain("' joined your reservation.'");
    expect(leaveBody).toContain("' left your reservation.'");
  });

  it("no notification is attempted when the host roster identity has no claimed account (v_host_claimed_by is null)", () => {
    const joinBody = functionBody(migrationSql(), "join_reservation_player_search");
    const leaveBody = functionBody(migrationSql(), "leave_reservation_participation");
    expect(joinBody).toContain("if v_host_claimed_by is not null then");
    expect(leaveBody).toContain("if v_host_claimed_by is not null then");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CAPACITY (items 1-12 from the original spec — unchanged invariants)
// ═══════════════════════════════════════════════════════════════════════════

describe("0204 capacity — canonical formula and effective-open helpers", () => {
  it("exactly one canonical occupied-seat formula function exists", () => {
    const sql = migrationSql();
    expect((sql.match(/create or replace function public\._reservation_player_search_occupied_seats\(/g) ?? []).length).toBe(1);
  });

  it("the host always counts exactly once — the formula starts with a literal 1", () => {
    const body = functionBody(migrationSql(), "_reservation_player_search_occupied_seats");
    expect(body).toMatch(/select\s+1\s*\n\s*\+/);
  });

  it("an active non-host participant consumes exactly one seat", () => {
    const body = functionBody(migrationSql(), "_reservation_player_search_occupied_seats");
    expect(body).toMatch(/from public\.reservation_participants/);
    expect(body).toMatch(/status\s*=\s*'active'/);
    expect(body).toMatch(/roster_member_id\s*<>\s*p_host_roster_member_id/);
  });

  it("an active guest consumes exactly one seat", () => {
    const body = functionBody(migrationSql(), "_reservation_player_search_occupied_seats");
    expect(body).toMatch(/from public\.reservation_guests/);
  });

  it("removed participants/guests consume zero seats", () => {
    const body = functionBody(migrationSql(), "_reservation_player_search_occupied_seats");
    const occurrences = body.match(/status\s*=\s*'active'/g) ?? [];
    expect(occurrences.length).toBe(2);
  });

  it("a stale or closed search imposes no capacity ceiling", () => {
    const body = functionBody(migrationSql(), "_reservation_player_search_is_effective_open");
    expect(body).toMatch(/p_search\.is_open/);
    expect(body).toMatch(/p_search\.host_roster_member_id\s*=\s*p_reservation\.roster_member_id/);
  });

  it("add_reservation_participant cannot exceed capacity", () => {
    const body = functionBody(migrationSql(), "add_reservation_participant");
    expect(body).toContain("if v_occupied + 1 > v_search.player_capacity then");
    expect(body).toContain("raise exception 'reservation_player_search_full';");
  });

  it("participant reactivation is covered by the same capacity gate as first-time activation", () => {
    const body = functionBody(migrationSql(), "add_reservation_participant");
    const occurrences = body.match(/if v_occupied \+ 1 > v_search\.player_capacity then/g) ?? [];
    expect(occurrences.length).toBe(2);
  });

  it("add_reservation_guest cannot exceed capacity", () => {
    const body = functionBody(migrationSql(), "add_reservation_guest");
    expect(body).toContain("if v_occupied + 1 > v_search.player_capacity then");
    expect(body).toContain("raise exception 'reservation_player_search_full';");
  });

  it("no guest reactivation path exists — the capacity gate before the single unconditional INSERT covers every guest-activation path", () => {
    const currentBody = functionBody(codeOnly(readSource(ROSTER_RPC_MIGRATION_PATH)), "add_reservation_guest");
    expect(currentBody).not.toMatch(/select \* into v_existing/);
    const newBody = functionBody(migrationSql(), "add_reservation_guest");
    expect(newBody).not.toMatch(/select \* into v_existing/);
  });

  it("two concurrent last-seat joins cannot both succeed by lock-order design — scope lock, then search-row lock, then the participant loop, then the capacity check, in that order", () => {
    const body = functionBody(migrationSql(), "join_reservation_player_search");
    const scopeLockIdx = body.indexOf("perform public._lock_reservation_player_search_scope(p_reservation_id);");
    const rowLockIdx = body.indexOf("v_search := public._lock_reservation_player_search_row(p_reservation_id);");
    const loopIdx = body.indexOf("loop\n    select * into v_existing");
    const capacityCheckIdx = body.indexOf("if v_occupied + 1 > v_search.player_capacity then");
    expect(scopeLockIdx).toBeGreaterThan(0);
    expect(rowLockIdx).toBeGreaterThan(scopeLockIdx);
    expect(loopIdx).toBeGreaterThan(rowLockIdx);
    expect(capacityCheckIdx).toBeGreaterThan(loopIdx);
  });

  it("both occupied-seat formulas (0203's trigger and 0204's function) are textually parallel", () => {
    const foundationBody = functionBody(codeOnly(readSource(FOUNDATION_MIGRATION_PATH)), "enforce_reservation_player_search_domain");
    const newFormula = functionBody(migrationSql(), "_reservation_player_search_occupied_seats");
    expect(foundationBody).toMatch(/v_occupied_seats := 1 \+ v_participant_count \+ v_guest_count;/);
    expect(newFormula).toMatch(/select\s+1\s*\n\s*\+/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SEARCH STATE
// ═══════════════════════════════════════════════════════════════════════════

describe("0204 search state RPCs", () => {
  it("set/clear/get reuse _authorize_reservation_roster_access — never a separate reimplementation", () => {
    const setBody = functionBody(migrationSql(), "set_reservation_player_search");
    expect(setBody).toContain("v_reservation := public._authorize_reservation_roster_access(p_reservation_id, p_expected_club_id, true);");
    expect(migrationSql()).not.toMatch(/create or replace function public\._authorize_reservation_roster_access/);
  });

  it("open/reopen derives host_roster_member_id server-side — the caller never supplies it", () => {
    const start = migrationSql().indexOf("create or replace function public.set_reservation_player_search(");
    const sigEnd = migrationSql().indexOf(")", start);
    const signature = migrationSql().slice(start, sigEnd);
    expect(signature).not.toMatch(/host_roster_member_id/);
    const body = functionBody(migrationSql(), "set_reservation_player_search");
    expect(body).toContain("host_roster_member_id = v_reservation.roster_member_id,");
    expect(body).toContain("p_reservation_id, v_reservation.roster_member_id, p_player_capacity, true, auth.uid()");
  });

  it("clear_reservation_player_search sets is_open=false only — never rewrites host_roster_member_id, never deletes, never touches participants/guests", () => {
    const body = functionBody(migrationSql(), "clear_reservation_player_search");
    const updateIdx = body.indexOf("update public.reservation_player_searches");
    const updateStmt = body.slice(updateIdx, body.indexOf(";", updateIdx));
    expect(updateStmt).toContain("set is_open = false");
    expect(updateStmt).not.toMatch(/host_roster_member_id/);
    expect(updateStmt).not.toMatch(/player_capacity/);
    expect(body).not.toMatch(/delete from/i);
    expect(body).not.toMatch(/reservation_participants|reservation_guests/);
  });

  it("open/reopen requires member_self_service, independent of caller role", () => {
    const body = functionBody(migrationSql(), "set_reservation_player_search");
    expect(body).toContain("if not public.current_club_has_capability('member_self_service') then");
    expect(body).toContain("raise exception 'capability_not_available';");
  });

  it("operator clear remains possible when capability is disabled and host is inactive — clear never calls current_club_has_capability or checks host status", () => {
    const body = functionBody(migrationSql(), "clear_reservation_player_search");
    expect(body).not.toMatch(/current_club_has_capability/);
    expect(body).not.toMatch(/roster_members/);
  });

  it("past/cancelled/non-member_booking reservations cannot be opened", () => {
    const body = functionBody(migrationSql(), "set_reservation_player_search");
    expect(body).toContain("if v_reservation.status <> 'confirmed' then");
    expect(body).toContain("raise exception 'reservation_not_confirmed';");
    expect(body).toContain("if v_reservation.starts_at <= now() then");
    expect(body).toContain("raise exception 'reservation_already_started';");
  });

  it("set_reservation_player_search rejects a reservation with non-empty legacy guest_names", () => {
    const body = functionBody(migrationSql(), "set_reservation_player_search");
    expect(body).toContain("if v_reservation.guest_names is not null and array_length(v_reservation.guest_names, 1) is not null then");
    expect(body).toContain("raise exception 'reservation_has_legacy_guest_names';");
  });

  it("set_reservation_player_search validates the 2-8 structural capacity range with a dedicated friendly error", () => {
    const body = functionBody(migrationSql(), "set_reservation_player_search");
    expect(body).toContain("if p_player_capacity is null or p_player_capacity < 2 or p_player_capacity > 8 then");
    expect(body).toContain("raise exception 'reservation_player_capacity_out_of_range';");
  });

  it("get_reservation_player_search never mutates", () => {
    const body = functionBody(migrationSql(), "get_reservation_player_search");
    expect(body).not.toMatch(/\binsert into\b/i);
    expect(body).not.toMatch(/\bupdate\s+public\./i);
    expect(body).not.toMatch(/\bdelete from\b/i);
  });

  it("get_reservation_player_search returns effective_is_open and effective_open_block_reason, excludes host id/payment/waiver/email/phone/notes", () => {
    const start = migrationSql().indexOf("returns table (", migrationSql().indexOf("create or replace function public.get_reservation_player_search("));
    const end = migrationSql().indexOf(")", start);
    const returnShape = migrationSql().slice(start, end);
    expect(returnShape).toContain("effective_is_open");
    expect(returnShape).toContain("effective_open_block_reason");
    expect(returnShape).not.toMatch(/host_roster_member_id/);
    expect(returnShape).not.toMatch(/email|phone|payment|waiver|notes/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GUEST_NAMES BLOCK REASON
// ═══════════════════════════════════════════════════════════════════════════

describe("0204 guest_names conflict resolution", () => {
  it("effective-open predicate treats non-empty guest_names as disqualifying, without mutating the row", () => {
    const body = functionBody(migrationSql(), "_reservation_player_search_is_effective_open");
    expect(body).toMatch(/p_reservation\.guest_names is null or array_length\(p_reservation\.guest_names, 1\) is null/);
  });

  it("discovery excludes it via the shared predicate, no separate filter", () => {
    const body = functionBody(migrationSql(), "get_open_reservation_player_searches");
    expect(body).toContain("public._reservation_player_search_is_effective_open(r, s)");
  });

  it("join independently fails closed on it via the same shared predicate", () => {
    const body = functionBody(migrationSql(), "join_reservation_player_search");
    expect(body).toContain("if not public._reservation_player_search_is_effective_open(v_reservation, v_search) then");
  });

  it("no RPC ever returns the actual legacy guest_names array", () => {
    const sql = migrationSql();
    const lines = sql.split("\n").filter((l) => l.includes("guest_names"));
    for (const line of lines) {
      expect(line).not.toMatch(/select\s+.*guest_names/i);
      expect(line).not.toMatch(/,\s*guest_names\s*,/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DISCOVERY / PRIVACY
// ═══════════════════════════════════════════════════════════════════════════

describe("0204 discovery — get_open_reservation_player_searches", () => {
  it("requires a same-club, active, CLAIMED roster identity", () => {
    const body = functionBody(migrationSql(), "get_open_reservation_player_searches");
    expect(body).toContain("v_caller_roster_id := public.current_user_roster_member_id();");
    expect(body).toContain("if v_caller_roster.status is distinct from 'active' or v_caller_roster.removed_at is not null then");
  });

  it("capability required before any roster/discovery logic runs", () => {
    const body = functionBody(migrationSql(), "get_open_reservation_player_searches");
    const capIdx = body.indexOf("if not public.current_club_has_capability('member_self_service') then");
    const rosterIdx = body.indexOf("v_caller_roster_id := public.current_user_roster_member_id();");
    expect(capIdx).toBeGreaterThan(0);
    expect(rosterIdx).toBeGreaterThan(capIdx);
  });

  it("only confirmed, future, effective-open (host-eligible, guest_names-clean), non-full searches are returned", () => {
    const body = functionBody(migrationSql(), "get_open_reservation_player_searches");
    expect(body).toContain("public._reservation_player_search_is_effective_open(r, s)");
    expect(body).toMatch(/s\.player_capacity - public\._reservation_player_search_occupied_seats\(r\.id, s\.host_roster_member_id\)\) > 0/);
  });

  it("own hosted reservations are excluded", () => {
    const body = functionBody(migrationSql(), "get_open_reservation_player_searches");
    expect(body).toContain("r.roster_member_id <> v_caller_roster_id");
  });

  it("reservations where the caller already has an active participant row are excluded", () => {
    const body = functionBody(migrationSql(), "get_open_reservation_player_searches");
    expect(body).toContain("not exists (");
    expect(body).toMatch(/rp\.roster_member_id\s*=\s*v_caller_roster_id\s*\n\s*and rp\.status\s*=\s*'active'/);
  });

  it("no email, phone, roster notes, reservation notes, guest names, full participant roster, payment/pricing, or waiver state is returned", () => {
    const start = migrationSql().indexOf("returns table (", migrationSql().indexOf("create or replace function public.get_open_reservation_player_searches("));
    const end = migrationSql().indexOf(")", start);
    const returnShape = migrationSql().slice(start, end);
    expect(returnShape).not.toMatch(/email|phone|notes|payment|price|waiver|guest_name/i);
  });

  it("does not change ordinary Calendar reservation visibility", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/alter policy/i);
    expect(sql).not.toMatch(/reservations_select_same_club/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// JOIN
// ═══════════════════════════════════════════════════════════════════════════

describe("0204 join — join_reservation_player_search", () => {
  it("self-only identity resolution — no roster_member_id parameter", () => {
    const start = migrationSql().indexOf("create or replace function public.join_reservation_player_search(");
    const sigEnd = migrationSql().indexOf(")", start);
    const signature = migrationSql().slice(start, sigEnd);
    expect(signature).not.toMatch(/roster_member_id/);
    const body = functionBody(migrationSql(), "join_reservation_player_search");
    expect(body).toContain("v_roster_member_id := public.current_user_roster_member_id();");
  });

  it("the host cannot join their own booking", () => {
    const body = functionBody(migrationSql(), "join_reservation_player_search");
    expect(body).toContain("if v_reservation.roster_member_id = v_roster_member_id then");
    expect(body).toContain("raise exception 'reservation_player_search_host_cannot_join';");
  });

  it("current occupied seats are rechecked under the search-row lock, after it is acquired", () => {
    const body = functionBody(migrationSql(), "join_reservation_player_search");
    const lockIdx = body.indexOf("v_search := public._lock_reservation_player_search_row(p_reservation_id);");
    const recheckIdx = body.indexOf("v_occupied := public._reservation_player_search_occupied_seats(p_reservation_id, v_search.host_roster_member_id);");
    expect(lockIdx).toBeGreaterThan(0);
    expect(recheckIdx).toBeGreaterThan(lockIdx);
  });

  it("insert/reactivate uses reservation_participants via the identical insert-or-reactivate shape — no second roster table", () => {
    const body = functionBody(migrationSql(), "join_reservation_player_search");
    expect(body).toContain("insert into public.reservation_participants (reservation_id, roster_member_id, added_by)");
    expect(body).toContain("update public.reservation_participants");
    expect(body).not.toMatch(/create table|reservation_player_participants|reservation_search_participants/);
  });

  it("a duplicate active join does not create a second seat, row, or notification", () => {
    const body = functionBody(migrationSql(), "join_reservation_player_search");
    const activeExitIdx = body.indexOf("if v_existing_found and v_existing.status = 'active' then");
    const exitIdx = body.indexOf("exit;", activeExitIdx);
    const capacityCheckIdx = body.indexOf("if v_occupied + 1 > v_search.player_capacity then");
    const gateIdx = body.indexOf("if v_reactivated or not v_existing_found then");
    expect(activeExitIdx).toBeGreaterThan(0);
    expect(exitIdx).toBeGreaterThan(activeExitIdx);
    expect(capacityCheckIdx).toBeGreaterThan(exitIdx);
    expect(gateIdx).toBeGreaterThan(exitIdx);
  });

  it("cross-club and inactive-identity callers fail closed", () => {
    const body = functionBody(migrationSql(), "join_reservation_player_search");
    expect(body).toContain("if v_reservation.club_id <> v_club_id then");
    expect(body).toContain("raise exception 'reservation_not_found';");
    expect(body).toContain("if v_roster.status is distinct from 'active' or v_roster.removed_at is not null then");
  });

  it("no payment/pricing/checkout/refund object is touched", () => {
    const body = functionBody(migrationSql(), "join_reservation_player_search");
    expect(body).not.toMatch(/payment|price_amount_cents|hourly_rate_cents|checkout|refund|stripe/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LEAVE
// ═══════════════════════════════════════════════════════════════════════════

describe("0204 leave — leave_reservation_participation", () => {
  it("a participant may remove themselves — scoped to their own roster_member_id only", () => {
    const body = functionBody(migrationSql(), "leave_reservation_participation");
    expect(body).toContain("and roster_member_id = v_roster_member_id");
  });

  it("cannot remove another participant — no participant-id parameter exists", () => {
    const start = migrationSql().indexOf("create or replace function public.leave_reservation_participation(");
    const sigEnd = migrationSql().indexOf(")", start);
    const signature = migrationSql().slice(start, sigEnd);
    expect(signature).not.toMatch(/participant_id/);
  });

  it("the host cannot self-leave via this RPC", () => {
    const body = functionBody(migrationSql(), "leave_reservation_participation");
    expect(body).toContain("if v_reservation.roster_member_id = v_roster_member_id then");
    expect(body).toContain("raise exception 'reservation_player_search_host_cannot_leave';");
  });

  it("works even when LFP has been closed — never references the search table or is_effective_open", () => {
    const body = functionBody(migrationSql(), "leave_reservation_participation");
    expect(body).not.toMatch(/reservation_player_searches\b/);
    expect(body).not.toMatch(/_is_effective_open/);
  });

  it("soft-remove only", () => {
    const body = functionBody(migrationSql(), "leave_reservation_participation");
    expect(body).toContain("set status     = 'removed',");
    expect(body).not.toMatch(/delete from/i);
  });

  it("no payment object is touched", () => {
    const body = functionBody(migrationSql(), "leave_reservation_participation");
    expect(body).not.toMatch(/payment|price_amount_cents|hourly_rate_cents|checkout|refund|stripe/i);
  });

  it("leave does not require member_self_service", () => {
    const body = functionBody(migrationSql(), "leave_reservation_participation");
    expect(body).not.toMatch(/current_club_has_capability/);
  });

  it("leave reuses the existing cancelled-reservation roster lock", () => {
    const body = functionBody(migrationSql(), "leave_reservation_participation");
    expect(body).toContain("v_reservation := public._lock_and_validate_reservation_roster_mutable(p_reservation_id);");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY
// ═══════════════════════════════════════════════════════════════════════════

describe("0204 security posture", () => {
  const CLIENT_REACHABLE_RPCS = [
    { name: "add_reservation_participant", sig: "add_reservation_participant(uuid, uuid, uuid)" },
    { name: "add_reservation_guest", sig: "add_reservation_guest(uuid, uuid, text)" },
    { name: "set_reservation_player_search", sig: "set_reservation_player_search(uuid, uuid, int)" },
    { name: "clear_reservation_player_search", sig: "clear_reservation_player_search(uuid, uuid)" },
    { name: "get_reservation_player_search", sig: "get_reservation_player_search(uuid, uuid)" },
    { name: "get_open_reservation_player_searches", sig: "get_open_reservation_player_searches(uuid)" },
    { name: "join_reservation_player_search", sig: "join_reservation_player_search(uuid, uuid)" },
    { name: "leave_reservation_participation", sig: "leave_reservation_participation(uuid, uuid)" },
  ];

  const INTERNAL_HELPERS = [
    "_reservation_player_search_is_effective_open(public.reservations, public.reservation_player_searches)",
    "_reservation_player_search_block_reason(public.reservations, public.reservation_player_searches)",
    "_reservation_player_search_occupied_seats(uuid, uuid)",
    "_lock_reservation_player_search_row(uuid)",
    "_lock_reservation_player_search_scope(uuid)",
  ];

  it("every client-reachable RPC is revoked from public/anon and explicitly granted to authenticated", () => {
    const sql = migrationSql();
    for (const rpc of CLIENT_REACHABLE_RPCS) {
      expect(sql, `${rpc.name} missing revoke`).toMatch(
        new RegExp(`revoke execute on function public\\.${rpc.sig.replace(/[()]/g, (c) => `\\${c}`)} from public, anon;`),
      );
      expect(sql, `${rpc.name} missing grant`).toMatch(
        new RegExp(`grant\\s+execute on function public\\.${rpc.sig.replace(/[()]/g, (c) => `\\${c}`)} to authenticated;`),
      );
    }
  });

  it("every internal helper has EXECUTE revoked from public, anon, AND authenticated", () => {
    const sql = migrationSql();
    for (const helper of INTERNAL_HELPERS) {
      const escaped = helper.replace(/[()]/g, (c) => `\\${c}`).replace(/\./g, "\\.");
      expect(sql, `${helper} missing full revoke`).toMatch(
        new RegExp(`revoke execute on function public\\.${escaped}\\s+from public, anon, authenticated;`),
      );
    }
    for (const helper of INTERNAL_HELPERS) {
      const name = helper.split("(")[0];
      const grantPattern = new RegExp(`grant\\s+execute on function public\\.${name}\\(`);
      expect(sql).not.toMatch(grantPattern);
    }
  });

  it("no new direct GRANT or RLS policy is created on reservation_player_searches, reservation_participants, or reservation_guests", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/create policy/);
    expect(sql).not.toMatch(/grant .* on public\.reservation_player_searches/);
    expect(sql).not.toMatch(/grant .* on public\.reservation_participants/);
    expect(sql).not.toMatch(/grant .* on public\.reservation_guests/);
  });

  it("0203 is not modified", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/alter table public\.reservation_player_searches\b/);
    expect(sql).not.toMatch(/create or replace function public\.enforce_reservation_player_search_domain/);
    expect(sql).not.toMatch(/drop trigger.*reservation_player_searches_domain_guard/);
  });

  it("every new SECURITY DEFINER function pins search_path to public, pg_temp", () => {
    const sql = migrationSql();
    const names = [
      "_reservation_player_search_is_effective_open",
      "_reservation_player_search_block_reason",
      "_reservation_player_search_occupied_seats",
      "_lock_reservation_player_search_row",
      "_lock_reservation_player_search_scope",
      "add_reservation_participant",
      "add_reservation_guest",
      "set_reservation_player_search",
      "clear_reservation_player_search",
      "get_reservation_player_search",
      "get_open_reservation_player_searches",
      "join_reservation_player_search",
      "leave_reservation_participation",
    ];
    for (const name of names) {
      const start = sql.indexOf(`create or replace function public.${name}(`);
      expect(start, `${name} not found`).toBeGreaterThanOrEqual(0);
      const end = sql.indexOf("\n$$;", start);
      const body = sql.slice(start, end);
      expect(body, `${name} missing search_path pin`).toContain("set search_path = public, pg_temp");
      expect(body, `${name} missing security definer`).toContain("security definer");
    }
  });

  it("same-club checks fail closed and expected-club staleness is checked in every new client-reachable RPC that accepts p_expected_club_id", () => {
    for (const rpc of [
      "set_reservation_player_search",
      "clear_reservation_player_search",
      "get_reservation_player_search",
      "get_open_reservation_player_searches",
      "join_reservation_player_search",
      "leave_reservation_participation",
    ]) {
      const body = functionBody(migrationSql(), rpc);
      const usesSharedGate = body.includes("_authorize_reservation_roster_access(p_reservation_id, p_expected_club_id,");
      const hasOwnStaleCheck = body.includes("if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context';");
      expect(usesSharedGate || hasOwnStaleCheck, `${rpc} has no stale-club protection`).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// COMPATIBILITY
// ═══════════════════════════════════════════════════════════════════════════

describe("0204 compatibility — existing behavior preserved", () => {
  it("add_reservation_participant preserves every existing error code from 0179 verbatim", () => {
    const body = functionBody(migrationSql(), "add_reservation_participant");
    for (const code of [
      "roster_identity_required", "roster_member_not_found", "roster_member_inactive",
      "reservation_participant_write_failed",
    ]) {
      expect(body).toContain(`'${code}'`);
    }
  });

  it("add_reservation_guest preserves every existing error code and audit action from 0179 verbatim", () => {
    const body = functionBody(migrationSql(), "add_reservation_guest");
    expect(body).toContain("'guest_display_name_required'");
    expect(body).toContain("'guest_display_name_too_long'");
    expect(body).toContain("'add_reservation_guest'");
  });

  it("remove_reservation_participant and remove_reservation_guest are not redefined", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/create or replace function public\.remove_reservation_participant/);
    expect(sql).not.toMatch(/create or replace function public\.remove_reservation_guest/);
  });

  it("_lock_and_validate_reservation_roster_mutable and _authorize_reservation_roster_access are reused, never redefined", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/create or replace function public\._lock_and_validate_reservation_roster_mutable/);
    expect(sql).not.toMatch(/create or replace function public\._authorize_reservation_roster_access/);
  });

  it("no payment, pricing, checkout, refund, or Stripe object is touched anywhere in 0204", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/public\.payments\b/);
    expect(sql).not.toMatch(/payment_checkout_attempts/);
    expect(sql).not.toMatch(/price_amount_cents/);
    expect(sql).not.toMatch(/hourly_rate_cents/);
    expect(sql).not.toMatch(/stripe/i);
  });

  it("introduces exactly zero new tables", () => {
    const sql = migrationSql();
    expect((sql.match(/create table public\./g) ?? []).length).toBe(0);
  });
});
