"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

const ERROR_MESSAGES: Record<string, string> = {
  not_authenticated:   "You must be signed in.",
  insufficient_role:   "Admin access required.",
  invalid_court:       "Court not found.",
  name_required:       "Court name cannot be blank.",
  name_too_long:       "Court name must be 60 characters or fewer.",
  name_already_exists: "A court with that name already exists.",
  invalid_court_order: "Invalid court order. Please reload and try again.",
};

function revalidateCourts() {
  revalidatePath("/admin/courts");
  revalidatePath("/calendar");
}

export async function addCourt(name: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("add_court", { p_name: name });
  if (error) {
    const key = error.message.match(/not_authenticated|insufficient_role|name_required|name_too_long|name_already_exists/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to add court." };
  }

  revalidateCourts();
  return {};
}

export async function renameCourt(courtId: string, name: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("rename_court", { p_court_id: courtId, p_name: name });
  if (error) {
    const key = error.message.match(/not_authenticated|insufficient_role|invalid_court|name_required|name_too_long|name_already_exists/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to rename court." };
  }

  revalidateCourts();
  return {};
}

export async function reorderCourts(courtOrder: string[]): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("reorder_courts", { p_court_order: courtOrder });
  if (error) {
    const key = error.message.match(/not_authenticated|insufficient_role|invalid_court_order/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to reorder courts." };
  }

  revalidateCourts();
  return {};
}

export async function setCourtActive(
  courtId: string,
  isActive: boolean
): Promise<{ error?: string; futureCount?: number }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("set_court_active", {
    p_court_id: courtId,
    p_is_active: isActive,
  });

  if (error) {
    const futureMatch = error.message.match(/court_has_future_reservations:\s*(\d+)/);
    if (futureMatch) {
      return { error: "court_has_future_reservations", futureCount: parseInt(futureMatch[1], 10) };
    }
    const key = error.message.match(/not_authenticated|insufficient_role|invalid_court/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to update court." };
  }

  revalidateCourts();
  return {};
}

export async function deleteCourt(courtId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("delete_court", { p_court_id: courtId });
  if (error) {
    if (error.message.includes("court_has_history")) {
      return { error: "court_has_history" };
    }
    const key = error.message.match(/not_authenticated|insufficient_role|invalid_court/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to delete court." };
  }

  revalidateCourts();
  return {};
}
