// Phase 34G-C2 — batched domain-context hydration for the Payments CSV
// exports (Outstanding Balances + Payment Activity). Deliberately a NEW,
// independent implementation of the same query PATTERN page.tsx already
// uses (reservations/lesson_requests/event_participants/event_guests/
// program_enrollments/roster_members, then courts/profiles/events/
// programs) — not an extraction FROM page.tsx and not imported BY it. Per
// the explicit checkpoint instruction: "reuse the existing approach... do
// NOT refactor /admin/payments wholesale just to build the export." A
// wholesale extraction would mean reworking page.tsx's own tightly-coupled
// inline logic, which is out of scope; this file instead accepts a small,
// deliberate amount of duplication as the lower-risk path, shared ONLY
// between this checkpoint's two new Server Actions.
//
// Correction pass (Issue 3) — every bulk `.in("id", ids)` lookup here now
// goes through fetchRowsByIdsExhaustively: de-duplicated, chunked (never
// one arbitrarily large IN-list), and exhaustively paginated per chunk
// (never a one-shot .select() that PostgREST could silently cap). An
// "All activity" Payment Activity export, or a long-lived club's
// Outstanding Balances export, can plausibly reference >1000 distinct
// reservations/events/profiles/etc. — a one-shot read here would silently
// truncate real financial/operational data. Any read error fails the
// WHOLE export (propagated up, never a partial-success hydration map).
//
// Correction pass (Issue 2) — ExportDomainContext now also carries
// `collectible: boolean`, computed via the SAME cancelled-family gate that
// governs whether Record Payment may be offered (src/app/(app)/admin/
// payments/paymentContext.ts's `is*Collectible` predicates, extracted from
// page.tsx's own inline logic in this same correction pass) — never a
// competing definition.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";
import { fetchRowsByIdsExhaustively } from "@/lib/supabase/exhaustiveRange";
import { formatClubLocalDateTime } from "./exportLogic";
import {
  reservationLifecycleLabel,
  lessonRequestLifecycleLabel,
  eventParticipantLifecycleLabel,
  eventGuestLifecycleLabel,
  programEnrollmentLifecycleLabel,
  isReservationCollectible,
  isLessonRequestCollectible,
  isEventParticipantCollectible,
  isEventGuestCollectible,
  isProgramEnrollmentCollectible,
} from "./paymentContext";

export type ExportDomainType =
  | "reservation" | "lesson_request" | "event_participant" | "event_guest" | "program_enrollment";

export const DOMAIN_TYPE_LABEL: Record<ExportDomainType, string> = {
  reservation:        "Court Reservation",
  lesson_request:     "Lesson",
  event_participant:  "Event",
  event_guest:        "Event (Guest)",
  program_enrollment: "Program",
};

export interface ExportDomainContext {
  identityName: string;
  title: string;
  domainTypeLabel: string;
  serviceDateTime: string;
  lifecycleLabel: string | null;
  // Issue 2 — true unless the domain's own (or its parent's) status is
  // cancelled-family, mirroring Record Payment's existing gate exactly.
  collectible: boolean;
}

export interface DomainHydrationInput {
  paymentId: string;
  domainType: ExportDomainType;
  domainId: string;
  rosterMemberId: string | null;
}

export interface HydrationFailure {
  error: string;
}

function isFailure(x: unknown): x is HydrationFailure {
  return typeof x === "object" && x !== null && "error" in x;
}

// Fetches and hydrates domain context for a batch of payments, keyed by
// payment id. Completeness pass — a financial export must never silently
// drop a row: a payment whose REQUIRED domain/parent row cannot be
// resolved (the domain's own row for every type, PLUS the parent Event for
// event_participant/event_guest, PLUS the parent Program for
// program_enrollment) now returns a HydrationFailure for the WHOLE batch
// rather than merely omitting that one payment from the map. Returns a
// HydrationFailure (never a partial map) if ANY underlying chunked/
// exhaustive read fails too — the caller must abort the export rather than
// ship data hydrated from an incomplete lookup, or silently short a
// genuinely outstanding/activity row. SUPPORTING display-only lookups (a
// Court's name, a Pro's profile, a roster Member's display name) are
// unaffected — those keep their existing neutral fallback text, since they
// are never needed to establish financial/domain identity or
// collectibility.
export async function hydrateExportDomainContext(
  supabase: SupabaseClient<Database>,
  inputs: DomainHydrationInput[],
  clubTimezone: string,
): Promise<Map<string, ExportDomainContext> | HydrationFailure> {
  const idsByDomain: Record<ExportDomainType, string[]> = {
    reservation: [], lesson_request: [], event_participant: [], event_guest: [], program_enrollment: [],
  };
  const rosterMemberIds = new Set<string>();
  for (const p of inputs) {
    idsByDomain[p.domainType].push(p.domainId);
    if (p.rosterMemberId) rosterMemberIds.add(p.rosterMemberId);
  }

  const [
    reservationsResult, lessonRequestsResult, eventParticipantsResult,
    eventGuestsResult, programEnrollmentsResult, rosterMembersResult,
  ] = await Promise.all([
    fetchRowsByIdsExhaustively<{ id: string; court_id: string; starts_at: string; ends_at: string; status: string }>(
      idsByDomain.reservation,
      async (chunkIds, offset, limit) => {
        const result = await supabase
          .from("reservations")
          .select("id, court_id, starts_at, ends_at, status")
          .in("id", chunkIds)
          .order("id", { ascending: true })
          .range(offset, offset + limit - 1);
        return { data: result.data, error: result.error };
      },
    ),
    fetchRowsByIdsExhaustively<{ id: string; pro_id: string; proposed_starts_at: string | null; proposed_ends_at: string | null; status: string }>(
      idsByDomain.lesson_request,
      async (chunkIds, offset, limit) => {
        // Same pre-existing db/types.ts staleness workaround page.tsx
        // already carries for this exact table.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (supabase.from as any)("lesson_requests")
          .select("id, pro_id, proposed_starts_at, proposed_ends_at, status")
          .in("id", chunkIds)
          .order("id", { ascending: true })
          .range(offset, offset + limit - 1);
        return { data: result.data, error: result.error };
      },
    ),
    fetchRowsByIdsExhaustively<{ id: string; event_id: string; status: string }>(
      idsByDomain.event_participant,
      async (chunkIds, offset, limit) => {
        const result = await supabase
          .from("event_participants")
          .select("id, event_id, status")
          .in("id", chunkIds)
          .order("id", { ascending: true })
          .range(offset, offset + limit - 1);
        return { data: result.data, error: result.error };
      },
    ),
    fetchRowsByIdsExhaustively<{ id: string; event_id: string; display_name: string }>(
      idsByDomain.event_guest,
      async (chunkIds, offset, limit) => {
        const result = await supabase
          .from("event_guests")
          .select("id, event_id, display_name")
          .in("id", chunkIds)
          .order("id", { ascending: true })
          .range(offset, offset + limit - 1);
        return { data: result.data, error: result.error };
      },
    ),
    fetchRowsByIdsExhaustively<{ id: string; program_id: string; status: string }>(
      idsByDomain.program_enrollment,
      async (chunkIds, offset, limit) => {
        const result = await supabase
          .from("program_enrollments")
          .select("id, program_id, status")
          .in("id", chunkIds)
          .order("id", { ascending: true })
          .range(offset, offset + limit - 1);
        return { data: result.data, error: result.error };
      },
    ),
    fetchRowsByIdsExhaustively<{ id: string; first_name: string; last_name: string }>(
      [...rosterMemberIds],
      async (chunkIds, offset, limit) => {
        const result = await supabase
          .from("roster_members")
          .select("id, first_name, last_name")
          .in("id", chunkIds)
          .order("id", { ascending: true })
          .range(offset, offset + limit - 1);
        return { data: result.data, error: result.error };
      },
    ),
  ]);

  for (const r of [reservationsResult, lessonRequestsResult, eventParticipantsResult, eventGuestsResult, programEnrollmentsResult, rosterMembersResult]) {
    if (r.error) return { error: r.error };
  }

  const reservations = reservationsResult.rows;
  const lessonRequests = lessonRequestsResult.rows;
  const eventParticipants = eventParticipantsResult.rows;
  const eventGuests = eventGuestsResult.rows;
  const programEnrollments = programEnrollmentsResult.rows;
  const rosterMembers = rosterMembersResult.rows;

  const courtIds = [...new Set(reservations.map(r => r.court_id))];
  const proIds = [...new Set(lessonRequests.map(r => r.pro_id))];
  const eventIds = [...new Set([...eventParticipants.map(p => p.event_id), ...eventGuests.map(g => g.event_id)])];
  const programIds = [...new Set(programEnrollments.map(e => e.program_id))];

  const [courtsResult, prosResult, eventsResult, programsResult] = await Promise.all([
    fetchRowsByIdsExhaustively<{ id: string; name: string }>(
      courtIds,
      async (chunkIds, offset, limit) => {
        const result = await supabase.from("courts").select("id, name").in("id", chunkIds).order("id", { ascending: true }).range(offset, offset + limit - 1);
        return { data: result.data, error: result.error };
      },
    ),
    fetchRowsByIdsExhaustively<{ id: string; first_name: string | null; last_name: string | null }>(
      proIds,
      async (chunkIds, offset, limit) => {
        const result = await supabase.from("profiles").select("id, first_name, last_name").in("id", chunkIds).order("id", { ascending: true }).range(offset, offset + limit - 1);
        return { data: result.data, error: result.error };
      },
    ),
    fetchRowsByIdsExhaustively<{ id: string; title: string; starts_at: string; ends_at: string; status: string }>(
      eventIds,
      async (chunkIds, offset, limit) => {
        const result = await supabase.from("events").select("id, title, starts_at, ends_at, status").in("id", chunkIds).order("id", { ascending: true }).range(offset, offset + limit - 1);
        return { data: result.data, error: result.error };
      },
    ),
    fetchRowsByIdsExhaustively<{ id: string; title: string; starts_on: string; status: string }>(
      programIds,
      async (chunkIds, offset, limit) => {
        const result = await supabase.from("programs").select("id, title, starts_on, status").in("id", chunkIds).order("id", { ascending: true }).range(offset, offset + limit - 1);
        return { data: result.data, error: result.error };
      },
    ),
  ]);

  for (const r of [courtsResult, prosResult, eventsResult, programsResult]) {
    if (r.error) return { error: r.error };
  }

  const courtName = new Map(courtsResult.rows.map(c => [c.id, c.name]));
  const proName = new Map(prosResult.rows.map(p => [p.id, [p.first_name, p.last_name].filter(Boolean).join(" ") || "Pro"]));
  const eventById = new Map(eventsResult.rows.map(e => [e.id, e]));
  const programById = new Map(programsResult.rows.map(p => [p.id, p]));
  const rosterName = new Map(rosterMembers.map(m => [m.id, [m.first_name, m.last_name].filter(Boolean).join(" ") || "Unknown"]));
  const reservationById = new Map(reservations.map(r => [r.id, r]));
  const lessonRequestById = new Map(lessonRequests.map(r => [r.id, r]));
  const eventParticipantById = new Map(eventParticipants.map(p => [p.id, p]));
  const eventGuestById = new Map(eventGuests.map(g => [g.id, g]));
  const programEnrollmentById = new Map(programEnrollments.map(e => [e.id, e]));

  const result = new Map<string, ExportDomainContext>();

  // Completeness pass — REQUIRED parent/domain objects (the row itself for
  // every domain, PLUS the parent Event for event_participant/event_guest,
  // PLUS the parent Program for program_enrollment) must propagate a
  // HydrationFailure when missing — a financial export must never silently
  // omit a row, or default a missing parent to a fallback title with
  // collectible=true, because its context couldn't be resolved. This is
  // distinct from a SUPPORTING display lookup (a Court's name, a Pro's
  // profile, a roster Member's display name) which is not needed to
  // establish financial/domain identity or collectibility and may keep its
  // existing neutral fallback ("Court Reservation" / "Pro" / "Unknown").
  for (const input of inputs) {
    let title: string;
    let identityName = "Unknown";
    let serviceDateTime = "";
    let lifecycleLabel: string | null = null;
    let collectible: boolean;

    if (input.domainType === "reservation") {
      const r = reservationById.get(input.domainId);
      if (!r) return { error: `reservation row not found (payment ${input.paymentId}, domain_id ${input.domainId})` };
      title = courtName.get(r.court_id) ?? "Court Reservation"; // supporting lookup — neutral fallback OK
      serviceDateTime = formatClubLocalDateTime(r.starts_at, clubTimezone);
      identityName = input.rosterMemberId ? rosterName.get(input.rosterMemberId) ?? "Unknown" : "Unknown"; // supporting lookup
      lifecycleLabel = reservationLifecycleLabel(r.status);
      collectible = isReservationCollectible(r.status);
    } else if (input.domainType === "lesson_request") {
      const r = lessonRequestById.get(input.domainId);
      if (!r) return { error: `lesson_request row not found (payment ${input.paymentId}, domain_id ${input.domainId})` };
      title = `Lesson with ${proName.get(r.pro_id) ?? "Pro"}`; // supporting lookup — neutral fallback OK
      serviceDateTime = r.proposed_starts_at ? formatClubLocalDateTime(r.proposed_starts_at, clubTimezone) : "";
      identityName = input.rosterMemberId ? rosterName.get(input.rosterMemberId) ?? "Unknown" : "Unknown";
      lifecycleLabel = lessonRequestLifecycleLabel(r.status);
      collectible = isLessonRequestCollectible(r.status);
    } else if (input.domainType === "event_participant") {
      const r = eventParticipantById.get(input.domainId);
      if (!r) return { error: `event_participant row not found (payment ${input.paymentId}, domain_id ${input.domainId})` };
      const ev = eventById.get(r.event_id);
      // The parent Event is REQUIRED (it's where title/dates/lifecycle/
      // collectibility all come from) — never a fallback title/collectible.
      if (!ev) return { error: `parent event not found for event_participant ${input.domainId} (payment ${input.paymentId})` };
      title = ev.title;
      serviceDateTime = formatClubLocalDateTime(ev.starts_at, clubTimezone);
      identityName = input.rosterMemberId ? rosterName.get(input.rosterMemberId) ?? "Unknown" : "Unknown";
      lifecycleLabel = eventParticipantLifecycleLabel(ev.status, r.status);
      collectible = isEventParticipantCollectible(ev.status, r.status);
    } else if (input.domainType === "event_guest") {
      const r = eventGuestById.get(input.domainId);
      if (!r) return { error: `event_guest row not found (payment ${input.paymentId}, domain_id ${input.domainId})` };
      const ev = eventById.get(r.event_id);
      if (!ev) return { error: `parent event not found for event_guest ${input.domainId} (payment ${input.paymentId})` };
      title = ev.title;
      serviceDateTime = formatClubLocalDateTime(ev.starts_at, clubTimezone);
      identityName = `${r.display_name} (Guest)`;
      lifecycleLabel = eventGuestLifecycleLabel(ev.status);
      collectible = isEventGuestCollectible(ev.status);
    } else {
      const r = programEnrollmentById.get(input.domainId);
      if (!r) return { error: `program_enrollment row not found (payment ${input.paymentId}, domain_id ${input.domainId})` };
      const prog = programById.get(r.program_id);
      // The parent Program is REQUIRED — never a fallback title/collectible.
      if (!prog) return { error: `parent program not found for program_enrollment ${input.domainId} (payment ${input.paymentId})` };
      title = prog.title;
      // starts_on is a plain `date` column (no time component) — already a
      // "YYYY-MM-DD" string, per §7's date-only program-context format.
      serviceDateTime = prog.starts_on;
      identityName = input.rosterMemberId ? rosterName.get(input.rosterMemberId) ?? "Unknown" : "Unknown";
      lifecycleLabel = programEnrollmentLifecycleLabel(prog.status, r.status);
      collectible = isProgramEnrollmentCollectible(prog.status, r.status);
    }

    result.set(input.paymentId, {
      identityName,
      title,
      domainTypeLabel: DOMAIN_TYPE_LABEL[input.domainType],
      serviceDateTime,
      lifecycleLabel,
      collectible,
    });
  }

  return result;
}

export { isFailure as isHydrationFailure };
