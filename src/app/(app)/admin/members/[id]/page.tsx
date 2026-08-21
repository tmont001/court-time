import { notFound, redirect } from "next/navigation";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import { isOperator } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";
import Header from "@/components/Header";
import MemberDetailClient, {
  type MemberDetail,
  type UpcomingItem,
  type ClientNote,
} from "./MemberDetailClient";
import type { HistoryItem } from "./actions";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function MemberDetailPage({ params }: Props) {
  const { id } = await params;

  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  // Phase 26C1: profile.role/activeClubId reflect the caller's ACTIVE
  // club_memberships row, not legacy profiles.role/club_id.
  // Phase 34A4: admin+staff (isOperator), matching migration 0132's
  // widening of get_admin_member_detail — never Pro.
  const profile = await getAuthProfile();
  if (!profile || !isOperator(profile.role)) redirect("/calendar");

  const supabase  = await createClient();
  const clubId    = profile.activeClubId ?? "";

  const [detailResult, upcomingResult, historyResult, notesResult, clubResult, settingsResult, prosResult, courtsResult, lessonTypesResult, rosterResult] =
    await Promise.all([
      supabase.rpc("get_admin_member_detail", { p_member_id: id }),
      supabase.rpc("get_member_upcoming_activity", { p_member_id: id }),
      supabase.rpc("get_member_activity_history", { p_member_id: id, p_limit: 20 }),
      supabase.rpc("get_member_notes", { p_member_id: id }),
      clubId
        ? supabase.from("clubs").select("timezone").eq("id", clubId).single()
        : Promise.resolve({ data: null }),
      clubId
        ? supabase.from("club_settings").select("currency").eq("club_id", clubId).single()
        : Promise.resolve({ data: null }),
      supabase.rpc("get_admin_club_pros"),
      clubId
        ? supabase
            .from("courts")
            .select("id, name")
            .eq("club_id", clubId)
            .eq("is_active", true)
            .order("display_order")
        : Promise.resolve({ data: [] }),
      supabase.rpc("get_lesson_types"),
      // Phase 33D1: this Member's roster_member_id — AdminRequestLessonSheet
      // now books via admin_create_member_lesson(p_roster_member_id, ...),
      // not the old profiles-keyed admin_create_lesson_request. This page
      // is reached only for a Member with a profiles row (get_admin_member_
      // detail is profiles-keyed), so this Member is always claimed — the
      // roster row is looked up by claimed_by, not created here.
      clubId
        ? supabase.from("roster_members").select("id").eq("club_id", clubId).eq("claimed_by", id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

  if (detailResult.error) {
    const msg = detailResult.error.message ?? "";
    if (msg.includes("member_not_found")) notFound();
    console.error("[MemberDetailPage] get_admin_member_detail failed:", msg);
    throw new Error("Failed to load member details");
  }
  if (!detailResult.data || (detailResult.data as MemberDetail[]).length === 0) {
    notFound();
  }

  const member       = (detailResult.data as MemberDetail[])[0];
  const upcoming     = (upcomingResult.data ?? []) as UpcomingItem[];
  const historyItems = (historyResult.data ?? []) as HistoryItem[];
  const notes        = (notesResult.data ?? []) as ClientNote[];
  const timezone     = (clubResult as { data: { timezone: string } | null })?.data?.timezone
    ?? "America/New_York";
  const pros = (prosResult.data ?? []) as {
    id: string; first_name: string | null; last_name: string | null;
    role: string; is_lesson_provider: boolean;
  }[];
  const courts = (courtsResult.data ?? []) as { id: string; name: string }[];
  const lessonTypes = (lessonTypesResult.data ?? []) as {
    id: string; name: string; allowed_durations: number[] | null;
    pricing_basis: "flat" | "hourly"; unit_price_amount_cents: number | null;
  }[];
  const currency = (settingsResult as { data: { currency: string } | null })?.data?.currency ?? "USD";
  const rosterMemberId = (rosterResult as { data: { id: string } | null })?.data?.id ?? null;

  const fullName = [member.first_name, member.last_name].filter(Boolean).join(" ") || "Member";

  return (
    <>
      <Header screenTitle={fullName} />
      <div className="overflow-y-auto" style={{ height: "var(--page-fill-height)" }}>
        <div className="md:max-w-2xl md:mx-auto">
          <MemberDetailClient
            member={member}
            upcomingItems={upcoming}
            initialHistory={historyItems}
            initialHasMore={historyItems.length === 20}
            initialNotes={notes}
            clubId={clubId}
            clubTimezone={timezone}
            pros={pros}
            courts={courts}
            lessonTypes={lessonTypes}
            currency={currency}
            rosterMemberId={rosterMemberId}
            adminId={user.id}
          />
        </div>
      </div>
    </>
  );
}
