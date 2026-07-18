import { redirect } from "next/navigation";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  const profile = await getAuthProfile();
  if (profile?.role !== "admin" && profile?.role !== "pro") redirect("/calendar");

  return <>{children}</>;
}
