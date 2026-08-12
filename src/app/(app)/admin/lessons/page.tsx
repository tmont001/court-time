import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import Header from "@/components/Header";
import LessonsTab from "@/app/(app)/events/LessonsTab";
import AdminLessonsWrapper from "./AdminLessonsWrapper";
import type { ProLessonRequestRow } from "@/app/(app)/lessons/actions";

export default async function AdminLessonsPage() {
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  const profile = await getAuthProfile();
  if (profile?.role !== "admin" && profile?.role !== "pro") redirect("/calendar");

  const supabase = await createClient();
  const clubId   = profile.club_id ?? "";

  const [requestsResult, courtsResult, clubResult] = await Promise.all([
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
  ]);

  // Fetch pros, roster Members, and lesson types only for admins.
  // Phase 33D1: roster_members (admin-only RLS, same-club, includes
  // no-account Members) replaces get_members() (profiles-only — could
  // never include a Member with no Court Time account) as the source for
  // the lesson-booking Member picker, mirroring Calendar's admin booking
  // flow (fetchRosterMembers in CalendarShell.tsx).
  const [prosResult, rosterResult, lessonTypesResult] =
    profile.role === "admin" && clubId
      ? await Promise.all([
          supabase.rpc("get_admin_club_pros"),
          supabase
            .from("roster_members")
            .select("id, first_name, last_name, claimed_by")
            .eq("club_id", clubId)
            .order("last_name", { ascending: true })
            .order("first_name", { ascending: true }),
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
  const lessonTypes = (lessonTypesResult.data ?? []) as {
    id: string; name: string; allowed_durations: number[] | null;
  }[];

  if (profile.role !== "admin") {
    return (
      <>
        <Header screenTitle="Lesson Requests" />
        <div className="overflow-y-auto" style={{ height: "var(--page-fill-height)" }}>
          <div className="md:max-w-2xl md:mx-auto">
            <LessonsTab
              initialRequests={requests}
              courts={courts}
              userId={user.id}
              userRole={profile.role}
              clubId={clubId}
              clubTimezone={clubTimezone}
            />
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Header screenTitle="Lesson Requests" />
      <div className="overflow-y-auto" style={{ height: "var(--page-fill-height)" }}>
        <div className="md:max-w-2xl md:mx-auto">
          <AdminLessonsWrapper
            requests={requests}
            courts={courts}
            userId={user.id}
            clubId={clubId}
            clubTimezone={clubTimezone}
            pros={pros}
            rosterMembers={rosterMembers}
            lessonTypes={lessonTypes}
          />
        </div>
      </div>
    </>
  );
}
