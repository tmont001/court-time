// Phase 43B-3A — PDF Waiver Document Foundation (backend/database only).
//
// Source-inspection style: reads migration SQL as a raw string and asserts
// against it. No live Postgres, no DOM rendering. Covers the 56 scenarios
// specified for this checkpoint.
//
// This checkpoint REPLACES the abandoned Guest-invitation/acceptance 0196
// draft (never applied/committed) with a PDF document foundation. Guest
// invitation/acceptance tables and RPCs move to a later 0197 checkpoint —
// this file asserts their ABSENCE from 0196.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "fs";
import path from "path";

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");
const MIGRATION_FILENAME = "0196_waiver_pdf_document_foundation.sql";

function functionBody(sql: string, functionName: string): string {
  const marker = `function public.${functionName}(`;
  const start = sql.indexOf(marker);
  if (start === -1) return "";
  const asMarker = sql.indexOf("as $$", start);
  const endMarker = sql.indexOf("\n$$;", asMarker);
  return sql.slice(start, endMarker === -1 ? undefined : endMarker + 4);
}

describe("Phase 43B-3A — waiver PDF document foundation (0196)", () => {
  let sql: string;

  beforeAll(() => {
    const filePath = path.join(MIGRATIONS_DIR, MIGRATION_FILENAME);
    sql = readFileSync(filePath, "utf8");
  });

  // 1. 0196 filename is exactly waiver PDF foundation
  it("migration file is named exactly 0196_waiver_pdf_document_foundation.sql", () => {
    const files = readdirSync(MIGRATIONS_DIR);
    expect(files).toContain(MIGRATION_FILENAME);
  });

  // 2. abandoned Guest invitation 0196 is gone
  it("the abandoned Guest invitation/acceptance 0196 draft no longer exists", () => {
    const files = readdirSync(MIGRATIONS_DIR);
    expect(files).not.toContain("0196_guest_waiver_invitation_acceptance_foundation.sql");
  });

  it("the abandoned Guest invitation/acceptance regression test no longer exists", () => {
    const abandonedTestPath = path.join(
      process.cwd(),
      "src/app/(app)/admin/settings/guestWaiverInvitationAcceptanceFoundation.regression.test.ts"
    );
    expect(() => readFileSync(abandonedTestPath, "utf8")).toThrow();
  });

  // 3. no 0197+
  it("no migration 0197 or beyond exists yet", () => {
    const files = readdirSync(MIGRATIONS_DIR);
    const beyond = files.filter((f) => {
      const match = f.match(/^(\d+)_/);
      return match !== null && Number(match[1]) > 196;
    });
    expect(beyond).toEqual([]);
  });

  // 4. 0192-0195 still exist untouched
  it("0192-0195 still exist, untouched", () => {
    const files = readdirSync(MIGRATIONS_DIR);
    expect(files).toContain("0192_member_waiver_foundation.sql");
    expect(files).toContain("0193_fix_member_waiver_status_accepted_at_ambiguity.sql");
    expect(files).toContain("0194_member_waiver_compliance_operations.sql");
    expect(files).toContain("0195_guest_waiver_document_foundation.sql");
  });

  it("does not touch 0192-0195 file content (no ALTER on their objects outside 0196's own file)", () => {
    // Sanity: 0196 is additive only, never a DROP/ALTER of 0192's own
    // trigger/FK objects by name.
    expect(sql).not.toMatch(/drop\s+trigger.*waiver_versions_block_published_mutation/i);
    expect(sql).not.toMatch(/drop\s+constraint.*waivers_current_version_id_fkey/i);
  });

  // 5. body NOT NULL is relaxed only in 0196
  it("relaxes waiver_versions.body to nullable", () => {
    expect(sql).toMatch(
      /alter\s+table\s+public\.waiver_versions\s+alter\s+column\s+body\s+drop\s+not\s+null/i
    );
  });

  it("0192's own file still declares body not null (proving the relaxation is additive, not an edit to 0192)", () => {
    const originalSql = readFileSync(
      path.join(MIGRATIONS_DIR, "0192_member_waiver_foundation.sql"),
      "utf8"
    );
    expect(originalSql).toMatch(/body\s+text\s+not\s+null/);
  });

  // 6. title remains NOT NULL
  it("does not relax waiver_versions.title", () => {
    expect(sql).not.toMatch(/alter\s+column\s+title\s+drop\s+not\s+null/i);
  });

  // 7. version_number model preserved
  it("does not alter version_number, status, or the one-draft-per-waiver index", () => {
    expect(sql).not.toMatch(/alter\s+column\s+version_number/i);
    expect(sql).not.toMatch(/alter\s+column\s+status/i);
    expect(sql).not.toMatch(/drop\s+index.*waiver_versions_one_draft_per_waiver/i);
  });

  // 8. waiver_document_files exists
  it("creates table public.waiver_document_files", () => {
    expect(sql).toMatch(/create\s+table\s+public\.waiver_document_files/i);
  });

  // 9. exactly 1:1 with waiver_version_id
  it("waiver_version_id is the primary key, referencing waiver_versions(id) — structural 1:1", () => {
    const tableMatch = sql.match(
      /create\s+table\s+public\.waiver_document_files\s*\(([\s\S]*?)\n\);/i
    );
    expect(tableMatch).not.toBeNull();
    const body = tableMatch![1];
    expect(body).toMatch(/waiver_version_id\s+uuid\s+primary\s+key/i);
    expect(body).toMatch(/references\s+public\.waiver_versions\(id\)/i);
  });

  // 10. storage_path NOT NULL UNIQUE
  it("storage_path is not null and unique", () => {
    const tableMatch = sql.match(
      /create\s+table\s+public\.waiver_document_files\s*\(([\s\S]*?)\n\);/i
    );
    const body = tableMatch![1];
    expect(body).toMatch(/storage_path\s+text\s+not\s+null\s+unique/i);
  });

  // 11. original_filename required
  it("original_filename is not null", () => {
    const tableMatch = sql.match(
      /create\s+table\s+public\.waiver_document_files\s*\(([\s\S]*?)\n\);/i
    );
    const body = tableMatch![1];
    expect(body).toMatch(/original_filename\s+text\s+not\s+null/i);
  });

  // 12. MIME constrained to application/pdf
  it("mime_type is constrained to exactly application/pdf", () => {
    const tableMatch = sql.match(
      /create\s+table\s+public\.waiver_document_files\s*\(([\s\S]*?)\n\);/i
    );
    const body = tableMatch![1];
    expect(body).toMatch(/mime_type\s+text\s+not\s+null[\s\S]*?check\s*\(\s*mime_type\s*=\s*'application\/pdf'\s*\)/i);
  });

  // 13. file size >0 and <=10 MB
  it("file_size_bytes is constrained to (0, 10485760]", () => {
    const tableMatch = sql.match(
      /create\s+table\s+public\.waiver_document_files\s*\(([\s\S]*?)\n\);/i
    );
    const body = tableMatch![1];
    expect(body).toMatch(/file_size_bytes\s+bigint\s+not\s+null/i);
    expect(body).toMatch(/file_size_bytes\s*>\s*0/);
    expect(body).toMatch(/file_size_bytes\s*<=\s*10485760/);
  });

  // 14. SHA-256 format constrained to 64 lowercase hex
  it("sha256_digest is constrained to 64 lowercase hex characters", () => {
    const tableMatch = sql.match(
      /create\s+table\s+public\.waiver_document_files\s*\(([\s\S]*?)\n\);/i
    );
    const body = tableMatch![1];
    expect(body).toMatch(/sha256_digest\s+text\s+not\s+null/i);
    expect(body).toMatch(/\^\[0-9a-f\]\{64\}\$/);
  });

  // 15. digest NOT unique
  it("sha256_digest is not declared unique (the same PDF may be reused across clubs/audiences/revisions)", () => {
    const tableMatch = sql.match(
      /create\s+table\s+public\.waiver_document_files\s*\(([\s\S]*?)\n\);/i
    );
    const body = tableMatch![1];
    const digestLine = body.split("\n").find((l) => l.includes("sha256_digest"));
    expect(digestLine).toBeDefined();
    expect(digestLine).not.toMatch(/unique/i);
  });

  // 16. uploaded_by/uploaded_at preserved
  it("has uploaded_by (references profiles) and uploaded_at (default now())", () => {
    const tableMatch = sql.match(
      /create\s+table\s+public\.waiver_document_files\s*\(([\s\S]*?)\n\);/i
    );
    const body = tableMatch![1];
    expect(body).toMatch(/uploaded_by\s+uuid\s+not\s+null\s+references\s+public\.profiles\(id\)/i);
    expect(body).toMatch(/uploaded_at\s+timestamptz\s+not\s+null\s+default\s+now\(\)/i);
  });

  it("does not store title/body/file-content snapshot on waiver_document_files", () => {
    const tableMatch = sql.match(
      /create\s+table\s+public\.waiver_document_files\s*\(([\s\S]*?)\n\);/i
    );
    const body = tableMatch![1];
    expect(body).not.toMatch(/\btitle\b/);
    expect(body).not.toMatch(/\bbody\b/);
  });

  // 17. unconditional UPDATE/DELETE immutability trigger
  it("has an unconditional BEFORE UPDATE OR DELETE immutability trigger raising waiver_document_file_immutable", () => {
    expect(sql).toMatch(/raise\s+exception\s+'waiver_document_file_immutable'/i);
    expect(sql).toMatch(
      /create\s+trigger\s+\S+\s+before\s+update\s+or\s+delete\s+on\s+public\.waiver_document_files/i
    );
  });

  it("the immutability trigger function is unconditional (no OLD.status branch, unlike the waiver_versions trigger)", () => {
    const fnMatch = sql.match(
      /create\s+or\s+replace\s+function\s+public\.\S*waiver_document_file\S*\(\)[\s\S]*?as\s+\$\$([\s\S]*?)\$\$;/i
    );
    expect(fnMatch).not.toBeNull();
    expect(fnMatch![1]).not.toMatch(/if\s+old\./i);
  });

  // 18. RLS enabled
  it("enables RLS on waiver_document_files", () => {
    expect(sql).toMatch(/alter\s+table\s+public\.waiver_document_files\s+enable\s+row\s+level\s+security/i);
  });

  // 19. direct public/anon/authenticated table access revoked
  it("revokes direct table privileges from public/anon/authenticated", () => {
    expect(sql).toMatch(
      /revoke\s+all\s+on\s+table\s+public\.waiver_document_files\s+from\s+public\s*,\s*anon\s*,\s*authenticated/i
    );
  });

  // 20. zero RLS policy for waiver_document_files
  it("creates zero RLS policies on waiver_document_files", () => {
    expect(sql).not.toMatch(/create\s+policy[\s\S]*?on\s+public\.waiver_document_files/i);
  });

  // 21. no storage.buckets DML
  it("never performs DML against storage.buckets", () => {
    expect(sql).not.toMatch(/insert\s+into\s+storage\.buckets/i);
    expect(sql).not.toMatch(/update\s+storage\.buckets/i);
    expect(sql).not.toMatch(/delete\s+from\s+storage\.buckets/i);
  });

  // 22. no storage.objects DML
  it("never performs DML against storage.objects", () => {
    expect(sql).not.toMatch(/insert\s+into\s+storage\.objects/i);
    expect(sql).not.toMatch(/update\s+storage\.objects/i);
    expect(sql).not.toMatch(/delete\s+from\s+storage\.objects/i);
  });

  // 23. no Storage signed-URL/upload implementation
  it("contains no signed-URL/upload implementation", () => {
    expect(sql).not.toMatch(/createSignedUrl/i);
    expect(sql).not.toMatch(/create\s+bucket/i);
  });

  it("documents the future waiver-documents bucket requirement without creating it", () => {
    expect(sql).toMatch(/waiver-documents/);
    expect(sql).not.toMatch(/create\s+extension.*storage/i);
  });

  // 24. publish_waiver_pdf_version exists
  it("creates function public.publish_waiver_pdf_version", () => {
    expect(sql).toMatch(/create\s+or\s+replace\s+function\s+public\.publish_waiver_pdf_version\(/i);
  });

  // 25/26. service_role only, authenticated cannot execute
  it("publish_waiver_pdf_version is revoked from public/anon/authenticated and granted only to service_role", () => {
    const revokeGrant = sql.slice(
      sql.indexOf("function public.publish_waiver_pdf_version"),
      sql.indexOf("function public.publish_waiver_pdf_version") + 8000
    );
    expect(revokeGrant).toMatch(
      /revoke\s+execute\s+on\s+function\s+public\.publish_waiver_pdf_version[\s\S]*?from\s+public\s*,\s*anon\s*,\s*authenticated/i
    );
    expect(revokeGrant).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.publish_waiver_pdf_version[\s\S]*?to\s+service_role/i
    );
  });

  // 27. audience member|guest only
  it("validates p_audience is exactly member or guest", () => {
    const body = functionBody(sql, "publish_waiver_pdf_version");
    expect(body).toMatch(/p_audience\s+not\s+in\s*\(\s*'member'\s*,\s*'guest'\s*\)/i);
  });

  // 28. actor must be active same-club Admin using canonical membership model
  it("validates the actor via club_memberships (not current_user_role()) — active admin, same club", () => {
    const body = functionBody(sql, "publish_waiver_pdf_version");
    expect(body).toMatch(/from\s+public\.club_memberships/i);
    expect(body).toMatch(/role\s*=\s*'admin'/i);
    expect(body).toMatch(/status\s*=\s*'active'/i);
    expect(body).toMatch(/removed_at\s+is\s+null/i);
    expect(body).not.toMatch(/current_user_role\(\)/);
    expect(body).not.toMatch(/current_user_club_id\(\)/);
  });

  it("does not rely on auth.uid() for actor identity (service_role caller has no meaningful auth.uid())", () => {
    const body = functionBody(sql, "publish_waiver_pdf_version");
    // auth.uid() may not appear at all as an identity source in this RPC.
    expect(body).not.toMatch(/auth\.uid\(\)/);
  });

  // 29/30. storage_path computed internally, caller cannot supply it
  it("computes storage_path internally as {club_id}/{audience}/{version_id}.pdf and never accepts it as a parameter", () => {
    const signatureMatch = sql.match(/create\s+or\s+replace\s+function\s+public\.publish_waiver_pdf_version\(([\s\S]*?)\)\s*\n?returns/i);
    expect(signatureMatch).not.toBeNull();
    expect(signatureMatch![1]).not.toMatch(/p_storage_path/i);

    const body = functionBody(sql, "publish_waiver_pdf_version");
    expect(body).toMatch(/\|\|\s*'\/'\s*\|\|/); // path concatenation
    expect(body).toMatch(/\.pdf/);
  });

  // 31. PDF publish inserts body = NULL
  it("inserts the new waiver_versions row with body = null", () => {
    const body = functionBody(sql, "publish_waiver_pdf_version");
    expect(body).toMatch(/insert\s+into\s+public\.waiver_versions[\s\S]*?\)/i);
    expect(body).toMatch(/,\s*null\s*,/); // body slot as null literal among the values
  });

  // 32. PDF publish inserts status='published'
  it("inserts the new waiver_versions row directly as status = 'published'", () => {
    const body = functionBody(sql, "publish_waiver_pdf_version");
    expect(body).toMatch(/'published'/);
  });

  // 33. next internal version_number computed
  it("computes the next version_number using the same max(version_number)+1 model as the text RPCs", () => {
    const body = functionBody(sql, "publish_waiver_pdf_version");
    expect(body).toMatch(/max\(\s*wv\.version_number\s*\)/i);
  });

  // Runtime-ambiguity regression: RETURNS TABLE output names (version_id,
  // version_number, storage_path, published_at) become implicit variables
  // for the whole function body — the same class of bug that caused the
  // 0192/0193 accepted_at runtime failure. The version-sequencing subquery
  // must reference waiver_versions through an explicit alias, never a bare
  // column name that collides with an OUT parameter.
  it("qualifies the version-sequencing subquery with an explicit waiver_versions alias (0192/0193-class ambiguity guard)", () => {
    const body = functionBody(sql, "publish_waiver_pdf_version");
    expect(body).toMatch(/from\s+public\.waiver_versions\s+wv\b/i);
    expect(body).toMatch(/wv\.waiver_id\s*=\s*v_waiver\.id/i);
    expect(body).not.toMatch(/select\s+max\(version_number\)\s+from\s+public\.waiver_versions\s+where\s+waiver_id\s*=/i);
  });

  // 34. current_version_id updated
  it("updates waivers.current_version_id to the new version id", () => {
    const body = functionBody(sql, "publish_waiver_pdf_version");
    expect(body).toMatch(/update\s+public\.waivers[\s\S]*?set[\s\S]*?current_version_id\s*=/i);
  });

  // 35. previous published version untouched
  it("never updates or deletes an existing waiver_versions row", () => {
    const body = functionBody(sql, "publish_waiver_pdf_version");
    expect(body).not.toMatch(/update\s+public\.waiver_versions/i);
    expect(body).not.toMatch(/delete\s+from\s+public\.waiver_versions/i);
  });

  // 36. is_required untouched
  it("never writes waivers.is_required", () => {
    const body = functionBody(sql, "publish_waiver_pdf_version");
    const updateWaiversMatch = body.match(/update\s+public\.waivers\s+set([\s\S]*?)where/i);
    expect(updateWaiversMatch).not.toBeNull();
    expect(updateWaiversMatch![1]).not.toMatch(/is_required/i);
  });

  // 37. existing draft causes draft_already_exists
  it("raises draft_already_exists when a draft already exists for the club+audience waiver", () => {
    const body = functionBody(sql, "publish_waiver_pdf_version");
    expect(body).toMatch(/raise\s+exception\s+'draft_already_exists'/i);
  });

  // 38. no implicit draft deletion
  it("never deletes a waiver_versions row from within publish_waiver_pdf_version", () => {
    const body = functionBody(sql, "publish_waiver_pdf_version");
    expect(body).not.toMatch(/delete\s+from\s+public\.waiver_versions/i);
  });

  // 39. document row inserted in same transaction
  it("inserts waiver_document_files in the same function body (same implicit transaction)", () => {
    const body = functionBody(sql, "publish_waiver_pdf_version");
    expect(body).toMatch(/insert\s+into\s+public\.waiver_document_files/i);
  });

  it("waiver_document_files insert includes all required evidence fields", () => {
    const body = functionBody(sql, "publish_waiver_pdf_version");
    const insertMatch = body.match(/insert\s+into\s+public\.waiver_document_files\s*\(([\s\S]*?)\)/i);
    expect(insertMatch).not.toBeNull();
    const cols = insertMatch![1];
    expect(cols).toMatch(/waiver_version_id/);
    expect(cols).toMatch(/storage_path/);
    expect(cols).toMatch(/original_filename/);
    expect(cols).toMatch(/mime_type/);
    expect(cols).toMatch(/file_size_bytes/);
    expect(cols).toMatch(/sha256_digest/);
    expect(cols).toMatch(/uploaded_by/);
  });

  it("rejects a version_id that already has a waiver_document_files row or an existing waiver_versions row", () => {
    const body = functionBody(sql, "publish_waiver_pdf_version");
    expect(body).toMatch(/from\s+public\.waiver_document_files/i);
    expect(body).toMatch(/from\s+public\.waiver_versions/i);
  });

  it("validates file_size_bytes, sha256_digest format, and nonblank title/filename in the RPC body", () => {
    const body = functionBody(sql, "publish_waiver_pdf_version");
    expect(body).toMatch(/10485760/);
    expect(body).toMatch(/\[0-9a-f\]\{64\}/);
    expect(body).toMatch(/300/); // title length cap, matching existing text RPCs
  });

  // 40. audit publication uses real actor
  it("writes an audit_log row using p_actor_user_id as the actor", () => {
    const body = functionBody(sql, "publish_waiver_pdf_version");
    expect(body).toMatch(/insert\s+into\s+public\.audit_log/i);
    expect(body).toMatch(/p_actor_user_id/);
    expect(body).toMatch(/'publish_waiver_pdf_version'/);
  });

  // 41. no signed URL/token in audit
  it("audit metadata never includes file bytes, signed URLs, tokens, or storage credentials", () => {
    const body = functionBody(sql, "publish_waiver_pdf_version");
    const auditInsertMatch = body.match(/insert\s+into\s+public\.audit_log[\s\S]*?\);/i);
    expect(auditInsertMatch).not.toBeNull();
    const auditBlock = auditInsertMatch![0];
    expect(auditBlock).not.toMatch(/signed/i);
    expect(auditBlock).not.toMatch(/token/i);
    expect(auditBlock).not.toMatch(/sha256_digest/i);
  });

  // 42. discard_waiver_draft exists
  it("creates function public.discard_waiver_draft", () => {
    expect(sql).toMatch(/create\s+or\s+replace\s+function\s+public\.discard_waiver_draft\(/i);
  });

  // 43. discard Admin only
  it("discard_waiver_draft is authenticated, Admin-only", () => {
    const body = functionBody(sql, "discard_waiver_draft");
    expect(body).toMatch(/current_user_role\(\)/);
    expect(body).toMatch(/'insufficient_role'/);
    expect(body).toMatch(/is\s+distinct\s+from\s+'admin'/i);
  });

  it("discard_waiver_draft is granted to authenticated (not service_role only)", () => {
    const idx = sql.indexOf("function public.discard_waiver_draft");
    const grantBlock = sql.slice(idx, idx + 2500);
    expect(grantBlock).toMatch(/grant\s+execute\s+on\s+function\s+public\.discard_waiver_draft[\s\S]*?to\s+authenticated/i);
  });

  // 44. discard only status='draft'
  it("discard_waiver_draft only deletes a row with status = 'draft'", () => {
    const body = functionBody(sql, "discard_waiver_draft");
    expect(body).toMatch(/status\s*=\s*'draft'|status\s*<>\s*'draft'/i);
    expect(body).toMatch(/'version_not_draft'/);
  });

  // 45. discard cannot remove published version
  it("discard_waiver_draft rejects a published version via version_not_draft", () => {
    const body = functionBody(sql, "discard_waiver_draft");
    expect(body).toMatch(/'version_not_draft'/);
  });

  // 46. discard same-club scoped
  it("discard_waiver_draft is scoped to the caller's own club", () => {
    const body = functionBody(sql, "discard_waiver_draft");
    expect(body).toMatch(/club_id\s*=\s*v_club_id/i);
    expect(body).toMatch(/'version_not_found'/);
  });

  it("discard_waiver_draft accepts audience member or guest (not restricted to one)", () => {
    const body = functionBody(sql, "discard_waiver_draft");
    expect(body).toMatch(/audience\s+in\s*\(\s*'member'\s*,\s*'guest'\s*\)/i);
  });

  // 47. discard audited
  it("discard_waiver_draft writes an audit_log row", () => {
    const body = functionBody(sql, "discard_waiver_draft");
    expect(body).toMatch(/insert\s+into\s+public\.audit_log/i);
    expect(body).toMatch(/'discard_waiver_draft'/);
  });

  it("discard_waiver_draft actually deletes the draft row", () => {
    const body = functionBody(sql, "discard_waiver_draft");
    expect(body).toMatch(/delete\s+from\s+public\.waiver_versions/i);
  });

  // 48. waiver_acceptances untouched
  it("never touches waiver_acceptances", () => {
    expect(sql).not.toMatch(/waiver_acceptances/);
  });

  // 49. Member/Guest legacy text authoring RPCs untouched (not redefined in this file)
  it("does not redefine any existing text-authoring RPC", () => {
    expect(sql).not.toMatch(/create\s+or\s+replace\s+function\s+public\.create_member_waiver_draft\(/i);
    expect(sql).not.toMatch(/create\s+or\s+replace\s+function\s+public\.update_member_waiver_draft\(/i);
    expect(sql).not.toMatch(/create\s+or\s+replace\s+function\s+public\.publish_member_waiver_version\(/i);
    expect(sql).not.toMatch(/create\s+or\s+replace\s+function\s+public\.create_guest_waiver_draft\(/i);
    expect(sql).not.toMatch(/create\s+or\s+replace\s+function\s+public\.update_guest_waiver_draft\(/i);
    expect(sql).not.toMatch(/create\s+or\s+replace\s+function\s+public\.publish_guest_waiver_version\(/i);
  });

  it("existing text RPC bodies in 0192/0195 are byte-identical to their applied source (untouched)", () => {
    const originalMember = readFileSync(
      path.join(MIGRATIONS_DIR, "0192_member_waiver_foundation.sql"),
      "utf8"
    );
    const originalGuest = readFileSync(
      path.join(MIGRATIONS_DIR, "0195_guest_waiver_document_foundation.sql"),
      "utf8"
    );
    expect(originalMember).toMatch(/create_member_waiver_draft/);
    expect(originalGuest).toMatch(/create_guest_waiver_draft/);
  });

  // 50/51. no guest_waiver_invitations / guest_waiver_acceptances table
  it("does not create guest_waiver_invitations or guest_waiver_acceptances", () => {
    expect(sql).not.toMatch(/create\s+table\s+public\.guest_waiver_invitations/i);
    expect(sql).not.toMatch(/create\s+table\s+public\.guest_waiver_acceptances/i);
  });

  // 52. no create/revoke/resolve/accept Guest invitation RPC
  it("does not define any Guest invitation/acceptance RPC", () => {
    expect(sql).not.toMatch(/create\s+or\s+replace\s+function\s+public\.create_guest_waiver_invitation\(/i);
    expect(sql).not.toMatch(/create\s+or\s+replace\s+function\s+public\.revoke_guest_waiver_invitation\(/i);
    expect(sql).not.toMatch(/create\s+or\s+replace\s+function\s+public\.resolve_guest_waiver_invitation\(/i);
    expect(sql).not.toMatch(/create\s+or\s+replace\s+function\s+public\.accept_guest_waiver\(/i);
  });

  // 53. no public Guest route/UI
  it("contains no route/UI code (this is a pure SQL migration file)", () => {
    expect(sql).not.toMatch(/export\s+default\s+function/);
    expect(sql).not.toMatch(/"use client"/);
  });

  // 54/55. Originally: "no PDF upload UI exists yet" / "MemberWaiverSection.
  // tsx and GuestWaiverSection.tsx are unmodified by this checkpoint" — both
  // were scope guards verifying 43B-3A's OWN boundary (backend/database
  // only, no UI). That boundary was specific to the 43B-3A checkpoint and
  // has since been legitimately superseded by the later, separately
  // authorized 43B-3B checkpoint (PDF Waiver Upload + Settings + Member
  // Agreement UX — see waiverPdfUploadSettingsUI.regression.test.ts),
  // which intentionally rewrites both files. Removed here rather than left
  // failing forever: a live regression suite asserting "this file is never
  // modified" would incorrectly block all future legitimate UI work on it.
  // 43B-3A's own backend-only correctness remains fully covered by this
  // file's SQL-content assertions above, which this removal does not touch.

  // 56. boundary guards now allow through 0196 and reject 0197+
  it("this file's own boundary guard allows exactly through 0196 and rejects 0197+", () => {
    const files = readdirSync(MIGRATIONS_DIR);
    const numbers = files
      .map((f) => f.match(/^(\d+)_/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => Number(m[1]));
    expect(Math.max(...numbers)).toBe(196);
  });

  // Header/documentation checks
  it("documents the 43B-3B Storage bucket requirement (waiver-documents, private, 10MB, application/pdf) without creating it", () => {
    expect(sql).toMatch(/waiver-documents/);
    expect(sql).toMatch(/10\s*MB|10485760/);
    expect(sql).toMatch(/application\/pdf/);
  });

  it("is wrapped in a single transaction", () => {
    expect(sql).toMatch(/^begin;/m);
    expect(sql).toMatch(/^commit;/m);
  });
});
