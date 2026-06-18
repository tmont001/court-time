import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import BottomNav from "@/components/BottomNav";
import SideNav from "@/components/SideNav";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");

  let themeKey = "classic-gray";
  const { data: profile } = await supabase
    .from("profiles")
    .select("club_id")
    .eq("id", user.id)
    .single();

  if (!profile?.club_id) redirect("/pending-invite");

  if (profile?.club_id) {
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
          {children}
        </main>
      </div>
      {/* Bottom nav: visible on mobile, hidden on desktop where SideNav takes over */}
      <BottomNav />
    </div>
  );
}
