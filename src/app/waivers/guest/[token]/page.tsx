import type { Metadata } from "next";
import { resolveGuestWaiverInvitation } from "./resolveGuestWaiver";
import GuestWaiverAcceptanceClient from "./GuestWaiverAcceptanceClient";

// Phase 43B-4B — the first public, unauthenticated Guest waiver page.
// Deliberately NOT under (app) (its layout.tsx redirects every
// unauthenticated request to /sign-in) or (auth) (a transactional
// account-flow group this isn't part of) — a bare top-level route, like
// /join/[code], inheriting only the root layout. Possession of the raw
// bearer token in the URL is this Guest's entire authority; there is no
// sign-in, no account, and no client-supplied id anywhere on this route.
//
// force-dynamic: this page's entire content is derived from the token
// path segment and the database's current state at request time — never
// statically generated/cached across different tokens.
export const dynamic = "force-dynamic";

// A transactional, per-link page tied to one specific Guest — never
// indexed, matching (auth)'s own robots posture for the same reason.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// Locked, non-security-disclosing copy — every failure mode (malformed
// token, unknown/revoked token, removed/cancelled Guest slot, cancelled
// reservation, cancelled/archived Event) collapses to this ONE generic
// state. resolveGuestWaiverInvitation already returns null uniformly for
// all of those (0198's own resolve_guest_waiver_invitation design) — nothing
// here re-derives or exposes which condition actually failed.
function UnavailableState() {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-8 text-center space-y-2">
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
        This waiver link is no longer available.
      </p>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Contact the club for a new link.
      </p>
    </div>
  );
}

// The resolver found a valid invitation, but the club's Guest waiver is
// either not currently required or has no current published version —
// this is a legitimate, safe state, never treated as a security error
// (0198's own resolve_guest_waiver_invitation returns this as VALUES on a
// real row, not as a failed resolution).
function NotRequiredState() {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-8 text-center space-y-2">
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
        No waiver is currently required for this guest.
      </p>
    </div>
  );
}

export default async function GuestWaiverPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const resolved = await resolveGuestWaiverInvitation(token);

  return (
    <div className="px-4 py-10 space-y-4 md:max-w-lg md:mx-auto">
      <div className="text-center space-y-1">
        {resolved?.clubName && (
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
            {resolved.clubName}
          </p>
        )}
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Guest Waiver</h1>
        {resolved?.guestDisplayName && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            For {resolved.guestDisplayName}
          </p>
        )}
      </div>

      {!resolved ? (
        <UnavailableState />
      ) : !resolved.currentVersionId || !resolved.isRequired ? (
        <NotRequiredState />
      ) : (
        <>
          {/* Legacy text-backed current version (pre-apply correction):
              rendered directly here, server-side, exactly like /waivers/
              member/page.tsx renders its own legacy body — the Guest sees
              it simply by loading the page, no separate "open" action. */}
          {!resolved.isPdfBacked && resolved.versionBody && (
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
              <div className="px-4 py-3 bg-gray-50 dark:bg-gray-800/60">
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {resolved.versionTitle ?? "Guest Waiver"}
                </p>
              </div>
              <div className="px-4 py-3">
                <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
                  {resolved.versionBody}
                </p>
              </div>
            </div>
          )}

          <GuestWaiverAcceptanceClient
            key={`${resolved.invitationId}:${resolved.currentVersionId}`}
            rawToken={token}
            invitationId={resolved.invitationId}
            currentVersionId={resolved.currentVersionId}
            versionTitle={resolved.versionTitle}
            isPdfBacked={resolved.isPdfBacked}
            legacyBody={resolved.versionBody}
            initialAccepted={resolved.isCurrentAccepted}
            initialAcceptedAt={resolved.acceptedAt}
          />
        </>
      )}
    </div>
  );
}
