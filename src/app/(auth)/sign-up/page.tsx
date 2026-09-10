import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import SignUpForm from "./SignUpForm";

// (auth)/layout.tsx already sets robots: noindex for this whole group —
// title only, no description/OpenGraph needed for a page that's never
// meant to appear in search results or link previews.
export const metadata: Metadata = {
  title: "Sign Up — Court Time",
};

// Only /join/<32-char-hex> is a permitted redirect destination.
const SAFE_REDIRECT_RE = /^\/join\/[0-9a-f]{32}$/;

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string | string[]; emailRestricted?: string | string[] }>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // If already authenticated, send to the invite destination or calendar.
  const { redirect: rawRedirect, emailRestricted: rawEmailRestricted } = await searchParams;
  const rawRedirectStr = typeof rawRedirect === "string" ? rawRedirect : null;
  const redirectTo = rawRedirectStr && SAFE_REDIRECT_RE.test(rawRedirectStr)
    ? rawRedirectStr
    : null;

  if (user) {
    redirect(redirectTo ?? "/calendar");
  }

  if (!redirectTo) {
    // No valid invite destination — signup without an invite context is not
    // supported; send to sign-in so the user can find their way.
    redirect("/sign-in");
  }

  const emailRestricted = rawEmailRestricted === "1";

  return (
    <SignUpForm
      redirectTo={redirectTo}
      emailRestricted={emailRestricted}
    />
  );
}
