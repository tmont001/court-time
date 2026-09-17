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
//
// Phase 43B-3B — PDF-only product pivot. get_my_member_waiver_status()
// (0192/0193, applied/immutable) was never changed for this checkpoint —
// it still returns title/body exactly as before. "PDF-backed vs legacy
// text" is derived from data already in that same response: a PDF-backed
// version always has body = NULL (publish_waiver_pdf_version, 0196,
// always inserts body = null); a legacy text version has a populated
// body. No new RPC/query is needed for this page to know which case it's
// in. "Version N" is no longer shown anywhere on this page, PDF-backed or
// legacy — internal version_number stays evidence/history only.

export default async function MemberWaiverPage() {
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  const supabase = await createClient();
  const { data: rows } = await supabase.rpc("get_my_member_waiver_status");
  const waiver = rows?.[0] ?? null;
  const isPdfBacked = Boolean(waiver?.current_version_id) && waiver?.body === null;

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
            {!isPdfBacked && (
              <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
                <div className="px-4 py-3 bg-gray-50 dark:bg-gray-800/60">
                  <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {waiver.title ?? "Member Waiver"}
                  </p>
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
            )}

            {waiver.current_version_id && (
              <WaiverAcceptanceClient
                key={waiver.current_version_id}
                currentVersionId={waiver.current_version_id}
                initialStatus={waiver.status as "current" | "never_accepted" | "outdated"}
                initialAcceptedAt={waiver.accepted_at}
                isPdfBacked={isPdfBacked}
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
