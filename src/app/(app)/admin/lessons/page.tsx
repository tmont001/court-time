import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import Header from "@/components/Header";
import LessonsTab from "@/app/(app)/events/LessonsTab";
import type { ProLessonRequestRow } from "@/app/(app)/lessons/actions";

export default async function AdminLessonsPage() {
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  const profile = await getAuthProfile();
  if (profile?.role !== "admin" && profile?.role !== "pro") redirect("/calendar");

  const supabase = await createClient();
  const clubId   = profile.club_id ?? "";

  const [requestsResult, courtsResult] = await Promise.all([
    supabase.rpc("get_pro_lesson_requests"),
    clubId
      ? supabase
          .from("courts")
          .select("id, name")
          .eq("club_id", clubId)
          .eq("is_active", true)
          .order("display_order")
      : Promise.resolve({ data: [] }),
  ]);

  const clubResult = await supabase
    .from("clubs")
    .select("timezone")
    .eq("id", clubId)
    .single();

  const requests    = (requestsResult.data ?? []) as ProLessonRequestRow[];
  const courts      = (courtsResult.data ?? []) as { id: string; name: string }[];
  const clubTimezone = clubResult.data?.timezone ?? "America/New_York";

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
