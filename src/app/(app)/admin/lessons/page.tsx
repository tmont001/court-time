import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import { canAccessOperationsWorkspace, isOperator } from "@/lib/auth/roles";
import Header from "@/components/Header";
import PageTabs from "@/components/PageTabs";
import AdminLessonsWrapper from "./AdminLessonsWrapper";
import LessonTypesSection from "./LessonTypesSection";
import type { ProLessonRequestRow } from "@/app/(app)/lessons/actions";

// Admin UX Checkpoint 3 — Lessons IA. Admin-only "Lesson Types"
// destination, added as a second tab alongside the existing (unchanged)
// Lesson Requests board. /admin/lessons had no pre-existing tab mechanism
// to extend (unlike /events), so this uses the same Link + searchParams
// pattern already established for /admin/reports' range selector and
// /admin/courts' three tabs — direct URL access, refresh persistence, and
// natural back/forward all fall out of that for free. Pro/Staff never see
// the tab strip at all (not just a hidden "Lesson Types" tab) — the page
// renders exactly as it did before this checkpoint for those roles.
type LessonsTab = "requests" | "types";

function resolveLessonsTab(raw: string | undefined, isAdmin: boolean): LessonsTab {
  return raw === "types" && isAdmin ? "types" : "requests";
}

export default async function AdminLessonsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  const profile = await getAuthProfile();
  if (!profile || !canAccessOperationsWorkspace(profile.role)) redirect("/calendar");
  // Narrows profile.role (typed string) to the literal union AdminLessonsWrapper
  // expects — the redirect above already guarantees one of these three values.
  // Phase 34A4A correction: previously coerced Staff into the literal
  // "admin" string ("admin" | "pro" only) for downstream UI convenience.
  // That coercion made it impossible for any component in this tree to
  // tell a real Admin from Staff riding along as "admin", which is exactly
  // the kind of fragile indirection that caused repeated confusion while
  // debugging Staff lesson-reassignment — every component below now
  // receives the caller's real role and applies its own centralized
  // predicate for the specific capability it's gating.
  const userRole: "admin" | "pro" | "staff" =
    profile.role === "pro" ? "pro" : profile.role === "staff" ? "staff" : "admin";

  const sp = await searchParams;
  const tab = resolveLessonsTab(sp.tab, userRole === "admin");

  const supabase = await createClient();
  const clubId   = profile.club_id ?? "";

  const [requestsResult, courtsResult, clubResult, settingsResult] = await Promise.all([
    supabase.rpc("get_pro_lesson_requests"),
    clubId
      ? supabase
          .from("courts")
          .select("id, name")
          .eq("club_id", clubId)
          .eq("is_active", true)
          .order("display_order")
      : Promise.resolve({ data: [] }),
    clubId
      ? supabase.from("clubs").select("timezone").eq("id", clubId).single()
      : Promise.resolve({ data: null }),
    clubId
      ? supabase.from("club_settings").select("currency").eq("club_id", clubId).single()
      : Promise.resolve({ data: null }),
  ]);

  // Phase 33G2: roster Members and lesson types are now fetched for BOTH
  // Admin and Pro — both roles can book a Lesson directly (0128's
  // get_lesson_roster_members, admin+pro; roster_members itself stays
  // admin-only RLS, unchanged). Pros stay operator-only (get_admin_club_pros,
  // widened admin+staff by 0132) — a Pro never picks a Pro, they book
  // themselves (see AdminRequestLessonSheet's viewerRole handling).
  const [prosResult, rosterResult, lessonTypesResult] = clubId
    ? await Promise.all([
        isOperator(userRole)
          ? supabase.rpc("get_admin_club_pros")
          : Promise.resolve({ data: [] }),
        supabase.rpc("get_lesson_roster_members"),
        supabase.rpc("get_lesson_types"),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }];

  const requests     = (requestsResult.data ?? []) as ProLessonRequestRow[];
  const courts       = (courtsResult.data ?? []) as { id: string; name: string }[];
  const clubTimezone = (clubResult as { data: { timezone: string } | null })?.data?.timezone
    ?? "America/New_York";
  const pros = (prosResult.data ?? []) as {
    id: string; first_name: string | null; last_name: string | null;
    role: string; is_lesson_provider: boolean;
  }[];
  const rosterMembers = ((rosterResult.data ?? []) as {
    id: string; first_name: string | null; last_name: string | null; claimed_by: string | null;
  }[]).map(r => ({
    id:      r.id,
    name:    [r.first_name, r.last_name].filter(Boolean).join(" ") || "Unknown",
    claimed: r.claimed_by !== null,
  }));
  // Admin UX Checkpoint 3: widened to the full get_lesson_types shape (was
  // previously narrowed to just what AdminRequestLessonSheet's dropdown
  // needs) so the SAME already-fetched data can also drive the new Lesson
  // Types tab's LessonTypesSection below — no second query, no new RPC.
  const lessonTypes = (lessonTypesResult.data ?? []) as {
    id: string; name: string; description: string | null;
    allowed_durations: number[] | null; max_participants: number;
    pricing_basis: "flat" | "hourly"; unit_price_amount_cents: number | null;
    rate_notes: string | null; is_active: boolean;
  }[];
  const currency = (settingsResult as { data: { currency: string } | null })?.data?.currency ?? "USD";
  const userName = [profile.first_name, profile.last_name].filter(Boolean).join(" ") || "You";

  return (
    <>
      <Header screenTitle="Lesson Requests" />
      <div className="overflow-y-auto" style={{ height: "var(--page-fill-height)" }}>
        <div className="md:max-w-2xl md:mx-auto">
          {/* Admin-only tab strip — Pro/Staff never see this at all (not a
              hidden/disabled tab), so their page is byte-identical to
              before this checkpoint. Same Link + searchParams pattern as
              /admin/courts' three tabs — direct URL, refresh, and back/
              forward all work natively; there was no pre-existing tab
              mechanism on this page to extend. */}
          {userRole === "admin" && (
            <div className="px-4 pt-3">
              <PageTabs
                items={[
                  { key: "requests", label: "Lesson Requests", href: "/admin/lessons", active: tab === "requests" },
                  { key: "types", label: "Lesson Types", href: "/admin/lessons?tab=types", active: tab === "types" },
                ]}
              />
            </div>
          )}

          {tab === "types" ? (
            <div className="px-4 py-4 space-y-3">
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Flat price per lesson type. Changing a price only affects lessons booked after the
                change.
              </p>
              <LessonTypesSection currency={currency} initialTypes={lessonTypes} />
            </div>
          ) : (
            <AdminLessonsWrapper
              requests={requests}
              courts={courts}
              userId={user.id}
              userName={userName}
              userRole={userRole}
              clubId={clubId}
              clubTimezone={clubTimezone}
              pros={pros}
              rosterMembers={rosterMembers}
              lessonTypes={lessonTypes}
              currency={currency}
            />
          )}
        </div>
      </div>
    </>
  );
}
