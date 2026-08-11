import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import Header from "@/components/Header";
import CalendarShell from "./CalendarShell";

export default async function CalendarPage({
  searchParams,
}: {
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  const profile  = await getAuthProfile();
  const supabase = await createClient();

  const clubId   = profile?.club_id ?? "";
  const userRole = profile?.role    ?? "member";

  // All five queries only need profile.club_id (or nothing at all) — run in
  // parallel to save sequential round-trips.
  const [
    { data: club },
    { data: courts, error: courtsError },
    { data: operatingHours },
    { data: operatingHoursOverrides },
    { data: userRosterMemberId },
  ] = await Promise.all([
    clubId
      ? supabase.from("clubs").select("timezone").eq("id", clubId).single()
      : Promise.resolve({ data: null }),
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
    // Phase 17C: table is small (O(tens) of rows); CalendarShell filters by
    // exact override_date for the selected date, so no date lower-bound needed.
    clubId
      ? supabase
          .from("operating_hours_override")
          .select("override_date, is_closed, opens_at, closes_at, note")
          .eq("club_id", clubId)
          .order("override_date")
      : Promise.resolve({ data: [] }),
    // Phase 33C3: the caller's own durable Member identity for this club,
    // if claimed — resolved server-side via current_user_roster_member_id()
    // (0110), never derived from owner_user_id alone. Lets CalendarShell
    // recognize a staff-created, pre-claim reservation (owner_user_id null)
    // as the signed-in Member's own booking.
    supabase.rpc("current_user_roster_member_id"),
  ]);

  const clubTimezone = club?.timezone ?? "America/New_York";

  // Compute today in the club's timezone on the server so CalendarShell gets a
  // stable YYYY-MM-DD string for both SSR and client hydration.
  const todayISO = new Date().toLocaleDateString("en-CA", { timeZone: clubTimezone });

  // Optional ?date=YYYY-MM-DD query parameter — jump the calendar to a specific date.
  const sp            = searchParams ? await searchParams : {};
  const dateParam     = typeof sp.date === "string" ? sp.date : null;
  const initialDateISO = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : null;

  if (courtsError) {
    console.error("[Calendar] courts query failed:", courtsError.message);
  }

  return (
    <>
      <Header screenTitle="Calendar" />
      {/* Calendar gets a generous max width; wider than normal content pages.
          On ultra-wide displays this prevents the grid from stretching endlessly. */}
      <div className="max-w-[1440px] mx-auto w-full">
        <CalendarShell
          courts={courts ?? []}
          hasError={!!courtsError}
          userId={user.id}
          userRosterMemberId={userRosterMemberId ?? null}
          clubId={clubId}
          clubTimezone={clubTimezone}
          userRole={userRole}
          todayISO={todayISO}
          initialDateISO={initialDateISO}
          operatingHours={operatingHours ?? []}
          operatingHoursOverrides={operatingHoursOverrides ?? []}
        />
      </div>
    </>
  );
}
