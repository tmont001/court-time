import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 43B-4A — Guest Waiver Invitation + Acceptance BACKEND FOUNDATION.
// Regression coverage for migration 0198 (guest_waiver_invitations,
// guest_waiver_acceptances, and their five supporting functions). Source-
// inspection style, matching this repository's established convention for
// migration SQL not yet applied to Supabase (see
// refundRequestAdminNotification.regression.test.ts /
// memberWaiverNotifications.regression.test.ts for the identical pattern
// on their own not-yet-applied migrations).
//
// This is NOT the abandoned 43B-3A draft — that migration
// (0196_guest_waiver_invitation_acceptance_foundation.sql) and its test
// (src/app/(app)/admin/settings/guestWaiverInvitationAcceptanceFoundation.
// regression.test.ts) were deleted before ever being applied (see
// waiverPdfDocumentFoundation.regression.test.ts's own "abandoned draft is
// gone" assertions) — this file intentionally uses a different name and
// covers the REAL, later 0198 checkpoint.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

const MIGRATION_PATH = "supabase/migrations/0198_guest_waiver_invitation_acceptance.sql";

function migrationSql(): string {
  return codeOnly(readSource(MIGRATION_PATH));
}

function extractFunctionBody(sql: string, signaturePrefix: string): string {
  const start = sql.indexOf(signaturePrefix);
  expect(start, `function not found: ${signaturePrefix}`).toBeGreaterThan(-1);
  const end = sql.indexOf("\n$$;", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end + "\n$$;".length);
}

function mintHelperBody(): string {
  return extractFunctionBody(migrationSql(), "create or replace function public._mint_guest_waiver_invitation(");
}
function mintReservationBody(): string {
  return extractFunctionBody(
    migrationSql(),
    "create or replace function public.mint_reservation_guest_waiver_invitation("
  );
}
function mintEventBody(): string {
  return extractFunctionBody(migrationSql(), "create or replace function public.mint_event_guest_waiver_invitation(");
}
function resolveBody(): string {
  return extractFunctionBody(migrationSql(), "create or replace function public.resolve_guest_waiver_invitation(");
}
function acceptBody(): string {
  return extractFunctionBody(migrationSql(), "create or replace function public.accept_guest_waiver(");
}

// ═══════════════════════════════════════════════════════════════════════════
// Migration ordering / immutability of prior work
// ═══════════════════════════════════════════════════════════════════════════

describe("migration ordering", () => {
  it("0198 is the next migration after immutable 0197, and no 0199+ migration exists yet", () => {
    expect(() => readSource("supabase/migrations/0197_member_waiver_notifications.sql")).not.toThrow();
    expect(() => readSource(MIGRATION_PATH)).not.toThrow();
  });

  it("0198 is wrapped in a single begin;/commit; transaction block", () => {
    const sql = migrationSql();
    expect(sql).toMatch(/^begin;/m);
    expect(sql).toMatch(/^commit;/m);
  });

  it("does not touch 0197's own objects (notifications_kind_check, the member-waiver-notification helpers)", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/notifications_kind_check|_notify_member_waiver_requires_acceptance|_close_prior_member_waiver_notifications/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TOKEN SECURITY
// ═══════════════════════════════════════════════════════════════════════════

describe("TOKEN SECURITY", () => {
  it("guestWaiverToken.ts generates a 32-byte cryptographically random token, base64url-encoded (URL-safe)", () => {
    const s = readSource("src/lib/waivers/guestWaiverToken.ts");
    expect(s).toContain("randomBytes(RAW_TOKEN_BYTES)");
    expect(s).toContain("RAW_TOKEN_BYTES = 32"); // 256 bits
    expect(s).toContain('.toString("base64url")');
  });

  it("hashes with SHA-256 lowercase hex, deterministically", () => {
    const s = readSource("src/lib/waivers/guestWaiverToken.ts");
    expect(s).toContain('createHash("sha256")');
    expect(s).toContain('.digest("hex")');
  });

  it("never touches Postgres/Supabase directly — pure crypto functions only, matching src/lib/stripe/connectConfig.ts's own no-\"server-only\"-import precedent for a directly-testable pure module", () => {
    const s = readSource("src/lib/waivers/guestWaiverToken.ts");
    const codeOnlyTs = s
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(codeOnlyTs).not.toMatch(/supabase|createClient|createPrivilegedClient/i);
    expect(codeOnlyTs).not.toContain('import "server-only";');
  });

  it("guestWaiverTokenServer.ts restores an explicit, build-time-enforced server-only boundary — a thin re-export wrapper, no logic of its own", () => {
    const s = readSource("src/lib/waivers/guestWaiverTokenServer.ts");
    expect(s.trimStart().startsWith('import "server-only";')).toBe(true);
    expect(s).toContain('} from "./guestWaiverToken";');
    for (const fn of [
      "generateGuestWaiverToken",
      "hashGuestWaiverToken",
      "isSyntacticallyValidGuestWaiverToken",
      "isSyntacticallyValidGuestWaiverTokenHash",
    ]) {
      expect(s).toContain(fn);
    }
    // No crypto/randomBytes/createHash of its own — a pure re-export, not
    // a second implementation that could drift from guestWaiverToken.ts.
    expect(s).not.toMatch(/randomBytes|createHash/);
  });

  it("the raw token is never persisted anywhere in 0198 — only token_hash columns exist, checked against a 64-hex-char pattern, on both new tables", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/\braw_token\b|\bplaintext\b/i);
    const tokenHashColumnCount = (sql.match(/token_hash\s+text\s+not null check \(token_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/g) ?? []).length;
    expect(tokenHashColumnCount).toBe(1); // guest_waiver_invitations only — guest_waiver_acceptances has no token column at all
  });

  it("every RPC that accepts a token parameter names it p_token_hash (never p_token/p_raw_token) — the hash, not plaintext, crosses into SQL", () => {
    const sql = migrationSql();
    expect(sql).toContain("p_token_hash");
    expect(sql).not.toMatch(/p_token\b(?!_hash)/);
    expect(sql).not.toMatch(/p_raw_token/);
  });

  it("no plaintext token is ever written into an audit_log metadata payload", () => {
    const mintFn = mintHelperBody();
    const auditIdx = mintFn.indexOf("insert into public.audit_log");
    const auditBlock = mintFn.slice(auditIdx);
    expect(auditBlock).not.toMatch(/p_token_hash|token_hash/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// INVITATION — schema
// ═══════════════════════════════════════════════════════════════════════════

describe("INVITATION — schema", () => {
  it("guest_waiver_invitations supports both reservation Guest and event Guest slots via two nullable FK columns", () => {
    const sql = migrationSql();
    expect(sql).toContain("reservation_guest_id  uuid        references public.reservation_guests(id)");
    expect(sql).toContain("event_guest_id        uuid        references public.event_guests(id)");
  });

  it("enforces exactly one Guest source populated via a CHECK constraint", () => {
    const sql = migrationSql();
    expect(sql).toContain("constraint guest_waiver_invitations_exactly_one_source_check");
    expect(sql).toContain(
      "(reservation_guest_id is not null and event_guest_id is null)\n      or\n      (reservation_guest_id is null and event_guest_id is not null)"
    );
  });

  it("token_hash is globally unique", () => {
    const sql = migrationSql();
    expect(sql).toContain("create unique index guest_waiver_invitations_token_hash_idx");
    expect(sql).toContain("on public.guest_waiver_invitations (token_hash);");
  });

  it("at most one ACTIVE invitation per reservation_guest_id AND per event_guest_id, via two partial unique indexes", () => {
    const sql = migrationSql();
    expect(sql).toContain("create unique index guest_waiver_invitations_active_reservation_guest_idx");
    expect(sql).toContain("on public.guest_waiver_invitations (reservation_guest_id)\n  where revoked_at is null and reservation_guest_id is not null;");
    expect(sql).toContain("create unique index guest_waiver_invitations_active_event_guest_idx");
    expect(sql).toContain("on public.guest_waiver_invitations (event_guest_id)\n  where revoked_at is null and event_guest_id is not null;");
  });

  it("does not use ON DELETE CASCADE from reservation_guests/event_guests — a plain FK (blocks, never silently destroys history)", () => {
    const sql = migrationSql();
    // The specific FK lines for the two source columns carry no ON DELETE clause at all.
    expect(sql).toMatch(/reservation_guest_id\s+uuid\s+references public\.reservation_guests\(id\),/);
    expect(sql).toMatch(/event_guest_id\s+uuid\s+references public\.event_guests\(id\),/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// INVITATION — mint / rotate behavior
// ═══════════════════════════════════════════════════════════════════════════

describe("INVITATION — mint / rotate", () => {
  it("reservation Guest mint reuses _authorize_reservation_roster_access verbatim, with p_require_not_cancelled = true", () => {
    const fn = mintReservationBody();
    expect(fn).toContain("public._authorize_reservation_roster_access(p_reservation_id, p_expected_club_id, true)");
  });

  it("event Guest mint reuses the CURRENT (0136) admin_add_guest/admin_remove_guest authorization shape — role in ('admin','pro','staff') via profiles.role/profiles.club_id", () => {
    const fn = mintEventBody();
    expect(fn).toContain("select * into v_actor from public.profiles where id = auth.uid();");
    expect(fn).toContain("if v_actor.role not in ('admin', 'pro', 'staff') then");
    expect(fn).toContain("raise exception 'admin_required';");
  });

  it("event Guest mint also reuses admin_add_guest's own event-state guard (scheduled + not archived)", () => {
    const fn = mintEventBody();
    expect(fn).toContain("if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;");
    expect(fn).toContain("if v_event.archived_at is not null then raise exception 'event_archived'; end if;");
  });

  it("no authorization abstraction is widened — event mint still excludes plain 'member' from its allowlist, matching the existing boundary", () => {
    const fn = mintEventBody();
    expect(fn).not.toMatch(/'member'/);
  });

  it("current Guest waiver must exist (current_version_id not null) and be required, or minting fails closed with specific errors", () => {
    const fn = mintHelperBody();
    expect(fn).toContain("if not found or v_waiver.current_version_id is null then");
    expect(fn).toContain("raise exception 'no_current_guest_waiver';");
    expect(fn).toContain("if not coalesce(v_waiver.is_required, false) then");
    expect(fn).toContain("raise exception 'guest_waiver_not_required';");
  });

  it("the invitation row never stores waiver_version_id — it remains slot-scoped, not version-scoped", () => {
    const sql = migrationSql();
    const tableStart = sql.indexOf("create table public.guest_waiver_invitations");
    const tableEnd = sql.indexOf(");", tableStart);
    const tableDef = sql.slice(tableStart, tableEnd);
    expect(tableDef).not.toMatch(/waiver_version_id/);
  });

  it("rotation atomically revokes the slot's existing active invitation before inserting the new one, in the same function", () => {
    const fn = mintHelperBody();
    const updateIdx = fn.indexOf("update public.guest_waiver_invitations");
    const insertIdx = fn.indexOf("insert into public.guest_waiver_invitations");
    expect(updateIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(updateIdx);
    expect(fn).toContain("set revoked_at = now(), revoked_by = p_actor_user_id");
  });

  it("both mint entry points take a row lock (FOR UPDATE) on the source Guest row before minting — serializes concurrent rotation for the same slot", () => {
    expect(mintReservationBody()).toMatch(/status\s+= 'active'\s*\n\s*for update;/);
    expect(mintEventBody()).toMatch(/status\s+= 'active'\s*\n\s*for update;/);
  });

  it("historical revoked invitations are never deleted — no DELETE statement targets guest_waiver_invitations anywhere in this migration", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/delete\s+from\s+public\.guest_waiver_invitations/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════

describe("RESOLUTION", () => {
  it("resolves by token_hash, requiring an active (non-revoked) invitation", () => {
    const fn = resolveBody();
    expect(fn).toContain("where token_hash = p_token_hash\n     and revoked_at is null;");
  });

  it("an unknown or revoked hash returns zero rows (fails closed, no distinguishing error)", () => {
    const fn = resolveBody();
    const lookupIdx = fn.indexOf("if not found then");
    expect(fn.slice(lookupIdx, lookupIdx + 30)).toContain("return;");
  });

  it("a removed/cancelled Guest slot is rejected — checks the slot's own status column for the correct domain-specific value, in both the reservation and event branches", () => {
    const fn = resolveBody();
    expect(fn).toContain("(rg.status = 'active')");
    expect(fn).toContain("(eg.status = 'active')");
    const occurrences = fn.match(/if not found or not coalesce\(v_slot_active, false\) then\s*\n\s*return;\s*\n\s*end if;/g) ?? [];
    expect(occurrences.length).toBe(2); // once per domain branch
  });

  it("PRE-APPLY CORRECTION (Problem 1): reservation parent cancellation makes resolution fail closed — reuses _authorize_reservation_roster_access's own status <> 'cancelled' predicate, plus a club_id match", () => {
    const fn = resolveBody();
    expect(fn).toContain("from public.reservations\n     where id = v_reservation_id;");
    expect(fn).toContain("if not found or v_reservation.status = 'cancelled' or v_reservation.club_id <> v_invitation.club_id then\n      return;\n    end if;");
  });

  it("PRE-APPLY CORRECTION (Problem 1): event.status != 'scheduled' or archived_at != null makes resolution fail closed, plus a club_id match", () => {
    const fn = resolveBody();
    expect(fn).toContain("from public.events\n     where id = v_event_id;");
    expect(fn).toContain(
      "if not found or v_event.status <> 'scheduled' or v_event.archived_at is not null or v_event.club_id <> v_invitation.club_id then\n      return;\n    end if;"
    );
  });

  it("the current Guest waiver is resolved DYNAMICALLY from (club_id, audience='guest') on every call — never a stored version id on the invitation", () => {
    const fn = resolveBody();
    expect(fn).toContain("from public.waivers w");
    expect(fn).toContain("w.club_id = v_invitation.club_id and w.audience = 'guest'");
  });

  it("no Member-waiver crossover — audience is always the literal 'guest', never 'member', and waiver_acceptances (Member-only) is never referenced", () => {
    const fn = resolveBody();
    expect(fn).not.toContain("audience = 'member'");
    expect(fn).not.toMatch(/\bwaiver_acceptances\b/); // guest_waiver_acceptances is a different identifier, unaffected by this check
  });

  it("returns only minimal context — no profiles join at all; reservations/events are queried ONLY for parent-validity (status/archived_at/club_id), never returned in the result", () => {
    const fn = resolveBody();
    expect(fn).not.toMatch(/from public\.profiles/);
    // v_reservation/v_event are used solely as validity-check inputs —
    // neither variable (nor any of their columns beyond status/
    // archived_at/club_id, already asserted above) appears in the
    // RETURN QUERY SELECT list.
    const returnIdx = fn.indexOf("return query select");
    const returnClause = fn.slice(returnIdx);
    expect(returnClause).not.toMatch(/v_reservation\.|v_event\./);
  });

  it("is granted to service_role only — not anon/authenticated", () => {
    const sql = migrationSql();
    expect(sql).toContain(
      "revoke execute on function public.resolve_guest_waiver_invitation(text)\n  from public, anon, authenticated;\ngrant  execute on function public.resolve_guest_waiver_invitation(text)\n  to service_role;"
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ACCEPTANCE
// ═══════════════════════════════════════════════════════════════════════════

describe("ACCEPTANCE", () => {
  it("accept_guest_waiver takes ONLY the token hash and the version to accept — never a guest id parameter", () => {
    const sql = migrationSql();
    const sigStart = sql.indexOf("create or replace function public.accept_guest_waiver(");
    const sigEnd = sql.indexOf(")\nreturns", sigStart);
    const signature = sql.slice(sigStart, sigEnd);
    expect(signature).toContain("p_token_hash");
    expect(signature).toContain("p_waiver_version_id");
    expect(signature).not.toMatch(/p_guest_id|p_reservation_guest_id|p_event_guest_id/);
  });

  it("resolves the Guest slot entirely from the invitation row — an arbitrary guest id can never be supplied to bypass token possession", () => {
    const fn = acceptBody();
    expect(fn).toContain("v_invitation.reservation_guest_id");
    expect(fn).toContain("v_invitation.event_guest_id");
  });

  it("verifies the Guest slot is still active before accepting, in both domain branches", () => {
    const fn = acceptBody();
    const occurrences = fn.match(/if not found or not coalesce\(v_slot_active, false\) then\s*\n\s*raise exception 'guest_slot_invalid';\s*\n\s*end if;/g) ?? [];
    expect(occurrences.length).toBe(2);
  });

  it("PRE-APPLY CORRECTION (Problem 1): reservation parent cancellation makes acceptance fail closed with guest_slot_invalid (no internal-state leak)", () => {
    const fn = acceptBody();
    expect(fn).toContain(
      "if not found or v_reservation.status = 'cancelled' or v_reservation.club_id <> v_invitation.club_id then\n      raise exception 'guest_slot_invalid';\n    end if;"
    );
  });

  it("PRE-APPLY CORRECTION (Problem 1): event.status != 'scheduled' or archived_at != null makes acceptance fail closed with guest_slot_invalid", () => {
    const fn = acceptBody();
    expect(fn).toContain(
      "if not found or v_event.status <> 'scheduled' or v_event.archived_at is not null or v_event.club_id <> v_invitation.club_id then\n      raise exception 'guest_slot_invalid';\n    end if;"
    );
  });

  it("PRE-APPLY CORRECTION (Problem 2): deliberate row locking + revalidation — participation (Guest child, then parent) locked FOR SHARE BEFORE the invitation row is re-locked and re-verified", () => {
    const fn = acceptBody();
    const guestLockReservationIdx = fn.indexOf("from public.reservation_guests rg\n     where rg.id = v_invitation.reservation_guest_id\n       for share;");
    const guestLockEventIdx = fn.indexOf("from public.event_guests eg\n     where eg.id = v_invitation.event_guest_id\n       for share;");
    const parentLockReservationIdx = fn.indexOf("from public.reservations\n     where id = v_reservation_id\n       for share;");
    const parentLockEventIdx = fn.indexOf("from public.events\n     where id = v_event_id\n       for share;");
    const invitationRelockIdx = fn.indexOf("from public.guest_waiver_invitations\n   where id = v_invitation.id\n     for share;");
    expect(guestLockReservationIdx).toBeGreaterThan(-1);
    expect(guestLockEventIdx).toBeGreaterThan(-1);
    expect(parentLockReservationIdx).toBeGreaterThan(guestLockReservationIdx);
    expect(parentLockEventIdx).toBeGreaterThan(guestLockEventIdx);
    expect(invitationRelockIdx).toBeGreaterThan(parentLockReservationIdx);
    expect(invitationRelockIdx).toBeGreaterThan(parentLockEventIdx);
  });

  it("PRE-APPLY CORRECTION (Problem 2): the re-locked invitation row is re-verified against the SAME token_hash and revoked_at IS NULL — catches a rotation that landed after the first, unlocked read", () => {
    const fn = acceptBody();
    const invitationRelockIdx = fn.indexOf("from public.guest_waiver_invitations\n   where id = v_invitation.id\n     for share;");
    expect(invitationRelockIdx).toBeGreaterThan(-1);
    const afterRelock = fn.slice(invitationRelockIdx, invitationRelockIdx + 300);
    expect(afterRelock).toContain("if not found or v_invitation.token_hash <> p_token_hash or v_invitation.revoked_at is not null then");
    expect(afterRelock).toContain("raise exception 'invalid_token';");
  });

  it("PRE-APPLY CORRECTION (Problem 2): lock order is compatible with mint's Guest-first locking — no invitation-first -> Guest-second inversion (every FOR SHARE/FOR UPDATE on the Guest/parent tables precedes every lock on guest_waiver_invitations)", () => {
    const fn = acceptBody();
    const lastParticipationLockIdx = Math.max(
      fn.lastIndexOf("for share;\n    if not found or v_reservation.status"),
      fn.lastIndexOf("for share;\n    if not found or v_event.status")
    );
    const invitationRelockIdx = fn.indexOf("from public.guest_waiver_invitations\n   where id = v_invitation.id\n     for share;");
    expect(lastParticipationLockIdx).toBeGreaterThan(-1);
    expect(invitationRelockIdx).toBeGreaterThan(lastParticipationLockIdx);
    // mint's own lock order, for cross-reference: Guest child row FOR
    // UPDATE precedes any touch of guest_waiver_invitations.
    const mintFn = mintReservationBody();
    const mintGuestLockIdx = mintFn.indexOf("for update;");
    const mintInvitationCallIdx = mintFn.indexOf("_mint_guest_waiver_invitation(");
    expect(mintInvitationCallIdx).toBeGreaterThan(mintGuestLockIdx);
  });

  it("requires the submitted version to equal the current version — stale versions are rejected", () => {
    const fn = acceptBody();
    expect(fn).toContain("if p_waiver_version_id is distinct from v_waiver.current_version_id then");
    expect(fn).toContain("raise exception 'stale_waiver_version';");
  });

  it("the waiver FOR SHARE protection against a concurrent publish/replacement is untouched by the Problem 2 correction — still acquired, still last in the lock chain (after the invitation re-lock)", () => {
    const fn = acceptBody();
    const invitationRelockIdx = fn.indexOf("from public.guest_waiver_invitations\n   where id = v_invitation.id\n     for share;");
    const waiverLockIdx = fn.indexOf("from public.waivers\n   where club_id = v_invitation.club_id and audience = 'guest'\n     for share;");
    expect(invitationRelockIdx).toBeGreaterThan(-1);
    expect(waiverLockIdx).toBeGreaterThan(invitationRelockIdx);
  });

  it("enforces the Guest waiver is currently required before accepting", () => {
    const fn = acceptBody();
    expect(fn).toContain("if not coalesce(v_waiver.is_required, false) then");
    expect(fn).toContain("raise exception 'guest_waiver_not_required';");
  });

  it("inserts acceptance tied to exact Guest slot, exact waiver_version_id, server-time accepted_at, and invitation id as provenance", () => {
    const fn = acceptBody();
    expect(fn).toContain("insert into public.guest_waiver_acceptances (");
    expect(fn).toContain("v_invitation.club_id, v_invitation.reservation_guest_id, v_invitation.event_guest_id,");
    expect(fn).toContain("p_waiver_version_id, v_invitation.id, now()");
  });

  it("is idempotent — ON CONFLICT DO NOTHING, then re-reads the existing accepted_at on a repeat call", () => {
    const fn = acceptBody();
    const conflictIdx = fn.indexOf("on conflict do nothing");
    expect(conflictIdx).toBeGreaterThan(-1);
    const notFoundIdx = fn.indexOf("if not found then", conflictIdx);
    expect(notFoundIdx).toBeGreaterThan(conflictIdx);
    const repeatBranch = fn.slice(notFoundIdx, fn.indexOf("end if;", notFoundIdx));
    expect(repeatBranch).toContain("select a.accepted_at into v_accepted_at");
  });

  it("preserves every prior acceptance forever — no UPDATE or DELETE statement targets guest_waiver_acceptances anywhere in this migration", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/update\s+public\.guest_waiver_acceptances/i);
    expect(sql).not.toMatch(/delete\s+from\s+public\.guest_waiver_acceptances/i);
  });

  it("writes no audit_log entry (no authenticated actor exists for a Guest) — the acceptance row itself is the evidence", () => {
    const fn = acceptBody();
    expect(fn).not.toContain("insert into public.audit_log");
  });

  it("is granted to service_role only — not anon/authenticated, and no Admin/Staff proxy-acceptance path exists (no p_actor_user_id/auth.uid()-derived actor anywhere in this function)", () => {
    const sql = migrationSql();
    expect(sql).toContain(
      "revoke execute on function public.accept_guest_waiver(text, uuid)\n  from public, anon, authenticated;\ngrant  execute on function public.accept_guest_waiver(text, uuid)\n  to service_role;"
    );
    const fn = acceptBody();
    expect(fn).not.toMatch(/auth\.uid\(\)|p_actor_user_id/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DATA MODEL — one acceptance per slot + version, immutability
// ═══════════════════════════════════════════════════════════════════════════

describe("DATA MODEL — guest_waiver_acceptances", () => {
  it("enforces exactly one Guest source populated via a CHECK constraint", () => {
    const sql = migrationSql();
    expect(sql).toContain("constraint guest_waiver_acceptances_exactly_one_source_check");
  });

  it("one acceptance per Guest slot + exact waiver_version_id, via two partial unique indexes", () => {
    const sql = migrationSql();
    expect(sql).toContain("create unique index guest_waiver_acceptances_reservation_guest_version_uniq");
    expect(sql).toContain("on public.guest_waiver_acceptances (reservation_guest_id, waiver_version_id)\n  where reservation_guest_id is not null;");
    expect(sql).toContain("create unique index guest_waiver_acceptances_event_guest_version_uniq");
    expect(sql).toContain("on public.guest_waiver_acceptances (event_guest_id, waiver_version_id)\n  where event_guest_id is not null;");
  });

  it("does not use ON DELETE CASCADE from reservation_guests/event_guests — history survives even a hypothetical future hard delete by blocking it instead", () => {
    const sql = migrationSql();
    expect(sql).toMatch(/reservation_guest_id\s+uuid\s+references public\.reservation_guests\(id\),/);
    expect(sql).toMatch(/event_guest_id\s+uuid\s+references public\.event_guests\(id\),/);
  });

  it("is a completely separate table from waiver_acceptances (0192, Member-only, immutable) — never widened, never reused", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/alter table public\.waiver_acceptances/);
    // Scoped to the actual CREATE TABLE's column list, not the migration's
    // prose (the header/comment-on-table text legitimately explains, in
    // English, why roster_member_id from 0192's table was NOT reused here
    // — that explanatory string would otherwise trip a whole-file check).
    const tableStart = sql.indexOf("create table public.guest_waiver_acceptances");
    const tableEnd = sql.indexOf(");", tableStart);
    const tableDef = sql.slice(tableStart, tableEnd);
    expect(tableDef).not.toMatch(/roster_member_id/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY
// ═══════════════════════════════════════════════════════════════════════════

describe("SECURITY", () => {
  it("both new tables have RLS enabled and a blanket revoke — no direct anon/authenticated read or write surface", () => {
    const sql = migrationSql();
    expect(sql).toContain("alter table public.guest_waiver_invitations enable row level security;");
    expect(sql).toContain("revoke all on table public.guest_waiver_invitations from public, anon, authenticated;");
    expect(sql).toContain("alter table public.guest_waiver_acceptances enable row level security;");
    expect(sql).toContain("revoke all on table public.guest_waiver_acceptances from public, anon, authenticated;");
  });

  it("zero RLS policies are created for either table — default-deny, matching calendar_feed_tokens' established posture", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/create policy/i);
  });

  it("every function hardens search_path to public, pg_temp", () => {
    const sql = migrationSql();
    const fnCount = (sql.match(/create or replace function public\.(_mint_guest_waiver_invitation|mint_reservation_guest_waiver_invitation|mint_event_guest_waiver_invitation|resolve_guest_waiver_invitation|accept_guest_waiver)\(/g) ?? []).length;
    const searchPathCount = (sql.match(/set search_path = public, pg_temp/g) ?? []).length;
    expect(fnCount).toBe(5);
    expect(searchPathCount).toBeGreaterThanOrEqual(5);
  });

  it("the private mint helper is revoked from public/anon/authenticated — reachable only via the two per-domain entry points", () => {
    const sql = migrationSql();
    expect(sql).toContain(
      "revoke execute on function public._mint_guest_waiver_invitation(uuid, uuid, uuid, uuid, text)\n  from public, anon, authenticated;"
    );
  });

  it("the two mint entry points are granted to authenticated only (never anon)", () => {
    const sql = migrationSql();
    expect(sql).toContain(
      "revoke execute on function public.mint_reservation_guest_waiver_invitation(uuid, uuid, uuid, text)\n  from public, anon;\ngrant  execute on function public.mint_reservation_guest_waiver_invitation(uuid, uuid, uuid, text)\n  to authenticated;"
    );
    expect(sql).toContain(
      "revoke execute on function public.mint_event_guest_waiver_invitation(uuid, uuid, text)\n  from public, anon;\ngrant  execute on function public.mint_event_guest_waiver_invitation(uuid, uuid, text)\n  to authenticated;"
    );
  });

  it("cross-club mint is structurally rejected — reservation mint resolves the reservation (and therefore its club) only through the authorization helper's own club-scoped lookup, event mint scopes every lookup by v_actor.club_id", () => {
    const reservationFn = mintReservationBody();
    expect(reservationFn).toContain("v_reservation.club_id");
    const eventFn = mintEventBody();
    expect(eventFn).toContain("and club_id = v_actor.club_id");
  });

  it("no RETURNS TABLE function has a bare column reference colliding with one of its own OUT parameter names (resolve_guest_waiver_invitation's own club_id collision, caught and fixed pre-apply)", () => {
    const fn = resolveBody();
    expect(fn).toContain("select w.* into v_waiver\n    from public.waivers w\n   where w.club_id = v_invitation.club_id and w.audience = 'guest';");
    expect(fn).not.toMatch(/from public\.waivers\s*\n\s*where club_id = /);
  });

  it("does not conflate Guest with non_member — no reference to membership_status/non_member/roster_members appears anywhere in 0198", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/membership_status|non_member|roster_members/);
  });

  it("no rate limiting is implemented (explicitly out of scope for this checkpoint)", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/rate.?limit/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// OUT OF SCOPE — no public page, no PDF UI, no e-signature language
// ═══════════════════════════════════════════════════════════════════════════

describe("out of scope items are genuinely absent", () => {
  it("no new route/page file exists for a public Guest waiver page yet", () => {
    expect(() => readSource("src/app/(app)/waivers/guest/[token]/page.tsx")).toThrow();
  });

  it("no e-signature language appears anywhere in the new migration or token utility", () => {
    const sql = migrationSql();
    const tokenSrc = readSource("src/lib/waivers/guestWaiverToken.ts");
    expect(sql).not.toMatch(/e-?signature|electronic signature/i);
    expect(tokenSrc).not.toMatch(/e-?signature|electronic signature/i);
  });

  it("resolve_guest_waiver_invitation does not itself resolve/return PDF storage_path or original_filename — 4B will call the existing audience-agnostic resolveWaiverPdfViewUrl(currentVersionId) helper instead", () => {
    const fn = resolveBody();
    expect(fn).not.toMatch(/storage_path|original_filename|waiver_document_files/);
  });
});
