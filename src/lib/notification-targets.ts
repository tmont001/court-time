// Phase 36A: pure notification-target resolver.
//
// Framework-independent on purpose (no React/router/Supabase imports) — see
// src/lib/auth/roles.ts for the same convention — so this can run inside
// NotificationSheet.tsx today and, later, inside server-side email/SMS
// template rendering without any change.
//
// ARCHITECTURE LOCK (Phase 36 audit): `kind` already determines the domain,
// and the domain object's own id is already present in `metadata` under an
// existing per-domain key (reservation_id / event_id / request_id) for
// every current producer. This module deliberately does NOT introduce a
// generic `target_id`/`target_domain` metadata key or a new notifications
// column — it reads the ids producers already write. Raw
// `metadata.target_path` (the pre-Phase-36 mechanism, still lesson-only and
// page-level) stays a legacy fallback, never the primary path, and is never
// removed — old rows must keep resolving exactly as they do today.
//
// Authorization is NOT this module's concern: a path returned here is only
// ever a hint for which id to fetch. The destination page/sheet performs
// its own independent, RLS-scoped fetch by that id — this resolver never
// decides who may see what, so it never falls back due to an authorization
// concern (there is none to evaluate here).

import type { Json } from "@/lib/db/types";
import { isMember } from "@/lib/auth/roles";

/** The 17 kinds currently produced (notifications_kind_check, migration
 * 0099 — the last migration to touch that constraint). Adding a kind here
 * without a matching NOTIFICATION_TARGET_MAP entry is a compile error. */
export type NotificationKind =
  | "reservation_confirmed"
  | "reservation_cancelled_by_admin"
  | "reservation_cancelled_by_member"
  | "reservation_rescheduled"
  | "event_cancelled"
  | "event_joined"
  | "event_updated"
  | "waitlist_promoted"
  | "waitlist_offer"
  | "announcement"
  | "lesson_request_received"
  | "lesson_request_proposed"
  | "lesson_request_confirmed"
  | "lesson_request_declined"
  | "lesson_cancelled"
  | "lesson_provider_reassigned"
  | "lesson_admin_requested";

export type TargetDomain = "reservation" | "event" | "lesson_request";

export interface TargetDefinition {
  domain: TargetDomain;
  /** The metadata key every current producer already writes this domain's
   * own object id under (never a new generic key). */
  idKey: string;
}

// kind -> { domain, idKey } | null (null = deliberately no structured
// destination, e.g. a broadcast announcement is not "about" one object).
export const NOTIFICATION_TARGET_MAP = {
  reservation_confirmed:           { domain: "reservation",   idKey: "reservation_id" },
  reservation_cancelled_by_admin:  { domain: "reservation",   idKey: "reservation_id" },
  reservation_cancelled_by_member: { domain: "reservation",   idKey: "reservation_id" },
  reservation_rescheduled:         { domain: "reservation",   idKey: "reservation_id" },
  event_cancelled:                 { domain: "event",         idKey: "event_id" },
  event_joined:                    { domain: "event",         idKey: "event_id" },
  event_updated:                   { domain: "event",         idKey: "event_id" },
  waitlist_promoted:                { domain: "event",         idKey: "event_id" },
  waitlist_offer:                   { domain: "event",         idKey: "event_id" },
  announcement:                     null,
  lesson_request_received:         { domain: "lesson_request", idKey: "request_id" },
  lesson_request_proposed:         { domain: "lesson_request", idKey: "request_id" },
  lesson_request_confirmed:        { domain: "lesson_request", idKey: "request_id" },
  lesson_request_declined:         { domain: "lesson_request", idKey: "request_id" },
  lesson_cancelled:                { domain: "lesson_request", idKey: "request_id" },
  lesson_provider_reassigned:      { domain: "lesson_request", idKey: "request_id" },
  lesson_admin_requested:          { domain: "lesson_request", idKey: "request_id" },
} satisfies Record<NotificationKind, TargetDefinition | null>;

// Same shape as the local UUID_RE already duplicated per-file across the
// codebase (e.g. src/lib/supabase/staleClub.ts, switchClubAction.ts,
// api/calendar/export/[domain]/[id]/route.ts) — no project-wide shared
// helper exists yet, so this reuses that exact pattern rather than adding a
// competing validator.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function isJsonObject(value: Json | null): value is { [key: string]: Json | undefined } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readMetadataId(metadata: Json | null, idKey: string): string | null {
  if (!isJsonObject(metadata)) return null;
  const value = metadata[idKey];
  return isValidUuid(value) ? value : null;
}

function getTargetDefinition(kind: string): TargetDefinition | null {
  return Object.prototype.hasOwnProperty.call(NOTIFICATION_TARGET_MAP, kind)
    ? NOTIFICATION_TARGET_MAP[kind as NotificationKind]
    : null;
}

function buildStructuredPath(
  domain: TargetDomain,
  id: string,
  viewerRole: string | null | undefined,
): string {
  const encodedId = encodeURIComponent(id);
  switch (domain) {
    case "reservation":
      return `/calendar?reservation=${encodedId}`;
    case "event":
      return `/calendar?event=${encodedId}`;
    case "lesson_request":
      // Member has its own member-facing surface; Pro/Staff/Admin all
      // share the canonical staff lesson-management surface (audit
      // confirmed no separate Pro-style request UI exists or should
      // exist) — so every non-Member role resolves to the same path.
      return isMember(viewerRole)
        ? `/my-schedule?tab=lessons&request_id=${encodedId}`
        : `/admin/lessons?lessonId=${encodedId}`;
  }
}

/**
 * Reads the pre-Phase-36 legacy `metadata.target_path` — a relative
 * application path only. Rejects absolute URLs ("http://…"),
 * protocol-relative URLs ("//…"), and anything containing a colon
 * (protocol injection). Malformed/non-string values return null.
 *
 * This is the single canonical implementation of that safety check —
 * NotificationSheet.tsx imports it rather than keeping its own copy.
 */
export function getSafeTargetPath(metadata: Json | null): string | null {
  if (!isJsonObject(metadata)) return null;
  const path = metadata.target_path;
  if (typeof path !== "string") return null;
  if (!path.startsWith("/") || path.startsWith("//") || path.includes(":")) return null;
  return path;
}

/**
 * Resolves where a notification should navigate to, or null if it
 * shouldn't navigate anywhere. Pure function — no side effects, no
 * authorization decisions (the destination's own fetch is what authorizes;
 * this only ever supplies a hint for which id to look up).
 *
 * Resolution order:
 *   1. Structured target: `kind` has a target definition AND the metadata
 *      id it names is present and a valid UUID -> canonical, role-aware
 *      path for that domain object. Wins even over a stale target_path.
 *   2. Structured target definition exists but the id is missing/malformed
 *      -> fall back to the legacy `metadata.target_path`, if safe.
 *   3. `kind` has no structured definition (including `announcement`,
 *      and any unrecognized/future kind) -> also fall back to the legacy
 *      `metadata.target_path`, if safe.
 *   4. Nothing resolves -> null.
 */
export function resolveNotificationTarget(
  kind: string,
  metadata: Json | null,
  viewerRole: string | null | undefined,
): string | null {
  const definition = getTargetDefinition(kind);

  if (definition) {
    const id = readMetadataId(metadata, definition.idKey);
    if (id) return buildStructuredPath(definition.domain, id, viewerRole);
  }

  return getSafeTargetPath(metadata);
}
