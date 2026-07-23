import { redirect } from "next/navigation";

export default async function LessonsPage({
  searchParams,
}: {
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp    = searchParams ? await searchParams : {};
  const extra = sp.request === "1" ? "&request=1" : "";
  redirect(`/my-schedule?tab=lessons${extra}`);
}
