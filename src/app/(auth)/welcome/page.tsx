import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import WelcomeForm from "./WelcomeForm";

export default async function WelcomePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/sign-in");

  const { data: profile } = await supabase
    .from("profiles")
    .select("first_name, last_name")
    .eq("id", user.id)
    .single();

  // Already completed onboarding — skip the form.
  if (profile?.first_name && profile?.last_name) {
    redirect("/calendar");
  }

  return <WelcomeForm />;
}
