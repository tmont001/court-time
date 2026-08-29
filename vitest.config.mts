import { defineConfig } from "vitest/config";

// Phase 34A2: minimal pure-TypeScript unit test baseline. No jsdom, no
// component/browser testing, no Supabase — see src/lib/auth/roles.test.ts
// for the only suite this currently runs.
//
// Phase 34E-E: added the SAME "@/*" -> "./src/*" alias tsconfig.json
// already declares, so a pure-TypeScript module that imports another
// shared module via "@/..." (e.g. src/lib/payments.ts importing
// formatMoney from "@/lib/money") can be imported directly by a test —
// genuine behavioral coverage against the real exported function, not a
// parallel reimplementation or source-inspection string-matching. No new
// dependency, no jsdom, no change to what this baseline tests (still
// plain Node, still *.test.ts only).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
});
