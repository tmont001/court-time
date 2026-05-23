import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Header from "@/components/Header";
import CalendarShell from "./CalendarShell";

export default async function CalendarPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/sign-in");

  const { data: profile } = await supabase
    .from("profiles")
    .select("club_id, role")
    .eq("id", user.id)
    .single();

  const clubId   = profile?.club_id ?? "";
  const userRole = profile?.role    ?? "member";

  let clubTimezone = "America/New_York";
  if (clubId) {
    const { data: club } = await supabase
      .from("clubs")
      .select("timezone")
      .eq("id", clubId)
      .single();
    if (club?.timezone) clubTimezone = club.timezone;
  }

  // Compute today in the club's timezone on the server so CalendarShell gets a
  // stable YYYY-MM-DD string for both SSR and client hydration.
  const todayISO = new Date().toLocaleDateString("en-CA", { timeZone: clubTimezone });

  const [{ data: courts, error: courtsError }, { data: operatingHours }] =
    await Promise.all([
      supabase
        .from("courts")
        .select("id, name, display_order")
        .eq("is_active", true)
        .order("display_order", { ascending: true }),
      clubId
        ? supabase
            .from("operating_hours")
            .select("day_of_week, opens_at, closes_at, is_closed")
            .eq("club_id", clubId)
            .order("day_of_week")
        : Promise.resolve({ data: [] }),
    ]);

  if (courtsError) {
    console.error("[Calendar] courts query failed:", courtsError.message);
  }

  return (
    <>
      <Header screenTitle="Calendar" />
      <CalendarShell
        courts={courts ?? []}
        hasError={!!courtsError}
        userId={user.id}
        clubId={clubId}
        clubTimezone={clubTimezone}
        userRole={userRole}
        todayISO={todayISO}
        operatingHours={operatingHours ?? []}
      />
    </>
  );
}
