import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Header from "@/components/Header";
import CalendarShell from "./CalendarShell";

export default async function CalendarPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/sign-in");

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

  const { data: courts, error: courtsError } = await supabase
    .from("courts")
    .select("id, name, display_order")
    .eq("is_active", true)
    .order("display_order", { ascending: true });

  if (courtsError) {
    console.error("[Calendar] courts query failed:", courtsError.message);
  }

  return (
    <>
      <Header screenTitle="Calendar" />
      <CalendarShell
        courts={courts ?? []}
        hasError={!!courtsError}
        userId={user.id}
        clubId={clubId}
        clubTimezone={clubTimezone}
      />
    </>
  );
}
