import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Header from "@/components/Header";
import SettingsForm from "./SettingsForm";
import TestSmsSection from "./TestSmsSection";

export default async function AdminSettingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");

  const { data: profile } = await supabase
    .from("profiles")
    .select("club_id, role")
    .eq("id", user.id)
    .single();

  const { data: settings } = await supabase
    .from("club_settings")
    .select("booking_window_days, cancellation_window_hours")
    .eq("club_id", profile?.club_id ?? "")
    .single();

  const twilioConfigured =
    !!process.env.TWILIO_ACCOUNT_SID &&
    !!process.env.TWILIO_AUTH_TOKEN &&
    !!process.env.TWILIO_FROM_NUMBER;

  return (
    <>
      <Header screenTitle="Settings" />
      <div className="px-4 py-6 space-y-4">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-gray-900">Club settings</p>
          <p className="text-xs text-gray-500">
            Changes take effect immediately for all members.
          </p>
        </div>

        <hr className="border-gray-100" />

        <SettingsForm
          bookingWindowDays={settings?.booking_window_days ?? 14}
          cancellationWindowHours={settings?.cancellation_window_hours ?? 24}
        />

        {profile?.role === "admin" && (
          <>
            <hr className="border-gray-100" />
            <TestSmsSection twilioConfigured={twilioConfigured} />
          </>
        )}
      </div>
    </>
  );
}
