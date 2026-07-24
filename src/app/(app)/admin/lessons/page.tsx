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

  // Fetch pros, members, and lesson types only for admins
  const [prosResult, membersResult, lessonTypesResult] =
    profile.role === "admin" && clubId
      ? await Promise.all([
          supabase.rpc("get_admin_club_pros"),
          supabase.rpc("get_members"),
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
  const members = (membersResult.data ?? []) as {
    id: string; first_name: string | null; last_name: string | null; email: string | null;
  }[];
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
            clubTimezone={clubTimezone}
            pros={pros}
            members={members}
            lessonTypes={lessonTypes}
          />
        </div>
      </div>
    </>
  );
}
