import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import Header from "@/components/Header";
import AuditLogTable from "./AuditLogTable";
import type { AuditLogRow } from "./actions";

export default async function AdminAuditLogPage() {
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  const profile  = await getAuthProfile();
  if (profile?.role !== "admin") redirect("/calendar");

  const supabase = await createClient();

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
        {error ? (
          <div className="mx-4 mt-6 px-4 py-3 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-700">
            <p className="text-sm font-semibold text-red-700 dark:text-red-400">Failed to load audit log</p>
            <p className="text-xs text-red-500 dark:text-red-400 mt-1">Please try again.</p>
          </div>
        ) : (
          <AuditLogTable initialRows={initialRows} />
        )}
        </div>
      </div>
    </>
  );
}
