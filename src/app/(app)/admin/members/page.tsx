import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import Header from "@/components/Header";
import MembersClient from "./MembersClient";

export const dynamic = "force-dynamic";

export default async function AdminMembersPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "admin") redirect("/calendar");

  const [membersResult, invitesResult] = await Promise.all([
    supabase.rpc("get_members"),
    supabase.rpc("get_club_invites"),
  ]);

  const now = new Date();
  const pendingInvites = (invitesResult.data ?? []).filter(
    (inv) =>
      !inv.accepted_at &&
      !inv.revoked_at &&
      new Date(inv.expires_at) > now
  );

  return (
    <>
      <Header screenTitle="Members" />
      <div
        className="overflow-y-auto"
        style={{ height: "var(--page-fill-height)" }}
      >
        <div className="md:max-w-3xl md:mx-auto">
          <div className="px-4 pt-3 pb-0">
            <Link href="/profile" className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300">
              ← Back to Profile
            </Link>
          </div>
          <MembersClient
            members={membersResult.data ?? []}
            pendingInvites={pendingInvites}
            currentUserId={user.id}
            membersError={membersResult.error?.message ?? null}
            invitesError={invitesResult.error?.message ?? null}
          />
        </div>
      </div>
    </>
  );
}
