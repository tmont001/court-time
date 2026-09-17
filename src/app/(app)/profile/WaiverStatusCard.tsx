import Link from "next/link";

// Phase 43A-2 — Member Profile waiver status card. Presentational only —
// all authoritative status comes from get_my_member_waiver_status()
// (role-agnostic: Member/Pro/Staff/Admin's own claimed roster identity all
// resolve identically), fetched once by profile/page.tsx and passed in.
// Never fetches/mutates anything itself; never exposes a draft (the RPC
// itself only ever returns a published version's title/body).
//
// Phase 43B-3B — PDF-only product pivot: normal UI never shows "Version
// N" (internal version_number stays evidence/history only). versionNumber
// is no longer accepted as a prop — this card's own copy never needed it
// for anything beyond that removed parenthetical.
//
// Phase 43B-3C — never_accepted/outdated get a restrained AMBER attention
// treatment (border + light background tint + amber dot/status text) so a
// real pending action doesn't read as visually neutral. Deliberately
// amber, not red: this is a normal, expected required action, not an
// error state — red stays reserved for actual errors elsewhere in the
// app. current/accepted keeps its existing green treatment unchanged.

export interface MyWaiverStatus {
  status:        "not_required" | "current" | "outdated" | "never_accepted";
  title:         string | null;
  acceptedAt:    string | null;
}

export default function WaiverStatusCard({ status, title, acceptedAt }: MyWaiverStatus) {
  // not_required: no current required waiver exists — keep the UI quiet
  // rather than show an empty/reassuring card. Omitting the section
  // entirely is the calmest possible treatment.
  if (status === "not_required") return null;

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
        Waiver
      </p>
      <div
        className={`rounded-xl border overflow-hidden ${
          status === "current"
            ? "border-gray-200 dark:border-gray-700"
            : "border-amber-300 dark:border-amber-800/60"
        }`}
      >
        {status === "current" && (
          <div className="px-4 py-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                {title ?? "Member Waiver"}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                Accepted {acceptedAt ? new Date(acceptedAt).toLocaleDateString() : ""}
              </p>
            </div>
            <span className="shrink-0 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-400">
              Accepted
            </span>
          </div>
        )}

        {(status === "never_accepted" || status === "outdated") && (
          <div className="px-4 py-3 space-y-2 bg-amber-50 dark:bg-amber-900/20">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                {title ?? "Member Waiver"}
              </p>
              <span className="shrink-0 inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-400">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500 dark:bg-amber-400" aria-hidden="true" />
                {status === "never_accepted" ? "Needs acceptance" : "Updated waiver needs acceptance"}
              </span>
            </div>
          </div>
        )}

        <Link
          href="/waivers/member"
          className={
            status === "current"
              ? "ct-row-interactive"
              : "ct-row-interactive !bg-amber-50 dark:!bg-amber-900/20 hover:!bg-amber-100 dark:hover:!bg-amber-900/40 text-amber-900 dark:text-amber-300 font-medium"
          }
        >
          {status === "current"
            ? "View Waiver"
            : status === "outdated"
            ? "Review Updated Waiver"
            : "Review & Accept"}
          <span className={status === "current" ? "text-gray-400 dark:text-gray-500" : "text-amber-500 dark:text-amber-400"}>
            ›
          </span>
        </Link>
      </div>
    </div>
  );
}
