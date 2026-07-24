import { redirect } from "next/navigation";
import Link from "next/link";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import { createClient } from "@/lib/supabase/server";
import Header from "@/components/Header";
import SignOutButton from "./SignOutButton";
import ProfileEditForm from "./ProfileEditForm";

const ROLE_LABELS: Record<string, string> = {
  member: "Member",
  pro:    "Pro",
  admin:  "Admin",
};

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  active:    { label: "Active",    className: "bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-400" },
  inactive:  { label: "Inactive",  className: "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400" },
  suspended: { label: "Suspended", className: "bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-400" },
};

export default async function ProfilePage() {
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  const profile = await getAuthProfile();

  const supabase = await createClient();
  let clubName: string | null = null;
  if (profile?.club_id) {
    const { data: club } = await supabase
      .from("clubs")
      .select("name")
      .eq("id", profile.club_id)
      .single();
    clubName = club?.name ?? null;
  }

  const status = profile?.status ?? "active";
  const statusConfig = STATUS_CONFIG[status] ?? STATUS_CONFIG.active;

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
            <div className="px-4 py-3 flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400 shrink-0">Role</span>
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {ROLE_LABELS[profile?.role ?? "member"]}
              </span>
            </div>
            <div className="px-4 py-3 flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400 shrink-0">Status</span>
              <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${statusConfig.className}`}>
                {statusConfig.label}
              </span>
            </div>
            {profile?.is_lesson_provider && (
              <div className="px-4 py-3 flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 shrink-0">Designation</span>
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-accent/10 text-accent">
                  Lesson Pro
                </span>
              </div>
            )}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 px-1">
            Role and membership status are managed by your club.
          </p>
        </div>

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
