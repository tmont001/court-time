// Phase 36B: pure "may this viewer open this reservation's detail sheet"
// rule, extracted from CalendarShell's calendar-grid click logic (the one
// existing source of truth for this decision) so the notification-deep-link
// open path and the grid's own click-to-open behavior can never drift into
// two subtly different authorization rules.
//
// Framework-independent (no React/router/Supabase) — see
// src/lib/auth/roles.ts for the same convention.
//
// This is a UX-level pre-filter only, never the authorization boundary
// itself: the reservation row it inspects was already fetched under
// reservations_select_same_club RLS, and this function only decides
// whether to SHOW that already-authorized row's detail to this particular
// viewer — it never widens access beyond what RLS already permitted, and
// it is never a substitute for the destination's own server-side checks.

import { isOperator } from "@/lib/auth/roles";

export interface ReservationAccessRow {
  reason:         string;
  ownerUserId:    string | null;
  rosterMemberId: string | null;
}

export interface ReservationAccessViewer {
  userId:             string;
  userRosterMemberId: string | null;
  role:               string | null | undefined;
}

/** True if `viewer` is the Member/Pro this reservation belongs to — via
 * owner_user_id (a claimed account) or roster_member_id (claim-continuity:
 * the same durable roster identity, even pre-claim). Both viewer ids are
 * always server-resolved — never derived from anything client-supplied. */
export function isOwnReservation(
  reservation: ReservationAccessRow,
  viewer: ReservationAccessViewer,
): boolean {
  return (
    reservation.ownerUserId === viewer.userId ||
    (viewer.userRosterMemberId !== null && reservation.rosterMemberId === viewer.userRosterMemberId)
  );
}

/**
 * May `viewer` open this reservation's ReservationDetailSheet? Mirrors the
 * calendar grid's own isClickable rule exactly:
 *   - a lesson reservation (reason='pro_lesson') is never opened through
 *     this sheet — it has its own lesson-surface navigation
 *     (handleManageLesson / handleOpenMemberLesson), out of scope here.
 *   - a maintenance/admin block (reason not 'member_booking', not a
 *     lesson) opens for Admin only — Staff gets no maintenance access,
 *     matching the grid's existing isAdmin-only (not isOperator) check.
 *   - an ordinary member_booking reservation opens for any operator
 *     (Admin/Staff) or its own owner (Member/Pro) — never another,
 *     non-operator Member/Pro.
 */
export function canOpenReservationDetail(
  reservation: ReservationAccessRow,
  viewer: ReservationAccessViewer,
): boolean {
  if (reservation.reason === "pro_lesson") return false;
  const isBlocked = reservation.reason !== "member_booking";
  if (isBlocked) return viewer.role === "admin";
  return isOperator(viewer.role) || isOwnReservation(reservation, viewer);
}
