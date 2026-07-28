// Phase 26F1: shared stale-club-context contract. Client-safe (no server
// imports) so both Server Actions (via src/lib/supabase/staleClub.ts) and
// the client components that display their errors can import from here
// without pulling server-only code into a client bundle.
export const STALE_CLUB_CONTEXT_ERROR = "stale_club_context";

export const STALE_CLUB_MESSAGE =
  "Your active club changed. Reload this page and try again.";
