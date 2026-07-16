import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
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
import type { AdminEventRow } from "@/app/(app)/admin/events/actions";

// ─── Server actions ───────────────────────────────────────────────────────────

async function joinEventAction(formData: FormData) {
  "use server";
  const eventId = formData.get("event_id") as string | null;
  if (!eventId) return;
  await dispatchJoinEvent(eventId);
  revalidatePath("/events");
}

async function leaveEventAction(formData: FormData) {
  "use server";
  const eventId = formData.get("event_id") as string | null;
  if (!eventId) return;
  await dispatchLeaveEvent(eventId);
  revalidatePath("/events");
}

async function acceptWaitlistOfferAction(formData: FormData) {
  "use server";
  const eventId = formData.get("event_id") as string | null;
  if (!eventId) return;
  await dispatchAcceptWaitlistOffer(eventId);
  revalidatePath("/events");
}

async function declineWaitlistOfferAction(formData: FormData) {
  "use server";
  const eventId = formData.get("event_id") as string | null;
  if (!eventId) return;
  await dispatchDeclineWaitlistOffer(eventId);
  revalidatePath("/events");
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function EventsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");

  const { data: profile } = await supabase
    .from("profiles")
    .select("club_id, role")
    .eq("id", user.id)
    .single();

  const clubId         = profile?.club_id ?? "";
  const isAdminOrPro   = profile?.role === "admin" || profile?.role === "pro";
  const now            = new Date().toISOString();

  // Parallel fetches: timezone + upcoming events + admin-only data (courts, all events)
  const [clubResult, eventsResult, adminEventsResult, adminCourtsResult] = await Promise.all([
    clubId
      ? supabase.from("clubs").select("timezone").eq("id", clubId).single()
      : Promise.resolve({ data: null }),
    supabase
      .from("events")
      .select(`
        id, title, starts_at, ends_at, capacity, status, created_by,
        event_types(key, label, color),
        event_participants(profile_id, role, status, offer_expires_at),
        event_guests(id),
        reservations(court_id, reason, status)
      `)
      .eq("club_id", clubId)
      .eq("status", "scheduled")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .eq("member_joinable" as any, true)
      .gte("starts_at", now)
      .is("archived_at", null)
      .order("starts_at", { ascending: true }),
    // Admin/pro: all events (past + future) for the Manage tab; excludes archived by default
    isAdminOrPro
      ? supabase
          .from("events")
          .select(`
            id, title, starts_at, ends_at, capacity, status, created_by, member_joinable, archived_at, archived_by,
            event_types(key, label, color),
            event_participants(profile_id, role, status),
            event_guests(id)
          `)
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
  ]);

  const clubTimezone = clubResult.data?.timezone ?? "America/New_York";
  const events       = (eventsResult.data ?? []) as unknown as UpcomingEventData[];
  const adminEvents  = (adminEventsResult.data ?? []) as unknown as AdminEventRow[];
  const adminCourts  = adminCourtsResult.data ?? [];

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
      userId={user.id}
      userRole={profile?.role}
      clubTimezone={clubTimezone}
      courtNames={courtNames}
      joinEventAction={joinEventAction}
      leaveEventAction={leaveEventAction}
      acceptWaitlistOfferAction={acceptWaitlistOfferAction}
      declineWaitlistOfferAction={declineWaitlistOfferAction}
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
                <AdminEventsClient
                  initialEvents={adminEvents}
                  hasMore={adminEvents.length === 25}
                  clubTimezone={clubTimezone}
                  userRole={profile!.role}
                  userId={user.id}
                  courts={adminCourts as { id: string; name: string; display_order: number }[]}
                  clubId={clubId}
                  showCreateButton={false}
                />
              }
              courts={adminCourts as { id: string; name: string; display_order: number }[]}
              clubId={clubId}
              clubTimezone={clubTimezone}
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
