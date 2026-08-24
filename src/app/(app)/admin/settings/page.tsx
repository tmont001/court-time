import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import Header from "@/components/Header";
import ClubBrandingSection from "./ClubBrandingSection";
import ClubTimezoneSection from "./ClubTimezoneSection";
import EventTypesSection from "./EventTypesSection";
import PricingSettingsForm from "./PricingSettingsForm";
import PaymentTrackingSection from "./PaymentTrackingSection";
import StripeConnectSection from "./StripeConnectSection";
import { getStripeConnectStatusForAdmin } from "./stripeConnectShared";
import LessonTypesSection from "./LessonTypesSection";
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

  const [settingsResult, clubResult, eventTypesResult, lessonTypesResult, stripeConnectResult] = await Promise.all([
    supabase
      .from("club_settings")
      .select("booking_window_days, cancellation_window_hours, cancellation_grace_minutes, waitlist_offer_window_hours, currency, default_court_hourly_rate_cents, payment_mode")
      .eq("club_id", clubId)
      .single(),
    supabase
      .from("clubs")
      .select("name, logo_url, theme_key, timezone")
      .eq("id", clubId)
      .single(),
    supabase
      .from("event_types")
      .select("id, key, label, color, is_active, default_price_amount_cents")
      .eq("club_id", clubId)
      .order("is_active", { ascending: false })
      .order("label"),
    supabase.rpc("get_lesson_types"),
    // Phase 34D-A: club_stripe_accounts has no authenticated-client grant
    // at all (0147) — this helper resolves the caller/club itself and
    // reads through the service-role RPC, scoped to the server's own
    // configured Stripe mode (never a client-selectable value).
    getStripeConnectStatusForAdmin(),
  ]);

  const settings   = settingsResult.data;
  const club       = clubResult.data;
  const eventTypes = (eventTypesResult.data ?? []) as {
    id: string; key: string; label: string; color: string; is_active: boolean;
    default_price_amount_cents: number | null;
  }[];
  const lessonTypes = (lessonTypesResult.data ?? []) as {
    id: string; name: string; description: string | null;
    allowed_durations: number[] | null; max_participants: number;
    pricing_basis: "flat" | "hourly"; unit_price_amount_cents: number | null;
    rate_notes: string | null; is_active: boolean;
  }[];
  const currency = settings?.currency ?? "USD";
  const stripeStatus = stripeConnectResult.status;

  // Server-only config checks — booleans only ever reach the rendered page;
  // no environment-variable name or value is passed as a prop or exposed to
  // the client.
  const smsConfigured =
    !!process.env.TWILIO_ACCOUNT_SID &&
    !!process.env.TWILIO_AUTH_TOKEN &&
    !!process.env.TWILIO_FROM_NUMBER;
  const emailConfigured = !!process.env.RESEND_API_KEY;
  const stripeConfigured = stripeConnectResult.configured;

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
          <EventTypesSection clubId={clubId} currency={currency} initialTypes={eventTypes} />
        </section>

        <hr className="border-gray-100 dark:border-gray-800" />

        {/* ── Pricing ── */}
        <section className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Pricing
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Club-wide currency and the default court reservation rate. Changes apply to new bookings only.
          </p>
          <PricingSettingsForm
            currency={currency}
            defaultCourtHourlyRateCents={settings?.default_court_hourly_rate_cents ?? null}
          />
        </section>

        <hr className="border-gray-100 dark:border-gray-800" />

        {/* ── Payments ── */}
        {/* Phase 34D-A: grouped under one "Payments" heading — Payment
            Tracking (34C, controls whether balances are tracked at all)
            and Court Time Payments (34D-A, the Stripe connected-account
            foundation a future checkpoint's activation gate will build
            on) are related but distinct configuration surfaces, kept
            visually separate within the group rather than merged into one
            control. Operational balances/Record Payment stay entirely on
            /admin/payments — nothing here duplicates that. */}
        <section className="space-y-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Payments
          </p>

          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
              Payment Tracking
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Controls whether Court Time tracks balances for new confirmed bookings. Existing
              payment history is never hidden or gated by this setting — it only affects whether
              NEW obligations are created going forward.
            </p>
            <PaymentTrackingSection
              clubId={clubId}
              currentMode={(settings?.payment_mode ?? "none") as "none" | "manual" | "court_time_payments"}
            />
          </div>

          <div className="space-y-2 pt-2 border-t border-gray-100 dark:border-gray-800">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 pt-2">
              Court Time Payments
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Connect Stripe to prepare this club to accept online payments from Members. Court
              Time Payments itself isn&apos;t available to turn on yet — this only sets up the connection.
            </p>
            <StripeConnectSection clubId={clubId} initialStatus={stripeStatus} configured={stripeConfigured} />
          </div>
        </section>

        <hr className="border-gray-100 dark:border-gray-800" />

        {/* ── Lesson Types ── */}
        <section className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Lesson Types
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Flat price per lesson type. Changing a price only affects lessons booked after the change.
          </p>
          <LessonTypesSection currency={currency} initialTypes={lessonTypes} />
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
