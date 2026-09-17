import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Phase 43B-3B — PDF Waiver Upload + Settings + Member Agreement UX.
// Covers the direct-browser-upload/finalize architecture, secure PDF
// viewing, and the Member acceptance-page PDF behavior. Source-inspection
// style, matching this repository's established convention (no live
// Postgres/DOM render in this suite). Settings UI states (filename/Last
// updated/View PDF/Replace Waiver/no Version N/legacy-draft discard) are
// covered in the rewritten memberWaiverUI.regression.test.ts and
// guestWaiverSettingsUI.regression.test.ts — this file covers the upload/
// finalize/view Server Actions, the shared upload hook, the Member
// acceptance page/client, and this checkpoint's own security/scope guards.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const PDF_ACTIONS_PATH   = "src/app/(app)/admin/settings/waiverPdfActions.ts";
const UPLOAD_HOOK_PATH   = "src/app/(app)/admin/members/useWaiverPdfUpload.ts";
const PDF_VIEW_URL_PATH  = "src/lib/waivers/pdfViewUrl.ts";
const CONSTANTS_PATH     = "src/lib/waivers/constants.ts";
const MEMBER_PAGE_PATH   = "src/app/(app)/waivers/member/page.tsx";
const MEMBER_CLIENT_PATH = "src/app/(app)/waivers/member/WaiverAcceptanceClient.tsx";
const MEMBER_ACTIONS_PATH = "src/app/(app)/waivers/member/actions.ts";
const PROFILE_CARD_PATH  = "src/app/(app)/profile/WaiverStatusCard.tsx";
const MIGRATION_0196_PATH = "supabase/migrations/0196_waiver_pdf_document_foundation.sql";

function functionBody(source: string, exportName: string): string {
  const start = source.indexOf(`export async function ${exportName}(`);
  expect(start, `${exportName} not found`).toBeGreaterThan(-1);
  const nextExportIdx = source.indexOf("\nexport async function", start + 1);
  const nextConstFnIdx = source.indexOf("\nasync function", start + 1);
  const candidates = [nextExportIdx, nextConstFnIdx].filter((i) => i > -1);
  const end = candidates.length > 0 ? Math.min(...candidates) : -1;
  return source.slice(start, end > -1 ? end : undefined);
}

const pdfActions = readSource(PDF_ACTIONS_PATH);

// ═══════════════════════════════════════════════════════════════════════════
// UPLOAD / AUTH
// ═══════════════════════════════════════════════════════════════════════════

describe("authorizeWaiverPdfUploadAction — Admin-only authorization", () => {
  const fn = functionBody(pdfActions, "authorizeWaiverPdfUploadAction");

  it("1. only Admin may authorize upload", () => {
    expect(fn).toContain('profile?.role !== "admin"');
    expect(fn).toContain("insufficient_role");
  });

  it("2. audience must be exactly member or guest", () => {
    expect(pdfActions).toContain('function isValidAudience(value: unknown): value is Audience {');
    expect(pdfActions).toContain('value === "member" || value === "guest"');
    expect(fn).toContain("isValidAudience(audience)");
  });

  it("3. server generates the version UUID — never accepted from the caller", () => {
    expect(fn).toContain("const versionId = randomUUID();");
    const signature = pdfActions.slice(
      pdfActions.indexOf("export async function authorizeWaiverPdfUploadAction("),
      pdfActions.indexOf(")", pdfActions.indexOf("export async function authorizeWaiverPdfUploadAction("))
    );
    expect(signature).not.toMatch(/versionId|version_id/);
  });

  it("4. path is derived server-side via derivePath(clubId, audience, versionId), never caller-supplied", () => {
    expect(fn).toContain("const path = derivePath(clubId, audience, versionId);");
    expect(pdfActions).toContain("function derivePath(clubId: string, audience: Audience, versionId: string): string {");
    expect(pdfActions).toContain("return `${clubId}/${audience}/${versionId}.pdf`;");
  });

  it("5. mints the signed upload URL against the private waiver-documents bucket only", () => {
    expect(fn).toContain(".storage");
    expect(fn).toContain(".from(WAIVER_PDF_BUCKET)");
    expect(fn).toContain(".createSignedUploadUrl(path,");
  });

  it("6/7. authorizes a DIRECT browser upload — never accepts a File/Buffer/Blob, only filename (string) and fileSize (number)", () => {
    const signature = pdfActions.slice(
      pdfActions.indexOf("export async function authorizeWaiverPdfUploadAction("),
      pdfActions.indexOf(")", pdfActions.indexOf("export async function authorizeWaiverPdfUploadAction(") + 200)
    );
    expect(signature).toContain("filename: string");
    expect(signature).toContain("fileSize: number");
    expect(signature).not.toMatch(/: File\b|Buffer|ArrayBuffer|Blob/);
  });

  it("8. no upsert/overwrite of an existing object", () => {
    expect(fn).toContain("{ upsert: false }");
  });

  it("uses the privileged (service_role) client to mint the token — never the ordinary authenticated client", () => {
    expect(fn).toContain("createPrivilegedClient()");
  });
});

describe("finalizeWaiverPdfUploadAction — re-authorization and path re-derivation", () => {
  const fn = functionBody(pdfActions, "finalizeWaiverPdfUploadAction");

  it("9. re-authenticates the Admin independently of authorize (its own getAuthUser/getAuthProfile calls)", () => {
    expect(fn).toContain("const user = await getAuthUser();");
    expect(fn).toContain("const profile = await getAuthProfile();");
    expect(fn).toContain('profile?.role !== "admin"');
  });

  it("10. re-resolves the active club fresh — never trusts a clubId carried over from authorize", () => {
    expect(fn).toContain("const clubId = profile.club_id;");
    const signature = pdfActions.slice(
      pdfActions.indexOf("export async function finalizeWaiverPdfUploadAction("),
      pdfActions.indexOf(")", pdfActions.indexOf("export async function finalizeWaiverPdfUploadAction(") + 100)
    );
    expect(signature).not.toMatch(/clubId|club_id/);
  });

  it("11. derives the expected path itself, from THIS call's own fresh club/audience/versionId — never a client-supplied path", () => {
    expect(fn).toContain("const expectedPath = derivePath(clubId, audience, versionId);");
    expect(fn).toContain("Re-derived from THIS call's own fresh club/audience/versionId");
    const signature = pdfActions.slice(
      pdfActions.indexOf("export async function finalizeWaiverPdfUploadAction("),
      pdfActions.indexOf(")", pdfActions.indexOf("export async function finalizeWaiverPdfUploadAction(") + 100)
    );
    expect(signature).not.toMatch(/path\s*:/);
  });

  it("6/7. finalizes without ever receiving PDF bytes — signature is (audience, versionId, originalFilename) only", () => {
    const signature = pdfActions.slice(
      pdfActions.indexOf("export async function finalizeWaiverPdfUploadAction("),
      pdfActions.indexOf(")", pdfActions.indexOf("export async function finalizeWaiverPdfUploadAction(") + 200)
    );
    expect(signature).toContain("originalFilename: string");
    expect(signature).not.toMatch(/: File\b|Buffer|ArrayBuffer|Blob/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION (authoritative — actual downloaded bytes, never client claims)
// ═══════════════════════════════════════════════════════════════════════════

describe("finalizeWaiverPdfUploadAction — authoritative byte-level validation", () => {
  const fn = functionBody(pdfActions, "finalizeWaiverPdfUploadAction");

  it("12. size is checked against the ACTUAL downloaded buffer length, not a client-claimed size", () => {
    expect(fn).toContain("const buffer = Buffer.from(await blob.arrayBuffer());");
    expect(fn).toContain("buffer.length === 0 || buffer.length > WAIVER_PDF_MAX_BYTES");
  });

  it("13. MIME is not trusted as a string — validated via the actual magic header instead (see #14)", () => {
    expect(fn).not.toMatch(/blob\.type\s*===\s*["']application\/pdf["']/);
  });

  it("14. validates the actual %PDF- magic header on the downloaded bytes", () => {
    expect(fn).toContain('buffer.subarray(0, 5).toString("ascii")');
    expect(fn).toContain('header !== "%PDF-"');
    expect(fn).toContain("invalid_pdf_header");
  });

  it("15. SHA-256 is computed server-side from the actual downloaded buffer", () => {
    expect(fn).toContain('createHash("sha256").update(buffer).digest("hex")');
  });

  it("16. the client cannot supply digest/path/club_id/file size to finalize — none of those are parameters", () => {
    const signature = pdfActions.slice(
      pdfActions.indexOf("export async function finalizeWaiverPdfUploadAction("),
      pdfActions.indexOf(")", pdfActions.indexOf("export async function finalizeWaiverPdfUploadAction(") + 200)
    );
    expect(signature).not.toMatch(/digest|sha256|storage_?[Pp]ath|club_?[Ii]d|file_?[Ss]ize/);
  });

  it("17. a missing/invalid uploaded object cannot publish — download failure short-circuits before any validation or RPC call", () => {
    expect(fn).toContain("if (downloadError || !blob) {");
    expect(fn).toContain("uploaded_object_missing");
    const downloadIdx = fn.indexOf("downloadError || !blob");
    const publishIdx = fn.indexOf("publish_waiver_pdf_version");
    expect(downloadIdx).toBeGreaterThan(-1);
    expect(publishIdx).toBeGreaterThan(downloadIdx);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FINALIZATION — publish RPC contract, orphan cleanup, revalidation
// ═══════════════════════════════════════════════════════════════════════════

describe("finalizeWaiverPdfUploadAction — publish RPC contract and orphan cleanup", () => {
  const fn = functionBody(pdfActions, "finalizeWaiverPdfUploadAction");

  it("18/19. calls publish_waiver_pdf_version via the privileged client, matching 0196's exact param names, only after header/size validation", () => {
    expect(fn).toContain('privileged.rpc("publish_waiver_pdf_version", {');
    expect(fn).toContain("p_actor_user_id: user.id,");
    expect(fn).toContain("p_club_id: clubId,");
    expect(fn).toContain("p_audience: audience,");
    expect(fn).toContain("p_version_id: versionId,");
    expect(fn).toContain("p_original_filename: trimmedFilename,");
    expect(fn).toContain("p_title: title,");
    expect(fn).toContain("p_file_size_bytes: buffer.length,");
    expect(fn).toContain("p_sha256_digest: sha256Digest,");

    const migrationSql = readSource(MIGRATION_0196_PATH);
    expect(migrationSql).toContain("p_actor_user_id      uuid,");
    expect(migrationSql).toContain("p_club_id            uuid,");
    expect(migrationSql).toContain("p_audience           text,");
    expect(migrationSql).toContain("p_version_id         uuid,");
    expect(migrationSql).toContain("p_original_filename  text,");
    expect(migrationSql).toContain("p_title              text,");
    expect(migrationSql).toContain("p_file_size_bytes    bigint,");
    expect(migrationSql).toContain("p_sha256_digest      text");
  });

  it("20. a failed DB finalization triggers guarded cleanup, never an unconditional Storage remove", () => {
    const publishBlock = fn.slice(fn.indexOf("if (publishError)"), fn.indexOf("return { error: friendlyError"));
    expect(publishBlock).toContain("await removeUploadIfUnpublished(privileged, versionId, expectedPath);");
    expect(publishBlock).not.toMatch(/\.storage\.from\(WAIVER_PDF_BUCKET\)\.remove\(/);
  });

  it("21. guarded cleanup is used at every cleanup call site — invalid size, invalid header, and publish failure", () => {
    const removeCalls = fn.match(/removeUploadIfUnpublished\([^)]*\)/g) ?? [];
    expect(removeCalls.length).toBe(3);
    for (const call of removeCalls) {
      expect(call).toContain("privileged");
      expect(call).toContain("versionId");
      expect(call).toContain("expectedPath");
    }
  });

  it("7. there is no unguarded .storage.from(WAIVER_PDF_BUCKET).remove(...) call anywhere outside the guarded helper", () => {
    // Code only — the guard function's own preceding header comment
    // legitimately documents this exact call pattern in prose.
    const codeOnly = pdfActions.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    const guardFnStart = codeOnly.indexOf("async function removeUploadIfUnpublished(");
    const guardFnEnd = codeOnly.indexOf("export async function discardWaiverDraftAction(");
    const beforeGuard = codeOnly.slice(0, guardFnStart);
    const afterGuard = codeOnly.slice(guardFnEnd);
    expect(beforeGuard).not.toMatch(/\.storage\.from\(WAIVER_PDF_BUCKET\)\.remove\(/);
    expect(afterGuard).not.toMatch(/\.storage\.from\(WAIVER_PDF_BUCKET\)\.remove\(/);
    // Exactly one raw .remove( call in the whole file — inside the guard.
    const allRemoveCalls = codeOnly.match(/\.storage\.from\(WAIVER_PDF_BUCKET\)\.remove\(/g) ?? [];
    expect(allRemoveCalls.length).toBe(1);
  });

  describe("removeUploadIfUnpublished — evidence-preserving guarded cleanup", () => {
    const guardFn = pdfActions.slice(
      pdfActions.indexOf("async function removeUploadIfUnpublished("),
      pdfActions.indexOf("// ── C. Explicit legacy draft discard")
    );

    it("1. checks waiver_document_files for the version BEFORE any Storage removal", () => {
      const docCheckIdx = guardFn.indexOf('.from("waiver_document_files")');
      const removeIdx = guardFn.indexOf(".remove([expectedPath]);");
      expect(docCheckIdx).toBeGreaterThan(-1);
      expect(removeIdx).toBeGreaterThan(docCheckIdx);
      expect(guardFn).toContain('.eq("waiver_version_id", versionId)');
    });

    it("2. an existing document row prevents deletion — presence alone is sufficient to block, regardless of storage_path", () => {
      expect(guardFn).toContain("if (documentRow) return;");
      const blockLine = guardFn.slice(guardFn.indexOf("if (documentRow) return;"));
      expect(blockLine.slice(0, 80)).not.toMatch(/storage_path\s*===|storage_path\s*==/);
    });

    it("3. a guard-query error fails CLOSED for deletion — never proceeds to remove on an errored lookup", () => {
      expect(guardFn).toContain("if (guardError) return;");
      const guardErrorIdx = guardFn.indexOf("if (guardError) return;");
      const removeIdx = guardFn.indexOf(".remove([expectedPath]);");
      expect(guardErrorIdx).toBeGreaterThan(-1);
      expect(guardErrorIdx).toBeLessThan(removeIdx);
    });

    it("guard-query error never hides/overwrites the caller's own validation/publish error — the guard function only ever returns void", () => {
      expect(pdfActions).toContain("async function removeUploadIfUnpublished(");
      const signature = pdfActions.slice(
        pdfActions.indexOf("async function removeUploadIfUnpublished("),
        pdfActions.indexOf("{", pdfActions.indexOf("async function removeUploadIfUnpublished("))
      );
      expect(signature).toContain("Promise<void>");
    });

    it("4. only the no-document-row path reaches Storage removal, and only for expectedPath — never any other path", () => {
      const afterBothGuards = guardFn.slice(guardFn.indexOf("if (documentRow) return;"));
      expect(afterBothGuards).toContain(".remove([expectedPath]);");
      expect(afterBothGuards).not.toMatch(/\.remove\(\[(?!expectedPath)/);
    });

    it("5. version_id_already_exists can never delete an existing published PDF — the guard runs unconditionally before any remove, regardless of which error triggered cleanup", () => {
      // The guard function itself has no branching on WHICH error caused
      // cleanup to be invoked — every caller (invalid size, invalid
      // header, publish failure incl. version_id_already_exists) goes
      // through the identical documentRow check first.
      expect(guardFn).not.toMatch(/version_id_already_exists/);
      expect(guardFn.indexOf("if (documentRow) return;")).toBeLessThan(guardFn.indexOf(".remove([expectedPath]);"));
    });

    it("6. every cleanup call site supplies BOTH versionId and expectedPath to the guard", () => {
      const calls = fn.match(/removeUploadIfUnpublished\(privileged, versionId, expectedPath\)/g) ?? [];
      expect(calls.length).toBe(3);
    });
  });

  it("22. successful publication revalidates the Admin Members Waivers tab and Member-facing surfaces (Phase 43B-3E relocated the Admin waiver management surface from /admin/settings to /admin/members/waivers)", () => {
    const tail = fn.slice(fn.indexOf("revalidatePath"));
    expect(tail).toContain('revalidatePath("/admin/members/waivers");');
    expect(tail).toContain('revalidatePath("/waivers/member");');
    expect(tail).toContain('revalidatePath("/profile");');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Shared upload hook
// ═══════════════════════════════════════════════════════════════════════════

describe("useWaiverPdfUpload — shared client-side orchestration", () => {
  const s = readSource(UPLOAD_HOOK_PATH);

  it("validates the file client-side for UX only — never treated as authoritative", () => {
    expect(s).toContain("Browser-side UX validation only — never authoritative");
    expect(s).toContain('file.type !== "application/pdf"');
    expect(s).toContain("file.size > WAIVER_PDF_MAX_BYTES");
  });

  it("uploads directly to Storage via uploadToSignedUrl using the browser's own Supabase client — never a Server Action", () => {
    expect(s).toContain("createClient()");
    expect(s).toContain(".uploadToSignedUrl(authResult.path, authResult.token, file,");
  });

  it("calls authorize then finalize in sequence, surfacing errors from either step", () => {
    const authIdx = s.indexOf("authorizeWaiverPdfUploadAction(audience, file.name, file.size)");
    const uploadIdx = s.indexOf(".uploadToSignedUrl(");
    const finalizeIdx = s.indexOf("finalizeWaiverPdfUploadAction(");
    expect(authIdx).toBeGreaterThan(-1);
    expect(uploadIdx).toBeGreaterThan(authIdx);
    expect(finalizeIdx).toBeGreaterThan(uploadIdx);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY — bucket privacy, signed-URL expiry, cross-audience/cross-club
// ═══════════════════════════════════════════════════════════════════════════

describe("PDF viewing security (Admin Settings + Member acceptance page)", () => {
  const pdfViewUrl = readSource(PDF_VIEW_URL_PATH);

  it("43/44. never uses a public bucket or a permanent Storage URL — only createSignedUrl/createSignedUploadUrl appear, never getPublicUrl", () => {
    for (const source of [pdfActions, pdfViewUrl]) {
      expect(source).not.toMatch(/getPublicUrl/);
      expect(source).not.toMatch(/public:\s*true/);
    }
  });

  it("45. the download signed URL is short-lived (~5 minutes), never a session-length or permanent expiry", () => {
    expect(pdfViewUrl).toContain("const SIGNED_VIEW_URL_EXPIRES_SECONDS = 300;");
    expect(pdfViewUrl).toContain("createSignedUrl(documentRow.storage_path, SIGNED_VIEW_URL_EXPIRES_SECONDS)");
  });

  it("46. the Member view action takes NO audience/version parameter — it can only ever resolve the caller's own current Member waiver, never Guest's", () => {
    const memberActions = readSource(MEMBER_ACTIONS_PATH);
    const fnStart = memberActions.indexOf("export async function getMemberWaiverPdfViewUrlAction(");
    expect(fnStart).toBeGreaterThan(-1);
    const signature = memberActions.slice(fnStart, memberActions.indexOf(")", fnStart));
    expect(signature).toBe("export async function getMemberWaiverPdfViewUrlAction(");
    // Sliced to end-of-file (this is the last export in the file) rather
    // than the first "\n}" — the return type itself is a multi-line
    // object literal whose OWN closing "}" would otherwise truncate the
    // extraction before the function body even starts.
    const fn = memberActions.slice(fnStart);
    expect(fn).toContain('supabase.rpc("get_my_member_waiver_status")');
  });

  it("47. the Admin view action scopes current_version_id lookup to the caller's own club_id via RLS-scoped .eq — never a client-supplied club_id", () => {
    const fn = functionBody(pdfActions, "getAdminWaiverPdfViewUrlAction");
    expect(fn).toContain('.eq("club_id", clubId)');
    expect(fn).toContain("const clubId = profile.club_id;");
    const signature = pdfActions.slice(
      pdfActions.indexOf("export async function getAdminWaiverPdfViewUrlAction("),
      pdfActions.indexOf(")", pdfActions.indexOf("export async function getAdminWaiverPdfViewUrlAction(") + 60)
    );
    expect(signature).not.toMatch(/club/i);
  });

  it("48. no Guest-public PDF viewing exists — no public/unauthenticated route file was created", () => {
    const apiDir = join(process.cwd(), "src/app/api");
    const walk = (dir: string): string[] => {
      const entries = readdirSync(dir, { withFileTypes: true });
      return entries.flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
      );
    };
    const apiFiles = walk(apiDir);
    const waiverRelated = apiFiles.filter((f) => /waiver/i.test(f));
    expect(waiverRelated).toEqual([]);
  });

  it("49. no broad Storage write policy was added — this checkpoint created no new migration at all", () => {
    const files = readdirSync(join(process.cwd(), "supabase/migrations"));
    const beyond0196 = files.filter((f) => {
      const match = f.match(/^(\d+)_/);
      return match !== null && Number(match[1]) > 196;
    });
    expect(beyond0196).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MEMBER EXPERIENCE — /waivers/member PDF behavior
// ═══════════════════════════════════════════════════════════════════════════

describe("/waivers/member — PDF-backed vs legacy text detection and rendering", () => {
  const page = readSource(MEMBER_PAGE_PATH);
  const client = readSource(MEMBER_CLIENT_PATH);

  it("35. detects PDF-backed via body === null on the existing get_my_member_waiver_status() response — no new RPC/query", () => {
    expect(page).toContain('waiver?.body === null');
    expect((page.match(/\.rpc\(/g) ?? []).length).toBe(1);
  });

  it("35. does not render body text for a PDF-backed current version", () => {
    const bodyBlockIdx = page.indexOf("!isPdfBacked &&");
    expect(bodyBlockIdx).toBeGreaterThan(-1);
  });

  it("35/38. offers a PDF-review action, never Version N, on the acceptance page (Phase 43B-3D renamed 'View waiver PDF' to 'Review Waiver PDF' as part of the review-before-agreement gate)", () => {
    expect(client).toContain("Review Waiver PDF");
    expect(client).not.toMatch(/>\s*Version \{/);
    expect(client).not.toMatch(/>\s*Version \d/);
    expect(page).not.toMatch(/>\s*Version \{/);
  });

  it("36. requires an explicit agreement checkbox for a PDF-backed waiver, and Accept is disabled until checked", () => {
    expect(client).toContain('type="checkbox"');
    expect(client).toContain("I have read and agree to the waiver.");
    expect(client).toContain("disabled={isPending || (isPdfBacked && !agreed)}");
  });

  it("legacy text (isPdfBacked=false) never requires the checkbox — Accept stays gated only on isPending, exactly as before", () => {
    const disabledExpr = client.slice(
      client.indexOf("disabled={isPending || (isPdfBacked && !agreed)}"),
      client.indexOf("disabled={isPending || (isPdfBacked && !agreed)}") + 60
    );
    expect(disabledExpr).toContain("isPdfBacked && !agreed");
  });

  it("37. accept_member_waiver (0192/0193, applied/immutable) is still the sole acceptance call — unchanged signature, still keyed by currentVersionId", () => {
    const memberActions = readSource(MEMBER_ACTIONS_PATH);
    expect(memberActions).toContain('supabase.rpc("accept_member_waiver", {');
    expect(memberActions).toContain("p_waiver_version_id: waiverVersionId,");
    expect(client).toContain("acceptMemberWaiverAction(currentVersionId)");
  });

  it("39. legacy text rendering (title/body block) is preserved for a non-PDF-backed current version", () => {
    expect(page).toContain("whitespace-pre-wrap");
    expect(page).toContain("{waiver.body}");
  });

  it("40/41. status handling (current/never_accepted/outdated) is unchanged — the PDF gate only adds the checkbox/View PDF, it never alters acceptance state transitions", () => {
    expect(client).toContain('if (status === "current")');
    expect(client).toContain("setStatus(\"current\");");
  });
});

describe("WaiverStatusCard — 42. no Version N anywhere on the profile card", () => {
  const s = readSource(PROFILE_CARD_PATH);
  // Code only — the file's own header comment legitimately documents the
  // removed "versionNumber" prop/parenthetical in prose.
  const codeOnly = s.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");

  it("never renders a versionNumber-based parenthetical", () => {
    expect(codeOnly).not.toContain("versionNumber");
    expect(codeOnly).not.toMatch(/\(Version/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SCOPE
// ═══════════════════════════════════════════════════════════════════════════

describe("Phase 43B-3B scope guard", () => {
  it("50. 0196 remains untouched — still declares the exact applied publish_waiver_pdf_version/discard_waiver_draft/waiver_document_files contract", () => {
    const migrationSql = readSource(MIGRATION_0196_PATH);
    expect(migrationSql).toContain("create table public.waiver_document_files");
    expect(migrationSql).toContain("create or replace function public.publish_waiver_pdf_version(");
    expect(migrationSql).toContain("create or replace function public.discard_waiver_draft(");
  });

  it("51. no 0197 (or beyond) migration exists — no new migration was created by this checkpoint", () => {
    const files = readdirSync(join(process.cwd(), "supabase/migrations"));
    const beyond = files.filter((f) => {
      const match = f.match(/^(\d+)_/);
      return match !== null && Number(match[1]) > 196;
    });
    expect(beyond).toEqual([]);
  });

  it("52. no Guest invitation/acceptance backend exists anywhere in the touched files", () => {
    for (const source of [pdfActions, readSource(UPLOAD_HOOK_PATH), readSource(PDF_VIEW_URL_PATH)]) {
      expect(source).not.toMatch(/guest_waiver_invitation|guest_waiver_acceptance|resolve_guest_waiver_invitation|accept_guest_waiver/i);
    }
  });

  it("53. no URL-import ('Import PDF from URL') implementation exists — no function/feature name for fetching a PDF from an arbitrary URL", () => {
    for (const source of [pdfActions, readSource(UPLOAD_HOOK_PATH)]) {
      expect(source).not.toMatch(/fetchPdfFromUrl|importFromUrl|importPdfFromUrl|"Import PDF from URL"/i);
    }
  });

  it("54. no e-signature/drawn-signature/initials work exists (excludes the legitimate Supabase Storage API name createSignedUploadUrl/uploadToSignedUrl)", () => {
    for (const source of [pdfActions, readSource(UPLOAD_HOOK_PATH), readSource(MEMBER_CLIENT_PATH)]) {
      expect(source).not.toMatch(/e-signature|drawn signature|signature (pad|field|image)|\binitials\b|DocuSign/i);
    }
  });

  it("constants module is plain (no 'use server') — a 'use server' file may only export async functions, so shared string/number constants live here instead", () => {
    const constants = readSource(CONSTANTS_PATH);
    expect(constants).not.toContain('"use server"');
    expect(constants).toContain('export const WAIVER_PDF_BUCKET = "waiver-documents";');
    expect(constants).toContain("export const WAIVER_PDF_MAX_BYTES = 10 * 1024 * 1024;");
  });

  it("no PDF parser/rendering dependency was added — opaque-blob treatment only", () => {
    expect(pdfActions).not.toMatch(/pdf-lib|pdfjs|pdf-parse|OCR/i);
  });
});
