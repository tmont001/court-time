import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import Header from "@/components/Header";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReservationRow {
  id:         string;
  court_id:   string;
  starts_at:  string;
  ends_at:    string;
  status:     string;
  format:     string | null;
}

// ─── Server action ────────────────────────────────────────────────────────────

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
    .eq("owner_user_id", user.id); // defence in depth on top of RLS

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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function MySchedulePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");

  // Fetch club timezone from profile → club join
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

  // Fetch upcoming confirmed/pending reservations for this member
  const { data: rows } = await supabase
    .from("reservations")
    .select("id, court_id, starts_at, ends_at, status, format")
    .eq("owner_user_id", user.id)
    .in("status", ["pending", "confirmed"])
    .gte("starts_at", new Date().toISOString())
    .order("starts_at") as { data: ReservationRow[] | null };

  const reservations = rows ?? [];

  // Fetch court names for all referenced courts
  const courtIds = [...new Set(reservations.map(r => r.court_id))];
  const { data: courts } = courtIds.length
    ? await supabase.from("courts").select("id, name").in("id", courtIds)
    : { data: [] };
  const courtName = new Map((courts ?? []).map(c => [c.id, c.name]));

  // Group by local date
  const grouped = new Map<string, ReservationRow[]>();
  for (const res of reservations) {
    const key = dateKey(res.starts_at, clubTimezone);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(res);
  }
  const sortedDateKeys = [...grouped.keys()].sort();

  return (
    <>
      <Header screenTitle="My Schedule" />

      <div
        className="overflow-y-auto bg-gray-50"
        style={{ height: "calc(100dvh - 56px - 64px)" }}
      >
        {reservations.length === 0 ? (
          <div className="flex items-center justify-center h-48 text-gray-400 text-sm">
            No upcoming reservations.
          </div>
        ) : (
          <div className="pb-6">
            {sortedDateKeys.map(key => {
              const dayRes = grouped.get(key)!;
              const header = formatDateHeader(dayRes[0].starts_at, clubTimezone);
              return (
                <div key={key}>
                  <p className="px-4 pt-5 pb-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    {header}
                  </p>
                  {dayRes.map(res => {
                    const name     = courtName.get(res.court_id) ?? "Court";
                    const start    = formatTime(res.starts_at, clubTimezone);
                    const end      = formatTime(res.ends_at,   clubTimezone);
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
