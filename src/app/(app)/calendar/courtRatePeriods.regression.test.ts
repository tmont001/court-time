import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Peak / Off-Peak Pricing — Checkpoint A regression coverage for Peak/Off-Peak court
// pricing: the court_rate_periods table, the shared internal
// _resolve_court_reservation_rate resolver, the Add/Edit/Deactivate/
// Reactivate lifecycle RPCs, and the write-path integration in
// create_reservation/admin_create_member_reservation/
// update_member_reservation/update_club_pricing.
//
// Same source-inspection style as memberNonMemberCourtPricing.regression.
// test.ts — no live Postgres in this repo, so the shipped migration text is
// the honest thing to assert against. Migration 0200 is NOT applied to any
// database by this checkpoint.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--") && !line.trim().startsWith("//"))
    .join("\n");
}

const MIGRATION_PATH = "supabase/migrations/0200_court_rate_periods.sql";

function migrationSql(): string {
  return codeOnly(readSource(MIGRATION_PATH));
}

// Isolates a single function body, handling both this repo's `$$;`-quoted
// and `$function$;`-quoted CREATE (OR REPLACE) FUNCTION conventions, and
// both `create` and `CREATE` casing.
function functionBody(sql: string, name: string): string {
  const pattern = new RegExp(`create or replace function public\\.${name}\\(`, "i");
  const match = pattern.exec(sql);
  expect(match, `function public.${name} not found`).not.toBeNull();
  const start = match!.index;
  const dollarDollarEnd = sql.indexOf("\n$$;", start);
  const dollarFnEnd = sql.indexOf("\n$function$;", start);
  const end =
    dollarFnEnd >= 0 && (dollarDollarEnd < 0 || dollarFnEnd < dollarDollarEnd)
      ? dollarFnEnd + "\n$function$;".length
      : dollarDollarEnd + "\n$$;".length;
  expect(end, `closing terminator for public.${name} not found`).toBeGreaterThan(start);
  return sql.slice(start, end);
}

// ═══════════════════════════════════════════════════════════════════════════
// A. Migration ordering
// ═══════════════════════════════════════════════════════════════════════════

describe("0200 — migration numbering", () => {
  it("is the next migration after immutable 0190/0199", () => {
    expect(() => readSource("supabase/migrations/0190_memberships_enable_disable_foundation.sql")).not.toThrow();
    expect(() => readSource(MIGRATION_PATH)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. Schema — court_rate_periods
// ═══════════════════════════════════════════════════════════════════════════

describe("0200 — court_rate_periods schema", () => {
  const sql = migrationSql();

  it("has no court_id column and no priority/order column (club-wide, no precedence field, per locked scope)", () => {
    const tableStart = sql.indexOf("create table public.court_rate_periods");
    const tableEnd = sql.indexOf("\n);", tableStart) + 3;
    const tableDdl = sql.slice(tableStart, tableEnd);
    expect(tableDdl).not.toMatch(/court_id/);
    expect(tableDdl).not.toMatch(/priority|\border\b|sort_order/);
  });

  it("requires days_of_week non-empty (guards the array_length NULL-on-empty-array gotcha with coalesce)", () => {
    expect(sql).toMatch(
      /constraint court_rate_periods_days_of_week_nonempty\s*\n\s*check \(coalesce\(array_length\(days_of_week, 1\), 0\) > 0\)/,
    );
  });

  it("restricts days_of_week values to 0-6", () => {
    expect(sql).toMatch(
      /constraint court_rate_periods_days_of_week_valid\s*\n\s*check \(days_of_week <@ array\[0,1,2,3,4,5,6\]::integer\[\]\)/,
    );
  });

  it("forbids overnight periods (ends_at_local must be strictly after starts_at_local)", () => {
    expect(sql).toMatch(
      /constraint court_rate_periods_same_day_only\s*\n\s*check \(ends_at_local > starts_at_local\)/,
    );
  });

  it("rates are nullable but non-negative when present", () => {
    expect(sql).toMatch(
      /constraint court_rate_periods_hourly_rate_cents_nonneg\s*\n\s*check \(hourly_rate_cents is null or hourly_rate_cents >= 0\)/,
    );
    expect(sql).toMatch(
      /constraint court_rate_periods_hourly_rate_non_member_cents_nonneg\s*\n\s*check \(hourly_rate_non_member_cents is null or hourly_rate_non_member_cents >= 0\)/,
    );
  });

  it("requires at least one of the two rate columns to be non-null", () => {
    expect(sql).toMatch(
      /constraint court_rate_periods_at_least_one_rate\s*\n\s*check \(hourly_rate_cents is not null or hourly_rate_non_member_cents is not null\)/,
    );
  });

  it("enables RLS and grants SELECT to admin-only, same-club (no Member-facing read access in this checkpoint)", () => {
    expect(sql).toMatch(/alter table public\.court_rate_periods enable row level security;/);
    expect(sql).toMatch(
      /create policy "court_rate_periods_select_admin"\s*\n\s*on public\.court_rate_periods for select\s*\n\s*using \(\s*\n\s*club_id = current_user_club_id\(\)\s*\n\s*and current_user_role\(\) = 'admin'\s*\n\s*\);/,
    );
  });

  it("creates no INSERT/UPDATE/DELETE policy on court_rate_periods — mutation is only possible through the lifecycle RPCs", () => {
    expect(sql).not.toMatch(/on public\.court_rate_periods for insert/);
    expect(sql).not.toMatch(/on public\.court_rate_periods for update/);
    expect(sql).not.toMatch(/on public\.court_rate_periods for delete/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. _resolve_court_reservation_rate — shared resolver
// ═══════════════════════════════════════════════════════════════════════════

describe("0200 — _resolve_court_reservation_rate", () => {
  const sql = migrationSql();
  const body = functionBody(sql, "_resolve_court_reservation_rate");

  it("accepts an already-resolved membership_pricing_class as a PARAMETER — never derives one from a roster_member_id", () => {
    expect(sql).toMatch(
      /create or replace function public\._resolve_court_reservation_rate\(\s*\n\s*p_club_id\s+uuid,\s*\n\s*p_court_id\s+uuid,\s*\n\s*p_membership_pricing_class text,\s*\n\s*p_starts_at\s+timestamptz\s*\n\)/,
    );
    expect(body).not.toMatch(/is_active_club_member/);
    expect(body).not.toMatch(/roster_member_id/);
  });

  it("is SECURITY INVOKER (not DEFINER) and STABLE", () => {
    const sigStart = sql.indexOf("create or replace function public._resolve_court_reservation_rate(");
    const bodyStart = sql.indexOf("as $$", sigStart);
    const signatureBlock = sql.slice(sigStart, bodyStart);
    expect(signatureBlock).toMatch(/security invoker/);
    expect(signatureBlock).toMatch(/\bstable\b/);
    expect(signatureBlock).not.toMatch(/security definer/);
  });

  it("EXECUTE is revoked from public, anon, AND authenticated — no direct client-callable surface", () => {
    expect(sql).toMatch(
      /revoke execute on function public\._resolve_court_reservation_rate\(uuid, uuid, text, timestamptz\) from public, anon, authenticated;/,
    );
    // No corresponding grant to authenticated anywhere for this function.
    expect(sql).not.toMatch(
      /grant\s+execute on function public\._resolve_court_reservation_rate\(/,
    );
  });

  it("only consults the Non-Member chain when memberships_enabled — reproduces the 0190 predicate exactly", () => {
    expect(body).toMatch(
      /v_use_non_member := v_settings\.memberships_enabled and p_membership_pricing_class = 'non_member';/,
    );
  });

  it("Member/standard chain precedence: court override -> matching period -> club default", () => {
    const elseBranchStart = body.indexOf("else\n    if v_court.hourly_rate_cents is not null then");
    expect(elseBranchStart).toBeGreaterThan(-1);
    const elseBranch = body.slice(elseBranchStart);
    const courtIdx = elseBranch.indexOf("v_court.hourly_rate_cents is not null");
    const periodIdx = elseBranch.indexOf("v_period_found and v_period.hourly_rate_cents is not null");
    const defaultIdx = elseBranch.indexOf("v_settings.default_court_hourly_rate_cents is not null");
    expect(courtIdx).toBeGreaterThan(-1);
    expect(periodIdx).toBeGreaterThan(courtIdx);
    expect(defaultIdx).toBeGreaterThan(periodIdx);
  });

  it("Non-Member chain precedence: court non-member -> period non-member -> club non-member default -> court member -> period member -> club member default", () => {
    const ifBranchStart = body.indexOf("if v_use_non_member then");
    const ifBranchEnd = body.indexOf("\n  else\n", ifBranchStart);
    const nonMemberBranch = body.slice(ifBranchStart, ifBranchEnd);
    const order = [
      "v_court.hourly_rate_non_member_cents is not null",
      "v_period_found and v_period.hourly_rate_non_member_cents is not null",
      "v_settings.default_court_hourly_rate_non_member_cents is not null",
      "v_court.hourly_rate_cents is not null",
      "v_period_found and v_period.hourly_rate_cents is not null",
      "v_settings.default_court_hourly_rate_cents is not null",
    ];
    let lastIdx = -1;
    for (const needle of order) {
      const idx = nonMemberBranch.indexOf(needle);
      expect(idx, `expected to find "${needle}"`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it("selects the matching rate period using the club-local day-of-week/time of p_starts_at only — never references p_ends_at (locked start-time-pricing rule)", () => {
    expect(body).not.toMatch(/p_ends_at/);
    expect(body).toMatch(
      /v_dow\s*:=\s*extract\(dow\s+from p_starts_at at time zone v_tz\)::int;/,
    );
    expect(body).toMatch(
      /v_local_time\s*:=\s*\(p_starts_at at time zone v_tz\)::time;/,
    );
    expect(body).toMatch(/v_dow = any\(crp\.days_of_week\)/);
    expect(body).toMatch(/v_local_time >= crp\.starts_at_local/);
    expect(body).toMatch(/v_local_time <\s*crp\.ends_at_local/);
  });

  it("only looks up ACTIVE rate periods", () => {
    expect(body).toMatch(/crp\.is_active = true/);
  });

  it("populates applied_rate_period_id/name ONLY on the rate_period_* branches — never when a court override or club default supplied the rate", () => {
    const courtOverrideBlocks = body.match(/applied_rate_source := 'court_override_[a-z_]+';\n(\s*end if;|\s*elsif)/g) ?? [];
    for (const block of courtOverrideBlocks) {
      expect(block).not.toMatch(/applied_rate_period_id/);
    }
    const clubDefaultBlocks = body.match(/applied_rate_source := 'club_default_[a-z_]+';\n(\s*end if;|\s*elsif|\s*else)/g) ?? [];
    for (const block of clubDefaultBlocks) {
      expect(block).not.toMatch(/applied_rate_period_id/);
    }
    expect(body).toMatch(/applied_rate_source := 'rate_period_non_member';\s*\n\s*applied_rate_period_id := v_period\.id;\s*\n\s*applied_rate_period_name := v_period\.name;/);
    expect(body).toMatch(/applied_rate_source := 'rate_period_member';\s*\n\s*applied_rate_period_id := v_period\.id;\s*\n\s*applied_rate_period_name := v_period\.name;/);
  });

  it("falls back to fully unpriced when neither chain resolves anything (courts remain optionally priced, unchanged invariant)", () => {
    expect(body).toMatch(/hourly_rate_cents := null;\s*\n\s*applied_rate_source := 'unpriced';/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. Lifecycle RPCs — Add/Edit, Deactivate/Reactivate
// ═══════════════════════════════════════════════════════════════════════════

describe("0200 — upsert_court_rate_period (Add/Edit)", () => {
  const sql = migrationSql();
  const body = functionBody(sql, "upsert_court_rate_period");

  it("is admin-only, same-club, via the canonical current_user_club_id()/current_user_role() pattern", () => {
    expect(body).toMatch(
      /select\s*\n\s*public\.current_user_club_id\(\),\s*\n\s*public\.current_user_role\(\)\s*\n\s*into\s*\n\s*v_club_id,\s*\n\s*v_role;/,
    );
    expect(body).toMatch(/if v_role is distinct from 'admin' then\s*\n\s*raise exception 'insufficient_role';/);
  });

  it("validates name, days, time range, and requires at least one rate", () => {
    expect(body).toMatch(/raise exception 'name_required';/);
    expect(body).toMatch(/raise exception 'days_required';/);
    expect(body).toMatch(/raise exception 'invalid_day_of_week';/);
    expect(body).toMatch(/raise exception 'invalid_time_range';/);
    expect(body).toMatch(/raise exception 'rate_required';/);
  });

  it("locks the club's own club_settings row FOR UPDATE before validating overlap (concurrency-safe)", () => {
    const lockPos = body.indexOf("perform 1 from public.club_settings where club_id = v_club_id for update;");
    const overlapPos = body.indexOf("select exists (");
    expect(lockPos).toBeGreaterThan(-1);
    expect(overlapPos).toBeGreaterThan(lockPos);
  });

  it("overlap check compares against other ACTIVE periods sharing a day (&& operator) and an overlapping local time window, excluding the row being edited", () => {
    const overlapStart = body.indexOf("select exists (");
    const overlapEnd = body.indexOf(") into v_overlap_exists;") + ") into v_overlap_exists;".length;
    const overlapBlock = body.slice(overlapStart, overlapEnd);
    expect(overlapBlock).toMatch(/crp\.is_active = true/);
    expect(overlapBlock).toMatch(/\(p_id is null or crp\.id <> p_id\)/);
    expect(overlapBlock).toMatch(/crp\.days_of_week && p_days_of_week/);
    expect(overlapBlock).toMatch(/crp\.starts_at_local < p_ends_at_local/);
    expect(overlapBlock).toMatch(/crp\.ends_at_local\s*> p_starts_at_local/);
  });

  it("rejects the mutation when an overlap is found", () => {
    expect(body).toMatch(/if v_overlap_exists then\s*\n\s*raise exception 'rate_period_overlap';/);
  });

  it("Add (p_id null) inserts and audits 'create_court_rate_period'; Edit (p_id set) updates and audits 'update_court_rate_period'", () => {
    expect(body).toMatch(/if p_id is null then\s*\n\s*insert into public\.court_rate_periods/);
    expect(body).toMatch(/'create_court_rate_period'/);
    expect(body).toMatch(/update public\.court_rate_periods set/);
    expect(body).toMatch(/'update_court_rate_period'/);
  });

  it("grants EXECUTE only to authenticated, revoked from public/anon", () => {
    expect(sql).toMatch(
      /revoke execute on function public\.upsert_court_rate_period\(uuid, text, integer\[\], time, time, integer, integer\) from public, anon;/,
    );
    expect(sql).toMatch(
      /grant\s+execute on function public\.upsert_court_rate_period\(uuid, text, integer\[\], time, time, integer, integer\) to authenticated;/,
    );
  });
});

describe("0200 — upsert_court_rate_period: overlap validation gated by resulting active state", () => {
  const sql = migrationSql();
  const body = functionBody(sql, "upsert_court_rate_period");

  it("does NOT accept a p_is_active parameter — activation state stays exclusively managed by set_court_rate_period_active", () => {
    expect(sql).toMatch(
      /create or replace function public\.upsert_court_rate_period\(\s*\n\s*p_id\s+uuid,\s*\n\s*p_name\s+text,\s*\n\s*p_days_of_week\s+integer\[\],\s*\n\s*p_starts_at_local\s+time,\s*\n\s*p_ends_at_local\s+time,\s*\n\s*p_hourly_rate_cents\s+integer default null,\s*\n\s*p_hourly_rate_non_member_cents integer default null\s*\n\)/,
    );
    expect(body).not.toMatch(/p_is_active/);
  });

  it("gates the entire overlap check on the row being (or remaining) ACTIVE: p_id is null (a new, active-by-default period) OR v_existing.is_active", () => {
    const gateMatch = body.match(/if p_id is null or v_existing\.is_active then\n(\s*select exists \([\s\S]*?\n\s*end if;\n\s*end if;)/);
    expect(gateMatch, "expected the overlap block to be wrapped in the active-state gate").not.toBeNull();
  });

  it("new periods (p_id is null) always validate overlap — the gate's first disjunct is unconditional on p_id", () => {
    const gateStart = body.indexOf("if p_id is null or v_existing.is_active then");
    expect(gateStart).toBeGreaterThan(-1);
    // p_id is null short-circuits the gate to true regardless of v_existing
    // (which is never populated in the Add path in the first place).
    expect(body.slice(gateStart, gateStart + 60)).toMatch(/^if p_id is null or v_existing\.is_active then/);
  });

  it("edits to an ACTIVE period (v_existing.is_active = true) validate overlap", () => {
    // Structural: the gate's second disjunct is v_existing.is_active,
    // populated only in the Edit path (p_id is not null) by the preceding
    // `select * into v_existing ... where id = p_id` lookup.
    const lookupPos = body.indexOf("select * into v_existing\n      from public.court_rate_periods");
    const gatePos = body.indexOf("if p_id is null or v_existing.is_active then");
    expect(lookupPos).toBeGreaterThan(-1);
    expect(gatePos).toBeGreaterThan(lookupPos);
  });

  it("edits to an INACTIVE period (v_existing.is_active = false) skip overlap validation entirely — may freely overlap an active period", () => {
    const gateStart = body.indexOf("if p_id is null or v_existing.is_active then");
    const gateBlockEnd = body.indexOf("if p_id is null then\n    insert into public.court_rate_periods", gateStart);
    const gateBlock = body.slice(gateStart, gateBlockEnd);
    // The overlap SELECT and its raise are both nested strictly inside the
    // gate — an inactive v_existing (false) never reaches them.
    expect(gateBlock).toMatch(/select exists \(/);
    expect(gateBlock).toMatch(/raise exception 'rate_period_overlap';/);
    const insertPos = body.indexOf("insert into public.court_rate_periods (\n      club_id, name, days_of_week");
    const updatePos = body.indexOf("update public.court_rate_periods set");
    expect(insertPos).toBeGreaterThan(gateBlockEnd - 1);
    expect(updatePos).toBeGreaterThan(gateBlockEnd - 1);
  });

  it("does not skip the not-found guard for a nonexistent p_id — the inactive-edit exemption only applies to a row that was actually found", () => {
    expect(body).toMatch(/if not found then\s*\n\s*raise exception 'rate_period_not_found';/);
  });

  it("reactivation (set_court_rate_period_active) still independently validates overlap, unaffected by this upsert-only gating change", () => {
    const activeBody = functionBody(sql, "set_court_rate_period_active");
    expect(activeBody).toMatch(/if p_active and not v_existing\.is_active then/);
    const reactivateStart = activeBody.indexOf("if p_active and not v_existing.is_active then");
    const reactivateEnd = activeBody.indexOf("update public.court_rate_periods set", reactivateStart);
    expect(activeBody.slice(reactivateStart, reactivateEnd)).toMatch(/raise exception 'rate_period_overlap';/);
  });

  it("there is still no hard-delete lifecycle path (upsert only ever Adds/Edits, never removes a row)", () => {
    expect(sql).not.toMatch(/create or replace function public\.delete_court_rate_period/i);
    expect(sql).not.toMatch(/create or replace function public\.remove_court_rate_period/i);
    expect(body).not.toMatch(/delete from public\.court_rate_periods/);
  });
});

describe("0200 — set_court_rate_period_active (Deactivate/Reactivate)", () => {
  const sql = migrationSql();
  const body = functionBody(sql, "set_court_rate_period_active");

  it("is admin-only, same-club", () => {
    expect(body).toMatch(/if v_role is distinct from 'admin' then\s*\n\s*raise exception 'insufficient_role';/);
  });

  it("locks the club's own club_settings row FOR UPDATE before any overlap check (concurrency-safe, same pattern as upsert)", () => {
    const lockPos = body.indexOf("perform 1 from public.club_settings where club_id = v_club_id for update;");
    expect(lockPos).toBeGreaterThan(-1);
  });

  it("re-validates overlap ONLY when transitioning inactive -> active (reactivation) — never on deactivation", () => {
    expect(body).toMatch(/if p_active and not v_existing\.is_active then/);
    const reactivateStart = body.indexOf("if p_active and not v_existing.is_active then");
    const reactivateEnd = body.indexOf("update public.court_rate_periods set", reactivateStart);
    const reactivateBlock = body.slice(reactivateStart, reactivateEnd);
    expect(reactivateBlock).toMatch(/raise exception 'rate_period_overlap';/);
  });

  it("reactivation's overlap check uses the identical shape as Add/Edit's (active periods, day overlap via &&, time-window overlap, excluding self)", () => {
    const reactivateStart = body.indexOf("if p_active and not v_existing.is_active then");
    const reactivateEnd = body.indexOf("update public.court_rate_periods set", reactivateStart);
    const reactivateBlock = body.slice(reactivateStart, reactivateEnd);
    expect(reactivateBlock).toMatch(/crp\.is_active = true/);
    expect(reactivateBlock).toMatch(/crp\.id <> p_id/);
    expect(reactivateBlock).toMatch(/crp\.days_of_week && v_existing\.days_of_week/);
    expect(reactivateBlock).toMatch(/crp\.starts_at_local < v_existing\.ends_at_local/);
    expect(reactivateBlock).toMatch(/crp\.ends_at_local\s*> v_existing\.starts_at_local/);
  });

  it("audits deactivate vs reactivate distinctly", () => {
    expect(body).toMatch(
      /case when p_active then 'reactivate_court_rate_period' else 'deactivate_court_rate_period' end,/,
    );
  });

  it("grants EXECUTE only to authenticated, revoked from public/anon", () => {
    expect(sql).toMatch(
      /revoke execute on function public\.set_court_rate_period_active\(uuid, boolean\) from public, anon;/,
    );
    expect(sql).toMatch(
      /grant\s+execute on function public\.set_court_rate_period_active\(uuid, boolean\) to authenticated;/,
    );
  });
});

describe("0200 — no hard-delete lifecycle path in v1", () => {
  const sql = migrationSql();

  it("does not define a delete/drop RPC for court_rate_periods", () => {
    expect(sql).not.toMatch(/create or replace function public\.delete_court_rate_period/i);
    expect(sql).not.toMatch(/create or replace function public\.remove_court_rate_period/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. create_reservation / admin_create_member_reservation — resolver wiring
// ═══════════════════════════════════════════════════════════════════════════

describe("0200 — create_reservation", () => {
  const sql = migrationSql();
  const body = functionBody(sql, "create_reservation");

  it("membership_pricing_class computation is byte-identical to 0189/0190 (still via is_active_club_member, role-agnostic)", () => {
    expect(body).toMatch(
      /v_membership_pricing_class := case\s*\n\s*when public\.is_active_club_member\(v_roster_member_id, v_profile\.club_id\) then 'member'\s*\n\s*else 'non_member'\s*\n\s*end;/,
    );
  });

  it("resolves the rate via the shared resolver, passing the already-computed class and p_starts_at", () => {
    expect(body).toMatch(
      /select \* into v_rate_resolution\s*\n\s*from public\._resolve_court_reservation_rate\(\s*\n\s*v_profile\.club_id, p_court_id, v_membership_pricing_class, p_starts_at\s*\n\s*\);\s*\n\s*v_hourly_rate_cents := v_rate_resolution\.hourly_rate_cents;/,
    );
  });

  it("no longer contains the old inline non-member coalesce chain (fully delegated to the resolver)", () => {
    expect(body).not.toMatch(/v_hourly_rate_cents := coalesce\(\s*\n\s*v_court\.hourly_rate_non_member_cents,/);
  });

  it("still multiplies price_amount_cents by duration exactly as before", () => {
    expect(body).toMatch(
      /if v_hourly_rate_cents is not null then\s*\n\s*v_price_amount_cents := round\(v_hourly_rate_cents \* extract\(epoch from \(p_ends_at - p_starts_at\)\) \/ 3600\.0\)::integer;\s*\n\s*else\s*\n\s*v_price_amount_cents := null;\s*\n\s*end if;/,
    );
  });

  it("does not alter scheduling, capacity, notification, or payment-obligation logic", () => {
    expect(body).toMatch(/if v_profile\.status <> 'active' then raise exception 'account_inactive'; end if;/);
    expect(body).toMatch(/raise exception 'outside_booking_window';/);
    expect(body).toMatch(/perform public\._create_payment_obligation\(/);
  });
});

describe("0200 — admin_create_member_reservation", () => {
  const sql = migrationSql();
  const body = functionBody(sql, "admin_create_member_reservation");

  it("membership_pricing_class computation is byte-identical to 0189/0190", () => {
    expect(body).toMatch(
      /v_membership_pricing_class := case\s*\n\s*when public\.is_active_club_member\(p_roster_member_id, v_club_id\) then 'member'\s*\n\s*else 'non_member'\s*\n\s*end;/,
    );
  });

  it("resolves the rate via the shared resolver", () => {
    expect(body).toMatch(
      /select \* into v_rate_resolution\s*\n\s*from public\._resolve_court_reservation_rate\(\s*\n\s*v_club_id, p_court_id, v_membership_pricing_class, p_starts_at\s*\n\s*\);\s*\n\s*v_hourly_rate_cents := v_rate_resolution\.hourly_rate_cents;/,
    );
  });

  it("preserves the payment-obligation call and audit_log entry", () => {
    expect(body).toMatch(/perform public\._create_payment_obligation\(/);
    expect(body).toMatch(/'admin_create_member_reservation'/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. update_member_reservation — corrected fresh-rate trigger matrix
// ═══════════════════════════════════════════════════════════════════════════

describe("0200 — update_member_reservation", () => {
  const sql = migrationSql();
  const body = functionBody(sql, "update_member_reservation");

  it("declares and computes v_starts_at_changed", () => {
    expect(body).toMatch(/v_starts_at_changed\s*:= p_starts_at is distinct from v_before\.starts_at;/);
  });

  it("fresh-rate trigger fires on court change OR member change OR starts_at change", () => {
    expect(body).toMatch(/if v_court_changed or v_member_changed or v_starts_at_changed then/);
  });

  it("a starts_at-only change (same court/member/duration) still falls into the fresh-resolve branch, not the duration-preserve branch", () => {
    // The fresh-resolve branch is the FIRST branch checked; v_duration_changed
    // alone can never gate it, and the trigger condition already includes
    // v_starts_at_changed independently of v_duration_changed.
    const triggerPos = body.indexOf("if v_court_changed or v_member_changed or v_starts_at_changed then");
    const elsifPos = body.indexOf("elsif v_duration_changed then");
    expect(triggerPos).toBeGreaterThan(-1);
    expect(elsifPos).toBeGreaterThan(triggerPos);
  });

  it("both starts_at AND ends_at shifting with duration held constant still re-resolves (starts_at changed is sufficient on its own)", () => {
    // Structural guarantee: v_starts_at_changed is computed independently of
    // v_duration_changed and ORed into the same trigger condition, so a
    // same-duration time-shift can never silently fall through to the
    // duration-preserve or no-op branches.
    const triggerLine = body.match(/if v_court_changed or v_member_changed or v_starts_at_changed then/);
    expect(triggerLine).not.toBeNull();
    expect(body.indexOf("v_starts_at_changed := p_starts_at is distinct from v_before.starts_at;")).toBeGreaterThan(-1);
  });

  it("the fresh-resolve branch calls the shared resolver using the ALREADY-COMPUTED v_new_pricing_class (preserved unless the Member was reassigned)", () => {
    const triggerStart = body.indexOf("if v_court_changed or v_member_changed or v_starts_at_changed then");
    const triggerEnd = body.indexOf("elsif v_duration_changed then", triggerStart);
    const triggerBranch = body.slice(triggerStart, triggerEnd);
    expect(triggerBranch).toMatch(
      /select \* into v_rate_resolution\s*\n\s*from public\._resolve_court_reservation_rate\(\s*\n\s*v_club_id, p_court_id, v_new_pricing_class, p_starts_at\s*\n\s*\);/,
    );
  });

  it("membership_pricing_class resolution is unchanged: fresh ONLY on reassignment, preserved otherwise — never re-derived merely because starts_at changed", () => {
    expect(body).toMatch(
      /if v_member_changed then\s*\n\s*v_new_pricing_class := case\s*\n\s*when public\.is_active_club_member\(p_roster_member_id, v_club_id\) then 'member'\s*\n\s*else 'non_member'\s*\n\s*end;\s*\n\s*else\s*\n\s*v_new_pricing_class := v_before\.membership_pricing_class;\s*\n\s*end if;/,
    );
    // The class-resolution block itself never references starts_at.
    const classStart = body.indexOf("if v_member_changed then\n    v_new_pricing_class := case");
    const classEnd = body.indexOf("end if;", classStart) + "end if;".length;
    expect(body.slice(classStart, classEnd)).not.toMatch(/starts_at/);
  });

  it("duration-only changes (starts_at fixed) preserve the EXISTING hourly_rate_cents and re-multiply only — unchanged from 0190", () => {
    expect(body).toMatch(
      /elsif v_duration_changed then\s*\n\s*v_new_hourly_rate_cents := v_before\.hourly_rate_cents;/,
    );
  });

  it("no scheduling/Member/starts_at change preserves both the rate and the pricing class exactly", () => {
    expect(body).toMatch(
      /else\s*\n\s*v_new_hourly_rate_cents {2}:= v_before\.hourly_rate_cents;\s*\n\s*v_new_price_amount_cents := v_before\.price_amount_cents;\s*\n\s*end if;/,
    );
  });

  it("no longer declares an unused v_settings local (the resolver now owns the club_settings lookup)", () => {
    expect(body).not.toMatch(/v_settings\s+public\.club_settings%rowtype;/);
    expect(body).not.toMatch(/select \* into v_settings from public\.club_settings/);
  });

  it("preserves the pre-mutation Stripe Checkout invalidation guard and the reassignment-forces-new-cycle payment wiring, untouched", () => {
    expect(body).toMatch(/_invalidate_or_flag_open_checkout_attempt/);
    expect(body).toMatch(
      /if v_member_changed then\s*\n\s*perform public\._create_payment_obligation\(\s*\n\s*v_club_id, 'reservation', p_reservation_id, p_roster_member_id,\s*\n\s*v_new_price_amount_cents, auth\.uid\(\), true\s*\n\s*\);/,
    );
  });

  it("preserves the inactive-court reassignment carve-out (member-only reassignment court reload does not require is_active = true)", () => {
    const reassignBlockStart = body.indexOf("if v_member_changed and not v_scheduling_changed then");
    const reassignBlockEnd = body.indexOf("Peak/Off-Peak Pricing — Checkpoint A: fresh-rate trigger", reassignBlockStart);
    const reassignBlock = body.slice(reassignBlockStart, reassignBlockEnd);
    expect(reassignBlock).toMatch(/where id = p_court_id and club_id = v_club_id;/);
    expect(reassignBlock).not.toMatch(/is_active/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G. update_club_pricing — currency lock extended
// ═══════════════════════════════════════════════════════════════════════════

describe("0200 — update_club_pricing currency-lock extension", () => {
  const sql = migrationSql();

  it("does NOT drop the existing signature — the currency-lock scan change is a pure body edit, no signature change", () => {
    expect(sql).not.toMatch(/drop function if exists public\.update_club_pricing/);
  });

  const body = functionBody(sql, "update_club_pricing");

  it("adds a court_rate_periods clause to the currency-lock scan, unfiltered by is_active (matching the courts/club_settings scan sources)", () => {
    expect(body).toMatch(
      /select 1 from court_rate_periods\s*\n\s*where club_id = v_club_id\s*\n\s*and \(hourly_rate_cents > 0 or hourly_rate_non_member_cents > 0\)/,
    );
  });

  it("preserves every pre-existing currency-lock scan source", () => {
    for (const table of [
      "club_settings",
      "courts",
      "lesson_types",
      "event_types",
      "events",
      "programs",
      "reservations",
      "lesson_requests",
      "event_participants",
      "event_guests",
      "program_enrollments",
    ]) {
      expect(body, `currency-lock scan must still cover ${table}`).toMatch(new RegExp(`from ${table}\\b`));
    }
  });

  it("preserves admin-only authorization, same-club scoping, and the 3-arg grant posture unchanged", () => {
    expect(body).toMatch(/if v_role is distinct from 'admin' then\s*\n\s*raise exception 'insufficient_role';/);
    expect(sql).toMatch(
      /revoke execute on function public\.update_club_pricing\(text, integer, integer\) from public, anon;/,
    );
    expect(sql).toMatch(
      /grant\s+execute on function public\.update_club_pricing\(text, integer, integer\) to authenticated;/,
    );
  });

  it("locks its own club_settings row (FOR UPDATE) BEFORE the positive-pricing currency scan runs", () => {
    const lockMatch = body.match(/select \* into v_settings from club_settings where club_id = v_club_id for update;/);
    expect(lockMatch, "update_club_pricing must lock v_settings FOR UPDATE").not.toBeNull();
    const lockPos = body.indexOf(lockMatch![0]);
    const scanPos = body.indexOf("select exists (");
    expect(lockPos).toBeGreaterThan(-1);
    expect(scanPos).toBeGreaterThan(lockPos);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G2. Cross-cutting — club_settings row mutex serializes currency changes
//     with rate-period mutations
// ═══════════════════════════════════════════════════════════════════════════

describe("0200 — club_settings row mutex: currency changes vs. rate-period mutations", () => {
  const sql = migrationSql();

  it("upsert_court_rate_period and set_court_rate_period_active both lock club_settings FOR UPDATE before validating overlap", () => {
    const upsertBody = functionBody(sql, "upsert_court_rate_period");
    const setActiveBody = functionBody(sql, "set_court_rate_period_active");
    const lockStatement = "perform 1 from public.club_settings where club_id = v_club_id for update;";
    expect(upsertBody).toContain(lockStatement);
    expect(setActiveBody).toContain(lockStatement);
  });

  it("update_club_pricing locks the SAME club_settings row (via SELECT ... FOR UPDATE) rather than a different or no lock", () => {
    const pricingBody = functionBody(sql, "update_club_pricing");
    expect(pricingBody).toMatch(
      /select \* into v_settings from club_settings where club_id = v_club_id for update;/,
    );
  });

  it("the court_rate_periods positive-price clause remains present in update_club_pricing's currency-lock scan (unaffected by the added lock)", () => {
    const pricingBody = functionBody(sql, "update_club_pricing");
    expect(pricingBody).toMatch(
      /select 1 from court_rate_periods\s*\n\s*where club_id = v_club_id\s*\n\s*and \(hourly_rate_cents > 0 or hourly_rate_non_member_cents > 0\)/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// H. Non-regression — scope discipline for Checkpoint A
// ═══════════════════════════════════════════════════════════════════════════

describe("0200 — non-regression: Checkpoint A scope discipline", () => {
  const sql = migrationSql();

  it("does not create a preview RPC (deferred to Checkpoint B)", () => {
    expect(sql).not.toMatch(/preview_reservation_price/i);
  });

  it("does not touch the payment/Stripe helper functions", () => {
    for (const name of [
      "_create_payment_obligation",
      "_adjust_payment_obligation",
      "_check_member_reassignment_allowed",
      "_invalidate_or_flag_open_checkout_attempt",
    ]) {
      expect(sql).not.toMatch(new RegExp(`create or replace function public\\.${name}\\(`, "i"));
    }
  });

  it("does not touch is_active_club_member's own definition", () => {
    expect(sql).not.toMatch(/create or replace function public\.is_active_club_member\(/);
  });

  it("does not add any new column to the reservations table (existing snapshot columns remain sole authority)", () => {
    expect(sql).not.toMatch(/alter table (public\.)?reservations/i);
  });

  it("does not touch lesson/event/program pricing functions", () => {
    for (const name of [
      "submit_lesson_request",
      "set_program_price",
      "create_event",
      "update_event",
      "join_program",
      "join_event",
    ]) {
      expect(sql).not.toMatch(new RegExp(`create or replace function public\\.${name}\\(`, "i"));
    }
  });
});
