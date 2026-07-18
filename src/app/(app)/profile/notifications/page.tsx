import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/supabase/user";
import Header from "@/components/Header";
import NotificationPreferencesForm from "./NotificationPreferencesForm";

export default async function NotificationPreferencesPage() {
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  const supabase = await createClient();
  const { data: preferences } = await supabase
    .from("notification_preferences")
    .select("kind, enabled")
    .eq("user_id", user.id);

  return (
    <>
      <Header screenTitle="Notification Preferences" />
      <div className="px-4 pt-3 pb-0 md:max-w-lg md:mx-auto">
        <Link href="/profile" className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-accent motion-safe:transition-colors motion-safe:duration-150">
          ← Back to Account
        </Link>
      </div>
      <div className="px-4 py-6 space-y-4 md:max-w-lg md:mx-auto">
        <div className="space-y-1">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Choose which email alerts you receive. Turning off a type stops
            email delivery for that category. Important updates always appear
            in your notification bell.
          </p>
        </div>

        <NotificationPreferencesForm preferences={preferences ?? []} />
      </div>
    </>
  );
}
