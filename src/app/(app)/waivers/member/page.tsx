import { redirect } from "next/navigation";
import Link from "next/link";
import { getAuthUser } from "@/lib/supabase/user";
import { createClient } from "@/lib/supabase/server";
import Header from "@/components/Header";
import WaiverAcceptanceClient from "./WaiverAcceptanceClient";

// Phase 43A-2 — dedicated Member waiver review/acceptance page.
// get_my_member_waiver_status() is the sole canonical read — role-agnostic
// (Member/Pro/Staff/Admin's own claimed roster identity all resolve
// identically), never exposes a draft (the RPC's own join requires
// status = 'published'). This page always shows the EXACT current version
// it just read — there is no client-supplied/invented version id anywhere
// on this route.

export default async function MemberWaiverPage() {
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  const supabase = await createClient();
  const { data: rows } = await supabase.rpc("get_my_member_waiver_status");
  const waiver = rows?.[0] ?? null;

  return (
    <>
      <Header screenTitle="Member Waiver" />
      <div className="px-4 py-6 space-y-4 md:max-w-lg md:mx-auto">
        {!waiver || waiver.status === "not_required" ? (
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-6 text-center space-y-3">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              No waiver is currently required.
            </p>
            <Link href="/profile" className="text-sm text-accent hover:underline">
              Back to Account
            </Link>
          </div>
        ) : (
          <>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
              <div className="px-4 py-3 bg-gray-50 dark:bg-gray-800/60 flex items-center justify-between gap-3 flex-wrap">
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {waiver.title ?? "Member Waiver"}
                </p>
                {waiver.version_number !== null && (
                  <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400">
                    Version {waiver.version_number}
                  </span>
                )}
              </div>
              <div className="px-4 py-3 space-y-3">
                {waiver.published_at && (
                  <p className="text-[11px] text-gray-400 dark:text-gray-500">
                    Published {new Date(waiver.published_at).toLocaleDateString()}
                  </p>
                )}
                <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
                  {waiver.body}
                </p>
              </div>
            </div>

            {waiver.current_version_id && (
              <WaiverAcceptanceClient
                key={waiver.current_version_id}
                currentVersionId={waiver.current_version_id}
                initialStatus={waiver.status as "current" | "never_accepted" | "outdated"}
                initialAcceptedAt={waiver.accepted_at}
              />
            )}

            <Link href="/profile" className="block text-center text-sm text-gray-500 dark:text-gray-400 hover:underline">
              Back to Account
            </Link>
          </>
        )}
      </div>
    </>
  );
}
