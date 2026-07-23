import { cache } from "react";
import { createClient } from "./server";

// Per-request memoized auth user.
// React.cache() resets on every RSC request — never shared across users or requests.
// Layouts and pages rendered in the same request share this result, so Supabase
// Auth is only validated once per request regardless of how many RSC segments call it.
export const getAuthUser = cache(async () => {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
});

// Per-request memoized profile.
// Selects a superset of all fields consumed by any layout or page so that the
// single network request satisfies every caller.  Different callers previously
// used different select() column sets, producing distinct PostgREST URLs that
// bypassed Next.js fetch deduplication.  With this helper they all read from
// the same memoized result.
//
// Fields covered:
//   id, club_id, role  — AppLayout, AdminLayout, every admin page
//   status             — invite guard in AppLayout
//   first_name, last_name, phone — ProfilePage, ProfileEditForm
//   is_lesson_provider — ProfilePage Lesson Pro indicator (Phase 25B+)
export const getAuthProfile = cache(async () => {
  const user = await getAuthUser();
  if (!user) return null;
  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, club_id, role, status, first_name, last_name, phone, is_lesson_provider")
    .eq("id", user.id)
    .single();
  return profile;
});
