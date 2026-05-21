import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import SignInForm from "./SignInForm";

export const dynamic = "force-dynamic";

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
