"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

const ERROR_MESSAGES: Record<string, string> = {
  not_authenticated:       "You must be signed in.",
  insufficient_role:       "Admin access required.",
  no_club:                 "Your account is not assigned to a club.",
  invalid_role:            "Invalid role selection.",
  invite_already_accepted: "This invite has already been accepted.",
  invite_already_revoked:  "This invite has already been revoked.",
  invalid_invite:          "Invite not found.",
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
