"use server";

// Phase 43B-3B — PDF waiver upload/finalize/view Server Actions.
//
// Direct browser -> Supabase Storage upload (never PDF bytes through a
// Server Action): this file only ever (1) authorizes an upload by minting
// a short-lived signed upload URL for a server-computed path, and (2)
// finalizes an already-uploaded object by downloading it back server-side
// (via the privileged client, since waiver-documents is a private bucket
// with no authenticated-reachable Storage policy) and independently
// verifying its actual bytes before calling the service-role-only
// publish_waiver_pdf_version RPC (0196, applied/immutable). Nothing here
// ever trusts a client-supplied club_id, storage_path, file size, MIME,
// or SHA-256 — every one of those is re-derived or re-measured server-side.
//
// version_id is generated HERE (authorize), never by the browser. The
// object path is deterministic — {club_id}/{audience}/{version_id}.pdf —
// so a client can only ever finalize an object that (a) actually exists
// in the private bucket at that exact path, which (b) can only exist if
// THIS Admin's own prior authorize call minted a signed upload token for
// it (the bucket has zero authenticated/anon Storage policies — see
// 0196's migration header and this checkpoint's audit). No separate
// "pending upload" ledger is needed: the object's mere existence at the
// expected path is the proof of a legitimate authorize+upload.

import { randomUUID, createHash } from "crypto";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import { createPrivilegedClient } from "@/lib/supabase/privileged";
import { resolveWaiverPdfViewUrl } from "@/lib/waivers/pdfViewUrl";
import { WAIVER_PDF_BUCKET, WAIVER_PDF_MAX_BYTES } from "@/lib/waivers/constants";

const TITLE_MAX = 300;

type Audience = "member" | "guest";

const ERROR_MESSAGES: Record<string, string> = {
  not_authenticated:          "You must be signed in.",
  insufficient_role:          "Admin access required.",
  invalid_audience:           "Invalid waiver audience.",
  filename_required:          "Please choose a PDF file.",
  invalid_file_size:          "The PDF must be 10 MB or smaller.",
  upload_authorization_failed:"Could not authorize the upload. Please try again.",
  uploaded_object_missing:    "The upload did not complete. Please try again.",
  invalid_pdf_header:         "That file doesn't look like a valid PDF.",
  draft_already_exists:       "A draft of the old text waiver must be discarded before uploading a PDF.",
  version_id_already_exists:  "That upload has already been finalized.",
  version_not_found:          "That draft could not be found.",
  version_not_draft:          "That version is already published and can't be discarded.",
  actor_required:             "You must be signed in.",
  club_required:              "No active club found.",
  version_id_required:        "Missing upload reference.",
  title_required:             "Missing waiver name.",
  title_too_long:             "Filename is too long.",
  invalid_digest:             "Could not verify the uploaded file.",
  no_current_waiver:          "No current waiver document found.",
};

function friendlyError(code: string, fallback: string): string {
  return ERROR_MESSAGES[code] ?? fallback;
}

function isValidAudience(value: unknown): value is Audience {
  return value === "member" || value === "guest";
}

function derivePath(clubId: string, audience: Audience, versionId: string): string {
  return `${clubId}/${audience}/${versionId}.pdf`;
}

// Internal label only (never shown to Members/Guests as "authored" text) —
// derived from the uploaded filename, never accepted as free text from the
// browser in this action.
function deriveTitleFromFilename(originalFilename: string): string {
  const trimmed = (originalFilename ?? "").trim();
  const withoutExtension = trimmed.replace(/\.pdf$/i, "").trim();
  const label = withoutExtension || trimmed || "Waiver";
  return label.slice(0, TITLE_MAX);
}

// ── A. Upload authorization ─────────────────────────────────────────────
// Admin-only. Generates a NEW version_id server-side, derives the exact
// immutable object path, and mints a short-lived signed upload URL/token
// for exactly that object (createSignedUploadUrl — 2-hour validity per the
// installed @supabase/supabase-js 2.105.4 Storage client; there is no
// shorter-expiry option in this SDK version, and the object itself is
// useless until finalize independently validates and publishes it, so
// this is an acceptable bound). No Storage RLS policy is added — this
// works because the privileged (service_role) client bypasses Storage RLS
// entirely to MINT the token; the browser's own upload call then needs no
// Storage permission of its own, since the token itself is the bearer
// credential for that one object (see the storage-js "objects: none"
// permission note on uploadToSignedUrl).
export async function authorizeWaiverPdfUploadAction(
  audience: Audience,
  filename: string,
  fileSize: number
): Promise<{
  error?: string;
  versionId?: string;
  path?: string;
  token?: string;
  bucket?: string;
}> {
  const user = await getAuthUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const profile = await getAuthProfile();
  if (profile?.role !== "admin") return { error: ERROR_MESSAGES.insufficient_role };
  const clubId = profile.club_id;
  if (!clubId) return { error: ERROR_MESSAGES.club_required };

  if (!isValidAudience(audience)) return { error: ERROR_MESSAGES.invalid_audience };

  const trimmedFilename = (filename ?? "").trim();
  if (!trimmedFilename) return { error: ERROR_MESSAGES.filename_required };

  // Courtesy pre-check only — the AUTHORITATIVE size check happens at
  // finalize against the actual downloaded bytes, never this claimed value.
  if (!fileSize || fileSize <= 0 || fileSize > WAIVER_PDF_MAX_BYTES) {
    return { error: ERROR_MESSAGES.invalid_file_size };
  }

  const privileged = createPrivilegedClient();
  if (!privileged) return { error: ERROR_MESSAGES.upload_authorization_failed };

  const versionId = randomUUID();
  const path = derivePath(clubId, audience, versionId);

  const { data, error } = await privileged.storage
    .from(WAIVER_PDF_BUCKET)
    .createSignedUploadUrl(path, { upsert: false });

  if (error || !data) {
    return { error: ERROR_MESSAGES.upload_authorization_failed };
  }

  return {
    versionId,
    path: data.path,
    token: data.token,
    bucket: WAIVER_PDF_BUCKET,
  };
}

// ── B. Finalize ──────────────────────────────────────────────────────────
// Admin-only, re-authenticated and re-resolved independently of the
// authorize call above. Re-derives the expected path itself (never trusts
// a client-supplied path), downloads the actual stored object via the
// privileged client, verifies it byte-for-byte, then calls the
// service-role-only publish_waiver_pdf_version RPC (0196). If validation
// or DB finalization fails, cleanup goes through removeUploadIfUnpublished
// (below), which re-checks waiver_document_files immediately before any
// Storage delete — a failed/errored publish response is NOT proof the
// object is unpublished (a retried or concurrent finalize call for the
// SAME version_id may have already published it moments earlier), so
// cleanup must verify, not assume.
export async function finalizeWaiverPdfUploadAction(
  audience: Audience,
  versionId: string,
  originalFilename: string
): Promise<{ error?: string }> {
  const user = await getAuthUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const profile = await getAuthProfile();
  if (profile?.role !== "admin") return { error: ERROR_MESSAGES.insufficient_role };
  const clubId = profile.club_id;
  if (!clubId) return { error: ERROR_MESSAGES.club_required };

  if (!isValidAudience(audience)) return { error: ERROR_MESSAGES.invalid_audience };
  if (!versionId) return { error: ERROR_MESSAGES.version_id_required };

  const privileged = createPrivilegedClient();
  if (!privileged) return { error: ERROR_MESSAGES.upload_authorization_failed };

  // Re-derived from THIS call's own fresh club/audience/versionId — never
  // the path returned by authorizeWaiverPdfUploadAction, and never a
  // client-supplied path.
  const expectedPath = derivePath(clubId, audience, versionId);

  const { data: blob, error: downloadError } = await privileged.storage
    .from(WAIVER_PDF_BUCKET)
    .download(expectedPath);

  if (downloadError || !blob) {
    return { error: ERROR_MESSAGES.uploaded_object_missing };
  }

  const buffer = Buffer.from(await blob.arrayBuffer());

  if (buffer.length === 0 || buffer.length > WAIVER_PDF_MAX_BYTES) {
    await removeUploadIfUnpublished(privileged, versionId, expectedPath);
    return { error: ERROR_MESSAGES.invalid_file_size };
  }

  // Opaque-blob treatment only — no PDF parser, no text extraction, no
  // rendering. The magic header is the one structural fact worth checking.
  const header = buffer.subarray(0, 5).toString("ascii");
  if (header !== "%PDF-") {
    await removeUploadIfUnpublished(privileged, versionId, expectedPath);
    return { error: ERROR_MESSAGES.invalid_pdf_header };
  }

  const sha256Digest = createHash("sha256").update(buffer).digest("hex");
  const title = deriveTitleFromFilename(originalFilename);
  const trimmedFilename = (originalFilename ?? "").trim() || "waiver.pdf";

  const { error: publishError } = await privileged.rpc("publish_waiver_pdf_version", {
    p_actor_user_id: user.id,
    p_club_id: clubId,
    p_audience: audience,
    p_version_id: versionId,
    p_original_filename: trimmedFilename,
    p_title: title,
    p_file_size_bytes: buffer.length,
    p_sha256_digest: sha256Digest,
  });

  if (publishError) {
    // A publish ERROR RESPONSE is not proof the object is unpublished —
    // in particular version_id_already_exists can mean a prior (retried
    // or concurrent) finalize call for this exact version_id already
    // published it moments ago, e.g. if the browser/network never
    // received that earlier call's success response. removeUploadIfUnpublished
    // re-checks waiver_document_files immediately before deleting
    // anything, so already-published evidence is never removed here.
    await removeUploadIfUnpublished(privileged, versionId, expectedPath);

    const key = publishError.message.match(
      /insufficient_role|invalid_audience|invalid_file_size|invalid_digest|version_id_already_exists|draft_already_exists|title_required|title_too_long|filename_required|actor_required|club_required|version_id_required/
    )?.[0] ?? "";
    // version_id_already_exists deliberately returns a friendly error
    // here rather than treating it as success — the simplest safe
    // behavior for this checkpoint (no new idempotency architecture):
    // the evidence and stored PDF are preserved either way (the guard
    // above already ensured that), and the caller can retry the upload
    // as a new version if this one truly never finished on their end.
    return { error: friendlyError(key, "Failed to publish the waiver. Please try again.") };
  }

  revalidatePath("/admin/members/waivers");
  revalidatePath("/waivers/member");
  revalidatePath("/profile");
  return {};
}

// Guarded cleanup — the ONLY path in this file allowed to call
// .storage.from(WAIVER_PDF_BUCKET).remove(...). Deletes expectedPath ONLY
// if no waiver_document_files row exists for versionId. A row's mere
// presence is sufficient proof this object is published evidence (a
// prior, possibly retried/concurrent finalize call already succeeded) and
// blocks deletion outright — the object's own storage_path is also read
// back as an extra sanity check, but is never required to justify a
// block, only ever consulted when a row exists at all.
async function removeUploadIfUnpublished(
  privileged: NonNullable<ReturnType<typeof createPrivilegedClient>>,
  versionId: string,
  expectedPath: string
): Promise<void> {
  const { data: documentRow, error: guardError } = await privileged
    .from("waiver_document_files")
    .select("waiver_version_id, storage_path")
    .eq("waiver_version_id", versionId)
    .maybeSingle();

  // Fail CLOSED for deletion: if the guard query itself errors, we
  // cannot prove the object is unpublished — preserving a possible
  // orphan is safer than risking deletion of possible published
  // evidence. Never overwrites/hides the caller's own already-decided
  // validation/publish error — this function only ever returns void.
  if (guardError) return;

  // A document row exists for this version — it is published evidence
  // (regardless of whether its storage_path happens to equal
  // expectedPath) and must never be deleted here.
  if (documentRow) return;

  try {
    await privileged.storage.from(WAIVER_PDF_BUCKET).remove([expectedPath]);
  } catch {
    // Cleanup failure never hides the primary error above, and never
    // touches any other file — a stray orphan object is an accepted,
    // documented limitation in this checkpoint (no background cleanup
    // system exists yet).
  }
}

// ── C. Explicit legacy draft discard ────────────────────────────────────
// Thin wrapper around discard_waiver_draft (0196). Never called implicitly
// from finalizeWaiverPdfUploadAction — this is a deliberate, separate
// Admin action, only ever exposed in the UI when a draft actually exists.
export async function discardWaiverDraftAction(
  versionId: string
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("discard_waiver_draft", {
    p_version_id: versionId,
  });
  if (error) {
    const key = error.message.match(/version_not_found|version_not_draft|not_authenticated|insufficient_role/)?.[0] ?? "";
    return { error: friendlyError(key, "Failed to discard the draft.") };
  }

  revalidatePath("/admin/members/waivers");
  return {};
}

// ── D. Admin Settings — secure PDF viewing ──────────────────────────────
// Admin can view the Member OR Guest waiver PDF for their OWN club only.
// Never trusts a client-supplied version_id/path — audience is the only
// input, and current_version_id is re-resolved server-side from the
// admin-RLS-scoped waivers table (0192), which itself is already scoped
// to the caller's own club_id by RLS. waiver_document_files has zero
// authenticated table access (0196) — its lookup, and the Storage signed
// URL itself, both go through the privileged client. Short-lived (5
// minutes) — never a permanent Storage URL.
export async function getAdminWaiverPdfViewUrlAction(
  audience: Audience
): Promise<{ error?: string; url?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const profile = await getAuthProfile();
  if (profile?.role !== "admin") return { error: ERROR_MESSAGES.insufficient_role };
  const clubId = profile.club_id;
  if (!clubId) return { error: ERROR_MESSAGES.club_required };

  if (!isValidAudience(audience)) return { error: ERROR_MESSAGES.invalid_audience };

  const { data: waiverRow } = await supabase
    .from("waivers")
    .select("current_version_id")
    .eq("club_id", clubId)
    .eq("audience", audience)
    .maybeSingle();

  const currentVersionId = waiverRow?.current_version_id ?? null;
  if (!currentVersionId) return { error: ERROR_MESSAGES.no_current_waiver };

  const result = await resolveWaiverPdfViewUrl(currentVersionId);
  if (result.error) return { error: ERROR_MESSAGES.no_current_waiver };
  return { url: result.url };
}
