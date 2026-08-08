import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getAuthUser, getAuthProfile, getMyClubMemberships } from "@/lib/supabase/user";
import BottomNav from "@/components/BottomNav";
import SideNav from "@/components/SideNav";
import MemberWelcomeCard from "@/components/MemberWelcomeCard";
import StaleActiveClubGuard from "@/components/StaleActiveClubGuard";

const INVITE_CODE_RE = /^[0-9a-f]{32}$/;

export const dynamic = "force-dynamic";

// The authenticated app is never a public marketing surface — every route
// under this group requires a session and is club-specific, so none of it
// belongs in search results.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  const profile = await getAuthProfile();

  // Phase 26C1: club_id is now the caller's ACTIVE membership's club
  // (activeClubId), derived from club_memberships — not the legacy
  // profiles.club_id read directly. A user with no valid active membership
  // (never joined, or their sole membership is inactive/suspended/removed)
  // is routed to the same pending-invite flow as before; distinguishing
  // those cases for a returning multi-club user is Phase 26E's job.
  if (!profile?.club_id) {
    // If the user visited /join/<code> recently, the middleware set a cookie.
    // Redirect them to that invite page so they can accept without re-entering code.
    const cookieStore = await cookies();
    const pendingCode = cookieStore.get("ct_invite_pending")?.value ?? "";
    if (INVITE_CODE_RE.test(pendingCode)) {
      redirect(`/join/${pendingCode}`);
    }
    redirect("/pending-invite");
  }

  // Active club's theme/name come directly from get_current_account_context()
  // (via getAuthProfile) — no separate clubs query needed.
  const themeKey = profile.themeKey ?? "graphite";
  const clubName = profile.clubName ?? undefined;

  // Phase 26E1: the caller's own switchable memberships, fetched once here
  // (get_my_club_memberships, migration 0085) and passed to both nav
  // surfaces. A single-membership user gets an empty-switcher render (the
  // existing static club-name display, unchanged); two or more renders the
  // switcher — see SideNav/BottomNav.
  const memberships = await getMyClubMemberships();

  // Phase 26E2: guaranteed non-null past the redirect guard above.
  const activeClubId = profile.club_id;

  return (
    <div className={`theme-${themeKey} min-h-screen`}>
      {/* Sidebar: fixed on desktop (md+), hidden on mobile */}
      <SideNav userRole={profile?.role ?? undefined} clubName={clubName} memberships={memberships} />
      {/* Content area: offset right of sidebar on desktop */}
      <div className="flex flex-col min-h-screen md:pl-60">
        <main className="flex-1 app-main-content">
          {profile?.role === "member" && profile.club_id && (
            <MemberWelcomeCard userId={user.id} clubId={profile.club_id} />
          )}
          {children}
        </main>
      </div>
      {/* Bottom nav: visible on mobile, hidden on desktop where SideNav takes over */}
      <BottomNav userRole={profile?.role ?? undefined} clubName={clubName} memberships={memberships} />
      {/* Phase 26E2: mounted once for the whole authenticated app shell
          (covers every (app)/* route, including nested /admin/* pages).
          Detects this tab's active-club context going stale — another tab
          switched, or the membership itself was deactivated/suspended/
          removed — and blocks interaction until reloaded. */}
      <StaleActiveClubGuard activeClubId={activeClubId} />
    </div>
  );
}
