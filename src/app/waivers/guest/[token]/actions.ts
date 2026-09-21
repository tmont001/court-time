"use server";

// Phase 43B-4B — public, unauthenticated Guest waiver Server Actions.
// Possession of the raw bearer token IS the Guest's entire authority here
// — no auth.uid(), no account, no client-supplied reservation_guest_id/
// event_guest_id ever reaches either action below. Both actions re-hash
// the raw token server-side and call a service_role-only RPC (0198) via
// createPrivilegedClient() — the same privileged-client posture already
// established by the calendar feed route and the Member waiver PDF
// actions. Neither the raw token nor its hash is ever logged, returned in
// an error message, or written anywhere beyond the one RPC parameter that
// needs it.

import { createPrivilegedClient } from "@/lib/supabase/privileged";
import {
  isSyntacticallyValidGuestWaiverToken,
  hashGuestWaiverToken,
} from "@/lib/waivers/guestWaiverTokenServer";
import { resolveWaiverPdfViewUrl } from "@/lib/waivers/pdfViewUrl";
import { resolveGuestWaiverInvitation } from "./resolveGuestWaiver";

const UNAVAILABLE_ERROR = "This waiver link is no longer available.";
const GENERIC_ERROR = "Something went wrong. Please try again.";

// Phase 43B-3D's Member equivalent (getMemberWaiverPdfViewUrlAction)
// re-derives its own current_version_id from the caller's own identity
// rather than trusting a client-supplied one; this does the same via the
// token — resolveGuestWaiverInvitation re-validates the token (and its
// parent participation) fresh on every call, so a since-revoked/rotated
// token, or a since-removed Guest slot, can never open a PDF that was
// valid only at page-render time.
export async function getGuestWaiverPdfViewUrlAction(
  rawToken: string
): Promise<{ error?: string; url?: string; originalFilename?: string }> {
  if (!isSyntacticallyValidGuestWaiverToken(rawToken)) return { error: UNAVAILABLE_ERROR };

  const resolved = await resolveGuestWaiverInvitation(rawToken);
  if (!resolved || !resolved.currentVersionId) return { error: UNAVAILABLE_ERROR };

  const result = await resolveWaiverPdfViewUrl(resolved.currentVersionId);
  if (result.error || !result.url) {
    return { error: "Could not open the waiver PDF. Please try again." };
  }
  return { url: result.url, originalFilename: result.originalFilename };
}

// Thin wrapper around accept_guest_waiver(hash, version_id) — 0198 itself
// is the sole authority for every invariant (active invitation, active
// Guest slot, live parent participation, current Guest waiver, required=
// true, exact-version match). Nothing here duplicates those checks; this
// only maps the RPC's own error codes to Guest-safe copy that never
// discloses which internal condition failed.
export async function acceptGuestWaiverAction(
  rawToken: string,
  waiverVersionId: string
): Promise<{ error?: string; stale?: boolean; acceptedAt?: string }> {
  if (!isSyntacticallyValidGuestWaiverToken(rawToken)) return { error: UNAVAILABLE_ERROR };
  if (!waiverVersionId) return { error: GENERIC_ERROR };

  const privileged = createPrivilegedClient();
  if (!privileged) return { error: GENERIC_ERROR };

  const tokenHash = hashGuestWaiverToken(rawToken);
  const { data, error } = await privileged.rpc("accept_guest_waiver", {
    p_token_hash: tokenHash,
    p_waiver_version_id: waiverVersionId,
  });

  if (error) {
    const key =
      error.message.match(
        /invalid_token|guest_slot_invalid|no_current_guest_waiver|guest_waiver_not_required|stale_waiver_version|waiver_version_id_required/
      )?.[0] ?? "";

    // A newer version was published (or the waiver's requirement/current
    // version otherwise changed) between this page's render and this
    // click — fail closed, never accept the stale version, and tell the
    // Guest to review again rather than showing a dead-end error.
    if (key === "stale_waiver_version" || key === "no_current_guest_waiver" || key === "guest_waiver_not_required") {
      return {
        error: "This waiver has changed since you opened this page. Please review it again.",
        stale: true,
      };
    }
    if (key === "invalid_token" || key === "guest_slot_invalid") {
      return { error: UNAVAILABLE_ERROR };
    }
    return { error: GENERIC_ERROR };
  }

  return { acceptedAt: data ?? undefined };
}
