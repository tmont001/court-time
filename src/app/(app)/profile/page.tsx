import { redirect } from "next/navigation";
import Link from "next/link";
import { getAuthUser, getAuthProfile, getMyClubMemberships } from "@/lib/supabase/user";
import { createClient } from "@/lib/supabase/server";
import { createPrivilegedClient } from "@/lib/supabase/privileged";
import Header from "@/components/Header";
import ClubMembershipList from "@/components/ClubMembershipList";
import SignOutButton from "./SignOutButton";
import ProfileEditForm from "./ProfileEditForm";
import WaiverStatusCard from "./WaiverStatusCard";

// Operational (auth/access) role label — Phase 43B-3C renamed from bare
// "Role" to "Club Role" for Admin/Staff/Pro, and this label is no longer
// shown at all for an ordinary Member (see the Membership Type/Status
// domain read below instead — club_memberships.role is an authorization
// concept, not the Phase 42 membership-domain concept Members think of as
// "their membership").
const OPERATIONAL_ROLE_LABELS: Record<string, string> = {
  pro:   "Pro",
  staff: "Staff",
  admin: "Admin",
};

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  active:    { label: "Active",    className: "bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-400" },
  inactive:  { label: "Inactive",  className: "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400" },
  suspended: { label: "Suspended", className: "bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-400" },
};

// Phase 42's own domain-membership vocabulary (roster_members.
// membership_status, 0188) — duplicated here rather than imported,
// matching this codebase's established per-file small-display-helper
// convention (MembersClient.tsx/MemberDetailClient.tsx already duplicate
// this exact same map rather than share a module). Deliberately DISTINCT
// from STATUS_CONFIG above, which is club_memberships.status (the
// auth/access membership lifecycle) — these are two different domain
// concepts that must never be conflated.
const MEMBERSHIP_STATUS_LABELS: Record<string, string> = {
  active:     "Active",
  inactive:   "Inactive",
  suspended:  "Suspended",
  non_member: "Non-Member",
};

const MEMBERSHIP_STATUS_BADGE_CLASSES: Record<string, string> = {
  active:     "text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800",
  suspended:  "text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800",
  inactive:   "text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700",
  non_member: "text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/40 border-slate-200 dark:border-slate-700",
};

export default async function ProfilePage() {
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  // Phase 26C1: club name/role/status/Lesson Pro all come from
  // get_current_account_context() (via getAuthProfile) — the caller's
  // ACTIVE membership — never from legacy profiles fields directly.
  // Personal-information editing (first_name/last_name/phone) is unaffected
  // — those remain global profile fields.
  //
  // This page lives inside (app)/layout.tsx, which already redirects any
  // user with no valid active membership (no-club, or a sole membership
  // that is inactive/suspended/removed) to /pending-invite (or /join/<code>)
  // before this component ever renders — see (app)/layout.tsx. In Phase
  // 26C1, that means hasActiveMembership below is always true whenever this
  // page actually runs; the no-active-membership branch (clubName/role/
  // status all null, "—" display) is dead code today, kept only so this
  // page renders correctly once Phase 26E changes what the parent layout
  // allows through. Dedicated inactive-account messaging/routing is Phase
  // 26E's job, not this checkpoint's. Own-profile SELECT/UPDATE access for
  // such a user is already correctly protected at the database layer by
  // migration 0082's profiles_select_same_club/profiles_update_own_row
  // corrections, independent of what this page currently renders.
  const supabase = await createClient();
  const profile = await getAuthProfile();
  const clubName = profile?.clubName ?? null;
  const hasActiveMembership = Boolean(profile?.activeClubId);
  const status = profile?.status ?? "active";
  const statusConfig = STATUS_CONFIG[status] ?? STATUS_CONFIG.active;
  const isOperationalRole = hasActiveMembership && profile?.role !== "member" && profile?.role != null;

  // Phase 43B-3C — Phase 42 domain-membership read (roster_members.
  // membership_status/membership_type_id -> membership_types.name),
  // deliberately NOT club_memberships.role/status (the auth/access model
  // already shown above) — an ordinary Member's real "membership" is this
  // domain concept, not their access role. roster_members has admin(+
  // staff)-only RLS (0056/0132), so a Member cannot read even their OWN
  // row through the normal client — this narrow, server-only read is
  // scoped entirely by already-verified server-side values (this
  // request's own authenticated user id and active club id, never
  // anything client-supplied), exactly the createPrivilegedClient()
  // precedent from 43B-3B's Settings data-loading. No new RPC/migration
  // needed for this narrow a read.
  let membershipsEnabled = true;
  let membershipStatus: string | null = null;
  let membershipTypeName: string | null = null;
  if (hasActiveMembership && profile?.role === "member" && profile.activeClubId) {
    const { data: settingsRow } = await supabase
      .from("club_settings")
      .select("memberships_enabled")
      .eq("club_id", profile.activeClubId)
      .maybeSingle();
    membershipsEnabled = settingsRow?.memberships_enabled ?? true;

    if (membershipsEnabled) {
      const privileged = createPrivilegedClient();
      if (privileged) {
        const { data: rosterRow } = await privileged
          .from("roster_members")
          .select("membership_status, membership_type_id")
          .eq("club_id", profile.activeClubId)
          .eq("claimed_by", user.id)
          .maybeSingle();

        membershipStatus = rosterRow?.membership_status ?? null;

        if (rosterRow?.membership_type_id) {
          const { data: typeRow } = await privileged
            .from("membership_types")
            .select("name")
            .eq("id", rosterRow.membership_type_id)
            .maybeSingle();
          membershipTypeName = typeRow?.name ?? null;
        }
      }
    }
  }

  // Phase 26E1: read-only membership list — shown only for a genuinely
  // multi-club account (never for a single membership, matching the
  // existing "Club Membership" card above for that common case). Inactive/
  // suspended/removed memberships are never included — get_my_club_
  // memberships() (migration 0085) excludes them entirely, not just
  // hidden client-side. No leave/remove/reactivate control exists here;
  // selecting another club switches to it via the same shared component/
  // action used by the desktop and mobile switchers.
  const memberships = await getMyClubMemberships();
  const hasMultipleClubs = memberships.length > 1;

  // Phase 43A-2 — role-agnostic (decision 6): resolves the caller's OWN
  // claimed roster identity server-side, regardless of Member/Pro/Staff/
  // Admin role. A caller with no claimed roster identity (no_roster_
  // identity) simply gets no waiver card — same quiet omission as
  // not_required, never an error banner on this page.
  const { data: waiverStatusRows } = await supabase.rpc("get_my_member_waiver_status");
  const waiverStatus = waiverStatusRows?.[0] ?? null;

  return (
    <>
      <Header screenTitle="Account" />
      <div className="px-4 py-6 space-y-6 md:max-w-lg md:mx-auto">

        {/* ── Account ─────────────────────────────────────────────── */}
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Account
          </p>
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            <div className="px-4 py-3 flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400 shrink-0">Email</span>
              <span className="text-sm text-gray-900 dark:text-gray-100 truncate text-right">
                {user.email}
              </span>
            </div>
          </div>
        </div>

        <hr className="border-gray-100 dark:border-gray-800" />

        {/* ── Personal Information ─────────────────────────────────── */}
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Personal Information
          </p>
          <ProfileEditForm
            firstName={profile?.first_name ?? null}
            lastName={profile?.last_name ?? null}
            phone={profile?.phone ?? null}
          />
        </div>

        <hr className="border-gray-100 dark:border-gray-800" />

        {/* ── Club Membership ──────────────────────────────────────── */}
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Club Membership
          </p>
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700 overflow-hidden">
            <div className="px-4 py-3 flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400 shrink-0">Club</span>
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate text-right">
                {clubName ?? "—"}
              </span>
            </div>

            {/* Operational (auth/access) roles: Admin/Staff/Pro — "Club
                Role", not bare "Role", and this whole branch never renders
                for an ordinary Member (see the Membership Type/Status
                domain branch below instead). */}
            {isOperationalRole && (
              <div className="px-4 py-3 flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 shrink-0">Club Role</span>
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {OPERATIONAL_ROLE_LABELS[profile?.role ?? ""] ?? profile?.role}
                </span>
              </div>
            )}
            {isOperationalRole && (
              <div className="px-4 py-3 flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 shrink-0">Status</span>
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${statusConfig.className}`}>
                  {statusConfig.label}
                </span>
              </div>
            )}
            {isOperationalRole && profile?.is_lesson_provider && (
              <div className="px-4 py-3 flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 shrink-0">Designation</span>
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-accent/10 text-accent">
                  Lesson Pro
                </span>
              </div>
            )}

            {/* Ordinary Member: the real Phase 42 domain-membership
                concept (Membership Type / Membership Status), never the
                auth/access role or club_memberships.status — see the
                read above for why. Memberships-disabled and unassigned-
                type are both handled gracefully; no value is fabricated. */}
            {hasActiveMembership && profile?.role === "member" && membershipsEnabled && (
              <div className="px-4 py-3 flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 shrink-0">Membership Type</span>
                {membershipTypeName ? (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full border text-xs font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600">
                    {membershipTypeName}
                  </span>
                ) : (
                  <span className="text-sm text-gray-400 dark:text-gray-500">Not assigned</span>
                )}
              </div>
            )}
            {hasActiveMembership && profile?.role === "member" && membershipsEnabled && membershipStatus && (
              <div className="px-4 py-3 flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 shrink-0">Membership Status</span>
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-xs font-medium ${MEMBERSHIP_STATUS_BADGE_CLASSES[membershipStatus] ?? MEMBERSHIP_STATUS_BADGE_CLASSES.inactive}`}>
                  {MEMBERSHIP_STATUS_LABELS[membershipStatus] ?? membershipStatus}
                </span>
              </div>
            )}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 px-1">
            {!hasActiveMembership
              ? "You don't currently have an active club membership."
              : isOperationalRole
              ? "Role and status are managed by your club."
              : membershipsEnabled
              ? "Membership type and status are managed by your club."
              : "Your club doesn't currently use membership types."}
          </p>
        </div>

        {waiverStatus && waiverStatus.status !== "not_required" && (
          <>
            <hr className="border-gray-100 dark:border-gray-800" />
            <WaiverStatusCard
              status={waiverStatus.status}
              title={waiverStatus.title}
              acceptedAt={waiverStatus.accepted_at}
            />
          </>
        )}

        {hasMultipleClubs && (
          <>
            <hr className="border-gray-100 dark:border-gray-800" />

            {/* ── Clubs ─────────────────────────────────────────────── */}
            <div className="space-y-2">
              <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                Clubs
              </p>
              <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
                <ClubMembershipList memberships={memberships} />
              </div>
            </div>
          </>
        )}

        <hr className="border-gray-100 dark:border-gray-800" />

        {/* ── Preferences & Support ────────────────────────────────── */}
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Preferences &amp; Support
          </p>
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700 overflow-hidden">
            <Link href="/profile/notifications" className="ct-row-interactive">
              <div>
                <p>Notification Preferences</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  Choose which alerts you receive.
                </p>
              </div>
              <span className="text-gray-400 dark:text-gray-500">›</span>
            </Link>
            <Link href="/profile/security" className="ct-row-interactive">
              <div>
                <p>Account Security</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  Change your password.
                </p>
              </div>
              <span className="text-gray-400 dark:text-gray-500">›</span>
            </Link>
            <Link href="/help" className="ct-row-interactive">
              Help &amp; Rules
              <span className="text-gray-400 dark:text-gray-500">›</span>
            </Link>
          </div>
        </div>

        <SignOutButton />
      </div>
    </>
  );
}
