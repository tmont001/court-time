import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 39B-1 — regression coverage for migration 0203
// (reservation_player_searches schema, host-snapshot domain guard,
// RLS/grants posture), using this repository's established
// source-inspection style (see reservationParticipantFoundation.
// regression.test.ts / reservationRosterRpc.regression.test.ts's own
// header comments for why: this test baseline is deliberately
// pure-TypeScript with no jsdom/Supabase/network mocking, so for "does the
// shipped migration actually take this shape" questions, reading the real
// SQL is a more honest guard than standing up a live Postgres instance in
// this suite).
//
// 0203 is NOT applied to Supabase by this checkpoint — these tests verify
// the migration FILE's content only, which is exactly what is reviewable
// before an apply.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

// Strips `--` comment-only lines so structural assertions are never
// tripped (or falsely satisfied) by this migration's own extensive
// explanatory header prose — e.g. the header discusses "reservation_open_
// play" and "skill_preference" only to say those were rejected, and
// mentions add_reservation_participant/add_reservation_guest only to
// document the still-open 39B-2 gap; those must not count as the code
// containing them.
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

const MIGRATION_PATH = "supabase/migrations/0203_reservation_player_search_foundation.sql";
const PARTICIPANT_MIGRATION_PATH = "supabase/migrations/0178_reservation_participant_foundation.sql";
const ROSTER_RPC_MIGRATION_PATH = "supabase/migrations/0179_reservation_roster_rpc_layer.sql";
const RESERVATIONS_MIGRATION_PATH = "supabase/migrations/0003_reservations.sql";

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

function tableBlock(sql: string, tableName: string): string {
  const start = sql.indexOf(`create table public.${tableName} (`);
  expect(start, `table public.${tableName} not found`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n);", start);
  expect(end, `closing "\\n);" not found for table ${tableName}`).toBeGreaterThan(start);
  return sql.slice(start, end + "\n);".length);
}

// ═══════════════════════════════════════════════════════════════════════════
// SCHEMA (items 1-6)
// ═══════════════════════════════════════════════════════════════════════════

describe("0203 schema", () => {
  it("1. exact table shape — reservation_player_searches has exactly the locked columns", () => {
    const block = tableBlock(migrationSql(), "reservation_player_searches");
    expect(block).toMatch(/id\s+uuid\s+primary key default gen_random_uuid\(\)/);
    expect(block).toMatch(/reservation_id\s+uuid\s+not null unique references public\.reservations\(id\) on delete cascade/);
    expect(block).toMatch(/host_roster_member_id\s+uuid\s+not null references public\.roster_members\(id\)/);
    expect(block).toMatch(/player_capacity\s+integer\s+not null/);
    expect(block).toMatch(/is_open\s+boolean\s+not null default true/);
    expect(block).toMatch(/created_by\s+uuid\s+not null references public\.profiles\(id\)/);
    expect(block).toMatch(/created_at\s+timestamptz\s+not null default now\(\)/);
    expect(block).toMatch(/updated_at\s+timestamptz\s+not null default now\(\)/);
  });

  it("2. reservation_id is both a foreign key AND UNIQUE (one search row per reservation, cascades on delete)", () => {
    const block = tableBlock(migrationSql(), "reservation_player_searches");
    expect(block).toMatch(/reservation_id\s+uuid\s+not null unique references public\.reservations\(id\) on delete cascade/);
  });

  it("3. host_roster_member_id is a required foreign key to roster_members with no ON DELETE clause (restrict-by-default, matching reservation_participants.roster_member_id precedent)", () => {
    const block = tableBlock(migrationSql(), "reservation_player_searches");
    expect(block).toMatch(/host_roster_member_id\s+uuid\s+not null references public\.roster_members\(id\)/);
    // No "on delete" clause anywhere on that column's own definition line.
    const line = block.split("\n").find((l) => l.includes("host_roster_member_id"))!;
    expect(line).not.toMatch(/on delete/i);
  });

  it("4. player_capacity has a structural CHECK between 2 and 8, and is never tied to reservations.format", () => {
    const block = tableBlock(migrationSql(), "reservation_player_searches");
    expect(block).toMatch(/constraint reservation_player_searches_capacity_check\s+check \(player_capacity between 2 and 8\)/);
    expect(block).not.toMatch(/format/);
  });

  it("5. no skill_preference, message, or free-text collaboration field exists anywhere in the table block", () => {
    const block = tableBlock(migrationSql(), "reservation_player_searches");
    expect(block).not.toMatch(/skill/i);
    expect(block).not.toMatch(/\bmessage\b/i);
    expect(block).not.toMatch(/\bnotes\b/i);
    expect(block).not.toMatch(/beginner|intermediate|advanced/i);
  });

  it("6. no remaining_spots (or similarly-named derived counter) column is stored", () => {
    const block = tableBlock(migrationSql(), "reservation_player_searches");
    expect(block).not.toMatch(/remaining/i);
    expect(block).not.toMatch(/occupied/i);
    expect(block).not.toMatch(/spots/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DOMAIN GUARD (items 7-14)
// ═══════════════════════════════════════════════════════════════════════════

describe("0203 domain guard — enforce_reservation_player_search_domain", () => {
  it("7. reservation_id is immutable after INSERT", () => {
    const body = functionBody(migrationSql(), "enforce_reservation_player_search_domain");
    expect(body).toContain("if tg_op = 'UPDATE' and new.reservation_id is distinct from old.reservation_id then");
    expect(body).toContain("raise exception 'reservation_player_search_reservation_immutable';");
  });

  it("8. reuses _lock_and_validate_reservation_roster_mutable (0178) rather than reimplementing the reason/cancelled/missing-parent checks", () => {
    const body = functionBody(migrationSql(), "enforce_reservation_player_search_domain");
    expect(body).toContain("v_reservation := public._lock_and_validate_reservation_roster_mutable(new.reservation_id);");
    // Must NOT redefine that shared helper in this migration.
    expect(migrationSql()).not.toMatch(/create or replace function public\._lock_and_validate_reservation_roster_mutable/);
  });

  it("9. non-member_booking and cancelled-reservation rejection come from the reused shared helper, confirmed present in 0178", () => {
    const sharedHelperSql = codeOnly(readSource(PARTICIPANT_MIGRATION_PATH));
    const body = functionBody(sharedHelperSql, "_lock_and_validate_reservation_roster_mutable");
    expect(body).toContain("if v_reservation.reason <> 'member_booking' then");
    expect(body).toContain("raise exception 'reservation_not_participant_eligible';");
    expect(body).toContain("if v_reservation.status = 'cancelled' then");
    expect(body).toContain("raise exception 'reservation_roster_locked';");
  });

  it("10. rejects a reservation with a null roster_member_id", () => {
    const body = functionBody(migrationSql(), "enforce_reservation_player_search_domain");
    expect(body).toContain("if v_reservation.roster_member_id is null then");
    expect(body).toContain("raise exception 'roster_identity_required';");
  });

  // Phase 39B host-check correction: the host check is state-dependent,
  // not a blanket "always match current reservation host" rule. INSERT and
  // any UPDATE that keeps/sets is_open=true must snapshot the
  // reservation's CURRENT host (so a reopen always re-adopts whoever owns
  // the reservation now); an UPDATE that keeps/sets is_open=false is
  // instead checked for host IMMUTABILITY against its own prior value,
  // never against the reservation — a closed search must always remain
  // closable even after the reservation has been reassigned.

  it("11. INSERT unconditionally requires host_roster_member_id to equal the reservation's CURRENT roster_member_id, regardless of the row's own is_open value — the branch condition is 'tg_op = ''INSERT'' or new.is_open', so INSERT always enters it", () => {
    const body = functionBody(migrationSql(), "enforce_reservation_player_search_domain");
    expect(body).toContain("if tg_op = 'INSERT' or new.is_open then");
  });

  it("11b. UPDATE with is_open = true requires host_roster_member_id to equal the reservation's CURRENT roster_member_id — the same branch as INSERT, proven by the nested host-mismatch check inside it", () => {
    const body = functionBody(migrationSql(), "enforce_reservation_player_search_domain");
    const branchIdx = body.indexOf("if tg_op = 'INSERT' or new.is_open then");
    expect(branchIdx).toBeGreaterThan(0);
    const nested = body.slice(branchIdx, body.indexOf("elsif", branchIdx));
    expect(nested).toContain("if new.host_roster_member_id <> v_reservation.roster_member_id then");
    expect(nested).toContain("raise exception 'reservation_player_search_host_mismatch';");
  });

  it("11c. UPDATE with is_open = false does NOT require the row's host to equal the reservation's current roster_member_id — the elsif (closed) branch never references v_reservation.roster_member_id", () => {
    const body = functionBody(migrationSql(), "enforce_reservation_player_search_domain");
    const elsifIdx = body.indexOf("elsif new.host_roster_member_id is distinct from old.host_roster_member_id then");
    expect(elsifIdx).toBeGreaterThan(0);
    const elsifBlock = body.slice(elsifIdx, body.indexOf("end if;", elsifIdx));
    expect(elsifBlock).not.toMatch(/v_reservation\.roster_member_id/);
  });

  it("11d. a closed-state update (is_open = false) cannot change host_roster_member_id — it must equal OLD.host_roster_member_id or the write is rejected", () => {
    const body = functionBody(migrationSql(), "enforce_reservation_player_search_domain");
    expect(body).toContain("elsif new.host_roster_member_id is distinct from old.host_roster_member_id then");
    expect(body).toContain("raise exception 'reservation_player_search_host_immutable_while_closed';");
  });

  it("11e. reopening (an UPDATE that sets is_open = true) may adopt a different host_roster_member_id than the row's own prior value, but only by re-validating it against the reservation's CURRENT roster_member_id — the open/reopen branch never compares against OLD", () => {
    const body = functionBody(migrationSql(), "enforce_reservation_player_search_domain");
    const branchIdx = body.indexOf("if tg_op = 'INSERT' or new.is_open then");
    const nested = body.slice(branchIdx, body.indexOf("elsif", branchIdx));
    expect(nested).not.toMatch(/old\.host_roster_member_id/);
    expect(nested).toContain("v_reservation.roster_member_id");
  });

  it("12. the null-roster check runs unconditionally, before the state-dependent host check, which itself runs before the is_open-gated capacity check", () => {
    const body = functionBody(migrationSql(), "enforce_reservation_player_search_domain");
    const nullCheckIdx = body.indexOf("if v_reservation.roster_member_id is null then");
    const hostBranchIdx = body.indexOf("if tg_op = 'INSERT' or new.is_open then");
    const capacityGateIdx = body.indexOf("if new.is_open then");
    expect(nullCheckIdx).toBeGreaterThan(0);
    expect(hostBranchIdx).toBeGreaterThan(nullCheckIdx);
    expect(capacityGateIdx).toBeGreaterThan(hostBranchIdx);
  });

  it("13. occupied-seat calculation is 1 (host) + active non-host participants + active guests", () => {
    const body = functionBody(migrationSql(), "enforce_reservation_player_search_domain");
    expect(body).toContain("v_occupied_seats := 1 + v_participant_count + v_guest_count;");
  });

  it("14. the host is never double-counted — the participant count query explicitly excludes the host's own roster_member_id", () => {
    const body = functionBody(migrationSql(), "enforce_reservation_player_search_domain");
    const participantQueryIdx = body.indexOf("select count(*) into v_participant_count");
    expect(participantQueryIdx).toBeGreaterThan(0);
    const participantQuery = body.slice(participantQueryIdx, body.indexOf(";", participantQueryIdx));
    expect(participantQuery).toMatch(/status\s*=\s*'active'/);
    expect(participantQuery).toMatch(/roster_member_id\s*<>\s*new\.host_roster_member_id/);
  });

  it("15. active guests are counted", () => {
    const body = functionBody(migrationSql(), "enforce_reservation_player_search_domain");
    const guestQueryIdx = body.indexOf("select count(*) into v_guest_count");
    expect(guestQueryIdx).toBeGreaterThan(0);
    const guestQuery = body.slice(guestQueryIdx, body.indexOf(";", guestQueryIdx));
    expect(guestQuery).toMatch(/from public\.reservation_guests/);
    expect(guestQuery).toMatch(/status\s*=\s*'active'/);
  });

  it("16. removed participants/guests are excluded from both counts (status = 'active' filter present on each query, not merely a WHERE on reservation_id)", () => {
    const body = functionBody(migrationSql(), "enforce_reservation_player_search_domain");
    const occurrences = body.match(/status\s*=\s*'active'/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it("17. an OPEN search cannot be written with player_capacity below the computed occupied-seat count", () => {
    const body = functionBody(migrationSql(), "enforce_reservation_player_search_domain");
    expect(body).toContain("if new.is_open then");
    expect(body).toContain("if new.player_capacity < v_occupied_seats then");
    expect(body).toContain("raise exception 'reservation_player_capacity_too_small';");
  });

  it("18. a CLOSED search is exempt from the capacity-vs-occupied-seats check — the check is nested inside 'if new.is_open then', not evaluated unconditionally", () => {
    const body = functionBody(migrationSql(), "enforce_reservation_player_search_domain");
    const isOpenIdx = body.indexOf("if new.is_open then");
    const capacityCheckIdx = body.indexOf("if new.player_capacity < v_occupied_seats then");
    expect(isOpenIdx).toBeGreaterThan(0);
    expect(capacityCheckIdx).toBeGreaterThan(isOpenIdx);
    // Confirm nothing about player_capacity is checked before the is_open gate.
    const beforeGate = body.slice(0, isOpenIdx);
    expect(beforeGate).not.toMatch(/player_capacity/);
  });

  it("the guard raises exactly five distinct, ordered errors — immutable reservation_id, null roster, open/reopen host mismatch, closed-state host immutability, and capacity — with no other unconditional raise anywhere in the body", () => {
    const body = functionBody(migrationSql(), "enforce_reservation_player_search_domain");
    const raiseLines = body.match(/raise exception '[a-z_]+';/g) ?? [];
    expect(raiseLines).toEqual([
      "raise exception 'reservation_player_search_reservation_immutable';",
      "raise exception 'roster_identity_required';",
      "raise exception 'reservation_player_search_host_mismatch';",
      "raise exception 'reservation_player_search_host_immutable_while_closed';",
      "raise exception 'reservation_player_capacity_too_small';",
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY (items 19-21)
// ═══════════════════════════════════════════════════════════════════════════

describe("0203 security posture", () => {
  it("19. RLS is enabled on reservation_player_searches", () => {
    expect(migrationSql()).toMatch(/alter table public\.reservation_player_searches enable row level security;/);
  });

  it("20. no client-facing RLS policy is created", () => {
    expect(migrationSql()).not.toMatch(/create policy/);
  });

  it("21. all table privileges are revoked from public, anon, and authenticated, with no compensating grant", () => {
    const sql = migrationSql();
    expect(sql).toMatch(/revoke all on public\.reservation_player_searches from public, anon, authenticated;/);
    expect(sql).not.toMatch(/grant .* on public\.reservation_player_searches/);
  });

  it("the domain guard function pins search_path to public, pg_temp and is security definer", () => {
    const body = functionBody(migrationSql(), "enforce_reservation_player_search_domain");
    expect(body).toContain("set search_path = public, pg_temp");
    expect(body).toContain("security definer");
  });

  it("direct EXECUTE on the domain guard function is revoked from public/anon/authenticated — trigger-only, never re-granted", () => {
    const sql = migrationSql();
    expect(sql).toMatch(
      /revoke execute on function public\.enforce_reservation_player_search_domain\(\)\s+from public, anon, authenticated;/,
    );
    expect(sql).not.toMatch(/grant execute .* to authenticated/);
    expect(sql).not.toMatch(/grant execute .* to anon/);
  });

  it("the domain-guard trigger fires on INSERT and UPDATE with no column-list/WHEN narrowing", () => {
    expect(migrationSql()).toMatch(
      /before insert or update\s+on public\.reservation_player_searches\s+for each row\s+execute function public\.enforce_reservation_player_search_domain\(\);/,
    );
  });

  it("updated_at reuses the existing shared trigger_set_updated_at function — no second generic timestamp helper is introduced", () => {
    const sql = migrationSql();
    expect(sql).toMatch(
      /create trigger reservation_player_searches_updated_at\s+before update on public\.reservation_player_searches\s+for each row execute function trigger_set_updated_at\(\);/,
    );
    expect(sql).not.toMatch(/create or replace function.*trigger_set_updated_at/);
    expect(sql).not.toMatch(/create or replace function public\.set_reservation_player_searches_updated_at/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// COMPATIBILITY (items 22-27)
// ═══════════════════════════════════════════════════════════════════════════

describe("0203 compatibility — existing schema/RPCs/behavior untouched", () => {
  it("22. does not alter reservations, reservation_participants, or reservation_guests table definitions", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/alter table public\.reservations\b/);
    expect(sql).not.toMatch(/alter table reservations\b/);
    expect(sql).not.toMatch(/alter table public\.reservation_participants\b/);
    expect(sql).not.toMatch(/alter table public\.reservation_guests\b/);
  });

  it("23. does not redefine any existing reservation/roster RPC from 0179 or reservation CRUD RPCs", () => {
    const sql = migrationSql();
    for (const fn of [
      "create_reservation",
      "admin_create_member_reservation",
      "update_member_reservation",
      "cancel_member_reservation",
      "admin_cancel_reservation",
      "admin_cancel_reservation_v2",
      "get_reservation_roster",
      "get_reservation_eligible_roster_members",
      "add_reservation_participant",
      "remove_reservation_participant",
      "add_reservation_guest",
      "remove_reservation_guest",
      "_authorize_reservation_roster_access",
    ]) {
      expect(sql).not.toMatch(new RegExp(`create or replace function public\\.${fn}\\(`));
    }
  });

  it("24. touches no payment, pricing, checkout, or refund object", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/public\.payments\b/);
    expect(sql).not.toMatch(/payment_events/);
    expect(sql).not.toMatch(/payment_checkout_attempts/);
    expect(sql).not.toMatch(/price_amount_cents/);
    expect(sql).not.toMatch(/hourly_rate_cents/);
    expect(sql).not.toMatch(/stripe/i);
  });

  it("25. introduces exactly one new table and zero new client-facing RPCs — no join/create/close RPC is added in this checkpoint", () => {
    const sql = migrationSql();
    expect((sql.match(/create table public\./g) ?? []).length).toBe(1);
    for (const fn of [
      "create_reservation_player_search",
      "close_reservation_player_search",
      "join_open_reservation",
      "leave_open_reservation",
      "get_open_reservations",
    ]) {
      expect(sql).not.toMatch(new RegExp(`function public\\.${fn}\\(`));
    }
  });

  it("26. reservation_player_searches does not appear in the 0178 or 0179 migration files (genuinely new in 0203)", () => {
    expect(readSource(PARTICIPANT_MIGRATION_PATH)).not.toMatch(/reservation_player_searches/);
    expect(readSource(ROSTER_RPC_MIGRATION_PATH)).not.toMatch(/reservation_player_searches/);
  });

  it("27. does not reference guest_names or player_count from the reservations table (0003) anywhere in executable SQL", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/guest_names/);
    // player_count (reservations') vs player_capacity (this table's own,
    // deliberately different name) must not be conflated.
    expect(sql).not.toMatch(/\bplayer_count\b/);
    // Sanity: reservations.player_count really does exist under that exact
    // name, confirming this isn't a false negative from a renamed column.
    expect(readSource(RESERVATIONS_MIGRATION_PATH)).toMatch(/player_count\s+int/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DOCUMENTATION OF THE STILL-OPEN 39B-2 INVARIANT (item 28)
// ═══════════════════════════════════════════════════════════════════════════

describe("0203 documents — not silently claims complete — the 39B-2 follow-up invariant", () => {
  it("28. the migration header explicitly states the capacity invariant is not yet enforced across add_reservation_participant/add_reservation_guest/reactivation paths", () => {
    const raw = rawMigrationSql();
    expect(raw).toMatch(/DOES NOT COMPLETE THE RUNTIME CAPACITY INVARIANT/);
    expect(raw).toMatch(/add_reservation_participant/);
    expect(raw).toMatch(/add_reservation_guest/);
    expect(raw).toMatch(/join_open_reservation/);
    expect(raw).toMatch(/reactivat/i);
  });
});
