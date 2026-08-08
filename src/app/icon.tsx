import { ImageResponse } from "next/og";

// No Court Time brand/logo asset exists in this repo yet — rather than ship
// with no favicon at all, generate a minimal text monogram in code (no
// external image, no design tooling). Replace with a real brand asset when
// one exists; this is a deliberate placeholder, not the final mark.
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#111827",
          color: "#ffffff",
          fontSize: 16,
          fontWeight: 700,
          fontFamily: "sans-serif",
          borderRadius: 6,
        }}
      >
        CT
      </div>
    ),
    { ...size }
  );
}
