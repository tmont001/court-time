import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Header from "@/components/Header";
import NotificationPreferencesForm from "./NotificationPreferencesForm";

export default async function NotificationPreferencesPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");

  const { data: preferences } = await supabase
    .from("notification_preferences")
    .select("kind, enabled")
    .eq("user_id", user.id);

  return (
    <>
      <Header screenTitle="Notification Preferences" />
      <div className="px-4 py-6 space-y-4 md:max-w-lg md:mx-auto">
        <div className="space-y-1">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Choose which alerts you receive. Turning off a notification type
            stops both in-app and text alerts for that category.
          </p>
        </div>

        <NotificationPreferencesForm preferences={preferences ?? []} />
      </div>
    </>
  );
}
