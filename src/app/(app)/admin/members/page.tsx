import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import { isOperator } from "@/lib/auth/roles";
import Header from "@/components/Header";
import MembersClient from "./MembersClient";
import MembersAreaTabs from "./MembersAreaTabs";

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
  const clubId = profile?.club_id ?? "";
  // Phase 42C-3B: the unclaimed-roster Membership editor is Admin-only
  // (matches get_roster_members' own admin-only RPC gate, and
  // membership_types' admin-only RLS policy) — Staff never reaches this
  // condition, so this query is never even attempted for them, rather
  // than attempted and silently failing closed. Active types only: this
  // is the pool of newly-assignable options for the editor, not the full
  // Membership Types management list (that's /admin/settings, Admin-only,
  // shows inactive types too).
  const isAdmin = profile?.role === "admin";

  const [membersResult, invitesResult, rosterResult, settingsResult, membershipTypesResult, complianceResult, rosterIdentityResult] = await Promise.all([
    supabase.rpc("get_members"),
    supabase.rpc("get_club_invites"),
    // Phase 33E2: this CRM listing wants to see every unclaimed identity,
    // including inactive ones, so staff can view/manage them — active-only
    // filtering is for picker use (EventRosterSheet's bare, default call).
    supabase.rpc("get_roster_members", { p_include_inactive: true }),
    clubId
      ? supabase.from("club_settings").select("memberships_enabled").eq("club_id", clubId).single()
      : Promise.resolve({ data: null }),
    isAdmin && clubId
      ? supabase.from("membership_types").select("id, name").eq("club_id", clubId).eq("is_active", true).order("name")
      : Promise.resolve({ data: [] }),
    // Phase 43B-1B — bulk, set-based Member waiver compliance (0194).
    // Called ONCE for the whole roster, never per-Member (no N+1). Admin+
    // Staff both reach this page (isOperator gate above); the RPC's own
    // internal role check is the real authorization — no client-side gate
    // needed here.
    supabase.rpc("get_club_member_waiver_compliance"),
    // roster_members.claimed_by is the only way to resolve a CLAIMED
    // Member row's roster_member_id — get_members() itself has never
    // returned it. roster_members' own SELECT RLS is Admin+Staff (0132),
    // so this plain table read works for both, matching Member Detail's
    // existing claimed_by-scoped roster_members read. Unclaimed
    // RosterMember rows need no such lookup — get_roster_members()'s own
    // `id` IS roster_members.id already.
    clubId
      ? supabase.from("roster_members").select("id, claimed_by").eq("club_id", clubId)
      : Promise.resolve({ data: [] as { id: string; claimed_by: string | null }[] }),
  ]);

  // Include expired invites so admins can see them and resend. Active invites
  // are those with expires_at in the future; expired ones have expires_at <= now.
  // Revoked and accepted invites are always excluded.
  const pendingInvites = (invitesResult.data ?? []).filter(
    (inv) => !inv.accepted_at && !inv.revoked_at
  );

  const membershipsEnabled = (settingsResult as { data: { memberships_enabled: boolean } | null })?.data?.memberships_enabled ?? true;
  const membershipTypes = membershipTypesResult.data ?? [];

  // Phase 43B-1B — merge bulk compliance into both roster lists by
  // roster_member_id only (never name/email/local state). waiver_
  // configured is a club-wide fact (every compliance row carries the same
  // value) — hasMemberWaiverConfigured hoists it once so the UI can hide
  // the whole indicator entirely when no Member waiver document exists,
  // rather than rendering a meaningless "Not required" pill on every row.
  const complianceRows = complianceResult.data ?? [];
  const hasMemberWaiverConfigured = complianceRows.some((r) => r.waiver_configured);
  const complianceByRosterMemberId = new Map(complianceRows.map((r) => [r.roster_member_id, r.status]));
  const rosterMemberIdByClaimedBy = new Map(
    (rosterIdentityResult.data ?? [])
      .filter((r): r is { id: string; claimed_by: string } => r.claimed_by !== null)
      .map((r) => [r.claimed_by, r.id])
  );

  const membersWithWaiver = (membersResult.data ?? []).map((m) => {
    const rosterMemberId = rosterMemberIdByClaimedBy.get(m.id);
    const status = rosterMemberId ? complianceByRosterMemberId.get(rosterMemberId) : undefined;
    return { ...m, waiverStatus: status ? { status } : null };
  });

  const rosterMembersWithWaiver = (rosterResult.data ?? []).map((rm) => {
    const status = complianceByRosterMemberId.get(rm.id);
    return { ...rm, waiverStatus: status ? { status } : null };
  });

  return (
    <>
      <Header screenTitle="Members" />
      <div
        className="overflow-y-auto"
        style={{ height: "var(--page-fill-height)" }}
      >
        <MembersAreaTabs canManageMemberships={profile?.role === "admin"} />
        <div className="md:max-w-3xl md:mx-auto">
          <MembersClient
            members={membersWithWaiver}
            rosterMembers={rosterMembersWithWaiver}
            pendingInvites={pendingInvites}
            currentUserId={user.id}
            membersError={membersResult.error?.message ?? null}
            invitesError={invitesResult.error?.message ?? null}
            userRole={profile?.role ?? "member"}
            membershipsEnabled={membershipsEnabled}
            membershipTypes={membershipTypes}
            hasMemberWaiverConfigured={hasMemberWaiverConfigured}
          />
        </div>
      </div>
    </>
  );
}
