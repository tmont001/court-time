import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import Header from "@/components/Header";
import { getZonedDayBoundsUTC } from "@/lib/timezone";

// ── Types ─────────────────────────────────────────────────────────────────────

// Phase 33C2: profiles (via owner_user_id) is null for a staff-created
// no-account-Member booking (0108) — roster_members (via roster_member_id)
// is the fallback, always present for reason='member_booking' per 0108's
// identity-guard trigger.
type Reservation = {
  id:        string;
  starts_at: string;
  ends_at:   string;
  courts:         { name: string } | null;
  profiles:       { first_name: string | null; last_name: string | null } | null;
  roster_members: { first_name: string | null; last_name: string | null } | null;
};

type TodayEvent = {
  id:                 string;
  title:              string;
  starts_at:          string;
  capacity:           number;
  event_types:        { label: string; color: string } | null;
  event_participants: Array<{ status: string }>;
  event_guests:       Array<{ id: string }>;
};

type ActiveEvent = {
  id:       string;
  title:    string;
  starts_at: string;
};

type OfferedParticipant = {
  profile_id:       string;
  offer_expires_at: string;
  event_id:         string;
  profiles:         { first_name: string | null; last_name: string | null } | null;
};

type DeliveryFailure = {
  channel:    string;
  created_at: string;
};

// ── Display helpers ───────────────────────────────────────────────────────────

function memberName(p: { first_name: string | null; last_name: string | null } | null): string {
  if (!p) return "Unknown";
  return [p.first_name, p.last_name].filter(Boolean).join(" ") || "Unknown";
}

function formatTime(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true,
  });
}

/**
 * Forward-looking expiry formatter. Displays how long until an offer expires.
 * Requirements:
 * - Any remaining duration under 1 minute → "expires in 1 minute" (never "0 minutes")
 * - Minutes: Math.round, minimum 1
 * - Hours: Math.round for values < 24h, minimum 1
 * - Tomorrow detection uses the club timezone
 * - Dates > 24h away show an absolute date+time in the club timezone
 */
function formatOfferExpiry(iso: string, tz: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "expired";

  const totalMins = diff / 60_000;

  if (totalMins < 1) return "expires in 1 minute";

  if (totalMins < 60) {
    const mins = Math.max(1, Math.round(totalMins));
    return `expires in ${mins} minute${mins === 1 ? "" : "s"}`;
  }

  const totalHours = diff / 3_600_000;
  if (totalHours < 24) {
    const hours = Math.max(1, Math.round(totalHours));
    return `expires in ${hours} hour${hours === 1 ? "" : "s"}`;
  }

  // More than 24h: show absolute time. Compare calendar dates in club timezone.
  const expiryDateStr   = new Date(iso).toLocaleDateString("en-CA", { timeZone: tz });
  // Derive tomorrow's date string in the club timezone (not by adding 86400s)
  const todayStr        = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const [ty, tm, td]    = todayStr.split("-").map(Number);
  const tomorrowStr     = new Date(Date.UTC(ty, tm - 1, td + 1))
    .toISOString()
    .slice(0, 10);
  const timeStr = new Date(iso).toLocaleTimeString("en-US", {
    timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true,
  });

  if (expiryDateStr === tomorrowStr) return `expires tomorrow at ${timeStr}`;
  return `expires ${new Date(iso).toLocaleDateString("en-US", {
    timeZone: tz, month: "short", day: "numeric",
  })} at ${timeStr}`;
}

function formatRelativeAge(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return "< 1 hour ago";
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Layout components ─────────────────────────────────────────────────────────

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
      {children}
    </p>
  );
}

function EmptyState({ label }: { label: string }) {
  return <p className="text-sm text-gray-400 dark:text-gray-500 px-1">{label}</p>;
}

function SetupRow({
  label, done, href, optional = false,
}: {
  label: string; done: boolean; href: string; optional?: boolean;
}) {
  return (
    <Link href={href} className="px-4 py-2.5 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-800/50 motion-safe:transition-colors motion-safe:duration-100">
      <span className="text-sm text-gray-700 dark:text-gray-200">
        {label}
        {optional && (
          <span className="ml-1.5 text-xs text-gray-400 dark:text-gray-500">(optional)</span>
        )}
      </span>
      {done
        ? <span className="text-xs font-medium text-green-600 dark:text-green-400">Done</span>
        : <span className="text-xs font-medium text-amber-600 dark:text-amber-400">Set up →</span>}
    </Link>
  );
}

function UnavailableState() {
  return (
    <p className="text-sm text-orange-500 dark:text-orange-400 px-1">
      Data unavailable — try refreshing.
    </p>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function AdminOverviewPage() {
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  const profile  = await getAuthProfile();
  if (profile?.role !== "admin" && profile?.role !== "pro") redirect("/calendar");

  const supabase = await createClient();
  const clubId  = profile?.club_id ?? "";
  const isAdmin = profile?.role === "admin";

  const { data: club } = await supabase
    .from("clubs")
    .select("name, timezone")
    .eq("id", clubId)
    .single();

  const tz       = club?.timezone ?? "America/New_York";
  const clubName = (club?.name ?? "").trim();

  // ── Date boundaries (DST-safe) ────────────────────────────────────────────
  // getZonedDayBoundsUTC computes both midnight instants independently using
  // formatToParts. This is correct on spring-forward days (23h), fall-back
  // days (25h), and is independent of the server runtime timezone.
  const { start: startIso, nextDayStart: nextDayStartIso } = getZonedDayBoundsUTC(new Date(), tz);
  const now = new Date().toISOString();

  // ── Phase 1: parallel queries that don't require event IDs ────────────────
  const [
    reservationsResult,
    todayEventsResult,
    activeEventsResult,
    cancellationsResult,
    setupCourtsResult,
    setupEventTypesResult,
    setupMembersResult,
    setupOperatingHoursResult,
    setupStaffResult,
    setupRosterResult,
    setupInvitesResult,
  ] = await Promise.all([
    // Today's confirmed member-booking reservations.
    // profiles!owner_user_id disambiguates the three FK relationships on
    // reservations → profiles (owner_user_id, created_by, cancelled_by).
    // Phase 33C2: roster_members(first_name, last_name) added as the
    // display fallback for a staff-created no-account-Member booking,
    // where owner_user_id (and therefore the profiles embed) is null.
    supabase
      .from("reservations")
      .select("id, starts_at, ends_at, courts(name), profiles!owner_user_id(first_name, last_name), roster_members(first_name, last_name)")
      .eq("club_id", clubId)
      .eq("status", "confirmed")
      .eq("reason", "member_booking")
      .gte("starts_at", startIso)
      .lt("starts_at", nextDayStartIso)
      .order("starts_at", { ascending: true }),

    // Today's scheduled, non-archived events.
    supabase
      .from("events")
      .select("id, title, starts_at, capacity, event_types(label, color), event_participants(status), event_guests(id)")
      .eq("club_id", clubId)
      .eq("status", "scheduled")
      .is("archived_at", null)
      .gte("starts_at", startIso)
      .lt("starts_at", nextDayStartIso)
      .order("starts_at", { ascending: true }),

    // All scheduled, non-archived events in this club — needed to scope the
    // active-offers query (phase 2). We fetch title+starts_at here so phase 2
    // can look up event details without an additional join.
    // Explicit filters: club_id, status=scheduled, archived_at IS NULL.
    supabase
      .from("events")
      .select("id, title, starts_at")
      .eq("club_id", clubId)
      .eq("status", "scheduled")
      .is("archived_at", null),

    // Count of cancelled reservations in the last 7 days (count only).
    supabase
      .from("reservations")
      .select("id", { count: "exact", head: true })
      .eq("club_id", clubId)
      .eq("status", "cancelled")
      .gte("cancelled_at", new Date(Date.now() - 7 * 86_400_000).toISOString()),

    // Setup checklist: active courts (admin only).
    isAdmin
      ? supabase
          .from("courts")
          .select("id", { count: "exact", head: true })
          .eq("club_id", clubId)
          .eq("is_active", true)
      : Promise.resolve({ count: 0, error: null, data: null, status: 200, statusText: "OK" }),

    // Setup checklist: active event types (admin only).
    isAdmin
      ? supabase
          .from("event_types")
          .select("id", { count: "exact", head: true })
          .eq("club_id", clubId)
          .eq("is_active", true)
      : Promise.resolve({ count: 0, error: null, data: null, status: 200, statusText: "OK" }),

    // Setup checklist: active members excluding current user (admin only).
    isAdmin
      ? supabase
          .from("profiles")
          .select("id", { count: "exact", head: true })
          .eq("club_id", clubId)
          .eq("status", "active")
          .neq("id", user.id)
      : Promise.resolve({ count: 0, error: null, data: null, status: 200, statusText: "OK" }),

    // Setup checklist: operating hours with at least one open day (admin only).
    isAdmin
      ? supabase
          .from("operating_hours")
          .select("id", { count: "exact", head: true })
          .eq("club_id", clubId)
          .eq("is_closed", false)
      : Promise.resolve({ count: 0, error: null, data: null, status: 200, statusText: "OK" }),

    // Setup checklist: additional admin/pro users besides current user (admin only).
    isAdmin
      ? supabase
          .from("profiles")
          .select("id", { count: "exact", head: true })
          .eq("club_id", clubId)
          .eq("status", "active")
          .in("role", ["admin", "pro"])
          .neq("id", user.id)
      : Promise.resolve({ count: 0, error: null, data: null, status: 200, statusText: "OK" }),

    // Setup checklist: roster members (admin only — admin SELECT policy).
    isAdmin
      ? supabase
          .from("roster_members")
          .select("id", { count: "exact", head: true })
          .eq("club_id", clubId)
      : Promise.resolve({ count: 0, error: null, data: null, status: 200, statusText: "OK" }),

    // Setup checklist: active pending invites (admin only).
    isAdmin
      ? supabase
          .from("club_invites")
          .select("id", { count: "exact", head: true })
          .eq("club_id", clubId)
          .is("accepted_at", null)
          .is("revoked_at", null)
          .gt("expires_at", now)
      : Promise.resolve({ count: 0, error: null, data: null, status: 200, statusText: "OK" }),
  ]);

  const todayReservations    = (reservationsResult.data  ?? []) as unknown as Reservation[];
  const todayEvents          = (todayEventsResult.data   ?? []) as unknown as TodayEvent[];
  const activeEvents         = (activeEventsResult.data  ?? []) as unknown as ActiveEvent[];
  const cancellationCount    = cancellationsResult.count ?? 0;
  const activeCourtsCount    = setupCourtsResult.count   ?? 0;
  const activeTypesCount     = setupEventTypesResult.count ?? 0;
  const activeMembersCount   = setupMembersResult.count  ?? 0;
  const operatingHoursCount  = setupOperatingHoursResult.count ?? 0;
  const additionalStaffCount = setupStaffResult.count    ?? 0;
  const rosterMemberCount    = setupRosterResult.count   ?? 0;
  const activeInviteCount    = setupInvitesResult.count  ?? 0;

  // Build a lookup map for event metadata (used to attach titles to offers).
  const activeEventsById = new Map(activeEvents.map(e => [e.id, e]));
  const activeEventIds   = activeEvents.map(e => e.id);

  // ── Phase 2: active-offers query + admin delivery queries (parallel) ───────
  //
  // Active-offers uses a two-step approach instead of nested PostgREST filters:
  //   Step 1 (phase 1): fetched scheduled, non-archived club event IDs above.
  //   Step 2 (here):    query event_participants scoped to those exact event IDs.
  //
  // This makes all four required filters explicit at the query level:
  //   - club_id:       via events.club_id = clubId (enforced in phase 1)
  //   - status:        via events.status = 'scheduled' (phase 1)
  //   - archived_at:   via events.archived_at IS NULL (phase 1)
  //   - event_id IN:   via .in("event_id", activeEventIds) (phase 2)
  //   - offered:       via .eq("status", "offered")
  //   - not expired:   via .gt("offer_expires_at", now)
  //
  // An offer attached to a cancelled, archived, or other-club event cannot
  // appear because its event_id will not be in activeEventIds.

  const offersPromise = activeEventIds.length > 0
    ? supabase
        .from("event_participants")
        .select("profile_id, offer_expires_at, event_id, profiles(first_name, last_name)")
        .in("event_id", activeEventIds)
        .eq("status", "offered")
        .gt("offer_expires_at", now)
        .order("offer_expires_at", { ascending: true })
    : Promise.resolve({ data: [] as OfferedParticipant[], error: null, count: null, status: 200, statusText: "OK" });

  // Delivery failure queries: admin-only.
  // notification_deliveries SELECT policy is admin-only (role = 'admin').
  // Running these for pro users would always return 0 rows and give a false
  // "no failures" impression, so the system status section is skipped for pros.
  const since48h = new Date(Date.now() - 48 * 3600_000).toISOString();
  const failureCountPromise = isAdmin
    ? supabase
        .from("notification_deliveries")
        .select("id", { count: "exact", head: true })
        .eq("club_id", clubId)
        .eq("status", "failed")
        .gte("created_at", since48h)
    : Promise.resolve({ count: 0, error: null, data: null, status: 200, statusText: "OK" });

  const failureDetailsPromise = isAdmin
    ? supabase
        .from("notification_deliveries")
        .select("channel, created_at")
        .eq("club_id", clubId)
        .eq("status", "failed")
        .gte("created_at", since48h)
        .order("created_at", { ascending: false })
        .limit(10)
    : Promise.resolve({ data: [] as DeliveryFailure[], error: null, count: null, status: 200, statusText: "OK" });

  const [offersResult, failureCountResult, failureDetailsResult] = await Promise.all([
    offersPromise,
    failureCountPromise,
    failureDetailsPromise,
  ]);

  const rawOffers      = (offersResult.data ?? []) as unknown as OfferedParticipant[];
  const failureCount   = failureCountResult.count ?? 0;
  const failureDetails = (failureDetailsResult.data ?? []) as DeliveryFailure[];

  // Attach event title/starts_at to each offer using the phase-1 lookup map.
  const activeOffers = rawOffers.map(o => ({
    ...o,
    event: activeEventsById.get(o.event_id) ?? null,
  }));

  // ── Section failure tracking ───────────────────────────────────────────────
  const sectionFailed = {
    reservations:  !!reservationsResult.error,
    events:        !!todayEventsResult.error,
    activeEvents:  !!activeEventsResult.error,
    offers:        !!offersResult.error,
    cancellations: !!cancellationsResult.error,
    deliveries:    !!(failureCountResult.error || failureDetailsResult.error),
  };

  const anyFailed = Object.values(sectionFailed).some(Boolean);

  // Integration status — env-var presence only; values never sent to client.
  const smsConfigured   = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);
  const emailConfigured = !!process.env.RESEND_API_KEY;

  return (
    <>
      <Header screenTitle="Overview" />

      <div className="overflow-y-auto" style={{ height: "var(--page-fill-height)" }}>
        <div className="md:max-w-2xl md:mx-auto px-4 pt-3 pb-8 space-y-6">

          <Link
            href="/profile"
            className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-accent motion-safe:transition-colors motion-safe:duration-150"
          >
            ← Back to Account
          </Link>

          {/* Warning banner — shown only when one or more queries failed */}
          {anyFailed && (
            <div className="rounded-xl border border-orange-200 dark:border-orange-800 bg-orange-50 dark:bg-orange-950/30 px-4 py-3">
              <p className="text-sm text-orange-700 dark:text-orange-300">
                Some data could not be loaded. The affected sections show &ldquo;Data
                unavailable.&rdquo; This is usually temporary — try refreshing the page.
              </p>
            </div>
          )}

          {/* ── Setup checklist (admin only) ──────────────────────────────── */}
          {isAdmin && (
            <section>
              <SectionHeading>Setup checklist</SectionHeading>
              <div className="ct-card divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden">
                <SetupRow label="Club name"           done={clubName.length > 0}        href="/admin/settings" />
                <SetupRow label="Timezone"            done={!!club?.timezone}            href="/admin/settings" />
                <SetupRow label="Active court"        done={activeCourtsCount > 0}      href="/admin/courts" />
                <SetupRow label="Operating hours"     done={operatingHoursCount > 0}    href="/admin/settings" />
                <SetupRow label="Active event type"   done={activeTypesCount > 0}       href="/admin/settings" />
                <SetupRow label="Additional admin or pro" done={additionalStaffCount > 0} href="/admin/members" />
                <SetupRow
                  label="Members"
                  done={activeMembersCount > 0 || rosterMemberCount > 0 || activeInviteCount > 0}
                  href="/admin/members"
                />
                <SetupRow label="Email delivery"      done={emailConfigured}            href="/admin/settings" optional />
                <SetupRow label="SMS delivery"        done={smsConfigured}              href="/admin/settings" optional />
              </div>
            </section>
          )}

          {/* ── System status (admin only) ──────────────────────────────────────
              notification_deliveries SELECT is admin-only per RLS. Showing this
              section to pro users would always display 0 failures (no rows
              returned by RLS), which is misleading. Env-var status is also only
              meaningful to admins who manage system configuration. ──────────── */}
          {isAdmin && (
            <section>
              <SectionHeading>System status</SectionHeading>
              <div className="ct-card divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden">
                <div className="px-4 py-2.5 flex items-center justify-between">
                  <span className="text-sm text-gray-700 dark:text-gray-200">SMS</span>
                  {smsConfigured
                    ? <span className="text-xs font-medium text-green-600 dark:text-green-400">Configured</span>
                    : <span className="text-xs text-gray-400 dark:text-gray-500">Not configured</span>}
                </div>
                <div className="px-4 py-2.5 flex items-center justify-between">
                  <span className="text-sm text-gray-700 dark:text-gray-200">Email</span>
                  {emailConfigured
                    ? <span className="text-xs font-medium text-green-600 dark:text-green-400">Configured</span>
                    : <span className="text-xs text-gray-400 dark:text-gray-500">Not configured</span>}
                </div>
                <div className="px-4 py-2.5 flex items-center justify-between">
                  <span className="text-sm text-gray-700 dark:text-gray-200">Delivery failures (48 h)</span>
                  {sectionFailed.deliveries
                    ? <span className="text-xs text-orange-500">Unavailable</span>
                    : failureCount === 0
                      ? <span className="text-xs font-medium text-green-600 dark:text-green-400">None</span>
                      : <span className="text-xs font-semibold text-red-600 dark:text-red-400">{failureCount}</span>}
                </div>
              </div>

              {!sectionFailed.deliveries && failureDetails.length > 0 && (
                <div className="mt-2 space-y-1">
                  {failureDetails.map((f, i) => (
                    <div
                      key={i}
                      className="ct-card px-3 py-2 flex items-center justify-between text-xs text-red-600 dark:text-red-400"
                    >
                      <span className="font-medium uppercase">{f.channel}</span>
                      <span className="text-gray-400 dark:text-gray-500">{formatRelativeAge(f.created_at)}</span>
                    </div>
                  ))}
                  {failureCount > failureDetails.length && (
                    <p className="text-xs text-gray-400 dark:text-gray-500 px-1">
                      … and {failureCount - failureDetails.length} more. Review notification delivery logs for details.
                    </p>
                  )}
                </div>
              )}
            </section>
          )}

          {/* ── Today's court reservations ─────────────────────────────────── */}
          <section>
            <SectionHeading>
              Today&apos;s court reservations
              {!sectionFailed.reservations && ` (${todayReservations.length})`}
            </SectionHeading>
            {sectionFailed.reservations ? (
              <UnavailableState />
            ) : todayReservations.length === 0 ? (
              <EmptyState label="No reservations today." />
            ) : (
              <div className="space-y-2">
                {todayReservations.map(r => (
                  <div key={r.id} className="ct-card px-4 py-2.5">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {/* Phase 33C2: r.profiles is null for a staff-created
                          no-account-Member booking — fall back to
                          r.roster_members (the durable Member identity,
                          always present for reason='member_booking'). */}
                      {memberName(r.profiles ?? r.roster_members)}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {r.courts?.name ?? "Court"} · {formatTime(r.starts_at, tz)} – {formatTime(r.ends_at, tz)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── Today's events ─────────────────────────────────────────────── */}
          <section>
            <SectionHeading>
              Today&apos;s events
              {!sectionFailed.events && ` (${todayEvents.length})`}
            </SectionHeading>
            {sectionFailed.events ? (
              <UnavailableState />
            ) : todayEvents.length === 0 ? (
              <EmptyState label="No events today." />
            ) : (
              <div className="space-y-2">
                {todayEvents.map(ev => {
                  const confirmed  = ev.event_participants.filter(p => p.status === "confirmed").length;
                  const waitlisted = ev.event_participants.filter(p => p.status === "waitlisted").length;
                  const offered    = ev.event_participants.filter(p => p.status === "offered").length;
                  const guests     = ev.event_guests.length;
                  const occupied   = confirmed + offered + guests;
                  return (
                    <div key={ev.id} className="ct-card px-4 py-2.5 flex items-center justify-between">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 mb-0.5">
                          {ev.event_types && (
                            <span
                              className="inline-block rounded-full w-2 h-2 shrink-0"
                              style={{ background: ev.event_types.color }}
                            />
                          )}
                          <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                            {ev.title}
                          </p>
                        </div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {formatTime(ev.starts_at, tz)} · {occupied}/{ev.capacity} filled
                          {waitlisted > 0 && ` · ${waitlisted} waitlisted`}
                          {offered    > 0 && ` · ${offered} offered`}
                        </p>
                      </div>
                      <Link
                        href="/events?tab=manage"
                        className="text-xs text-accent hover:underline shrink-0 ml-3"
                      >
                        Manage
                      </Link>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* ── Active waitlist offers ─────────────────────────────────────── */}
          <section>
            <SectionHeading>
              Active waitlist offers
              {!sectionFailed.offers && !sectionFailed.activeEvents && ` (${activeOffers.length})`}
            </SectionHeading>
            {sectionFailed.offers || sectionFailed.activeEvents ? (
              <UnavailableState />
            ) : activeOffers.length === 0 ? (
              <EmptyState label="No pending offers." />
            ) : (
              <div className="space-y-2">
                {activeOffers.map((o, i) => (
                  <div key={i} className="ct-card px-4 py-2.5 flex items-center justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                        {memberName(o.profiles)}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                        {o.event?.title ?? "Event"} · {formatOfferExpiry(o.offer_expires_at, tz)}
                      </p>
                    </div>
                    <Link
                      href="/events?tab=manage"
                      className="text-xs text-accent hover:underline shrink-0 ml-3"
                    >
                      Roster
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── Recent activity ────────────────────────────────────────────── */}
          <section>
            <SectionHeading>Recent activity</SectionHeading>
            <div className="ct-card divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden">
              <div className="px-4 py-2.5 flex items-center justify-between">
                <span className="text-sm text-gray-700 dark:text-gray-200">
                  Reservation cancellations (7 days)
                </span>
                {sectionFailed.cancellations
                  ? <span className="text-xs text-orange-500">Unavailable</span>
                  : <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{cancellationCount}</span>}
              </div>
            </div>
          </section>

          {/* ── Quick links ────────────────────────────────────────────────── */}
          <section>
            <SectionHeading>Manage</SectionHeading>
            <div className="ct-card divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden">
              <Link href="/events?tab=manage" className="ct-row-interactive">
                Events
                <span className="text-gray-400 dark:text-gray-500">›</span>
              </Link>
              <Link href="/admin/lessons" className="ct-row-interactive">
                Lesson Requests
                <span className="text-gray-400 dark:text-gray-500">›</span>
              </Link>
              {isAdmin && (
                <>
                  <Link href="/admin/members" className="ct-row-interactive">
                    Members
                    <span className="text-gray-400 dark:text-gray-500">›</span>
                  </Link>
                  <Link href="/admin/courts" className="ct-row-interactive">
                    Courts
                    <span className="text-gray-400 dark:text-gray-500">›</span>
                  </Link>
                  <Link href="/admin/settings" className="ct-row-interactive">
                    Settings
                    <span className="text-gray-400 dark:text-gray-500">›</span>
                  </Link>
                  <Link href="/admin/audit-log" className="ct-row-interactive">
                    Audit Log
                    <span className="text-gray-400 dark:text-gray-500">›</span>
                  </Link>
                </>
              )}
            </div>
          </section>

        </div>
      </div>
    </>
  );
}
