import { createClient } from "@/lib/supabase/server";
import NotificationBell from "@/components/NotificationBell";

interface HeaderProps {
  screenTitle: string;
}

export default async function Header({ screenTitle }: HeaderProps) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  let clubName = "Court Time";
  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("club_id")
      .eq("id", user.id)
      .single();
    if (profile?.club_id) {
      const { data: club } = await supabase
        .from("clubs")
        .select("name")
        .eq("id", profile.club_id)
        .single();
      if (club?.name?.trim()) clubName = club.name.trim();
    }
  }

  return (
    <header className="flex items-center justify-between px-4 h-14 border-b border-gray-200 bg-white">
      <span className="text-xs text-gray-500 font-medium uppercase tracking-wide">
        {clubName}
      </span>
      <span className="text-sm font-semibold text-gray-900">{screenTitle}</span>
      <NotificationBell />
    </header>
  );
}
