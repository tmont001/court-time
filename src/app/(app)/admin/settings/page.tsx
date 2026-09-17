import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import { createPrivilegedClient } from "@/lib/supabase/privileged";
import Header from "@/components/Header";
import ClubBrandingSection from "./ClubBrandingSection";
import ClubTimezoneSection from "./ClubTimezoneSection";
import ClubRulesSection from "./ClubRulesSection";
import PricingSettingsForm from "./PricingSettingsForm";
import MembershipsSection from "./MembershipsSection";
import MembershipTypesSection from "./MembershipTypesSection";
import MemberWaiverSection, {
  type CurrentWaiverDocument,
  type LegacyDraftVersion,
} from "./MemberWaiverSection";
import GuestWaiverSection, {
  type CurrentGuestWaiverDocument,
  type LegacyGuestDraftVersion,
} from "./GuestWaiverSection";
import PaymentTrackingSection from "./PaymentTrackingSection";
import StripeConnectSection from "./StripeConnectSection";
import CourtTimePaymentsSection from "./CourtTimePaymentsSection";
import { getStripeConnectStatusForAdmin } from "./stripeConnectShared";
import { deriveConnectUIState } from "@/lib/stripe/connectConfig";

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

  const [settingsResult, clubResult, stripeConnectResult, membershipTypesResult] = await Promise.all([
    supabase
      .from("club_settings")
      .select(
        "currency, default_court_hourly_rate_cents, default_court_hourly_rate_non_member_cents, memberships_enabled, payment_mode, rules_and_policies"
      )
      .eq("club_id", clubId)
      .single(),
    supabase
      .from("clubs")
      .select("name, logo_url, theme_key, timezone")
      .eq("id", clubId)
      .single(),
    // Phase 34D-A: club_stripe_accounts has no authenticated-client grant
    // at all (0147) — this helper resolves the caller/club itself and
    // reads through the service-role RPC, scoped to the server's own
    // configured Stripe mode (never a client-selectable value).
    getStripeConnectStatusForAdmin(),
    // Phase 42C-3B — membership_types is a plain RLS-scoped table read
    // (admin-only, same-club policy, 0188), not an RPC: this whole page
    // is already Admin-gated above, so no extra role check is needed
    // here. Shows ALL types (active and inactive) — Membership Types
    // management is the one surface where an inactive type must remain
    // fully visible/renamable/reactivatable, never hidden.
    supabase
      .from("membership_types")
      .select("id, name, is_active")
      .eq("club_id", clubId)
      .order("name"),
  ]);

  const settings   = settingsResult.data;
  const club       = clubResult.data;
  const membershipTypes = membershipTypesResult.data ?? [];

  // Phase 43A-2 — Member Waiver: Admin-only RLS-scoped direct table reads
  // (0192), not a new RPC. Fetches only what the UI needs (waiver
  // metadata, current published version, an unpublished draft if any) —
  // no roster-wide acceptance/compliance data belongs on this page.
  const { data: waiverRow } = await supabase
    .from("waivers")
    .select("id, is_required, current_version_id")
    .eq("club_id", clubId)
    .eq("audience", "member")
    .maybeSingle();

  // Phase 43B-2B — Guest Waiver: an INDEPENDENT audience='guest' read,
  // same RLS-scoped direct table reads as the Member read above, never
  // derived from waiverRow. Guest and Member are separate waivers rows
  // (0195, unique(club_id, audience)).
  const { data: guestWaiverRow } = await supabase
    .from("waivers")
    .select("id, is_required, current_version_id")
    .eq("club_id", clubId)
    .eq("audience", "guest")
    .maybeSingle();

  const [{ data: memberVersions }, { data: guestVersions }] = await Promise.all([
    waiverRow
      ? supabase
          .from("waiver_versions")
          .select("id, title, body, status, published_at")
          .eq("waiver_id", waiverRow.id)
      : Promise.resolve({ data: null }),
    guestWaiverRow
      ? supabase
          .from("waiver_versions")
          .select("id, title, body, status, published_at")
          .eq("waiver_id", guestWaiverRow.id)
      : Promise.resolve({ data: null }),
  ]);

  // Phase 43B-3B — waiver_document_files has ALL direct table access
  // revoked (0196) — its lookup goes through the privileged (service_
  // role) client, never the normal RLS-scoped one above. This is a plain
  // narrow read keyed ONLY by version ids this Server Component already
  // resolved from the admin-RLS-scoped waivers table a moment ago —
  // never a client-supplied id — so no new RPC is needed; a batched `in`
  // query avoids N+1 for the (at most two) current versions. See this
  // checkpoint's own report for why this was preferred over a new 0197
  // RPC: the read is narrow, server-only, and keyed by already-verified
  // ids, exactly the case createPrivilegedClient() exists for.
  const currentVersionIds = [waiverRow?.current_version_id, guestWaiverRow?.current_version_id].filter(
    (id): id is string => Boolean(id)
  );
  let documentByVersionId = new Map<string, { originalFilename: string }>();
  if (currentVersionIds.length > 0) {
    const privileged = createPrivilegedClient();
    if (privileged) {
      const { data: docs } = await privileged
        .from("waiver_document_files")
        .select("waiver_version_id, original_filename")
        .in("waiver_version_id", currentVersionIds);
      documentByVersionId = new Map(
        (docs ?? []).map((d) => [d.waiver_version_id, { originalFilename: d.original_filename }])
      );
    }
  }

  // PDF-backed vs legacy text: a PDF-backed version always has body = NULL
  // (0196's publish_waiver_pdf_version always inserts body = null) and a
  // matching waiver_document_files row; a legacy text version has a
  // populated body and no document row. No new query is needed for this
  // distinction — it falls directly out of data already read above.
  let currentMemberDocument: CurrentWaiverDocument | null = null;
  let legacyMemberDraft: LegacyDraftVersion | null = null;
  if (waiverRow) {
    const draft = memberVersions?.find((v) => v.status === "draft") ?? null;
    const current = memberVersions?.find((v) => v.id === waiverRow.current_version_id) ?? null;
    if (draft) {
      legacyMemberDraft = { id: draft.id, title: draft.title, body: draft.body ?? "" };
    }
    if (current) {
      const doc = documentByVersionId.get(current.id) ?? null;
      currentMemberDocument = {
        versionId: current.id,
        publishedAt: current.published_at ?? "",
        isPdfBacked: doc !== null,
        originalFilename: doc?.originalFilename ?? null,
        legacyTitle: doc ? null : current.title,
        legacyBody: doc ? null : current.body,
      };
    }
  }

  let currentGuestDocument: CurrentGuestWaiverDocument | null = null;
  let legacyGuestDraft: LegacyGuestDraftVersion | null = null;
  if (guestWaiverRow) {
    const guestDraft = guestVersions?.find((v) => v.status === "draft") ?? null;
    const guestCurrent = guestVersions?.find((v) => v.id === guestWaiverRow.current_version_id) ?? null;
    if (guestDraft) {
      legacyGuestDraft = { id: guestDraft.id, title: guestDraft.title, body: guestDraft.body ?? "" };
    }
    if (guestCurrent) {
      const doc = documentByVersionId.get(guestCurrent.id) ?? null;
      currentGuestDocument = {
        versionId: guestCurrent.id,
        publishedAt: guestCurrent.published_at ?? "",
        isPdfBacked: doc !== null,
        originalFilename: doc?.originalFilename ?? null,
        legacyTitle: doc ? null : guestCurrent.title,
        legacyBody: doc ? null : guestCurrent.body,
      };
    }
  }

  const currency = settings?.currency ?? "USD";
  const membershipsEnabled = settings?.memberships_enabled ?? true;
  const stripeStatus = stripeConnectResult.status;
  // Phase 34D-C: the SAME derivation StripeConnectSection's own state
  // already uses, computed once here so PaymentTrackingSection's
  // activation gate and StripeConnectSection's own display can never
  // disagree about whether the club is actually ready.
  const stripeReadiness = deriveConnectUIState(stripeStatus.connected, stripeStatus.cardPaymentsStatus);

  const stripeConfigured = stripeConnectResult.configured;

  return (
    <>
      <Header screenTitle="Club Settings" />
      <div className="px-4 py-6 space-y-8 md:max-w-2xl md:mx-auto dark:text-gray-100">

        {/* ═══════════════════════════════════════════════════════════════
            Admin IA Checkpoint 5 — Final Club Settings Regroup. All
            domain-specific configuration has moved out of this page
            (Courts -> /admin/courts, Event Types -> /events, Lesson Types
            -> /admin/lessons, Announcements/Delivery Diagnostics ->
            /admin/communications), so what remains is true club-wide
            configuration: Club Profile, Memberships, Pricing & Payments,
            Plan & Access. No tabs, no accordions, no subroutes — one
            page, vertically grouped, with a bold group heading above
            each group's own small-caps subsection labels (the existing
            "text-xs font-semibold uppercase tracking-wider" treatment,
            reused here as the SUBSECTION level rather than the group
            level) so the hierarchy reads as two tiers, not a flat repeat
            of "CLUB PROFILE" / "CLUB BRANDING". Every child component
            below is presentation-neutral (no component renders its own
            top-level heading), so this is a pure JSX/copy reorganization —
            Phase 42C-3B split the former Memberships subsection (inside
            Pricing & Payments) out into its own top-level group and added
            Membership Types management alongside the existing toggle —
            no component's props, state, or Server Action calls changed. ══ */}

        {/* ── Group 1: Club Profile ── */}
        <section className="space-y-4">
          <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Club Profile</h2>

          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Branding
            </p>
            <ClubBrandingSection
              clubName={club?.name ?? ""}
              logoUrl={club?.logo_url ?? null}
              themeKey={club?.theme_key ?? "graphite"}
            />
          </div>

          <hr className="border-gray-100 dark:border-gray-800" />

          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Timezone
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              All dates and times in the app are displayed in this timezone.
            </p>
            <ClubTimezoneSection currentTimezone={club?.timezone ?? "America/New_York"} />
          </div>

          <hr className="border-gray-100 dark:border-gray-800" />

          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Club Rules & Policies
            </p>
            <ClubRulesSection currentRulesAndPolicies={settings?.rules_and_policies ?? null} />
          </div>
        </section>

        <hr className="border-gray-200 dark:border-gray-700" />

        {/* ── Group 2: Memberships (Phase 42C-3B) ──
            Moved out of Pricing & Payments — frontend-only reorganization,
            no data-fetching or Server Action change (memberships_enabled
            was already selected above; membership_types is a new read,
            but on the SAME already-Admin-gated page). The On/Off toggle
            is ALWAYS visible, even when off — Membership Types management
            hides entirely when off, but nothing in the database is ever
            cleared by hiding it (0188's soft-lifecycle RPCs are the only
            thing that can change a type's own is_active, never this
            visibility gate). */}
        <section className="space-y-4">
          <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Memberships</h2>

          <MembershipsSection enabled={membershipsEnabled} />

          {membershipsEnabled && (
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                Membership Types
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Club-configurable membership categories (e.g. Adult, Junior, Senior). Deactivating a
                type keeps it attached to anyone who already has it — it just can&apos;t be newly
                assigned.
              </p>
              <MembershipTypesSection initialTypes={membershipTypes} />
            </div>
          )}

          {/* Phase 43A-2 — Member Waiver. Deliberately NOT gated behind
              membershipsEnabled: waiver acceptance is a legal-agreement
              concept independent of the club-business "Membership"
              program toggle above — a club with Memberships off can still
              require a Member waiver. */}
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Member Waiver
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Upload your club&apos;s Member waiver as a PDF for Members to review and agree to.
              Replacing it requires Members to agree again.
            </p>
            <MemberWaiverSection
              waiverId={waiverRow?.id ?? null}
              isRequired={waiverRow?.is_required ?? true}
              currentDocument={currentMemberDocument}
              legacyDraft={legacyMemberDraft}
            />
          </div>

          {/* Phase 43B-2B — Guest Waiver. An independently versioned
              document from the Member waiver above — separate waivers
              row (audience='guest'), separate draft/publish lifecycle,
              separate Required toggle. Not a variation picker inside the
              Member editor. No Guest acceptance flow exists yet — this
              section only manages the document; nothing here implies
              booking/event/check-in enforcement. */}
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Guest Waiver
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Upload a separate PDF waiver for Guests, independent from the Member waiver above.
            </p>
            <GuestWaiverSection
              waiverId={guestWaiverRow?.id ?? null}
              isRequired={guestWaiverRow?.is_required ?? true}
              currentDocument={currentGuestDocument}
              legacyDraft={legacyGuestDraft}
            />
          </div>
        </section>

        <hr className="border-gray-200 dark:border-gray-700" />

        {/* ── Group 3: Pricing & Payments ──
            Locked product distinction: Pricing = what the club charges;
            Payments = how the club tracks/collects money. Global/default
            pricing stays here — domain-specific pricing (court overrides,
            Event Type pricing, Lesson Type pricing) stays in its own
            domain page and is never duplicated here. */}
        <section className="space-y-4">
          <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Pricing & Payments</h2>

          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Pricing
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Club-wide currency and the default court reservation rate. Changes apply to new bookings only.
            </p>
            <PricingSettingsForm
              currency={currency}
              defaultCourtHourlyRateCents={settings?.default_court_hourly_rate_cents ?? null}
              membershipsEnabled={membershipsEnabled}
              defaultCourtHourlyRateNonMemberCents={settings?.default_court_hourly_rate_non_member_cents ?? null}
            />
          </div>

          <hr className="border-gray-100 dark:border-gray-800" />

          {/* Phase 34G-B (hierarchy correction, preserved): ONE Payments
              subsection, not three unrelated ones — a club operator
              experiences this as a single workflow. Two visually distinct
              groups inside it: Payment Tracking (the base balance-tracking
              layer), then Online Payments (Stripe Account infrastructure,
              followed by the Court Time Payments feature that depends on
              it). Each of the three components below still derives from
              and mutates its own independent source of truth exactly as
              before — this checkpoint is a visual/IA change only, no state
              logic was recombined. Operational balances/Record Payment
              stay entirely on /admin/payments — nothing here duplicates
              that. */}
          <div className="space-y-4">
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
          </div>
        </section>

        <hr className="border-gray-200 dark:border-gray-700" />

        {/* ── Group 4: Plan & Access (Phase 34G-A2) ──
            Read-only — sourced from the same profile.memberSelfService
            value every capability check already uses
            (src/lib/supabase/user.ts, current_club_has_capability RPC,
            0122). No tier-mutation control lives here or anywhere in-app;
            changing tier remains a service_role-only operator action
            (set_club_tier_for_operator, reachable only via
            scripts/grant-club-entitlement.mjs). This is purely a clarity
            aid so an Admin isn't left guessing why, e.g., Court Time
            Payments requires Connected above.
            Phase 34G-B (readability correction) — plan pills say
            "Staff-Managed Plan"/"Connected Plan" (never bare "Connected"),
            explicitly naming them as plans so neither can be mistaken for
            infrastructure/status terminology (see StripeConnectSection's
            own "Stripe ready" badge, deliberately never "Connected"
            either). Staff-Managed uses neutral slate/gray styling — it is
            a legitimate paid product, never styled as a warning/disabled
            state.
            Phase 34G-C3 (brand identity) — Connected Plan uses the
            dedicated Court Time brand-green identity via the shared
            .ct-brand-pill CSS class (globals.css) rather than the generic
            Tailwind green scale: this pill represents a Court Time
            commercial PRODUCT identity, not a status/readiness signal. */}
        <section className="space-y-4">
          <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Plan & Access</h2>

          <div className="space-y-2">
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
          </div>
        </section>

      </div>
    </>
  );
}
