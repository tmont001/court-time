import { redirect } from "next/navigation";
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
      <div className="px-4 py-6 space-y-4">
        <div className="space-y-1">
          <p className="text-lg font-semibold text-gray-900">
            {profile?.first_name ?? ""} {profile?.last_name ?? ""}
          </p>
          <p className="text-sm text-gray-500">{user.email}</p>
        </div>

        <div>
          <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700">
            {ROLE_LABELS[profile?.role ?? "member"]}
          </span>
        </div>

        <hr className="border-gray-100" />

        <ProfileEditForm
          firstName={profile?.first_name ?? null}
          lastName={profile?.last_name ?? null}
          phone={profile?.phone ?? null}
        />

        <SignOutButton />
      </div>
    </>
  );
}
