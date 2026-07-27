import { redirect } from "next/navigation";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  // Phase 26C1: profile.role is the caller's role in their ACTIVE club
  // (club_memberships), not legacy profiles.role. A user with no valid
  // active membership has role === null here and is redirected exactly as
  // a non-admin/non-pro member would be — no broadening of admin access.
  const profile = await getAuthProfile();
  if (profile?.role !== "admin" && profile?.role !== "pro") redirect("/calendar");

  return <>{children}</>;
}
