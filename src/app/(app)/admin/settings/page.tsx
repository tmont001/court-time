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
import CourtTimePaymentsSection from "./CourtTimePaymentsSection";
import { getStripeConnectStatusForAdmin } from "./stripeConnectShared";
import { deriveConnectUIState } from "@/lib/stripe/connectConfig";
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
  // Phase 34G-A2 — already resolved by getAuthProfile() for every caller
  // (current_club_has_capability RPC, 0122); no new query. Read-only here
  // — see the Operating Model section below.
  const memberSelfService = profile?.memberSelfService ?? false;

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
  // Phase 34D-C: the SAME derivation StripeConnectSection's own state
  // already uses, computed once here so PaymentTrackingSection's
  // activation gate and StripeConnectSection's own display can never
  // disagree about whether the club is actually ready.
  const stripeReadiness = deriveConnectUIState(stripeStatus.connected, stripeStatus.cardPaymentsStatus);

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

        {/* ── Operating Model (Phase 34G-A2) ── */}
        {/* Read-only — sourced from the same profile.memberSelfService value
            every capability check already uses (src/lib/supabase/user.ts,
            current_club_has_capability RPC, 0122). No tier-mutation control
            lives here or anywhere in-app; changing tier remains a
            service_role-only operator action (set_club_tier_for_operator,
            reachable only via scripts/grant-club-entitlement.mjs). This is
            purely a clarity aid so an Admin isn't left guessing why, e.g.,
            Court Time Payments requires Connected below.
            Phase 34G-B (readability correction) — plan pills now say
            "Staff-Managed Plan"/"Connected Plan" (never bare "Connected"),
            explicitly naming them as plans so neither can be mistaken for
            infrastructure/status terminology (see StripeConnectSection's
            own "Stripe ready" badge, deliberately never "Connected"
            either). Staff-Managed uses neutral slate/gray styling — it is
            a legitimate paid product, never styled as a warning/disabled
            state.
            Phase 34G-C3 (brand identity, corrected) — Connected Plan now
            uses the dedicated Court Time brand-green identity via the
            shared .ct-brand-pill CSS class (globals.css) rather than the
            generic Tailwind green scale: this pill represents a Court Time
            commercial PRODUCT identity, not a status/readiness signal —
            StripeConnectSection's "Stripe ready" badge below stays on the
            semantic green scale unchanged, since readiness IS a status
            signal. .ct-brand-pill exists specifically because Tailwind
            can't apply an opacity modifier to a var()-backed named color
            at build time — it centralizes the brand color source values
            (--ct-brand/--ct-brand-tint) in one token-backed CSS rule
            instead of repeating literal hex at this JSX call site. */}
        <section className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Operating Model
          </p>
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3.5 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {memberSelfService ? "Connected" : "Staff-Managed"}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {memberSelfService
                  ? "Everything in Staff-Managed, plus Member self-service for accounts, court booking, signup, and lesson requests."
                  : "Full staff/operational functionality. Member self-service is not included on this plan."}
              </p>
            </div>
            <span
              className={`shrink-0 inline-block px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide border ${
                memberSelfService
                  ? "ct-brand-pill"
                  : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600"
              }`}
            >
              {memberSelfService ? "Connected Plan" : "Staff-Managed Plan"}
            </span>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Plan changes are managed by Court Time.{" "}
            <Link href="/pricing" className="text-accent hover:underline">
              Compare plans
            </Link>{" "}
            or{" "}
            <Link href="/contact" className="text-accent hover:underline">
              contact us
            </Link>{" "}
            to switch.
          </p>
        </section>

        <hr className="border-gray-100 dark:border-gray-800" />

        {/* ── Payments ── */}
        {/* Phase 34G-B (hierarchy correction): ONE top-level Payments
            section, not three unrelated ones — a club operator experiences
            this as a single workflow. Two visually distinct groups inside
            it: Payment Tracking (the base balance-tracking layer), then
            Online Payments (Stripe Account infrastructure, followed by the
            Court Time Payments feature that depends on it — grouped so the
            dependency is visually obvious without "above"/"below" copy).
            Each of the three components below still derives from and
            mutates its own independent source of truth exactly as before
            this correction — this is a visual/IA change only, no state
            logic was recombined. Operational balances/Record Payment stay
            entirely on /admin/payments — nothing here duplicates that. */}
        <section className="space-y-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Payments
          </p>

          <div className="space-y-2">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Choose whether Court Time tracks balances for new bookings. Existing payment history
              is never hidden or rewritten by this setting — it only affects what happens going
              forward.
            </p>
            <PaymentTrackingSection
              clubId={clubId}
              currentMode={(settings?.payment_mode ?? "none") as "none" | "manual" | "court_time_payments"}
            />
          </div>

          <div className="space-y-2 pt-2 border-t border-gray-100 dark:border-gray-800">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 pt-2">
              Online Payments
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Stripe securely handles card processing and payouts. Court Time Payments is the
              optional feature that uses your connected Stripe account to let Members pay
              online — available once your club is Connected.
            </p>
            <StripeConnectSection clubId={clubId} initialStatus={stripeStatus} configured={stripeConfigured} />
            <CourtTimePaymentsSection
              clubId={clubId}
              currentMode={(settings?.payment_mode ?? "none") as "none" | "manual" | "court_time_payments"}
              stripeReadiness={stripeReadiness}
              connected={memberSelfService}
            />
          </div>
        </section>

        <hr className="border-gray-100 dark:border-gray-800" />

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
