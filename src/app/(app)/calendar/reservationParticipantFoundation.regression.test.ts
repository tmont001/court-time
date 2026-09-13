import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 37B — regression coverage for migration 0178 (reservation_participants
// / reservation_guests schema, domain guards, RLS/grants posture), using
// this repository's established source-inspection style (see
// staleCheckoutInvalidation.regression.test.ts's own header comment for
// why: this test baseline is deliberately pure-TypeScript with no
// jsdom/Supabase/network mocking, so for "does the shipped migration
// actually take this shape" questions, reading the real SQL is a more
// honest guard than standing up a live Postgres instance in this suite).
//
// 0178 is NOT applied to Supabase by this checkpoint — these tests verify
// the migration FILE's content only, which is exactly what is reviewable
// before an apply.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

// Strips `--` comment-only lines so structural assertions are never
// tripped (or falsely satisfied) by this migration's own extensive
// explanatory header prose — e.g. the header discusses "guest_names" and
// "player_count" only to say they are untouched, and mentions "is_booker"
// only to say it does not exist; those must not count as the code
// containing them.
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

const MIGRATION_PATH = "supabase/migrations/0178_reservation_participant_foundation.sql";

function migrationSql(): string {
  return codeOnly(readSource(MIGRATION_PATH));
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
// SCHEMA (items 1-5)
// ═══════════════════════════════════════════════════════════════════════════

describe("0178 schema", () => {
  it("1. both reservation_participants and reservation_guests tables are created", () => {
    const sql = migrationSql();
    expect(sql).toContain("create table public.reservation_participants (");
    expect(sql).toContain("create table public.reservation_guests (");
  });

  it("2. reservation_participants has a plain (non-partial) UNIQUE(reservation_id, roster_member_id) constraint", () => {
    const block = tableBlock(migrationSql(), "reservation_participants");
    expect(block).toMatch(
      /constraint reservation_participants_reservation_roster_uniq\s+unique \(reservation_id, roster_member_id\)/,
    );
    const idx = block.indexOf("reservation_participants_reservation_roster_uniq");
    // Not a partial index — no "where" clause attached to this constraint.
    expect(block.slice(idx, idx + 150)).not.toMatch(/where/i);
  });

  it("3. reservation_guests.display_name must be stored already-trimmed and 1-100 characters (canonical storage, not merely trim-aware validation)", () => {
    const block = tableBlock(migrationSql(), "reservation_guests");
    expect(block).toMatch(/constraint reservation_guests_display_name_canonical_check/);
    expect(block).toMatch(/display_name = btrim\(display_name\)/);
    expect(block).toMatch(/char_length\(display_name\) between 1 and 100/);
    // The old merely-trim-aware form must be gone, not merely supplemented.
    expect(block).not.toMatch(/char_length\(btrim\(display_name\)\)/);
  });

  it("3b. the constraint's equality predicate rejects EITHER leading or trailing whitespace, not just one side", () => {
    // display_name = btrim(display_name) is a single equality against the
    // BOTH-sides trim of the stored value — proven here by confirming the
    // migration uses btrim() (strips both ends), not ltrim()/rtrim()
    // (which would only catch one side each and let the other slip
    // through uncanonicalized).
    const block = tableBlock(migrationSql(), "reservation_guests");
    expect(block).toMatch(/display_name = btrim\(display_name\)/);
    expect(block).not.toMatch(/ltrim\(display_name\)/);
    expect(block).not.toMatch(/rtrim\(display_name\)/);
  });

  it("3c. stored canonical display_name length must be between 1 and 100 characters (post-trim, not pre-trim)", () => {
    const block = tableBlock(migrationSql(), "reservation_guests");
    // The length check applies to the raw column value directly (which the
    // other half of the same CHECK already forces to equal its own
    // btrim()), never to a re-trimmed expression — confirming there is no
    // "trim then measure" leniency that would let a stored value be
    // longer than 100 once its surrounding whitespace is discounted.
    expect(block).toMatch(/and char_length\(display_name\) between 1 and 100/);
    expect(block).not.toMatch(/char_length\(btrim\(display_name\)\) between/);
  });

  it.each(["reservation_participants", "reservation_guests"])(
    "4. %s has status in ('active','removed') and full removed_at/removed_by consistency checks",
    (table) => {
      const block = tableBlock(migrationSql(), table);
      expect(block).toMatch(/check \(status in \('active', 'removed'\)\)/);
      expect(block).toMatch(/status = 'active'\s+and removed_at is null\s+and removed_by is null/);
      expect(block).toMatch(/status = 'removed' and removed_at is not null and removed_by is not null/);
    },
  );

  it.each(["reservation_participants", "reservation_guests"])(
    "5. %s column block contains no is_booker, brought_by, email, or phone fields",
    (table) => {
      const block = tableBlock(migrationSql(), table);
      expect(block).not.toMatch(/is_booker/i);
      expect(block).not.toMatch(/brought_by/i);
      expect(block).not.toMatch(/\bemail\b/i);
      expect(block).not.toMatch(/\bphone\b/i);
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// DOMAIN (items 6-11)
// ═══════════════════════════════════════════════════════════════════════════

describe("0178 domain guards", () => {
  it("6. shared guard rejects a reservation whose reason is not member_booking", () => {
    const body = functionBody(migrationSql(), "_lock_and_validate_reservation_roster_mutable");
    expect(body).toContain("if v_reservation.reason <> 'member_booking' then");
    expect(body).toContain("raise exception 'reservation_not_participant_eligible';");
  });

  it("7. shared guard rejects mutation once the parent reservation is cancelled", () => {
    const body = functionBody(migrationSql(), "_lock_and_validate_reservation_roster_mutable");
    expect(body).toContain("if v_reservation.status = 'cancelled' then");
    expect(body).toContain("raise exception 'reservation_roster_locked';");
  });

  it("8. reservation_participants guard rejects a roster_member_id from a different club", () => {
    const body = functionBody(migrationSql(), "enforce_reservation_participant_domain");
    expect(body).toContain("if v_roster.club_id <> v_reservation.club_id then");
    expect(body).toContain("raise exception 'roster_member_wrong_club';");
  });

  it("9. reservation_participants.reservation_id is immutable after INSERT", () => {
    const body = functionBody(migrationSql(), "enforce_reservation_participant_domain");
    expect(body).toContain("if new.reservation_id is distinct from old.reservation_id then");
    expect(body).toContain("raise exception 'reservation_participant_reservation_immutable';");
  });

  it("10. reservation_participants.roster_member_id is immutable after INSERT", () => {
    const body = functionBody(migrationSql(), "enforce_reservation_participant_domain");
    expect(body).toContain("if new.roster_member_id is distinct from old.roster_member_id then");
    expect(body).toContain("raise exception 'reservation_participant_identity_immutable';");
  });

  it("11. reservation_guests.reservation_id is immutable after INSERT", () => {
    const body = functionBody(migrationSql(), "enforce_reservation_guest_domain");
    expect(body).toContain("if tg_op = 'UPDATE' and new.reservation_id is distinct from old.reservation_id then");
    expect(body).toContain("raise exception 'reservation_guest_reservation_immutable';");
  });

  it("both domain-guard triggers fire on INSERT and UPDATE with no column-list/WHEN narrowing", () => {
    const sql = migrationSql();
    expect(sql).toMatch(
      /before insert or update\s+on public\.reservation_participants\s+for each row\s+execute function public\.enforce_reservation_participant_domain\(\);/,
    );
    expect(sql).toMatch(
      /before insert or update\s+on public\.reservation_guests\s+for each row\s+execute function public\.enforce_reservation_guest_domain\(\);/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CONCURRENCY (item 12)
// ═══════════════════════════════════════════════════════════════════════════

describe("0178 concurrency", () => {
  it("12. the shared guard locks the parent reservation row FOR SHARE before validating reason/status", () => {
    const body = functionBody(migrationSql(), "_lock_and_validate_reservation_roster_mutable");
    const lockIdx = body.indexOf(
      "select * into v_reservation\n    from public.reservations\n    where id = p_reservation_id\n    for share;",
    );
    expect(lockIdx).toBeGreaterThan(0);
    const reasonCheckIdx = body.indexOf("if v_reservation.reason <> 'member_booking' then");
    const statusCheckIdx = body.indexOf("if v_reservation.status = 'cancelled' then");
    expect(reasonCheckIdx).toBeGreaterThan(lockIdx);
    expect(statusCheckIdx).toBeGreaterThan(lockIdx);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY (items 13-17)
// ═══════════════════════════════════════════════════════════════════════════

describe("0178 security posture", () => {
  it("13. RLS is enabled on both new tables", () => {
    const sql = migrationSql();
    expect(sql).toMatch(/alter table public\.reservation_participants enable row level security;/);
    expect(sql).toMatch(/alter table public\.reservation_guests\s+enable row level security;/);
  });

  it("14. no client-facing RLS policy is created on either table", () => {
    expect(migrationSql()).not.toMatch(/create policy/);
  });

  it("15. all table privileges are revoked from public, anon, and authenticated on both tables, with no compensating grant", () => {
    const sql = migrationSql();
    expect(sql).toMatch(/revoke all on public\.reservation_participants from public, anon, authenticated;/);
    expect(sql).toMatch(/revoke all on public\.reservation_guests\s+from public, anon, authenticated;/);
    expect(sql).not.toMatch(/grant .* on public\.reservation_participants/);
    expect(sql).not.toMatch(/grant .* on public\.reservation_guests/);
  });

  it("16. every new trigger/guard function pins search_path to public, pg_temp", () => {
    for (const fn of [
      "_lock_and_validate_reservation_roster_mutable",
      "enforce_reservation_participant_domain",
      "enforce_reservation_guest_domain",
    ]) {
      const body = functionBody(migrationSql(), fn);
      expect(body).toContain("set search_path = public, pg_temp");
      expect(body).toContain("security definer");
    }
  });

  it("17. direct EXECUTE is revoked from public/anon/authenticated for all three new functions — trigger-only", () => {
    const sql = migrationSql();
    expect(sql).toMatch(
      /revoke execute on function public\._lock_and_validate_reservation_roster_mutable\(uuid\)\s+from public, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /revoke execute on function public\.enforce_reservation_participant_domain\(\)\s+from public, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /revoke execute on function public\.enforce_reservation_guest_domain\(\)\s+from public, anon, authenticated;/,
    );
    // None of the three is ever re-granted to any client-facing role.
    expect(sql).not.toMatch(/grant execute .* to authenticated/);
    expect(sql).not.toMatch(/grant execute .* to anon/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// COMPATIBILITY (items 18-21)
// ═══════════════════════════════════════════════════════════════════════════

describe("0178 compatibility — existing schema/RPCs/behavior untouched", () => {
  it("18. does not alter the reservations table itself", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/alter table public\.reservations\b/);
    expect(sql).not.toMatch(/alter table reservations\b/);
  });

  it("19. does not redefine any existing reservation CRUD RPC", () => {
    const sql = migrationSql();
    for (const fn of [
      "create_reservation",
      "admin_create_member_reservation",
      "update_member_reservation",
      "cancel_member_reservation",
      "admin_cancel_reservation",
      "admin_cancel_reservation_v2",
    ]) {
      expect(sql).not.toMatch(new RegExp(`create or replace function public\\.${fn}\\(`));
    }
  });

  it("20. touches no payment, pricing, checkout, or refund object", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/public\.payments\b/);
    expect(sql).not.toMatch(/payment_events/);
    expect(sql).not.toMatch(/payment_checkout_attempts/);
    expect(sql).not.toMatch(/price_amount_cents/);
    expect(sql).not.toMatch(/hourly_rate_cents/);
  });

  it("21. does not reference guest_names or player_count anywhere in executable SQL — no backfill, no sync", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/guest_names/);
    expect(sql).not.toMatch(/player_count/);
  });

  it("introduces exactly two new tables and zero new RPCs — 37C's six RPCs are not created here", () => {
    const sql = migrationSql();
    expect((sql.match(/create table public\./g) ?? []).length).toBe(2);
    for (const fn of [
      "get_reservation_roster",
      "get_reservation_eligible_roster_members",
      "add_reservation_participant",
      "remove_reservation_participant",
      "add_reservation_guest",
      "remove_reservation_guest",
    ]) {
      expect(sql).not.toMatch(new RegExp(`function public\\.${fn}\\(`));
    }
  });
});
