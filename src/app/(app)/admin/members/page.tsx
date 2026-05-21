import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Header from "@/components/Header";
import MembersClient from "./MembersClient";

export const dynamic = "force-dynamic";

export default async function AdminMembersPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");

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
        className="overflow-y-auto bg-gray-50 dark:bg-gray-900"
        style={{ height: "calc(100dvh - 56px - 64px)" }}
      >
        <div className="md:max-w-3xl md:mx-auto">
          <MembersClient
            members={membersResult.data ?? []}
            pendingInvites={pendingInvites}
            membersError={membersResult.error?.message ?? null}
            invitesError={invitesResult.error?.message ?? null}
          />
        </div>
      </div>
    </>
  );
}
