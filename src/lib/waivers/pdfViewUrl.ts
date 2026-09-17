import "server-only";

// Phase 43B-3B — shared, non-presentational helper: given a
// waiver_version_id already authorized by the CALLER (Admin Settings'
// own audience-scoped waivers read, or the Member acceptance page's own
// get_my_member_waiver_status() call), resolve a short-lived signed
// download URL for its PDF document, if one exists.
//
// Deliberately a plain server-only helper, not a "use server" Server
// Action, and deliberately shared (unlike MemberWaiverSection/
// GuestWaiverSection's own established full-duplication precedent): this
// is pure plumbing with no presentation, no copy, and no audience-specific
// authorization logic of its own — every caller has already independently
// proven the caller may see this exact version_id BEFORE calling this
// helper (Admin Settings via the admin-RLS-scoped waivers table; the
// Member acceptance page via get_my_member_waiver_status(), which is
// already self/club-scoped). Duplicating this one Storage-signing call
// would only risk the two copies drifting on the security-relevant bits
// (bucket name, expiry, "PDF-backed vs legacy text" detection) — sharing
// it removes that risk without coupling either caller's UI/copy together.

import { createPrivilegedClient } from "@/lib/supabase/privileged";
import { WAIVER_PDF_BUCKET } from "@/lib/waivers/constants";

const SIGNED_VIEW_URL_EXPIRES_SECONDS = 300; // ~5 minutes — never a permanent Storage URL.

export async function resolveWaiverPdfViewUrl(
  waiverVersionId: string
): Promise<{ error?: string; url?: string; originalFilename?: string }> {
  const privileged = createPrivilegedClient();
  if (!privileged) return { error: "privileged_client_unavailable" };

  const { data: documentRow } = await privileged
    .from("waiver_document_files")
    .select("storage_path, original_filename")
    .eq("waiver_version_id", waiverVersionId)
    .maybeSingle();

  // No row: this version is legacy text-backed, not PDF-backed. Callers
  // must check this before offering a "View PDF" action.
  if (!documentRow) return { error: "not_pdf_backed" };

  const { data, error } = await privileged.storage
    .from(WAIVER_PDF_BUCKET)
    .createSignedUrl(documentRow.storage_path, SIGNED_VIEW_URL_EXPIRES_SECONDS);

  if (error || !data) return { error: "signed_url_failed" };

  return { url: data.signedUrl, originalFilename: documentRow.original_filename };
}
