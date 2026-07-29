"use server";

// programRosterActions.ts
// Phase 27D3B: Server Actions wrapping the two Phase 27D3A write RPCs
// (add_program_member, remove_program_member — 0092, applied and
// immutable). Mirrors programEnrollmentActions.ts's exact shape:
// destructure expectedClubId, run the assertActiveClub preflight guard
// before any mutation, call exactly one RPC, return { data?, error? } with
// error as { code?, message } so the shared mapProgramError() (extended in
// this checkpoint with the 0092 codes) can map it client-side.
//
// The roster read (get_program_roster) is deliberately NOT wrapped here —
// ProgramRosterSheet calls it directly via the browser Supabase client,
// exactly like EventRosterSheet already calls get_event_roster directly.
// It is a SECURITY DEFINER RPC that enforces its own authorization
// regardless of transport, and reads need no stale-club guard (that guard
// exists to protect writes from being applied against the wrong club, not
// to gate reads).

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { assertActiveClub } from "@/lib/supabase/staleClub";

export type ProgramEnrollmentStatus = "enrolled" | "waitlisted" | "offered" | "cancelled";

export interface ProgramEnrollmentResult {
  status:            ProgramEnrollmentStatus;
  offer_expires_at:  string | null;
}

// Every successful mutation revalidates all four surfaces that read
// program_enrollments/event_participants for this program: the Manage →
// Programs list and the member-facing Upcoming Programs section (both on
// /events), the generated sessions' own cards (/calendar), and a member's
// personal schedule (/my-schedule) if materialization changed their rows.
// Both add and remove can affect any of the four depending on the target's
// resulting status, so both revalidate unconditionally rather than trying
// to mirror RPC-internal branching here — matching the same reasoning
// already used in programEnrollmentActions.ts's own write actions.

export async function addProgramMember(params: {
  p_program_id:   string;
  p_profile_id:   string;
  expectedClubId: string;
}): Promise<{ data?: ProgramEnrollmentResult; error?: { code?: string; message: string } }> {
  const { expectedClubId, ...rpcParams } = params;
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: { message: guard.error } };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("add_program_member", rpcParams);
  if (error) return { error: { code: error.code, message: error.message } };

  revalidatePath("/events");
  revalidatePath("/calendar");
  revalidatePath("/my-schedule");

  return { data: data ? { status: data.status, offer_expires_at: data.offer_expires_at } : undefined };
}

export async function removeProgramMember(params: {
  p_program_id:   string;
  p_profile_id:   string;
  expectedClubId: string;
}): Promise<{ data?: ProgramEnrollmentResult; error?: { code?: string; message: string } }> {
  const { expectedClubId, ...rpcParams } = params;
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: { message: guard.error } };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("remove_program_member", rpcParams);
  if (error) return { error: { code: error.code, message: error.message } };

  revalidatePath("/events");
  revalidatePath("/calendar");
  revalidatePath("/my-schedule");

  return { data: data ? { status: data.status, offer_expires_at: data.offer_expires_at } : undefined };
}
