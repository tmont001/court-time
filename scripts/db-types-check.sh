#!/usr/bin/env bash
# Phase 45C1 — verifies src/lib/db/database.types.ts (committed, generated,
# never hand-edited) has not drifted from the live schema. Generates a fresh
# copy to a private temp file, diffs it against the committed file, and exits
# non-zero on any difference. NEVER writes to database.types.ts itself — use
# `pnpm db:types:generate` to intentionally update it.
#
# Portable macOS/Linux bash. No new package dependency: uses `pnpm dlx` to
# fetch the pinned Supabase CLI version on demand, exactly like
# db:types:generate.

set -euo pipefail

# Keep this in sync with package.json's db:types:generate — both must use the
# identical pinned CLI version so `check` and `generate` can never disagree
# about output shape due to a version drift between the two commands.
SUPABASE_CLI_VERSION="2.118.0"

COMMITTED_FILE="src/lib/db/database.types.ts"

if [ -z "${SUPABASE_PROJECT_REF:-}" ]; then
  echo "db:types:check: SUPABASE_PROJECT_REF is not set." >&2
  echo "Set it to your Supabase project ref (the subdomain in its dashboard URL) and ensure you are logged in via: pnpm dlx supabase@${SUPABASE_CLI_VERSION} login" >&2
  exit 1
fi

if [ ! -f "$COMMITTED_FILE" ]; then
  echo "db:types:check: $COMMITTED_FILE does not exist. Run 'pnpm db:types:generate' first." >&2
  exit 1
fi

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

if ! pnpm dlx "supabase@${SUPABASE_CLI_VERSION}" gen types typescript \
  --project-id "$SUPABASE_PROJECT_REF" \
  --schema public \
  > "$TMP_FILE"; then
  echo "db:types:check: generation failed — see the CLI's own error above. No comparison was made; $COMMITTED_FILE is unchanged." >&2
  exit 1
fi

if [ ! -s "$TMP_FILE" ]; then
  echo "db:types:check: generation produced an empty file — refusing to compare. $COMMITTED_FILE is unchanged." >&2
  exit 1
fi

if diff -q "$COMMITTED_FILE" "$TMP_FILE" > /dev/null; then
  echo "db:types:check: OK — $COMMITTED_FILE matches the live schema."
  exit 0
else
  echo "db:types:check: DRIFT DETECTED — $COMMITTED_FILE no longer matches the live schema." >&2
  echo "Diff (committed -> live):" >&2
  diff "$COMMITTED_FILE" "$TMP_FILE" >&2 || true
  echo "" >&2
  echo "Run 'pnpm db:types:generate' to update $COMMITTED_FILE, then review the diff before committing." >&2
  exit 1
fi
