// Phase 35B — one-off "Add to Calendar" (.ics) export.
//
// GET /api/calendar/export/[domain]/[id] — domain is strictly allowlisted
// (reservation | event | lesson | program); id is the canonical row id for
// that domain.
//
// SECURITY: this endpoint independently authenticates and authorizes every
// request. The client supplies ONLY the domain + id — never a club_id,
// profile/member/pro id, title, time, court, status, notes, price, or
// participant data. Every fact in the exported .ics is re-derived here,
// server-side, through the caller's own current identity:
//   - identity/club/role come from getAuthProfile() (the same per-request
//     helper every other page in this app uses), never from anything the
//     client sent.
//   - every domain row is read through supabase/lib/server.ts's session-
//     scoped (cookie-bound) client, so every existing RLS SELECT policy
//     (reservations_select_same_club, events_select_same_club,
//     lesson_requests_select_*, programs_select_same_club,
//     program_enrollments_select) applies exactly as it does everywhere
//     else in the app — this route never uses a service-role/privileged
//     client, and never bypasses RLS as a shortcut.
//   - the one place RLS's own club-wide operator/member_self_service
//     branches are not narrow enough by themselves — a Program parent
//     schedule export — has its own additional application-level check
//     (canOperatorExportProgramSchedule / canMemberExportProgramSchedule in
//     @/lib/calendar/export) so a Member enrolled per-session (or not
//     enrolled at all) can never receive another Member's or the whole
//     club's occurrence schedule merely because the parent Program row
//     itself is visible to them.
//
// A row that doesn't exist, isn't visible under RLS, isn't eligible
// (wrong status/archived/finished), or fails a domain-specific check below
// all produce the SAME 404 — never a distinct 403 — so a caller probing
// ids cannot learn anything about why a given id failed.
//
// Correction pass (post-35B review) — three more places where raw RLS row-
// visibility is broader than "may export this as MY calendar item":
//   - Reservation (reason='member_booking'): Admin/Staff unrestricted
//     (unchanged); Member/Pro may export only their OWN reservation
//     (owner_user_id, or roster_member_id against their OWN resolved
//     current roster identity — never a client-supplied id).
//   - Program, Member branch: enrollment lookup now also accepts a match
//     on the caller's own resolved roster_member_id, not just profile_id —
//     a claimed Member's whole-Program enrollment may predate their
//     account (see resolveViewerRosterMemberId below).
//   - Program, Pro branch: scoped to program.created_by === viewer.id,
//     mirroring ProgramsManageClient's existing management boundary — RLS
//     grants every Pro club-wide row visibility, but this export must not
//     grant every Pro every other Pro's Program schedule.
// A fourth correction — "ends_at > now" folded into every domain's
// eligibility (including each Program occurrence) and a Program export
// with zero remaining eligible occurrences returning 404 rather than an
// empty-but-200 calendar — lives in @/lib/calendar/export's eligibility
// functions themselves.
//
// No SEQUENCE/update semantics, no VTIMEZONE, no URL: field — this is a
// standalone snapshot export, not a subscription (see @/lib/ics and
// @/lib/calendar/export module headers for why).

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAuthProfile } from "@/lib/supabase/user";
import { buildIcsCalendar, type IcsEvent } from "@/lib/ics";
import {
  isReservationExportEligible,
  canExportReservationForRole,
  buildReservationIcsEvent,
  isEventExportEligible,
  buildEventIcsEvent,
  resolveLocation,
  isLessonExportEligible,
  resolveLessonCounterparty,
  formatLessonSummary,
  fullDisplayName,
  buildLessonIcsEvent,
  safeDescription,
  isProgramExportEligible,
  isProgramOccurrenceExportEligible,
  canOperatorExportProgramSchedule,
  canMemberExportProgramSchedule,
  buildProgramOccurrenceIcsEvents,
  EXPORT_FILENAMES,
} from "@/lib/calendar/export";
import type { Database } from "@/lib/db/types";
import type { SupabaseClient } from "@supabase/supabase-js";

type Supabase = SupabaseClient<Database>;

const ALLOWED_DOMAINS = ["reservation", "event", "lesson", "program"] as const;
type Domain = (typeof ALLOWED_DOMAINS)[number];

function isAllowedDomain(value: string): value is Domain {
  return (ALLOWED_DOMAINS as readonly string[]).includes(value);
}

// Fails fast on an obviously-malformed id before ever touching the
// database — a real, well-formed-but-nonexistent/unauthorized uuid still
// falls through to the same 404 each domain function below already
// produces.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound(): NextResponse {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

async function lookupCourtNames(
  supabase: Supabase,
  courtIds: readonly string[],
): Promise<Map<string, string>> {
  if (courtIds.length === 0) return new Map();
  const { data } = await supabase
    .from("courts")
    .select("id, name")
    .in("id", Array.from(new Set(courtIds)));
  return new Map((data ?? []).map(c => [c.id, c.name]));
}

// The human-readable event_types.label for each given id — never the
// immutable internal `key`. RLS's event_types_select_same_club already
// grants any same-club viewer read access with no role restriction, so no
// further authorization is needed beyond the events row itself already
// having passed its own eligibility/authorization check.
async function lookupEventTypeLabels(
  supabase: Supabase,
  eventTypeIds: readonly string[],
): Promise<Map<string, string>> {
  if (eventTypeIds.length === 0) return new Map();
  const { data } = await supabase
    .from("event_types")
    .select("id, label")
    .in("id", Array.from(new Set(eventTypeIds)));
  return new Map((data ?? []).map(t => [t.id, t.label]));
}

// The caller's own durable roster identity, resolved entirely server-side —
// never accepted from the client. Mirrors the exact RPC (and null-for-
// unclaimed-caller handling) /my-schedule already uses for the same
// ownership-continuity purpose.
async function resolveViewerRosterMemberId(supabase: Supabase): Promise<string | null> {
  const { data } = await supabase.rpc("current_user_roster_member_id");
  return data ?? null;
}

async function exportReservation(
  supabase: Supabase,
  id: string,
  viewer: { id: string; role: string | null },
  now: Date,
): Promise<IcsEvent[] | null> {
  const { data: reservation } = await supabase
    .from("reservations")
    .select("id, court_id, starts_at, ends_at, status, reason, owner_user_id, roster_member_id")
    .eq("id", id)
    .maybeSingle();

  if (!reservation || !isReservationExportEligible(reservation, now)) return null;

  // Correction pass: RLS's own broad club-wide READ visibility (a
  // Connected club's member_self_service branch) must not be mistaken for
  // "may add someone else's booking to my personal calendar." Admin/Staff
  // are unrestricted here (unchanged); a Member/Pro must own the row.
  const rosterMemberId = await resolveViewerRosterMemberId(supabase);
  const authorized = canExportReservationForRole(viewer.role ?? "", reservation, {
    id: viewer.id,
    rosterMemberId,
  });
  if (!authorized) return null;

  const { data: court } = await supabase
    .from("courts")
    .select("name")
    .eq("id", reservation.court_id)
    .maybeSingle();

  return [buildReservationIcsEvent(reservation, court?.name ?? "Court")];
}

// The PARENT Program's own current description, for a generated occurrence
// (see @/lib/calendar/export's DESCRIPTION-safety note for why the fresh
// parent value is used rather than the occurrence's own, independently-
// editable copy). null for a standalone event (programId null) or when the
// program has no description set.
async function lookupProgramDescription(supabase: Supabase, programId: string | null): Promise<string | null> {
  if (!programId) return null;
  const { data: program } = await supabase
    .from("programs")
    .select("description")
    .eq("id", programId)
    .maybeSingle();
  return safeDescription(program?.description);
}

async function exportEvent(supabase: Supabase, id: string, now: Date): Promise<IcsEvent[] | null> {
  const { data: event } = await supabase
    .from("events")
    .select("id, title, starts_at, ends_at, status, archived_at, program_id, event_type_id, reservations(court_id, reason, status)")
    .eq("id", id)
    .maybeSingle();

  if (!event || !isEventExportEligible(event, now)) return null;

  const courtIds = (event.reservations ?? [])
    .filter(r => r.reason === "event" && r.status === "confirmed")
    .map(r => r.court_id);
  const [nameById, description, typeLabelById] = await Promise.all([
    lookupCourtNames(supabase, courtIds),
    lookupProgramDescription(supabase, event.program_id),
    lookupEventTypeLabels(supabase, [event.event_type_id]),
  ]);

  return [
    buildEventIcsEvent(
      event,
      resolveLocation(courtIds, nameById),
      description,
      typeLabelById.get(event.event_type_id) ?? null,
    ),
  ];
}

async function exportLesson(
  supabase: Supabase,
  id: string,
  viewerId: string,
  now: Date,
): Promise<IcsEvent[] | null> {
  const { data: lesson } = await supabase
    .from("lesson_requests")
    .select("id, member_id, pro_id, roster_member_id, proposed_starts_at, proposed_ends_at, proposed_court_id, status, member_note")
    .eq("id", id)
    .maybeSingle();

  if (!lesson || !isLessonExportEligible(lesson, now)) return null;

  const counterparty = resolveLessonCounterparty(viewerId, lesson);

  const [memberProfile, proProfile] = await Promise.all([
    lesson.member_id
      ? supabase.from("profiles").select("first_name, last_name").eq("id", lesson.member_id).maybeSingle()
      : supabase.from("roster_members").select("first_name, last_name").eq("id", lesson.roster_member_id).maybeSingle(),
    supabase.from("profiles").select("first_name, last_name").eq("id", lesson.pro_id).maybeSingle(),
  ]);

  const summary = formatLessonSummary(counterparty, {
    memberName: fullDisplayName(memberProfile.data),
    proName: fullDisplayName(proProfile.data),
  });

  let location: string | null = null;
  if (lesson.proposed_court_id) {
    const { data: court } = await supabase
      .from("courts")
      .select("name")
      .eq("id", lesson.proposed_court_id)
      .maybeSingle();
    location = court?.name ?? null;
  }

  return [
    buildLessonIcsEvent(
      { id: lesson.id, proposed_starts_at: lesson.proposed_starts_at!, proposed_ends_at: lesson.proposed_ends_at! },
      summary,
      location,
      // member_note is rendered unconditionally to BOTH the Member
      // (LessonRequestDetail) and the assigned Pro (LessonProSheet), in
      // every status including confirmed — genuinely shared between the
      // two legitimate Lesson parties, safe regardless of which of them
      // (or Admin/Staff) is exporting. decline_reason/cancellation_reason
      // are never read by this route at all.
      safeDescription(lesson.member_note),
    ),
  ];
}

async function exportProgram(
  supabase: Supabase,
  id: string,
  viewer: { id: string; role: string | null },
  now: Date,
): Promise<IcsEvent[] | null> {
  const { data: program } = await supabase
    .from("programs")
    .select("id, status, archived_at, enrollment_model, created_by, description")
    .eq("id", id)
    .maybeSingle();

  if (!program || !isProgramExportEligible(program)) return null;

  const role = viewer.role ?? "";
  let authorized = canOperatorExportProgramSchedule(role, program, viewer.id);

  // Correction pass: the Member branch below is attempted ONLY for
  // role='member' — a non-creator Pro must fail here exactly like an
  // unenrolled Member (the same generic 404), never fall through to a
  // program_enrollments lookup that was never meant to authorize a Pro.
  if (!authorized && role === "member") {
    // Correction pass — durable identity: a claimed Member's whole-Program
    // enrollment may predate their account (staff-created pre-claim row,
    // profile_id null, roster_member_id authoritative — the same pattern
    // current_user_enrolled_in_program(), program_enrollments RLS, and
    // /my-schedule's own Program lookup already recognize). Resolve the
    // caller's OWN current roster identity server-side and accept either
    // match — never a roster/member id supplied by the client.
    const rosterMemberId = await resolveViewerRosterMemberId(supabase);
    let enrollmentQuery = supabase.from("program_enrollments").select("status").eq("program_id", id);
    enrollmentQuery = rosterMemberId
      ? enrollmentQuery.or(`profile_id.eq.${viewer.id},roster_member_id.eq.${rosterMemberId}`)
      : enrollmentQuery.eq("profile_id", viewer.id);
    const { data: enrollment } = await enrollmentQuery.maybeSingle();
    authorized = canMemberExportProgramSchedule(program.enrollment_model, enrollment?.status ?? null);
  }

  if (!authorized) return null;

  const { data: occurrenceRows } = await supabase
    .from("events")
    .select("id, title, starts_at, ends_at, status, archived_at, event_type_id, reservations(court_id, reason, status)")
    .eq("program_id", id)
    .order("starts_at");

  // Correction pass: current/future only (ends_at > now) — a "schedule"
  // export should hand the calendar app what's left, not backfill history.
  const occurrences = (occurrenceRows ?? []).filter(ev => isProgramOccurrenceExportEligible(ev, now));

  // Correction pass: zero remaining eligible occurrences is NOT a
  // successful empty-calendar download — it's the same generic
  // not-found/unavailable outcome as every other non-exportable state.
  if (occurrences.length === 0) return null;

  const allCourtIds = occurrences.flatMap(ev =>
    (ev.reservations ?? [])
      .filter(r => r.reason === "event" && r.status === "confirmed")
      .map(r => r.court_id),
  );
  const [nameById, typeLabelById] = await Promise.all([
    lookupCourtNames(supabase, allCourtIds),
    lookupEventTypeLabels(supabase, occurrences.map(ev => ev.event_type_id)),
  ]);

  const locationByEventId = new Map(
    occurrences.map(ev => {
      const courtIds = (ev.reservations ?? [])
        .filter(r => r.reason === "event" && r.status === "confirmed")
        .map(r => r.court_id);
      return [ev.id, resolveLocation(courtIds, nameById)] as const;
    }),
  );

  // Read per-occurrence, not once from the parent Program — see
  // buildProgramOccurrenceIcsEvents' own header for why an occurrence's
  // event_type_id can differ from the Program's after independent editing.
  const typeLabelByEventId = new Map(
    occurrences.map(ev => [ev.id, typeLabelById.get(ev.event_type_id) ?? null] as const),
  );

  // programs.description is rendered unconditionally to any Member who can
  // see their own whole-program enrollment (ProgramEnrollmentCard) — the
  // one confirmed, current, participant-facing text field for this domain.
  // Applied uniformly to every occurrence, matching generate_program_
  // sessions' (0088) own "same description on every occurrence" origin.
  return buildProgramOccurrenceIcsEvents(
    occurrences,
    locationByEventId,
    safeDescription(program.description),
    typeLabelByEventId,
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ domain: string; id: string }> },
): Promise<NextResponse> {
  const { domain, id } = await params;

  if (!isAllowedDomain(domain) || !UUID_RE.test(id)) {
    return notFound();
  }

  const profile = await getAuthProfile();
  if (!profile || !profile.club_id) {
    return notFound();
  }

  const supabase = await createClient();
  // One shared instant for every eligibility check AND the ICS DTSTAMP in
  // this request — never re-read the clock mid-request.
  const now = new Date();
  const viewer = { id: profile.id, role: profile.role };

  let icsEvents: IcsEvent[] | null;
  switch (domain) {
    case "reservation":
      icsEvents = await exportReservation(supabase, id, viewer, now);
      break;
    case "event":
      icsEvents = await exportEvent(supabase, id, now);
      break;
    case "lesson":
      icsEvents = await exportLesson(supabase, id, profile.id, now);
      break;
    case "program":
      icsEvents = await exportProgram(supabase, id, viewer, now);
      break;
  }

  if (icsEvents === null) {
    return notFound();
  }

  return new NextResponse(buildIcsCalendar(icsEvents, now), {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${EXPORT_FILENAMES[domain]}"`,
      "Cache-Control": "no-store",
    },
  });
}
