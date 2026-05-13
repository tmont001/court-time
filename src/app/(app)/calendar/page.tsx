import { createClient } from "@/lib/supabase/server";
import Header from "@/components/Header";
import CalendarShell from "./CalendarShell";

export default async function CalendarPage() {
  const supabase = await createClient();

  const { data: courts } = await supabase
    .from("courts")
    .select("id, name, display_order")
    .eq("is_active", true)
    .order("display_order", { ascending: true });

  return (
    <>
      <Header screenTitle="Calendar" />
      <CalendarShell courts={courts ?? []} />
    </>
  );
}
