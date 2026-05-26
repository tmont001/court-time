import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import Header from "@/components/Header";
import { joinEvent as dispatchJoinEvent, leaveEvent as dispatchLeaveEvent } from "@/app/(app)/calendar/actions";
import EventRosterButton from "./EventRosterButton";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RawEventRow {
  id:         string;
  title:      string;
  starts_at:  string;
  ends_at:    string;
  capacity:   number;
  status:     string;
  created_by: string;
  event_types: { key: string; label: string; color: string } | null;
  event_participants: Array<{ profile_id: string; role: string; status: string }>;
  reservations: Array<{ court_id: string; reason: string; status: string }>;
}

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dateKey(iso: string, tz: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
}

function formatDateHeader(iso: string, tz: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: tz, weekday: "long", month: "long", day: "numeric",
  });
}

function formatTime(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true,
  });
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

  const clubId = profile?.club_id ?? "";

  let clubTimezone = "America/New_York";
  if (clubId) {
    const { data: club } = await supabase
      .from("clubs")
      .select("timezone")
      .eq("id", clubId)
      .single();
    if (club?.timezone) clubTimezone = club.timezone;
  }

  // ── Fetch upcoming scheduled events ─────────────────────────────────────────
  const now = new Date().toISOString();

  const { data: rawEvents } = await supabase
    .from("events")
    .select(`
      id, title, starts_at, ends_at, capacity, status, created_by,
      event_types(key, label, color),
      event_participants(profile_id, role, status),
      reservations(court_id, reason, status)
    `)
    .eq("club_id", clubId)
    .eq("status", "scheduled")
    .gte("starts_at", now)
    .order("starts_at", { ascending: true }) as { data: RawEventRow[] | null };

  const events = rawEvents ?? [];

  // ── Batch-fetch court names ───────────────────────────────────────────────
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
  const courtName = new Map((courts ?? []).map(c => [c.id, c.name]));

  // ── Group events by local date ───────────────────────────────────────────
  const grouped = new Map<string, RawEventRow[]>();
  for (const ev of events) {
    const key = dateKey(ev.starts_at, clubTimezone);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(ev);
  }
  const sortedDateKeys = [...grouped.keys()].sort();

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      <Header screenTitle="Events" />

      <div
        className="overflow-y-auto bg-gray-50 dark:bg-gray-900"
        style={{ height: "calc(100dvh - 56px - 64px - env(safe-area-inset-bottom, 0px))" }}
      >
        <div className="md:max-w-2xl md:mx-auto">
        {/* Page title */}
        <div className="px-4 pt-5 pb-1">
          <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">Upcoming Events</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Browse clinics, socials, leagues, and other scheduled events.
          </p>
        </div>

        {events.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-gray-400 dark:text-gray-500 text-sm">
            No upcoming events yet.
          </div>
        ) : (
          <div className="pb-6">
            {sortedDateKeys.map(key => {
              const dayEvents = grouped.get(key)!;
              const header = formatDateHeader(dayEvents[0].starts_at, clubTimezone);

              return (
                <div key={key}>
                  {/* Date section header */}
                  <p className="px-4 pt-5 pb-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                    {header}
                  </p>

                  <div className="px-4 space-y-3">
                    {dayEvents.map(ev => {
                      const type = ev.event_types;

                      // Participant counts — hosts do not consume capacity
                      const confirmedCount = ev.event_participants.filter(
                        p => p.role === "participant" && p.status === "confirmed"
                      ).length;
                      const waitlistCount = ev.event_participants.filter(
                        p => p.status === "waitlisted"
                      ).length;
                      const isFull = confirmedCount >= ev.capacity;

                      // Current user's participation
                      const myEntry  = ev.event_participants.find(p => p.profile_id === user.id);
                      const myRole   = myEntry?.role   ?? null;
                      const myStatus = myEntry?.status ?? null;

                      const isHost       = myRole === "host";
                      const isConfirmed  = myStatus === "confirmed" && myRole === "participant";
                      const isWaitlisted = myStatus === "waitlisted";
                      const isJoined     = isHost || isConfirmed;

                      // Courts
                      const evCourtNames = ev.reservations
                        .filter(r => r.reason === "event" && r.status === "confirmed")
                        .map(r => courtName.get(r.court_id) ?? "Court")
                        .join(", ");

                      // Time range only — date is already in the section header
                      const startLabel = formatTime(ev.starts_at, clubTimezone);
                      const endLabel   = formatTime(ev.ends_at,   clubTimezone);

                      return (
                        <div
                          key={ev.id}
                          className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3"
                        >
                          {/* Type pill + status badge */}
                          <div className="flex items-center gap-1.5 mb-2 flex-wrap">
                            {type && (
                              <span
                                className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold text-white"
                                style={{ background: type.color }}
                              >
                                {type.label}
                              </span>
                            )}
                            {isHost && (
                              <span className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                                Host
                              </span>
                            )}
                            {isConfirmed && (
                              <span className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold bg-green-100 text-green-700">
                                Joined
                              </span>
                            )}
                            {isWaitlisted && (
                              <span className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-700">
                                Waitlisted
                              </span>
                            )}
                          </div>

                          {/* Title */}
                          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{ev.title}</p>

                          {/* Time range + courts (date is in section header) */}
                          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                            {startLabel} – {endLabel}
                            {evCourtNames ? ` · ${evCourtNames}` : ""}
                          </p>

                          {/* Capacity row + action button */}
                          <div className="flex items-center justify-between mt-2">
                            <p className="text-xs text-gray-400 dark:text-gray-500">
                              {confirmedCount} / {ev.capacity} joined
                              {waitlistCount > 0 ? ` · ${waitlistCount} waitlisted` : ""}
                            </p>

                            {isHost ? null : isJoined || isWaitlisted ? (
                              <form action={leaveEventAction}>
                                <input type="hidden" name="event_id" value={ev.id} />
                                <button
                                  type="submit"
                                  className="text-xs font-medium text-red-500"
                                >
                                  {isWaitlisted ? "Leave Waitlist" : "Leave"}
                                </button>
                              </form>
                            ) : (
                              <form action={joinEventAction}>
                                <input type="hidden" name="event_id" value={ev.id} />
                                <button
                                  type="submit"
                                  className="text-xs font-medium text-blue-600"
                                >
                                  {isFull ? "Join Waitlist" : "Join Event"}
                                </button>
                              </form>
                            )}
                          </div>

                          {/* Roster — admin / pro only */}
                          {(profile?.role === "admin" || profile?.role === "pro") && (
                            <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-700">
                              <EventRosterButton
                                eventId={ev.id}
                                count={confirmedCount + waitlistCount}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        </div>
      </div>
    </>
  );
}
