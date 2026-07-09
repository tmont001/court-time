import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import Header from "@/components/Header";
import AdminEventsClient from "./AdminEventsClient";
import type { AdminEventRow } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminEventsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");

  const { data: profile } = await supabase
    .from("profiles")
    .select("club_id, role")
    .eq("id", user.id)
    .single();

  if (!profile?.club_id || (profile.role !== "admin" && profile.role !== "pro")) {
    redirect("/calendar");
  }

  let clubTimezone = "America/New_York";
  const [clubResult, courtsResult] = await Promise.all([
    supabase.from("clubs").select("timezone").eq("id", profile.club_id).single(),
    supabase.from("courts").select("id, name, display_order").eq("club_id", profile.club_id).eq("is_active", true).order("display_order"),
  ]);
  if (clubResult.data?.timezone) clubTimezone = clubResult.data.timezone;
  const courts = courtsResult.data ?? [];

  const { data: rawEvents } = await supabase
    .from("events")
    .select(`
      id, title, starts_at, ends_at, capacity, status,
      event_types(key, label, color),
      event_participants(profile_id, role, status),
      event_guests(id)
    `)
    .eq("club_id", profile.club_id)
    .order("starts_at", { ascending: false })
    .range(0, 24);

  const initialEvents = (rawEvents ?? []) as AdminEventRow[];

  return (
    <>
      <Header screenTitle="Events" />
      <div
        className="overflow-y-auto"
        style={{ height: "var(--page-fill-height)" }}
      >
        <div className="md:max-w-3xl md:mx-auto">
          <div className="px-4 pt-3 pb-0">
            <Link href="/profile" className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-accent motion-safe:transition-colors motion-safe:duration-150">
              ← Back to Account
            </Link>
          </div>
          <div className="px-4 pt-5 pb-1">
            <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">All Events</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              Manage rosters across all scheduled and past events.
            </p>
          </div>
          <AdminEventsClient
            initialEvents={initialEvents}
            hasMore={initialEvents.length === 25}
            clubTimezone={clubTimezone}
            userRole={profile.role}
            courts={courts}
            clubId={profile.club_id}
          />
        </div>
      </div>
    </>
  );
}
