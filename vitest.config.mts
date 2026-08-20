import { defineConfig } from "vitest/config";

// Phase 34A2: minimal pure-TypeScript unit test baseline. No jsdom, no
// component/browser testing, no Supabase — see src/lib/auth/roles.test.ts
// for the only suite this currently runs.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
