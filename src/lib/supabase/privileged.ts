// Server-only. Never import from a Client Component or any module that
// could end up in the browser bundle.
//
// This is the ONLY client in the app that authenticates with an elevated,
// backend-only Supabase key (SUPABASE_SECRET_KEY) rather than the public
// anon/publishable key. It exists for exactly one purpose: calling RPCs
// that are deliberately granted to `service_role` only, such as
// submit_pilot_inquiry (Phase 32C) — a public-facing operation that must
// still be reachable by a signed-out visitor, but only through the Next.js
// Server Action, never directly from the browser with the public key.
//
// Deliberately built with the plain @supabase/supabase-js client rather
// than the SSR cookie-aware client from src/lib/supabase/server.ts — an
// authenticated visitor's session cookie must never be able to substitute
// for this privileged identity, and this client never reads or writes
// cookies at all. persistSession/autoRefreshToken/detectSessionInUrl are
// all disabled because there is no session here to manage.
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";

// Returns null (never throws) when SUPABASE_SECRET_KEY is not configured,
// so callers fail closed instead of falling back to a lower-privilege
// client. Never logs the key itself.
export function createPrivilegedClient(): SupabaseClient<Database> | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) return null;

  return createSupabaseClient<Database>(url, secretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
