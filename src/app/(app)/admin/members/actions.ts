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
  invite_already_accepted:       "This invite has already been accepted.",
  invite_already_revoked:        "This invite has already been revoked.",
  invalid_invite:                "Invite not found.",
  first_name_required:           "Please enter a first name.",
  last_name_required:            "Please enter a last name.",
  email_already_on_roster:       "This email is already on the roster.",
  email_already_a_member:        "This email already belongs to a member.",
  roster_member_not_found:       "Roster member not found.",
  roster_member_already_claimed: "This member has already created an account.",
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

  const { error } = await supabase.rpc("set_member_status", {
    p_target_user_id: targetUserId,
    p_new_status:     newStatus,
  });
  if (error) return { error: mapError(error.message) };

  revalidatePath("/admin/members");
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
