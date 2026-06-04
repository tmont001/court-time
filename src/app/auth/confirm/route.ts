import { type NextRequest, NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";

// Permitted redirect destinations: only internal invite-acceptance paths.
// Invite codes are 32-character lowercase hex strings (gen_random_uuid() with hyphens stripped).
const SAFE_NEXT_RE = /^\/join\/[0-9a-f]{32}$/;

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "";

  // Reject missing confirmation code before doing anything else.
  if (!code) {
    return NextResponse.redirect(
      new URL("/sign-in?error=confirmation_failed", origin)
    );
  }

  // Validate next. Only /join/<32-hex> is a permitted destination.
  // Absolute URLs, protocol-relative URLs, and arbitrary internal paths are rejected.
  if (!SAFE_NEXT_RE.test(next)) {
    return NextResponse.redirect(
      new URL("/sign-in?error=invalid_redirect", origin)
    );
  }

  // Extract the invite code from the validated path.
  const inviteCode = next.slice("/join/".length);

  // Accumulate session cookies here so they can be applied to whatever final
  // response we return, regardless of the redirect destination.
  const cookieStore: Map<string, { name: string; value: string; options: CookieOptions }> =
    new Map();

  // Cast required: same @supabase/ssr generic mismatch as server.ts and middleware.ts.
  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach((c) => cookieStore.set(c.name, c));
        },
      },
    }
  ) as unknown as SupabaseClient<Database>;

  function withSession(response: NextResponse): NextResponse {
    cookieStore.forEach(({ name, value, options }) =>
      response.cookies.set(name, value, options)
    );
    return response;
  }

  // Exchange the PKCE confirmation code for a cookie-backed session.
  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);

  if (exchangeError) {
    return NextResponse.redirect(
      new URL("/sign-in?error=confirmation_failed", origin)
    );
  }

  // Auto-accept the invitation using the session established above.
  // The same supabase client instance has the new session in its auth context
  // after exchangeCodeForSession, so accept_club_invite runs as the confirmed user.
  const { error: acceptError } = await supabase.rpc("accept_club_invite", {
    p_code: inviteCode,
  });

  if (acceptError) {
    // Acceptance failed (email_mismatch, invite_expired, invite_used, etc.).
    // Redirect back to the invite page with the session cookie set so the user
    // sees the error via the existing AcceptButton error display.
    return withSession(NextResponse.redirect(new URL(next, origin)));
  }

  // Invite accepted. Send the user to /welcome to complete their profile.
  // /welcome redirects to /calendar once first_name and last_name are saved.
  return withSession(NextResponse.redirect(new URL("/welcome", origin)));
}
