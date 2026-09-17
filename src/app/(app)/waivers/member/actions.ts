"use server";

// Phase 43A-2 — role-agnostic, self-only acceptance (locked decisions 5
// and 6). Thin wrapper around accept_member_waiver(uuid) — no business
// rule is reproduced here: the RPC itself resolves the caller's own
// claimed roster identity, rejects a stale (non-current) version, and is
// idempotent. This is the ONLY acceptance action in the app; there is no
// Admin-proxy variant anywhere.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { resolveWaiverPdfViewUrl } from "@/lib/waivers/pdfViewUrl";

const ERROR_MESSAGES: Record<string, string> = {
  not_authenticated:         "You must be signed in.",
  no_roster_identity:        "We couldn't find your membership record for this club.",
  no_current_waiver_version: "There is no current waiver to accept.",
  stale_waiver_version:      "A newer version of this waiver has been published. Refresh to review it.",
};

export async function acceptMemberWaiverAction(
  waiverVersionId: string
): Promise<{ error?: string; stale?: boolean; acceptedAt?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { data, error } = await supabase.rpc("accept_member_waiver", {
    p_waiver_version_id: waiverVersionId,
  });
  if (error) {
    const key = error.message.match(/no_roster_identity|no_current_waiver_version|stale_waiver_version|not_authenticated/)?.[0] ?? "";
    return {
      error: ERROR_MESSAGES[key] ?? "Failed to record your acceptance. Please try again.",
      stale: key === "stale_waiver_version",
    };
  }

  revalidatePath("/waivers/member");
  revalidatePath("/profile");
  return { acceptedAt: data ?? undefined };
}

// Phase 43B-3B — self-only, PDF-backed current Member waiver viewing. No
// parameters: re-derives the caller's own current version_id server-side
// via get_my_member_waiver_status() (already self/club-scoped, role-
// agnostic) — this can never be used to request the Guest document or a
// version from another club. Short-lived signed URL only, never a
// permanent Storage URL. Returns not_pdf_backed (silently, via the shared
// helper) when the current version is legacy text — callers must check
// isPdfBacked (derivable from body === null) before offering this action.
export async function getMemberWaiverPdfViewUrlAction(): Promise<{
  error?: string;
  url?: string;
  originalFilename?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { data: rows } = await supabase.rpc("get_my_member_waiver_status");
  const currentVersionId = rows?.[0]?.current_version_id ?? null;
  if (!currentVersionId) return { error: "There is no current waiver to view." };

  const result = await resolveWaiverPdfViewUrl(currentVersionId);
  if (result.error || !result.url) {
    return { error: "Could not open the PDF. Please try again." };
  }
  return { url: result.url, originalFilename: result.originalFilename };
}
