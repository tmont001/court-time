import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import Header from "@/components/Header";
import AuditLogTable from "./AuditLogTable";
import type { AuditLogRow } from "./actions";

export default async function AdminAuditLogPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "admin") redirect("/calendar");

  const { data, error } = await supabase.rpc("get_audit_log", {
    p_limit:  50,
    p_offset: 0,
  });

  const initialRows = (data ?? []) as AuditLogRow[];

  return (
    <>
      <Header screenTitle="Audit Log" />
      <div
        className="overflow-y-auto"
        style={{ height: "var(--page-fill-height)" }}
      >
        <div className="md:max-w-3xl md:mx-auto">
          <div className="px-4 pt-3 pb-0">
            <Link href="/profile" className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-accent motion-safe:transition-colors motion-safe:duration-150">
              ← Back to Account
            </Link>
          </div>
        {error ? (
          <div className="mx-4 mt-6 px-4 py-3 bg-red-50 rounded-xl border border-red-200">
            <p className="text-sm font-semibold text-red-700">Failed to load audit log</p>
            <p className="text-xs text-red-500 mt-1 break-all">{error.message}</p>
          </div>
        ) : (
          <AuditLogTable initialRows={initialRows} />
        )}
        </div>
      </div>
    </>
  );
}
