import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import BottomNav from "@/components/BottomNav";
import SideNav from "@/components/SideNav";
import MemberWelcomeCard from "@/components/MemberWelcomeCard";

const INVITE_CODE_RE = /^[0-9a-f]{32}$/;

export const dynamic = "force-dynamic";

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

  return (
    <div className={`theme-${themeKey} min-h-screen`}>
      {/* Sidebar: fixed on desktop (md+), hidden on mobile */}
      <SideNav userRole={profile?.role ?? undefined} clubName={clubName} />
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
      <BottomNav userRole={profile?.role ?? undefined} clubName={clubName} />
    </div>
  );
}
