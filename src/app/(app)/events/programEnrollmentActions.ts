"use server";

// programEnrollmentActions.ts
// Phase 27D2: member-facing Server Actions for whole-program
// (enrollment_model='program') enrollment. Reads use the existing
// SELECT-scoped tables directly (programs/program_schedule_rules/
// program_enrollments — all RLS-readable per 0087, any club member, not
// just admin/pro); writes go exclusively through the four Phase 27D1 RPCs
// (join_program, leave_program, accept_program_waitlist_offer,
// decline_program_waitlist_offer — 0091, applied and immutable). No direct
// write to any program or event_participants table.
//
// Mirrors the exact Server Action shape already established in
// programsActions.ts (admin/pro program CRUD) and calendar/actions.ts
// (member event join/leave/waitlist): destructure expectedClubId, run the
// assertActiveClub preflight guard before any mutation, call the RPC, and
// return a plain { data?, error? } shape — error as { code?, message }
// matching programsActions.ts exactly, since mapProgramError() (extended
// in this checkpoint to cover these four RPCs' error codes) expects that
// shape.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { assertActiveClub } from "@/lib/supabase/staleClub";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MemberProgramScheduleRule {
  day_of_week:      number;
  start_time:       string;
  duration_minutes: number;
}

export type ProgramEnrollmentStatus = "enrolled" | "waitlisted" | "offered" | "cancelled";

export interface MemberProgramEnrollment {
  status:            ProgramEnrollmentStatus;
  offer_expires_at:  string | null;
}

export interface MemberProgramCard {
  id:                string;
  title:             string;
  description:       string | null;
  event_type:        { key: string; label: string; color: string } | null;
  starts_on:         string;
  ends_on:           string;
  rules:             MemberProgramScheduleRule[];
  my_enrollment:     MemberProgramEnrollment | null;
}

export interface EnrollmentResult {
  status:            ProgramEnrollmentStatus;
  offer_expires_at:  string | null;
}

interface RawMemberProgramRow {
  id:           string;
  title:        string;
  description:  string | null;
  starts_on:    string;
  ends_on:      string;
  event_types:  { key: string; label: string; color: string } | null;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

// Called from page.tsx during SSR (a direct function call, no Server Action
// boundary crossed), in parallel with the existing events fetch — the same
// pattern getPrograms() already establishes for the admin Programs list.
//
// Scope matches the Phase 27D1 join_program eligibility contract as
// closely as a display-only read can: enrollment_model='program',
// status='active' (draft programs have never been generated and are never
// enrollable — see 0091's lifecycle matrix), not archived, and ends_on has
// not passed in the club's own timezone (club-local "today", matching the
// _program_is_enrollable convention rather than a server-UTC date, so the
// listing and the RPC's own authoritative check never disagree at a
// timezone boundary). This is a display filter only — join_program
// re-validates eligibility itself regardless of what this query returns.
// Single stable message for every read failure in this function — the UI
// never sees which of the four queries below actually failed, only that
// the load failed and a retry is warranted (see the "Try again" affordance
// in EventsUpcomingClient).
const PROGRAMS_LOAD_ERROR = "Failed to load programs. Please try again.";

export async function getMemberPrograms(
  clubId: string,
  userId: string,
): Promise<{ programs: MemberProgramCard[] } | { error: string }> {
  if (!clubId) return { programs: [] };

  const supabase = await createClient();

  // Looked up independently rather than threaded through from the caller
  // (page.tsx already fetches this for its own use, but duplicating one
  // small indexed clubs lookup here keeps this function callable on its
  // own — matching how every write action below independently calls
  // createClient() rather than sharing page-level setup — and keeps
  // page.tsx's parallel Promise.all fetch shape unchanged: no fetch here
  // needs to wait on another fetch in the same batch to resolve first).
  //
  // A failed lookup here must not silently fall back to a default
  // timezone — that would shift the ends_on >= today comparison below by
  // however far the caller's real club timezone differs from the
  // fallback, potentially hiding a program that is genuinely still
  // enrollable (or showing one that has genuinely ended). Treated as a
  // full load failure instead.
  const { data: club, error: clubErr } = await supabase.from("clubs").select("timezone").eq("id", clubId).single();
  if (clubErr) {
    console.error("[getMemberPrograms] failed to load club timezone:", clubErr);
    return { error: PROGRAMS_LOAD_ERROR };
  }
  const clubTimezone = club.timezone;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: clubTimezone });

  const { data: programsData, error: programsErr } = await supabase
    .from("programs")
    .select(`
      id, title, description, starts_on, ends_on,
      event_types(key, label, color)
    `)
    .eq("club_id", clubId)
    .eq("enrollment_model", "program")
    .eq("status", "active")
    .is("archived_at", null)
    .gte("ends_on", today)
    .order("starts_on", { ascending: true });

  if (programsErr) {
    // Log the real Postgres/PostgREST error server-side for debugging; the
    // UI only ever sees a stable, generic message — never raw database text.
    console.error("[getMemberPrograms] failed to load programs:", programsErr);
    return { error: PROGRAMS_LOAD_ERROR };
  }

  const rawPrograms = (programsData ?? []) as unknown as RawMemberProgramRow[];
  if (rawPrograms.length === 0) return { programs: [] };

  const programIds = rawPrograms.map(p => p.id);

  const [rulesResult, enrollmentResult] = await Promise.all([
    supabase
      .from("program_schedule_rules")
      .select("program_id, day_of_week, start_time, duration_minutes")
      .in("program_id", programIds),
    // Own row only — program_enrollments_select (0087) restricts a plain
    // member to profile_id = auth.uid() regardless of this .eq(), but the
    // explicit filter keeps the query's intent self-documenting and avoids
    // depending solely on RLS to narrow the result set.
    supabase
      .from("program_enrollments")
      .select("program_id, status, offer_expires_at")
      .in("program_id", programIds)
      .eq("profile_id", userId),
  ]);

  // Neither failure is allowed to silently degrade into a misleading
  // display state: a failed schedule read must not read as "no schedule
  // rules exist" (renders "Schedule to be announced" for a program that
  // actually has one), and a failed enrollment read must not read as "not
  // enrolled" (would show Join Program to a member who is actually already
  // enrolled or waitlisted). Both fail the whole load instead.
  if (rulesResult.error) {
    console.error("[getMemberPrograms] failed to load program_schedule_rules:", rulesResult.error);
    return { error: PROGRAMS_LOAD_ERROR };
  }
  if (enrollmentResult.error) {
    console.error("[getMemberPrograms] failed to load program_enrollments:", enrollmentResult.error);
    return { error: PROGRAMS_LOAD_ERROR };
  }

  const rulesByProgram = new Map<string, MemberProgramScheduleRule[]>();
  for (const r of (rulesResult.data ?? []) as { program_id: string; day_of_week: number; start_time: string; duration_minutes: number }[]) {
    const list = rulesByProgram.get(r.program_id) ?? [];
    list.push({ day_of_week: r.day_of_week, start_time: r.start_time, duration_minutes: r.duration_minutes });
    rulesByProgram.set(r.program_id, list);
  }
  for (const list of rulesByProgram.values()) {
    list.sort((a, b) => a.day_of_week - b.day_of_week || a.start_time.localeCompare(b.start_time));
  }

  // A 'cancelled' row is treated identically to "no enrollment row" for
  // display purposes — matches the Phase 27D1 state machine's own
  // Join Program eligibility (no row or status='cancelled' both show the
  // same Join Program action). This is a successful-read business rule,
  // not a fallback for a failed read (which is rejected above already).
  const enrollmentByProgram = new Map<string, MemberProgramEnrollment>();
  for (const e of (enrollmentResult.data ?? []) as { program_id: string; status: ProgramEnrollmentStatus; offer_expires_at: string | null }[]) {
    if (e.status === "cancelled") continue;
    enrollmentByProgram.set(e.program_id, { status: e.status, offer_expires_at: e.offer_expires_at });
  }

  const programs: MemberProgramCard[] = rawPrograms.map(p => ({
    id:            p.id,
    title:         p.title,
    description:   p.description,
    event_type:    p.event_types,
    starts_on:     p.starts_on,
    ends_on:       p.ends_on,
    rules:         rulesByProgram.get(p.id) ?? [],
    my_enrollment: enrollmentByProgram.get(p.id) ?? null,
  }));

  return { programs };
}

// ─── Writes ───────────────────────────────────────────────────────────────────

// Every write action below shares the same shape:
//   1. assertActiveClub preflight (stale-club protection, matching
//      calendar/actions.ts and programsActions.ts exactly);
//   2. call exactly one Phase 27D1 RPC;
//   3. on success, revalidate /events, /calendar, and /my-schedule.
//
// Revalidation runs on every successful call, not only the branches that
// are guaranteed to materialize/un-materialize event_participants rows
// (join and leave sometimes do, depending on capacity/prior status; accept
// always does; decline never does) — the four-path conditional needed to
// revalidate only exactly when required would mirror RPC-internal business
// logic in the UI layer for no real benefit, since /events always needs
// revalidating anyway (this page's own Programs section reflects the
// caller's own program_enrollments status, which changes on every one of
// these four calls) and an extra revalidation of /calendar or /my-schedule
// on a no-op decline is harmless.

export async function joinProgram(params: {
  p_program_id:   string;
  expectedClubId: string;
}): Promise<{ data?: EnrollmentResult; error?: { code?: string; message: string } }> {
  const guard = await assertActiveClub(params.expectedClubId);
  if (!guard.ok) return { error: { message: guard.error } };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("join_program", { p_program_id: params.p_program_id });
  if (error) return { error: { code: error.code, message: error.message } };

  revalidatePath("/events");
  revalidatePath("/calendar");
  revalidatePath("/my-schedule");

  return { data: data ? { status: data.status, offer_expires_at: data.offer_expires_at } : undefined };
}

export async function leaveProgram(params: {
  p_program_id:   string;
  expectedClubId: string;
}): Promise<{ data?: EnrollmentResult; error?: { code?: string; message: string } }> {
  const guard = await assertActiveClub(params.expectedClubId);
  if (!guard.ok) return { error: { message: guard.error } };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("leave_program", { p_program_id: params.p_program_id });
  if (error) return { error: { code: error.code, message: error.message } };

  revalidatePath("/events");
  revalidatePath("/calendar");
  revalidatePath("/my-schedule");

  return { data: data ? { status: data.status, offer_expires_at: data.offer_expires_at } : undefined };
}

export async function acceptProgramOffer(params: {
  p_program_id:   string;
  expectedClubId: string;
}): Promise<{ data?: EnrollmentResult; error?: { code?: string; message: string } }> {
  const guard = await assertActiveClub(params.expectedClubId);
  if (!guard.ok) return { error: { message: guard.error } };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("accept_program_waitlist_offer", { p_program_id: params.p_program_id });
  if (error) return { error: { code: error.code, message: error.message } };

  revalidatePath("/events");
  revalidatePath("/calendar");
  revalidatePath("/my-schedule");

  return { data: data ? { status: data.status, offer_expires_at: data.offer_expires_at } : undefined };
}

export async function declineProgramOffer(params: {
  p_program_id:   string;
  expectedClubId: string;
}): Promise<{ data?: EnrollmentResult; error?: { code?: string; message: string } }> {
  const guard = await assertActiveClub(params.expectedClubId);
  if (!guard.ok) return { error: { message: guard.error } };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("decline_program_waitlist_offer", { p_program_id: params.p_program_id });
  if (error) return { error: { code: error.code, message: error.message } };

  revalidatePath("/events");
  revalidatePath("/calendar");
  revalidatePath("/my-schedule");

  return { data: data ? { status: data.status, offer_expires_at: data.offer_expires_at } : undefined };
}
