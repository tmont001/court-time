import { type NextRequest, NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";

// Permitted redirect destinations: only internal invite-acceptance paths.
// Invite codes are 32-character lowercase hex strings (gen_random_uuid() with hyphens stripped).
const SAFE_NEXT_RE = /^\/join\/[0-9a-f]{32}$/;
const CODE_RE = /^[0-9a-f]{32}$/;
const COOKIE_NAME = "ct_invite_pending";

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

  // Resolve invite code: prefer the validated 'next' query param, fall back to
  // the ct_invite_pending cookie set by middleware when /join/<code> was opened.
  // This handles email clients that strip query parameters from confirmation links.
  let inviteCode: string | null = null;
  if (SAFE_NEXT_RE.test(next)) {
    inviteCode = next.slice("/join/".length);
  } else {
    const cookieCode = request.cookies.get(COOKIE_NAME)?.value ?? "";
    if (CODE_RE.test(cookieCode)) {
      inviteCode = cookieCode;
    }
  }

  if (!inviteCode) {
    return NextResponse.redirect(
      new URL("/sign-in?error=invalid_redirect", origin)
    );
  }

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

  // Apply accumulated session cookies and always clear the invite cookie.
  // The invite is either accepted (success) or terminal (failure) at this point —
  // in either case the cookie has served its purpose.
  function withSessionAndClear(response: NextResponse): NextResponse {
    cookieStore.forEach(({ name, value, options }) =>
      response.cookies.set(name, value, options)
    );
    response.cookies.set(COOKIE_NAME, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 0,
      path: "/",
    });
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
  const { error: acceptError } = await supabase.rpc("accept_club_invite", {
    p_code: inviteCode,
  });

  if (acceptError) {
    // Acceptance failed (email_mismatch, invite_expired, invite_used, etc.).
    // Redirect to the join page with session set so the AcceptButton can show
    // the specific error. Clear the cookie — the invite is in a terminal state.
    const errorDest = SAFE_NEXT_RE.test(next) ? next : `/join/${inviteCode}`;
    return withSessionAndClear(NextResponse.redirect(new URL(errorDest, origin)));
  }

  // Invite accepted. Determine destination from authoritative profile values
  // (accept_club_invite may have copied names from the roster entry).
  // Treat null and blank strings the same — both require /welcome.
  let dest = "/welcome";
  const { data: { user: confirmedUser } } = await supabase.auth.getUser();
  if (confirmedUser) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("first_name, last_name")
      .eq("id", confirmedUser.id)
      .single();
    const firstName = profile?.first_name?.trim() ?? "";
    const lastName  = profile?.last_name?.trim()  ?? "";
    if (firstName && lastName) {
      dest = "/calendar";
    }
  }

  return withSessionAndClear(NextResponse.redirect(new URL(dest, origin)));
}
