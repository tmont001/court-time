import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import { hasAdminAuthority } from "@/lib/auth/roles";
import Header from "@/components/Header";
import CourtManagementList from "./CourtManagementList";
import OperatingHoursEditor from "./OperatingHoursEditor";
import DateOverridesEditor from "./DateOverridesEditor";
import BookingRulesForm from "./BookingRulesForm";

// Admin UX Checkpoint 2A: Courts IA. Three tabs — Courts / Hours & Closures /
// Booking Rules — replacing the three sections (Booking Rules, Operating
// Hours, Special Closures) that used to live on /admin/settings. Tab state
// is a plain ?tab= query param resolved server-side, matching the same
// Link-based, searchParams-driven pattern /admin/reports' range selector
// already established (not the client-useState EventsAdminTabs pattern —
// that one doesn't sync to the URL on switch, so it can't satisfy "refresh
// preserves the selected tab" or "direct URL to each tab works" the way a
// plain Link + searchParams page can). An unrecognized or missing tab value
// falls back to "courts", the same fail-safe-to-default shape
// resolveReportRange/EventsPage's own tab resolution already use.
type CourtsTab = "courts" | "hours" | "rules";

function resolveCourtsTab(raw: string | undefined): CourtsTab {
  if (raw === "hours") return "hours";
  if (raw === "rules") return "rules";
  return "courts";
}

export default async function AdminCourtsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  const profile = await getAuthProfile();
  if (!hasAdminAuthority(profile?.role)) redirect("/calendar");

  const sp = await searchParams;
  const tab = resolveCourtsTab(sp.tab);

  const supabase = await createClient();
  const clubId = profile?.club_id ?? "";

  const [{ data: courts, error }, { data: settings }, { data: club }] = await Promise.all([
    supabase
      .from("courts")
      .select("id, name, display_order, is_active, hourly_rate_cents, hourly_rate_non_member_cents")
      .eq("club_id", clubId)
      .order("display_order", { ascending: true }),
    supabase
      .from("club_settings")
      .select(
        "currency, default_court_hourly_rate_cents, default_court_hourly_rate_non_member_cents, memberships_enabled, booking_window_days, cancellation_window_hours, cancellation_grace_minutes, waitlist_offer_window_hours"
      )
      .eq("club_id", clubId)
      .single(),
    supabase
      .from("clubs")
      .select("timezone")
      .eq("id", clubId)
      .single(),
  ]);

  if (error) {
    console.error("[AdminCourts] courts query failed:", error.message);
  }

  const tabLinks: { key: CourtsTab; label: string; href: string }[] = [
    { key: "courts", label: "Courts", href: "/admin/courts" },
    { key: "hours", label: "Hours & Closures", href: "/admin/courts?tab=hours" },
    { key: "rules", label: "Booking Rules", href: "/admin/courts?tab=rules" },
  ];

  return (
    <>
      <Header screenTitle="Courts" />
      <div className="px-4 py-6 space-y-4 md:max-w-2xl md:mx-auto dark:text-gray-100">

        {/* ── Tab strip ── same Link + searchParams pattern as /admin/reports'
            range selector: one ct-card, divide-x, flex-1 links, active tab
            filled with the accent color. Each link is itself a flex
            container (items-center justify-center) so its own text is
            centered both ways within whatever height the row stretches to
            — the three links are flex siblings of one row with the default
            align-items: stretch, so "Hours & Closures" wrapping to two
            lines on mobile makes all three equally tall automatically;
            without items-center on each link, the single-line labels would
            sit at the top of that shared height instead of centered in it.
            leading-tight keeps the wrapped two-line label compact. No fixed
            height is set — the natural stretch-to-tallest-sibling behavior
            already guarantees equal height without one. */}
        <div className="ct-card flex divide-x divide-gray-100 dark:divide-gray-800 overflow-hidden">
          {tabLinks.map(t => (
            <Link
              key={t.key}
              href={t.href}
              className={`flex-1 flex items-center justify-center text-center leading-tight px-2 py-2 text-xs font-medium motion-safe:transition-colors motion-safe:duration-100 ${
                tab === t.key
                  ? "bg-accent text-white"
                  : "text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/50"
              }`}
            >
              {t.label}
            </Link>
          ))}
        </div>

        {tab === "courts" && (
          <div className="space-y-4">
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
              membershipsEnabled={settings?.memberships_enabled ?? true}
              defaultHourlyRateNonMemberCents={settings?.default_court_hourly_rate_non_member_cents ?? null}
            />
          </div>
        )}

        {tab === "hours" && (
          <div className="space-y-4">
            {/* ── Regular operating hours ── */}
            <section className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                Regular operating hours
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Changes take effect immediately for new bookings. Existing reservations are not affected.
              </p>
              <OperatingHoursEditor clubId={clubId} />
            </section>

            <hr className="border-gray-100 dark:border-gray-800" />

            {/* ── Special closures / date overrides ── */}
            <section className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                Special closures / date overrides
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Override hours for a specific date. Existing reservations are not cancelled or modified.
              </p>
              <DateOverridesEditor
                clubId={clubId}
                clubTimezone={club?.timezone ?? "America/New_York"}
              />
            </section>
          </div>
        )}

        {tab === "rules" && (
          <section className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Booking Rules
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Changes take effect immediately for all members.
            </p>
            <BookingRulesForm
              bookingWindowDays={settings?.booking_window_days ?? 14}
              cancellationWindowHours={settings?.cancellation_window_hours ?? 24}
              cancellationGraceMinutes={settings?.cancellation_grace_minutes ?? 5}
              waitlistOfferWindowHours={settings?.waitlist_offer_window_hours ?? 2}
            />
          </section>
        )}

      </div>
    </>
  );
}
