import { createClient } from "@/lib/supabase/server";
import NotificationBell from "@/components/NotificationBell";

interface HeaderProps {
  screenTitle: string;
}

export default async function Header({ screenTitle }: HeaderProps) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  let clubName = "Court Time";
  let logoUrl: string | null = null;

  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("club_id")
      .eq("id", user.id)
      .single();
    if (profile?.club_id) {
      const { data: club } = await supabase
        .from("clubs")
        .select("name, logo_url")
        .eq("id", profile.club_id)
        .single();
      if (club?.name?.trim()) clubName = club.name.trim();
      if (club?.logo_url)     logoUrl  = club.logo_url;
    }
  }

  const initial = clubName.charAt(0).toUpperCase();

  return (
    <header className="flex items-center justify-between px-4 h-14 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl}
          width={32}
          height={32}
          alt={clubName}
          className="rounded object-contain flex-shrink-0"
        />
      ) : (
        <div className="w-8 h-8 rounded bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-xs font-semibold text-gray-600 dark:text-gray-400 flex-shrink-0">
          {initial}
        </div>
      )}
      <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{screenTitle}</span>
      <NotificationBell />
    </header>
  );
}
