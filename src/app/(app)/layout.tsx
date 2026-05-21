import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import BottomNav from "@/components/BottomNav";

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
    <div className={`flex flex-col min-h-screen theme-${themeKey}`}>
      <main className="flex-1 pb-16">{children}</main>
      <BottomNav />
    </div>
  );
}
