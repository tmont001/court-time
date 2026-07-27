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
  email_required:                "Email is required for invite generation.",
  invalid_email_format:          "Please enter a valid email address.",
  invite_already_pending:        "An active invite already exists for this email.",
};

function mapError(message: string): string {
  const key = Object.keys(ERROR_MESSAGES).find((k) => message.includes(k));
  return key ? ERROR_MESSAGES[key] : "Something went wrong. Please try again.";
}

export async function createInviteAction(
  role: string,
  email: string | null,
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
    p_role:       role,
    p_email:      email || null,
    p_expires_at: expiresAt.toISOString(),
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

export async function resendInviteAction(
  oldCode: string,
  role: string,
  email: string | null,
): Promise<{ code?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  // Revoke the old invite so it disappears from the list. Errors are ignored:
  // the invite may already be expired (which is fine — revoke still works) or
  // already revoked (shouldn't happen in normal flow but harmless).
  await supabase.rpc("revoke_club_invite", { p_code: oldCode });

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  const { data, error } = await supabase.rpc("create_club_invite", {
    p_role:       role,
    p_email:      email || null,
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

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);
  const expiresAtIso = expiresAt.toISOString();

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

    const { data, error } = await supabase.rpc("create_club_invite", {
      p_role:       row.role,
      p_email:      row.email,
      p_expires_at: expiresAtIso,
    });
    if (error) {
      results.push({ email: row.email, name, role: row.role, error: mapError(error.message) });
      failed++;
    } else {
      results.push({ email: row.email, name, role: row.role, code: data ?? undefined });
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
