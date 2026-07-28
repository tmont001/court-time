"use client";

import { createClient } from "@/lib/supabase/client";

export default function SignOutButton() {
  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    // Hard navigation, not router.push: an identity change must be a hard
    // application boundary. A soft navigation can leave the (app) layout
    // shell (Header/SideNav/BottomNav — all rendered from the signed-out
    // user's session) served from Next's client router cache on the next
    // sign-in, showing the previous account's club/role until a manual
    // refresh. window.location.replace also drops this page from history,
    // so Back can't land on a stale authenticated page.
    window.location.replace("/sign-in");
  }

  return (
    <button
      onClick={handleSignOut}
      className="mt-4 w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-gray-800 dark:hover:text-gray-100 active:scale-[0.98] motion-safe:transition-all motion-safe:duration-150"
    >
      Sign out
    </button>
  );
}
