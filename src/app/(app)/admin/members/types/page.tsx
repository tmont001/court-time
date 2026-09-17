import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import Header from "@/components/Header";
import MembersAreaTabs from "../MembersAreaTabs";
import MembershipsSection from "../MembershipsSection";
import MembershipTypesSection from "../MembershipTypesSection";

// Phase 43B-3E — relocated verbatim from the former "Memberships" group
// on /admin/settings (Phase 42C-2/42C-3B) into its own Admin Members hub
// tab. Same data reads, same components, same Admin-only gate — pure IA
// relocation, no business logic change. Admin-only, matching the RPCs'
// own gate (update_club_memberships_enabled, membership_types' admin-only
// RLS) — Staff, who has roster read/write access on the Members tab, does
// NOT gain membership-type/toggle authoring through this move.

export default async function AdminMembershipTypesPage() {
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  const profile = await getAuthProfile();
  if (profile?.role !== "admin") redirect("/calendar");

  const supabase = await createClient();
  const clubId = profile?.club_id ?? "";

  const [settingsResult, membershipTypesResult] = await Promise.all([
    supabase
      .from("club_settings")
      .select("memberships_enabled")
      .eq("club_id", clubId)
      .single(),
    // Shows ALL types (active and inactive) — Membership Types management
    // is the one surface where an inactive type must remain fully
    // visible/renamable/reactivatable, never hidden.
    supabase
      .from("membership_types")
      .select("id, name, is_active")
      .eq("club_id", clubId)
      .order("name"),
  ]);

  const membershipsEnabled = settingsResult.data?.memberships_enabled ?? true;
  const membershipTypes = membershipTypesResult.data ?? [];

  return (
    <>
      <Header screenTitle="Members" />
      {/* Phase 43B-3E2 browser-QA polish — width/centering (md:max-w-2xl
          md:mx-auto) now lives on this OUTER div, wrapping MembersAreaTabs
          alongside the padded content div below, so the tab strip aligns
          with the content it controls instead of stretching full-width on
          desktop. The inner div keeps its own px-4 (content padding) —
          MembersAreaTabs' own mx-4 margin lands on the same outer edge, so
          both stay visually aligned at every width. Purely a layout
          regrouping: no class changed, no width value added. */}
      <div className="md:max-w-2xl md:mx-auto">
        <MembersAreaTabs canManageMemberships={profile?.role === "admin"} />
        <div className="px-4 py-6 space-y-4 dark:text-gray-100">
          <MembershipsSection enabled={membershipsEnabled} />

          {membershipsEnabled && (
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                Membership Types
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Club-configurable membership categories (e.g. Adult, Junior, Senior). Deactivating a
                type keeps it attached to anyone who already has it — it just can&apos;t be newly
                assigned.
              </p>
              <MembershipTypesSection initialTypes={membershipTypes} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
