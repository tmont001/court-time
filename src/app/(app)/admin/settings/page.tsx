import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Header from "@/components/Header";
import ClubBrandingSection from "./ClubBrandingSection";
import BookingRulesForm from "./BookingRulesForm";
import OperatingHoursEditor from "./OperatingHoursEditor";
import DateOverridesEditor from "./DateOverridesEditor";
import TestSmsSection from "./TestSmsSection";
import AnnouncementsSection from "./AnnouncementsSection";

export default async function AdminSettingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");

  const { data: profile } = await supabase
    .from("profiles")
    .select("club_id, role")
    .eq("id", user.id)
    .single();

  const { data: settings } = await supabase
    .from("club_settings")
    .select("booking_window_days, cancellation_window_hours, cancellation_grace_minutes, waitlist_offer_window_hours")
    .eq("club_id", profile?.club_id ?? "")
    .single();

  const { data: club } = await supabase
    .from("clubs")
    .select("name, logo_url, theme_key, timezone")
    .eq("id", profile?.club_id ?? "")
    .single();

  const twilioConfigured =
    !!process.env.TWILIO_ACCOUNT_SID &&
    !!process.env.TWILIO_AUTH_TOKEN &&
    !!process.env.TWILIO_FROM_NUMBER;

  return (
    <>
      <Header screenTitle="Settings" />
      <div className="px-4 py-6 space-y-6 md:max-w-2xl md:mx-auto dark:text-gray-100">

        {/* ── Club Branding ── */}
        <section className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Club Branding
          </p>
          <ClubBrandingSection
            clubName={club?.name ?? ""}
            logoUrl={club?.logo_url ?? null}
            themeKey={club?.theme_key ?? "classic-gray"}
          />
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
          <OperatingHoursEditor clubId={profile?.club_id ?? ""} />
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
            clubId={profile?.club_id ?? ""}
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

        {/* ── Notifications ── */}
        <section className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Notifications
          </p>
          <TestSmsSection twilioConfigured={twilioConfigured} />
          <p className="text-xs text-gray-400 dark:text-gray-500">
            More notification options coming soon.
          </p>
        </section>

      </div>
    </>
  );
}
