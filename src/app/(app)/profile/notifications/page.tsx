import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import Header from "@/components/Header";
import NotificationPreferencesForm from "./NotificationPreferencesForm";
import DeliveryMethodsSection from "./DeliveryMethodsSection";

interface CommunicationSettings {
  phone:      string | null;
  sms_opt_in: boolean;
}

export default async function NotificationPreferencesPage() {
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  const supabase = await createClient();

  // is_lesson_provider drives presentation-only filtering of the Lessons
  // group below (see NotificationPreferencesForm) — sourced from the
  // existing account-context RPC, not a new authorization check.
  const [{ data: preferences }, profile, { data: commSettingsRaw, error: commSettingsError }] = await Promise.all([
    supabase
      .from("notification_preferences")
      .select("kind, enabled")
      .eq("user_id", user.id),
    getAuthProfile(),
    // Phase 31D: replaces a raw `.from("profiles").select("phone,
    // sms_opt_in")` that was silently failing — sms_opt_in was never part
    // of the column-level SELECT grant added in migration 0079, so that
    // query was denied in full and its discarded error was indistinguishable
    // from "no phone on file." get_my_communication_settings() (migration
    // 0104) is a security-definer RPC scoped to the caller's own row.
    supabase.rpc("get_my_communication_settings"),
  ]);

  const commSettings = commSettingsRaw as unknown as CommunicationSettings | null;
  // A successful lookup always returns a non-null object for an
  // authenticated user with a profile row (even one with phone: null) — a
  // null result with no RPC-level error still indicates a failed lookup
  // (e.g. a missing profile row), never "no phone yet."
  const commSettingsFailed = Boolean(commSettingsError) || commSettings === null;

  // Server-only config check — booleans only ever cross into the rendered
  // page; no environment-variable name or value reaches the client.
  const smsConfigured =
    !!process.env.TWILIO_ACCOUNT_SID &&
    !!process.env.TWILIO_AUTH_TOKEN &&
    !!process.env.TWILIO_FROM_NUMBER;

  return (
    <>
      <Header screenTitle="Notification Preferences" />
      <div className="px-4 pt-3 pb-0 md:max-w-lg md:mx-auto">
        <Link href="/profile" className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-accent motion-safe:transition-colors motion-safe:duration-150">
          ← Back to Account
        </Link>
      </div>
      <div className="px-4 py-6 space-y-6 md:max-w-lg md:mx-auto">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Manage how Court Time contacts you. Important updates always appear
          in your notification bell.
        </p>

        <DeliveryMethodsSection
          smsConfigured={smsConfigured}
          commSettingsFailed={commSettingsFailed}
          phone={commSettings?.phone ?? null}
          smsOptIn={commSettings?.sms_opt_in ?? false}
        />

        <div className="space-y-1">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide px-1">
            Email preferences
          </p>
          <NotificationPreferencesForm
            preferences={preferences ?? []}
            isLessonProvider={profile?.is_lesson_provider ?? false}
          />
        </div>
      </div>
    </>
  );
}
