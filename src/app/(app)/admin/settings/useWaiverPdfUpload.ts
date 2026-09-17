"use client";

// Phase 43B-3B — shared upload orchestration for the Member/Guest PDF
// waiver flow. Deliberately a plain hook (no JSX, no copy, no audience-
// specific presentation) shared between MemberWaiverSection and
// GuestWaiverSection, unlike those two components' own established
// full-duplication precedent (43B-2B): this sequencing — validate,
// authorize, direct-upload to the signed URL, finalize, surface errors —
// is security-relevant and identical for both audiences by design (same
// RPC, same bucket, same validation rules). Duplicating it 1:1 would only
// risk the two copies drifting apart on the security-relevant bits; each
// component still owns 100% of its own JSX, copy, and props independently.
//
// Never sends PDF bytes through a Server Action — the actual file upload
// (uploadToSignedUrl) goes directly from this browser client to Supabase
// Storage, using the short-lived signed token minted server-side.

import { useCallback, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { authorizeWaiverPdfUploadAction, finalizeWaiverPdfUploadAction } from "./waiverPdfActions";
import { WAIVER_PDF_BUCKET, WAIVER_PDF_MAX_BYTES } from "@/lib/waivers/constants";

export type WaiverPdfUploadState =
  | "idle"
  | "authorizing"
  | "uploading"
  | "finalizing"
  | "success"
  | "error";

interface UseWaiverPdfUploadResult {
  state: WaiverPdfUploadState;
  error: string | null;
  upload: (file: File) => void;
  reset: () => void;
}

// Browser-side UX validation only — never authoritative. The finalize
// Server Action independently re-verifies the actual downloaded bytes
// (size, MIME via magic header, SHA-256) regardless of what this check
// found.
export function validateWaiverPdfFile(file: File | null | undefined): string | null {
  if (!file) return "Please choose a PDF file.";
  if (file.type !== "application/pdf") return "Only PDF files are allowed.";
  if (file.size <= 0) return "That file appears to be empty.";
  if (file.size > WAIVER_PDF_MAX_BYTES) return "The PDF must be 10 MB or smaller.";
  return null;
}

export function useWaiverPdfUpload(
  audience: "member" | "guest",
  onSuccess: () => void
): UseWaiverPdfUploadResult {
  const [state, setState] = useState<WaiverPdfUploadState>("idle");
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setState("idle");
    setError(null);
  }, []);

  const upload = useCallback(
    (file: File) => {
      const validationError = validateWaiverPdfFile(file);
      if (validationError) {
        setError(validationError);
        setState("error");
        return;
      }
      setError(null);

      void (async () => {
        setState("authorizing");
        const authResult = await authorizeWaiverPdfUploadAction(audience, file.name, file.size);
        if (authResult.error || !authResult.versionId || !authResult.path || !authResult.token) {
          setError(authResult.error ?? "Could not authorize the upload.");
          setState("error");
          return;
        }

        setState("uploading");
        const supabase = createClient();
        const { error: uploadError } = await supabase.storage
          .from(authResult.bucket ?? WAIVER_PDF_BUCKET)
          .uploadToSignedUrl(authResult.path, authResult.token, file, {
            contentType: "application/pdf",
          });

        if (uploadError) {
          setError("Upload failed. Please try again.");
          setState("error");
          return;
        }

        setState("finalizing");
        const finalizeResult = await finalizeWaiverPdfUploadAction(
          audience,
          authResult.versionId,
          file.name
        );
        if (finalizeResult.error) {
          setError(finalizeResult.error);
          setState("error");
          return;
        }

        setState("success");
        onSuccess();
      })();
    },
    [audience, onSuccess]
  );

  return { state, error, upload, reset };
}
