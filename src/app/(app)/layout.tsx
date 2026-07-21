import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import BottomNav from "@/components/BottomNav";
import SideNav from "@/components/SideNav";
import MemberWelcomeCard from "@/components/MemberWelcomeCard";

const INVITE_CODE_RE = /^[0-9a-f]{32}$/;

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  let themeKey = "graphite";
  const profile = await getAuthProfile();

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

  if (profile?.club_id) {
    const supabase = await createClient();
    const { data: club } = await supabase
      .from("clubs")
      .select("theme_key")
      .eq("id", profile.club_id)
      .single();
    if (club?.theme_key) themeKey = club.theme_key;
  }

  return (
    <div className={`theme-${themeKey} min-h-screen`}>
      {/* Sidebar: fixed on desktop (md+), hidden on mobile */}
      <SideNav />
      {/* Content area: offset right of sidebar on desktop */}
      <div className="flex flex-col min-h-screen md:pl-56">
        <main className="flex-1 app-main-content">
          {profile?.role === "member" && profile.club_id && (
            <MemberWelcomeCard userId={user.id} clubId={profile.club_id} />
          )}
          {children}
        </main>
      </div>
      {/* Bottom nav: visible on mobile, hidden on desktop where SideNav takes over */}
      <BottomNav />
    </div>
  );
}
