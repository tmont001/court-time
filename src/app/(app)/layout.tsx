import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getAuthUser, getAuthProfile, getMyClubMemberships } from "@/lib/supabase/user";
import { createClient } from "@/lib/supabase/server";
import BottomNav from "@/components/BottomNav";
import SideNav from "@/components/SideNav";
import MemberWelcomeCard from "@/components/MemberWelcomeCard";
import StaleActiveClubGuard from "@/components/StaleActiveClubGuard";
import WaitlistOfferModal, { type WaitlistOfferData } from "@/components/WaitlistOfferModal";

const INVITE_CODE_RE = /^[0-9a-f]{32}$/;

// Phase 33G3: the single most urgent active Event waitlist offer for an
// account-backed Member — mirrors the embedded-select shape my-schedule/
// page.tsx already uses for event_participants, narrowed to status='offered'
// only (a small row set) and capped at 5 candidates, with validity
// (event still scheduled/non-archived, offer not yet expired) checked in
// JS rather than via an untested cross-table `!inner` filter. Returns the
// single most-urgent (soonest-expiring) valid offer, or null.
async function getActiveWaitlistOffer(
  userId: string,
): Promise<WaitlistOfferData | null> {
  const supabase = await createClient();
  const { data: rosterMemberId } = await supabase.rpc("current_user_roster_member_id");

  let query = supabase
    .from("event_participants")
    .select(`
      event_id,
      offer_expires_at,
      events(
        id, title, starts_at, ends_at, status, archived_at, club_id,
        event_types(label, color)
      )
    `)
    .eq("status", "offered")
    .eq("role", "participant")
    .order("offer_expires_at", { ascending: true })
    .limit(5);
  query = rosterMemberId
    ? query.or(`profile_id.eq.${userId},roster_member_id.eq.${rosterMemberId}`)
    : query.eq("profile_id", userId);

  const { data } = await query;
  const now = Date.now();

  type Row = {
    event_id: string;
    offer_expires_at: string | null;
    events: {
      id: string; title: string; starts_at: string; ends_at: string;
      status: string; archived_at: string | null; club_id: string;
      event_types: { label: string; color: string } | null;
    } | null;
  };

  const candidate = ((data ?? []) as unknown as Row[]).find(row =>
    row.events &&
    row.events.status === "scheduled" &&
    !row.events.archived_at &&
    row.offer_expires_at &&
    new Date(row.offer_expires_at).getTime() > now
  );
  if (!candidate || !candidate.events) return null;

  // Only fetched once an actual candidate exists — the common case (no
  // active offer) never pays for this extra round-trip.
  const { data: clubRow } = await supabase
    .from("clubs")
    .select("timezone")
    .eq("id", candidate.events.club_id)
    .single();

  return {
    eventId:        candidate.events.id,
    eventTitle:     candidate.events.title,
    eventTypeLabel: candidate.events.event_types?.label ?? "Event",
    eventTypeColor: candidate.events.event_types?.color ?? "#6b7280",
    startsAt:       candidate.events.starts_at,
    endsAt:         candidate.events.ends_at,
    offerExpiresAt: candidate.offer_expires_at!,
    clubId:         candidate.events.club_id,
    clubTimezone:   clubRow?.timezone ?? "America/New_York",
  };
}

export const dynamic = "force-dynamic";

// The authenticated app is never a public marketing surface — every route
// under this group requires a session and is club-specific, so none of it
// belongs in search results.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  const profile = await getAuthProfile();

  // Phase 26C1: club_id is now the caller's ACTIVE membership's club
  // (activeClubId), derived from club_memberships — not the legacy
  // profiles.club_id read directly. A user with no valid active membership
  // (never joined, or their sole membership is inactive/suspended/removed)
  // is routed to the same pending-invite flow as before; distinguishing
  // those cases for a returning multi-club user is Phase 26E's job.
  if (!profile?.club_id) {
    // If the user visited /join/<code> recently, the middleware set a cookie.
    // Redirect them to that invite page so they can accept without re-entering code.
    const cookieStore = await cookies();
    const pendingCode = cookieStore.get("ct_invite_pending")?.value ?? "";
    if (INVITE_CODE_RE.test(pendingCode)) {
      redirect(`/join/${pendingCode}`);
    }
    redirect("/pending-invite");
  }

  // Active club's theme/name come directly from get_current_account_context()
  // (via getAuthProfile) — no separate clubs query needed.
  const themeKey = profile.themeKey ?? "graphite";
  const clubName = profile.clubName ?? undefined;

  // Phase 26E1: the caller's own switchable memberships, fetched once here
  // (get_my_club_memberships, migration 0085) and passed to both nav
  // surfaces. A single-membership user gets an empty-switcher render (the
  // existing static club-name display, unchanged); two or more renders the
  // switcher — see SideNav/BottomNav.
  const memberships = await getMyClubMemberships();

  // Phase 26E2: guaranteed non-null past the redirect guard above.
  const activeClubId = profile.club_id;

  // Phase 33G3: an account-backed Member's active Event waitlist offer,
  // surfaced app-wide via a prominent modal rather than only as a list row
  // on /my-schedule. Admin/Pro are not offered Event participant spots in
  // the ordinary product flow, so this stays scoped to role==='member',
  // mirroring MemberWelcomeCard's own existing gating just below.
  const activeWaitlistOffer = profile?.role === "member"
    ? await getActiveWaitlistOffer(user.id)
    : null;

  return (
    <div className={`theme-${themeKey} min-h-screen`}>
      {/* Sidebar: fixed on desktop (md+), hidden on mobile */}
      <SideNav userRole={profile?.role ?? undefined} clubName={clubName} memberships={memberships} memberSelfService={profile?.memberSelfService ?? true} />
      {/* Content area: offset right of sidebar on desktop */}
      <div className="flex flex-col min-h-screen md:pl-60">
        <main className="flex-1 app-main-content">
          {profile?.role === "member" && profile.club_id && (
            <MemberWelcomeCard userId={user.id} clubId={profile.club_id} />
          )}
          {children}
        </main>
      </div>
      {/* Bottom nav: visible on mobile, hidden on desktop where SideNav takes over */}
      <BottomNav userRole={profile?.role ?? undefined} clubName={clubName} memberships={memberships} memberSelfService={profile?.memberSelfService ?? true} />
      {/* Phase 26E2: mounted once for the whole authenticated app shell
          (covers every (app)/* route, including nested /admin/* pages).
          Detects this tab's active-club context going stale — another tab
          switched, or the membership itself was deactivated/suspended/
          removed — and blocks interaction until reloaded. */}
      <StaleActiveClubGuard activeClubId={activeClubId} />
      {profile?.role === "member" && <WaitlistOfferModal offer={activeWaitlistOffer} />}
    </div>
  );
}
