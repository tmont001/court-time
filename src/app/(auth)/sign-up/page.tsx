import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import SignUpForm from "./SignUpForm";

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
