import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import { hasAdminAuthority } from "@/lib/auth/roles";
import Header from "@/components/Header";
import PageTabs from "@/components/PageTabs";
import AnnouncementsSection from "./AnnouncementsSection";
import CommunicationsActivitySection, { type AnnouncementBatch } from "./CommunicationsActivitySection";
import DeliveryDiagnosticsSection from "./DeliveryDiagnosticsSection";

// Admin IA Checkpoint 4 — Communications. One coherent Admin communications
// workspace at /admin/communications, replacing the two Settings sections
// (Member Announcements, Delivery diagnostics) this page absorbs. Tab state
// is a plain ?tab= query param resolved server-side — the same Link +
// searchParams pattern already established for /admin/courts and
// /admin/lessons (not client useState: that pattern doesn't sync to the
// URL, so it can't satisfy "refresh preserves the selected tab" or "direct
// URL to each tab works"). An unrecognized or missing tab value falls back
// to "compose", the same fail-safe-to-default shape resolveCourtsTab/
// resolveLessonsTab already use.
//
// The ENTIRE page is Admin-only — hasAdminAuthority mirrors the exact gate
// /admin/settings, /admin/courts, and /admin/audit-log already use. This is
// UI-level defense in depth only: the real authorization boundaries are
// send_announcement_v2 (role <> 'admin' -> insufficient_role),
// get_communications_activity/get_announcement_batch_delivery_context
// (both fail closed to zero rows for a non-admin caller), and
// notification_deliveries' admin-only RLS — none of which this page gate
// substitutes for.
type CommunicationsTab = "compose" | "activity" | "diagnostics";

function resolveCommunicationsTab(raw: string | undefined): CommunicationsTab {
  if (raw === "activity") return "activity";
  if (raw === "diagnostics") return "diagnostics";
  return "compose";
}

export default async function AdminCommunicationsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  const profile = await getAuthProfile();
  if (!hasAdminAuthority(profile?.role)) redirect("/calendar");

  const sp = await searchParams;
  const tab = resolveCommunicationsTab(sp.tab);

  const supabase = await createClient();
  const clubId = profile?.club_id ?? "";

  const since48h = new Date(Date.now() - 48 * 3600_000).toISOString();

  const [activityResult, failureCountResult, failureDetailsResult] = await Promise.all([
    supabase.rpc("get_communications_activity", { p_limit: 20, p_offset: 0 }),
    supabase
      .from("notification_deliveries")
      .select("id", { count: "exact", head: true })
      .eq("club_id", clubId)
      .eq("status", "failed")
      .gte("created_at", since48h),
    supabase
      .from("notification_deliveries")
      .select("channel, created_at")
      .eq("club_id", clubId)
      .eq("status", "failed")
      .gte("created_at", since48h)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  const batches: AnnouncementBatch[] = (activityResult.data ?? []).map(row => ({
    batchId:         row.batch_id,
    title:           row.title,
    sentAt:          row.sent_at,
    recipientCount:  row.recipient_count,
    emailSentCount:  row.email_sent_count,
    emailFailedCount: row.email_failed_count,
  }));

  const failuresUnavailable = !!(failureCountResult.error || failureDetailsResult.error);
  const failureCount        = failureCountResult.count ?? 0;
  const failureDetails      = (failureDetailsResult.data ?? []) as Array<{ channel: string; created_at: string }>;

  const smsConfigured =
    !!process.env.TWILIO_ACCOUNT_SID && !!process.env.TWILIO_AUTH_TOKEN && !!process.env.TWILIO_FROM_NUMBER;
  const emailConfigured = !!process.env.RESEND_API_KEY;

  const tabLinks: { key: CommunicationsTab; label: string; href: string }[] = [
    { key: "compose",     label: "Compose",     href: "/admin/communications" },
    { key: "activity",    label: "Activity",    href: "/admin/communications?tab=activity" },
    { key: "diagnostics", label: "Diagnostics", href: "/admin/communications?tab=diagnostics" },
  ];

  return (
    <>
      <Header screenTitle="Communications" />
      <div className="px-4 py-6 space-y-4 md:max-w-2xl md:mx-auto dark:text-gray-100">

        {/* ── Tab strip ── the shared PageTabs component (src/components/
            PageTabs.tsx), Court Time's one canonical page-level tab-strip
            treatment — same Link + searchParams pattern as /admin/courts
            and /admin/lessons. */}
        <PageTabs
          items={tabLinks.map(t => ({ key: t.key, label: t.label, href: t.href, active: tab === t.key }))}
        />

        {tab === "compose" && (
          <section className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Compose
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Send a one-time announcement to your club.
            </p>
            <AnnouncementsSection />
          </section>
        )}

        {tab === "activity" && (
          <section className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Activity
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Announcements sent to your club, newest first.
            </p>
            <CommunicationsActivitySection batches={batches} />
          </section>
        )}

        {tab === "diagnostics" && (
          <section className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Diagnostics
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Provider status, delivery failures, and a test message tool.
            </p>
            <DeliveryDiagnosticsSection
              emailConfigured={emailConfigured}
              smsConfigured={smsConfigured}
              failureCount={failureCount}
              failureDetails={failureDetails}
              failuresUnavailable={failuresUnavailable}
            />
          </section>
        )}

      </div>
    </>
  );
}
