"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";

const COOKIE_NAME = "ct_invite_pending";
const CODE_RE = /^[0-9a-f]{32}$/;

const ERROR_MESSAGES: Record<string, string> = {
  invalid_invite:    "This invite link is not valid.",
  invite_revoked:    "This invite has been revoked.",
  invite_used:       "This invite has already been used.",
  invite_expired:    "This invite has expired. Ask your admin for a new link.",
  email_mismatch:    "This invite was sent to a different email address.",
  // Phase 26D1: replaces the old single-club "already_in_club" gate, which
  // no longer exists — accept_club_invite (0084) now allows an already-
  // clubbed user to accept an invite to a different club. These two errors
  // cover the destination club's own existing-membership states.
  already_member:            "You're already a member of this club.",
  membership_state_conflict: "Your account already has a membership at this club that can't be restored this way. Contact your club administrator.",
  not_authenticated: "You must be signed in to accept this invitation.",
};

// Failures that mean the invite is permanently unusable — clear the cookie so
// subsequent sign-in attempts don't keep retrying a dead code.
const DEFINITIVE_ERRORS = new Set([
  "invalid_invite",
  "invite_revoked",
  "invite_used",
  "invite_expired",
  "email_mismatch",
  "already_member",
  "membership_state_conflict",
]);

async function clearInviteCookie(): Promise<void> {
  (await cookies()).delete(COOKIE_NAME);
}

async function destAfterAccept(userId: string): Promise<"/calendar" | "/welcome"> {
  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("first_name, last_name")
    .eq("id", userId)
    .single();
  const firstName = profile?.first_name?.trim() ?? "";
  const lastName  = profile?.last_name?.trim()  ?? "";
  return firstName && lastName ? "/calendar" : "/welcome";
}

// Used by AcceptButton on the /join/[code] page (existing-account sign-in flow).
export async function acceptInviteAction(
  code: string
): Promise<{ error: string } | undefined> {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("accept_club_invite", { p_code: code });

  if (error) {
    const key = Object.keys(ERROR_MESSAGES).find((k) => error.message.includes(k));
    if (key && DEFINITIVE_ERRORS.has(key)) await clearInviteCookie();
    return {
      error: key ? ERROR_MESSAGES[key] : "Failed to accept the invite. Please try again.",
    };
  }

  await clearInviteCookie();
  const dest = await destAfterAccept(user.id);
  redirect(dest);
}

// Called from sign-up (immediate session) and sign-in after authentication.
// Uses explicitCode when provided and valid; falls back to the ct_invite_pending
// cookie otherwise. Calls redirect() on success. Returns { error } on failure,
// { noInvite: true } when no code is available at all.
export async function acceptPendingInviteAction(
  explicitCode?: string
): Promise<{ error: string } | { noInvite: true } | undefined> {
  // Resolve the code: explicit parameter first, then cookie fallback.
  let code = (explicitCode ?? "").trim().toLowerCase();
  if (!CODE_RE.test(code)) {
    const store = await cookies();
    const cookieCode = store.get(COOKIE_NAME)?.value ?? "";
    if (CODE_RE.test(cookieCode)) {
      code = cookieCode;
    } else {
      return { noInvite: true };
    }
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("accept_club_invite", { p_code: code });

  if (error) {
    const key = Object.keys(ERROR_MESSAGES).find((k) => error.message.includes(k));
    if (key && DEFINITIVE_ERRORS.has(key)) await clearInviteCookie();
    return {
      error: key ? ERROR_MESSAGES[key] : "Failed to accept the invite. Please try again.",
    };
  }

  await clearInviteCookie();
  const dest = await destAfterAccept(user.id);
  redirect(dest);
}
