import { createClient } from "@/lib/supabase/server";
import Header from "@/components/Header";
import CalendarShell from "./CalendarShell";

export default async function CalendarPage() {
  const supabase = await createClient();

  // Validate the session before making RLS-protected queries.
  await supabase.auth.getUser();

  const { data: courts, error } = await supabase
    .from("courts")
    .select("*")
    .eq("is_active", true)
    .order("display_order", { ascending: true });

  if (error) {
    console.error("[Calendar] courts query failed:", error.message);
  }

  return (
    <>
      <Header screenTitle="Calendar" />
      <CalendarShell courts={courts ?? []} hasError={!!error} />
    </>
  );
}
