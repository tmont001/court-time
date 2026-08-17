"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

const ERROR_MESSAGES: Record<string, string> = {
  not_authenticated:             "You must be signed in.",
  insufficient_role:             "Only admins can manage members.",
  no_club:                       "Your account is not assigned to a club.",
  invalid_role:                  "Invalid role selection.",
  invalid_status:                "Invalid status value.",
  user_not_found:                "Member not found in your club.",
  cannot_change_own_role:        "You cannot change your own role.",
  cannot_change_own_status:      "You cannot change your own status.",
  last_admin:                    "This is the last active admin. Promote another member first.",
  cannot_remove_self:            "You cannot remove your own membership.",
  invite_already_accepted:       "This invite has already been accepted.",
  invite_already_revoked:        "This invite has already been revoked.",
  invalid_invite:                "Invite not found.",
  first_name_required:           "Please enter a first name.",
  last_name_required:            "Please enter a last name.",
  email_already_on_roster:       "This email is already on the roster.",
  email_already_a_member:        "This email already belongs to a member.",
  roster_member_not_found:       "Roster member not found.",
  roster_member_already_claimed: "This member has already created an account.",
  roster_member_claimed:         "This member has already created an account. Use the account's membership controls instead.",
  roster_member_already_inactive: "This member is already removed.",
  roster_member_not_removed:      "This member is not currently removed.",
  roster_member_update_failed:    "Something changed before this could be saved. Please try again.",
  // Phase 33E2-correction: create_club_invite/resend_club_invite now reject
  // an inactive roster target — restore the Member first, then invite.
  roster_member_inactive:        "This member is currently removed. Restore them first, then send a new invite.",
  email_required:                "Email is required for invite generation.",
  invalid_email_format:          "Please enter a valid email address.",
  invite_already_pending:        "An active invite already exists for this email.",
  // Phase 33B1 — roster-first invite creation/resend.
  roster_identity_required:      "No Member record is linked to this invite, so it can't be resent. Recreate it using Add Member + Invite, or Send Invite from an existing roster member.",
  roster_email_required:         "Add an email to this member's roster record before sending an invite.",
  // Phase 33F3B — a Staff-Managed club cannot invite a new Member account.
  capability_not_available:      "This club is on the Staff-Managed plan, which doesn't include Member self-service accounts. Contact support to enable it.",
};

function mapError(message: string): string {
  const key = Object.keys(ERROR_MESSAGES).find((k) => message.includes(k));
  return key ? ERROR_MESSAGES[key] : "Something went wrong. Please try again.";
}

// Phase 33B1: replaces the old free-form createInviteAction. Every invite
// capable of creating a new membership must be bound to an existing roster
// identity — this sheet's only caller (InviteSheet, opened from an existing
// roster member row) already has one.
export async function createRosterInviteAction(
  rosterMemberId: string,
  role: string,
  expiryDays: number
): Promise<{ code?: string; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expiryDays);

  const { data, error } = await supabase.rpc("create_club_invite", {
    p_role:              role,
    p_roster_member_id:  rosterMemberId,
    p_expires_at:        expiresAt.toISOString(),
  });

  if (error) return { error: mapError(error.message) };

  revalidatePath("/admin/members");
  return { code: data ?? undefined };
}

export async function setMemberRoleAction(
  targetUserId: string,
  newRole: string
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("set_member_role", {
    p_target_user_id: targetUserId,
    p_new_role:       newRole,
  });
  if (error) return { error: mapError(error.message) };

  revalidatePath("/admin/members");
  return {};
}

export async function setMemberStatusAction(
  targetUserId: string,
  newStatus: string
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  // Phase 26D2: newStatus now also accepts "suspended" — set_member_status
  // (0086) validates the vocabulary server-side; this action is an
  // unchanged pass-through.
  const { error } = await supabase.rpc("set_member_status", {
    p_target_user_id: targetUserId,
    p_new_status:     newStatus,
  });
  if (error) return { error: mapError(error.message) };

  revalidatePath("/admin/members");
  return {};
}

// Phase 26D2: explicit removal (removed_at/removed_by), scoped to the
// caller's active club only — never touches the target's memberships in
// any other club.
export async function removeMemberAction(
  targetUserId: string
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("remove_club_member", {
    p_target_user_id: targetUserId,
  });
  if (error) return { error: mapError(error.message) };

  revalidatePath("/admin/members");
  revalidatePath(`/admin/members/${targetUserId}`);
  return {};
}

// Phase 26D2: explicit restoration — clears removed_at/removed_by only,
// preserving whatever role/status the membership had when removed.
export async function restoreMemberAction(
  targetUserId: string
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("restore_club_member", {
    p_target_user_id: targetUserId,
  });
  if (error) return { error: mapError(error.message) };

  revalidatePath("/admin/members");
  revalidatePath(`/admin/members/${targetUserId}`);
  return {};
}

export async function revokeInviteAction(
  code: string
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("revoke_club_invite", { p_code: code });
  if (error) return { error: mapError(error.message) };

  revalidatePath("/admin/members");
  return {};
}

// ── Admin notes on signed-in members ─────────────────────────────────────

export async function setMemberNotesAction(
  targetUserId: string,
  notes: string | null
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("set_member_notes", {
    p_target_user_id: targetUserId,
    p_notes:          notes || null,
  });
  if (error) return { error: mapError(error.message) };

  revalidatePath("/admin/members");
  return {};
}

// ── Roster member actions ────────────────────────────────────────────────

// ── Add roster member + invite atomically ────────────────────────────────────

export type AddAndInviteInput = {
  firstName: string;
  lastName:  string;
  email:     string;
  role:      "member" | "pro";
  phone:     string | null;
  notes:     string | null;
};

export async function addRosterMemberAndInviteAction(
  input: AddAndInviteInput
): Promise<{ rosterMemberId?: string; code?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { data, error } = await supabase.rpc("add_roster_member_and_invite", {
    p_first_name: input.firstName,
    p_last_name:  input.lastName,
    p_email:      input.email,
    p_role:       input.role,
    p_phone:      input.phone ?? null,
    p_notes:      input.notes ?? null,
  });

  if (error) return { error: mapError(error.message) };

  const result = data as { roster_member_id: string; code: string } | null;
  revalidatePath("/admin/members");
  return {
    rosterMemberId: result?.roster_member_id,
    code:           result?.code,
  };
}

export async function addRosterMemberAction(
  firstName: string,
  lastName: string,
  email: string | null,
  phone: string | null,
  role: string,
  notes: string | null
): Promise<{ id?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { data, error } = await supabase.rpc("add_roster_member", {
    p_first_name: firstName,
    p_last_name:  lastName,
    p_email:      email || null,
    p_phone:      phone || null,
    p_role:       role,
    p_notes:      notes || null,
  });
  if (error) return { error: mapError(error.message) };

  revalidatePath("/admin/members");
  return { id: data ?? undefined };
}

export async function updateRosterMemberAction(
  id: string,
  firstName: string,
  lastName: string,
  email: string | null,
  phone: string | null,
  role: string,
  notes: string | null
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("update_roster_member", {
    p_id:         id,
    p_first_name: firstName,
    p_last_name:  lastName,
    p_email:      email || null,
    p_phone:      phone || null,
    p_role:       role,
    p_notes:      notes || null,
  });
  if (error) return { error: mapError(error.message) };

  revalidatePath("/admin/members");
  return {};
}

// Phase 33E2-correction: kept as an unused cleanup primitive only — no
// normal UI path calls this anymore (see removeRosterMemberAction below).
// A future explicit "delete mistaken pristine record" workflow may still
// reach for it; normal membership lifecycle must not.
export async function deleteRosterMemberAction(
  id: string
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("delete_roster_member", { p_id: id });
  if (error) return { error: mapError(error.message) };

  revalidatePath("/admin/members");
  return {};
}

// Phase 33E2-correction: soft removal for a no-account (unclaimed) roster
// Member — preserves the roster identity and its full history, only marks
// it inactive. This is now the normal-lifecycle "Remove" action for a
// no-account Member; delete_roster_member above is no longer used for it.
export async function removeRosterMemberAction(
  id: string
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("remove_roster_member", { p_roster_member_id: id });
  if (error) return { error: mapError(error.message) };

  revalidatePath("/admin/members");
  return {};
}

// Phase 33E2-correction: restores the same roster identity a no-account
// Member had before removal — never a new row.
export async function restoreRosterMemberAction(
  id: string
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("restore_roster_member", { p_roster_member_id: id });
  if (error) return { error: mapError(error.message) };

  revalidatePath("/admin/members");
  return {};
}

// ── Bulk import ────────────────────────────────────────────────────────────

export type ImportRowInput = {
  firstName: string;
  lastName:  string;
  email:     string | null;
  phone:     string | null;
  notes:     string | null;
};

export type ImportRowError = {
  row:     number;   // 1-based index in the submitted rows array
  name:    string;   // "First Last" for display
  message: string;
};

export type ImportResult = {
  imported: number;
  failed:   number;
  errors:   ImportRowError[];
};

// Phase 33B1: revoke-then-create is now a single server-side transaction
// (resend_club_invite) instead of two separate RPC calls — closes a latent
// atomicity gap (a revoke succeeding while create failed used to leave no
// valid invite at all) and resolves/validates a roster identity before
// touching anything. role/email are no longer passed from the client; the
// RPC re-derives them from the invite being resent.
export async function resendInviteAction(
  oldCode: string,
): Promise<{ code?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  const { data, error } = await supabase.rpc("resend_club_invite", {
    p_old_code:   oldCode,
    p_expires_at: expiresAt.toISOString(),
  });

  if (error) return { error: mapError(error.message) };

  revalidatePath("/admin/members");
  return { code: data ?? undefined };
}

// ── Bulk invite import ─────────────────────────────────────────────────────

export type InviteRowInput = {
  firstName: string;
  lastName:  string;
  email:     string;
  role:      "member" | "pro";
};

export type InviteRowResult = {
  email:      string;
  name:       string;
  role:       "member" | "pro";
  code?:      string;
  error?:     string;
  skippedAs?: "existing-member" | "existing-roster" | "existing-invite";
};

export type InviteImportResult = {
  generated: number;
  failed:    number;
  results:   InviteRowResult[];
};

export async function importInvitesAction(
  rows: InviteRowInput[]
): Promise<{ result?: InviteImportResult; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  // Derive club_id from the authenticated profile — never trust the browser.
  const { data: profile } = await supabase
    .from("profiles")
    .select("club_id, role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") return { error: ERROR_MESSAGES.insufficient_role };
  const clubId = profile?.club_id;
  if (!clubId) return { error: ERROR_MESSAGES.no_club };

  if (rows.length === 0) return { result: { generated: 0, failed: 0, results: [] } };

  const emails = rows.map(r => r.email.toLowerCase());
  const nowIso = new Date().toISOString();

  // Authoritative server-side duplicate checks — do not trust browser classification.
  // get_members() is SECURITY DEFINER and joins auth.users for email (profiles has none).
  // roster_members and club_invites are queried with explicit club_id filter.
  const [membersRpc, rosterResult, invitesResult] = await Promise.all([
    supabase.rpc("get_members"),
    supabase
      .from("roster_members")
      .select("email")
      .eq("club_id", clubId)
      .in("email", emails),
    supabase
      .from("club_invites")
      .select("email")
      .eq("club_id", clubId)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .gt("expires_at", nowIso)
      .in("email", emails),
  ]);

  const existingMemberEmails = new Set<string>(
    (membersRpc.data ?? [])
      .map(m => (m.email ?? "").toLowerCase())
      .filter(Boolean)
  );
  const existingRosterEmails = new Set<string>(
    (rosterResult.data ?? [])
      .map(r => ((r.email as string | null) ?? "").toLowerCase())
      .filter(Boolean)
  );
  const existingInviteEmails = new Set<string>(
    (invitesResult.data ?? [])
      .map(r => ((r.email as string | null) ?? "").toLowerCase())
      .filter(Boolean)
  );

  const results: InviteRowResult[] = [];
  let generated = 0;
  let failed    = 0;

  // add_roster_member_and_invite always uses a fixed 7-day expiry
  // internally — no p_expires_at parameter to compute here.
  for (const row of rows) {
    const name       = [row.firstName, row.lastName].filter(Boolean).join(" ");
    const emailLower = row.email.toLowerCase();

    if (existingMemberEmails.has(emailLower)) {
      results.push({ email: row.email, name, role: row.role, skippedAs: "existing-member" });
      continue;
    }
    if (existingRosterEmails.has(emailLower)) {
      results.push({ email: row.email, name, role: row.role, skippedAs: "existing-roster" });
      continue;
    }
    if (existingInviteEmails.has(emailLower)) {
      results.push({ email: row.email, name, role: row.role, skippedAs: "existing-invite" });
      continue;
    }

    // Phase 33B1: roster identity first, per row — reuses the same RPC and
    // duplicate-safety logic as the single-row "Add and Generate Invite"
    // flow (AddMemberSheet.tsx) instead of creating a bare, unlinked
    // invite. firstName/lastName were already collected by this form but
    // previously only used for display (actions.ts pre-33B1) — now they
    // create the roster identity the invite is bound to. On any error, the
    // row fails safely and is reported per-row; no partial identity is
    // ever created (add_roster_member_and_invite itself only writes after
    // all of its own validation passes).
    const { data, error } = await supabase.rpc("add_roster_member_and_invite", {
      p_first_name: row.firstName,
      p_last_name:  row.lastName,
      p_email:      row.email,
      p_role:       row.role,
    });
    if (error) {
      results.push({ email: row.email, name, role: row.role, error: mapError(error.message) });
      failed++;
    } else {
      const code = (data as { code?: string } | null)?.code;
      results.push({ email: row.email, name, role: row.role, code: code ?? undefined });
      generated++;
    }
  }

  revalidatePath("/admin/members");
  return { result: { generated, failed, results } };
}

export async function importRosterMembersAction(
  rows: ImportRowInput[]
): Promise<{ result?: ImportResult; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const errors: ImportRowError[] = [];
  let imported = 0;

  for (let i = 0; i < rows.length; i++) {
    const row  = rows[i];
    const name = [row.firstName, row.lastName].filter(Boolean).join(" ");

    const { error } = await supabase.rpc("add_roster_member", {
      p_first_name: row.firstName,
      p_last_name:  row.lastName,
      p_email:      row.email   || null,
      p_phone:      row.phone   || null,
      p_role:       "member",
      p_notes:      row.notes   || null,
    });

    if (error) {
      errors.push({ row: i + 1, name, message: mapError(error.message) });
    } else {
      imported++;
    }
  }

  revalidatePath("/admin/members");

  return {
    result: {
      imported,
      failed: errors.length,
      errors,
    },
  };
}
