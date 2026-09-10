import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import { isOperator } from "@/lib/auth/roles";
import Header from "@/components/Header";
import MembersClient from "./MembersClient";

export const dynamic = "force-dynamic";

export default async function AdminMembersPage() {
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  // Phase 26C1: profile.role reflects the caller's role in their ACTIVE
  // club_memberships row; get_members()/get_roster_members()/
  // get_club_invites() below are similarly scoped to that active club.
  // Phase 34A4: admin+staff (isOperator), matching migration 0132's
  // widening of those same three RPCs — never Pro, which has no access
  // to any of them.
  const profile  = await getAuthProfile();
  if (!isOperator(profile?.role)) redirect("/calendar");

  const supabase = await createClient();

  const [membersResult, invitesResult, rosterResult] = await Promise.all([
    supabase.rpc("get_members"),
    supabase.rpc("get_club_invites"),
    // Phase 33E2: this CRM listing wants to see every unclaimed identity,
    // including inactive ones, so staff can view/manage them — active-only
    // filtering is for picker use (EventRosterSheet's bare, default call).
    supabase.rpc("get_roster_members", { p_include_inactive: true }),
  ]);

  // Include expired invites so admins can see them and resend. Active invites
  // are those with expires_at in the future; expired ones have expires_at <= now.
  // Revoked and accepted invites are always excluded.
  const pendingInvites = (invitesResult.data ?? []).filter(
    (inv) => !inv.accepted_at && !inv.revoked_at
  );

  return (
    <>
      <Header screenTitle="Members" />
      <div
        className="overflow-y-auto"
        style={{ height: "var(--page-fill-height)" }}
      >
        <div className="md:max-w-3xl md:mx-auto">
          <MembersClient
            members={membersResult.data ?? []}
            rosterMembers={rosterResult.data ?? []}
            pendingInvites={pendingInvites}
            currentUserId={user.id}
            membersError={membersResult.error?.message ?? null}
            invitesError={invitesResult.error?.message ?? null}
            userRole={profile?.role ?? "member"}
          />
        </div>
      </div>
    </>
  );
}
