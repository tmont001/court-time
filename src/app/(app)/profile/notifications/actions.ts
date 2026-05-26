"use server";

import { createClient } from "@/lib/supabase/server";

export async function updateNotificationPreference(
  kind:    string,
  enabled: boolean,
): Promise<{ error?: string }> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("update_notification_preference", {
    p_kind:    kind,
    p_enabled: enabled,
  });

  if (error) return { error: error.message };
  return {};
}
