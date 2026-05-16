import { redirect } from "next/navigation";

// Booking entry point is the calendar grid — tap an empty slot to book.
export default function BookPage() {
  redirect("/calendar");
}
