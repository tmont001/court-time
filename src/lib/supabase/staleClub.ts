import { getAuthProfile } from "./user";
import { STALE_CLUB_CONTEXT_ERROR } from "@/lib/staleClub";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Phase 26F1: a PREFLIGHT check, run before the guarded RPC/table write —
// not a transactionally atomic guard. This is NOT an authorization check —
// the RPC/table write it guards still derives and enforces the target club
// itself (current_user_club_id()/current_user_role(), or the RPC's own
// profiles.club_id lookup), completely unchanged. Database authorization
// remains authoritative; this call only distinguishes "the page's club is
// stale" (a friendly, recoverable error) from "the account isn't allowed to
// do this" (the existing RLS/RPC error) — so a user who left a tab open
// across a club switch, or fires a mutation in the gap before Phase 26E2's
// StaleActiveClubGuard next re-checks, gets a clear error instead of
// silently writing against whichever club the server happens to still
// consider active.
//
// getAuthProfile() is safe to call fresh here: it's React.cache()-memoized
// per REQUEST, and a Server Action invocation is its own request — it never
// reuses a cached value from the page render that originally produced
// expectedClubId.
//
// Known remaining gap (TOCTOU): this check and the subsequent RPC/table
// write are two separate statements, not one transaction. The account's
// active club could still change in the narrow window between this check
// returning ok and the write actually executing (e.g. a concurrent club
// switch on another device landing mid-request). Closing that gap
// completely would require passing expected_club_id into the RPC itself and
// re-validating it inside the same transaction as the write — deferred as a
// later hardening pass, RPC by RPC, rather than done here. This preflight
// check still meaningfully narrows the window (from "any time the tab is
// left open" to "the few hundred milliseconds of one request") and is
// intentionally scoped as a fail-fast UX improvement, not a
// concurrency-proof guarantee.
export async function assertActiveClub(
  expectedClubId: string
): Promise<{ ok: true } | { ok: false; error: typeof STALE_CLUB_CONTEXT_ERROR }> {
  if (typeof expectedClubId !== "string" || !UUID_RE.test(expectedClubId)) {
    return { ok: false, error: STALE_CLUB_CONTEXT_ERROR };
  }

  const profile = await getAuthProfile();
  if (!profile || profile.activeClubId !== expectedClubId) {
    return { ok: false, error: STALE_CLUB_CONTEXT_ERROR };
  }

  return { ok: true };
}
