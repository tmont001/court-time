"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import ResponsiveSheet from "@/components/ResponsiveSheet";
import {
  importRosterMembersAction,
  importInvitesAction,
  type ImportRowInput,
  type ImportResult,
  type InviteRowInput,
  type InviteImportResult,
  type InviteRowResult,
} from "./actions";

// ── Types ────────────────────────────────────────────────────────────────────

type ImportMode = "roster" | "invite";
type Step = "mode" | "upload" | "preview" | "importing" | "summary";

type RowStatus = "ready" | "warning" | "error";
type InviteRowStatus =
  | "ready"
  | "invalid"
  | "duplicate"
  | "existing-member"
  | "existing-roster"
  | "existing-invite";

type ParsedRow = {
  index:      number;
  first_name: string;
  last_name:  string;
  email:      string;
  phone:      string;
  notes:      string;
  status:     RowStatus;
  messages:   string[];
};

type InviteParsedRow = {
  index:      number;
  first_name: string;
  last_name:  string;
  email:      string;
  role:       string;  // raw CSV value for display; valid "member"/"pro" for ready rows
  status:     InviteRowStatus;
  messages:   string[];
};

interface Props {
  onClose:             () => void;
  rosterMembers:       { first_name: string; last_name: string; email: string | null }[];
  memberEmails:        string[];
  pendingInviteEmails: string[];
}

// ── CSV parser ────────────────────────────────────────────────────────────────

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current  = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
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
  const text  = raw.replace(/^﻿/, "");
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  return lines.filter(l => l.trim() !== "").map(parseCSVLine);
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
  role:         "role",
};

function normalizeHeader(h: string): string {
  const s = h.toLowerCase().replace(/[\s\-]+/g, "");
  return HEADER_MAP[s] ?? s;
}

// ── Role validation ───────────────────────────────────────────────────────────
// Blank → "member" (default). "member" and "pro" are the only valid values.
// "admin" and every other non-blank value must be classified Invalid and skipped —
// they are never silently converted to "member".

function parseRole(raw: string): "member" | "pro" | null {
  const s = raw.toLowerCase().trim();
  if (!s)           return "member"; // blank → default member
  if (s === "member") return "member";
  if (s === "pro")    return "pro";
  return null;                       // "admin" and anything else → invalid
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isValidEmail(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function triggerDownload(csv: string, filename: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadRosterTemplate() {
  triggerDownload(
    ["first_name,last_name,email,phone,notes", "John,Smith,john@example.com,555-0101,Tennis level 3.5", "Jane,Doe,,,"].join("\n") + "\n",
    "court-time-members-template.csv"
  );
}

function downloadInviteTemplate() {
  triggerDownload(
    ["first_name,last_name,email,role", "John,Smith,john@example.com,member", "Jane,Doe,jane@example.com,pro"].join("\n") + "\n",
    "court-time-invites-template.csv"
  );
}

function downloadInviteResultsCSV(results: InviteRowResult[], origin: string) {
  const rows = [
    "name,email,role,invite_url",
    ...results
      .filter(r => r.code)
      .map(r => `"${r.name}","${r.email}","${r.role}","${origin}/join/${r.code}"`),
  ].join("\n") + "\n";
  triggerDownload(rows, "court-time-invite-links.csv");
}

// ── Parse: roster ─────────────────────────────────────────────────────────────

function parseAndValidateRoster(
  raw:           string,
  rosterMembers: Props["rosterMembers"],
): { rows: ParsedRow[]; parseError?: string } {
  const all = parseCSV(raw);
  if (all.length < 2) return { rows: [], parseError: "The file appears to be empty or has no data rows." };

  const headers = all[0].map(normalizeHeader);
  const idx = {
    first_name: headers.indexOf("first_name"),
    last_name:  headers.indexOf("last_name"),
    email:      headers.indexOf("email"),
    phone:      headers.indexOf("phone"),
    notes:      headers.indexOf("notes"),
  };

  if (idx.first_name === -1 || idx.last_name === -1) {
    return { rows: [], parseError: "Could not find first_name and last_name columns. Make sure your CSV has those headers (or First Name / Last Name)." };
  }

  const dataRows = all.slice(1);
  if (dataRows.length > 200) {
    return { rows: [], parseError: `The file has ${dataRows.length} data rows. Maximum allowed is 200. Split the file into smaller batches.` };
  }

  const emailsSeen  = new Map<string, number>();
  const namesSeen   = new Map<string, number>();
  const rosterEmails = new Set(rosterMembers.map(r => r.email?.toLowerCase() ?? "").filter(Boolean));
  const rosterNames  = new Set(rosterMembers.map(r => [r.first_name, r.last_name].join(" ").toLowerCase()));

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

    if (!first && !last && !email && !phone && !notes) continue;
    displayIndex++;
    const messages: string[] = [];
    let status: RowStatus = "ready";

    if (!first) { messages.push("First name is required."); status = "error"; }
    if (!last)  { messages.push("Last name is required.");  status = "error"; }
    if (email && !isValidEmail(email)) { messages.push("Invalid email format."); status = "error"; }

    if (status !== "error") {
      if (email) {
        if (emailsSeen.has(email)) {
          messages.push(`Duplicate email (same as row ${emailsSeen.get(email)}).`);
          status = "warning";
        } else {
          emailsSeen.set(email, displayIndex);
        }
        if (rosterEmails.has(email)) { messages.push("Email already on the roster."); status = "warning"; }
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

  if (rows.length === 0) return { rows: [], parseError: "No valid data rows found after skipping blank lines." };
  return { rows };
}

// ── Parse: invite ─────────────────────────────────────────────────────────────

function parseAndValidateInvite(
  raw:                string,
  rosterMembers:      Props["rosterMembers"],
  memberEmails:       string[],
  pendingInviteEmails: string[],
): { rows: InviteParsedRow[]; parseError?: string } {
  const all = parseCSV(raw);
  if (all.length < 2) return { rows: [], parseError: "The file appears to be empty or has no data rows." };

  const headers = all[0].map(normalizeHeader);
  const idx = {
    first_name: headers.indexOf("first_name"),
    last_name:  headers.indexOf("last_name"),
    email:      headers.indexOf("email"),
    role:       headers.indexOf("role"),
  };

  if (idx.first_name === -1 || idx.last_name === -1) {
    return { rows: [], parseError: "Could not find first_name and last_name columns." };
  }
  if (idx.email === -1) {
    return { rows: [], parseError: "Could not find an email column. Email is required for invite links." };
  }

  const dataRows = all.slice(1);
  if (dataRows.length > 200) {
    return { rows: [], parseError: `The file has ${dataRows.length} data rows. Maximum allowed is 200.` };
  }

  const memberEmailSet   = new Set(memberEmails.map(e => e.toLowerCase()));
  const rosterEmailSet   = new Set(rosterMembers.map(r => r.email?.toLowerCase() ?? "").filter(Boolean));
  const pendingInviteSet = new Set(pendingInviteEmails.map(e => e.toLowerCase()));
  const emailsSeen       = new Map<string, number>();

  const rows: InviteParsedRow[] = [];
  let displayIndex = 0;

  for (let i = 0; i < dataRows.length; i++) {
    const cols    = dataRows[i];
    const get     = (colIdx: number) => (colIdx >= 0 ? (cols[colIdx] ?? "").trim() : "");
    const first   = get(idx.first_name);
    const last    = get(idx.last_name);
    const email   = get(idx.email).toLowerCase();
    const roleRaw = get(idx.role);

    if (!first && !last && !email) continue;
    displayIndex++;
    const messages: string[] = [];
    let status: InviteRowStatus = "ready";

    const parsedRole = parseRole(roleRaw);

    // Validate all required fields and role together
    if (!first) messages.push("First name is required.");
    if (!last)  messages.push("Last name is required.");
    if (!email) {
      messages.push("Email is required for invite links.");
    } else if (!isValidEmail(email)) {
      messages.push("Invalid email format.");
    }
    if (parsedRole === null) {
      messages.push(`Role must be "member" or "pro" (got "${roleRaw}").`);
    }

    if (messages.length > 0) {
      status = "invalid";
    } else {
      // Deduplication checks (only run when all fields are valid)
      if (emailsSeen.has(email)) {
        messages.push(`Duplicate email within import (same as row ${emailsSeen.get(email)}).`);
        status = "duplicate";
      } else {
        emailsSeen.set(email, displayIndex);
        if (memberEmailSet.has(email)) {
          messages.push("Already an active club member.");
          status = "existing-member";
        } else if (rosterEmailSet.has(email)) {
          messages.push("Email already on the roster.");
          status = "existing-roster";
        } else if (pendingInviteSet.has(email)) {
          messages.push("Active invite already pending.");
          status = "existing-invite";
        }
      }
    }

    rows.push({
      index: displayIndex,
      first_name: first,
      last_name:  last,
      email,
      role: parsedRole ?? roleRaw,  // show raw CSV value for invalid-role rows
      status,
      messages,
    });
  }

  if (rows.length === 0) return { rows: [], parseError: "No valid data rows found after skipping blank lines." };
  return { rows };
}

// ── Badges ────────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: RowStatus }) {
  if (status === "ready")   return <span className="text-xs font-medium text-green-700 dark:text-green-400">Ready</span>;
  if (status === "warning") return <span className="text-xs font-medium text-amber-600 dark:text-amber-400">Warning</span>;
  return <span className="text-xs font-medium text-red-600 dark:text-red-400">Error</span>;
}

const INVITE_STATUS_META: Record<InviteRowStatus, { label: string; color: string }> = {
  "ready":           { label: "Ready",            color: "text-green-700 dark:text-green-400" },
  "invalid":         { label: "Invalid",          color: "text-red-600 dark:text-red-400"     },
  "duplicate":       { label: "Duplicate",        color: "text-amber-600 dark:text-amber-400" },
  "existing-member": { label: "Already a member", color: "text-amber-600 dark:text-amber-400" },
  "existing-roster": { label: "On roster",        color: "text-amber-600 dark:text-amber-400" },
  "existing-invite": { label: "Invite pending",   color: "text-amber-600 dark:text-amber-400" },
};

function InviteStatusBadge({ status }: { status: InviteRowStatus }) {
  const { label, color } = INVITE_STATUS_META[status];
  return <span className={`text-xs font-medium ${color}`}>{label}</span>;
}

// ── Invite link result row ────────────────────────────────────────────────────

const SKIPPED_AS_LABELS: Record<NonNullable<InviteRowResult["skippedAs"]>, string> = {
  "existing-member":  "Already a club member — skipped",
  "existing-roster":  "Already on the roster — skipped",
  "existing-invite":  "Active invite pending — skipped",
};

function InviteLinkRow({ result, origin }: { result: InviteRowResult; origin: string }) {
  const [copied, setCopied] = useState(false);
  const url = result.code ? `${origin}/join/${result.code}` : null;

  async function handleCopy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* noop */ }
  }

  return (
    <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700 last:border-0">
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <p className="text-xs font-medium text-gray-800 dark:text-gray-200 truncate">{result.name}</p>
        <span className="shrink-0 text-[10px] text-gray-400 dark:text-gray-500 uppercase">{result.role}</span>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-1.5">{result.email}</p>
      {url ? (
        <div className="flex items-center gap-2">
          <input
            readOnly
            value={url}
            onFocus={e => e.target.select()}
            className="flex-1 min-w-0 rounded-lg border border-gray-200 dark:border-gray-600 px-2 py-1 text-[11px] text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-700 focus:outline-none"
          />
          <button
            onClick={handleCopy}
            className="shrink-0 px-2 py-1 rounded-lg border border-gray-200 dark:border-gray-600 text-[11px] font-medium text-gray-700 dark:text-gray-300 hover:border-accent hover:text-accent motion-safe:transition-all motion-safe:duration-150"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      ) : result.skippedAs ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {SKIPPED_AS_LABELS[result.skippedAs]}
        </p>
      ) : (
        <p className="text-xs text-red-500 dark:text-red-400">{result.error ?? "Failed to generate."}</p>
      )}
    </div>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export default function ImportMembersSheet({
  onClose,
  rosterMembers,
  memberEmails,
  pendingInviteEmails,
}: Props) {
  const router  = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [mode, setMode] = useState<ImportMode>("roster");
  const [step, setStep] = useState<Step>("mode");

  // Roster state
  const [parseError,       setParseError]       = useState<string | null>(null);
  const [rows,             setRows]             = useState<ParsedRow[]>([]);
  const [includeWarnings,  setIncludeWarnings]  = useState(false);
  const [importResult,     setImportResult]     = useState<ImportResult | null>(null);
  const [importError,      setImportError]      = useState<string | null>(null);
  const [pasteText,        setPasteText]        = useState("");

  // Invite state
  const [inviteRows,         setInviteRows]         = useState<InviteParsedRow[]>([]);
  const [inviteImportResult, setInviteImportResult] = useState<InviteImportResult | null>(null);
  const [inviteParseError,   setInviteParseError]   = useState<string | null>(null);
  const [invitePasteText,    setInvitePasteText]    = useState("");

  // Derived: roster
  const readyRows      = rows.filter(r => r.status === "ready");
  const warningRows    = rows.filter(r => r.status === "warning");
  const errorRows      = rows.filter(r => r.status === "error");
  const rowsToImport   = includeWarnings ? [...readyRows, ...warningRows] : readyRows;

  // Derived: invite preview
  const inviteReadyRows = inviteRows.filter(r => r.status === "ready");
  const inviteSkipRows  = inviteRows.filter(r => r.status !== "ready");

  // Derived: invite summary counts (combining preview classifications + server results)
  const sumGenerated       = (inviteImportResult?.results ?? []).filter(r => r.code).length;
  const sumFailed          = (inviteImportResult?.results ?? []).filter(r => r.error && !r.skippedAs).length;
  const sumServerMember    = (inviteImportResult?.results ?? []).filter(r => r.skippedAs === "existing-member").length;
  const sumServerRoster    = (inviteImportResult?.results ?? []).filter(r => r.skippedAs === "existing-roster").length;
  const sumServerInvite    = (inviteImportResult?.results ?? []).filter(r => r.skippedAs === "existing-invite").length;
  const sumPreviewInvalid  = inviteRows.filter(r => r.status === "invalid").length;
  const sumPreviewDup      = inviteRows.filter(r => r.status === "duplicate").length;
  const sumPreviewMember   = inviteRows.filter(r => r.status === "existing-member").length;
  const sumPreviewRoster   = inviteRows.filter(r => r.status === "existing-roster").length;
  const sumPreviewInvite   = inviteRows.filter(r => r.status === "existing-invite").length;
  const sumTotalMember     = sumPreviewMember + sumServerMember;
  const sumTotalRoster     = sumPreviewRoster + sumServerRoster;
  const sumTotalInvite     = sumPreviewInvite + sumServerInvite;

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  // ── File handling ──────────────────────────────────────────────────────

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv")) {
      if (mode === "roster") setParseError("Please choose a .csv file.");
      else setInviteParseError("Please choose a .csv file.");
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const raw = ev.target?.result as string;
      if (mode === "roster") {
        const result = parseAndValidateRoster(raw, rosterMembers);
        if (result.parseError) { setParseError(result.parseError); return; }
        setParseError(null); setRows(result.rows); setStep("preview");
      } else {
        const result = parseAndValidateInvite(raw, rosterMembers, memberEmails, pendingInviteEmails);
        if (result.parseError) { setInviteParseError(result.parseError); return; }
        setInviteParseError(null); setInviteRows(result.rows); setStep("preview");
      }
    };
    reader.readAsText(file, "UTF-8");
    e.target.value = "";
  }

  function handlePasteSubmit() {
    if (mode === "roster") {
      if (!pasteText.trim()) { setParseError("Paste some CSV content first."); return; }
      const result = parseAndValidateRoster(pasteText, rosterMembers);
      if (result.parseError) { setParseError(result.parseError); return; }
      setParseError(null); setRows(result.rows); setStep("preview");
    } else {
      if (!invitePasteText.trim()) { setInviteParseError("Paste some CSV content first."); return; }
      const result = parseAndValidateInvite(invitePasteText, rosterMembers, memberEmails, pendingInviteEmails);
      if (result.parseError) { setInviteParseError(result.parseError); return; }
      setInviteParseError(null); setInviteRows(result.rows); setStep("preview");
    }
  }

  // ── Import ─────────────────────────────────────────────────────────────

  async function handleImport() {
    setStep("importing"); setImportError(null);
    const payload: ImportRowInput[] = rowsToImport.map(r => ({
      firstName: r.first_name, lastName: r.last_name,
      email: r.email || null, phone: r.phone || null, notes: r.notes || null,
    }));
    const response = await importRosterMembersAction(payload);
    if (response.error) { setImportError(response.error); setStep("preview"); return; }
    setImportResult(response.result ?? null); setStep("summary");
  }

  async function handleInviteImport() {
    setStep("importing");
    const payload: InviteRowInput[] = inviteReadyRows.map(r => ({
      firstName: r.first_name,
      lastName:  r.last_name,
      email:     r.email,
      role:      r.role as "member" | "pro",  // safe: only ready rows have valid roles
    }));
    const response = await importInvitesAction(payload);
    if (response.error) { setInviteParseError(response.error); setStep("preview"); return; }
    setInviteImportResult(response.result ?? null); setStep("summary");
  }

  // ── Navigation ─────────────────────────────────────────────────────────

  function resetState() {
    setRows([]); setParseError(null); setIncludeWarnings(false); setPasteText("");
    setInviteRows([]); setInviteParseError(null); setInvitePasteText("");
  }

  function handleBack()       { resetState(); setStep("upload"); }
  function handleBackToMode() { resetState(); setStep("mode"); }
  function handleDone()       { router.refresh(); onClose(); }

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <ResponsiveSheet onClose={onClose} variant="modal" size="wide">
      <div className="px-6 pt-5 pb-8 overflow-y-auto flex-1">
        <div className="ct-handlebar mx-auto mb-4 md:hidden" />

        {/* ─── Mode selector ──────────────────────────────────────────────── */}
        {step === "mode" && (
          <div className="space-y-5">
            <div className="pr-8">
              <p className="text-base font-semibold text-gray-900 dark:text-gray-100">Import Members</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Choose how to bring in your members.</p>
            </div>
            <button
              onClick={() => { setMode("roster"); setStep("upload"); }}
              className="w-full text-left rounded-xl border border-gray-200 dark:border-gray-600 px-4 py-4 hover:border-accent hover:bg-gray-50 dark:hover:bg-gray-700/30 motion-safe:transition-all motion-safe:duration-150"
            >
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Add to roster only</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
                Add names (and optionally emails) to your member list. No invite link is created — use this for members who will claim their account later.
              </p>
            </button>
            <button
              onClick={() => { setMode("invite"); setStep("upload"); }}
              className="w-full text-left rounded-xl border border-gray-200 dark:border-gray-600 px-4 py-4 hover:border-accent hover:bg-gray-50 dark:hover:bg-gray-700/30 motion-safe:transition-all motion-safe:duration-150"
            >
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Generate member invite links</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
                Generate a shareable invite link for each person. Email is required for every row. Links are valid for 7 days — copy and share them manually.
              </p>
            </button>
          </div>
        )}

        {/* ─── Upload: roster ─────────────────────────────────────────────── */}
        {step === "upload" && mode === "roster" && (
          <div className="space-y-5">
            <div className="pr-8 flex items-center gap-3">
              <button onClick={handleBackToMode} className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 shrink-0">←</button>
              <div>
                <p className="text-base font-semibold text-gray-900 dark:text-gray-100">Add to Roster</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Upload a CSV to add multiple members at once.</p>
              </div>
            </div>

            <div className="rounded-xl border border-gray-200 dark:border-gray-600 px-4 py-4">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">Step 1 — Download the template</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">Fill in your members, save as CSV, then upload below.</p>
              <button onClick={downloadRosterTemplate} className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 text-xs font-medium text-gray-700 dark:text-gray-300 hover:border-accent hover:text-accent motion-safe:transition-all motion-safe:duration-150">
                Download template CSV
              </button>
            </div>

            <div className="rounded-xl border border-gray-200 dark:border-gray-600 px-4 py-4">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">Step 2 — Upload your file</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">Supported format: .csv · Max 200 rows</p>
              <input ref={fileRef} type="file" accept=".csv" onChange={handleFileChange} className="hidden" />
              <button onClick={() => fileRef.current?.click()} className="ct-button-neutral w-full py-3 text-sm font-semibold">
                Choose CSV file
              </button>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex-1 border-t border-gray-200 dark:border-gray-700" />
              <span className="text-xs text-gray-400 dark:text-gray-500">or paste CSV text</span>
              <div className="flex-1 border-t border-gray-200 dark:border-gray-700" />
            </div>

            <div className="rounded-xl border border-gray-200 dark:border-gray-600 px-4 py-4">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">Paste CSV</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">Copy and paste CSV content directly, including the header row.</p>
              <textarea
                value={pasteText}
                onChange={e => { setPasteText(e.target.value); setParseError(null); }}
                placeholder={"first_name,last_name,email,phone,notes\nJohn,Smith,john@example.com,,"}
                rows={5}
                className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-xs text-gray-900 dark:text-gray-100 px-3 py-2 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent resize-y font-mono"
              />
              <button onClick={handlePasteSubmit} disabled={!pasteText.trim()} className="mt-2 px-3 py-1.5 rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-xs font-medium disabled:opacity-40">
                Preview
              </button>
            </div>

            {parseError && <p className="text-xs text-red-600 dark:text-red-400">{parseError}</p>}
          </div>
        )}

        {/* ─── Upload: invite ──────────────────────────────────────────────── */}
        {step === "upload" && mode === "invite" && (
          <div className="space-y-5">
            <div className="pr-8 flex items-center gap-3">
              <button onClick={handleBackToMode} className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 shrink-0">←</button>
              <div>
                <p className="text-base font-semibold text-gray-900 dark:text-gray-100">Generate Invite Links</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">Email is required for every row. Links are valid for 7 days — copy and share them manually.</p>
              </div>
            </div>

            <div className="rounded-xl border border-gray-200 dark:border-gray-600 px-4 py-4">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">Step 1 — Download the template</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">Columns: first_name, last_name, email, role (member or pro; blank defaults to member)</p>
              <button onClick={downloadInviteTemplate} className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 text-xs font-medium text-gray-700 dark:text-gray-300 hover:border-accent hover:text-accent motion-safe:transition-all motion-safe:duration-150">
                Download template CSV
              </button>
            </div>

            <div className="rounded-xl border border-gray-200 dark:border-gray-600 px-4 py-4">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">Step 2 — Upload your file</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">Supported format: .csv · Max 200 rows</p>
              <input ref={fileRef} type="file" accept=".csv" onChange={handleFileChange} className="hidden" />
              <button onClick={() => fileRef.current?.click()} className="ct-button-neutral w-full py-3 text-sm font-semibold">
                Choose CSV file
              </button>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex-1 border-t border-gray-200 dark:border-gray-700" />
              <span className="text-xs text-gray-400 dark:text-gray-500">or paste CSV text</span>
              <div className="flex-1 border-t border-gray-200 dark:border-gray-700" />
            </div>

            <div className="rounded-xl border border-gray-200 dark:border-gray-600 px-4 py-4">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">Paste CSV</p>
              <textarea
                value={invitePasteText}
                onChange={e => { setInvitePasteText(e.target.value); setInviteParseError(null); }}
                placeholder={"first_name,last_name,email,role\nJohn,Smith,john@example.com,member"}
                rows={5}
                className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-xs text-gray-900 dark:text-gray-100 px-3 py-2 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent resize-y font-mono"
              />
              <button onClick={handlePasteSubmit} disabled={!invitePasteText.trim()} className="mt-2 px-3 py-1.5 rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-xs font-medium disabled:opacity-40">
                Preview
              </button>
            </div>

            {inviteParseError && <p className="text-xs text-red-600 dark:text-red-400">{inviteParseError}</p>}
          </div>
        )}

        {/* ─── Preview: roster ─────────────────────────────────────────────── */}
        {step === "preview" && mode === "roster" && (
          <div className="space-y-4">
            <div className="pr-8">
              <p className="text-base font-semibold text-gray-900 dark:text-gray-100">Review before importing</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                <span className="text-green-700 dark:text-green-400 font-medium">{readyRows.length} ready</span>
                {warningRows.length > 0 && <> · <span className="text-amber-600 dark:text-amber-400 font-medium">{warningRows.length} warning{warningRows.length !== 1 ? "s" : ""}</span></>}
                {errorRows.length > 0 && <> · <span className="text-red-600 dark:text-red-400 font-medium">{errorRows.length} error{errorRows.length !== 1 ? "s" : ""} (will be skipped)</span></>}
              </p>
            </div>

            {errorRows.length > 0 && (
              <p className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">Rows with errors will be skipped.</p>
            )}
            {warningRows.length > 0 && (
              <p className="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-3 py-2">Rows with warnings may already exist. Review before importing.</p>
            )}

            <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
              <table className="min-w-full text-xs">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700">
                    {["#", "First", "Last", "Email", "Phone", "Notes", "Status"].map(h => (
                      <th key={h} className="px-3 py-2 text-left font-semibold text-gray-500 dark:text-gray-400">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {rows.map(row => (
                    <tr key={row.index} className={row.status === "error" ? "bg-red-50/50 dark:bg-red-900/10 opacity-60" : row.status === "warning" ? "bg-amber-50/50 dark:bg-amber-900/10" : ""}>
                      <td className="px-3 py-2 text-gray-400">{row.index}</td>
                      <td className="px-3 py-2 text-gray-900 dark:text-gray-100 whitespace-nowrap">{row.first_name || <span className="text-red-400">—</span>}</td>
                      <td className="px-3 py-2 text-gray-900 dark:text-gray-100 whitespace-nowrap">{row.last_name  || <span className="text-red-400">—</span>}</td>
                      <td className="px-3 py-2 text-gray-500 dark:text-gray-400 whitespace-nowrap">{row.email || "—"}</td>
                      <td className="px-3 py-2 text-gray-500 dark:text-gray-400 whitespace-nowrap">{row.phone || "—"}</td>
                      <td className="px-3 py-2 text-gray-500 dark:text-gray-400 max-w-[160px] truncate">{row.notes || "—"}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <StatusBadge status={row.status} />
                        {row.messages.length > 0 && <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5 max-w-[180px] leading-snug">{row.messages[0]}</p>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {warningRows.length > 0 && (
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input type="checkbox" checked={includeWarnings} onChange={e => setIncludeWarnings(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-gray-300 accent-accent" />
                <span className="text-sm text-gray-700 dark:text-gray-300">
                  Include rows with warnings
                  <span className="block text-xs text-gray-400 dark:text-gray-500 mt-0.5">{warningRows.length} row{warningRows.length !== 1 ? "s" : ""} will be added even if they may already exist.</span>
                </span>
              </label>
            )}

            {importError && <p className="text-sm text-red-600 dark:text-red-400">{importError}</p>}

            <div className="flex gap-3 pt-1">
              <button onClick={handleBack} className="flex-1 py-3 rounded-xl border border-gray-200 dark:border-gray-600 text-sm font-medium text-gray-700 dark:text-gray-300 hover:border-accent hover:text-accent motion-safe:transition-all motion-safe:duration-150">
                ← Change file
              </button>
              <button disabled={rowsToImport.length === 0} onClick={handleImport} className="ct-button-neutral flex-1 py-3 text-sm font-semibold">
                Import {rowsToImport.length} Member{rowsToImport.length !== 1 ? "s" : ""}
              </button>
            </div>
          </div>
        )}

        {/* ─── Preview: invite ─────────────────────────────────────────────── */}
        {step === "preview" && mode === "invite" && (
          <div className="space-y-4">
            <div className="pr-8">
              <p className="text-base font-semibold text-gray-900 dark:text-gray-100">Review before generating</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                <span className="text-green-700 dark:text-green-400 font-medium">{inviteReadyRows.length} ready</span>
                {inviteSkipRows.length > 0 && <> · <span className="text-amber-600 dark:text-amber-400 font-medium">{inviteSkipRows.length} will be skipped</span></>}
              </p>
            </div>

            {inviteReadyRows.length === 0 && (
              <p className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">
                No rows are ready — fix errors in your CSV and re-upload.
              </p>
            )}

            <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
              <table className="min-w-full text-xs">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700">
                    {["#", "Name", "Email", "Role", "Status"].map(h => (
                      <th key={h} className="px-3 py-2 text-left font-semibold text-gray-500 dark:text-gray-400">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {inviteRows.map(row => (
                    <tr key={row.index} className={row.status !== "ready" ? "opacity-50" : ""}>
                      <td className="px-3 py-2 text-gray-400">{row.index}</td>
                      <td className="px-3 py-2 text-gray-900 dark:text-gray-100 whitespace-nowrap">{row.first_name} {row.last_name}</td>
                      <td className="px-3 py-2 text-gray-500 dark:text-gray-400 whitespace-nowrap">{row.email || "—"}</td>
                      <td className="px-3 py-2 text-gray-500 dark:text-gray-400 whitespace-nowrap">{row.role || "—"}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <InviteStatusBadge status={row.status} />
                        {row.messages.length > 0 && <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5 max-w-[180px] leading-snug">{row.messages[0]}</p>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-xs text-gray-400 dark:text-gray-500">
              Only <strong className="text-gray-600 dark:text-gray-300">Ready</strong> rows will receive invite links. All other rows will be skipped.
            </p>

            <div className="flex gap-3 pt-1">
              <button onClick={handleBack} className="flex-1 py-3 rounded-xl border border-gray-200 dark:border-gray-600 text-sm font-medium text-gray-700 dark:text-gray-300 hover:border-accent hover:text-accent motion-safe:transition-all motion-safe:duration-150">
                ← Change file
              </button>
              <button disabled={inviteReadyRows.length === 0} onClick={handleInviteImport} className="ct-button-neutral flex-1 py-3 text-sm font-semibold">
                Generate {inviteReadyRows.length} Link{inviteReadyRows.length !== 1 ? "s" : ""}
              </button>
            </div>
          </div>
        )}

        {/* ─── Importing: roster ──────────────────────────────────────────── */}
        {step === "importing" && mode === "roster" && (
          <div className="flex flex-col items-center justify-center py-12 gap-4">
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Adding members…</p>
            <p className="text-xs text-gray-400 dark:text-gray-500">Adding {rowsToImport.length} member{rowsToImport.length !== 1 ? "s" : ""}. This may take a moment.</p>
          </div>
        )}

        {/* ─── Importing: invite ───────────────────────────────────────────── */}
        {step === "importing" && mode === "invite" && (
          <div className="flex flex-col items-center justify-center py-12 gap-4">
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Generating invite links…</p>
            <p className="text-xs text-gray-400 dark:text-gray-500">Creating {inviteReadyRows.length} invite{inviteReadyRows.length !== 1 ? "s" : ""}. This may take a moment.</p>
          </div>
        )}

        {/* ─── Summary: roster ─────────────────────────────────────────────── */}
        {step === "summary" && mode === "roster" && importResult && (
          <div className="space-y-5">
            <p className="text-base font-semibold text-gray-900 dark:text-gray-100 pr-8">Import complete</p>

            {importResult.failed === 0 ? (
              <div className="rounded-xl bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 px-4 py-4">
                <p className="text-sm font-medium text-green-800 dark:text-green-300">Added {importResult.imported} member{importResult.imported !== 1 ? "s" : ""} to the roster.</p>
              </div>
            ) : importResult.imported > 0 ? (
              <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 px-4 py-4">
                <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                  Added {importResult.imported} of {importResult.imported + importResult.failed} members. {importResult.failed} row{importResult.failed !== 1 ? "s were" : " was"} skipped.
                </p>
              </div>
            ) : (
              <div className="rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 px-4 py-4">
                <p className="text-sm font-medium text-red-700 dark:text-red-400">No members were added. See details below.</p>
              </div>
            )}

            {importResult.errors.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Skipped rows</p>
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

            <button onClick={handleDone} className="ct-button-neutral w-full py-3 text-sm font-semibold">Done</button>
          </div>
        )}

        {/* ─── Summary: invite ─────────────────────────────────────────────── */}
        {step === "summary" && mode === "invite" && inviteImportResult && (
          <div className="space-y-5">
            <div className="pr-8 flex items-center justify-between gap-3">
              <p className="text-base font-semibold text-gray-900 dark:text-gray-100">Invite links generated</p>
              {inviteImportResult.results.some(r => r.code) && (
                <button
                  onClick={() => downloadInviteResultsCSV(inviteImportResult.results, origin)}
                  className="shrink-0 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 text-xs font-medium text-gray-700 dark:text-gray-300 hover:border-accent hover:text-accent motion-safe:transition-all motion-safe:duration-150"
                >
                  Download CSV
                </button>
              )}
            </div>

            {sumFailed === 0 ? (
              <div className="rounded-xl bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 px-4 py-3">
                <p className="text-sm font-medium text-green-800 dark:text-green-300">
                  Generated {sumGenerated} invite link{sumGenerated !== 1 ? "s" : ""}.
                </p>
              </div>
            ) : (
              <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 px-4 py-3">
                <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                  Generated {sumGenerated} link{sumGenerated !== 1 ? "s" : ""}. {sumFailed} failed.
                </p>
              </div>
            )}

            {/* Combined summary breakdown */}
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden divide-y divide-gray-100 dark:divide-gray-700">
              {sumGenerated > 0 && (
                <div className="px-4 py-2.5 flex items-center justify-between">
                  <span className="text-sm text-gray-700 dark:text-gray-200">Links generated</span>
                  <span className="text-sm font-medium text-green-700 dark:text-green-400">{sumGenerated}</span>
                </div>
              )}
              {sumTotalMember > 0 && (
                <div className="px-4 py-2.5 flex items-center justify-between">
                  <span className="text-sm text-gray-700 dark:text-gray-200">Existing members — skipped</span>
                  <span className="text-sm font-medium text-amber-600 dark:text-amber-400">{sumTotalMember}</span>
                </div>
              )}
              {sumTotalRoster > 0 && (
                <div className="px-4 py-2.5 flex items-center justify-between">
                  <span className="text-sm text-gray-700 dark:text-gray-200">Existing roster members — skipped</span>
                  <span className="text-sm font-medium text-amber-600 dark:text-amber-400">{sumTotalRoster}</span>
                </div>
              )}
              {sumTotalInvite > 0 && (
                <div className="px-4 py-2.5 flex items-center justify-between">
                  <span className="text-sm text-gray-700 dark:text-gray-200">Pending invitations — skipped</span>
                  <span className="text-sm font-medium text-amber-600 dark:text-amber-400">{sumTotalInvite}</span>
                </div>
              )}
              {sumPreviewDup > 0 && (
                <div className="px-4 py-2.5 flex items-center justify-between">
                  <span className="text-sm text-gray-700 dark:text-gray-200">Duplicates within import — skipped</span>
                  <span className="text-sm font-medium text-amber-600 dark:text-amber-400">{sumPreviewDup}</span>
                </div>
              )}
              {sumPreviewInvalid > 0 && (
                <div className="px-4 py-2.5 flex items-center justify-between">
                  <span className="text-sm text-gray-700 dark:text-gray-200">Invalid rows — skipped</span>
                  <span className="text-sm font-medium text-red-600 dark:text-red-400">{sumPreviewInvalid}</span>
                </div>
              )}
              {sumFailed > 0 && (
                <div className="px-4 py-2.5 flex items-center justify-between">
                  <span className="text-sm text-gray-700 dark:text-gray-200">Failed (unexpected error)</span>
                  <span className="text-sm font-medium text-red-600 dark:text-red-400">{sumFailed}</span>
                </div>
              )}
            </div>

            <p className="text-xs text-gray-400 dark:text-gray-500">
              Links are valid for 7 days. Copy and share each one directly — no email was sent.
            </p>

            {inviteImportResult.results.length > 0 && (
              <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
                {inviteImportResult.results.map((r, i) => (
                  <InviteLinkRow key={i} result={r} origin={origin} />
                ))}
              </div>
            )}

            <button onClick={handleDone} className="ct-button-neutral w-full py-3 text-sm font-semibold">Done</button>
          </div>
        )}

      </div>
    </ResponsiveSheet>
  );
}
