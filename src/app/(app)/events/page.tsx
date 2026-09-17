import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import Header from "@/components/Header";
import {
  joinEvent as dispatchJoinEvent,
  leaveEvent as dispatchLeaveEvent,
  acceptWaitlistOffer as dispatchAcceptWaitlistOffer,
  declineWaitlistOffer as dispatchDeclineWaitlistOffer,
} from "@/app/(app)/calendar/actions";
import EventsUpcomingClient, { type UpcomingEventData } from "./EventsUpcomingClient";
import EventsAdminShell from "./EventsAdminShell";
import AdminEventsClient from "@/app/(app)/admin/events/AdminEventsClient";
import EventTypesSection from "@/app/(app)/admin/events/EventTypesSection";
import ManageSubview from "./ManageSubview";
import ProgramsManageClient from "./ProgramsManageClient";
import { getPrograms, type ProgramListRow } from "./programsActions";
import { getMemberPrograms, type MemberProgramCard } from "./programEnrollmentActions";
import type { AdminEventRow } from "@/app/(app)/admin/events/actions";
import { ADMIN_EVENT_SELECT, mapAdminEventRow, type RawAdminEventRow } from "@/app/(app)/admin/events/adminEventRow";
import { canAccessOperationsWorkspace } from "@/lib/auth/roles";

// ─── Server actions ───────────────────────────────────────────────────────────

// Phase 26F1: each action is bound with the club id the page was rendered
// for (see `.bind(null, clubId)` at the call sites below) so the stale-club
// guard in the underlying calendar action has an expectedClubId to check,
// without EventsUpcomingClient needing to know about club context at all.
async function joinEventAction(clubId: string, formData: FormData) {
  "use server";
  const eventId = formData.get("event_id") as string | null;
  if (!eventId) return;
  await dispatchJoinEvent(eventId, clubId);
  revalidatePath("/events");
}

async function leaveEventAction(clubId: string, formData: FormData) {
  "use server";
  const eventId = formData.get("event_id") as string | null;
  if (!eventId) return;
  await dispatchLeaveEvent(eventId, clubId);
  revalidatePath("/events");
}

async function acceptWaitlistOfferAction(clubId: string, formData: FormData) {
  "use server";
  const eventId = formData.get("event_id") as string | null;
  if (!eventId) return;
  await dispatchAcceptWaitlistOffer(eventId, clubId);
  revalidatePath("/events");
}

async function declineWaitlistOfferAction(clubId: string, formData: FormData) {
  "use server";
  const eventId = formData.get("event_id") as string | null;
  if (!eventId) return;
  await dispatchDeclineWaitlistOffer(eventId, clubId);
  revalidatePath("/events");
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; checkout?: string; program?: string }>;
}) {
  // Phase 27C.2: ?manageView and ?q (the Programs "View Sessions" link's
  // URL contract) are no longer parsed here — ManageSubview and
  // AdminEventsClient each read them directly via useSearchParams(), a
  // live client-side subscription to the current URL that doesn't depend
  // on this Server Component's props reliably propagating down through
  // already-mounted client-component layers on a same-route navigation.
  // See both components for the full rationale.
  const sp = await searchParams;
  // Admin UX Checkpoint 3: the "eventTypes" branch is resolved further down,
  // once profile.role is known — an admin-only tab value must never resolve
  // for a non-admin caller (that tab literally isn't rendered for them; see
  // EventsAdminShell), so this can't be decided from sp.tab alone the way
  // the other three values already are.
  const initialTabFromUrl = sp.tab === "manage" ? "manage" : "upcoming";

  // Phase 34F-C, generalized in Phase 36C: optional ?program=<uuid> — no
  // longer requires checkout=success, mirroring /calendar's reservation/
  // event deep-link params (Phase 36B/36C) exactly. ProgramEnrollmentCard's
  // own fetchPaymentStates effect (already fresh on this hard-navigation
  // page load) shows authoritative, freshly-fetched payment state
  // regardless of this param's presence — this never mutates any
  // financial state itself. Used by EventsUpcomingClient both to strip
  // the one-time query string from the URL bar and, as of Phase 36C, to
  // scroll the matching ProgramEnrollmentCard into view (waitlist_offer
  // notification deep links land here when the offer is for a
  // whole-Program enrollment rather than a single Event occurrence — see
  // src/lib/notification-targets.ts's own comment on why that kind is
  // polymorphic).
  const programParam = typeof sp.program === "string" ? sp.program : null;
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const initialProgramId =
    programParam && uuidRe.test(programParam) ? programParam : null;

  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  const profile      = await getAuthProfile();
  const supabase     = await createClient();

  const clubId         = profile?.club_id ?? "";
  // Phase 34A: admin+pro+staff (canAccessOperationsWorkspace) — Staff now
  // reaches the same Manage-tab operational shell Admin/Pro already have.
  const isAdminOrPro   = canAccessOperationsWorkspace(profile?.role);
  // Phase 27D2 correction: whole-program enrollment (Join/Leave/Accept/Pass)
  // is a member-only surface — admins, pros, and staff keep their existing
  // Upcoming experience unchanged. current_user_role()'s four-value
  // vocabulary ('member' | 'pro' | 'staff' | 'admin', see 0131) means this
  // is still the exact complement of isAdminOrPro, but is spelled out
  // explicitly (rather than reusing !isAdminOrPro) so both the fetch guard
  // below and the render guard passed to EventsUpcomingClient say plainly
  // what they're gating on.
  const isMember       = profile?.role === "member";
  const isAdmin        = profile?.role === "admin";
  // Fails safe to the URL-only resolution (which never includes
  // "eventTypes") whenever the caller isn't Admin — a Staff/Pro/Member who
  // navigates to (or bookmarks) ?tab=eventTypes lands on Upcoming instead
  // of a blank page with no matching panel.
  const initialTab = sp.tab === "eventTypes" && isAdmin ? "eventTypes" : initialTabFromUrl;
  const now            = new Date().toISOString();

  // Parallel fetches: timezone + upcoming events + member programs + admin-only data (courts, all events, programs)
  const [clubResult, settingsResult, eventsResult, memberProgramsResult, adminEventsResult, adminCourtsResult, programsResult, eventTypesResult] = await Promise.all([
    clubId
      ? supabase.from("clubs").select("timezone").eq("id", clubId).single()
      : Promise.resolve({ data: null }),
    clubId
      ? supabase.from("club_settings").select("currency").eq("club_id", clubId).single()
      : Promise.resolve({ data: null }),
    supabase
      .from("events")
      .select(`
        id, title, starts_at, ends_at, capacity, status, created_by, member_joinable, price_amount_cents,
        event_types(key, label, color),
        event_participants(profile_id, role, status, offer_expires_at),
        event_guests(id, status),
        reservations(court_id, reason, status),
        programs(enrollment_model)
      `)
      .eq("club_id", clubId)
      .eq("status", "scheduled")
      .gte("starts_at", now)
      .is("archived_at", null)
      .order("starts_at", { ascending: true }),
    // Phase 27D2 correction: whole-program offerings for the Upcoming tab's
    // Programs section — member-only. Only fetched when the caller is a
    // plain member, so admins/pros never pay for this query.
    clubId && isMember ? getMemberPrograms(clubId, user.id) : Promise.resolve({ programs: [] as MemberProgramCard[] }),
    // Admin/pro: all events (past + future) for the Manage tab; excludes archived by default.
    // Selects the same ADMIN_EVENT_SELECT columns as fetchMoreAdminEvents'
    // reload query (Phase 30C2 fix) so both the initial page load and every
    // subsequent Load More/View-change reload provide the complete
    // editable-event shape EditEventSheet needs — previously this query was
    // missing event_type_id/description/updated_at/program_id/
    // is_program_exception/reservations entirely.
    isAdminOrPro
      ? supabase
          .from("events")
          .select(ADMIN_EVENT_SELECT)
          .eq("club_id", clubId)
          .is("archived_at", null)
          .order("starts_at", { ascending: false })
          .range(0, 24)
      : Promise.resolve({ data: null }),
    // Admin/pro: active courts for CreateEventSheet
    isAdminOrPro
      ? supabase
          .from("courts")
          .select("id, name, display_order")
          .eq("club_id", clubId)
          .eq("is_active", true)
          .order("display_order")
      : Promise.resolve({ data: null }),
    // Pro/admin: Programs list for the Manage → Programs sub-tab
    isAdminOrPro
      ? getPrograms(clubId)
      : Promise.resolve({ programs: [] as ProgramListRow[] }),
    // Admin UX Checkpoint 3 — Events IA: Event Types configuration data,
    // Admin-only (not isAdminOrPro — Staff/Pro never fetch or receive this,
    // matching the identical admin-only gate on the "eventTypes" tab prop
    // passed to EventsAdminShell below). The RPC/table-level authorization
    // in eventTypesActions.ts is the real boundary; this fetch gate is
    // defense-in-depth so Staff/Pro's page load never even carries this
    // data over the wire.
    isAdmin
      ? supabase
          .from("event_types")
          .select("id, key, label, color, is_active, default_price_amount_cents")
          .eq("club_id", clubId)
          .order("is_active", { ascending: false })
          .order("label")
      : Promise.resolve({ data: null }),
  ]);

  const clubTimezone  = clubResult.data?.timezone ?? "America/New_York";
  const currency      = settingsResult.data?.currency ?? "USD";
  // Phase 27D2: the DB-level member_joinable filter was removed from the
  // events query above (see its comment) because every generated session
  // under a whole-program offering has member_joinable=false and must
  // still appear in Upcoming — just without per-session join controls
  // (handled in EventsUpcomingClient via the embedded `programs` field).
  // Filter here instead: keep an event if it's ordinarily member-joinable,
  // OR if it's a generated session of a whole-program ('program'
  // enrollment_model) offering. admin_managed sessions (also
  // member_joinable=false, enrollment_model≠'program') are correctly
  // excluded, unchanged from prior behavior.
  const rawEvents = (eventsResult.data ?? []) as unknown as Array<UpcomingEventData & { member_joinable: boolean }>;
  const events = rawEvents.filter(ev => ev.member_joinable || ev.programs?.enrollment_model === "program");
  const adminEventsRaw = (adminEventsResult.data ?? []) as unknown as RawAdminEventRow[];
  const adminEvents: AdminEventRow[] = adminEventsRaw.map(mapAdminEventRow);
  const adminCourts   = adminCourtsResult.data ?? [];
  const programs      = "programs" in programsResult ? programsResult.programs : [];
  const programsError = "error" in programsResult ? programsResult.error : undefined;
  const memberPrograms      = "programs" in memberProgramsResult ? memberProgramsResult.programs : [];
  const memberProgramsError = "error" in memberProgramsResult ? memberProgramsResult.error : undefined;
  const eventTypes = (eventTypesResult.data ?? []) as {
    id: string; key: string; label: string; color: string; is_active: boolean;
    default_price_amount_cents: number | null;
  }[];

  // ── Batch-fetch court names for reservation display in EventsUpcomingClient ──
  const allCourtIds = [...new Set(
    events.flatMap(ev =>
      ev.reservations
        .filter(r => r.reason === "event" && r.status === "confirmed")
        .map(r => r.court_id)
    )
  )];

  const { data: courts } = allCourtIds.length
    ? await supabase.from("courts").select("id, name").in("id", allCourtIds)
    : { data: [] };
  const courtNames = (courts ?? []).map(c => ({ id: c.id, name: c.name }));

  // ─── Upcoming tab content — shared by admin Upcoming tab and member view ──
  const upcomingContent = (
    <EventsUpcomingClient
      events={events}
      isMember={isMember}
      memberSelfService={profile?.memberSelfService ?? true}
      programs={memberPrograms}
      programsError={memberProgramsError}
      userId={user.id}
      userRole={profile?.role}
      clubId={clubId}
      clubTimezone={clubTimezone}
      currency={currency}
      courtNames={courtNames}
      joinEventAction={joinEventAction.bind(null, clubId)}
      leaveEventAction={leaveEventAction.bind(null, clubId)}
      acceptWaitlistOfferAction={acceptWaitlistOfferAction.bind(null, clubId)}
      declineWaitlistOfferAction={declineWaitlistOfferAction.bind(null, clubId)}
      initialProgramId={initialProgramId}
    />
  );

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      <Header screenTitle="Events" />

      <div
        className="overflow-y-auto"
        style={{ height: "var(--page-fill-height)" }}
      >
        <div className="md:max-w-2xl md:mx-auto">
          {isAdminOrPro ? (
            /* Admin/pro: unified shell with tabs + single Create Event button */
            <EventsAdminShell
              upcoming={upcomingContent}
              manage={
                <ManageSubview
                  eventsPanel={
                    <AdminEventsClient
                      initialEvents={adminEvents}
                      hasMore={adminEvents.length === 25}
                      clubTimezone={clubTimezone}
                      userRole={profile!.role!}
                      userId={user.id}
                      courts={adminCourts as { id: string; name: string; display_order: number }[]}
                      clubId={clubId}
                      currency={currency}
                      showCreateButton={false}
                    />
                  }
                  programsPanel={
                    <ProgramsManageClient
                      initialPrograms={programs}
                      initialError={programsError}
                      courts={adminCourts as { id: string; name: string; display_order: number }[]}
                      clubId={clubId}
                      clubTimezone={clubTimezone}
                      userRole={profile!.role!}
                      userId={user.id}
                      currency={currency}
                    />
                  }
                />
              }
              eventTypes={
                isAdmin ? (
                  <div className="px-4 py-3 space-y-3">
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      Edit labels and colors. Deactivated types stay on historical events but are
                      hidden when creating new ones.
                    </p>
                    <EventTypesSection clubId={clubId} currency={currency} initialTypes={eventTypes} />
                  </div>
                ) : undefined
              }
              courts={adminCourts as { id: string; name: string; display_order: number }[]}
              clubId={clubId}
              clubTimezone={clubTimezone}
              currency={currency}
              isAdmin={profile!.role === "admin"}
              initialTab={initialTab as "upcoming" | "manage" | "eventTypes"}
            />
          ) : (
            /* Members: upcoming events list with search and type filter */
            upcomingContent
          )}
        </div>
      </div>
    </>
  );
}
