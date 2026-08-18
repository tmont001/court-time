// Central role/authorization vocabulary — Phase 34A2.
//
// Framework-independent on purpose: no Next.js, React, or Supabase imports.
// This module answers exactly one question — "given a role string, what can
// the caller do" — so it can be unit-tested in isolation and reused by any
// future consumer (route guards, nav, server actions) without dragging in
// request/response or database concerns.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY `Role` INCLUDES "staff" WHILE THE DATABASE DOES NOT (YET)
// ─────────────────────────────────────────────────────────────────────────
// The live database's role check constraint (profiles.role /
// club_memberships.role) only accepts 'member' | 'pro' | 'admin' as of this
// checkpoint — see the Phase 34A audit. Migration 0131 (a later checkpoint)
// will widen that constraint to add 'staff'. This module's `Role` type is
// intentionally ahead of the database: it models the LOCKED target shape
// (member/pro/staff/admin) so the predicates below never need to change
// shape when 0131 lands — only `canAccessOperationsWorkspace`'s body changes
// to admit `isStaff`.
//
// Nothing in src/lib/db/types.ts (the database-facing types) is widened by
// this file. A value read from the database is always a plain `string` at
// this module's boundary (see e.g. get_current_account_context's `role:
// string | null` return shape) — never cast to `Role` as if the database
// could truthfully produce "staff" today. All predicates below therefore
// accept `string | null | undefined`, not `Role | null | undefined`: that
// is what real callers actually have, and it avoids asserting a lie about
// what the database can return before 0131 ships.
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
// CURRENT RUNTIME BEHAVIOR — MUST NOT CHANGE IN 34A2
// ─────────────────────────────────────────────────────────────────────────
//   admin  -> operations workspace: true,  admin authority: true
//   pro    -> operations workspace: true,  admin authority: false
//   member -> operations workspace: false, admin authority: false
//   staff  -> operations workspace: false, admin authority: false  (LOCKED OFF)
// Staff is a legal value of the `Role` type so this module's shape is
// future-proof, but it carries ZERO runtime authority in this checkpoint —
// `canAccessOperationsWorkspace("staff")` returns false, exactly like
// `"member"`, until a later checkpoint deliberately flips it on alongside
// migration 0131 and its own RLS/RPC enforcement. Do not change this file to
// grant staff any access as a side effect of unrelated work.

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

/** Not yet reachable in production — no live account can have this role
 * until migration 0131 lands. Exists so callers can be written once and
 * start working the moment staff becomes a legal database value. */
export function isStaff(role: string | null | undefined): boolean {
  return role === "staff";
}

export function isAdmin(role: string | null | undefined): boolean {
  return role === "admin";
}

/**
 * May this role enter the shared operational/admin workspace shell (the
 * `/admin/*` route tree and equivalent nav) at all? This is a WORKSPACE
 * ENTRY check only — the "admin+pro" grouping already used throughout the
 * pre-34A codebase (e.g. the shared /admin route gate). It does NOT imply
 * authorization for any specific mutation: Roster/Event/Program/Lesson/etc.
 * actions remain individually gated by their own domain-specific checks
 * (RLS/RPC), which this predicate must never be used as a substitute for.
 * Staff is intentionally excluded here today: this predicate returns false
 * for "staff" until a later checkpoint's enforcement work turns it on
 * alongside the corresponding RLS/RPC changes. Do not add "staff" to this
 * check without also doing that work — see the Phase 34A audit, section 8.
 */
export function canAccessOperationsWorkspace(role: string | null | undefined): boolean {
  return isAdmin(role) || isPro(role);
}

/**
 * Club configuration / commercial / sensitive authority (Settings, Courts,
 * Members role management, Audit Log, Reports, Communications, future
 * pricing/payments). Admin-only, today and for the foreseeable future —
 * Staff does not receive this by default per the locked Phase 34A intent.
 */
export function hasAdminAuthority(role: string | null | undefined): boolean {
  return isAdmin(role);
}
