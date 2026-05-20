import { redirect } from "next/navigation";

// Authenticated users land on /calendar directly.
// Unauthenticated users reach /calendar, which middleware redirects to /sign-in.
export default function Home() {
  redirect("/calendar");
}
