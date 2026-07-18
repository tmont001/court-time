import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import Header from "@/components/Header";
import {
  leaveEvent as dispatchLeaveEvent,
  joinEvent as dispatchJoinEvent,
  acceptWaitlistOffer as dispatchAcceptWaitlistOffer,
  declineWaitlistOffer as dispatchDeclineWaitlistOffer,
  notifyMemberReservationCancelled,
} from "@/app/(app)/calendar/actions";
import PastEventsSection from "./PastEventsSection";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReservationRow {
  id:         string;
  court_id:   string;
  starts_at:  string;
  ends_at:    string;
  status:     string;
  format:     string | null;
  created_at: string;
}

interface EventItem {
  id:          string;
  title:       string;
  starts_at:   string;
  ends_at:     string;
  status:      string;
  archived_at: string | null;
  event_types: { label: string; color: string };
  reservations: Array<{ court_id: string; reason: string; status: string }>;
}

interface RawSignupRow {
  event_id:          string;
  role:              string;
  status:            string;
  attendance_status: string | null;
  offer_expires_at:  string | null;
  events:            EventItem | null;
}

type ScheduleItem =
  | { kind: "reservation"; res: ReservationRow; isCancellable: boolean }
  | { kind: "event"; ev: EventItem; myRole: string; myStatus: string; myAttendance: string | null; offerExpiresAt: string | null };

// ─── Server actions ───────────────────────────────────────────────────────────

async function cancelReservation(formData: FormData) {
  "use server";
  const id = formData.get("id") as string | null;
  if (!id) return;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  // Server-side guard: enforce cancellation window for non-admin users.
  // Admin is exempt; member and pro are subject to the window.
  const { data: actorProfile } = await supabase
    .from("profiles")
    .select("role, club_id")
    .eq("id", user.id)
    .single();

  if (actorProfile && actorProfile.role !== "admin") {
    const { data: targetRes } = await supabase
      .from("reservations")
      .select("starts_at, created_at")
      .eq("id", id)
      .eq("owner_user_id", user.id)
      .single();

    if (targetRes) {
      const { data: settings } = await supabase
        .from("club_settings")
        .select("cancellation_window_hours, cancellation_grace_minutes")
        .eq("club_id", actorProfile.club_id ?? "")
        .single();

      const windowMs     = (settings?.cancellation_window_hours  ?? 24) * 60 * 60 * 1000;
      const graceMs      = (settings?.cancellation_grace_minutes ?? 5)  * 60 * 1000;
      const insideWindow = new Date(targetRes.starts_at).getTime() - Date.now() < windowMs;
      const withinGrace  = graceMs > 0 && Date.now() - new Date(targetRes.created_at).getTime() < graceMs;

      // Block cancellation only when inside the window AND outside the grace period.
      if (insideWindow && !withinGrace) return;
    }
  }

  await supabase
    .from("reservations")
    .update({
      status:            "cancelled",
      cancelled_at:      new Date().toISOString(),
      cancelled_by:      user.id,
      cancellation_kind: "member",
    })
    .eq("id", id)
    .eq("owner_user_id", user.id);

  // Notify and dispatch SMS — non-blocking; never surfaces errors to the user.
  // The RPC verifies status = 'cancelled' before inserting, so a failed update
  // above simply results in no notification (reservation_not_found raised).
  try {
    await notifyMemberReservationCancelled(user.id, id);
  } catch {
    // intentionally swallowed
  }

  revalidatePath("/my-schedule");
}

async function leaveEvent(formData: FormData) {
  "use server";
  const eventId = formData.get("event_id") as string | null;
  if (!eventId) return;
  await dispatchLeaveEvent(eventId);
  revalidatePath("/my-schedule");
}

async function acceptWaitlistOfferAction(formData: FormData) {
  "use server";
  const eventId = formData.get("event_id") as string | null;
  if (!eventId) return;
  await dispatchAcceptWaitlistOffer(eventId);
  revalidatePath("/my-schedule");
}

async function declineWaitlistOfferAction(formData: FormData) {
  "use server";
  const eventId = formData.get("event_id") as string | null;
  if (!eventId) return;
  await dispatchDeclineWaitlistOffer(eventId);
  revalidatePath("/my-schedule");
}

async function rejoinEventAction(formData: FormData) {
  "use server";
  const eventId = formData.get("event_id") as string | null;
  if (!eventId) return;
  await dispatchJoinEvent(eventId);
  revalidatePath("/my-schedule");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true,
  });
}

function formatDateHeader(iso: string, tz: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: tz, weekday: "long", month: "long", day: "numeric",
  });
}

function dateKey(iso: string, tz: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
}

function itemStartsAt(item: ScheduleItem): string {
  return item.kind === "reservation" ? item.res.starts_at : item.ev.starts_at;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function MySchedulePage() {
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  const profile  = await getAuthProfile();
  const supabase = await createClient();

  const clubId   = profile?.club_id ?? "";
  const userRole = profile?.role ?? "member";

  let clubTimezone             = "America/New_York";
  let cancellationWindowHours  = 24; // matches DB default
  let cancellationGraceMinutes = 5;  // matches DB default

  const now = new Date().toISOString();

  // Reservations and event_participants only need user.id (available now).
  // Club and settings need club_id (from profile, also available now).
  // Run all four in parallel to save one sequential round-trip vs. the previous
  // two-batch pattern (clubs+settings → then reservations+participants).
  const [
    clubResult,
    settingsResult,
    reservationsResult,
    signupResult,
  ] = await Promise.all([
    clubId
      ? supabase.from("clubs").select("timezone").eq("id", clubId).single()
      : Promise.resolve({ data: null }),
    clubId
      ? supabase.from("club_settings").select("cancellation_window_hours, cancellation_grace_minutes").eq("club_id", clubId).single()
      : Promise.resolve({ data: null }),
    supabase
      .from("reservations")
      .select("id, court_id, starts_at, ends_at, status, format, created_at")
      .eq("owner_user_id", user.id)
      .in("status", ["pending", "confirmed"])
      .neq("reason", "event")
      .gte("starts_at", now)
      .order("starts_at"),
    supabase
      .from("event_participants")
      .select(`
        event_id,
        role,
        status,
        attendance_status,
        offer_expires_at,
        events(
          id,
          title,
          starts_at,
          ends_at,
          status,
          archived_at,
          event_types(label, color),
          reservations(court_id, reason, status)
        )
      `)
      .eq("profile_id", user.id)
      .in("status", ["confirmed", "waitlisted", "offered"]),
  ]);

  if (clubResult.data?.timezone) clubTimezone = clubResult.data.timezone;
  if (settingsResult.data?.cancellation_window_hours  != null) cancellationWindowHours  = settingsResult.data.cancellation_window_hours;
  if (settingsResult.data?.cancellation_grace_minutes != null) cancellationGraceMinutes = settingsResult.data.cancellation_grace_minutes;

  // ── 1. Member court reservations ────────────────────────────────────────────
  const reservations = (reservationsResult.data ?? []) as ReservationRow[];

  // ── 2. Event signups ─────────────────────────────────────────────────────────
  const { data: signupRows } = signupResult as { data: RawSignupRow[] | null };

  const allSignupRows = signupRows ?? [];

  const validSignups = allSignupRows.filter(
    s => s.events !== null &&
         s.events.status === "scheduled" &&
         s.events.archived_at == null &&
         s.events.starts_at >= now
  );

  const pastSignups = allSignupRows.filter(
    s => s.events !== null &&
         s.events.archived_at == null &&
         (s.events.status !== "scheduled" || s.events.starts_at < now)
  );

  // ── 3. Collect all court IDs and fetch names in one query ───────────────────
  const resCourtIds      = reservations.map(r => r.court_id);
  const eventCourtIds    = validSignups.flatMap(s =>
    (s.events?.reservations ?? [])
      .filter(r => r.reason === "event" && r.status === "confirmed")
      .map(r => r.court_id)
  );
  const pastEventCourtIds = pastSignups.flatMap(s =>
    (s.events?.reservations ?? [])
      .filter(r => r.reason === "event" && r.status === "confirmed")
      .map(r => r.court_id)
  );
  const allCourtIds = [...new Set([...resCourtIds, ...eventCourtIds, ...pastEventCourtIds])];

  const { data: courts } = allCourtIds.length
    ? await supabase.from("courts").select("id, name").in("id", allCourtIds)
    : { data: [] };
  const courtName = new Map((courts ?? []).map(c => [c.id, c.name]));

  // ── 4. Build unified sorted list ────────────────────────────────────────────
  const windowMs = cancellationWindowHours  * 60 * 60 * 1000;
  const graceMs  = cancellationGraceMinutes * 60 * 1000;

  const allItems: ScheduleItem[] = [
    ...reservations.map(res => ({
      kind: "reservation" as const,
      res,
      isCancellable:
        userRole === "admin" ||
        new Date(res.starts_at).getTime() - Date.now() >= windowMs ||
        (graceMs > 0 && Date.now() - new Date(res.created_at).getTime() < graceMs),
    })),
    ...validSignups.map(s => ({
      kind:           "event" as const,
      ev:             s.events!,
      myRole:         s.role,
      myStatus:       s.status,
      myAttendance:   s.attendance_status,
      offerExpiresAt: s.offer_expires_at,
    })),
  ];
  allItems.sort((a, b) => itemStartsAt(a).localeCompare(itemStartsAt(b)));

  // Past events — most recent first, passed to PastEventsSection (read-only, collapsible)
  const pastItems = pastSignups
    .map(s => ({
      id:           s.events!.id,
      title:        s.events!.title,
      starts_at:    s.events!.starts_at,
      ends_at:      s.events!.ends_at,
      eventStatus:  s.events!.status,
      event_types:  s.events!.event_types,
      reservations: s.events!.reservations,
      myRole:       s.role,
      myStatus:     s.status,
      myAttendance: s.attendance_status,
    }))
    .sort((a, b) => b.starts_at.localeCompare(a.starts_at));

  // ── 5. Group by local date ───────────────────────────────────────────────────
  const grouped = new Map<string, ScheduleItem[]>();
  for (const item of allItems) {
    const key = dateKey(itemStartsAt(item), clubTimezone);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(item);
  }
  const sortedDateKeys = [...grouped.keys()].sort();

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <>
      <Header screenTitle="My Bookings" />

      <div
        className="overflow-y-auto"
        style={{ height: "var(--page-fill-height)" }}
      >
        <div className="md:max-w-2xl md:mx-auto">
        {allItems.length === 0 && pastItems.length === 0 ? (
          <div className="flex items-center justify-center h-48 text-gray-400 dark:text-gray-500 text-sm">
            No upcoming reservations or events.
          </div>
        ) : (
          <div className="pb-6">

            {/* ── Upcoming section ──────────────────────────────────────── */}
            {sortedDateKeys.map(key => {
              const dayItems = grouped.get(key)!;
              const header   = formatDateHeader(itemStartsAt(dayItems[0]), clubTimezone);
              return (
                <div key={key}>
                  <p className="px-4 pt-5 pb-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                    {header}
                  </p>

                  {dayItems.map(item => {
                    if (item.kind === "reservation") {
                      const { res } = item;
                      const name        = courtName.get(res.court_id) ?? "Court";
                      const start       = formatTime(res.starts_at, clubTimezone);
                      const end         = formatTime(res.ends_at,   clubTimezone);
                      const durationMin = Math.round(
                        (new Date(res.ends_at).getTime() - new Date(res.starts_at).getTime()) / 60_000
                      );
                      const formatLabel = res.format
                        ? res.format.charAt(0).toUpperCase() + res.format.slice(1)
                        : null;

                      return (
                        <div
                          key={res.id}
                          className="ct-card mx-4 mb-3 px-4 py-3 flex items-center justify-between"
                        >
                          <div>
                            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{name}</p>
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                              {start} – {end} · {durationMin} min
                              {formatLabel ? ` · ${formatLabel}` : ""}
                            </p>
                          </div>
                          {item.isCancellable ? (
                            <form action={cancelReservation}>
                              <input type="hidden" name="id" value={res.id} />
                              <button
                                type="submit"
                                className="text-xs font-medium text-red-500 ml-4 shrink-0 hover:text-red-700 dark:hover:text-red-400 active:scale-95 motion-safe:transition-colors motion-safe:duration-100"
                              >
                                Cancel
                              </button>
                            </form>
                          ) : (
                            <span className="text-xs text-gray-400 ml-4 shrink-0 text-right">
                              Cannot cancel within {cancellationWindowHours}h
                              {cancellationGraceMinutes > 0 && (
                                <><br />unless booked in last {cancellationGraceMinutes}m</>
                              )}
                            </span>
                          )}
                        </div>
                      );
                    }

                    // ── Upcoming event signup card ────────────────────────────
                    const { ev, myRole, myStatus, offerExpiresAt } = item;
                    const start = formatTime(ev.starts_at, clubTimezone);
                    const end   = formatTime(ev.ends_at,   clubTimezone);
                    const evCourtNames = ev.reservations
                      .filter(r => r.reason === "event" && r.status === "confirmed")
                      .map(r => courtName.get(r.court_id) ?? "Court")
                      .join(", ");

                    const isWaitlisted           = myStatus === "waitlisted";
                    const isOffered              = myStatus === "offered";
                    const offerExpiredServerSide = isOffered && offerExpiresAt
                      ? new Date(offerExpiresAt) <= new Date()
                      : false;

                    return (
                      <div
                        key={ev.id}
                        className="ct-card mx-4 mb-3 px-4 py-3 flex items-start justify-between"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
                            <span
                              className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold text-white"
                              style={{ background: ev.event_types.color }}
                            >
                              {ev.event_types.label}
                            </span>
                            {isWaitlisted && (
                              <span className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-700">
                                Waitlisted
                              </span>
                            )}
                            {isOffered && !offerExpiredServerSide && (
                              <span className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-700">
                                Spot offered
                              </span>
                            )}
                            {isOffered && offerExpiredServerSide && (
                              <span className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
                                Offer expired
                              </span>
                            )}
                          </div>
                          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{ev.title}</p>
                          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                            {start} – {end}
                            {evCourtNames ? ` · ${evCourtNames}` : ""}
                          </p>
                          {isOffered && !offerExpiredServerSide && offerExpiresAt && (
                            <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5 font-medium">
                              Accept by {formatTime(offerExpiresAt, clubTimezone)}
                            </p>
                          )}
                        </div>
                        {myRole === "host" ? (
                          <span className="text-xs text-gray-400 ml-4 shrink-0">Host</span>
                        ) : isOffered ? (
                          offerExpiredServerSide ? (
                            <form action={rejoinEventAction}>
                              <input type="hidden" name="event_id" value={ev.id} />
                              <button
                                type="submit"
                                className="text-xs font-medium text-blue-600 ml-4 shrink-0 hover:text-blue-800 dark:hover:text-blue-400 active:scale-95 motion-safe:transition-colors motion-safe:duration-100"
                              >
                                Rejoin
                              </button>
                            </form>
                          ) : (
                            <div className="flex flex-col items-end gap-1.5 ml-4 shrink-0">
                              <form action={acceptWaitlistOfferAction}>
                                <input type="hidden" name="event_id" value={ev.id} />
                                <button
                                  type="submit"
                                  className="text-xs font-semibold text-green-600 hover:text-green-800 dark:hover:text-green-400 active:scale-95 motion-safe:transition-colors motion-safe:duration-100"
                                >
                                  Accept
                                </button>
                              </form>
                              <form action={declineWaitlistOfferAction}>
                                <input type="hidden" name="event_id" value={ev.id} />
                                <button
                                  type="submit"
                                  className="text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 active:scale-95 motion-safe:transition-colors motion-safe:duration-100"
                                >
                                  Pass
                                </button>
                              </form>
                            </div>
                          )
                        ) : (
                          <form action={leaveEvent}>
                            <input type="hidden" name="event_id" value={ev.id} />
                            <button
                              type="submit"
                              className="text-xs font-medium text-red-500 ml-4 shrink-0 hover:text-red-700 dark:hover:text-red-400 active:scale-95 motion-safe:transition-colors motion-safe:duration-100"
                            >
                              {isWaitlisted ? "Leave Waitlist" : "Leave"}
                            </button>
                          </form>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}

            {/* ── Past events — collapsed by default (client component) ── */}
            <PastEventsSection
              items={pastItems}
              courtNames={courts ?? []}
              clubTimezone={clubTimezone}
            />

          </div>
        )}
        </div>
      </div>
    </>
  );
}
