/**
 * Phase: Admin IA / Reports Cleanup — Checkpoint 1 (observability only).
 *
 * The Reports page (page.tsx) converts every reporting RPC failure into a
 * generic "Data unavailable — try refreshing." UI state and discards the
 * actual Postgres/PostgREST error entirely — there is currently no way to
 * diagnose which RPC failed or why. This module adds ONE small, sanitized
 * server-side log line per failing RPC call. It changes no RPC logic and
 * no user-facing text.
 *
 * Sanitization is an allowlist, not a blocklist: only rpc/code/message/hint
 * are ever read off the error object. Nothing else on the error (or any
 * other value in scope at the call site — session, cookies, tokens, full
 * profile/user rows, query args) is ever passed in or logged.
 */

/** The subset of a PostgrestError this module ever reads. Structural, not
 * imported from @supabase/supabase-js, so this stays decoupled from the
 * client library's own error shape/version. */
export interface ReportingRpcErrorLike {
  code?: string | null;
  message?: string | null;
  hint?: string | null;
}

export interface ReportingRpcDiagnostic {
  rpc: string;
  code?: string;
  message?: string;
  hint?: string;
}

/**
 * Pure: builds the sanitized diagnostic object for one failed reporting RPC
 * call. Omits hint/code/message entirely when absent rather than including
 * them as null/undefined — keeps the logged shape minimal and consistent.
 */
export function sanitizeReportingRpcError(
  rpcName: string,
  error: ReportingRpcErrorLike
): ReportingRpcDiagnostic {
  const diagnostic: ReportingRpcDiagnostic = { rpc: rpcName };
  if (error.code) diagnostic.code = error.code;
  if (error.message) diagnostic.message = error.message;
  if (error.hint) diagnostic.hint = error.hint;
  return diagnostic;
}

/**
 * Logs one sanitized diagnostic line for a failed reporting RPC call.
 * No-op when `error` is null/undefined — callers pass the RPC result's
 * `error` field unconditionally rather than branching themselves.
 */
export function logReportingRpcFailure(
  rpcName: string,
  error: ReportingRpcErrorLike | null | undefined
): void {
  if (!error) return;
  console.error("[AdminReports] reporting RPC failed:", sanitizeReportingRpcError(rpcName, error));
}
