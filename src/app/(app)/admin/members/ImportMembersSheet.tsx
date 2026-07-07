"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import ResponsiveSheet from "@/components/ResponsiveSheet";
import {
  importRosterMembersAction,
  type ImportRowInput,
  type ImportResult,
} from "./actions";

// ── Types ────────────────────────────────────────────────────────────────────

type RowStatus = "ready" | "warning" | "error";

type ParsedRow = {
  index:      number;   // 1-based row number in the file (for display)
  first_name: string;
  last_name:  string;
  email:      string;
  phone:      string;
  notes:      string;
  status:     RowStatus;
  messages:   string[];
};

type Step = "upload" | "preview" | "importing" | "summary";

interface Props {
  onClose:       () => void;
  rosterMembers: { first_name: string; last_name: string; email: string | null }[];
}

// ── CSV parser ────────────────────────────────────────────────────────────────
// Browser-side only. No external dependency.
// Handles: UTF-8 BOM, CRLF/LF, quoted fields with embedded commas/quotes.

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current   = "";
  let inQuotes  = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;                    // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseCSV(raw: string): string[][] {
  const text  = raw.replace(/^﻿/, "");          // strip BOM
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  return lines
    .filter(l => l.trim() !== "")
    .map(parseCSVLine);
}

// ── Header normalization ──────────────────────────────────────────────────────

const HEADER_MAP: Record<string, string> = {
  firstname:    "first_name",
  first:        "first_name",
  "first_name": "first_name",
  lastname:     "last_name",
  last:         "last_name",
  "last_name":  "last_name",
  email:        "email",
  emailaddress: "email",
  phone:        "phone",
  phonenumber:  "phone",
  notes:        "notes",
  note:         "notes",
  adminnotes:   "notes",
};

function normalizeHeader(h: string): string {
  const s = h.toLowerCase().replace(/[\s\-]+/g, "");
  return HEADER_MAP[s] ?? s;
}

// ── Email format check ────────────────────────────────────────────────────────

function isValidEmail(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

// ── Template download ─────────────────────────────────────────────────────────

function downloadTemplate() {
  const csv = [
    "first_name,last_name,email,phone,notes",
    "John,Smith,john@example.com,555-0101,Tennis level 3.5",
    "Jane,Doe,,,",
  ].join("\n") + "\n";
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = "court-time-members-template.csv";
  a.click();
  URL.revokeObjectURL(url);
}

// ── Parse and validate ────────────────────────────────────────────────────────

function parseAndValidate(
  raw:           string,
  rosterMembers: Props["rosterMembers"],
): { rows: ParsedRow[]; parseError?: string } {
  const all = parseCSV(raw);
  if (all.length < 2) {
    return { rows: [], parseError: "The file appears to be empty or has no data rows." };
  }

  const headers = all[0].map(normalizeHeader);

  const idx = {
    first_name: headers.indexOf("first_name"),
    last_name:  headers.indexOf("last_name"),
    email:      headers.indexOf("email"),
    phone:      headers.indexOf("phone"),
    notes:      headers.indexOf("notes"),
  };

  if (idx.first_name === -1 || idx.last_name === -1) {
    return {
      rows: [],
      parseError:
        "Could not find first_name and last_name columns. " +
        "Make sure your CSV has those headers (or First Name / Last Name).",
    };
  }

  const dataRows = all.slice(1);

  if (dataRows.length > 200) {
    return {
      rows: [],
      parseError: `The file has ${dataRows.length} data rows. Maximum allowed is 200. Split the file into smaller batches.`,
    };
  }

  // Build email + name sets for within-batch dedup
  const emailsSeen = new Map<string, number>(); // email → first row index
  const namesSeen  = new Map<string, number>(); // "first last" → first row index

  // Existing roster for dedup
  const rosterEmails = new Set(
    rosterMembers.map(r => r.email?.toLowerCase() ?? "").filter(Boolean)
  );
  const rosterNames = new Set(
    rosterMembers.map(r =>
      [r.first_name, r.last_name].join(" ").toLowerCase()
    )
  );

  const rows: ParsedRow[] = [];
  let displayIndex = 0;

  for (let i = 0; i < dataRows.length; i++) {
    const cols = dataRows[i];
    const get  = (colIdx: number) => (colIdx >= 0 ? (cols[colIdx] ?? "").trim() : "");

    const first = get(idx.first_name);
    const last  = get(idx.last_name);
    const email = get(idx.email).toLowerCase();
    const phone = get(idx.phone);
    const notes = get(idx.notes);

    // Skip entirely blank rows
    if (!first && !last && !email && !phone && !notes) continue;

    displayIndex++;
    const messages: string[] = [];
    let status: RowStatus = "ready";

    // Hard errors
    if (!first) { messages.push("First name is required."); status = "error"; }
    if (!last)  { messages.push("Last name is required.");  status = "error"; }
    if (email && !isValidEmail(email)) {
      messages.push("Invalid email format.");
      status = "error";
    }

    // Warnings (only if not already an error)
    if (status !== "error") {
      if (email) {
        if (emailsSeen.has(email)) {
          messages.push(`Duplicate email (same as row ${emailsSeen.get(email)}).`);
          status = "warning";
        } else {
          emailsSeen.set(email, displayIndex);
        }
        if (rosterEmails.has(email)) {
          messages.push("Email already on the roster.");
          status = "warning";
        }
      }
      const nameKey = `${first} ${last}`.toLowerCase();
      if (namesSeen.has(nameKey)) {
        messages.push(`Duplicate name (same as row ${namesSeen.get(nameKey)}).`);
        if (status !== "warning") status = "warning";
      } else {
        namesSeen.set(nameKey, displayIndex);
      }
      if (rosterNames.has(nameKey)) {
        messages.push("Name already on the roster.");
        if (status !== "warning") status = "warning";
      }
    }

    rows.push({ index: displayIndex, first_name: first, last_name: last, email, phone, notes, status, messages });
  }

  if (rows.length === 0) {
    return { rows: [], parseError: "No valid data rows found after skipping blank lines." };
  }

  return { rows };
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: RowStatus }) {
  if (status === "ready")   return <span className="text-xs font-medium text-green-700 dark:text-green-400">Ready</span>;
  if (status === "warning") return <span className="text-xs font-medium text-amber-600 dark:text-amber-400">Warning</span>;
  return <span className="text-xs font-medium text-red-600 dark:text-red-400">Error</span>;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function ImportMembersSheet({ onClose, rosterMembers }: Props) {
  const router   = useRouter();
  const fileRef  = useRef<HTMLInputElement>(null);

  const [step, setStep]               = useState<Step>("upload");
  const [parseError, setParseError]   = useState<string | null>(null);
  const [rows, setRows]               = useState<ParsedRow[]>([]);
  const [includeWarnings, setIncludeWarnings] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError]   = useState<string | null>(null);

  // ── Derived counts ──────────────────────────────────────────────────────

  const readyRows   = rows.filter(r => r.status === "ready");
  const warningRows = rows.filter(r => r.status === "warning");
  const errorRows   = rows.filter(r => r.status === "error");
  const rowsToImport = includeWarnings
    ? [...readyRows, ...warningRows]
    : readyRows;

  // ── File handling ───────────────────────────────────────────────────────

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith(".csv")) {
      setParseError("Please choose a .csv file.");
      return;
    }

    const reader = new FileReader();
    reader.onload = (ev) => {
      const raw    = ev.target?.result as string;
      const result = parseAndValidate(raw, rosterMembers);
      if (result.parseError) {
        setParseError(result.parseError);
        return;
      }
      setParseError(null);
      setRows(result.rows);
      setStep("preview");
    };
    reader.readAsText(file, "UTF-8");

    // Reset so same file can be re-selected after going back
    e.target.value = "";
  }

  // ── Import ──────────────────────────────────────────────────────────────

  async function handleImport() {
    setStep("importing");
    setImportError(null);

    const payload: ImportRowInput[] = rowsToImport.map(r => ({
      firstName: r.first_name,
      lastName:  r.last_name,
      email:     r.email  || null,
      phone:     r.phone  || null,
      notes:     r.notes  || null,
    }));

    const response = await importRosterMembersAction(payload);

    if (response.error) {
      setImportError(response.error);
      setStep("preview");
      return;
    }

    setImportResult(response.result ?? null);
    setStep("summary");
  }

  // ── Handlers ────────────────────────────────────────────────────────────

  function handleDone() {
    router.refresh();
    onClose();
  }

  function handleBack() {
    setRows([]);
    setParseError(null);
    setIncludeWarnings(false);
    setStep("upload");
  }

  // ── Shared classes ───────────────────────────────────────────────────────

  const inputClass =
    "mt-1.5 w-full rounded-xl border border-gray-200 px-4 py-3 text-sm text-gray-900 bg-white dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent";

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <ResponsiveSheet onClose={onClose} variant="modal" size="wide">
      <div className="px-6 pt-5 pb-8 overflow-y-auto flex-1">

        <div className="ct-handlebar mx-auto mb-4 md:hidden" />

        {/* ── Step: Upload ─────────────────────────────────────────────── */}
        {step === "upload" && (
          <div className="space-y-5">
            <div className="pr-8">
              <p className="text-base font-semibold text-gray-900 dark:text-gray-100">Import Members</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Upload a CSV file to add multiple members at once.
              </p>
            </div>

            {/* Template download */}
            <div className="rounded-xl border border-gray-200 dark:border-gray-600 px-4 py-4">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">Step 1 — Download the template</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                Fill in your members, save as CSV, then upload below.
              </p>
              <button
                onClick={downloadTemplate}
                className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 text-xs font-medium text-gray-700 dark:text-gray-300 hover:border-accent hover:text-accent motion-safe:transition-all motion-safe:duration-150"
              >
                Download template CSV
              </button>
            </div>

            {/* File upload */}
            <div className="rounded-xl border border-gray-200 dark:border-gray-600 px-4 py-4">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">Step 2 — Upload your file</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                Supported format: .csv · Max 200 rows
              </p>

              <input
                ref={fileRef}
                type="file"
                accept=".csv"
                onChange={handleFileChange}
                className="hidden"
              />
              <button
                onClick={() => fileRef.current?.click()}
                className="w-full py-3 rounded-xl bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-semibold"
              >
                Choose CSV file
              </button>

              {parseError && (
                <p className="mt-3 text-xs text-red-600 dark:text-red-400">{parseError}</p>
              )}
            </div>
          </div>
        )}

        {/* ── Step: Preview ────────────────────────────────────────────── */}
        {step === "preview" && (
          <div className="space-y-4">
            <div className="pr-8">
              <p className="text-base font-semibold text-gray-900 dark:text-gray-100">Review before importing</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                <span className="text-green-700 dark:text-green-400 font-medium">{readyRows.length} ready</span>
                {warningRows.length > 0 && (
                  <> · <span className="text-amber-600 dark:text-amber-400 font-medium">{warningRows.length} warning{warningRows.length !== 1 ? "s" : ""}</span></>
                )}
                {errorRows.length > 0 && (
                  <> · <span className="text-red-600 dark:text-red-400 font-medium">{errorRows.length} error{errorRows.length !== 1 ? "s" : ""} (will be skipped)</span></>
                )}
              </p>
            </div>

            {/* Notices */}
            {errorRows.length > 0 && (
              <p className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">
                Rows with errors will be skipped.
              </p>
            )}
            {warningRows.length > 0 && (
              <p className="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-3 py-2">
                Rows with warnings may already exist. Review before importing.
              </p>
            )}

            {/* Preview table */}
            <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
              <table className="min-w-full text-xs">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700">
                    <th className="px-3 py-2 text-left font-semibold text-gray-500 dark:text-gray-400">#</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-500 dark:text-gray-400">First</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-500 dark:text-gray-400">Last</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-500 dark:text-gray-400">Email</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-500 dark:text-gray-400">Phone</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-500 dark:text-gray-400">Notes</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-500 dark:text-gray-400">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {rows.map(row => (
                    <tr
                      key={row.index}
                      className={
                        row.status === "error"
                          ? "bg-red-50/50 dark:bg-red-900/10 opacity-60"
                          : row.status === "warning"
                          ? "bg-amber-50/50 dark:bg-amber-900/10"
                          : ""
                      }
                    >
                      <td className="px-3 py-2 text-gray-400">{row.index}</td>
                      <td className="px-3 py-2 text-gray-900 dark:text-gray-100 whitespace-nowrap">{row.first_name || <span className="text-red-400">—</span>}</td>
                      <td className="px-3 py-2 text-gray-900 dark:text-gray-100 whitespace-nowrap">{row.last_name  || <span className="text-red-400">—</span>}</td>
                      <td className="px-3 py-2 text-gray-500 dark:text-gray-400 whitespace-nowrap">{row.email || "—"}</td>
                      <td className="px-3 py-2 text-gray-500 dark:text-gray-400 whitespace-nowrap">{row.phone || "—"}</td>
                      <td className="px-3 py-2 text-gray-500 dark:text-gray-400 max-w-[160px] truncate">{row.notes || "—"}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <StatusBadge status={row.status} />
                        {row.messages.length > 0 && (
                          <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5 max-w-[180px] leading-snug">
                            {row.messages[0]}
                          </p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Include warnings checkbox */}
            {warningRows.length > 0 && (
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeWarnings}
                  onChange={e => setIncludeWarnings(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 accent-accent"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">
                  Include rows with warnings
                  <span className="block text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                    {warningRows.length} row{warningRows.length !== 1 ? "s" : ""} will be added even if they may already exist.
                  </span>
                </span>
              </label>
            )}

            {/* Import error */}
            {importError && (
              <p className="text-sm text-red-600 dark:text-red-400">{importError}</p>
            )}

            {/* Action buttons */}
            <div className="flex gap-3 pt-1">
              <button
                onClick={handleBack}
                className="flex-1 py-3 rounded-xl border border-gray-200 dark:border-gray-600 text-sm font-medium text-gray-700 dark:text-gray-300 hover:border-accent hover:text-accent motion-safe:transition-all motion-safe:duration-150"
              >
                ← Change file
              </button>
              <button
                disabled={rowsToImport.length === 0}
                onClick={handleImport}
                className="flex-1 py-3 rounded-xl bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-semibold disabled:opacity-40"
              >
                Import {rowsToImport.length} Member{rowsToImport.length !== 1 ? "s" : ""}
              </button>
            </div>
          </div>
        )}

        {/* ── Step: Importing ──────────────────────────────────────────── */}
        {step === "importing" && (
          <div className="flex flex-col items-center justify-center py-12 gap-4">
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Adding members…</p>
            <p className="text-xs text-gray-400 dark:text-gray-500">
              Adding {rowsToImport.length} member{rowsToImport.length !== 1 ? "s" : ""}. This may take a moment.
            </p>
          </div>
        )}

        {/* ── Step: Summary ────────────────────────────────────────────── */}
        {step === "summary" && importResult && (
          <div className="space-y-5">
            <div className="pr-8">
              <p className="text-base font-semibold text-gray-900 dark:text-gray-100">Import complete</p>
            </div>

            {/* Result banner */}
            {importResult.failed === 0 ? (
              <div className="rounded-xl bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 px-4 py-4">
                <p className="text-sm font-medium text-green-800 dark:text-green-300">
                  Added {importResult.imported} member{importResult.imported !== 1 ? "s" : ""} to the roster.
                </p>
              </div>
            ) : importResult.imported > 0 ? (
              <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 px-4 py-4">
                <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                  Added {importResult.imported} of {importResult.imported + importResult.failed} members.{" "}
                  {importResult.failed} row{importResult.failed !== 1 ? "s were" : " was"} skipped.
                </p>
              </div>
            ) : (
              <div className="rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 px-4 py-4">
                <p className="text-sm font-medium text-red-700 dark:text-red-400">
                  No members were added. See details below.
                </p>
              </div>
            )}

            {/* Error details */}
            {importResult.errors.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
                  Skipped rows
                </p>
                <div className="rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700 overflow-hidden">
                  {importResult.errors.map((err, i) => (
                    <div key={i} className="px-4 py-2.5">
                      <p className="text-xs font-medium text-gray-800 dark:text-gray-200">{err.name}</p>
                      <p className="text-xs text-gray-400 dark:text-gray-500">{err.message}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <button
              onClick={handleDone}
              className="w-full py-3 rounded-xl bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-semibold"
            >
              Done
            </button>
          </div>
        )}

      </div>
    </ResponsiveSheet>
  );
}
