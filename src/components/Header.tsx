import Image from "next/image";
import { createClient } from "@/lib/supabase/server";
import { getMyClubMemberships } from "@/lib/supabase/user";
import NotificationBell from "@/components/NotificationBell";
import ThemeToggle from "@/components/ThemeToggle";
import AccountMenu from "@/components/AccountMenu";
import HeaderClubSwitcherButton from "@/components/HeaderClubSwitcherButton";

interface HeaderProps {
  screenTitle: string;
}

export default async function Header({ screenTitle }: HeaderProps) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  let clubName = "Court Time";
  let logoUrl: string | null = null;

  let userInitials = "";
  let userName     = "";
  const userEmail  = user?.email ?? "";

  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("club_id, first_name, last_name")
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
    const first = profile?.first_name?.trim() ?? "";
    const last  = profile?.last_name?.trim()  ?? "";
    userName     = [first, last].filter(Boolean).join(" ");
    userInitials = first && last
      ? (first[0] + last[0]).toUpperCase()
      : first
        ? first[0].toUpperCase()
        : userEmail
          ? userEmail[0].toUpperCase()
          : "?";
  }

  const initial = clubName.charAt(0).toUpperCase();

  const clubIcon = logoUrl ? (
    <Image
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
  );

  // Phase 26E1 mobile UX: the top-left club icon becomes a second entry
  // point to the same "Switch Club" sheet already reachable via BottomNav's
  // More menu — mobile only, and only for 2+ active memberships. Sourced
  // from the same getMyClubMemberships() the authenticated layout already
  // calls for SideNav/BottomNav this request — React.cache() means this is
  // not a second network/RPC round trip when the layout already fetched it.
  // Desktop is untouched: it always renders the exact same static icon,
  // whether or not the user can switch (the SideNav dropdown is the
  // desktop entry point).
  const memberships = user ? await getMyClubMemberships() : [];
  const canSwitchOnMobile = memberships.length > 1;

  return (
    <header className="sticky top-0 z-30 flex items-center justify-between px-4 h-14 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 motion-safe:transition-colors motion-safe:duration-150">
      {canSwitchOnMobile ? (
        <>
          <div className="hidden md:block">{clubIcon}</div>
          <div className="md:hidden">
            <HeaderClubSwitcherButton clubName={clubName} icon={clubIcon} memberships={memberships} />
          </div>
        </>
      ) : (
        clubIcon
      )}
      <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{screenTitle}</span>
      <div className="flex items-center gap-0.5">
        <ThemeToggle />
        <NotificationBell />
        <AccountMenu
          userInitials={userInitials}
          userName={userName}
          userEmail={userEmail}
        />
      </div>
    </header>
  );
}
