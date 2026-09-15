import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 42B — regression coverage for Member vs Non-Member COURT RESERVATION
// pricing: the two new non-member rate columns, the reservations.
// membership_pricing_class historical snapshot, class-aware resolution in
// create_reservation/admin_create_member_reservation/
// update_member_reservation, and the widened update_club_pricing/
// set_court_hourly_rate management RPCs.
//
// Same source-inspection style as cancellationPolicy.regression.test.ts /
// membershipDomainFoundation.regression.test.ts — no live Postgres in this
// repo, so the shipped migration text is the honest thing to assert
// against. Migration 0189 is NOT applied to any database by this
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

const MIGRATION_PATH = "supabase/migrations/0189_member_non_member_court_pricing.sql";

function migrationSql(): string {
  return codeOnly(readSource(MIGRATION_PATH));
}

// Isolates a single function body, handling both this repo's `$$;`-quoted
// and `$function$;`-quoted CREATE (OR REPLACE) FUNCTION conventions, and
// both `create` and `CREATE` casing (several functions here are reproduced
// verbatim from uppercase Production exports).
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

describe("0189 — migration numbering", () => {
  it("is the next migration after immutable 0188", () => {
    expect(() => readSource("supabase/migrations/0188_membership_domain_foundation.sql")).not.toThrow();
    expect(() => readSource(MIGRATION_PATH)).not.toThrow();
  });

  // Phase 42C-1 (0190) and 42C-3A (0191) are the legitimate next
  // migrations once 0189 is applied — this guard now checks for anything
  // PAST that authorized boundary, not past 0189 itself.
  it("no unauthorized 0192+ migration exists yet", () => {
    const files = readdirSync(join(process.cwd(), "supabase/migrations"));
    const laterMigrations = files.filter((f) => {
      const match = f.match(/^(\d{4})_/);
      return match !== null && Number(match[1]) > 191;
    });
    expect(laterMigrations).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. Schema — non-member rate columns, historical snapshot column
// ═══════════════════════════════════════════════════════════════════════════

describe("0189 — schema", () => {
  const sql = migrationSql();

  it("adds nullable, non-negative club_settings.default_court_hourly_rate_non_member_cents", () => {
    expect(sql).toMatch(
      /alter table public\.club_settings\s*\n\s*add column default_court_hourly_rate_non_member_cents integer null;/,
    );
    expect(sql).toMatch(
      /add constraint club_settings_default_court_hourly_rate_non_member_cents_nonneg\s*\n\s*check \(default_court_hourly_rate_non_member_cents is null or default_court_hourly_rate_non_member_cents >= 0\);/,
    );
  });

  it("adds nullable, non-negative courts.hourly_rate_non_member_cents", () => {
    expect(sql).toMatch(
      /alter table public\.courts\s*\n\s*add column hourly_rate_non_member_cents integer null;/,
    );
    expect(sql).toMatch(
      /add constraint courts_hourly_rate_non_member_cents_nonneg\s*\n\s*check \(hourly_rate_non_member_cents is null or hourly_rate_non_member_cents >= 0\);/,
    );
  });

  it("adds reservations.membership_pricing_class as nullable with a two-value CHECK, no default, no NOT NULL", () => {
    const alterStart = sql.indexOf("alter table public.reservations\n  add column membership_pricing_class");
    const alterEnd = sql.indexOf(");", alterStart) + 2;
    expect(alterStart).toBeGreaterThan(-1);
    const alterStatement = sql.slice(alterStart, alterEnd);

    expect(alterStatement).toMatch(
      /alter table public\.reservations\s*\n\s*add column membership_pricing_class text\s*\n\s*check \(membership_pricing_class in \('member', 'non_member'\)\);/,
    );
    expect(alterStatement).not.toMatch(/not null/);
    expect(alterStatement).not.toMatch(/default/);
  });

  it("never backfills membership_pricing_class on existing rows (no UPDATE reservations statement anywhere in this migration)", () => {
    expect(sql).not.toMatch(/update reservations\s+set\s+membership_pricing_class/i);
    expect(sql).not.toMatch(/update public\.reservations\s+set\s+membership_pricing_class/i);
  });

  // ─── Correction: column comment must not imply a NEW reservation can stay
  // NULL merely because a club hasn't configured differential pricing ─────
  it("the column comment states every new/reassigned reservation always snapshots member or non_member, and that NULL is exclusively historical/legacy state", () => {
    const commentStart = sql.indexOf("comment on column public.reservations.membership_pricing_class is");
    const commentEnd = sql.indexOf("';", commentStart) + 2;
    const commentText = sql.slice(commentStart, commentEnd);

    expect(commentText).toMatch(/always\s*\n\s*snapshots ''member'' or ''non_member''/);
    expect(commentText).toMatch(/NULL is exclusively historical\/legacy state/);
    // The corrected wording must not imply a club's pricing configuration
    // (as opposed to booking date) determines whether NULL is possible.
    expect(commentText).not.toMatch(/for any club that has not adopted/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. create_reservation — class-aware resolution
// ═══════════════════════════════════════════════════════════════════════════

describe("0189 — create_reservation", () => {
  const sql = migrationSql();
  const body = functionBody(sql, "create_reservation");

  it("resolves membership_pricing_class via is_active_club_member(caller's own roster id, own club id) — role-agnostic", () => {
    expect(body).toMatch(
      /v_membership_pricing_class := case\s*\n\s*when public\.is_active_club_member\(v_roster_member_id, v_profile\.club_id\) then 'member'\s*\n\s*else 'non_member'\s*\n\s*end;/,
    );
    // Never consults v_profile.role when resolving the pricing class itself.
    const classResolutionStart = body.indexOf("v_membership_pricing_class := case");
    const classResolutionEnd = body.indexOf("end;", classResolutionStart) + 4;
    expect(body.slice(classResolutionStart, classResolutionEnd)).not.toMatch(/v_profile\.role/);
  });

  it("branches on '= non_member' (never '= member') so NULL fails closed into the existing Member/default chain", () => {
    expect(body).toMatch(/if v_membership_pricing_class = 'non_member' then/);
    expect(body).not.toMatch(/if v_membership_pricing_class = 'member' then/);
  });

  it("non-member resolution falls back through: court non-member -> club non-member default -> existing court/club default chain", () => {
    expect(body).toMatch(
      /v_hourly_rate_cents := coalesce\(\s*\n\s*v_court\.hourly_rate_non_member_cents,\s*\n\s*v_settings\.default_court_hourly_rate_non_member_cents,\s*\n\s*v_court\.hourly_rate_cents,\s*\n\s*v_settings\.default_court_hourly_rate_cents\s*\n\s*\);/,
    );
  });

  it("member resolution is byte-identical to the pre-42B formula (court override, else club default)", () => {
    expect(body).toMatch(
      /else\s*\n\s*v_hourly_rate_cents := coalesce\(v_court\.hourly_rate_cents, v_settings\.default_court_hourly_rate_cents\);\s*\n\s*end if;/,
    );
  });

  it("snapshots membership_pricing_class into the INSERT alongside the existing price columns", () => {
    expect(body).toMatch(
      /hourly_rate_cents, price_amount_cents, membership_pricing_class\s*\n\s*\) values \(/,
    );
    expect(body).toMatch(
      /v_hourly_rate_cents, v_price_amount_cents, v_membership_pricing_class\s*\n\s*\)/,
    );
  });

  it("never references guest_names or player_count anywhere in the pricing-resolution block (guests never affect base classification)", () => {
    const classStart = body.indexOf("v_membership_pricing_class := case");
    const insertStart = body.indexOf("insert into reservations");
    const pricingBlock = body.slice(classStart, insertStart);
    expect(pricingBlock).not.toMatch(/guest_names|player_count/);
  });

  it("does not alter any pre-42B scheduling, capacity, notification, or payment-obligation logic", () => {
    expect(body).toMatch(/if v_profile\.status <> 'active' then raise exception 'account_inactive'; end if;/);
    expect(body).toMatch(/raise exception 'outside_booking_window';/);
    expect(body).toMatch(/perform public\._create_payment_obligation\(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. admin_create_member_reservation — identical class-aware resolution
// ═══════════════════════════════════════════════════════════════════════════

describe("0189 — admin_create_member_reservation", () => {
  const sql = migrationSql();
  const body = functionBody(sql, "admin_create_member_reservation");

  it("resolves membership_pricing_class via is_active_club_member(explicit target roster id, club id)", () => {
    expect(body).toMatch(
      /v_membership_pricing_class := case\s*\n\s*when public\.is_active_club_member\(p_roster_member_id, v_club_id\) then 'member'\s*\n\s*else 'non_member'\s*\n\s*end;/,
    );
  });

  it("branches on '= non_member', matching create_reservation's NULL-safe pattern", () => {
    expect(body).toMatch(/if v_membership_pricing_class = 'non_member' then/);
    expect(body).not.toMatch(/if v_membership_pricing_class = 'member' then/);
  });

  it("uses the identical 4-level non-member fallback chain", () => {
    expect(body).toMatch(
      /coalesce\(\s*\n\s*v_court\.hourly_rate_non_member_cents,\s*\n\s*v_settings\.default_court_hourly_rate_non_member_cents,\s*\n\s*v_court\.hourly_rate_cents,\s*\n\s*v_settings\.default_court_hourly_rate_cents\s*\n\s*\);/,
    );
  });

  it("snapshots membership_pricing_class into the INSERT and never references role", () => {
    expect(body).toMatch(
      /hourly_rate_cents, price_amount_cents, membership_pricing_class\s*\n\s*\) values \(/,
    );
    const classResolutionStart = body.indexOf("v_membership_pricing_class := case");
    const classResolutionEnd = body.indexOf("end;", classResolutionStart) + 4;
    expect(body.slice(classResolutionStart, classResolutionEnd)).not.toMatch(/\brole\b/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. update_member_reservation — reassignment/court/duration repricing rules
// ═══════════════════════════════════════════════════════════════════════════

describe("0189 — update_member_reservation", () => {
  const sql = migrationSql();
  const body = functionBody(sql, "update_member_reservation");

  it("resolves a FRESH pricing class only when the Member is reassigned; otherwise preserves the existing snapshot", () => {
    expect(body).toMatch(
      /if v_member_changed then\s*\n\s*v_new_pricing_class := case\s*\n\s*when public\.is_active_club_member\(p_roster_member_id, v_club_id\) then 'member'\s*\n\s*else 'non_member'\s*\n\s*end;\s*\n\s*else\s*\n\s*v_new_pricing_class := v_before\.membership_pricing_class;\s*\n\s*end if;/,
    );
  });

  it("loads v_court for a reassignment-only edit (member changed, no scheduling change) so the rate can be re-resolved", () => {
    expect(body).toMatch(
      /if v_member_changed and not v_scheduling_changed then\s*\n\s*select \* into v_court\s*\n\s*from courts\s*\n\s*where id = p_court_id and club_id = v_club_id;\s*\n\s*if not found then raise exception 'invalid_court'; end if;\s*\n\s*end if;/,
    );
  });

  // ─── Correction: inactive-court reassignment must remain possible ───────
  it("the court-CHANGE path (v_scheduling_changed) still requires is_active = true — moving a booking onto a court IS a new-booking decision", () => {
    const schedulingBlockStart = body.indexOf("if v_scheduling_changed then");
    const schedulingBlockEnd = body.indexOf("-- Phase 34B: reservation-edit pricing invariants", schedulingBlockStart);
    const schedulingBlock = body.slice(schedulingBlockStart, schedulingBlockEnd);
    expect(schedulingBlock).toMatch(
      /where id = p_court_id and club_id = v_club_id and is_active = true;/,
    );
  });

  it("the MEMBER-ONLY reassignment court reload does NOT require is_active = true — reassigning an existing, unmoved booking must remain possible even if the court was since deactivated for new bookings", () => {
    const reassignBlockStart = body.indexOf("if v_member_changed and not v_scheduling_changed then");
    const reassignBlockEnd = body.indexOf("if v_court_changed or v_member_changed then", reassignBlockStart);
    const reassignBlock = body.slice(reassignBlockStart, reassignBlockEnd);
    expect(reassignBlock).toMatch(/where id = p_court_id and club_id = v_club_id;/);
    expect(reassignBlock).not.toMatch(/is_active/);
  });

  it("the member-only reassignment court reload remains same-club scoped (club_id = v_club_id, not just id = p_court_id)", () => {
    const reassignBlockStart = body.indexOf("if v_member_changed and not v_scheduling_changed then");
    const reassignBlockEnd = body.indexOf("if v_court_changed or v_member_changed then", reassignBlockStart);
    const reassignBlock = body.slice(reassignBlockStart, reassignBlockEnd);
    expect(reassignBlock).toMatch(/club_id = v_club_id/);
  });

  it("re-resolves the rate when EITHER the court changed OR the Member was reassigned (both are repricing triggers)", () => {
    expect(body).toMatch(/if v_court_changed or v_member_changed then/);
  });

  it("branches the reassignment/court-change rate resolution on '= non_member', never '= member' (NULL-safe for legacy rows)", () => {
    const triggerStart = body.indexOf("if v_court_changed or v_member_changed then");
    const triggerEnd = body.indexOf("elsif v_duration_changed then", triggerStart);
    const triggerBranch = body.slice(triggerStart, triggerEnd);
    expect(triggerBranch).toMatch(/if v_new_pricing_class = 'non_member' then/);
    expect(triggerBranch).not.toMatch(/if v_new_pricing_class = 'member' then/);
  });

  it("duration-only changes preserve the EXISTING hourly_rate_cents exactly (byte-identical to pre-42B behavior)", () => {
    expect(body).toMatch(
      /elsif v_duration_changed then\s*\n\s*v_new_hourly_rate_cents := v_before\.hourly_rate_cents;/,
    );
  });

  it("no scheduling/Member change preserves both the rate and the pricing class exactly", () => {
    expect(body).toMatch(
      /else\s*\n\s*v_new_hourly_rate_cents {2}:= v_before\.hourly_rate_cents;\s*\n\s*v_new_price_amount_cents := v_before\.price_amount_cents;\s*\n\s*end if;/,
    );
  });

  it("writes membership_pricing_class into the UPDATE using v_new_pricing_class", () => {
    expect(body).toMatch(/membership_pricing_class = v_new_pricing_class,/);
  });

  it("tracks membership_pricing_class in changed_fields the same way hourly_rate_cents/price_amount_cents already are", () => {
    expect(body).toMatch(
      /if v_new_pricing_class is distinct from v_before\.membership_pricing_class then\s*\n\s*v_changed_fields := array_append\(v_changed_fields, 'membership_pricing_class'\);\s*\n\s*end if;/,
    );
  });

  it("includes membership_pricing_class in both the audit 'before' and 'after' blocks", () => {
    const beforeStart = body.indexOf("'before', jsonb_build_object(");
    const beforeEnd = body.indexOf("'after', jsonb_build_object(", beforeStart);
    const afterStart = beforeEnd;
    const afterEnd = body.indexOf(")\n    )\n  );", afterStart);
    expect(body.slice(beforeStart, beforeEnd)).toMatch(/'membership_pricing_class', v_before\.membership_pricing_class/);
    expect(body.slice(afterStart, afterEnd)).toMatch(/'membership_pricing_class', v_after\.membership_pricing_class/);
  });

  it("preserves the existing _check_member_reassignment_allowed guard, unresolved-obligation-blocking reassignment before any repricing runs", () => {
    const guardPos = body.indexOf("_check_member_reassignment_allowed");
    const pricingPos = body.indexOf("v_new_pricing_class := case");
    expect(guardPos).toBeGreaterThan(-1);
    expect(pricingPos).toBeGreaterThan(guardPos);
  });

  it("preserves the existing payment-wiring block: reassignment always forces a new obligation cycle", () => {
    expect(body).toMatch(
      /if v_member_changed then\s*\n\s*perform public\._create_payment_obligation\(\s*\n\s*v_club_id, 'reservation', p_reservation_id, p_roster_member_id,\s*\n\s*v_new_price_amount_cents, auth\.uid\(\), true\s*\n\s*\);/,
    );
  });

  it("preserves the pre-mutation Stripe Checkout invalidation guard untouched", () => {
    expect(body).toMatch(/_invalidate_or_flag_open_checkout_attempt/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. update_club_pricing / set_court_hourly_rate — widened management RPCs
// ═══════════════════════════════════════════════════════════════════════════

describe("0189 — update_club_pricing (widened, stale 2-arg overload dropped)", () => {
  const sql = migrationSql();

  it("explicitly drops the old 2-arg signature before creating the 3-arg version", () => {
    const dropPos = sql.indexOf("drop function if exists public.update_club_pricing(text, integer);");
    const createPos = sql.indexOf("create or replace function public.update_club_pricing(");
    expect(dropPos).toBeGreaterThan(-1);
    expect(createPos).toBeGreaterThan(dropPos);
  });

  const body = functionBody(sql, "update_club_pricing");

  it("adds p_default_court_hourly_rate_non_member_cents as a defaulted 3rd param (backward-compatible with existing named-arg callers)", () => {
    expect(sql).toMatch(
      /create or replace function public\.update_club_pricing\(\s*\n\s*p_currency text,\s*\n\s*p_default_court_hourly_rate_cents integer,\s*\n\s*p_default_court_hourly_rate_non_member_cents integer default null\s*\n\s*\)/,
    );
  });

  it("validates the new rate the same way as the existing one (nullable, non-negative)", () => {
    expect(body).toMatch(
      /if p_default_court_hourly_rate_non_member_cents is not null and p_default_court_hourly_rate_non_member_cents < 0 then\s*\n\s*raise exception 'invalid_rate';/,
    );
  });

  it("preserves the currency-lock guard and extends its scan to the two new non-member rate columns", () => {
    expect(body).toMatch(/raise exception 'currency_locked_by_pricing';/);
    expect(body).toMatch(
      /select 1 from club_settings where club_id = v_club_id and default_court_hourly_rate_non_member_cents > 0/,
    );
    expect(body).toMatch(
      /select 1 from courts where club_id = v_club_id and hourly_rate_non_member_cents > 0/,
    );
  });

  it("preserves every pre-42B currency-lock scan source (lesson_types, event_types, events, programs, reservations, lesson_requests, event_participants, event_guests, program_enrollments)", () => {
    for (const table of [
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

  it("writes the new rate into both the UPDATE and the audit_log metadata", () => {
    expect(body).toMatch(/default_court_hourly_rate_non_member_cents\s*=\s*p_default_court_hourly_rate_non_member_cents/);
    expect(body).toMatch(/'default_court_hourly_rate_non_member_cents', p_default_court_hourly_rate_non_member_cents/);
  });

  it("preserves admin-only authorization and same-club scoping", () => {
    expect(body).toMatch(/if v_role is distinct from 'admin' then\s*\n\s*raise exception 'insufficient_role';/);
  });

  it("grants EXECUTE only on the new 3-arg signature, revoked from public/anon", () => {
    expect(sql).toMatch(
      /revoke execute on function public\.update_club_pricing\(text, integer, integer\) from public, anon;/,
    );
    expect(sql).toMatch(
      /grant\s+execute on function public\.update_club_pricing\(text, integer, integer\) to authenticated;/,
    );
    // No lingering grant statement targeting the old 2-arg signature.
    expect(sql).not.toMatch(/grant\s+execute on function public\.update_club_pricing\(text, integer\) to/);
  });

  // ─── Correction: canonical active-club authorization ────────────────────
  it("uses current_user_club_id()/current_user_role() — the canonical pattern for a newly republished privileged RPC — never profiles.role/profiles.club_id", () => {
    expect(body).toMatch(
      /if auth\.uid\(\) is null then\s*\n\s*raise exception 'not_authenticated';\s*\n\s*end if;/,
    );
    expect(body).toMatch(
      /select\s*\n\s*public\.current_user_club_id\(\),\s*\n\s*public\.current_user_role\(\)\s*\n\s*into\s*\n\s*v_club_id,\s*\n\s*v_role;/,
    );
    expect(body).not.toMatch(/v_profile/);
    expect(body).not.toMatch(/profiles%rowtype/);
    expect(body).not.toMatch(/from profiles\b|from public\.profiles\b/);
  });

  it("scopes every club_settings/courts lookup, the currency-lock scan, the UPDATE, and the audit_log write to v_club_id", () => {
    expect(body).toMatch(/from club_settings where club_id = v_club_id;/);
    expect(body).toMatch(/where club_id = v_club_id\s*\n\s*returning \* into v_result;/);
    expect(body).toMatch(/values \(\s*\n\s*v_club_id,\s*\n\s*auth\.uid\(\),\s*\n\s*'update_club_pricing',/);
    // Every currency-lock scan source is club_id = v_club_id, not v_profile.club_id.
    const scanStart = body.indexOf("select exists (");
    const scanEnd = body.indexOf(") into v_positive_pricing_exists;");
    const scanBlock = body.slice(scanStart, scanEnd);
    expect(scanBlock).not.toMatch(/v_profile/);
    expect((scanBlock.match(/club_id = v_club_id/g) ?? []).length).toBeGreaterThanOrEqual(11);
  });
});

describe("0189 — set_court_hourly_rate (widened, stale 2-arg overload dropped)", () => {
  const sql = migrationSql();

  it("explicitly drops the old 2-arg signature before creating the 3-arg version", () => {
    const dropPos = sql.indexOf("drop function if exists public.set_court_hourly_rate(uuid, integer);");
    const createPos = sql.indexOf("create or replace function public.set_court_hourly_rate(");
    expect(dropPos).toBeGreaterThan(-1);
    expect(createPos).toBeGreaterThan(dropPos);
  });

  const body = functionBody(sql, "set_court_hourly_rate");

  it("adds p_hourly_rate_non_member_cents as a defaulted 3rd param", () => {
    expect(sql).toMatch(
      /create or replace function public\.set_court_hourly_rate\(\s*\n\s*p_court_id uuid,\s*\n\s*p_hourly_rate_cents integer,\s*\n\s*p_hourly_rate_non_member_cents integer default null\s*\n\s*\)/,
    );
  });

  it("validates the new rate the same way as the existing one", () => {
    expect(body).toMatch(
      /if p_hourly_rate_non_member_cents is not null and p_hourly_rate_non_member_cents < 0 then\s*\n\s*raise exception 'invalid_rate';/,
    );
  });

  it("writes both rates into the UPDATE and both into the audit_log metadata", () => {
    expect(body).toMatch(/hourly_rate_cents\s*=\s*p_hourly_rate_cents,\s*\n\s*hourly_rate_non_member_cents\s*=\s*p_hourly_rate_non_member_cents/);
    expect(body).toMatch(/'hourly_rate_cents', p_hourly_rate_cents,\s*\n\s*'hourly_rate_non_member_cents', p_hourly_rate_non_member_cents/);
  });

  it("preserves admin-only, same-club authorization", () => {
    expect(body).toMatch(/if v_role is distinct from 'admin' then\s*\n\s*raise exception 'insufficient_role';/);
    expect(body).toMatch(/select 1 from courts where id = p_court_id and club_id = v_club_id/);
  });

  // ─── Correction: the final WRITE must itself be club-scoped ─────────────
  it("the final UPDATE fails closed on BOTH id and club_id, not merely the pre-write existence check", () => {
    const updateStart = body.indexOf("update courts set");
    const updateEnd = body.indexOf("returning * into v_result;", updateStart) + "returning * into v_result;".length;
    const updateStatement = body.slice(updateStart, updateEnd);
    expect(updateStatement).toMatch(
      /where id = p_court_id\s*\n\s*and club_id = v_club_id\s*\n\s*returning \* into v_result;/,
    );
  });

  // ─── Correction: canonical active-club authorization ────────────────────
  it("uses current_user_club_id()/current_user_role() — never profiles.role/profiles.club_id", () => {
    expect(body).toMatch(
      /if auth\.uid\(\) is null then\s*\n\s*raise exception 'not_authenticated';\s*\n\s*end if;/,
    );
    expect(body).toMatch(
      /select\s*\n\s*public\.current_user_club_id\(\),\s*\n\s*public\.current_user_role\(\)\s*\n\s*into\s*\n\s*v_club_id,\s*\n\s*v_role;/,
    );
    expect(body).not.toMatch(/v_profile/);
    expect(body).not.toMatch(/profiles%rowtype/);
    expect(body).not.toMatch(/from profiles\b|from public\.profiles\b/);
  });

  it("scopes the audit_log write to v_club_id", () => {
    expect(body).toMatch(/values \(\s*\n\s*v_club_id, auth\.uid\(\), 'set_court_hourly_rate',/);
  });

  it("grants EXECUTE only on the new 3-arg signature", () => {
    expect(sql).toMatch(
      /revoke execute on function public\.set_court_hourly_rate\(uuid, integer, integer\) from public, anon;/,
    );
    expect(sql).toMatch(
      /grant\s+execute on function public\.set_court_hourly_rate\(uuid, integer, integer\) to authenticated;/,
    );
    expect(sql).not.toMatch(/grant\s+execute on function public\.set_court_hourly_rate\(uuid, integer\) to/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G. Non-regression — scope discipline
// ═══════════════════════════════════════════════════════════════════════════

describe("0189 — non-regression: scope stays to court reservations only", () => {
  const sql = migrationSql();

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

  it("does not touch the payment/Stripe helper functions — they continue to consume whatever this migration resolves, generically", () => {
    for (const name of [
      "_create_payment_obligation",
      "_adjust_payment_obligation",
      "_check_member_reassignment_allowed",
      "_invalidate_or_flag_open_checkout_attempt",
    ]) {
      expect(sql).not.toMatch(new RegExp(`create or replace function public\\.${name}\\(`, "i"));
    }
  });

  it("does not touch roster_members.status, roster_members.membership_status, or is_active_club_member's own definition", () => {
    expect(sql).not.toMatch(/alter table public\.roster_members/);
    expect(sql).not.toMatch(/create or replace function public\.is_active_club_member\(/);
  });

  it("does not touch reservation_participants or reservation_guests (Phase 37)", () => {
    expect(sql).not.toMatch(/alter table public\.reservation_participants/);
    expect(sql).not.toMatch(/alter table public\.reservation_guests/);
  });

  it("does not add any guest-fee pricing column or table", () => {
    expect(sql).not.toMatch(/guest_fee|guest_rate|guest_price/i);
  });
});
