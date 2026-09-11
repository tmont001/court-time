"use server";

// Phase 35C — Server Actions for personal calendar subscription
// management. Thin glue only: identity/stale-club preflight (the same
// pattern every other mutation in this app uses), raw-token generation +
// hashing (src/lib/calendar/feedToken.ts — the raw token is constructed
// here and returned to the browser exactly once; it is never sent to
// Postgres), and the RPC call itself. All real authorization/validation
// (role, member_self_service, one-active-token-per-scope, stale-club
// re-check) happens inside the SECURITY DEFINER functions in
// supabase/migrations/0173_calendar_feed_subscriptions.sql — this file
// never duplicates that logic.

import { getAuthUser } from "@/lib/supabase/user";
import { createClient } from "@/lib/supabase/server";
import { assertActiveClub } from "@/lib/supabase/staleClub";
import { generateRawFeedToken, hashFeedToken } from "@/lib/calendar/feedToken";
import { SITE_URL } from "@/lib/siteUrl";
import { revalidatePath } from "next/cache";

export type CalendarFeedType = "member_personal" | "pro_lessons";

export interface CalendarFeedUrls {
  httpsUrl: string;
  webcalUrl: string;
}

function feedUrls(rawToken: string): CalendarFeedUrls {
  const httpsUrl = `${SITE_URL}/api/calendar/feed/${rawToken}`;
  return { httpsUrl, webcalUrl: httpsUrl.replace(/^https?:\/\//, "webcal://") };
}

function mapCalendarFeedError(message: string): string {
  const known = [
    "stale_club_context",
    "insufficient_role",
    "capability_not_available",
    "invalid_feed_type",
    "no_active_token",
    "no_active_club",
    "not_authenticated",
  ];
  return known.includes(message) ? message : "unknown_error";
}

// Serves BOTH "Create subscription" and "Regenerate link" — they are the
// identical operation (issue_calendar_feed_token itself revokes any
// existing active token for this exact scope before inserting the new
// one, per the 0173 migration's own locked REGENERATE semantics), so this
// app has no separate regenerate RPC/action to keep in sync.
export async function issueCalendarFeedToken(
  feedType: CalendarFeedType,
  expectedClubId: string,
): Promise<{ urls?: CalendarFeedUrls; error?: string }> {
  const user = await getAuthUser();
  if (!user) return { error: "not_authenticated" };

  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: guard.error };

  const rawToken = generateRawFeedToken();
  const tokenHash = hashFeedToken(rawToken);

  const supabase = await createClient();
  const { error } = await supabase.rpc("issue_calendar_feed_token", {
    p_feed_type: feedType,
    p_token_hash: tokenHash,
    p_expected_club_id: expectedClubId,
  });

  if (error) return { error: mapCalendarFeedError(error.message) };

  revalidatePath("/profile/notifications");
  return { urls: feedUrls(rawToken) };
}

export async function revokeCalendarFeedToken(
  feedType: CalendarFeedType,
  expectedClubId: string,
): Promise<{ error?: string }> {
  const user = await getAuthUser();
  if (!user) return { error: "not_authenticated" };

  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: guard.error };

  const supabase = await createClient();
  const { error } = await supabase.rpc("revoke_calendar_feed_token", {
    p_feed_type: feedType,
    p_expected_club_id: expectedClubId,
  });

  if (error) return { error: mapCalendarFeedError(error.message) };

  revalidatePath("/profile/notifications");
  return {};
}
