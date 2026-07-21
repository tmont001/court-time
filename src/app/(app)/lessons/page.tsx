import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import Header from "@/components/Header";
import LessonsClient from "./LessonsClient";
import type { LessonRequestRow } from "./actions";

export default async function LessonsPage({
  searchParams,
}: {
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  const profile  = await getAuthProfile();
  const supabase = await createClient();

  const sp         = searchParams ? await searchParams : {};
  const openOnLoad = sp.request === "1";

  const clubId = profile?.club_id ?? "";

  const [
    clubResult,
    requestsResult,
    prosResult,
    courtsResult,
  ] = await Promise.all([
    clubId
      ? supabase.from("clubs").select("timezone").eq("id", clubId).single()
      : Promise.resolve({ data: null }),
    supabase.rpc("get_my_lesson_requests"),
    supabase.rpc("get_club_pros"),
    clubId
      ? supabase
          .from("courts")
          .select("id, name")
          .eq("club_id", clubId)
          .eq("is_active", true)
          .order("display_order")
      : Promise.resolve({ data: [] }),
  ]);

  // Distinguish RPC failure from an empty provider list.
  // prosResult.data is null when there is an error; [] when the RPC succeeded
  // but no providers match the filter.
  const prosError = !!prosResult.error;
  if (prosResult.error) {
    console.error("[LessonsPage] get_club_pros RPC failed:", prosResult.error);
  }

  const clubTimezone = clubResult.data?.timezone ?? "America/New_York";
  const requests     = (requestsResult.data ?? []) as LessonRequestRow[];
  const pros         = prosError ? [] : (prosResult.data ?? []);
  const courts       = courtsResult.data ?? [];

  // Auto-open the request sheet only when the param is present, providers
  // exist, and there is no lookup error. Server-side guard prevents opening
  // the sheet into an unusable state.
  const autoOpen = openOnLoad && !prosError && pros.length > 0;

  return (
    <>
      <Header screenTitle="Lesson Requests" />
      <div className="overflow-y-auto" style={{ height: "var(--page-fill-height)" }}>
        <div className="md:max-w-2xl md:mx-auto">
          <LessonsClient
            initialRequests={requests}
            pros={pros as { id: string; first_name: string | null; last_name: string | null; role: string }[]}
            courts={courts as { id: string; name: string }[]}
            userId={user.id}
            clubTimezone={clubTimezone}
            prosError={prosError}
            autoOpen={autoOpen}
          />
        </div>
      </div>
    </>
  );
}
