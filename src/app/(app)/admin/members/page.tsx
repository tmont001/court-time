import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Header from "@/components/Header";

const ROLE_LABELS: Record<string, string> = {
  member: "Member",
  pro: "Pro",
  admin: "Admin",
};

function formatJoinDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
  });
}

export default async function AdminMembersPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");

  const { data: members, error } = await supabase.rpc("get_members");

  return (
    <>
      <Header screenTitle="Members" />
      <div
        className="overflow-y-auto bg-gray-50"
        style={{ height: "calc(100dvh - 56px - 64px)" }}
      >
        {error ? (
          <div className="mx-4 mt-6 px-4 py-3 bg-red-50 rounded-xl border border-red-200">
            <p className="text-sm font-semibold text-red-700">Failed to load members</p>
            <p className="text-xs text-red-500 mt-1 break-all">{error.message}</p>
          </div>
        ) : !members || members.length === 0 ? (
          <div className="flex items-center justify-center h-48 text-gray-400 text-sm">
            No members yet.
          </div>
        ) : (
          <div className="pb-6 pt-3">
            {members.map((m) => {
              const fullName =
                [m.first_name, m.last_name].filter(Boolean).join(" ") ||
                "Unnamed member";
              return (
                <div
                  key={m.id}
                  className="mx-4 mb-3 px-4 py-3 bg-white rounded-xl border border-gray-200"
                >
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-gray-900">{fullName}</p>
                    <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700">
                      {ROLE_LABELS[m.role] ?? m.role}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">{m.email ?? "—"}</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {m.phone ?? "—"} · Joined {formatJoinDate(m.created_at)}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
