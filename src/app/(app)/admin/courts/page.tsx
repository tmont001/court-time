import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import { hasAdminAuthority } from "@/lib/auth/roles";
import Header from "@/components/Header";
import CourtManagementList from "./CourtManagementList";

export default async function AdminCourtsPage() {
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  const profile  = await getAuthProfile();
  if (!hasAdminAuthority(profile?.role)) redirect("/calendar");

  const supabase = await createClient();
  const clubId = profile?.club_id ?? "";
  const [{ data: courts, error }, { data: settings }] = await Promise.all([
    supabase
      .from("courts")
      .select("id, name, display_order, is_active, hourly_rate_cents")
      .eq("club_id", clubId)
      .order("display_order", { ascending: true }),
    supabase
      .from("club_settings")
      .select("currency, default_court_hourly_rate_cents")
      .eq("club_id", clubId)
      .single(),
  ]);

  if (error) {
    console.error("[AdminCourts] courts query failed:", error.message);
  }

  return (
    <>
      <Header screenTitle="Courts" />
      <div className="px-4 pt-3 pb-0 md:max-w-2xl md:mx-auto">
        <Link href="/profile" className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-accent motion-safe:transition-colors motion-safe:duration-150">
          ← Back to Account
        </Link>
      </div>
      <div className="px-4 py-6 space-y-4 md:max-w-2xl md:mx-auto dark:text-gray-100">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Court management</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Active courts appear as columns on the calendar. Inactive courts are hidden from
            bookings but their reservation history is preserved.
          </p>
        </div>
        <hr className="border-gray-100 dark:border-gray-800" />
        <CourtManagementList
          initialCourts={courts ?? []}
          clubId={clubId}
          currency={settings?.currency ?? "USD"}
          defaultHourlyRateCents={settings?.default_court_hourly_rate_cents ?? null}
        />
      </div>
    </>
  );
}
