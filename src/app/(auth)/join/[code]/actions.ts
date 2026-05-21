"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_invite:    "This invite link is not valid.",
  invite_revoked:    "This invite has been revoked.",
  invite_used:       "This invite has already been used.",
  invite_expired:    "This invite has expired.",
  email_mismatch:    "This invite was sent to a different email address.",
  already_in_club:   "Your account is already assigned to a club.",
  not_authenticated: "You must be signed in to accept this invitation.",
};

export async function acceptInviteAction(
  code: string
): Promise<{ error: string } | undefined> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("accept_club_invite", { p_code: code });

  if (error) {
    const key = Object.keys(ERROR_MESSAGES).find((k) =>
      error.message.includes(k)
    );
    return {
      error: key
        ? ERROR_MESSAGES[key]
        : "Failed to accept the invite. Please try again.",
    };
  }

  // Redirect to /welcome if the profile is not yet complete, /calendar otherwise.
  const { data: profile } = await supabase
    .from("profiles")
    .select("first_name, last_name")
    .eq("id", user.id)
    .single();

  if (!profile?.first_name || !profile?.last_name) {
    redirect("/welcome");
  }
  redirect("/calendar");
}
