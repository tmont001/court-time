import "server-only";

// Phase 43B-4B — the single, shared server-side resolution path for a raw
// Guest waiver bearer token: validate syntax, hash via the production
// server-only token wrapper, then call the service_role-only
// resolve_guest_waiver_invitation RPC (0198) via the privileged client.
// The raw token is NEVER sent to Postgres — only its hash, computed here
// — and neither the raw token nor its hash is ever logged. Used by both
// page.tsx (initial render) and actions.ts (re-resolution before opening
// the PDF) so the exact same resolution logic runs every time, never
// duplicated.
//
// Mirrors src/app/api/calendar/feed/[token]/route.ts's own resolution
// shape exactly (isSyntacticallyValid -> hash -> createPrivilegedClient()
// -> one narrow RPC call, fail closed to null on any problem, never a
// distinguishing error) — the same bearer-token pattern, applied to a
// page render instead of a route response.

import { createPrivilegedClient } from "@/lib/supabase/privileged";
import {
  isSyntacticallyValidGuestWaiverToken,
  hashGuestWaiverToken,
} from "@/lib/waivers/guestWaiverTokenServer";

export interface ResolvedGuestWaiverInvitation {
  invitationId: string;
  clubId: string;
  clubName: string | null;
  reservationGuestId: string | null;
  eventGuestId: string | null;
  guestDisplayName: string | null;
  waiverId: string | null;
  currentVersionId: string | null;
  versionTitle: string | null;
  isRequired: boolean;
  isCurrentAccepted: boolean;
  acceptedAt: string | null;
  // Legacy-text-Guest-waiver audit (pre-apply correction): the PDF-only
  // pivot (43B-3B) did NOT retroactively invalidate a Guest waiver
  // version published BEFORE it — GuestWaiverSection.tsx (admin UI)
  // still renders a `!currentDocument.isPdfBacked` branch for exactly
  // this case, proving a current Guest waiver CAN still be legacy text-
  // backed today. 0198's own resolve_guest_waiver_invitation does not
  // return waiver_versions.body (out of its original scope), so this
  // reads it directly via the SAME already-established privileged-client
  // read pattern src/lib/waivers/pdfViewUrl.ts already uses for the
  // sibling waiver_document_files table — no new RPC, no 0198 change, no
  // migration. Same heuristic /waivers/member/page.tsx already uses: a
  // PDF-backed version always has body = NULL (publish_waiver_pdf_
  // version, 0196, always inserts body = null); a legacy text version
  // has a populated body.
  isPdfBacked: boolean;
  versionBody: string | null;
}

// Returns null for EVERY failure mode alike (malformed token, unknown/
// revoked token, removed/cancelled Guest slot, invalid parent
// participation, or an unavailable privileged client) — resolve_guest_
// waiver_invitation itself already collapses all of those into "zero
// rows" (see 0198's own Design Decision 7), and this function preserves
// that same non-distinguishing shape rather than re-introducing a leak
// here.
export async function resolveGuestWaiverInvitation(
  rawToken: string
): Promise<ResolvedGuestWaiverInvitation | null> {
  if (!isSyntacticallyValidGuestWaiverToken(rawToken)) return null;

  const privileged = createPrivilegedClient();
  if (!privileged) {
    console.error("guest waiver resolution blocked: SUPABASE_SECRET_KEY is not configured");
    return null;
  }

  const tokenHash = hashGuestWaiverToken(rawToken);
  const { data } = await privileged.rpc("resolve_guest_waiver_invitation", {
    p_token_hash: tokenHash,
  });

  const row = data?.[0];
  if (!row) return null;

  // Narrow, single-column read scoped to a version_id already proven, by
  // the trusted RPC call above, to be THIS invitation's exact current
  // Guest waiver version — not a broad table surface, the same posture
  // resolveWaiverPdfViewUrl already uses one table over.
  let versionBody: string | null = null;
  let isPdfBacked = false;
  if (row.current_version_id) {
    const { data: versionRow } = await privileged
      .from("waiver_versions")
      .select("body")
      .eq("id", row.current_version_id)
      .maybeSingle();
    versionBody = versionRow?.body ?? null;
    isPdfBacked = versionRow?.body === null;
  }

  return {
    invitationId: row.invitation_id,
    clubId: row.club_id,
    clubName: row.club_name,
    reservationGuestId: row.reservation_guest_id,
    eventGuestId: row.event_guest_id,
    guestDisplayName: row.guest_display_name,
    waiverId: row.waiver_id,
    currentVersionId: row.current_version_id,
    versionTitle: row.version_title,
    isRequired: row.is_required,
    isCurrentAccepted: row.is_current_accepted,
    acceptedAt: row.accepted_at,
    isPdfBacked,
    versionBody: isPdfBacked ? null : versionBody,
  };
}
