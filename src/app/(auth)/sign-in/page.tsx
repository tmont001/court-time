import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import SignInForm from "./SignInForm";

export const dynamic = "force-dynamic";

// (auth)/layout.tsx already sets robots: noindex for this whole group —
// title only, no description/OpenGraph needed for a page that's never
// meant to appear in search results or link previews.
export const metadata: Metadata = {
  title: "Sign In — Court Time",
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string | string[] }>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) redirect("/calendar");

  const { redirect: raw } = await searchParams;
  const redirectTo = typeof raw === "string" && raw.startsWith("/") ? raw : null;

  return <SignInForm redirectTo={redirectTo} />;
}
