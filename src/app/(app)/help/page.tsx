import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import Header from "@/components/Header";

export default async function HelpPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");

  const { data: profile } = await supabase
    .from("profiles")
    .select("club_id")
    .eq("id", user.id)
    .single();

  const { data: settings } = profile?.club_id
    ? await supabase
        .from("club_settings")
        .select("booking_window_days, cancellation_window_hours")
        .eq("club_id", profile.club_id)
        .single()
    : { data: null };

  const bookingDays   = settings?.booking_window_days       ?? 14;
  const cancelHours   = settings?.cancellation_window_hours ?? 24;

  const sections = [
    {
      title: "Booking Rules",
      items: [
        `You can book court time up to ${bookingDays} day${bookingDays !== 1 ? "s" : ""} in advance.`,
        "Bookings are for confirmed members only.",
        "Courts are available during posted operating hours.",
        "Only one court reservation per time slot per member.",
      ],
    },
    {
      title: "Cancellation Policy",
      items: [
        `Reservations must be cancelled at least ${cancelHours} hour${cancelHours !== 1 ? "s" : ""} before the start time.`,
        "Late cancellations cannot be undone through the app — contact the club admin.",
        "Event participation can be cancelled any time before the event starts.",
      ],
    },
    {
      title: "Notifications",
      items: [
        "Booking confirmations and event updates are delivered via in-app notifications and email.",
        "Manage which email alerts you receive in Profile → Notification Preferences.",
        "Text (SMS) notifications are not currently available.",
      ],
    },
    {
      title: "Need Help?",
      items: [
        "For booking issues, account questions, or anything else, contact the club admin directly.",
        "Your admin can adjust your role, reset your password, or update court availability.",
        "When reporting an issue, include: what you were trying to do, which page you were on, what happened, and your device or browser if relevant. A screenshot is always helpful.",
      ],
    },
  ];

  return (
    <>
      <Header screenTitle="Help & Rules" />
      <div className="overflow-y-auto" style={{ height: "var(--page-fill-height)" }}>
      <div className="px-4 pt-3 pb-0 md:max-w-2xl md:mx-auto">
        <Link href="/profile" className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-accent motion-safe:transition-colors motion-safe:duration-150">
          ← Back to Profile
        </Link>
      </div>
      <div className="px-4 py-6 space-y-5 md:max-w-2xl md:mx-auto">
        {sections.map(section => (
          <div key={section.title}>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              {section.title}
            </p>
            <div className="ct-card divide-y divide-gray-100 dark:divide-gray-700 overflow-hidden">
              {section.items.map(item => (
                <p key={item} className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300 leading-snug">
                  {item}
                </p>
              ))}
            </div>
          </div>
        ))}
      </div>
      </div>
    </>
  );
}
