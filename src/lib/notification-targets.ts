// Phase 36A: pure notification-target resolver.
//
// Framework-independent on purpose (no React/router/Supabase imports) — see
// src/lib/auth/roles.ts for the same convention — so this can run inside
// NotificationSheet.tsx today and, later, inside server-side email/SMS
// template rendering without any change.
//
// ARCHITECTURE LOCK (Phase 36 audit): `kind` already determines the
// domain(s), and the domain object's own id is already present in
// `metadata` under an existing per-domain key (reservation_id / event_id /
// request_id / program_id) for every current producer. This module
// deliberately does NOT introduce a generic `target_id`/`target_domain`
// metadata key or a new notifications column — it reads the ids producers
// already write. Raw `metadata.target_path` (the pre-Phase-36 mechanism,
// still lesson-only and page-level) stays a legacy fallback, never the
// primary path, and is never removed — old rows must keep resolving
// exactly as they do today.
//
// Phase 36C correction: `kind` does NOT always determine a single uniform
// domain. `waitlist_offer` is genuinely polymorphic — it is produced both
// by advance_waitlist_offer/admin_offer_spot* (a single generated Event
// occurrence's own waitlist, event_id) and by
// _advance_program_waitlist_offer (a WHOLE-Program enrollment waitlist,
// program_id — there is no single occurrence to point to for that one;
// see supabase/migrations/0127_program_session_capacity_correctness.sql
// and accept_program_waitlist_offer's own p_program_id-only signature in
// 0091). Rather than pretending one idKey covers both shapes,
// NOTIFICATION_TARGET_MAP allows a kind's value to be an ORDERED LIST of
// candidate definitions — the first one whose id is present and valid
// wins. This stays a narrow, explicit special case for the one kind that
// actually needs it, not a general multi-domain mechanism.
//
// Authorization is NOT this module's concern: a path returned here is only
// ever a hint for which id to fetch. The destination page/sheet performs
// its own independent, RLS-scoped fetch by that id — this resolver never
// decides who may see what, so it never falls back due to an authorization
// concern (there is none to evaluate here).

import type { Json } from "@/lib/db/types";
import { isMember } from "@/lib/auth/roles";

/** The 19 kinds currently produced (notifications_kind_check, migration
 * 0181 — the last migration to touch that constraint; 0099 through
 * lesson_admin_requested, Phase 38B adds the final two refund-request
 * kinds). Adding a kind here without a matching NOTIFICATION_TARGET_MAP
 * entry is a compile error. */
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
  | "lesson_admin_requested"
  | "refund_request_rejected"
  | "refund_request_completed";

export type TargetDomain = "reservation" | "event" | "lesson_request" | "program";

export interface TargetDefinition {
  domain: TargetDomain;
  /** The metadata key every current producer already writes this domain's
   * own object id under (never a new generic key). */
  idKey: string;
}

// kind -> a single definition, an ORDERED LIST of candidate definitions
// (first valid id wins — see waitlist_offer below), or null (null =
// deliberately no structured destination, e.g. a broadcast announcement
// is not "about" one object).
export const NOTIFICATION_TARGET_MAP = {
  reservation_confirmed:           { domain: "reservation",   idKey: "reservation_id" },
  reservation_cancelled_by_admin:  { domain: "reservation",   idKey: "reservation_id" },
  reservation_cancelled_by_member: { domain: "reservation",   idKey: "reservation_id" },
  reservation_rescheduled:         { domain: "reservation",   idKey: "reservation_id" },
  event_cancelled:                 { domain: "event",         idKey: "event_id" },
  event_joined:                    { domain: "event",         idKey: "event_id" },
  event_updated:                   { domain: "event",         idKey: "event_id" },
  waitlist_promoted:                { domain: "event",         idKey: "event_id" },
  // Polymorphic (Phase 36C) — a single generated Event occurrence's own
  // waitlist carries event_id; a whole-Program enrollment waitlist
  // carries program_id instead. event_id is tried first: if a producer
  // ever supplied both (never happens today), the occurrence-specific
  // target wins.
  waitlist_offer: [
    { domain: "event",   idKey: "event_id" },
    { domain: "program", idKey: "program_id" },
  ],
  announcement:                     null,
  lesson_request_received:         { domain: "lesson_request", idKey: "request_id" },
  lesson_request_proposed:         { domain: "lesson_request", idKey: "request_id" },
  lesson_request_confirmed:        { domain: "lesson_request", idKey: "request_id" },
  lesson_request_declined:         { domain: "lesson_request", idKey: "request_id" },
  lesson_cancelled:                { domain: "lesson_request", idKey: "request_id" },
  lesson_provider_reassigned:      { domain: "lesson_request", idKey: "request_id" },
  lesson_admin_requested:          { domain: "lesson_request", idKey: "request_id" },
  // Phase 38B — no structured domain (no id-specific deep link is
  // required in this phase): both producers set metadata.target_path =
  // '/admin/payments' directly, so resolution falls through to the
  // legacy target_path fallback below, exactly like `announcement`. A
  // future phase could add a structured "payment" TargetDomain +
  // paymentId deep-link (mirroring the lesson ?lessonId= auto-open
  // pattern) — deliberately out of scope here.
  refund_request_rejected:         null,
  refund_request_completed:        null,
} satisfies Record<NotificationKind, TargetDefinition | readonly TargetDefinition[] | null>;

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

/** Always returns an array — a single definition is normalized to a
 * 1-element array so resolveNotificationTarget has one loop, not a branch
 * for "one definition" vs "a list of candidates". */
function getTargetDefinitions(kind: string): readonly TargetDefinition[] {
  if (!Object.prototype.hasOwnProperty.call(NOTIFICATION_TARGET_MAP, kind)) return [];
  const entry = NOTIFICATION_TARGET_MAP[kind as NotificationKind];
  if (entry === null) return [];
  return Array.isArray(entry) ? entry : [entry];
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
    case "program":
      // ProgramEnrollmentCard is the sole canonical whole-Program
      // Member surface (Phase 27D2) — one path for every role, matching
      // the fact that only Members ever receive this notification
      // variant (_advance_program_waitlist_offer's recipient is always a
      // roster member's own claimed_by account).
      return `/events?program=${encodedId}`;
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
 *   1. Structured target: `kind` has one or more candidate definitions,
 *      tried in order — the first whose named metadata id is present and
 *      a valid UUID wins (canonical, role-aware path for that domain
 *      object). For every kind except `waitlist_offer` there is exactly
 *      one candidate; `waitlist_offer` tries event_id, then program_id
 *      (see NOTIFICATION_TARGET_MAP's own comment). Wins even over a
 *      stale target_path.
 *   2. No candidate's id is present/valid (including a kind with no
 *      structured definition at all — `announcement`, or any
 *      unrecognized/future kind) -> fall back to the legacy
 *      `metadata.target_path`, if safe.
 *   3. Nothing resolves -> null.
 */
export function resolveNotificationTarget(
  kind: string,
  metadata: Json | null,
  viewerRole: string | null | undefined,
): string | null {
  for (const definition of getTargetDefinitions(kind)) {
    const id = readMetadataId(metadata, definition.idKey);
    if (id) return buildStructuredPath(definition.domain, id, viewerRole);
  }

  return getSafeTargetPath(metadata);
}
