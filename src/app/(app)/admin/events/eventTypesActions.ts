"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// Admin UX Checkpoint 3 — Events IA. Moved verbatim from
// admin/settings/actions.ts along with EventTypesSection — same five RPCs,
// same validation, same messages, same admin-only server-side enforcement
// (every RPC independently re-checks insufficient_role; this file's own
// !user check is a plain auth guard, not the authorization boundary).
const ERROR_MESSAGES: Record<string, string> = {
  not_authenticated:           "You must be signed in.",
  insufficient_role:           "Admin access required.",
  invalid_label:               "Label cannot be blank.",
  invalid_color:               "Color must be a valid hex color (e.g. #3B7DD8).",
  not_found:                   "Event type not found.",
  invalid_event_type:          "Event type not found.",
  protected_event_type:        "Built-in event types cannot be deleted.",
  event_type_active:           "Deactivate this type before deleting it.",
  event_type_in_use:           "This type has been used by existing events, including cancelled or archived events, so it cannot be permanently deleted. Keep it inactive instead.",
  // Phase 33G3: raised by event_types' retirement trigger (0129) — Book
  // Lesson is now the canonical Lesson workflow, so this one legacy type
  // can never be reactivated.
  event_type_retired:          "This event type has been retired and can't be reactivated. Book Lesson is now the canonical Lesson workflow.",
  invalid_price:               "Price must be zero or a positive amount.",
};

export async function createEventType(
  label: string,
  color: string
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("create_event_type", {
    p_label: label,
    p_color: color,
  });
  if (error) {
    const key = error.message.match(/invalid_label|invalid_color|not_authenticated|insufficient_role/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to create event type." };
  }

  revalidatePath("/", "layout");
  return {};
}

export async function updateEventType(
  id: string,
  label: string,
  color: string
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("update_event_type", {
    p_id:    id,
    p_label: label,
    p_color: color,
  });
  if (error) {
    const key = error.message.match(/invalid_label|invalid_color|not_found|not_authenticated|insufficient_role/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to update event type." };
  }

  revalidatePath("/", "layout");
  return {};
}

export async function setEventTypeActive(
  id: string,
  isActive: boolean
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("set_event_type_active", {
    p_id:        id,
    p_is_active: isActive,
  });
  if (error) {
    const key = error.message.match(/not_found|not_authenticated|insufficient_role|event_type_retired/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to update event type." };
  }

  revalidatePath("/", "layout");
  return {};
}

export async function deleteEventType(
  id: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("delete_event_type", { p_id: id });
  if (error) {
    const key = error.message.match(
      /invalid_event_type|not_found|insufficient_role|protected_event_type|event_type_active|event_type_in_use|not_authenticated/
    )?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to delete event type." };
  }

  revalidatePath("/", "layout");
  return {};
}

export async function setEventTypePrice(
  id: string,
  defaultPriceAmountCents: number | null,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("set_event_type_price", {
    p_id: id,
    p_default_price_amount_cents: defaultPriceAmountCents,
  });
  if (error) {
    const key = error.message.match(/invalid_event_type|invalid_price|not_found|not_authenticated|insufficient_role/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to save event type price." };
  }

  revalidatePath("/", "layout");
  return {};
}
