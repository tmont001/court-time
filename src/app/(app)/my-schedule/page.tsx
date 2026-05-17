import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import Header from "@/components/Header";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReservationRow {
  id:        string;
  court_id:  string;
  starts_at: string;
  ends_at:   string;
  status:    string;
  format:    string | null;
}

interface EventItem {
  id:         string;
  title:      string;
  starts_at:  string;
  ends_at:    string;
  status:     string;
  event_types: { label: string; color: string };
  reservations: Array<{ court_id: string; reason: string; status: string }>;
}

interface RawSignupRow {
  event_id: string;
  role:     string;
  events:   EventItem | null;
}

type ScheduleItem =
  | { kind: "reservation"; res: ReservationRow }
  | { kind: "event";       ev: EventItem; myRole: string };

// ─── Server actions ───────────────────────────────────────────────────────────

async function cancelReservation(formData: FormData) {
  "use server";
  const id = formData.get("id") as string | null;
  if (!id) return;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

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

  revalidatePath("/my-schedule");
}

async function leaveEvent(formData: FormData) {
  "use server";
  const eventId = formData.get("event_id") as string | null;
  if (!eventId) return;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  await supabase.rpc("leave_event", { p_event_id: eventId });
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
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");

  // Fetch club timezone
  const { data: profile } = await supabase
    .from("profiles")
    .select("club_id")
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

  const now = new Date().toISOString();

  // ── 1. Member court reservations (exclude event-linked ones) ────────────────
  const { data: rows } = await supabase
    .from("reservations")
    .select("id, court_id, starts_at, ends_at, status, format")
    .eq("owner_user_id", user.id)
    .in("status", ["pending", "confirmed"])
    .neq("reason", "event")
    .gte("starts_at", now)
    .order("starts_at") as { data: ReservationRow[] | null };

  const reservations = rows ?? [];

  // ── 2. Event signups (confirmed, future, scheduled events only) ─────────────
  const { data: signupRows } = await supabase
    .from("event_participants")
    .select(`
      event_id,
      role,
      events(
        id,
        title,
        starts_at,
        ends_at,
        status,
        event_types(label, color),
        reservations(court_id, reason, status)
      )
    `)
    .eq("profile_id", user.id)
    .eq("status", "confirmed") as { data: RawSignupRow[] | null };

  const validSignups = (signupRows ?? []).filter(
    s => s.events !== null &&
         s.events.status === "scheduled" &&
         s.events.starts_at >= now
  );

  // ── 3. Collect all court IDs and fetch names in one query ───────────────────
  const resCourtIds   = reservations.map(r => r.court_id);
  const eventCourtIds = validSignups.flatMap(s =>
    (s.events?.reservations ?? [])
      .filter(r => r.reason === "event" && r.status === "confirmed")
      .map(r => r.court_id)
  );
  const allCourtIds = [...new Set([...resCourtIds, ...eventCourtIds])];

  const { data: courts } = allCourtIds.length
    ? await supabase.from("courts").select("id, name").in("id", allCourtIds)
    : { data: [] };
  const courtName = new Map((courts ?? []).map(c => [c.id, c.name]));

  // ── 4. Build unified sorted list ────────────────────────────────────────────
  const allItems: ScheduleItem[] = [
    ...reservations.map(res => ({ kind: "reservation" as const, res })),
    ...validSignups.map(s => ({
      kind:   "event" as const,
      ev:     s.events!,
      myRole: s.role,
    })),
  ];
  allItems.sort((a, b) => itemStartsAt(a).localeCompare(itemStartsAt(b)));

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
      <Header screenTitle="My Schedule" />

      <div
        className="overflow-y-auto bg-gray-50"
        style={{ height: "calc(100dvh - 56px - 64px)" }}
      >
        {allItems.length === 0 ? (
          <div className="flex items-center justify-center h-48 text-gray-400 text-sm">
            No upcoming reservations or events.
          </div>
        ) : (
          <div className="pb-6">
            {sortedDateKeys.map(key => {
              const dayItems = grouped.get(key)!;
              const header   = formatDateHeader(itemStartsAt(dayItems[0]), clubTimezone);
              return (
                <div key={key}>
                  <p className="px-4 pt-5 pb-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">
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
                          className="mx-4 mb-3 px-4 py-3 bg-white rounded-xl border border-gray-200 flex items-center justify-between"
                        >
                          <div>
                            <p className="text-sm font-semibold text-gray-900">{name}</p>
                            <p className="text-xs text-gray-500 mt-0.5">
                              {start} – {end} · {durationMin} min
                              {formatLabel ? ` · ${formatLabel}` : ""}
                            </p>
                          </div>
                          <form action={cancelReservation}>
                            <input type="hidden" name="id" value={res.id} />
                            <button
                              type="submit"
                              className="text-xs font-medium text-red-500 ml-4 shrink-0"
                            >
                              Cancel
                            </button>
                          </form>
                        </div>
                      );
                    }

                    // ── Event signup card ────────────────────────────────────
                    const { ev, myRole } = item;
                    const start = formatTime(ev.starts_at, clubTimezone);
                    const end   = formatTime(ev.ends_at,   clubTimezone);
                    const evCourtNames = ev.reservations
                      .filter(r => r.reason === "event" && r.status === "confirmed")
                      .map(r => courtName.get(r.court_id) ?? "Court")
                      .join(", ");

                    return (
                      <div
                        key={ev.id}
                        className="mx-4 mb-3 px-4 py-3 bg-white rounded-xl border border-gray-200 flex items-start justify-between"
                      >
                        <div className="flex-1 min-w-0">
                          <span
                            className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold text-white mb-1.5"
                            style={{ background: ev.event_types.color }}
                          >
                            {ev.event_types.label}
                          </span>
                          <p className="text-sm font-semibold text-gray-900">{ev.title}</p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            {start} – {end}
                            {evCourtNames ? ` · ${evCourtNames}` : ""}
                          </p>
                        </div>
                        {myRole !== "host" ? (
                          <form action={leaveEvent}>
                            <input type="hidden" name="event_id" value={ev.id} />
                            <button
                              type="submit"
                              className="text-xs font-medium text-red-500 ml-4 shrink-0"
                            >
                              Leave
                            </button>
                          </form>
                        ) : (
                          <span className="text-xs text-gray-400 ml-4 shrink-0">Host</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
