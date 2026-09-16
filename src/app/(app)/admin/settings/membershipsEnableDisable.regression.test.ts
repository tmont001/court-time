import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 42C-1 — regression coverage for the memberships enable/disable DB
// foundation: club_settings.memberships_enabled, the
// update_club_memberships_enabled toggle RPC, the one-predicate pricing
// gate added to create_reservation/admin_create_member_reservation/
// update_member_reservation, and the widened get_members()/
// get_roster_members() read models.
//
// Same source-inspection style as memberNonMemberCourtPricing.regression
// .test.ts / membershipDomainFoundation.regression.test.ts — no live
// Postgres in this repo, so the shipped migration text is the honest thing
// to assert against. Migration 0190 is NOT applied to any database by this
// checkpoint.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--") && !line.trim().startsWith("//"))
    .join("\n");
}

const MIGRATION_PATH = "supabase/migrations/0190_memberships_enable_disable_foundation.sql";

function migrationSql(): string {
  return codeOnly(readSource(MIGRATION_PATH));
}

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

describe("0190 — migration numbering", () => {
  it("is the next migration after immutable 0189, and no unauthorized 0194+ migration exists yet", () => {
    // Phase 42C-3A (0191), 43A-1 (0192), and its 0193 hotfix are the
    // legitimate next migrations once 0190 is applied — this guard now
    // checks for anything PAST that authorized boundary, not past 0190
    // itself.
    expect(() => readSource("supabase/migrations/0189_member_non_member_court_pricing.sql")).not.toThrow();
    expect(() => readSource(MIGRATION_PATH)).not.toThrow();

    const files = readdirSync(join(process.cwd(), "supabase/migrations"));
    const laterMigrations = files.filter((f) => {
      const match = f.match(/^(\d{4})_/);
      return match !== null && Number(match[1]) > 193;
    });
    expect(laterMigrations).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. club_settings.memberships_enabled
// ═══════════════════════════════════════════════════════════════════════════

describe("0190 — club_settings.memberships_enabled", () => {
  const sql = migrationSql();

  it("adds the column as boolean NOT NULL DEFAULT true (existing clubs preserve current behavior)", () => {
    expect(sql).toMatch(
      /alter table public\.club_settings\s*\n\s*add column memberships_enabled boolean not null default true;/,
    );
  });

  it("never touches membership_types, roster_members membership columns, or configured rates", () => {
    expect(sql).not.toMatch(/drop table public\.membership_types/i);
    expect(sql).not.toMatch(/alter table public\.roster_members\s*\n\s*drop column (membership_status|membership_type_id)/i);
    expect(sql).not.toMatch(/update public\.club_settings\s+set\s+default_court_hourly_rate/i);
    expect(sql).not.toMatch(/update public\.courts\s+set\s+hourly_rate/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. update_club_memberships_enabled — toggle RPC
// ═══════════════════════════════════════════════════════════════════════════

describe("0190 — update_club_memberships_enabled", () => {
  const sql = migrationSql();
  const body = functionBody(sql, "update_club_memberships_enabled");

  it("uses the canonical current_user_club_id()/current_user_role() pattern, never profiles.role/profiles.club_id", () => {
    expect(body).toMatch(
      /if auth\.uid\(\) is null then\s*\n\s*raise exception 'not_authenticated';\s*\n\s*end if;/,
    );
    expect(body).toMatch(
      /select\s*\n\s*public\.current_user_club_id\(\),\s*\n\s*public\.current_user_role\(\)\s*\n\s*into\s*\n\s*v_club_id,\s*\n\s*v_role;/,
    );
    expect(body).not.toMatch(/v_profile/);
    expect(body).not.toMatch(/profiles%rowtype/);
  });

  it("is admin-only, fail-closed", () => {
    expect(body).toMatch(/if v_role is distinct from 'admin' then\s*\n\s*raise exception 'insufficient_role';/);
  });

  it("rejects a NULL p_enabled explicitly", () => {
    expect(body).toMatch(/if p_enabled is null then\s*\n\s*raise exception 'enabled_required';/);
  });

  it("scopes the UPDATE to the caller's own club only", () => {
    expect(body).toMatch(/where club_id = v_club_id\s*\n\s*returning \* into v_result;/);
  });

  it("writes an audit_log entry naming the action and the new value", () => {
    expect(body).toMatch(/insert into audit_log \(club_id, actor_id, action, target_type, target_id, metadata\)/);
    expect(body).toMatch(/'update_club_memberships_enabled'/);
    expect(body).toMatch(/'memberships_enabled', p_enabled/);
  });

  it("is not coupled to update_club_pricing — no shared param or body text", () => {
    expect(body).not.toMatch(/p_currency|p_default_court_hourly_rate_cents/);
  });

  it("grants EXECUTE only to authenticated, revoked from public/anon", () => {
    expect(sql).toMatch(
      /revoke execute on function public\.update_club_memberships_enabled\(boolean\) from public, anon;/,
    );
    expect(sql).toMatch(
      /grant\s+execute on function public\.update_club_memberships_enabled\(boolean\) to authenticated;/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. Reservation pricing gate — create_reservation / admin_create_member_
//    reservation / update_member_reservation
// ═══════════════════════════════════════════════════════════════════════════

describe("0190 — create_reservation pricing gate", () => {
  const sql = migrationSql();
  const body = functionBody(sql, "create_reservation");

  it("still computes membership_pricing_class unconditionally, exactly as 0189", () => {
    expect(body).toMatch(
      /v_membership_pricing_class := case\s*\n\s*when public\.is_active_club_member\(v_roster_member_id, v_profile\.club_id\) then 'member'\s*\n\s*else 'non_member'\s*\n\s*end;/,
    );
  });

  it("gates the non-member rate chain on memberships_enabled AND non_member class together", () => {
    expect(body).toMatch(/if v_settings\.memberships_enabled and v_membership_pricing_class = 'non_member' then/);
    expect(body).not.toMatch(/if v_membership_pricing_class = 'non_member' then/);
  });

  it("preserves the exact 4-level non-member fallback chain and the member chain", () => {
    expect(body).toMatch(
      /coalesce\(\s*\n\s*v_court\.hourly_rate_non_member_cents,\s*\n\s*v_settings\.default_court_hourly_rate_non_member_cents,\s*\n\s*v_court\.hourly_rate_cents,\s*\n\s*v_settings\.default_court_hourly_rate_cents\s*\n\s*\);/,
    );
    expect(body).toMatch(
      /else\s*\n\s*v_hourly_rate_cents := coalesce\(v_court\.hourly_rate_cents, v_settings\.default_court_hourly_rate_cents\);\s*\n\s*end if;/,
    );
  });

  it("preserves booking-window, operating-hours, and payment-obligation logic untouched", () => {
    expect(body).toMatch(/raise exception 'outside_booking_window';/);
    expect(body).toMatch(/raise exception 'outside_operating_hours';/);
    expect(body).toMatch(/perform public\._create_payment_obligation\(/);
  });
});

describe("0190 — admin_create_member_reservation pricing gate", () => {
  const sql = migrationSql();
  const body = functionBody(sql, "admin_create_member_reservation");

  it("still computes membership_pricing_class unconditionally", () => {
    expect(body).toMatch(
      /v_membership_pricing_class := case\s*\n\s*when public\.is_active_club_member\(p_roster_member_id, v_club_id\) then 'member'\s*\n\s*else 'non_member'\s*\n\s*end;/,
    );
  });

  it("gates the non-member rate chain on memberships_enabled", () => {
    expect(body).toMatch(/if v_settings\.memberships_enabled and v_membership_pricing_class = 'non_member' then/);
    expect(body).not.toMatch(/if v_membership_pricing_class = 'non_member' then/);
  });
});

describe("0190 — update_member_reservation pricing gate", () => {
  const sql = migrationSql();
  const body = functionBody(sql, "update_member_reservation");

  it("resolves a fresh class only on reassignment; otherwise preserves the snapshot — unaffected by memberships_enabled", () => {
    expect(body).toMatch(
      /if v_member_changed then\s*\n\s*v_new_pricing_class := case\s*\n\s*when public\.is_active_club_member\(p_roster_member_id, v_club_id\) then 'member'\s*\n\s*else 'non_member'\s*\n\s*end;\s*\n\s*else\s*\n\s*v_new_pricing_class := v_before\.membership_pricing_class;\s*\n\s*end if;/,
    );
  });

  it("gates the non-member rate chain (court-change/reassignment branch) on memberships_enabled", () => {
    const triggerStart = body.indexOf("if v_court_changed or v_member_changed then");
    const triggerEnd = body.indexOf("elsif v_duration_changed then", triggerStart);
    const triggerBranch = body.slice(triggerStart, triggerEnd);
    expect(triggerBranch).toMatch(/if v_settings\.memberships_enabled and v_new_pricing_class = 'non_member' then/);
    expect(triggerBranch).not.toMatch(/if v_new_pricing_class = 'non_member' then\s*\n(?!\s*raise)/);
  });

  it("duration-only and no-change branches remain untouched — never reference memberships_enabled", () => {
    const durationBranchStart = body.indexOf("elsif v_duration_changed then");
    const durationBranchEnd = body.indexOf("-- Phase 34E-A:", durationBranchStart);
    const durationAndElseBranch = body.slice(durationBranchStart, durationBranchEnd);
    expect(durationAndElseBranch).not.toMatch(/memberships_enabled/);
  });

  it("preserves the roster row's FOR UPDATE lock and the member-only-reassignment inactive-court exemption (0189 corrections)", () => {
    expect(body).toMatch(/where id = p_reservation_id and club_id = v_club_id\s*\n\s*for update;/);
    expect(body).toMatch(
      /if v_member_changed and not v_scheduling_changed then\s*\n\s*select \* into v_court\s*\n\s*from courts\s*\n\s*where id = p_court_id and club_id = v_club_id;\s*\n\s*if not found then raise exception 'invalid_court'; end if;\s*\n\s*end if;/,
    );
  });

  it("preserves the court-change path's is_active = true requirement", () => {
    expect(body).toMatch(/where id = p_court_id and club_id = v_club_id and is_active = true;/);
  });

  it("preserves the reassignment payment guard, the pre-mutation Checkout invalidation, and the forced-new-cycle obligation wiring", () => {
    expect(body).toMatch(/perform public\._check_member_reassignment_allowed\(v_club_id, 'reservation', p_reservation_id\);/);
    expect(body).toMatch(/_invalidate_or_flag_open_checkout_attempt/);
    expect(body).toMatch(
      /if v_member_changed then\s*\n\s*perform public\._create_payment_obligation\(\s*\n\s*v_club_id, 'reservation', p_reservation_id, p_roster_member_id,\s*\n\s*v_new_price_amount_cents, auth\.uid\(\), true\s*\n\s*\);/,
    );
  });

  it("never bulk-updates historical reservations — the only UPDATE reservations statement is scoped to a single id", () => {
    const updateStart = body.indexOf("update reservations set");
    const updateStatement = body.slice(updateStart, body.indexOf(";", updateStart));
    expect(updateStatement).toMatch(/where id = p_reservation_id/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. get_roster_members / get_members — widened read models
// ═══════════════════════════════════════════════════════════════════════════

describe("0190 — get_roster_members widened via DROP + CREATE", () => {
  const sql = migrationSql();

  it("drops the exact live 1-arg signature before recreating (adding return columns forbids bare CREATE OR REPLACE)", () => {
    const dropPos = sql.indexOf("drop function if exists public.get_roster_members(boolean);");
    const createPos = sql.indexOf("create or replace function get_roster_members(");
    expect(dropPos).toBeGreaterThan(-1);
    expect(createPos).toBeGreaterThan(dropPos);
  });

  it("preserves the exact signature (p_include_inactive boolean default false)", () => {
    expect(sql).toMatch(
      /create or replace function get_roster_members\(p_include_inactive boolean default false\)/,
    );
  });

  it("preserves every pre-existing returned column and adds exactly the three membership fields", () => {
    expect(sql).toMatch(
      /returns table \(\s*\n\s*id uuid, first_name text, last_name text, email text, phone text,\s*\n\s*role text, notes text, created_by uuid, created_at timestamptz,\s*\n\s*status text, removed_at timestamptz,\s*\n\s*membership_status text, membership_type_id uuid, membership_type_name text\s*\n\s*\)/,
    );
  });

  it("preserves same-club scoping, unclaimed-only filtering, and ordering", () => {
    const start = sql.indexOf("create or replace function get_roster_members(");
    const end = sql.indexOf("\n$$;", start) + 4;
    const body = sql.slice(start, end);
    expect(body).toMatch(/rm\.club_id\s*=\s*v_club_id/);
    expect(body).toMatch(/rm\.claimed_by is null/);
    expect(body).toMatch(/order by \(rm\.status <> 'active'\) asc,/);
  });

  it("joins membership_type_name via a same-club-scoped LEFT JOIN on membership_type_id, remaining nullable", () => {
    expect(sql).toMatch(/left join membership_types mt on mt\.id = rm\.membership_type_id/);
  });

  // ─── Correction: canonical active-club authorization ────────────────────
  it("uses current_user_club_id()/current_user_role() — never profiles.role/profiles.club_id", () => {
    const start = sql.indexOf("create or replace function get_roster_members(");
    const end = sql.indexOf("\n$$;", start) + 4;
    const body = sql.slice(start, end);

    expect(body).toMatch(
      /if auth\.uid\(\) is null then\s*\n\s*raise exception 'not_authenticated';\s*\n\s*end if;/,
    );
    expect(body).toMatch(
      /select\s*\n\s*public\.current_user_club_id\(\),\s*\n\s*public\.current_user_role\(\)\s*\n\s*into\s*\n\s*v_club_id,\s*\n\s*v_role;/,
    );
    expect(body).toMatch(/if v_role is distinct from 'admin' then\s*\n\s*raise exception 'insufficient_role';/);
    expect(body).not.toMatch(/v_profile/);
    expect(body).not.toMatch(/profiles%rowtype/);
    expect(body).not.toMatch(/from profiles\b|from public\.profiles\b/);
  });

  it("is explicitly hardened: revoked from public/anon, granted only to authenticated", () => {
    expect(sql).toMatch(
      /revoke execute on function public\.get_roster_members\(boolean\) from public, anon;/,
    );
    expect(sql).toMatch(
      /grant\s+execute on function public\.get_roster_members\(boolean\) to authenticated;/,
    );
  });
});

describe("0190 — get_members widened via DROP + CREATE", () => {
  const sql = migrationSql();

  it("drops the exact live 0-arg signature before recreating", () => {
    const dropPos = sql.indexOf("drop function if exists public.get_members();");
    const createPos = sql.indexOf("create or replace function public.get_members()");
    expect(dropPos).toBeGreaterThan(-1);
    expect(createPos).toBeGreaterThan(dropPos);
  });

  it("preserves every pre-existing returned column and adds exactly the three membership fields", () => {
    expect(sql).toMatch(
      /returns table\(id uuid, first_name text, last_name text, phone text, role text, status text, created_at timestamp with time zone, email text, is_lesson_provider boolean, removed_at timestamp with time zone, membership_status text, membership_type_id uuid, membership_type_name text\)/,
    );
  });

  const body = functionBody(sql, "get_members");

  it("preserves admin-or-staff authorization and same-club scoping", () => {
    expect(body).toMatch(
      /if v_actor_role is distinct from 'admin' and v_actor_role is distinct from 'staff' then\s*\n\s*raise exception 'insufficient_role';/,
    );
    expect(body).toMatch(/where cm\.club_id = v_actor_club_id/);
  });

  it("preserves the existing club_memberships/profiles/auth.users join shape and ordering", () => {
    expect(body).toMatch(/from public\.club_memberships cm\s*\n\s*join public\.profiles p on p\.id = cm\.user_id\s*\n\s*left join auth\.users u on u\.id = p\.id/);
    expect(body).toMatch(/order by \(cm\.removed_at is not null\) asc,/);
  });

  it("joins the new membership fields through roster_members on (club_id, claimed_by) — the per-club-unique pairing that cannot fan out rows", () => {
    expect(body).toMatch(
      /left join public\.roster_members rm on rm\.club_id = cm\.club_id and rm\.claimed_by = cm\.user_id/,
    );
    expect(body).toMatch(/left join public\.membership_types mt on mt\.id = rm\.membership_type_id/);
  });

  it("restores the pre-existing explicit revoke/grant exactly as it was", () => {
    expect(sql).toMatch(/revoke execute on function public\.get_members\(\) from public, anon;/);
    expect(sql).toMatch(/grant\s+execute on function public\.get_members\(\) to authenticated;/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. Non-regression — scope discipline
// ═══════════════════════════════════════════════════════════════════════════

describe("0190 — non-regression: scope stays to the memberships toggle + its two direct dependents", () => {
  const sql = migrationSql();

  it("does not touch get_admin_member_detail (audited, deliberately deferred to 42C-4)", () => {
    expect(sql).not.toMatch(/create or replace function public\.get_admin_member_detail\(/i);
    expect(sql).not.toMatch(/drop function if exists public\.get_admin_member_detail\(/i);
  });

  it("does not touch update_club_pricing or set_court_hourly_rate (frontend still calls the pre-0190 2-arg shape safely, since 0189's 3rd params default null)", () => {
    expect(sql).not.toMatch(/create or replace function public\.update_club_pricing\(/i);
    expect(sql).not.toMatch(/create or replace function public\.set_court_hourly_rate\(/i);
  });

  it("does not touch is_active_club_member, roster lifecycle RPCs, or membership_types CRUD RPCs", () => {
    for (const name of [
      "is_active_club_member",
      "remove_roster_member",
      "restore_roster_member",
      "set_member_status",
      "create_membership_type",
      "update_membership_type",
      "set_membership_type_active",
      "set_roster_member_membership_type",
      "set_roster_member_membership_status",
    ]) {
      expect(sql).not.toMatch(new RegExp(`create or replace function public\\.${name}\\(`, "i"));
    }
  });

  it("does not touch Stripe/payment helper functions", () => {
    for (const name of [
      "_create_payment_obligation",
      "_adjust_payment_obligation",
      "_check_member_reassignment_allowed",
      "_invalidate_or_flag_open_checkout_attempt",
      "update_club_payment_mode",
    ]) {
      expect(sql).not.toMatch(new RegExp(`create or replace function public\\.${name}\\(`, "i"));
    }
  });

  it("never issues a bulk UPDATE against reservations (no historical repricing/reclassification)", () => {
    expect(sql).not.toMatch(/update reservations\s+set\s+(hourly_rate_cents|price_amount_cents|membership_pricing_class)\s*=[^;]*where\s+club_id/i);
    expect(sql).not.toMatch(/update public\.reservations\s+set/i);
  });
});
