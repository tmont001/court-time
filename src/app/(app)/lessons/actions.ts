"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { assertActiveClub } from "@/lib/supabase/staleClub";
import { STALE_CLUB_CONTEXT_ERROR, STALE_CLUB_MESSAGE } from "@/lib/staleClub";
import { sendEmail, sendRosterOperationalEmail } from "@/lib/email";
import {
  lessonRequestReceivedTemplate,
  lessonRequestProposedTemplate,
  lessonRequestConfirmedTemplate,
  lessonRequestDeclinedTemplate,
  lessonCancelledTemplate,
  lessonProviderReassignedTemplate,
  lessonAdminRequestedTemplate,
  rosterOperationalEmailTemplate,
} from "@/lib/email-templates";

// Phase 33E3: shared date/time formatter for no-account lesson operational
// email bodies — resolves the club's IANA timezone (clubs.timezone,
// RLS-readable) rather than assuming the server/browser timezone, mirroring
// calendar/actions.ts's own formatClubDateTime helper.
async function formatLessonWhen(
  supabase:    Awaited<ReturnType<typeof createClient>>,
  clubId:      string,
  startsAtIso: string,
  endsAtIso:   string,
): Promise<{ day: string; timeRange: string }> {
  const { data: club } = await supabase.from("clubs").select("timezone").eq("id", clubId).single();
  const timeZone = club?.timezone || "America/New_York";
  const start = new Date(startsAtIso);
  const end   = new Date(endsAtIso);
  const day = start.toLocaleDateString("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" });
  const fmtTime = (d: Date) => d.toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true });
  return { day, timeRange: `${fmtTime(start)}–${fmtTime(end)}` };
}

// Phase 33E3 correction: resolves the Pro's display name and the court's
// name server-side from their trusted, already-validated IDs (the same
// p_pro_id/p_court_id the RPC itself just used), rather than relying on a
// client-supplied display string for the no-account operational email —
// runtime QA found the client-supplied proName/courtName arriving blank
// despite the caller computing them correctly, an unresolved transmission
// gap not worth chasing further when the server already holds the
// authoritative source. Never throws; falls back to a generic label so a
// lookup failure never blocks the (already-non-blocking) email attempt.
async function resolveLessonDisplayNames(
  supabase: Awaited<ReturnType<typeof createClient>>,
  clubId:   string,
  proId:    string,
  courtId:  string | null,
): Promise<{ proName: string; courtName: string | null }> {
  const [{ data: pro }, courtResult] = await Promise.all([
    supabase.from("profiles").select("first_name, last_name").eq("id", proId).eq("club_id", clubId).single(),
    courtId
      ? supabase.from("courts").select("name").eq("id", courtId).eq("club_id", clubId).single()
      : Promise.resolve({ data: null }),
  ]);
  const proName = pro ? [pro.first_name, pro.last_name].filter(Boolean).join(" ") : "";
  return { proName: proName || "your pro", courtName: courtResult.data?.name ?? null };
}

// ─── Type shared across pages ─────────────────────────────────────────────────

export interface LessonRequestRow {
  id:                    string;
  pro_id:                string;
  pro_first_name:        string | null;
  pro_last_name:         string | null;
  preferred_court_id:    string | null;
  preferred_court_name:  string | null;
  duration_minutes:      number;
  member_note:           string | null;
  preferred_windows:     Record<string, unknown> | null;
  proposed_starts_at:    string | null;
  proposed_ends_at:      string | null;
  proposed_court_id:     string | null;
  proposed_court_name:   string | null;
  status:                string;
  decline_reason:        string | null;
  cancellation_reason:   string | null;
  linked_reservation_id: string | null;
  created_at:            string;
  updated_at:            string;
  confirmed_at:          string | null;
}

export interface ProLessonRequestRow extends LessonRequestRow {
  // Phase 33D1: member_id is null for a lesson booked (via
  // admin_create_member_lesson) for a Member with no Court Time account.
  // roster_member_id is the durable identity — always present.
  // member_claimed distinguishes the two, for a "No account yet" indicator
  // — never labeled as a Guest, matching the reservations-domain precedent.
  member_id:         string | null;
  member_first_name: string | null;
  member_last_name:  string | null;
  roster_member_id:  string;
  member_claimed:    boolean;
  last_actor_role:   string | null;
}

// ─── Internal notification dispatch ───────────────────────────────────────────

type LessonKind =
  | "lesson_request_received"
  | "lesson_request_proposed"
  | "lesson_request_confirmed"
  | "lesson_request_declined"
  | "lesson_cancelled"
  | "lesson_provider_reassigned"
  | "lesson_admin_requested";

type TemplateBuilder = (clubName: string) => { subject: string; html: string; text: string };

function buildTemplate(kind: LessonKind, body: string): TemplateBuilder {
  return (clubName) => {
    switch (kind) {
      case "lesson_request_received":    return lessonRequestReceivedTemplate(clubName, body);
      case "lesson_request_proposed":    return lessonRequestProposedTemplate(clubName, body);
      case "lesson_request_confirmed":   return lessonRequestConfirmedTemplate(clubName, body);
      case "lesson_request_declined":    return lessonRequestDeclinedTemplate(clubName, body);
      case "lesson_cancelled":           return lessonCancelledTemplate(clubName, body);
      case "lesson_provider_reassigned": return lessonProviderReassignedTemplate(clubName, body);
      case "lesson_admin_requested":     return lessonAdminRequestedTemplate(clubName, body);
    }
  };
}

async function dispatchLessonEmail(
  recipientUserId: string,
  kind:            LessonKind,
  requestId:       string,
): Promise<void> {
  // Skip silently if Resend is not configured (dev/test environments).
  if (!process.env.RESEND_API_KEY) return;

  const supabase = await createClient();

  // Step 1: Get notification context via security-definer RPC.
  // Direct SELECT on notifications is blocked by user_id = auth.uid() RLS.
  const { data: notifData } = await supabase.rpc("get_lesson_notification_id", {
    p_request_id: requestId,
    p_user_id:    recipientUserId,
    p_kind:       kind,
  });
  const notif = notifData as { id: string; body: string } | null;
  if (!notif?.id) return;

  // Step 2: Duplicate-delivery guard (security-definer, bypasses admin RLS).
  const { data: alreadySent } = await supabase.rpc("email_already_delivered", {
    p_notification_id: notif.id,
  });
  if (alreadySent) return;

  // Step 3: User preference guard (security-definer, works cross-user).
  const { data: prefEnabled } = await supabase.rpc("user_pref_enabled", {
    p_user_id: recipientUserId,
    p_kind:    kind,
  });
  if (prefEnabled === false) {
    await supabase.rpc("record_delivery_attempt", {
      p_notification_id: notif.id,
      p_channel:         "email",
      p_status:          "opted_out",
    });
    return;
  }

  // Step 4: Get recipient email via lesson-party-aware security-definer RPC.
  // get_user_email_for_notification cannot be used here because it requires
  // the caller to be the recipient or have role admin/pro. A member calling
  // dispatchLessonEmail to send to the pro would fail that guard. The new
  // get_lesson_recipient_email RPC authorizes by lesson-party membership.
  const { data: recipientEmail } = await supabase.rpc("get_lesson_recipient_email", {
    p_request_id: requestId,
    p_user_id:    recipientUserId,
  });
  if (!recipientEmail) return;

  // Step 5: Fetch club name for the email template.
  let clubName = "Court Time";
  const { data: recvProfile } = await supabase
    .from("profiles")
    .select("club_id")
    .eq("id", recipientUserId)
    .single();
  if (recvProfile?.club_id) {
    const { data: club } = await supabase
      .from("clubs")
      .select("name")
      .eq("id", recvProfile.club_id)
      .single();
    if (club?.name) clubName = club.name;
  }

  // Step 6: Build template, send, and record delivery.
  const { subject, html, text } = buildTemplate(kind, notif.body)(clubName);
  const { messageId, error: emailError } = await sendEmail(
    recipientEmail as string,
    subject,
    html,
    text,
  );

  if (messageId) {
    await supabase.rpc("record_delivery_attempt", {
      p_notification_id:     notif.id,
      p_channel:             "email",
      p_status:              "sent",
      p_provider:            "resend",
      p_provider_message_id: messageId,
      p_sent_at:             new Date().toISOString(),
    });
  } else {
    await supabase.rpc("record_delivery_attempt", {
      p_notification_id: notif.id,
      p_channel:         "email",
      p_status:          "failed",
      p_provider:        "resend",
      p_error:           emailError ?? "Unknown error",
    });
  }
}

// ─── submitLessonRequest ──────────────────────────────────────────────────────

export async function submitLessonRequest(params: {
  p_pro_id:             string;
  p_duration_minutes:   number;
  p_preferred_court_id?: string | null;
  p_member_note?:        string | null;
  p_preferred_windows?:  Record<string, unknown> | null;
  expectedClubId:        string;
}): Promise<{ error?: string }> {
  const guard = await assertActiveClub(params.expectedClubId);
  if (!guard.ok) return { error: mapLessonError(guard.error) };

  const supabase = await createClient();

  const { data, error } = await supabase.rpc("submit_lesson_request", {
    p_pro_id:              params.p_pro_id,
    p_duration_minutes:    params.p_duration_minutes,
    p_preferred_court_id:  params.p_preferred_court_id ?? null,
    p_member_note:         params.p_member_note        ?? null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p_preferred_windows:   (params.p_preferred_windows ?? null) as any,
    p_lesson_type_id:      null,  // explicitly target the 6-arg signature from migration 0070
  });

  if (error) return { error: mapLessonError(error.message) };

  const requestId = (data as { id?: string } | null)?.id;

  if (requestId) {
    try {
      await dispatchLessonEmail(params.p_pro_id, "lesson_request_received", requestId);
    } catch {
      // non-blocking
    }
  }

  revalidatePath("/lessons");
  revalidatePath("/events");
  return {};
}

// ─── withdrawLessonRequest ────────────────────────────────────────────────────

export async function withdrawLessonRequest(
  requestId: string,
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: mapLessonError(guard.error) };

  const supabase = await createClient();

  const { error } = await supabase.rpc("withdraw_lesson_request", {
    p_request_id: requestId,
  });

  if (error) return { error: mapLessonError(error.message) };

  revalidatePath("/lessons");
  return {};
}

// ─── acceptLessonProposal ─────────────────────────────────────────────────────

export async function acceptLessonProposal(
  requestId: string,
  proId:     string,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const { error } = await supabase.rpc("accept_lesson_proposal", {
    p_request_id: requestId,
  });

  if (error) return { error: mapLessonError(error.message) };

  if (user) {
    try {
      await dispatchLessonEmail(user.id, "lesson_request_confirmed", requestId);
    } catch { /* non-blocking */ }
    try {
      await dispatchLessonEmail(proId, "lesson_request_confirmed", requestId);
    } catch { /* non-blocking */ }
  }

  revalidatePath("/lessons");
  revalidatePath("/my-schedule");
  revalidatePath("/calendar");
  return {};
}

// ─── declineLessonProposal ────────────────────────────────────────────────────

export async function declineLessonProposal(
  requestId: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("decline_lesson_proposal", {
    p_request_id: requestId,
  });

  if (error) return { error: mapLessonError(error.message) };

  revalidatePath("/lessons");
  return {};
}

// ─── proposeLessonTime ────────────────────────────────────────────────────────
// Phase 30E: also used to propose/revise a reschedule of an already-
// confirmed lesson (allowed by the RPC when status is 'confirmed', or
// 'proposed' with a linked_reservation_id already set). p_expected_updated_at
// is required optimistic concurrency, compared against the request's current
// updated_at server-side — mismatch raises stale_edit_conflict.

export async function proposeLessonTime(params: {
  p_request_id:            string;
  p_expected_updated_at:   string;
  p_starts_at:             string;
  p_ends_at:               string;
  p_court_id?:             string | null;
  member_id:               string | null;
}): Promise<{ error?: string }> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("propose_lesson_time", {
    p_request_id:           params.p_request_id,
    p_expected_updated_at:  params.p_expected_updated_at,
    p_starts_at:            params.p_starts_at,
    p_ends_at:              params.p_ends_at,
    p_court_id:             params.p_court_id ?? null,
  });

  if (error) return { error: mapLessonError(error.message) };

  // Phase 33D1: member_id is null for a no-account Member's lesson — the
  // RPC itself now rejects this call before reaching here (member_has_no_
  // account), so this branch is unreachable in practice, but handled
  // defensively rather than assumed.
  if (params.member_id) {
    try {
      await dispatchLessonEmail(params.member_id, "lesson_request_proposed", params.p_request_id);
    } catch { /* non-blocking */ }
  }

  revalidatePath("/events");
  revalidatePath("/admin/lessons");
  return {};
}

// ─── declineLessonRequest ─────────────────────────────────────────────────────

export async function declineLessonRequest(
  requestId: string,
  memberId:  string | null,
  reason?:   string | null,
): Promise<{ error?: string }> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("decline_lesson_request", {
    p_request_id: requestId,
    p_reason:     reason ?? null,
  });

  if (error) return { error: mapLessonError(error.message) };

  // Phase 33D1: memberId is null for a no-account Member's lesson — no
  // notification of any kind is sent in that case (deferred to Phase 33E,
  // unchanged from every prior Phase 33 checkpoint). In practice this RPC
  // is unreachable for such a row at all (decline_lesson_request's own
  // status guard only permits 'pending'/'proposed'-non-reschedule, which a
  // staff-created lesson never enters — it starts 'confirmed'), but the
  // null case is still handled defensively here rather than assumed away.
  if (memberId) {
    try {
      await dispatchLessonEmail(memberId, "lesson_request_declined", requestId);
    } catch { /* non-blocking */ }
  }

  revalidatePath("/events");
  revalidatePath("/admin/lessons");
  return {};
}

// ─── cancelLesson ─────────────────────────────────────────────────────────────

export async function cancelLesson(params: {
  requestId:  string;
  memberId:   string | null;
  proId:      string;
  actorId:    string;
  reason?:    string | null;
  expectedClubId: string;
}): Promise<{ error?: string }> {
  const guard = await assertActiveClub(params.expectedClubId);
  if (!guard.ok) return { error: mapLessonError(guard.error) };

  const supabase = await createClient();

  const { data, error } = await supabase.rpc("cancel_lesson", {
    p_request_id: params.requestId,
    p_reason:     params.reason ?? null,
  });

  if (error) return { error: mapLessonError(error.message) };

  // Notify both parties who are NOT the actor. Phase 33D1: memberId is
  // null for a no-account Member's lesson — no in-app notification exists
  // for that case, matching every prior Phase 33 checkpoint. Phase 33E3:
  // now sends an operational cancellation email directly to
  // roster_members.email instead of skipping entirely.
  if (params.memberId && params.actorId !== params.memberId) {
    try {
      await dispatchLessonEmail(params.memberId, "lesson_cancelled", params.requestId);
    } catch { /* non-blocking */ }
  } else if (!params.memberId && data?.roster_member_id) {
    // A no-account Member can never be the actor (they have no account to
    // act with), so no self-notification check is needed here. Phase
    // 33E3 correction: every detail is resolved server-side from cancel_
    // lesson's own returned row (data) and its trusted pro_id/proposed_
    // court_id — never a client-supplied display string. data is the
    // just-cancelled lesson_requests row itself, so this reads the exact
    // lesson that was cancelled, not a potentially-stale client value.
    try {
      const { proName, courtName } = await resolveLessonDisplayNames(
        supabase, params.expectedClubId, data.pro_id, data.proposed_court_id,
      );
      const lines = [`Your lesson with ${proName} has been cancelled.`, ""];
      if (data.proposed_starts_at && data.proposed_ends_at) {
        const { day, timeRange } = await formatLessonWhen(
          supabase, params.expectedClubId, data.proposed_starts_at, data.proposed_ends_at,
        );
        lines.push(day, timeRange);
        if (courtName) lines.push(courtName);
      }
      if (params.reason?.trim()) {
        lines.push("", `Reason: ${params.reason.trim()}`);
      }
      await sendRosterOperationalEmail(
        supabase,
        data.roster_member_id,
        params.expectedClubId,
        "lesson_cancelled",
        (clubName) => rosterOperationalEmailTemplate(
          clubName,
          `Lesson cancelled — ${clubName}`,
          lines.join("\n"),
        ),
      );
    } catch { /* non-blocking */ }
  }
  if (params.actorId !== params.proId) {
    try {
      await dispatchLessonEmail(params.proId, "lesson_cancelled", params.requestId);
    } catch { /* non-blocking */ }
  }

  revalidatePath("/lessons");
  revalidatePath("/events");
  revalidatePath("/calendar");
  revalidatePath("/my-schedule");
  revalidatePath("/admin/lessons");
  return {};
}

// ─── getClubProsAction ────────────────────────────────────────────────────────

export interface ClubPro {
  id:                 string;
  first_name:         string | null;
  last_name:          string | null;
  role:               string;
  is_lesson_provider: boolean;
}

export async function getClubProsAction(): Promise<{ pros?: ClubPro[]; error?: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_club_pros");
  if (error) return { error: "Failed to load pros." };
  return { pros: (data ?? []) as ClubPro[] };
}

// ─── reassignLessonProviderAction ─────────────────────────────────────────────

export async function reassignLessonProviderAction(
  requestId: string,
  newProId:  string,
  memberId:  string | null,
  oldProId:  string,
): Promise<{ error?: string }> {
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("reassign_lesson_provider", {
    p_request_id: requestId,
    p_new_pro_id: newProId,
  });

  if (error) return { error: mapLessonError(error.message) };

  const resultId = (data as { id?: string } | null)?.id ?? requestId;

  // Notify new provider
  try {
    await dispatchLessonEmail(newProId, "lesson_request_received", resultId);
  } catch { /* non-blocking */ }

  // Notify old provider — always (both pending and proposed had visibility)
  try {
    await dispatchLessonEmail(oldProId, "lesson_provider_reassigned", resultId);
  } catch { /* non-blocking */ }

  // Notify member. Phase 33D1: memberId is null for a no-account Member's
  // lesson — skipped (in practice unreachable here too, same reasoning as
  // declineLessonRequest above: reassign_lesson_provider only permits
  // 'pending'/'proposed'-non-reschedule, which a staff-created lesson
  // never enters).
  if (memberId) {
    try {
      await dispatchLessonEmail(memberId, "lesson_provider_reassigned", resultId);
    } catch { /* non-blocking */ }
  }

  revalidatePath("/events");
  revalidatePath("/admin/lessons");
  return {};
}

// ─── adminCreateLessonRequestAction ───────────────────────────────────────────

export interface AdminCreateLessonParams {
  memberId:         string;
  proId:            string;
  durationMinutes:  number;
  lessonTypeId?:    string | null;
  preferredCourtId?: string | null;
  memberNote?:      string | null;
  preferredWindows?: Record<string, unknown> | null;
  expectedClubId:   string;
}

export async function adminCreateLessonRequestAction(
  params: AdminCreateLessonParams,
): Promise<{ requestId?: string; error?: string }> {
  const guard = await assertActiveClub(params.expectedClubId);
  if (!guard.ok) return { error: mapLessonError(guard.error) };

  const supabase = await createClient();

  const { data, error } = await supabase.rpc("admin_create_lesson_request", {
    p_member_id:          params.memberId,
    p_pro_id:             params.proId,
    p_duration_minutes:   params.durationMinutes,
    p_lesson_type_id:     params.lessonTypeId    ?? null,
    p_preferred_court_id: params.preferredCourtId ?? null,
    p_member_note:        params.memberNote       ?? null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p_preferred_windows:  (params.preferredWindows ?? null) as any,
  });

  if (error) return { error: mapLessonError(error.message) };

  const requestId = (data as { id?: string } | null)?.id;

  if (requestId) {
    // Notify pro
    try {
      await dispatchLessonEmail(params.proId, "lesson_request_received", requestId);
    } catch { /* non-blocking */ }
    // Notify member
    try {
      await dispatchLessonEmail(params.memberId, "lesson_admin_requested", requestId);
    } catch { /* non-blocking */ }
  }

  revalidatePath("/events");
  revalidatePath("/admin/lessons");
  revalidatePath(`/admin/members/${params.memberId}`);
  return { requestId };
}

// ─── adminCreateMemberLessonAction ────────────────────────────────────────────
// Phase 33D1: staff books a CONFIRMED lesson directly for a roster Member —
// claimed or no-account — via admin_create_member_lesson. No pending/
// proposed negotiation stage, mirroring adminCreateMemberReservation's
// directness for court bookings. Distinct from adminCreateLessonRequestAction
// above, which remains unchanged and still only starts a negotiation for an
// already-claimed Member (profiles-based, unable to target a no-account
// roster Member at all — left as-is, not the primary admin flow anymore).

export interface AdminCreateMemberLessonParams {
  rosterMemberId: string;
  proId:          string;
  courtId:        string;
  startsAt:       string;
  endsAt:         string;
  lessonTypeId?:  string | null;
  memberNote?:    string | null;
  expectedClubId: string;
}

export async function adminCreateMemberLessonAction(
  params: AdminCreateMemberLessonParams,
): Promise<{ requestId?: string; error?: string }> {
  const guard = await assertActiveClub(params.expectedClubId);
  if (!guard.ok) return { error: mapLessonError(guard.error) };

  const supabase = await createClient();

  const { data, error } = await supabase.rpc("admin_create_member_lesson", {
    p_expected_club_id: params.expectedClubId,
    p_roster_member_id: params.rosterMemberId,
    p_pro_id:           params.proId,
    p_court_id:         params.courtId,
    p_starts_at:        params.startsAt,
    p_ends_at:           params.endsAt,
    p_lesson_type_id:   params.lessonTypeId ?? null,
    p_member_note:      params.memberNote   ?? null,
  });

  if (error) return { error: mapLessonError(error.message) };

  const result = data as { id: string; member_id: string | null } | null;
  const requestId = result?.id;

  if (requestId) {
    try {
      await dispatchLessonEmail(params.proId, "lesson_request_confirmed", requestId);
    } catch { /* non-blocking */ }
    if (result?.member_id) {
      try {
        await dispatchLessonEmail(result.member_id, "lesson_request_confirmed", requestId);
      } catch { /* non-blocking */ }
    } else {
      // Phase 33E3: no-account Member — no in-app notification exists, but
      // an operational confirmation email now goes to roster_members.email
      // directly. sendRosterOperationalEmail is a safe no-op if this
      // identity turns out to be claimed (defensive; result.member_id
      // already told us it isn't). Pro/court names are resolved server-side
      // from the same trusted p_pro_id/p_court_id the RPC itself just
      // validated — never a client-supplied display string (see
      // resolveLessonDisplayNames).
      try {
        const { proName, courtName } = await resolveLessonDisplayNames(
          supabase, params.expectedClubId, params.proId, params.courtId,
        );
        const { day, timeRange } = await formatLessonWhen(supabase, params.expectedClubId, params.startsAt, params.endsAt);
        const lines = [`Your lesson with ${proName} is confirmed.`, "", day, timeRange];
        if (courtName) lines.push(courtName);
        await sendRosterOperationalEmail(
          supabase,
          params.rosterMemberId,
          params.expectedClubId,
          "lesson_request_confirmed",
          (clubName) => rosterOperationalEmailTemplate(
            clubName,
            `Your lesson is confirmed — ${clubName}`,
            [...lines, "", `If you need to make a change, contact ${clubName}.`].join("\n"),
          ),
        );
      } catch { /* non-blocking */ }
    }
  }

  revalidatePath("/events");
  revalidatePath("/admin/lessons");
  revalidatePath("/calendar");
  return { requestId };
}

// ─── adminUpdateMemberLessonAction ────────────────────────────────────────────
// Phase 33D1: staff directly edits a confirmed lesson (Member/Pro/court/
// time/type/note reassignment) via admin_update_member_lesson — no
// negotiation step, mirroring updateMemberReservationAdmin's directness.

export interface AdminUpdateMemberLessonParams {
  requestId:            string;
  expectedClubId:       string;
  expectedUpdatedAt:    string;
  rosterMemberId:       string;
  proId:                string;
  courtId:              string;
  startsAt:             string;
  endsAt:               string;
  lessonTypeId?:        string | null;
  memberNote?:          string | null;
}

export async function adminUpdateMemberLessonAction(
  params: AdminUpdateMemberLessonParams,
): Promise<{ requestId?: string; error?: string }> {
  const guard = await assertActiveClub(params.expectedClubId);
  if (!guard.ok) return { error: mapLessonError(guard.error) };

  const supabase = await createClient();

  const { data, error } = await supabase.rpc("admin_update_member_lesson", {
    p_request_id:          params.requestId,
    p_expected_club_id:    params.expectedClubId,
    p_expected_updated_at: params.expectedUpdatedAt,
    p_roster_member_id:    params.rosterMemberId,
    p_pro_id:              params.proId,
    p_court_id:            params.courtId,
    p_starts_at:           params.startsAt,
    p_ends_at:              params.endsAt,
    p_lesson_type_id:      params.lessonTypeId ?? null,
    p_member_note:         params.memberNote   ?? null,
  });

  if (error) return { error: mapLessonError(error.message) };

  const result = data as { id: string; member_id: string | null } | null;
  const requestId = result?.id;

  if (requestId) {
    try {
      await dispatchLessonEmail(params.proId, "lesson_request_confirmed", requestId);
    } catch { /* non-blocking */ }
    if (result?.member_id) {
      try {
        await dispatchLessonEmail(result.member_id, "lesson_request_confirmed", requestId);
      } catch { /* non-blocking */ }
    }
  }

  revalidatePath("/events");
  revalidatePath("/admin/lessons");
  revalidatePath("/calendar");
  return { requestId };
}

// ─── Error mapper ─────────────────────────────────────────────────────────────

function mapLessonError(msg: string): string {
  const map: Record<string, string> = {
    [STALE_CLUB_CONTEXT_ERROR]:     STALE_CLUB_MESSAGE,
    not_authenticated:              "Please sign in to continue.",
    no_club:                        "You must belong to a club to use this feature.",
    account_inactive:               "Your account is inactive.",
    pro_not_found:                  "The selected pro is not available.",
    cannot_request_yourself:        "You cannot request a lesson from yourself.",
    invalid_duration:               "Please choose a valid duration (multiples of 15 min, minimum 30 min).",
    court_not_found:                "The selected court is not available.",
    request_not_found:              "This request could not be found.",
    not_your_request:               "You can only manage your own requests.",
    invalid_status_for_withdraw:    "This request cannot be withdrawn.",
    insufficient_role:              "You don't have permission to take this action.",
    not_assigned_pro:               "You can only manage requests assigned to you.",
    invalid_status_for_propose:     "This request cannot be updated at this time.",
    cannot_propose_past_time:       "Please choose a future date and time.",
    stale_edit_conflict:            "This lesson was changed by someone else. Reload and try again.",
    cannot_reschedule_started_lesson: "This lesson has already started and can no longer be rescheduled.",
    linked_reservation_not_found:   "The confirmed booking for this lesson could not be found.",
    duration_mismatch:              "The proposed duration doesn't match the requested duration.",
    invalid_status_for_confirm:     "This request cannot be confirmed in its current state.",
    cannot_confirm_past_time:       "Please choose a future date and time.",
    invalid_duration_confirm:       "Please provide valid start and end times.",
    court_conflict:                  "That court is already occupied at the selected time.",
    operating_hours_not_configured: "Operating hours are not set up for this club.",
    club_closed_this_day:           "That time falls outside the club's operating hours.",
    outside_operating_hours:        "That time falls outside the club's operating hours.",
    pro_has_conflict:               "You already have another booking, event, or lesson at that time.",
    pro_has_event_conflict:         "You already have another booking, event, or lesson at that time.",
    proposed_time_missing:          "No time has been proposed yet.",
    proposed_time_in_past:          "The proposed time has already passed.",
    proposed_court_missing:         "No court was proposed. Ask the pro to update their proposal.",
    invalid_status_for_accept:      "This proposal is no longer available to accept.",
    invalid_status_for_decline_proposal: "There is no active proposal to decline.",
    invalid_status_for_decline:     "This request cannot be declined in its current state.",
    invalid_status_for_cancel:      "Only confirmed lessons can be cancelled.",
    not_authorised_to_cancel:       "You don't have permission to cancel this lesson.",
    lesson_already_started:         "This lesson has already started and cannot be cancelled.",
    within_cancellation_window:     "This lesson is within the club's cancellation window and cannot be cancelled.",
    member_has_conflict:            "The member already has another booking, event, or lesson at that time.",
    member_has_event_conflict:      "The member already has another booking, event, or lesson at that time.",
    member_has_lesson_conflict:     "The member already has another booking, event, or lesson at that time.",
    pro_on_blackout:                "You are unavailable on that date.",
    lesson_type_not_found:          "The selected lesson type is not available.",
    duration_not_allowed_for_type:  "That duration is not available for the selected lesson type.",
    note_too_long:                  "Your note is too long (max 500 characters).",
    reason_too_long:                "The reason is too long (max 300 characters).",
    invalid_outcome:                "Invalid lesson outcome value.",
    invalid_status_for_outcome:     "Outcome can only be recorded for confirmed lessons.",
    lesson_not_yet_started:         "The lesson has not started yet.",
    name_required:                  "Lesson type name is required.",
    name_too_long:                  "Lesson type name is too long (max 100 characters).",
    allowed_durations_empty:        "Allowed durations list cannot be empty.",
    allowed_durations_invalid:      "All durations must be positive multiples of 15 minutes.",
    rate_amount_invalid:            "Rate must be a positive number.",
    max_participants_invalid:       "Maximum participants must be at least 1.",
    blackout_date_in_past:          "Blackout date cannot be in the past.",
    invalid_day_of_week:            "Day of week must be between 0 (Sunday) and 6 (Saturday).",
    invalid_time_range:             "End time must be after start time.",
    window_not_found:               "Availability window not found.",
    blackout_not_found:             "Blackout date not found.",
    // Phase 24B
    invalid_status_for_reassign:    "Only pending or proposed requests can be reassigned.",
    same_pro:                       "The request is already assigned to this pro.",
    cannot_assign_to_self:          "Cannot assign the lesson to the member themselves.",
    member_not_found:               "Member not found.",
    // Phase 33D1
    no_roster_identity:             "Your Member profile could not be found for this club.",
    roster_member_not_found:        "The selected member could not be found.",
    member_has_no_account:          "This lesson's Member has no account yet — use Edit Lesson instead.",
    invalid_status_for_edit:        "Only confirmed lessons can be edited this way.",
    // Phase 33F3B
    capability_not_available:       "This feature isn't available at your club right now. Contact the office for help.",
    // Phase 33G1C
    member_schedule_conflict:       "The member already has another confirmed commitment at that time.",
  };
  return map[msg] ?? "Something went wrong. Please try again.";
}
