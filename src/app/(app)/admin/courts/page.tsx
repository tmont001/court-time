import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import { hasAdminAuthority } from "@/lib/auth/roles";
import Header from "@/components/Header";
import PageTabs from "@/components/PageTabs";
import CourtManagementList from "./CourtManagementList";
import OperatingHoursEditor from "./OperatingHoursEditor";
import DateOverridesEditor from "./DateOverridesEditor";
import BookingRulesForm from "./BookingRulesForm";
import DefaultCourtRatesForm from "./DefaultCourtRatesForm";
import CourtRatePeriodsSection from "./CourtRatePeriodsSection";

// Admin UX Checkpoint 2A: Courts IA. Originally three tabs — Courts /
// Hours & Closures / Booking Rules — replacing the three sections
// (Booking Rules, Operating Hours, Special Closures) that used to live on
// /admin/settings. Tab state is a plain ?tab= query param resolved
// server-side, matching the same Link-based, searchParams-driven pattern
// /admin/reports' range selector already established (not the
// client-useState EventsAdminTabs pattern — that one doesn't sync to the
// URL on switch, so it can't satisfy "refresh preserves the selected tab"
// or "direct URL to each tab works" the way a plain Link + searchParams
// page can). An unrecognized or missing tab value falls back to "courts",
// the same fail-safe-to-default shape resolveReportRange/EventsPage's own
// tab resolution already use.
//
// Peak/Off-Peak Pricing IA refinement — added a fourth tab, "rates" (Court
// Rates), consolidating the operator's court-pricing mental model onto
// this one page: Default Court Rates (formerly /admin/settings'
// PricingSettingsForm) and Peak & Off-Peak Rates (formerly /admin/
// settings' CourtRatePeriodsSection) now live here, next to the
// per-court overrides (CourtManagementList) they already conceptually
// belong with. Club currency stays edited exclusively in Settings — this
// tab only displays it for context (see DefaultCourtRatesForm's own
// "Rates shown in {currency}" line) and never exposes it as editable.
type CourtsTab = "courts" | "hours" | "rules" | "rates";

function resolveCourtsTab(raw: string | undefined): CourtsTab {
  if (raw === "hours") return "hours";
  if (raw === "rules") return "rules";
  if (raw === "rates") return "rates";
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

  const [{ data: courts, error }, { data: settings }, { data: club }, { data: ratePeriods }] = await Promise.all([
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
    // Peak/Off-Peak Pricing IA refinement: court_rate_periods (0200) has
    // an admin-only, same-club SELECT RLS policy already — this page is
    // already admin-gated above, so the existing RLS-respecting server
    // client can read it directly, exactly like every other query in this
    // same Promise.all. No table RLS change, no new read path invented.
    supabase
      .from("court_rate_periods")
      .select("id, name, days_of_week, starts_at_local, ends_at_local, hourly_rate_cents, hourly_rate_non_member_cents, is_active")
      .eq("club_id", clubId)
      .order("starts_at_local", { ascending: true }),
  ]);

  if (error) {
    console.error("[AdminCourts] courts query failed:", error.message);
  }

  const tabLinks: { key: CourtsTab; label: string; href: string }[] = [
    { key: "courts", label: "Courts", href: "/admin/courts" },
    { key: "hours", label: "Hours & Closures", href: "/admin/courts?tab=hours" },
    { key: "rules", label: "Booking Rules", href: "/admin/courts?tab=rules" },
    { key: "rates", label: "Court Rates", href: "/admin/courts?tab=rates" },
  ];

  return (
    <>
      <Header screenTitle="Courts" />
      <div className="px-4 py-6 space-y-4 md:max-w-2xl md:mx-auto dark:text-gray-100">

        {/* ── Tab strip ── the shared PageTabs component (src/components/
            PageTabs.tsx), Court Time's one canonical page-level tab-strip
            treatment. Link-backed (href, not onClick) — same Link +
            searchParams pattern as before: direct URL/refresh/Back-Forward
            all keep working exactly as they did with the inline markup
            this replaced. */}
        <PageTabs
          items={tabLinks.map(t => ({ key: t.key, label: t.label, href: t.href, active: tab === t.key }))}
        />

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

        {tab === "rates" && (
          <div className="space-y-4">
            {/* ── Default Court Rates ── relocated from /admin/settings'
                former PricingSettingsForm. Currency itself stays editable
                only in Settings — this tab displays it for context via
                DefaultCourtRatesForm's own "Rates shown in {currency}"
                line, never as an editable field. */}
            <section className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                Default Court Rates
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                The club-wide default hourly rate charged for a court reservation. Changes apply to new
                bookings only.
              </p>
              <DefaultCourtRatesForm
                currency={settings?.currency ?? "USD"}
                defaultCourtHourlyRateCents={settings?.default_court_hourly_rate_cents ?? null}
                membershipsEnabled={settings?.memberships_enabled ?? true}
                defaultCourtHourlyRateNonMemberCents={settings?.default_court_hourly_rate_non_member_cents ?? null}
              />
            </section>

            <hr className="border-gray-100 dark:border-gray-800" />

            {/* ── Peak & Off-Peak Rates ── relocated from /admin/settings'
                former CourtRatePeriodsSection (0200 court_rate_periods).
                All mutations go through the two existing lifecycle RPCs,
                never a direct table write. */}
            <section className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                Peak &amp; Off-Peak Rates
              </p>
              <CourtRatePeriodsSection
                initialPeriods={ratePeriods ?? []}
                currency={settings?.currency ?? "USD"}
                membershipsEnabled={settings?.memberships_enabled ?? true}
              />
            </section>
          </div>
        )}

      </div>
    </>
  );
}
