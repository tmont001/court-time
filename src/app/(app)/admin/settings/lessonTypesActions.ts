"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// Phase 34B (final refinement): a Lesson Type's price is either FLAT (the
// configured amount is the whole Lesson's total) or HOURLY (the configured
// amount is an hourly rate, multiplied by the Lesson's own duration when a
// Lesson is created/edited) — no per-Pro override, no per-participant
// calculation. unitPriceAmountCents null = no price configured, 0 = free.
const ERROR_MESSAGES: Record<string, string> = {
  not_authenticated:        "You must be signed in.",
  insufficient_role:        "Admin access required.",
  no_club:                  "You must be signed in.",
  name_required:            "Name cannot be blank.",
  name_too_long:            "Name must be 100 characters or fewer.",
  allowed_durations_empty:  "Choose at least one duration, or leave durations unrestricted.",
  allowed_durations_invalid: "Durations must be positive multiples of 15 minutes.",
  invalid_pricing_basis:    "Choose Flat per lesson or Hourly.",
  unit_price_invalid:       "Amount must be zero or a positive amount.",
  max_participants_invalid: "Max participants must be at least 1.",
  lesson_type_not_found:    "Lesson type not found.",
};

export async function upsertLessonType(params: {
  id?: string | null;
  name: string;
  description: string | null;
  allowedDurations: number[] | null;
  maxParticipants: number;
  pricingBasis: "flat" | "hourly";
  unitPriceAmountCents: number | null;
  rateNotes: string | null;
}): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("upsert_lesson_type", {
    p_id: params.id ?? null,
    p_name: params.name,
    p_description: params.description,
    p_allowed_durations: params.allowedDurations,
    p_max_participants: params.maxParticipants,
    p_pricing_basis: params.pricingBasis,
    p_unit_price_amount_cents: params.unitPriceAmountCents,
    p_rate_notes: params.rateNotes,
  });
  if (error) {
    const key = error.message.match(
      /not_authenticated|insufficient_role|no_club|name_required|name_too_long|allowed_durations_empty|allowed_durations_invalid|invalid_pricing_basis|unit_price_invalid|max_participants_invalid|lesson_type_not_found/
    )?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to save lesson type." };
  }

  revalidatePath("/", "layout");
  return {};
}

export async function archiveLessonType(id: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("archive_lesson_type", { p_type_id: id });
  if (error) {
    const key = error.message.match(/not_authenticated|insufficient_role|lesson_type_not_found/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to archive lesson type." };
  }

  revalidatePath("/", "layout");
  return {};
}
