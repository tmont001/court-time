// Central role/authorization vocabulary — Phase 34A2, widened in 34A4.
//
// Framework-independent on purpose: no Next.js, React, or Supabase imports.
// This module answers exactly one question — "given a role string, what can
// the caller do" — so it can be unit-tested in isolation and reused by any
// future consumer (route guards, nav, server actions) without dragging in
// request/response or database concerns.
//
// ─────────────────────────────────────────────────────────────────────────
// `Role` vs THE DATABASE-FACING TYPES
// ─────────────────────────────────────────────────────────────────────────
// Migration 0131 (Phase 34A3, applied) widened the live database's role
// check constraint (profiles.role/club_memberships.role) to accept 'staff'.
// This module's `Role` type models that same four-value shape. Migration
// 0132 (Phase 34A4, drafted, not yet applied as of this comment) is what
// gives 'staff' actual operational authority at the RLS/RPC layer —
// `canAccessOperationsWorkspace`/`isOperator` below reflect the INTENDED
// post-0132 state; see the Phase 34A4 report for the full RPC/RLS mapping.
//
// A value read from the database is always a plain `string` at this
// module's boundary (see e.g. get_current_account_context's `role: string |
// null` return shape) — predicates below accept `string | null | undefined`,
// not `Role | null | undefined`, matching what real callers actually have.
//
// ─────────────────────────────────────────────────────────────────────────
// LESSON-PROVIDER IDENTITY IS A SEPARATE AXIS — NOT MODELED HERE
// ─────────────────────────────────────────────────────────────────────────
// Whether someone teaches (`is_lesson_provider`, on profiles/club_memberships)
// is orthogonal to role and is not derived from any predicate in this file.
// Locked future shape (see the Phase 34A audit / 34A2 brief):
//   Member        -> role=member, is_lesson_provider=false
//   Pro           -> role=pro,    is_lesson_provider=true
//   Staff         -> role=staff,  is_lesson_provider=false
//   Staff + Pro   -> role=staff,  is_lesson_provider=true
//   Admin         -> role=admin,  is_lesson_provider=true or false
// A caller that needs both facts reads `is_lesson_provider` directly from
// the profile/membership row alongside calling a predicate here — this
// module deliberately does not accept or return that field, so it can
// never conflate "is a provider" with "has operational/admin authority".
//
// ─────────────────────────────────────────────────────────────────────────
// CURRENT RUNTIME BEHAVIOR — Phase 34A4
// ─────────────────────────────────────────────────────────────────────────
//   admin  -> operations workspace: true,  admin authority: true,  operator: true
//   staff  -> operations workspace: true,  admin authority: false, operator: true
//   pro    -> operations workspace: true,  admin authority: false, operator: false
//   member -> operations workspace: false, admin authority: false, operator: false
// Staff gained workspace entry and operator status in Phase 34A4, alongside
// migration 0132's matching RLS/RPC widenings (get_members,
// admin_create_member_reservation, admin_create_member_lesson,
// create_club_invite restricted to Member-role invites, etc. — see the
// Phase 34A4 report for the complete list). Every genuinely admin-only
// page/RPC (Settings, Courts, Event Types, commercial tier, Audit Log,
// Reports, role/employee-authority changes, broad announcements) keeps its
// own separate, positive admin-only check — `canAccessOperationsWorkspace`
// was NEVER the sole gate for any of those, so widening it here does not
// change their behavior. See src/app/(app)/admin/*/page.tsx for the
// per-page enforcement this predicate does not replace.

/** The locked target role set. Not yet fully legal in the database — see
 * the module comment above. */
export type Role = "member" | "pro" | "staff" | "admin";

const ALL_ROLES: readonly Role[] = ["member", "pro", "staff", "admin"];

/** Narrows an arbitrary string (as read from auth/profile data) to `Role`,
 * or `null` if it isn't one of the four known values. Never throws. */
export function parseRole(value: string | null | undefined): Role | null {
  if (value != null && (ALL_ROLES as readonly string[]).includes(value)) {
    return value as Role;
  }
  return null;
}

export function isMember(role: string | null | undefined): boolean {
  return role === "member";
}

export function isPro(role: string | null | undefined): boolean {
  return role === "pro";
}

export function isStaff(role: string | null | undefined): boolean {
  return role === "staff";
}

export function isAdmin(role: string | null | undefined): boolean {
  return role === "admin";
}

/**
 * May this role enter the shared operational/admin workspace shell (the
 * `/admin/*` route tree and equivalent nav) at all? This is a WORKSPACE
 * ENTRY check only — admin+pro+staff as of Phase 34A4. It does NOT imply
 * authorization for any specific mutation: Roster/Event/Program/Lesson/etc.
 * actions remain individually gated by their own domain-specific checks
 * (RLS/RPC) — most of which are narrower than this predicate (e.g. Members/
 * Roster is admin+staff only, never pro; see `isOperator` below) — which
 * this predicate must never be used as a substitute for. Every Admin-only
 * page under /admin/* enforces its own separate, positive admin-only check
 * independent of this one (verified per-page in the Phase 34A4 report) —
 * widening this function does not, by itself, grant Staff (or Pro) access
 * to any of those pages.
 */
export function canAccessOperationsWorkspace(role: string | null | undefined): boolean {
  return isAdmin(role) || isPro(role) || isStaff(role);
}

/**
 * Generic club OPERATOR authority: Admin or Staff, and — deliberately —
 * never Pro. Pro's operational access is either provider-scoped (acting as
 * themselves) or a separate, narrower case handled individually per
 * domain (see the Phase 34A4 report's Lessons section for the concrete
 * example: a Pro may create a lesson only where they are the assigned
 * provider, while Admin/Staff may assign any eligible provider) — Pro must
 * never be granted this broader, generic operator check as a shortcut.
 * Mirrors the SQL current_user_is_operator() helper introduced in
 * migration 0132; used for route/page gating that needs the SAME
 * admin-or-staff (not admin-or-pro-or-staff) boundary as the underlying
 * RPC it calls — e.g. the Members/Roster pages, which call get_members()/
 * get_admin_member_detail() (admin+staff only, migration 0132) and would
 * be a broken experience for a Pro who passed a broader page gate only to
 * have the RPC underneath reject them.
 */
export function isOperator(role: string | null | undefined): boolean {
  return isAdmin(role) || isStaff(role);
}

/**
 * Club configuration / commercial / sensitive authority (Settings, Courts,
 * Event Type configuration, commercial tier/entitlement, Audit Log,
 * Reports, employee/role-authority changes, broadcast Communications,
 * future pricing/payments). Admin-only, today and for the foreseeable
 * future — Staff does not receive this, per the locked Phase 34A intent
 * reaffirmed in 34A4: Staff gets OPERATIONAL authority, never
 * CONTROL-PLANE authority.
 */
export function hasAdminAuthority(role: string | null | undefined): boolean {
  return isAdmin(role);
}
