"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export async function updateProfile(formData: FormData) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const firstName = (formData.get("first_name") as string | null)?.trim() || null;
  const lastName  = (formData.get("last_name")  as string | null)?.trim() || null;
  const phone     = (formData.get("phone")      as string | null)?.trim() || null;

  await supabase
    .from("profiles")
    .update({ first_name: firstName, last_name: lastName, phone })
    .eq("id", user.id);

  revalidatePath("/profile");
}
