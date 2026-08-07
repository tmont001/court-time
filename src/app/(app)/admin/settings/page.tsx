import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import Header from "@/components/Header";
import ClubBrandingSection from "./ClubBrandingSection";
import ClubTimezoneSection from "./ClubTimezoneSection";
import EventTypesSection from "./EventTypesSection";
import BookingRulesForm from "./BookingRulesForm";
import OperatingHoursEditor from "./OperatingHoursEditor";
import DateOverridesEditor from "./DateOverridesEditor";
import DeliveryDiagnosticsSection from "./DeliveryDiagnosticsSection";
import AnnouncementsSection from "./AnnouncementsSection";

export default async function AdminSettingsPage() {
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  const profile  = await getAuthProfile();
  if (profile?.role !== "admin") redirect("/calendar");

  const supabase = await createClient();
  const clubId = profile?.club_id ?? "";

  const [settingsResult, clubResult, eventTypesResult] = await Promise.all([
    supabase
      .from("club_settings")
      .select("booking_window_days, cancellation_window_hours, cancellation_grace_minutes, waitlist_offer_window_hours")
      .eq("club_id", clubId)
      .single(),
    supabase
      .from("clubs")
      .select("name, logo_url, theme_key, timezone")
      .eq("id", clubId)
      .single(),
    supabase
      .from("event_types")
      .select("id, key, label, color, is_active")
      .eq("club_id", clubId)
      .order("is_active", { ascending: false })
      .order("label"),
  ]);

  const settings   = settingsResult.data;
  const club       = clubResult.data;
  const eventTypes = (eventTypesResult.data ?? []) as {
    id: string; key: string; label: string; color: string; is_active: boolean;
  }[];

  // Server-only config checks — booleans only ever reach the rendered page;
  // no environment-variable name or value is passed as a prop or exposed to
  // the client.
  const smsConfigured =
    !!process.env.TWILIO_ACCOUNT_SID &&
    !!process.env.TWILIO_AUTH_TOKEN &&
    !!process.env.TWILIO_FROM_NUMBER;
  const emailConfigured = !!process.env.RESEND_API_KEY;

  return (
    <>
      <Header screenTitle="Settings" />
      <div className="px-4 pt-3 pb-0 md:max-w-2xl md:mx-auto">
        <Link href="/profile" className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-accent motion-safe:transition-colors motion-safe:duration-150">
          ← Back to Account
        </Link>
      </div>
      <div className="px-4 py-6 space-y-6 md:max-w-2xl md:mx-auto dark:text-gray-100">

        {/* ── Club Branding ── */}
        <section className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Club Branding
          </p>
          <ClubBrandingSection
            clubName={club?.name ?? ""}
            logoUrl={club?.logo_url ?? null}
            themeKey={club?.theme_key ?? "graphite"}
          />
        </section>

        <hr className="border-gray-100 dark:border-gray-800" />

        {/* ── Club Timezone ── */}
        <section className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Club Timezone
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            All dates and times in the app are displayed in this timezone.
          </p>
          <ClubTimezoneSection currentTimezone={club?.timezone ?? "America/New_York"} />
        </section>

        <hr className="border-gray-100 dark:border-gray-800" />

        {/* ── Event Types ── */}
        <section className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Event Types
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Edit labels and colors. Deactivated types stay on historical events but are hidden when creating new ones.
          </p>
          <EventTypesSection clubId={clubId} initialTypes={eventTypes} />
        </section>

        <hr className="border-gray-100 dark:border-gray-800" />

        {/* ── Booking Rules ── */}
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

        <hr className="border-gray-100 dark:border-gray-800" />

        {/* ── Operating Hours ── */}
        <section className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Operating Hours
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Changes take effect immediately for new bookings. Existing reservations are not affected.
          </p>
          <OperatingHoursEditor clubId={clubId} />
        </section>

        <hr className="border-gray-100 dark:border-gray-800" />

        {/* ── Special Closures ── */}
        <section className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Special Closures
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Override hours for a specific date. Existing reservations are not cancelled or modified.
          </p>
          <DateOverridesEditor
            clubId={clubId}
            clubTimezone={club?.timezone ?? "America/New_York"}
          />
        </section>

        <hr className="border-gray-100 dark:border-gray-800" />

        {/* ── Member Announcements ── */}
        <section className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Member Announcements
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Send an in-app notification to all active members.
          </p>
          <AnnouncementsSection />
        </section>

        <hr className="border-gray-100 dark:border-gray-800" />

        {/* ── Delivery diagnostics ── */}
        {/* Phase 31D: closed by default, visually secondary — operator-only
            provider status and test controls, kept separate from Member
            notification preferences (which live at /profile/notifications)
            and from Admin announcement composition above. */}
        <section>
          <DeliveryDiagnosticsSection
            emailConfigured={emailConfigured}
            smsConfigured={smsConfigured}
          />
        </section>

      </div>
    </>
  );
}
