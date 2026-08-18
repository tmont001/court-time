import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import Header from "@/components/Header";
import {
  leaveEvent as dispatchLeaveEvent,
  joinEvent as dispatchJoinEvent,
  acceptWaitlistOffer as dispatchAcceptWaitlistOffer,
  declineWaitlistOffer as dispatchDeclineWaitlistOffer,
  adminCancelReservation as dispatchAdminCancelReservation,
  cancelMemberReservation as dispatchCancelMemberReservation,
} from "@/app/(app)/calendar/actions";
import { assertActiveClub } from "@/lib/supabase/staleClub";
import PastEventsSection from "./PastEventsSection";
import LessonsClient from "@/app/(app)/lessons/LessonsClient";
import type { LessonRequestRow } from "@/app/(app)/lessons/actions";

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

// Phase 26F1: clubId is bound at the render site below (.bind(null, clubId)),
// so it's available here without threading it through FormData. This
// mirrors the existing silent early-return convention this function already
// uses — a stale club context stops the write the same way, with no
// separate error UI to wire up here (this form action never surfaced
// errors in the first place).
//
// Phase 30B1: no longer computes the cancellation-window/grace rule in
// TypeScript and no longer performs a raw `reservations` table UPDATE —
// this second, independent raw-update implementation (the first being the
// one that used to live in calendar/actions.ts's cancelMemberReservation)
// is fully replaced by routing to the same RPC-backed actions the calendar
// screen uses. Role-aware routing: an admin's own booking is now always
// cancelled through admin_cancel_reservation (unconditional, no window
// enforcement) — the same path an admin uses to cancel any other member's
// booking from the calendar — rather than the previous inconsistent
// behavior where an admin's own booking on this page fell into the same
// window-bypass branch as a member/pro's. A Member or Pro owner is routed
// to cancel_member_reservation, which enforces the window/grace rule
// inside Postgres.
async function cancelReservation(clubId: string, formData: FormData) {
  "use server";
  const id = formData.get("id") as string | null;
  if (!id) return;

  const guard = await assertActiveClub(clubId);
  if (!guard.ok) return;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const { data: actorProfile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (actorProfile?.role === "admin") {
    await dispatchAdminCancelReservation(id, clubId);
  } else {
    await dispatchCancelMemberReservation(id, clubId);
  }

  revalidatePath("/my-schedule");
}

async function leaveEvent(clubId: string, formData: FormData) {
  "use server";
  const eventId = formData.get("event_id") as string | null;
  if (!eventId) return;
  await dispatchLeaveEvent(eventId, clubId);
  revalidatePath("/my-schedule");
}

async function acceptWaitlistOfferAction(clubId: string, formData: FormData) {
  "use server";
  const eventId = formData.get("event_id") as string | null;
  if (!eventId) return;
  await dispatchAcceptWaitlistOffer(eventId, clubId);
  revalidatePath("/my-schedule");
}

async function declineWaitlistOfferAction(clubId: string, formData: FormData) {
  "use server";
  const eventId = formData.get("event_id") as string | null;
  if (!eventId) return;
  await dispatchDeclineWaitlistOffer(eventId, clubId);
  revalidatePath("/my-schedule");
}

async function rejoinEventAction(clubId: string, formData: FormData) {
  "use server";
  const eventId = formData.get("event_id") as string | null;
  if (!eventId) return;
  await dispatchJoinEvent(eventId, clubId);
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

export default async function MySchedulePage({
  searchParams,
}: {
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp       = searchParams ? await searchParams : {};
  const tab      = typeof sp.tab === "string" ? sp.tab : "upcoming";
  const autoOpen = sp.request === "1";

  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  const profile  = await getAuthProfile();
  const supabase = await createClient();

  const clubId   = profile?.club_id ?? "";
  const userRole = profile?.role ?? "member";

  // Phase 33G2: /admin/lessons is the canonical staff Lesson-management
  // surface — an Admin/Pro landing on this Member-style "Lesson Requests"
  // tab (a stale link, an old bookmark, or a manually-typed URL; nothing
  // here was previously role-gated) got the same submit-a-request flow a
  // Member sees, which duplicates /admin/lessons and lets staff request a
  // lesson FROM themselves rather than confirm one. Redirect keeps every
  // other /my-schedule tab, and Member behavior, unchanged.
  if (tab === "lessons" && (userRole === "admin" || userRole === "pro")) {
    redirect("/admin/lessons");
  }

  let clubTimezone             = "America/New_York";
  let cancellationWindowHours  = 24;
  let cancellationGraceMinutes = 5;

  const now = new Date().toISOString();

  // Phase 33C3: the signed-in user's own durable Member identity for this
  // club, if claimed — resolved server-side via current_user_roster_
  // member_id() (0110). Needed before the reservations query below, so
  // resolved in its own round-trip ahead of the parallel batch rather than
  // inside it. A claimed Member's pre-claim, staff-created reservation
  // (owner_user_id null, roster_member_id set to their own identity) can
  // only be found via this value — owner_user_id alone is not enough.
  const { data: rosterMemberId } = await supabase.rpc("current_user_roster_member_id");

  let reservationsQuery = supabase
    .from("reservations")
    .select("id, court_id, starts_at, ends_at, status, format, created_at")
    .in("status", ["pending", "confirmed"])
    .neq("reason", "event")
    .neq("reason", "pro_lesson")
    .gte("starts_at", now)
    .order("starts_at");
  // A single OR condition on one table cannot return the same row twice,
  // so no client-side dedup by id is structurally needed — kept anyway
  // below (reservations Map) as a defensive, explicit guarantee.
  reservationsQuery = rosterMemberId
    ? reservationsQuery.or(`owner_user_id.eq.${user.id},roster_member_id.eq.${rosterMemberId}`)
    : reservationsQuery.eq("owner_user_id", user.id);

  // Phase 33D2: same reasoning as reservationsQuery above — a claimed
  // Member's pre-claim, staff-added event participation (profile_id null,
  // roster_member_id set to their own identity) can only be found via the
  // roster route; profile_id alone is not enough.
  let eventParticipantsQuery = supabase
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
    .in("status", ["confirmed", "waitlisted", "offered"]);
  eventParticipantsQuery = rosterMemberId
    ? eventParticipantsQuery.or(`profile_id.eq.${user.id},roster_member_id.eq.${rosterMemberId}`)
    : eventParticipantsQuery.eq("profile_id", user.id);

  const [
    clubResult,
    settingsResult,
    reservationsResult,
    signupResult,
    lessonsResult,
    prosResult,
    lessonCourtsResult,
  ] = await Promise.all([
    clubId
      ? supabase.from("clubs").select("timezone").eq("id", clubId).single()
      : Promise.resolve({ data: null }),
    clubId
      ? supabase.from("club_settings").select("cancellation_window_hours, cancellation_grace_minutes").eq("club_id", clubId).single()
      : Promise.resolve({ data: null }),
    reservationsQuery,
    eventParticipantsQuery,
    supabase.rpc("get_my_lesson_requests"),
    supabase.rpc("get_club_pros"),
    clubId
      ? supabase.from("courts").select("id, name").eq("club_id", clubId).eq("is_active", true).order("display_order")
      : Promise.resolve({ data: [] }),
  ]);

  if (clubResult.data?.timezone) clubTimezone = clubResult.data.timezone;
  if (settingsResult.data?.cancellation_window_hours  != null) cancellationWindowHours  = settingsResult.data.cancellation_window_hours;
  if (settingsResult.data?.cancellation_grace_minutes != null) cancellationGraceMinutes = settingsResult.data.cancellation_grace_minutes;

  // A silently-swallowed error here previously fell back to an empty list
  // indistinguishable from "genuinely no lessons" — logged now (matching
  // the existing courtsError pattern in calendar/page.tsx) so a real
  // get_my_lesson_requests failure leaves a diagnostic trail instead of
  // presenting as a missing lesson with no trace of why.
  if (lessonsResult.error) {
    console.error("[MySchedule] get_my_lesson_requests failed:", lessonsResult.error.message);
  }
  const allLessons = (lessonsResult.data ?? []) as LessonRequestRow[];
  const confirmedUpcomingLessons = allLessons
    .filter(r => r.status === "confirmed" && r.proposed_starts_at && r.proposed_starts_at >= now)
    .sort((a, b) => (a.proposed_starts_at ?? "").localeCompare(b.proposed_starts_at ?? ""));

  const prosError    = !!prosResult.error;
  const pros         = prosError ? [] : (prosResult.data ?? []) as { id: string; first_name: string | null; last_name: string | null; role: string }[];
  const lessonCourts = (lessonCourtsResult.data ?? []) as { id: string; name: string }[];

  // ── 1. Member court reservations ────────────────────────────────────────────
  // Deduplicated by id defensively — see the reservationsQuery comment above
  // for why a duplicate is not structurally possible here, kept anyway as an
  // explicit guarantee rather than an assumption.
  const rawReservations = (reservationsResult.data ?? []) as ReservationRow[];
  const reservations = Array.from(new Map(rawReservations.map(r => [r.id, r])).values());

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

  const tabCls = (t: string) =>
    `px-3 py-1.5 rounded-lg text-xs font-medium motion-safe:transition-colors motion-safe:duration-100 ${
      tab === t
        ? "bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900"
        : "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
    }`;

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <>
      <Header screenTitle="Bookings" />

      <div
        className="overflow-y-auto"
        style={{ height: "var(--page-fill-height)" }}
      >
        <div className="md:max-w-2xl md:mx-auto">

          {/* Tab bar — Lesson Requests is Member-only; Admin/Pro use /admin/lessons */}
          <div className="flex gap-1 px-4 pt-4 pb-3">
            <Link href="/my-schedule"             className={tabCls("upcoming")}>Upcoming</Link>
            {userRole === "member" && (
              <Link href="/my-schedule?tab=lessons" className={tabCls("lessons")}>Lesson Requests</Link>
            )}
            <Link href="/my-schedule?tab=past"    className={tabCls("past")}>Past</Link>
          </div>

          {/* ── Upcoming tab ─────────────────────────────────────────────── */}
          {tab === "upcoming" && (
            <>
              {allItems.length === 0 && confirmedUpcomingLessons.length === 0 ? (
                <div className="flex items-center justify-center h-48 text-gray-400 dark:text-gray-500 text-sm">
                  No upcoming reservations or events.
                </div>
              ) : (
                <div className="pb-6">

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
                                  <form action={cancelReservation.bind(null, clubId)}>
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

                          // ── Upcoming event signup card ──────────────────────
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
                                  <form action={rejoinEventAction.bind(null, clubId)}>
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
                                    <form action={acceptWaitlistOfferAction.bind(null, clubId)}>
                                      <input type="hidden" name="event_id" value={ev.id} />
                                      <button
                                        type="submit"
                                        className="text-xs font-semibold text-green-600 hover:text-green-800 dark:hover:text-green-400 active:scale-95 motion-safe:transition-colors motion-safe:duration-100"
                                      >
                                        Accept
                                      </button>
                                    </form>
                                    <form action={declineWaitlistOfferAction.bind(null, clubId)}>
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
                                <form action={leaveEvent.bind(null, clubId)}>
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

                  {/* Confirmed upcoming lessons */}
                  {confirmedUpcomingLessons.length > 0 && (
                    <div>
                      <p className="px-4 pt-5 pb-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                        Upcoming Lessons
                      </p>
                      {confirmedUpcomingLessons.map(r => {
                        const proName = [r.pro_first_name, r.pro_last_name].filter(Boolean).join(" ") || "Pro";
                        return (
                          <Link
                            key={r.id}
                            href="/my-schedule?tab=lessons"
                            className="ct-card mx-4 mb-3 px-4 py-3 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-700/40 motion-safe:transition-colors motion-safe:duration-100"
                          >
                            <div>
                              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                                Lesson with {proName}
                              </p>
                              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                                {r.duration_minutes} min
                                {r.proposed_starts_at ? ` · ${new Date(r.proposed_starts_at).toLocaleString("en-US", {
                                  timeZone: clubTimezone, month: "short", day: "numeric",
                                  hour: "numeric", minute: "2-digit", hour12: true,
                                })}` : ""}
                                {r.proposed_court_name ? ` · ${r.proposed_court_name}` : ""}
                              </p>
                            </div>
                            <span className="text-gray-400 dark:text-gray-500 text-sm">›</span>
                          </Link>
                        );
                      })}
                    </div>
                  )}

                </div>
              )}
            </>
          )}

          {/* ── Lesson Requests tab ──────────────────────────────────────── */}
          {tab === "lessons" && (
            <LessonsClient
              initialRequests={allLessons}
              pros={pros}
              courts={lessonCourts}
              userId={user.id}
              clubId={clubId}
              clubTimezone={clubTimezone}
              prosError={prosError}
              autoOpen={autoOpen && !prosError && pros.length > 0 && profile?.memberSelfService !== false}
              canRequestNew={profile?.memberSelfService !== false}
            />
          )}

          {/* ── Past tab ─────────────────────────────────────────────────── */}
          {tab === "past" && (
            <PastEventsSection
              items={pastItems}
              courtNames={courts ?? []}
              clubTimezone={clubTimezone}
            />
          )}

        </div>
      </div>
    </>
  );
}
