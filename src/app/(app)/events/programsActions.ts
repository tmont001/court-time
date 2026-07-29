"use server";

// programsActions.ts
// Phase 27C: Server Actions for the Programs admin/pro UI. Reads use the
// existing SELECT-scoped tables directly (programs/program_schedule_rules/
// program_rule_courts/events — all RLS-readable per 0087/0088); writes go
// exclusively through the shipped Phase 27B2 RPCs (create_program,
// generate_program_sessions). No direct write to any program table.
//
// Mirrors the exact Server Action shape already established in
// calendar/actions.ts (createEvent, createReservation): destructure
// expectedClubId, run the assertActiveClub preflight guard before any
// mutation, then call the RPC and return a plain { data?, error? } shape.
// preview_program_sessions is read-only/STABLE and is called directly from
// the client (ProgramPreviewSheet) via the browser Supabase client, exactly
// like CreateEventSheet's own direct client-side reads (event_types
// fetch, court conflict check) — no Server Action wrapper needed for it.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { assertActiveClub } from "@/lib/supabase/staleClub";
import type { Json } from "@/lib/db/types";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProgramCourtRef {
  id:   string;
  name: string;
}

export interface ProgramRuleRow {
  id:                string;
  day_of_week:       number;
  start_time:        string;
  duration_minutes:  number;
  capacity_override: number | null;
  courts:            ProgramCourtRef[];
}

export interface ProgramListRow {
  id:                      string;
  title:                   string;
  description:             string | null;
  status:                  "draft" | "active" | "cancelled" | "completed";
  enrollment_model:        "program" | "per_session" | "admin_managed";
  starts_on:               string;
  ends_on:                 string;
  default_capacity:        number;
  created_by:              string;
  creator_name:            string;
  event_type:              { id: string; key: string; label: string; color: string } | null;
  rules:                   ProgramRuleRow[];
  generated_count:         number;
  next_session_starts_at:  string | null;
  archived_at:             string | null;
}

// Phase 27E: mirrors ArchiveView (src/app/(app)/admin/events/actions.ts)
// exactly — defined locally rather than imported so this module stays
// self-contained, matching how each actions.ts file in this directory
// already defines its own list-row/filter types independently.
export type ProgramArchiveView = "active" | "archived" | "all";

interface RawProgramRow {
  id:                string;
  title:             string;
  description:       string | null;
  status:            "draft" | "active" | "cancelled" | "completed";
  enrollment_model:  "program" | "per_session" | "admin_managed";
  starts_on:         string;
  ends_on:           string;
  default_capacity:  number;
  created_by:        string;
  archived_at:       string | null;
  event_types:        { id: string; key: string; label: string; color: string } | null;
  program_schedule_rules: {
    id:                string;
    day_of_week:       number;
    start_time:        string;
    duration_minutes:  number;
    capacity_override: number | null;
  }[];
}

export type ProgramRulePayload = {
  day_of_week:        number;
  start_time:          string;
  duration_minutes:    number;
  capacity_override:   number | null;
  court_ids:            string[];
};

export interface ProgramRow {
  id:                string;
  club_id:           string;
  event_type_id:     string;
  title:             string;
  description:       string | null;
  enrollment_model:  "program" | "per_session" | "admin_managed";
  status:            "draft" | "active" | "cancelled" | "completed";
  starts_on:         string;
  ends_on:           string;
  default_capacity:  number;
  created_by:        string;
  created_at:        string;
  updated_at:        string;
  archived_at:       string | null;
  archived_by:       string | null;
}

export interface GenerateResult {
  inserted_count: number;
  skipped_count:  number;
  event_ids:      string[];
}

// ─── Reads ────────────────────────────────────────────────────────────────────

// Called both from page.tsx during SSR (a direct function call, no Server
// Action boundary crossed) and from ProgramsManageClient after a create/
// generate to refresh the list — the exact fetchMoreAdminEvents split
// already used for the sibling Events manage surface.
export async function getPrograms(
  clubId: string,
  archiveView: ProgramArchiveView = "active",
): Promise<{ programs: ProgramListRow[] } | { error: string }> {
  if (!clubId) return { programs: [] };

  const supabase = await createClient();

  const baseQuery = supabase
    .from("programs")
    .select(`
      id, title, description, status, enrollment_model, starts_on, ends_on, default_capacity, created_by, archived_at,
      event_types(id, key, label, color),
      program_schedule_rules(id, day_of_week, start_time, duration_minutes, capacity_override)
    `)
    .eq("club_id", clubId);

  // Phase 27E: same three-way filter shape as fetchMoreAdminEvents
  // (admin/events/actions.ts) — default "active" excludes archived
  // programs so the normal Manage → Programs list is unaffected by
  // archiving until the caller explicitly asks to see archived/all.
  const filteredQuery =
    archiveView === "archived" ? baseQuery.not("archived_at", "is", null) :
    archiveView === "all"      ? baseQuery :
    /* active (default) */       baseQuery.is("archived_at", null);

  const { data: programsData, error: programsErr } = await filteredQuery
    .order("created_at", { ascending: false });

  if (programsErr) {
    // Log the real Postgres/PostgREST error server-side for debugging; the
    // UI only ever sees a stable, generic message — never raw database text.
    console.error("[getPrograms] failed to load programs list:", programsErr);
    return { error: "Failed to load programs. Please try again." };
  }

  const rawPrograms = (programsData ?? []) as unknown as RawProgramRow[];
  if (rawPrograms.length === 0) return { programs: [] };

  const ruleIds     = rawPrograms.flatMap(p => p.program_schedule_rules.map(r => r.id));
  const programIds  = rawPrograms.map(p => p.id);
  const creatorIds  = [...new Set(rawPrograms.map(p => p.created_by))];
  const nowIso      = new Date().toISOString();

  const [courtsResult, eventsResult, creatorsResult] = await Promise.all([
    ruleIds.length
      ? supabase
          .from("program_rule_courts")
          .select("program_schedule_rule_id, courts(id, name)")
          .in("program_schedule_rule_id", ruleIds)
      : Promise.resolve({ data: [] as { program_schedule_rule_id: string; courts: ProgramCourtRef | null }[] }),
    supabase
      .from("events")
      .select("id, program_id, starts_at, status")
      .eq("club_id", clubId)
      .in("program_id", programIds)
      .is("archived_at", null),
    creatorIds.length
      ? supabase.from("profiles").select("id, first_name, last_name").in("id", creatorIds)
      : Promise.resolve({ data: [] as { id: string; first_name: string | null; last_name: string | null }[] }),
  ]);

  const courtsByRule = new Map<string, ProgramCourtRef[]>();
  for (const row of (courtsResult.data ?? []) as unknown as { program_schedule_rule_id: string; courts: ProgramCourtRef | null }[]) {
    if (!row.courts) continue;
    const list = courtsByRule.get(row.program_schedule_rule_id) ?? [];
    list.push(row.courts);
    courtsByRule.set(row.program_schedule_rule_id, list);
  }

  const events = (eventsResult.data ?? []) as { id: string; program_id: string | null; starts_at: string; status: string }[];
  const generatedCountByProgram = new Map<string, number>();
  const nextSessionByProgram    = new Map<string, string>();
  for (const ev of events) {
    if (!ev.program_id) continue;
    generatedCountByProgram.set(ev.program_id, (generatedCountByProgram.get(ev.program_id) ?? 0) + 1);
    if (ev.status === "scheduled" && ev.starts_at >= nowIso) {
      const current = nextSessionByProgram.get(ev.program_id);
      if (!current || ev.starts_at < current) nextSessionByProgram.set(ev.program_id, ev.starts_at);
    }
  }

  const creatorNameById = new Map<string, string>();
  for (const c of (creatorsResult.data ?? []) as { id: string; first_name: string | null; last_name: string | null }[]) {
    const name = [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
    creatorNameById.set(c.id, name || "Unknown");
  }

  const programs: ProgramListRow[] = rawPrograms.map(p => ({
    id:               p.id,
    title:            p.title,
    description:      p.description,
    status:           p.status,
    enrollment_model: p.enrollment_model,
    starts_on:        p.starts_on,
    ends_on:          p.ends_on,
    default_capacity: p.default_capacity,
    created_by:       p.created_by,
    creator_name:     creatorNameById.get(p.created_by) ?? "Unknown",
    event_type:       p.event_types,
    rules: p.program_schedule_rules
      .map(r => ({ ...r, courts: courtsByRule.get(r.id) ?? [] }))
      .sort((a, b) => a.day_of_week - b.day_of_week || a.start_time.localeCompare(b.start_time)),
    generated_count:        generatedCountByProgram.get(p.id) ?? 0,
    next_session_starts_at: nextSessionByProgram.get(p.id) ?? null,
    archived_at:            p.archived_at,
  }));

  return { programs };
}

// ─── Writes ───────────────────────────────────────────────────────────────────

export async function createProgram(params: {
  p_event_type_id:    string;
  p_title:             string;
  p_enrollment_model:  "program" | "per_session" | "admin_managed";
  p_starts_on:         string;
  p_ends_on:           string;
  p_default_capacity:  number;
  p_rules:             ProgramRulePayload[];
  p_description?:      string | null;
  expectedClubId:      string;
}): Promise<{ data?: ProgramRow; error?: { code?: string; message: string } }> {
  const { expectedClubId, ...rpcParams } = params;
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: { message: guard.error } };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_program", {
    ...rpcParams,
    p_rules: rpcParams.p_rules as unknown as Json,
  });
  if (error) return { error: { code: error.code, message: error.message } };

  return { data: (data ?? undefined) as ProgramRow | undefined };
}

// Phase 27C.1: edit a draft program's definition. No revalidatePath here —
// update_program is only reachable while the program has zero generated
// events (program_already_generated blocks it otherwise), so /events and
// /calendar have nothing to invalidate.
export async function updateProgram(params: {
  p_program_id:        string;
  p_event_type_id:     string;
  p_title:             string;
  p_enrollment_model:  "program" | "per_session" | "admin_managed";
  p_starts_on:         string;
  p_ends_on:           string;
  p_default_capacity:  number;
  p_rules:             ProgramRulePayload[];
  p_description?:      string | null;
  expectedClubId:      string;
}): Promise<{ data?: ProgramRow; error?: { code?: string; message: string } }> {
  const { expectedClubId, ...rpcParams } = params;
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: { message: guard.error } };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("update_program", {
    ...rpcParams,
    p_rules: rpcParams.p_rules as unknown as Json,
  });
  if (error) return { error: { code: error.code, message: error.message } };

  return { data: (data ?? undefined) as ProgramRow | undefined };
}

export async function generateProgramSessions(params: {
  p_program_id:    string;
  p_from_date?:    string | null;
  p_through_date?: string | null;
  expectedClubId:  string;
}): Promise<{ data?: GenerateResult; error?: { code?: string; message: string } }> {
  const { expectedClubId, ...rpcParams } = params;
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: { message: guard.error } };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("generate_program_sessions", rpcParams);
  if (error) return { error: { code: error.code, message: error.message } };

  // Newly generated events/reservations are real events rows — invalidate
  // both surfaces that read them so the already-mounted Events panel (via
  // the caller's router.refresh()) and a later Calendar visit both see
  // fresh data instead of a stale cached RSC payload.
  revalidatePath("/events");
  revalidatePath("/calendar");

  // generate_program_sessions is RETURNS TABLE — PostgREST returns an array
  // with exactly one row for this call shape.
  const row = Array.isArray(data) ? data[0] : data;
  return { data: row as GenerateResult | undefined };
}

// ─── Lifecycle (Phase 27E) ──────────────────────────────────────────────────
//
// cancel_program can cancel future generated events and release their
// reservations — /calendar and /my-schedule are revalidated alongside
// /events for that reason, matching the same reasoning already used in
// programEnrollmentActions.ts/programRosterActions.ts (an extra
// revalidation on an action that didn't happen to touch a given surface is
// harmless; skipping one that was needed is not). complete_program/
// archive_program/unarchive_program never touch events/reservations, but
// revalidate all three anyway for the same reason and for consistency.

export async function cancelProgram(params: {
  p_program_id:   string;
  expectedClubId: string;
}): Promise<{ data?: ProgramRow; error?: { code?: string; message: string } }> {
  const { expectedClubId, ...rpcParams } = params;
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: { message: guard.error } };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("cancel_program", rpcParams);
  if (error) return { error: { code: error.code, message: error.message } };

  revalidatePath("/events");
  revalidatePath("/calendar");
  revalidatePath("/my-schedule");

  return { data: (data ?? undefined) as ProgramRow | undefined };
}

export async function completeProgram(params: {
  p_program_id:   string;
  expectedClubId: string;
}): Promise<{ data?: ProgramRow; error?: { code?: string; message: string } }> {
  const { expectedClubId, ...rpcParams } = params;
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: { message: guard.error } };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("complete_program", rpcParams);
  if (error) return { error: { code: error.code, message: error.message } };

  revalidatePath("/events");
  revalidatePath("/calendar");
  revalidatePath("/my-schedule");

  return { data: (data ?? undefined) as ProgramRow | undefined };
}

export async function archiveProgram(params: {
  p_program_id:   string;
  expectedClubId: string;
}): Promise<{ data?: ProgramRow; error?: { code?: string; message: string } }> {
  const { expectedClubId, ...rpcParams } = params;
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: { message: guard.error } };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("archive_program", rpcParams);
  if (error) return { error: { code: error.code, message: error.message } };

  revalidatePath("/events");
  revalidatePath("/calendar");
  revalidatePath("/my-schedule");

  return { data: (data ?? undefined) as ProgramRow | undefined };
}

export async function unarchiveProgram(params: {
  p_program_id:   string;
  expectedClubId: string;
}): Promise<{ data?: ProgramRow; error?: { code?: string; message: string } }> {
  const { expectedClubId, ...rpcParams } = params;
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: { message: guard.error } };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("unarchive_program", rpcParams);
  if (error) return { error: { code: error.code, message: error.message } };

  revalidatePath("/events");
  revalidatePath("/calendar");
  revalidatePath("/my-schedule");

  return { data: (data ?? undefined) as ProgramRow | undefined };
}
