// Phase 43B-3B — shared, non-executable constants for the PDF waiver
// upload/view flow. Kept out of waiverPdfActions.ts deliberately: a
// Server Action file (top-of-file server directive) may only export
// async functions, so a plain string/number constant needed by more than
// one module (this one, plus src/lib/waivers/pdfViewUrl.ts) has to live
// here instead.

export const WAIVER_PDF_BUCKET = "waiver-documents";
export const WAIVER_PDF_MAX_BYTES = 10 * 1024 * 1024; // 10 MB — matches the bucket's own configured limit.
