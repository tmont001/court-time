import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import PendingInviteClient from "./PendingInviteClient";

export const dynamic = "force-dynamic";

export default async function PendingInvitePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Should not be reachable when signed out; redirect defensively.
  if (!user) redirect("/sign-in");

  return <PendingInviteClient email={user.email ?? ""} />;
}
