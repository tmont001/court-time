import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import Header from "@/components/Header";
import SignOutButton from "./SignOutButton";
import ProfileEditForm from "./ProfileEditForm";

const ROLE_LABELS: Record<string, string> = {
  member: "Member",
  pro: "Pro",
  admin: "Admin",
};

export default async function ProfilePage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/sign-in");

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  return (
    <>
      <Header screenTitle="Profile" />
      <div className="px-4 py-6 space-y-4 md:max-w-lg md:mx-auto">
        <div className="space-y-1">
          <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {profile?.first_name ?? ""} {profile?.last_name ?? ""}
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400">{user.email}</p>
        </div>

        <div>
          <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300">
            {ROLE_LABELS[profile?.role ?? "member"]}
          </span>
        </div>

        <hr className="border-gray-100 dark:border-gray-800" />

        <ProfileEditForm
          firstName={profile?.first_name ?? null}
          lastName={profile?.last_name ?? null}
          phone={profile?.phone ?? null}
          smsOptIn={profile?.sms_opt_in ?? false}
        />

        {profile?.role === "admin" && (
          <>
            <hr className="border-gray-100 dark:border-gray-800" />
            <div className="space-y-2">
              <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                Admin
              </p>
              <div className="rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700 overflow-hidden">
                <Link
                  href="/admin/members"
                  className="flex items-center justify-between px-4 py-3 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100"
                >
                  Members
                  <span className="text-gray-400 dark:text-gray-500">›</span>
                </Link>
                <Link
                  href="/admin/courts"
                  className="flex items-center justify-between px-4 py-3 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100"
                >
                  Courts
                  <span className="text-gray-400 dark:text-gray-500">›</span>
                </Link>
                <Link
                  href="/admin/settings"
                  className="flex items-center justify-between px-4 py-3 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100"
                >
                  Settings
                  <span className="text-gray-400 dark:text-gray-500">›</span>
                </Link>
                <Link
                  href="/admin/audit-log"
                  className="flex items-center justify-between px-4 py-3 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100"
                >
                  Audit Log
                  <span className="text-gray-400 dark:text-gray-500">›</span>
                </Link>
              </div>
            </div>
          </>
        )}

        <hr className="border-gray-100 dark:border-gray-800" />

        {/* ── Notifications ── */}
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Notifications
          </p>
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            <Link
              href="/profile/notifications"
              className="flex items-center justify-between px-4 py-3 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100"
            >
              <div>
                <p>Notification Preferences</p>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                  Choose which alerts you receive.
                </p>
              </div>
              <span className="text-gray-400 dark:text-gray-500">›</span>
            </Link>
          </div>
        </div>

        <hr className="border-gray-100 dark:border-gray-800" />

        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Help
          </p>
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            <Link
              href="/help"
              className="flex items-center justify-between px-4 py-3 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100"
            >
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
