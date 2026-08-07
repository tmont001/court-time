import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/lib/db/types";

// Public route boundary — the single source of truth for which routes are
// reachable without a session. Every route not listed here is treated as
// part of the authenticated application and requires a signed-in user.
//
// PUBLIC_EXACT_ROUTES — routes with no sub-paths. Matched exactly so that an
// unrelated future route sharing a prefix (e.g. "/sign-in-help") is never
// accidentally treated as public.
//
// PUBLIC_PATH_PREFIXES — routes that legitimately have sub-paths (currently
// only the dynamic invite-code segment under /join).
const PUBLIC_EXACT_ROUTES = new Set([
  "/",
  "/features",
  "/pricing",
  "/contact",
  "/privacy",
  "/terms",
  "/sign-in",
  "/sign-up",
  "/forgot-password",
  "/reset-password",
  "/welcome",
  "/pending-invite",
  "/auth/confirm",
]);

const PUBLIC_PATH_PREFIXES = ["/join/"];

function isPublicRoute(pathname: string): boolean {
  return (
    PUBLIC_EXACT_ROUTES.has(pathname) ||
    PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  if (!isPublicRoute(pathname) && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    return NextResponse.redirect(url);
  }

  // Redirect authenticated users away from the sign-in page.
  if (pathname === "/sign-in" && user) {
    const url = request.nextUrl.clone();
    url.pathname = "/calendar";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
