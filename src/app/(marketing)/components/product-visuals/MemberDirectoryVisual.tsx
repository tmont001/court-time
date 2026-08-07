import ProductFrame from "./ProductFrame";

// Mirrors the real Admin → Members page: the same roster card ("No account
// yet" pill), the same "Pending Invites" section heading and invite-row
// shape, and the same active-member row ("Active" pill) — cycling one
// fictional member through the app's actual no-account → invited → active
// path rather than an instant, automatic acceptance.

export default function MemberDirectoryVisual() {
  return (
    <ProductFrame label="Members" sublabel="24 members">
      <div className="space-y-2.5 mb-4">
        {[
          { name: "A. Chen", role: "Admin" },
          { name: "D. Reyes", role: "Pro" },
          { name: "K. Patel", role: "Member" },
        ].map((m) => (
          <div key={m.name} className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <div className="shrink-0 w-5 h-5 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-[9px] font-semibold text-gray-600 dark:text-gray-300">
                {m.name.split(" ").map((p) => p[0]).join("")}
              </div>
              <span className="text-xs text-gray-800 dark:text-gray-200 truncate">{m.name}</span>
            </div>
            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
              {m.role}
            </span>
          </div>
        ))}
      </div>

      {/* Animated card — no-account roster entry → pending invite → active member */}
      <div className="relative h-[76px]">

        {/* Phase 1 — roster card, "No account yet" (matches RosterCard) */}
        <div className="mkt-viz-stack-1 absolute inset-0 ct-card overflow-hidden">
          <div className="px-3 pt-2.5 pb-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-gray-900 dark:text-gray-100 truncate">J. Ortiz</p>
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                No account yet
              </span>
            </div>
            <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-1">j.ortiz@example.com</p>
            <p className="text-[10px] text-gray-400 mt-0.5">Member · Added Jun 2026</p>
          </div>
        </div>

        {/* Phase 2 — pending invite (matches the real "Pending Invites" section) */}
        <div className="mkt-viz-stack-2 absolute inset-0">
          <p className="text-[9px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
            Pending Invites
          </p>
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2.5 flex items-center gap-2 bg-white dark:bg-gray-800">
            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
              Member
            </span>
            <span className="text-xs text-gray-900 dark:text-gray-100 truncate">j.ortiz@example.com</span>
          </div>
        </div>

        {/* Phase 3 — active member (matches the real MembersClient row) */}
        <div className="mkt-viz-stack-3 absolute inset-0 ct-card overflow-hidden">
          <div className="px-3 pt-2.5 pb-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-gray-900 dark:text-gray-100 truncate">J. Ortiz</p>
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                Active
              </span>
            </div>
            <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-1">j.ortiz@example.com</p>
            <p className="text-[10px] text-gray-400 mt-0.5">Member · Joined Aug 2026</p>
          </div>
        </div>

      </div>
    </ProductFrame>
  );
}
