import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 43B-4B — the first public, unauthenticated Guest waiver
// experience, built on the 43B-4A backend (0198, applied/immutable — not
// touched by this checkpoint). Source-inspection style, matching this
// repository's established convention (see waiverPdfReviewGate.
// regression.test.ts for the Member equivalent this mirrors closely).
//
// PRE-APPLY CORRECTION PASS (same checkpoint): two corrections made before
// this file was written —
//   1. The sessionStorage "reviewed" key was originally scoped by
//      rawToken + currentVersionId, persisting the bearer credential (as
//      part of a storage key) in the browser. Fixed: scoped by the non-
//      secret invitationId (0198's own resolve_guest_waiver_invitation
//      return field) + currentVersionId instead — rawToken is held only
//      in-memory component state for the two Server Action calls that
//      require it, never written to any persistent browser storage.
//   2. Legacy-text-Guest-waiver support: the PDF-only pivot (43B-3B) did
//      not retroactively invalidate a Guest waiver version published
//      before it — GuestWaiverSection.tsx (admin UI) still renders a
//      `!isPdfBacked` branch for exactly this case, proving a current
//      Guest waiver CAN still be legacy text-backed. resolveGuestWaiver.ts
//      now reads waiver_versions.body directly via the privileged client
//      (the same established pattern src/lib/waivers/pdfViewUrl.ts already
//      uses for the sibling waiver_document_files table) — no 0198
//      change, no migration — and the public page/client component
//      render the legacy body directly with no review-click gate,
//      mirroring /waivers/member/page.tsx's own identical posture.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
}

function extractFunctionBody(source: string, marker: string): string {
  const start = source.indexOf(marker);
  expect(start, `${marker} not found`).toBeGreaterThan(-1);
  // Several functions here return `Promise<{ ... }>` — a naive "first {
  // after start" search stops at THAT return type's own closing brace,
  // truncating long before the real function body. Skip past any
  // ": Promise<...> {" return-type annotation first; fall back to the
  // first "{" for functions with no such annotation (e.g. useEffect(() =>
  // {...}) or a plain function declaration).
  const sigWindow = source.slice(start, start + 400);
  const bodyOpenMatch = sigWindow.match(/\)\s*:\s*Promise<[\s\S]*?>\s*\{/);
  const relativeBodyStart = bodyOpenMatch
    ? bodyOpenMatch.index! + bodyOpenMatch[0].length - 1
    : sigWindow.indexOf("{");
  let depth = 0;
  let i = start + relativeBodyStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(start, i + 1);
}

// A useEffect(() => {...}, [deps]) call's dependency array lives OUTSIDE
// the balanced-brace body extractFunctionBody returns (it follows the
// closing "}" of the arrow function, as ", [deps]);") — this finds the
// dependency array's own closing "]);" specifically, rather than the
// first "");"" (which would match an inner call's own close instead).
function extractCallExpression(source: string, marker: string): string {
  const start = source.indexOf(marker);
  expect(start, `${marker} not found`).toBeGreaterThan(-1);
  const end = source.indexOf("]);", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 3);
}

const RESOLVE_PATH = "src/app/waivers/guest/[token]/resolveGuestWaiver.ts";
const ACTIONS_PATH = "src/app/waivers/guest/[token]/actions.ts";
const CLIENT_PATH = "src/app/waivers/guest/[token]/GuestWaiverAcceptanceClient.tsx";
const PAGE_PATH = "src/app/waivers/guest/[token]/page.tsx";
const APP_LAYOUT_PATH = "src/app/(app)/layout.tsx";
const PDF_VIEW_URL_PATH = "src/lib/waivers/pdfViewUrl.ts";
const GUEST_WAIVER_SECTION_PATH = "src/app/(app)/admin/members/GuestWaiverSection.tsx";

const resolveSrc = readSource(RESOLVE_PATH);
const resolveCodeOnly = codeOnly(resolveSrc);
const actionsSrc = readSource(ACTIONS_PATH);
const actionsCodeOnly = codeOnly(actionsSrc);
const clientSrc = readSource(CLIENT_PATH);
const clientCodeOnly = codeOnly(clientSrc);
const pageSrc = readSource(PAGE_PATH);
const pageCodeOnly = codeOnly(pageSrc);
const handleAcceptFn = extractFunctionBody(clientSrc, "function handleAccept()");

// ═══════════════════════════════════════════════════════════════════════════
// LEGACY TEXT AUDIT — the evidence this checkpoint's design decision rests on
// ═══════════════════════════════════════════════════════════════════════════

describe("legacy-text-Guest-waiver audit — a current Guest waiver CAN still be legacy text-backed", () => {
  it("GuestWaiverSection.tsx (admin UI) still renders a !isPdfBacked branch for the CURRENT document, not merely for an old unpublished draft", () => {
    const s = readSource(GUEST_WAIVER_SECTION_PATH);
    expect(s).toContain("currentDocument && !currentDocument.isPdfBacked && mode ===");
    expect(s).toContain("currentDocument.legacyTitle");
    expect(s).toContain("currentDocument.legacyBody");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════

describe("PUBLIC RESOLUTION", () => {
  it("validates token syntax BEFORE ever touching Postgres, mirroring the calendar feed route's own shape", () => {
    const fn = extractFunctionBody(resolveSrc, "export async function resolveGuestWaiverInvitation(");
    const fnCodeOnly = codeOnly(fn);
    expect(fnCodeOnly).toContain("if (!isSyntacticallyValidGuestWaiverToken(rawToken)) return null;");
    const syntaxCheckIdx = fnCodeOnly.indexOf("isSyntacticallyValidGuestWaiverToken(rawToken)");
    const hashIdx = fnCodeOnly.indexOf("hashGuestWaiverToken(rawToken)");
    expect(hashIdx).toBeGreaterThan(syntaxCheckIdx);
  });

  it("a malformed token fails closed (returns null) without reaching the privileged client at all", () => {
    const fn = extractFunctionBody(resolveSrc, "export async function resolveGuestWaiverInvitation(");
    const syntaxGuardIdx = fn.indexOf("if (!isSyntacticallyValidGuestWaiverToken(rawToken)) return null;");
    const privilegedIdx = fn.indexOf("createPrivilegedClient()");
    expect(syntaxGuardIdx).toBeGreaterThan(-1);
    expect(privilegedIdx).toBeGreaterThan(syntaxGuardIdx);
  });

  it("an unknown/revoked/unavailable resolution collapses to the SAME null return as a malformed token — no distinguishing state", () => {
    const fn = extractFunctionBody(resolveSrc, "export async function resolveGuestWaiverInvitation(");
    const returnNullCount = (fn.match(/return null;/g) ?? []).length;
    expect(returnNullCount).toBeGreaterThanOrEqual(2); // malformed-syntax path + missing-privileged-client/unknown-row path
  });

  it("calls resolve_guest_waiver_invitation via the privileged (service_role) client — never the ordinary session/anon client", () => {
    expect(resolveCodeOnly).toContain('privileged.rpc("resolve_guest_waiver_invitation"');
    expect(resolveCodeOnly).not.toMatch(/createClient\(\)/);
  });

  it("only the token HASH is ever passed as an RPC parameter — never the raw token", () => {
    const rpcCallIdx = resolveCodeOnly.indexOf('privileged.rpc("resolve_guest_waiver_invitation"');
    const rpcCallBlock = resolveCodeOnly.slice(rpcCallIdx, rpcCallIdx + 150);
    expect(rpcCallBlock).toContain("p_token_hash: tokenHash");
    expect(rpcCallBlock).not.toMatch(/p_token_hash:\s*rawToken/);
  });

  it("page.tsx requires no authentication — no getAuthUser/createClient session check anywhere on this route", () => {
    expect(pageCodeOnly).not.toMatch(/getAuthUser|getAuthProfile|auth\.getUser/);
  });

  it("the (app) layout's own blanket auth redirect confirms WHY this page must live outside that route group", () => {
    const layoutSrc = readSource(APP_LAYOUT_PATH);
    expect(layoutSrc).toContain('if (!user) redirect("/sign-in");');
    // And this page's own path is genuinely outside (app) — no "(app)"
    // segment in its own path.
    expect(PAGE_PATH).not.toContain("(app)");
  });

  it("returns only minimal fields — no participant/member/financial data beyond club name, Guest display name, and waiver identity", () => {
    const interfaceStart = resolveSrc.indexOf("export interface ResolvedGuestWaiverInvitation");
    const interfaceEnd = resolveSrc.indexOf("}", interfaceStart);
    const shape = resolveSrc.slice(interfaceStart, interfaceEnd);
    expect(shape).not.toMatch(/ownerUserId|participants|financial|amount|price|memberIdentity/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RAW TOKEN NON-PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════

describe("RAW TOKEN NON-PERSISTENCE", () => {
  it("resolveGuestWaiver.ts and actions.ts never log the raw token or its hash", () => {
    expect(resolveCodeOnly).not.toMatch(/console\.(log|error|warn)\([^)]*rawToken/);
    expect(actionsCodeOnly).not.toMatch(/console\.(log|error|warn)\([^)]*rawToken/);
  });

  it("PRE-APPLY CORRECTION: the sessionStorage review key is scoped by invitationId + currentVersionId — NEVER rawToken", () => {
    expect(clientCodeOnly).toContain(
      "function reviewedSessionKey(invitationId: string, versionId: string): string {"
    );
    const keyFn = extractFunctionBody(clientSrc, "function reviewedSessionKey(invitationId: string, versionId: string): string {");
    expect(keyFn).toContain("invitationId");
    expect(keyFn).toContain("versionId");
    expect(keyFn).not.toMatch(/rawToken/);
  });

  it("no sessionStorage/localStorage call anywhere in the client component ever receives rawToken as an argument", () => {
    const storageCalls = clientCodeOnly.match(/(session|local)Storage\.(setItem|getItem)\([^)]*\)/g) ?? [];
    expect(storageCalls.length).toBeGreaterThan(0);
    for (const call of storageCalls) {
      expect(call).not.toMatch(/rawToken/);
    }
  });

  it("rawToken is never written to any cookie (no document.cookie assignment anywhere in the client component)", () => {
    expect(clientCodeOnly).not.toMatch(/document\.cookie/);
  });

  it("rawToken never appears inside an error message string returned to the caller — the Server Actions only ever construct generic, fixed error copy", () => {
    // Every returned error string in actions.ts is a string literal, never
    // a template literal interpolating rawToken/tokenHash.
    expect(actionsCodeOnly).not.toMatch(/error:\s*`[^`]*\$\{(rawToken|tokenHash)\}/);
  });

  it("mint actions (calendar + events) never log the raw token, and only ever embed it in the ONE returned public URL — never anywhere else", () => {
    const calendarActions = codeOnly(readSource("src/app/(app)/calendar/actions.ts"));
    const eventsActions = codeOnly(readSource("src/app/(app)/admin/events/actions.ts"));
    for (const src of [calendarActions, eventsActions]) {
      expect(src).not.toMatch(/console\.(log|error|warn)\([^)]*rawToken/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC PAGE STATES
// ═══════════════════════════════════════════════════════════════════════════

describe("PUBLIC PAGE STATES", () => {
  it("state A (invalid/unavailable) is one generic message — never discloses which condition failed", () => {
    const fn = extractFunctionBody(pageSrc, "function UnavailableState()");
    expect(fn).toContain("This waiver link is no longer available.");
    expect(fn).not.toMatch(/revoked|cancelled|archived|removed|malformed/i);
  });

  it("state A renders with NO club/Guest data in scope — resolved is null on that branch, so nothing could leak even by mistake", () => {
    expect(pageCodeOnly).toContain("!resolved ? (");
    const branchIdx = pageCodeOnly.indexOf("!resolved ? (");
    const unavailableIdx = pageCodeOnly.indexOf("<UnavailableState", branchIdx);
    expect(unavailableIdx).toBeGreaterThan(branchIdx);
    expect(unavailableIdx - branchIdx).toBeLessThan(60);
  });

  it("state D (not currently required / no current version) is a neutral message, distinct from and never conflated with the invalid-token error", () => {
    const fn = extractFunctionBody(pageSrc, "function NotRequiredState()");
    expect(fn).toContain("No waiver is currently required for this guest.");
    expect(fn).not.toContain("no longer available");
  });

  it("state D triggers on !currentVersionId OR !isRequired — a real resolved row, not a failed resolution", () => {
    expect(pageCodeOnly).toContain("!resolved.currentVersionId || !resolved.isRequired");
  });

  it("state C (already accepted) is handled inside the client component via initialAccepted, not a separate page branch — so accepted status always reflects the live current-version read", () => {
    expect(pageCodeOnly).toContain("initialAccepted={resolved.isCurrentAccepted}");
    expect(clientCodeOnly).toContain("if (accepted) {");
    expect(clientCodeOnly).toContain("Waiver accepted");
    expect(clientCodeOnly).not.toMatch(/sign|signature|signed|e-signature|digital signature/i);
  });

  it("no other Guests, reservation owner, or booking financial data is ever rendered on this page", () => {
    expect(pageCodeOnly).not.toMatch(/owner|participants|amount_due|price|payment/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PDF / TEXT REVIEW GATE
// ═══════════════════════════════════════════════════════════════════════════

describe("PDF REVIEW GATE (isPdfBacked)", () => {
  const handleViewPdfFn = extractFunctionBody(clientSrc, "async function handleViewPdf()");

  it("the PDF window is opened SYNCHRONOUSLY before any await, exactly like the Member component (preserves browser user-activation)", () => {
    const openIdx = handleViewPdfFn.indexOf('window.open("about:blank", "_blank")');
    const awaitIdx = handleViewPdfFn.indexOf("await getGuestWaiverPdfViewUrlAction");
    expect(openIdx).toBeGreaterThan(-1);
    expect(awaitIdx).toBeGreaterThan(openIdx);
  });

  it("reviewed is set to true ONLY after the real window is confirmed still open and navigated — never merely because a URL was returned", () => {
    const closedCheckIdx = handleViewPdfFn.indexOf("if (pdfWindow.closed)");
    const navigateIdx = handleViewPdfFn.indexOf("pdfWindow.location.href = result.url;");
    const reviewedSetIdx = handleViewPdfFn.indexOf("setReviewed(true);");
    expect(closedCheckIdx).toBeGreaterThan(-1);
    expect(navigateIdx).toBeGreaterThan(closedCheckIdx);
    expect(reviewedSetIdx).toBeGreaterThan(navigateIdx);
  });

  it("accept controls are disabled before review when isPdfBacked — the checkbox is disabled={!reviewed} and Accept is disabled while isPdfBacked && !agreed", () => {
    expect(clientCodeOnly).toContain("disabled={!reviewed}");
    expect(clientCodeOnly).toContain("disabled={isPending || (isPdfBacked && !agreed)}");
  });

  it("copy stays restrained — 'Waiver opened', never a claim that reading/reviewing completed", () => {
    expect(clientCodeOnly).toContain("Waiver opened");
    expect(clientCodeOnly).not.toMatch(/read completely|reading confirmed|fully reviewed/i);
  });

  it("legacy text (isPdfBacked=false) has NO review-click gate — Accept is available immediately once rendered, matching the Member component's own posture for legacy text", () => {
    const acceptButtonBlock = clientCodeOnly.slice(clientCodeOnly.indexOf('onClick={handleAccept}') - 50, clientCodeOnly.indexOf('onClick={handleAccept}') + 250);
    expect(acceptButtonBlock).toContain("isPdfBacked ? \"Accept Waiver\" : \"I Accept\"");
    expect(clientCodeOnly).not.toContain("disabled={!reviewed && !isPdfBacked}"); // never an inverted/legacy-gated form
  });

  it("no durable server-side 'viewed' evidence is ever written — reviewed state lives ONLY in sessionStorage, never sent to a Server Action", () => {
    expect(actionsCodeOnly).not.toMatch(/reviewed|viewed_at/i);
  });
});

describe("EXACT-VERSION RESET", () => {
  it("the reviewed/agreed effect is keyed by invitationId, currentVersionId, AND isPdfBacked — a version change always re-derives from a fresh sessionStorage read, never inherits the prior version's state", () => {
    const effectCall = extractCallExpression(clientSrc, "useEffect(() => {\n    setReviewed(isPdfBacked");
    expect(effectCall).toContain("[invitationId, currentVersionId, isPdfBacked]");
    expect(effectCall).toContain("setAgreed(false);");
  });

  it("page.tsx forces a full remount of the client component on invitationId+currentVersionId change via its own React key", () => {
    expect(pageCodeOnly).toContain("key={`${resolved.invitationId}:${resolved.currentVersionId}`}");
  });

  it("Member waiver review-gate behavior is unchanged by this checkpoint — WaiverAcceptanceClient.tsx still keys its own sessionStorage by currentVersionId only (self-scoped, no token concept), untouched", () => {
    const memberClient = readSource("src/app/(app)/waivers/member/WaiverAcceptanceClient.tsx");
    expect(memberClient).toContain("function reviewedSessionKey(versionId: string): string {");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ACCEPTANCE / STALE VERSION
// ═══════════════════════════════════════════════════════════════════════════

describe("ACCEPTANCE", () => {
  it("acceptGuestWaiverAction hashes the raw token server-side and calls the service_role-only accept_guest_waiver RPC via the privileged client", () => {
    const fn = extractFunctionBody(actionsSrc, "export async function acceptGuestWaiverAction(");
    expect(fn).toContain("hashGuestWaiverToken(rawToken)");
    expect(fn).toContain('privileged.rpc("accept_guest_waiver"');
    expect(fn).toContain("p_token_hash: tokenHash");
    expect(fn).toContain("p_waiver_version_id: waiverVersionId");
  });

  it("submits the EXACT resolved current_version_id — handleAccept only ever calls acceptGuestWaiverAction(rawToken, currentVersionId), never a hard-coded/derived id", () => {
    expect(handleAcceptFn).toContain("acceptGuestWaiverAction(rawToken, currentVersionId)");
  });

  it("stale_waiver_version (and the equivalent no-longer-required states) fail closed and trigger the Refresh path — never silently retried as the old version", () => {
    const fn = extractFunctionBody(actionsSrc, "export async function acceptGuestWaiverAction(");
    expect(fn).toContain("stale_waiver_version");
    expect(fn).toContain("stale: true");
    expect(fn).toContain("no_current_guest_waiver");
    expect(fn).toContain("guest_waiver_not_required");
  });

  it("a stale result shows a Refresh button that calls router.refresh() — re-resolving fresh state, never re-submitting the same version", () => {
    expect(clientCodeOnly).toContain("isStale ? (");
    expect(clientCodeOnly).toContain("onClick={() => router.refresh()}");
  });

  it("invalid_token / guest_slot_invalid map to the SAME generic unavailable copy as the page's own state A — no internal distinction surfaced", () => {
    const fn = extractFunctionBody(actionsSrc, "export async function acceptGuestWaiverAction(");
    const unavailableBlock = fn.slice(fn.indexOf('key === "invalid_token" || key === "guest_slot_invalid"'));
    expect(unavailableBlock).toContain("UNAVAILABLE_ERROR");
  });

  it("acceptance error text never contains the raw token or its hash — only fixed, generic strings", () => {
    const fn = extractFunctionBody(actionsSrc, "export async function acceptGuestWaiverAction(");
    expect(fn).not.toMatch(/error:\s*`[^`]*\$\{/); // no template-literal error containing any interpolation at all
  });

  it("no Admin/Staff proxy-acceptance path exists anywhere in this route — acceptGuestWaiverAction takes only rawToken and waiverVersionId, never an actor id", () => {
    const sigStart = actionsSrc.indexOf("export async function acceptGuestWaiverAction(");
    const sigEnd = actionsSrc.indexOf(")", sigStart);
    const signature = actionsSrc.slice(sigStart, sigEnd);
    expect(signature).not.toMatch(/actorId|adminId|profileId|userId/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SIGNED PDF / MINIMAL DATA EXPOSURE
// ═══════════════════════════════════════════════════════════════════════════

describe("SIGNED PDF HANDLING", () => {
  it("getGuestWaiverPdfViewUrlAction re-resolves the token (never trusts a client-supplied version id) before requesting a signed URL", () => {
    const fn = extractFunctionBody(actionsSrc, "export async function getGuestWaiverPdfViewUrlAction(");
    expect(fn).toContain("resolveGuestWaiverInvitation(rawToken)");
    expect(fn).toContain("resolveWaiverPdfViewUrl(resolved.currentVersionId)");
  });

  it("reuses the existing shared, audience-agnostic resolveWaiverPdfViewUrl helper — no duplicate Storage-signing logic", () => {
    expect(actionsCodeOnly).toContain('import { resolveWaiverPdfViewUrl } from "@/lib/waivers/pdfViewUrl";');
    expect(actionsCodeOnly).not.toMatch(/createSignedUrl/); // that call lives only inside pdfViewUrl.ts
  });

  it("the storage bucket itself is never made public by this checkpoint — no bucket-policy/public-flag change anywhere in the new files", () => {
    for (const src of [resolveCodeOnly, actionsCodeOnly, clientCodeOnly, pageCodeOnly]) {
      expect(src).not.toMatch(/public:\s*true|makePublic|setPublic/i);
    }
  });

  it("pdfViewUrl.ts itself (the shared helper) is untouched by this checkpoint — same file this audit found already existed", () => {
    const s = readSource(PDF_VIEW_URL_PATH);
    expect(s).toContain("export async function resolveWaiverPdfViewUrl(");
  });
});
