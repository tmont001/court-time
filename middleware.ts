import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// When a /join/<code> page is opened, preserve the invite code in a short-lived
// HttpOnly cookie so that subsequent sign-up, sign-in, and /auth/confirm flows
// can accept the invite without requiring the user to re-enter the code.
const INVITE_PATH_RE = /^\/join\/([0-9a-f]{32})$/i;

export async function middleware(request: NextRequest) {
  // Run Supabase session refresh and route-protection logic first.
  // updateSession returns a NextResponse (next or redirect) with auth cookies set.
  const response = await updateSession(request);

  // If this is an invite page, stamp the code into a secure server-side cookie
  // on whatever response updateSession already prepared. This works for both
  // NextResponse.next() (normal visit) and NextResponse.redirect() (rare auth case).
  const match = request.nextUrl.pathname.match(INVITE_PATH_RE);
  if (match) {
    response.cookies.set("ct_invite_pending", match[1].toLowerCase(), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 3600, // 1 hour
      path: "/",
    });
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
