import { redirect } from "next/navigation";

// /admin/events is no longer a standalone page. Redirect to the unified
// Events management experience, opening directly on the Manage tab.
export default function AdminEventsPage() {
  redirect("/events?tab=manage");
}
