import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";

export async function createClient(): Promise<SupabaseClient<Database>> {
  // cookies() must be called inside each handler closure in Next.js 15 so that
  // the cookie store is always resolved against the current request, not cached
  // from a previous evaluation.
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        async getAll() {
          return (await cookies()).getAll();
        },
        async setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            const store = await cookies();
            cookiesToSet.forEach(({ name, value, options }) =>
              store.set(name, value, options)
            );
          } catch {
            // Server Component — cookies can only be written in Server Actions / Route Handlers
          }
        },
      },
    }
  ) as unknown as SupabaseClient<Database>;
}
