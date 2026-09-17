import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Phase 43B-3D — require PDF review before Member acceptance. A UX
// interaction requirement ONLY — not legal proof of reading. No new
// evidence table, no DB/audit write, no waiver_acceptances change.
// Source-inspection style, matching this repository's established
// convention. No migration in this checkpoint.
//
// Runtime correction pass (same checkpoint): `reviewed` must never be
// read from sessionStorage during the initial render (hydration-unsafe
// for a server-pre-rendered Client Component) — it always starts false
// and is only ever set from a post-mount effect. Separately, the PDF
// window is opened SYNCHRONOUSLY (before the signed-URL await) to
// preserve browser user-activation, and "reviewed" is only ever set
// after that exact window is confirmed still open and successfully
// navigated to the real signed URL — never merely because a URL was
// returned, and never via a second window.open() call after the await.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const CLIENT_PATH = "src/app/(app)/waivers/member/WaiverAcceptanceClient.tsx";
const MEMBER_ACTIONS_PATH = "src/app/(app)/waivers/member/actions.ts";
const MIGRATION_0196_PATH = "supabase/migrations/0196_waiver_pdf_document_foundation.sql";

const s = readSource(CLIENT_PATH);
const codeOnly = s.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");

function extractFunctionBody(source: string, marker: string): string {
  const start = source.indexOf(marker);
  expect(start, `${marker} not found`).toBeGreaterThan(-1);
  // Balanced-brace extraction: the naive "next \n  }" search truncates
  // early whenever the function body itself contains a nested block
  // (if-statements, etc.) that closes with "\n    }" or similar before
  // the function's own closing brace does.
  let depth = 0;
  let i = source.indexOf("{", start);
  const bodyStart = i;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(start, i + 1);
}

const handleViewPdfFn = extractFunctionBody(s, "async function handleViewPdf()");
const handleAcceptFn = extractFunctionBody(s, "function handleAccept()");
// Code only — comments in this function legitimately narrate the exact
// synchronous-open/no-second-window invariants these tests check for,
// using the same literal terms ("await", "window.open()") as prose.
const handleViewPdfFnCodeOnly = handleViewPdfFn
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");

describe("WaiverAcceptanceClient — PDF review gate, hydration-safe (Phase 43B-3D)", () => {
  it("1. reviewed initializes false without reading sessionStorage during render", () => {
    expect(s).toContain("const [reviewed, setReviewed] = useState(false);");
    expect(s).not.toContain("const [reviewed, setReviewed] = useState(() =>");
  });

  it("2. sessionStorage is read only from the post-mount/currentVersionId effect, never during the render body", () => {
    // The ONLY CALL to readReviewedFromSession(...) (as distinct from its
    // own function definition) must be inside the useEffect callback, not
    // in the component's top-level render body.
    const readCalls = [...s.matchAll(/readReviewedFromSession\(currentVersionId\)/g)];
    expect(readCalls.length).toBe(1);
    const firstEffectIdx = s.indexOf("useEffect(() => {");
    const readCallIdx = readCalls[0].index!;
    expect(readCallIdx).toBeGreaterThan(firstEffectIdx);
    const effectBody = s.slice(firstEffectIdx, s.indexOf("[currentVersionId, isPdfBacked]);") + 40);
    expect(effectBody).toContain("readReviewedFromSession(currentVersionId)");
    expect(effectBody).toContain("setAgreed(false);");
  });

  it("3. exact-version session key remains unchanged", () => {
    expect(s).toContain("function reviewedSessionKey(versionId: string): string {");
    expect(s).toContain("`court-time:waiver-reviewed:${versionId}`");
    expect(s).toContain("readReviewedFromSession(currentVersionId)");
    expect(s).toContain("writeReviewedToSession(currentVersionId)");
  });

  it("a replacement version cannot inherit an older version's reviewed/agreed state — both re-derived whenever currentVersionId changes", () => {
    const effectStart = s.indexOf("useEffect(() => {");
    const effect = s.slice(effectStart, s.indexOf("[currentVersionId, isPdfBacked]);") + 40);
    expect(effect).toContain("setReviewed(isPdfBacked ? readReviewedFromSession(currentVersionId) : false);");
    expect(effect).toContain("setAgreed(false);");
  });

  it("4. a blank PDF window is opened synchronously as the FIRST statement, before awaiting the signed-URL action", () => {
    const openIdx = handleViewPdfFnCodeOnly.indexOf('window.open("about:blank", "_blank")');
    const awaitIdx = handleViewPdfFnCodeOnly.indexOf("await getMemberWaiverPdfViewUrlAction()");
    expect(openIdx).toBeGreaterThan(-1);
    expect(awaitIdx).toBeGreaterThan(openIdx);
    // Nothing async happens between entering the function and the
    // window.open() call — only setError(null), a synchronous state
    // setter.
    const preamble = handleViewPdfFnCodeOnly.slice(0, openIdx);
    expect(preamble).not.toMatch(/await/);
  });

  it("5. a popup-blocked/null window never marks reviewed and returns before requesting a signed URL", () => {
    const nullCheckIdx = handleViewPdfFn.indexOf("if (!pdfWindow) {");
    const awaitIdx = handleViewPdfFn.indexOf("await getMemberWaiverPdfViewUrlAction()");
    expect(nullCheckIdx).toBeGreaterThan(-1);
    expect(nullCheckIdx).toBeLessThan(awaitIdx);
    const nullBranch = handleViewPdfFn.slice(nullCheckIdx, handleViewPdfFn.indexOf("return;", nullCheckIdx) + 8);
    expect(nullBranch).not.toMatch(/setReviewed|writeReviewedToSession|getMemberWaiverPdfViewUrlAction/);
    expect(nullBranch).toContain("blocked the waiver PDF");
  });

  it("6. a signed-URL failure never marks reviewed and closes the placeholder window", () => {
    const failIdx = handleViewPdfFn.indexOf("if (result.error || !result.url) {");
    expect(failIdx).toBeGreaterThan(-1);
    const failBranch = handleViewPdfFn.slice(failIdx, handleViewPdfFn.indexOf("return;", failIdx) + 8);
    expect(failBranch).not.toMatch(/setReviewed\(true\)|writeReviewedToSession/);
    expect(failBranch).toContain("pdfWindow.close();");
    expect(failBranch).toContain("setError(");
  });

  it("7. the placeholder being closed by the user before navigation never marks reviewed", () => {
    const closedCheckIdx = handleViewPdfFn.indexOf("if (pdfWindow.closed) {");
    expect(closedCheckIdx).toBeGreaterThan(-1);
    const closedBranch = handleViewPdfFn.slice(closedCheckIdx, handleViewPdfFn.indexOf("return;", closedCheckIdx) + 8);
    expect(closedBranch).not.toMatch(/setReviewed\(true\)|writeReviewedToSession/);
    expect(closedBranch).toContain("setError(");
    expect(closedBranch).toContain("closed before it could open");
  });

  it("8. only successful navigation to the returned URL marks reviewed — setReviewed(true) is preceded by pdfWindow.location.href = result.url in source order", () => {
    const navigateIdx = handleViewPdfFn.indexOf("pdfWindow.location.href = result.url;");
    const reviewedIdx = handleViewPdfFn.indexOf("setReviewed(true);");
    expect(navigateIdx).toBeGreaterThan(-1);
    expect(reviewedIdx).toBeGreaterThan(navigateIdx);
  });

  it("9. no second window.open() call occurs after the await — exactly one window.open() call in the whole handler", () => {
    const opens = [...handleViewPdfFnCodeOnly.matchAll(/window\.open\(/g)];
    expect(opens.length).toBe(1);
    const awaitIdx = handleViewPdfFnCodeOnly.indexOf("await getMemberWaiverPdfViewUrlAction()");
    expect(opens[0].index!).toBeLessThan(awaitIdx);
  });

  it("10. sessionStorage write happens only on the successful-navigation path, never in the null-window, failed-URL, or closed-placeholder branches", () => {
    const writeCalls = [...handleViewPdfFn.matchAll(/writeReviewedToSession\(/g)];
    expect(writeCalls.length).toBe(1);
    const navigateIdx = handleViewPdfFn.indexOf("pdfWindow.location.href = result.url;");
    expect(writeCalls[0].index!).toBeGreaterThan(navigateIdx);
  });

  it("11. checkbox still requires reviewed", () => {
    expect(s).toContain("disabled={!reviewed}");
  });

  it("12. checkbox agreement is still independently required for Accept — disabled expression checks !agreed, not merely !reviewed", () => {
    expect(s).toContain("disabled={isPending || (isPdfBacked && !agreed)}");
    expect(s).not.toMatch(/disabled=\{isPending \|\| \(isPdfBacked && !reviewed\)\}/);
  });

  it("opening the PDF alone can never accept the waiver — handleViewPdf never calls acceptMemberWaiverAction or sets status", () => {
    expect(handleViewPdfFn).not.toMatch(/acceptMemberWaiverAction|setStatus/);
  });

  it("accept_member_waiver is still called only from handleAccept, against the exact currentVersionId, unchanged from 43A-2", () => {
    expect(handleAcceptFn).toContain("acceptMemberWaiverAction(currentVersionId)");
  });

  it("current/already-accepted state is unchanged — no review gate applies once status === 'current'", () => {
    const currentBlock = extractFunctionBody(s, 'if (status === "current") {');
    expect(currentBlock).not.toMatch(/reviewed|Review Waiver PDF/);
    expect(currentBlock).toContain("Accepted");
  });

  it("13. legacy text (isPdfBacked=false) behavior is unchanged — the review panel/checkbox render only inside {isPdfBacked && (...)}, so legacy Accept is gated only on isPending", () => {
    const gateIdx = s.indexOf("{isPdfBacked && (");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(s).toContain('disabled={isPending || (isPdfBacked && !agreed)}');
  });

  it("no Version N wording anywhere in this component", () => {
    expect(s).not.toMatch(/>\s*Version \{/);
    expect(s).not.toMatch(/>\s*Version \d/);
  });

  it("signed URL/view authorization is unchanged — still calls getMemberWaiverPdfViewUrlAction() with no parameters, exactly as 43B-3B established", () => {
    expect(s).toContain("await getMemberWaiverPdfViewUrlAction();");
    const memberActions = readSource(MEMBER_ACTIONS_PATH);
    expect(memberActions).toContain("export async function getMemberWaiverPdfViewUrlAction(): Promise<{");
    expect(memberActions).toContain('supabase.rpc("get_my_member_waiver_status")');
  });

  it("accept_member_waiver / acceptMemberWaiverAction wrapper is unchanged", () => {
    const memberActions = readSource(MEMBER_ACTIONS_PATH);
    expect(memberActions).toContain('supabase.rpc("accept_member_waiver", {');
    expect(memberActions).toContain("p_waiver_version_id: waiverVersionId,");
  });

  it("no database/API 'view evidence' write exists — the client never calls a record/log/audit-style action for the open itself", () => {
    expect(codeOnly).not.toMatch(/record.*view|log.*view|audit.*view|markReviewed(?!Action)|reviewEvidence/i);
    const memberActions = readSource(MEMBER_ACTIONS_PATH);
    const viewFn = memberActions.slice(
      memberActions.indexOf("export async function getMemberWaiverPdfViewUrlAction("),
      memberActions.length
    );
    expect(viewFn).not.toMatch(/insert into|\.insert\(|\.rpc\(\s*["'](?!get_my_member_waiver_status)/);
  });

  it("14. no migration was created for this checkpoint", () => {
    const files = readdirSync(join(process.cwd(), "supabase/migrations"));
    const beyond = files.filter((f) => {
      const match = f.match(/^(\d+)_/);
      return match !== null && Number(match[1]) > 196;
    });
    expect(beyond).toEqual([]);
  });

  it("15. 0196 remains untouched", () => {
    const migrationSql = readSource(MIGRATION_0196_PATH);
    expect(migrationSql).toContain("create table public.waiver_document_files");
    expect(migrationSql).toContain("create or replace function public.publish_waiver_pdf_version(");
  });

  it("uses sessionStorage exclusively — never localStorage in code (the header comment's own prose mention of 'never localStorage' is expected and excluded)", () => {
    expect(s).toContain("sessionStorage.getItem(");
    expect(s).toContain("sessionStorage.setItem(");
    expect(codeOnly).not.toMatch(/localStorage/);
  });

  it("copy is restrained — 'Waiver opened', never claims reading/completion in actual rendered JSX text (the header comment's own prose listing forbidden phrasing as examples is expected and excluded)", () => {
    expect(s).toContain("Waiver opened");
    expect(codeOnly).not.toMatch(/waiver read|read confirm|reviewed completely|reading confirmed/i);
  });

  it("helper copy explains the disabled checkbox and the pre-review state", () => {
    expect(s).toContain("Open the waiver before agreeing.");
    expect(s).toContain("Open the waiver above to enable this.");
  });

  it("sequential hierarchy copy: '1. Review the waiver' then '2. Agree'", () => {
    const reviewIdx = s.indexOf("1. Review the waiver");
    const agreeIdx = s.indexOf("2. Agree");
    expect(reviewIdx).toBeGreaterThan(-1);
    expect(agreeIdx).toBeGreaterThan(reviewIdx);
  });

  it("sessionStorage read/write both fail closed (try/catch) rather than throwing, so an unavailable storage environment never breaks the live component session", () => {
    const readFn = s.slice(s.indexOf("function readReviewedFromSession("), s.indexOf("\n}", s.indexOf("function readReviewedFromSession(")) + 2);
    const writeFn = s.slice(s.indexOf("function writeReviewedToSession("), s.indexOf("\n}", s.indexOf("function writeReviewedToSession(")) + 2);
    expect(readFn).toContain("try {");
    expect(readFn).toContain("catch {");
    expect(writeFn).toContain("try {");
    expect(writeFn).toContain("catch {");
  });

  it("the PDF-open button is a native <button> (keyboard-activatable), not a mouse-only handler on a non-interactive element", () => {
    const onClickIdx = s.indexOf("onClick={handleViewPdf}");
    const buttonTagIdx = s.lastIndexOf("<button", onClickIdx);
    expect(onClickIdx).toBeGreaterThan(-1);
    expect(buttonTagIdx).toBeGreaterThan(-1);
    const buttonBlock = s.slice(buttonTagIdx, s.indexOf("Review Waiver PDF", onClickIdx));
    expect(buttonBlock).toContain("<button");
    expect(buttonBlock).toContain('onClick={handleViewPdf}');
  });

  it("pdfWindow.opener is cleared, mirroring rel=noopener for a direct link click", () => {
    expect(handleViewPdfFn).toContain("pdfWindow.opener = null;");
  });
});
