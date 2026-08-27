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

  // Phase 33F3B: a Staff-Managed Member has no calendar-level functionality
  // left — no club-wide reservation availability, no new-booking ability
  // (create_reservation itself rejects it) — their own reservations remain
  // fully visible on /my-schedule. Admin/Pro are never redirected here,
  // regardless of tier.
  if (profile?.role === "member" && profile.memberSelfService === false) {
    redirect("/my-schedule");
  }

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
    { data: settings },
  ] = await Promise.all([
    clubId
      ? supabase.from("clubs").select("timezone").eq("id", clubId).single()
      : Promise.resolve({ data: null }),
    supabase
      .from("courts")
      .select("id, name, display_order, hourly_rate_cents")
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
    clubId
      ? supabase.from("club_settings").select("currency, default_court_hourly_rate_cents").eq("club_id", clubId).single()
      : Promise.resolve({ data: null }),
  ]);

  const clubTimezone = club?.timezone ?? "America/New_York";

  // Compute today in the club's timezone on the server so CalendarShell gets a
  // stable YYYY-MM-DD string for both SSR and client hydration.
  const todayISO = new Date().toLocaleDateString("en-CA", { timeZone: clubTimezone });

  // Optional ?date=YYYY-MM-DD query parameter — jump the calendar to a specific date.
  const sp            = searchParams ? await searchParams : {};
  const dateParam     = typeof sp.date === "string" ? sp.date : null;
  const initialDateISO = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : null;

  // Phase 34D-D1: optional ?checkout=success&reservation=<uuid> return from
  // Stripe Checkout — see CalendarShell's own comment for what this does
  // (and does not do: never mutates any financial state itself).
  const checkoutParam    = typeof sp.checkout === "string" ? sp.checkout : null;
  const reservationParam = typeof sp.reservation === "string" ? sp.reservation : null;
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const initialCheckoutReservationId =
    checkoutParam === "success" && reservationParam && uuidRe.test(reservationParam) ? reservationParam : null;

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
          initialCheckoutReservationId={initialCheckoutReservationId}
          operatingHours={operatingHours ?? []}
          operatingHoursOverrides={operatingHoursOverrides ?? []}
          currency={settings?.currency ?? "USD"}
          defaultCourtHourlyRateCents={settings?.default_court_hourly_rate_cents ?? null}
        />
      </div>
    </>
  );
}
