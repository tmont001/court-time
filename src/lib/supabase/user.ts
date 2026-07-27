import { cache } from "react";
import { createClient } from "./server";

// Per-request memoized auth user.
// React.cache() resets on every RSC request — never shared across users or requests.
// Layouts and pages rendered in the same request share this result, so Supabase
// Auth is only validated once per request regardless of how many RSC segments call it.
export const getAuthUser = cache(async () => {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
});

// Per-request memoized account context.
//
// Phase 26C1: sourced from get_current_account_context(), not a direct
// profiles select. Global identity (id, first_name, last_name, phone,
// created_at, updated_at) always comes from the profile row. club_id,
// role, status, and is_lesson_provider now come from the caller's ACTIVE
// club_memberships row (the same Phase 26B2 primitive current_user_club_id()/
// current_user_role() are built on) — never from profiles.club_id/role/
// status/is_lesson_provider directly, which remain only a legacy
// compatibility projection (migration 0081) that unconverted Phase
// 26C2-26C4 code may still depend on elsewhere, but this file no longer
// reads.
//
// Field names are preserved from the pre-26C1 shape (club_id, role, status,
// is_lesson_provider) specifically so the many existing call sites across
// Calendar/Events/Lessons/Bookings/admin pages — none of which are in scope
// for this checkpoint — keep compiling and working unchanged; they are
// still correct because migration 0081's triggers keep profiles.club_id/
// role/status/is_lesson_provider synchronized with the active membership
// for as long as one exists. activeClubId is added as an explicit new
// alias (identical value to club_id) for callers converted in this or a
// later checkpoint that want to be unambiguous about what the field means.
//
// For a no-club user, an inactive/suspended/removed membership, or any
// user with no valid active membership, club_id/role/status/
// is_lesson_provider/clubName/clubSlug/themeKey are all null — global
// identity fields are still returned. This helper itself does not gate
// access: any caller can invoke it and get a well-formed result for such a
// user. In Phase 26C1, though, (app)/layout.tsx still redirects any user
// with no valid active membership to /pending-invite (or /join/<code>)
// before any page under (app)/ — including /profile — ever renders, so
// that identity data isn't actually reachable through any UI in this
// checkpoint; it exists here so a future route (Phase 26E) can use it
// without changing this file again. The database's own-profile SELECT/
// UPDATE protections for such a user (migration 0082's
// profiles_select_same_club/profiles_update_own_row corrections) are
// already in place independent of this application-layer gate.
export const getAuthProfile = cache(async () => {
  const user = await getAuthUser();
  if (!user) return null;
  const supabase = await createClient();
  const { data } = await supabase.rpc("get_current_account_context").single();
  if (!data) return null;

  return {
    id: data.id,
    first_name: data.first_name,
    last_name: data.last_name,
    phone: data.phone,
    created_at: data.created_at,
    updated_at: data.updated_at,
    club_id: data.active_club_id,
    activeClubId: data.active_club_id,
    role: data.role,
    status: data.status,
    is_lesson_provider: data.is_lesson_provider,
    clubName: data.club_name,
    clubSlug: data.club_slug,
    themeKey: data.theme_key,
  };
});

export interface ClubMembershipOption {
  clubId:           string;
  clubName:         string;
  role:             string;
  isLessonProvider: boolean;
  isActiveClub:     boolean;
}

// Per-request memoized list of the caller's own switchable memberships.
//
// Phase 26E1: sourced from get_my_club_memberships() (migration 0085) —
// never a direct club_memberships select, which remains inaccessible to
// authenticated browser code (RLS enabled, zero policies, all privileges
// revoked, unchanged since migration 0081). Only status = 'active' and
// removed_at is null memberships are ever returned; the caller's identity
// is derived entirely server-side from auth.uid(), never from any
// client-supplied id. Ordered by the RPC itself: active club first, then
// club name — no client-side sort needed.
//
// Returns an empty array for a signed-out user or a user with zero active
// memberships (both valid, non-error states for this list — an empty
// switcher is simply not rendered).
export const getMyClubMemberships = cache(async (): Promise<ClubMembershipOption[]> => {
  const user = await getAuthUser();
  if (!user) return [];
  const supabase = await createClient();
  const { data } = await supabase.rpc("get_my_club_memberships");
  if (!data) return [];

  return data.map((m) => ({
    clubId: m.club_id,
    clubName: m.club_name,
    role: m.role,
    isLessonProvider: m.is_lesson_provider,
    isActiveClub: m.is_active_club,
  }));
});
