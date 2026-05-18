"use server";

import { createClient } from "@/lib/supabase/server";

export type AuditLogRow = {
  id: string;
  actor_name: string;
  action: string;
  target_type: string;
  target_id: string;
  metadata: unknown;
  created_at: string;
};

export async function fetchMoreAuditLog(
  offset: number
): Promise<{ rows: AuditLogRow[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { rows: [], error: "Not authenticated." };

  const { data, error } = await supabase.rpc("get_audit_log", {
    p_limit:  50,
    p_offset: offset,
  });

  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as AuditLogRow[] };
}
