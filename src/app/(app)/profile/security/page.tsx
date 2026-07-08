import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import Header from "@/components/Header";
import ChangePasswordForm from "./ChangePasswordForm";

export default async function SecurityPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");

  return (
    <>
      <Header screenTitle="Change Password" />
      <div className="px-4 pt-3 pb-0 md:max-w-lg md:mx-auto">
        <Link href="/profile" className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-accent motion-safe:transition-colors motion-safe:duration-150">
          ← Back to Account
        </Link>
      </div>
      <div className="px-4 py-6 space-y-4 md:max-w-lg md:mx-auto">
        <div className="space-y-1">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Enter a new password for your account.
          </p>
        </div>

        <ChangePasswordForm />
      </div>
    </>
  );
}
