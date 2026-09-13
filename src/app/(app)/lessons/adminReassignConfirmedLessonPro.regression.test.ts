import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 38A — regression coverage for migration 0180
// (admin_reassign_confirmed_lesson_pro), using this repository's established
// source-inspection style (see reservationParticipantFoundation.regression.
// test.ts's own header comment for why: no jsdom/live-Postgres in this test
// baseline, so reading the shipped SQL is the honest guard here).
//
// 0180 is NOT applied to Supabase by this checkpoint — these tests verify
// the migration FILE's content only.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

const MIGRATION_PATH = "supabase/migrations/0180_admin_reassign_confirmed_lesson_pro.sql";
const REASSIGN_LESSON_PROVIDER_PATH = "supabase/migrations/0132_staff_operational_authorization.sql";
const ADMIN_UPDATE_MEMBER_LESSON_PATH = "supabase/migrations/0138_staff_confirmed_lesson_direct_edit.sql";

function migrationSql(): string {
  return codeOnly(readSource(MIGRATION_PATH));
}

function functionBody(): string {
  const sql = migrationSql();
  const start = sql.indexOf("create or replace function public.admin_reassign_confirmed_lesson_pro(");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n$$;", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end + "\n$$;".length);
}

function helperFunctionBody(): string {
  const sql = migrationSql();
  const start = sql.indexOf("create or replace function public._lesson_check_pro_availability_for_club(");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n$$;", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end + "\n$$;".length);
}

function pickerFunctionBody(): string {
  const sql = migrationSql();
  const start = sql.indexOf("create or replace function public.get_confirmed_lesson_reassignment_pros(");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n$$;", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end + "\n$$;".length);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Function shape / security posture
// ═══════════════════════════════════════════════════════════════════════════

describe("admin_reassign_confirmed_lesson_pro — function shape", () => {
  it("is SECURITY DEFINER with search_path pinned to public, pg_temp", () => {
    const fn = functionBody();
    expect(fn).toContain("security definer");
    expect(fn).toContain("set search_path = public, pg_temp");
  });

  it("takes exactly (p_request_id uuid, p_expected_updated_at timestamptz, p_new_pro_id uuid) and returns lesson_requests", () => {
    const fn = functionBody();
    expect(fn).toContain(
      "create or replace function public.admin_reassign_confirmed_lesson_pro(\n" +
      "  p_request_id          uuid,\n" +
      "  p_expected_updated_at timestamptz,\n" +
      "  p_new_pro_id          uuid\n" +
      ")\nreturns public.lesson_requests",
    );
  });

  it("is authenticated-callable only — revoked from public/anon, granted to authenticated", () => {
    const sql = migrationSql();
    expect(sql).toContain(
      "revoke execute on function public.admin_reassign_confirmed_lesson_pro(uuid, timestamptz, uuid) from public, anon;",
    );
    expect(sql).toContain(
      "grant  execute on function public.admin_reassign_confirmed_lesson_pro(uuid, timestamptz, uuid) to authenticated;",
    );
  });

  it("resolves club/role via the canonical current_user_club_id()/current_user_role() helpers, not a direct profiles lookup", () => {
    const fn = functionBody();
    expect(fn).toContain("select public.current_user_club_id(), public.current_user_role()");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Caller authorization — Admin AND Staff only, never Pro or Member
// ═══════════════════════════════════════════════════════════════════════════

describe("caller role gate", () => {
  it("admits only admin/staff — no pro or member branch exists in the role check", () => {
    const fn = functionBody();
    expect(fn).toContain("if v_role is null or v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;");
  });

  it("1/2. an Admin or Staff caller passes the role gate (both are in the allowlist)", () => {
    const fn = functionBody();
    const idx = fn.indexOf("if v_role is null or v_role not in ('admin', 'staff')");
    const clause = fn.slice(idx, fn.indexOf(";", idx));
    expect(clause).toContain("'admin'");
    expect(clause).toContain("'staff'");
  });

  it("3. a Pro caller is rejected — 'pro' never appears in the allowed-role list", () => {
    const fn = functionBody();
    const idx = fn.indexOf("if v_role is null or v_role not in ('admin', 'staff')");
    const clause = fn.slice(idx, fn.indexOf(";", idx));
    expect(clause).not.toContain("'pro'");
  });

  it("4. a Member caller is rejected — 'member' never appears in the allowed-role list, and current_user_role() only returns v_role for the caller themselves (never a target)", () => {
    const fn = functionBody();
    const idx = fn.indexOf("if v_role is null or v_role not in ('admin', 'staff')");
    const clause = fn.slice(idx, fn.indexOf(";", idx));
    expect(clause).not.toContain("'member'");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Status / concurrency / started-lesson guards
// ═══════════════════════════════════════════════════════════════════════════

describe("status, stale-edit, and already-started guards", () => {
  it("requires status = 'confirmed' — a pending/proposed/declined/cancelled request is rejected", () => {
    const fn = functionBody();
    expect(fn).toContain("if v_request.status <> 'confirmed' then raise exception 'invalid_status_for_pro_reassign'; end if;");
  });

  it("9. stale-edit protection via p_expected_updated_at, same shape as admin_update_member_lesson's own guard", () => {
    const fn = functionBody();
    expect(fn).toContain("if v_request.updated_at is distinct from p_expected_updated_at then raise exception 'stale_edit_conflict'; end if;");
  });

  it("5. an already-started lesson is rejected via the linked reservation's own starts_at, mirroring admin_update_member_lesson/propose_lesson_time's identical guard", () => {
    const fn = functionBody();
    expect(fn).toContain(
      "if v_reservation.starts_at <= now() then\n" +
      "    raise exception 'cannot_reschedule_started_lesson';\n" +
      "  end if;",
    );
  });

  it("locks both the lesson_requests row and the linked reservation row (for update) before any mutation", () => {
    const fn = functionBody();
    const lessonLockIdx = fn.indexOf("for update;");
    expect(lessonLockIdx).toBeGreaterThan(-1);
    const occurrences = fn.split("for update;").length - 1;
    expect(occurrences).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. New-Pro eligibility, same-pro, and conflict checks
// ═══════════════════════════════════════════════════════════════════════════

describe("new Pro eligibility, same-pro rejection, and conflict check", () => {
  it("6. same_pro is rejected before the eligibility lookup even runs", () => {
    const fn = functionBody();
    const sameProIdx = fn.indexOf("if v_request.pro_id = p_new_pro_id then\n    raise exception 'same_pro';");
    const eligibilityIdx = fn.indexOf("select * into v_new_pro_membership");
    expect(sameProIdx).toBeGreaterThan(-1);
    expect(eligibilityIdx).toBeGreaterThan(sameProIdx);
  });

  it("7. new Pro must be same-club, active, a lesson-providing pro/admin/staff account", () => {
    const fn = functionBody();
    const idx = fn.indexOf("select * into v_new_pro_membership");
    const end = fn.indexOf("if not found then raise exception 'pro_not_found'; end if;", idx);
    const clause = fn.slice(idx, end);
    expect(clause).toContain("club_id            = v_club_id");
    expect(clause).toContain("status              = 'active'");
    expect(clause).toContain("role                in ('pro', 'admin', 'staff')");
    expect(clause).toContain("is_lesson_provider  = true");
  });

  describe("multi-club correction: eligibility is validated against club_memberships, not the profiles legacy projection", () => {
    it("queries public.club_memberships — not public.profiles — for the target Pro's role/status/is_lesson_provider", () => {
      const fn = functionBody();
      const idx = fn.indexOf("select * into v_new_pro_membership");
      const end = fn.indexOf("if not found then raise exception 'pro_not_found'; end if;", idx);
      const clause = fn.slice(idx, end);
      expect(clause).toContain("from public.club_memberships");
      expect(clause).not.toContain("from public.profiles");
    });

    it("scopes by user_id = p_new_pro_id and club_id = v_club_id (THIS lesson's own, caller-verified club) — never the target's own currently active club", () => {
      const fn = functionBody();
      const idx = fn.indexOf("select * into v_new_pro_membership");
      const end = fn.indexOf("if not found then raise exception 'pro_not_found'; end if;", idx);
      const clause = fn.slice(idx, end);
      expect(clause).toContain("user_id            = p_new_pro_id");
      expect(clause).toContain("club_id            = v_club_id");
    });

    it("also requires removed_at is null — matching club_memberships' own established 'counts as active' definition used throughout the schema (0126's index predicates, 0177's send_announcement_v2 fix)", () => {
      const fn = functionBody();
      const idx = fn.indexOf("select * into v_new_pro_membership");
      const end = fn.indexOf("if not found then raise exception 'pro_not_found'; end if;", idx);
      const clause = fn.slice(idx, end);
      expect(clause).toContain("removed_at is null");
    });

    it("global identity (name) is read separately from public.profiles by plain id — never club-scoped, since name does not vary by club", () => {
      const fn = functionBody();
      const idx = fn.indexOf("select * into v_new_pro from public.profiles where id = p_new_pro_id;");
      expect(idx).toBeGreaterThan(-1);
      // Must come AFTER the club_memberships eligibility check succeeds.
      const eligibilityIdx = fn.indexOf("if not found then raise exception 'pro_not_found'; end if;");
      expect(idx).toBeGreaterThan(eligibilityIdx);
    });

    it("v_new_pro (profiles) is still what notification bodies read first/last_name from — unaffected by the eligibility source change", () => {
      const fn = functionBody();
      expect(fn).toContain("trim(coalesce(v_new_pro.first_name, '') || ' ' || coalesce(v_new_pro.last_name, ''))");
    });

    it("reassign_lesson_provider (0132) and admin_update_member_lesson (0138) are untouched — they keep validating via public.profiles, unmodified, per instruction not to edit already-applied migrations", () => {
      const reassignSrc = readSource(REASSIGN_LESSON_PROVIDER_PATH);
      expect(reassignSrc).toContain(
        "select pr.* into v_new_pro from public.profiles pr\n" +
        "   where pr.id                 = p_new_pro_id\n" +
        "     and pr.club_id            = v_actor.club_id",
      );
      const adminEditSrc = readSource(ADMIN_UPDATE_MEMBER_LESSON_PATH);
      expect(adminEditSrc).toMatch(/select \* into v_pro\s*\n\s*from public\.profiles\s*\n\s*where id\s*=\s*p_pro_id/);
    });
  });

  it("8. conflict check calls the club-aware _lesson_check_pro_availability_for_club helper (not the plain, applied _lesson_check_pro_availability), at the lesson's EXISTING (unchanged) reservation time, excluding this lesson's own reservation via p_exclude_request_id, and passing v_club_id explicitly", () => {
    const fn = functionBody();
    expect(fn).toContain(
      "perform public._lesson_check_pro_availability_for_club(\n" +
      "    p_new_pro_id, v_club_id, v_reservation.starts_at, v_reservation.ends_at, p_request_id\n" +
      "  );",
    );
  });

  it("never calls the plain _lesson_check_pro_availability (0126, applied, unmodified) — that function derives its own club from the target's profiles.club_id, exactly the stale projection this checkpoint corrects", () => {
    const fn = functionBody();
    expect(fn).not.toMatch(/perform public\._lesson_check_pro_availability\(/);
  });

  it("the availability check runs against v_reservation's own starts_at/ends_at, never a client-supplied time — this RPC has no p_starts_at/p_ends_at parameter at all", () => {
    const fn = functionBody();
    expect(fn).not.toMatch(/p_starts_at|p_ends_at|p_court_id/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Identity/invariant preservation — the required non-negotiables
// ═══════════════════════════════════════════════════════════════════════════

describe("identity and invariant preservation", () => {
  it("10. lesson_requests.id is preserved — exactly one UPDATE by id, no delete/insert of the row", () => {
    const fn = functionBody();
    expect(fn).toContain("update public.lesson_requests\n     set pro_id");
    expect(fn).toContain("where id = p_request_id");
    expect(fn).not.toMatch(/insert into public\.lesson_requests/);
    expect(fn).not.toMatch(/delete from public\.lesson_requests/);
  });

  it("11. reservation id is preserved — exactly one UPDATE by id, no soft-cancel-and-reinsert (unlike admin_update_member_lesson's scheduling-changed branch)", () => {
    const fn = functionBody();
    expect(fn).toContain("update public.reservations\n     set owner_user_id");
    expect(fn).toContain("where id = v_reservation.id");
    expect(fn).not.toMatch(/insert into public\.reservations/);
    expect(fn).not.toContain("status            = 'cancelled'");
  });

  it("12. court/time/duration/Member are never in either UPDATE's SET list — only owner_user_id/notes (reservation) and pro_id/last_actor_id/last_actor_role (lesson_requests) change", () => {
    const fn = functionBody();
    const resUpdateIdx = fn.indexOf("update public.reservations");
    const resUpdateEnd = fn.indexOf("where id = v_reservation.id", resUpdateIdx);
    const resSetClause = fn.slice(resUpdateIdx, resUpdateEnd);
    expect(resSetClause).not.toMatch(/court_id\s*=|starts_at\s*=|ends_at\s*=|roster_member_id\s*=/);

    const lrUpdateIdx = fn.indexOf("update public.lesson_requests");
    const lrUpdateEnd = fn.indexOf("where id = p_request_id", lrUpdateIdx);
    const lrSetClause = fn.slice(lrUpdateIdx, lrUpdateEnd);
    expect(lrSetClause).not.toMatch(/duration_minutes\s*=|lesson_type_id\s*=|roster_member_id\s*=|member_id\s*=|proposed_starts_at\s*=|proposed_ends_at\s*=|proposed_court_id\s*=/);
  });

  it("13. lesson_requests.pro_id changes atomically to p_new_pro_id", () => {
    const fn = functionBody();
    expect(fn).toMatch(/update public\.lesson_requests\s*\n\s*set pro_id\s*=\s*p_new_pro_id/);
  });

  it("14. reservations.owner_user_id changes atomically to p_new_pro_id", () => {
    const fn = functionBody();
    expect(fn).toMatch(/update public\.reservations\s*\n\s*set owner_user_id = p_new_pro_id/);
  });

  it("15. old Pro loses / new Pro gains assigned-Pro access purely via the live pro_id/owner_user_id fields this function updates — no separate ACL/assignment table exists or is touched", () => {
    const fn = functionBody();
    expect(fn).not.toMatch(/create table|alter table|assignment|acl/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Notifications and audit log
// ═══════════════════════════════════════════════════════════════════════════

describe("notifications and audit log", () => {
  it("16. inserts exactly one audit_log entry naming the old and new pro", () => {
    const fn = functionBody();
    const occurrences = fn.split("insert into public.audit_log").length - 1;
    expect(occurrences).toBe(1);
    const idx = fn.indexOf("insert into public.audit_log");
    const block = fn.slice(idx, fn.indexOf(");", idx));
    expect(block).toContain("'admin_reassign_confirmed_lesson_pro'");
    expect(block).toContain("'old_pro_id',      v_old_pro_id");
    expect(block).toContain("'new_pro_id',      p_new_pro_id");
  });

  it("17. notifies the NEW pro, reusing the existing lesson_provider_reassigned kind", () => {
    const fn = functionBody();
    expect(fn).toContain("v_club_id, p_new_pro_id, 'lesson_provider_reassigned',");
  });

  it("17. notifies the OLD pro, reusing the same kind", () => {
    const fn = functionBody();
    expect(fn).toContain("v_club_id, v_old_pro_id, 'lesson_provider_reassigned',");
  });

  it("17. notifies the Member only when member_id is not null (a no-account Member has no user_id — the calling Server Action sends the roster operational email instead)", () => {
    const fn = functionBody();
    const idx = fn.indexOf("if v_request.member_id is not null then");
    expect(idx).toBeGreaterThan(-1);
    const block = fn.slice(idx, fn.indexOf("end if;", idx));
    expect(block).toContain("v_club_id, v_request.member_id, 'lesson_provider_reassigned',");
  });

  it("no new notification kind is introduced — 'lesson_provider_reassigned' is the only kind this function ever inserts", () => {
    const fn = functionBody();
    const kinds = new Set(
      [...fn.matchAll(/insert into public\.notifications[\s\S]{0,120}'([a-z_]+)'/g)].map(m => m[1]),
    );
    expect(kinds.size).toBe(1);
    expect(kinds.has("lesson_provider_reassigned")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Payment non-interference
// ═══════════════════════════════════════════════════════════════════════════

describe("18. zero payment/refund mutation", () => {
  it("never references public.payments — no lookup, no update, no insert", () => {
    const fn = functionBody();
    expect(fn).not.toMatch(/payments/i);
  });

  it("never references stripe/checkout/refund in any form", () => {
    const fn = functionBody();
    expect(fn).not.toMatch(/stripe|checkout|refund/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Non-broadening of the two existing, related functions
// ═══════════════════════════════════════════════════════════════════════════

describe("reassign_lesson_provider and admin_update_member_lesson are not broadened by this migration", () => {
  it("reassign_lesson_provider (0132) still rejects a confirmed request — its pending/proposed-only boundary is untouched", () => {
    const s = readSource(REASSIGN_LESSON_PROVIDER_PATH);
    expect(s).toContain(
      "if v_request.status not in ('pending', 'proposed')\n" +
      "     or (v_request.status = 'proposed' and v_request.linked_reservation_id is not null)\n" +
      "  then\n" +
      "    raise exception 'invalid_status_for_reassign';",
    );
  });

  it("admin_update_member_lesson (0138) is unmodified by this checkpoint — this migration does not redefine it", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/create or replace function public\.admin_update_member_lesson/);
    // Sanity: confirm the function still exists at its known location, untouched.
    const s = readSource(ADMIN_UPDATE_MEMBER_LESSON_PATH);
    expect(s).toContain("CREATE OR REPLACE FUNCTION public.admin_update_member_lesson");
  });

  it("the plain _lesson_check_pro_availability (0126) is not redefined by this migration — it retains its existing profiles-derived club/timezone behavior for its OTHER, unmodified callers (propose_lesson_time, admin_update_member_lesson, accept_lesson_proposal)", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/create or replace function public\._lesson_check_pro_availability\(/);
    const s = readSource("supabase/migrations/0126_member_schedule_guards.sql");
    expect(s).toContain("create or replace function public._lesson_check_pro_availability(");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Multi-club correction — _lesson_check_pro_availability_for_club (new
// private helper)
// ═══════════════════════════════════════════════════════════════════════════

describe("_lesson_check_pro_availability_for_club — new private helper", () => {
  it("is SECURITY DEFINER with search_path pinned to public, pg_temp", () => {
    const fn = helperFunctionBody();
    expect(fn).toContain("security definer");
    expect(fn).toContain("set search_path = public, pg_temp");
  });

  it("takes p_club_id as an explicit parameter — never derives club from the target Pro's profile", () => {
    const fn = helperFunctionBody();
    expect(fn).toContain(
      "create or replace function public._lesson_check_pro_availability_for_club(\n" +
      "  p_pro_id             uuid,\n" +
      "  p_club_id            uuid,\n",
    );
    expect(fn).not.toMatch(/from public\.profiles/);
  });

  it("is fully private — EXECUTE revoked from public, anon, AND authenticated (never becomes a client-callable capability)", () => {
    const sql = migrationSql();
    expect(sql).toContain(
      "revoke execute on function public._lesson_check_pro_availability_for_club(uuid, uuid, timestamptz, timestamptz, uuid)\n" +
      "  from public, anon, authenticated;",
    );
    // No corresponding GRANT to any role exists for this function.
    expect(sql).not.toMatch(/grant\s+execute on function public\._lesson_check_pro_availability_for_club/);
  });

  it("reservation conflict check is reproduced verbatim from _lesson_check_pro_availability (0126) — genuinely club-independent, unchanged", () => {
    const fn = helperFunctionBody();
    const original = readSource("supabase/migrations/0126_member_schedule_guards.sql");
    const idx = original.indexOf("-- Check overlapping court reservations owned by the pro");
    const end = original.indexOf("if v_conflict > 0 then raise exception 'pro_has_conflict'; end if;", idx);
    const originalBlock = original.slice(idx, end);
    // Every structural clause of the original reservation-conflict query is
    // present verbatim in the new helper.
    for (const line of [
      "r.owner_user_id = p_pro_id",
      "r.status        in ('pending', 'confirmed')",
      "tstzrange(r.starts_at, r.ends_at, '[)') && v_range",
    ]) {
      expect(originalBlock).toContain(line);
      expect(fn).toContain(line);
    }
  });

  it("event-participation and event-creator conflict checks are reproduced verbatim — unchanged, club-independent", () => {
    const fn = helperFunctionBody();
    expect(fn).toContain("ep.status     = 'confirmed';");
    expect(fn).toContain("if v_conflict > 0 then raise exception 'pro_has_event_conflict'; end if;");
    expect(fn).toContain("e.status     = 'scheduled'");
  });

  it("blackout timezone lookup uses p_club_id — never a club derived from public.profiles", () => {
    const fn = helperFunctionBody();
    expect(fn).toContain("select timezone into v_tz from public.clubs where id = p_club_id;");
  });

  it("blackout row scan is scoped to b.club_id = p_club_id, in addition to pro_id and date — a blackout at a DIFFERENT club can never match", () => {
    const fn = helperFunctionBody();
    const idx = fn.indexOf("select 1 from public.pro_blackout_dates b");
    const end = fn.indexOf("raise exception 'pro_on_blackout';", idx);
    const block = fn.slice(idx, end);
    expect(block).toContain("b.pro_id       = p_pro_id");
    expect(block).toContain("b.club_id      = p_club_id");
    expect(block).toContain("b.blackout_date = v_local_date");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Multi-club correction — get_confirmed_lesson_reassignment_pros (new
// public RPC, the confirmed-reassignment-only provider picker)
// ═══════════════════════════════════════════════════════════════════════════

describe("get_confirmed_lesson_reassignment_pros — new public RPC", () => {
  it("is SECURITY DEFINER with search_path pinned to public, pg_temp", () => {
    const fn = pickerFunctionBody();
    expect(fn).toContain("security definer");
    expect(fn).toContain("set search_path = public, pg_temp");
  });

  it("takes no parameters — scoped entirely to the caller's own current_user_club_id()", () => {
    const fn = pickerFunctionBody();
    expect(fn).toContain("returns table (");
    expect(fn).toContain("select public.current_user_club_id(), public.current_user_role()");
  });

  it("Admin/Staff only — no Pro or Member branch in the role gate", () => {
    const fn = pickerFunctionBody();
    expect(fn).toContain("if v_role is null or v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;");
  });

  it("sources candidates from public.club_memberships, scoped to v_club_id (the CALLER's current club) — not p.club_id/p.role/p.is_lesson_provider", () => {
    const fn = pickerFunctionBody();
    const idx = fn.indexOf("return query");
    const clause = fn.slice(idx);
    expect(clause).toContain("from public.club_memberships cm");
    expect(clause).toContain("cm.club_id            = v_club_id");
    expect(clause).toContain("cm.status              = 'active'");
    expect(clause).toContain("cm.removed_at is null");
    expect(clause).toContain("cm.role                in ('pro', 'admin', 'staff')");
    expect(clause).toContain("cm.is_lesson_provider  = true");
  });

  it("returns cm.role/cm.is_lesson_provider (per-club canonical), joined to profiles ONLY for global identity (first_name/last_name)", () => {
    const fn = pickerFunctionBody();
    expect(fn).toContain("select p.id, p.first_name, p.last_name, cm.role, cm.is_lesson_provider");
    expect(fn).toContain("join public.profiles         p on p.id = cm.user_id");
  });

  it("is authenticated-callable only — revoked from public/anon, granted to authenticated (matching get_admin_club_pros' own posture, never broader)", () => {
    const sql = migrationSql();
    expect(sql).toContain("revoke execute on function public.get_confirmed_lesson_reassignment_pros() from public, anon;");
    expect(sql).toContain("grant  execute on function public.get_confirmed_lesson_reassignment_pros() to authenticated;");
  });

  it("get_admin_club_pros (0132) is completely unmodified by this migration — pending/proposed reassignment, lesson creation, and every other flow keep their existing profiles-based picker exactly as before", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/create or replace function public\.get_admin_club_pros/);
    const s = readSource(REASSIGN_LESSON_PROVIDER_PATH);
    expect(s).toContain("create or replace function public.get_admin_club_pros()");
    expect(s).toContain("from public.profiles p\n     where p.club_id            = v_profile.club_id");
  });
});
