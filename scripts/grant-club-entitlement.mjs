// scripts/grant-club-entitlement.mjs
// Phase 33F3A: manual pilot entitlement provisioning.
//
// Server-only, local-only. This file is NOT part of the Next.js app — it
// lives outside src/, imports nothing from the app, and is never reachable
// as an HTTP route. It calls set_club_tier_for_operator (migration 0122)
// using the Supabase SERVICE ROLE key (SUPABASE_SECRET_KEY) — the only
// role that function is granted to. There is no platform-admin role, no
// support UI, and no user allowlist anywhere in application code; this
// script IS the access control — whoever can run it on a machine with the
// service-role key in its environment is trusted.
//
// This script performs exactly ONE privileged RPC call — it does not
// mutate club_subscriptions / club_entitlements directly in separate
// requests. set_club_tier_for_operator updates both tables inside a single
// database transaction, so commercial state and enforcement state can
// never disagree because a second network request failed after the first
// succeeded.
//
// Scope: sets the CURRENT commercial/entitlement state for a club. As of
// 33F3B (migration 0123), transitioning a club to staff_managed also
// atomically revokes every outstanding (unaccepted, unrevoked) Member-role
// invitation for that club — performed inside set_club_tier_for_operator
// itself, in the same transaction as the tier/entitlement write, not as a
// separate step by this script. Admin/Pro invitations, already-accepted
// invitations, and any existing Reservation/Event/Program/lesson data are
// never touched, by this script or by the RPC it calls.
//
// Usage:
//   node --env-file=.env.local scripts/grant-club-entitlement.mjs <club-id-or-slug> <staff_managed|connected>
//
// Examples:
//   node --env-file=.env.local scripts/grant-club-entitlement.mjs my-club connected
//   node --env-file=.env.local scripts/grant-club-entitlement.mjs 3f1b... staff_managed

import { createClient } from "@supabase/supabase-js";

const VALID_TIERS = ["staff_managed", "connected"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

const [, , clubArg, tierArg] = process.argv;

if (!clubArg || !tierArg) {
  fail(
    "Usage: node --env-file=.env.local scripts/grant-club-entitlement.mjs <club-id-or-slug> <staff_managed|connected>",
  );
}

if (!VALID_TIERS.includes(tierArg)) {
  fail(`Invalid tier "${tierArg}" — must be one of: ${VALID_TIERS.join(", ")}`);
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey  = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !serviceKey) {
  fail(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in the environment. " +
    "Run with --env-file=.env.local, or export both vars directly.",
  );
}

// Service-role client — the only role set_club_tier_for_operator is
// granted to. Never reused for anything beyond this one RPC call.
const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  // Resolution-only read, for a clear before/after report — the actual
  // tier transition itself happens entirely inside the RPC call below.
  const clubQuery = supabase.from("clubs").select("id, name, slug");
  const { data: club, error: clubError } = UUID_RE.test(clubArg)
    ? await clubQuery.eq("id", clubArg).maybeSingle()
    : await clubQuery.eq("slug", clubArg).maybeSingle();

  if (clubError) fail(`Failed to look up club: ${clubError.message}`);
  if (!club) fail(`No club found matching "${clubArg}" (tried as id, then as slug).`);

  console.log(`\nClub: ${club.name} (${club.slug}, id=${club.id})`);
  console.log(`Requesting tier: ${tierArg}`);

  const { data, error } = await supabase.rpc("set_club_tier_for_operator", {
    p_club_id: club.id,
    p_tier:    tierArg,
  });

  if (error) fail(`set_club_tier_for_operator failed: ${error.message}`);

  const result = Array.isArray(data) ? data[0] : data;
  if (!result) fail("set_club_tier_for_operator returned no result — treat as failed, verify manually.");

  console.log(`\n✔ ${club.name} is now ${result.tier} (status=${result.status}).`);
  if (tierArg === "staff_managed") {
    console.log(
      "Note: any outstanding (unaccepted) Member-role invitations for this club were revoked as part of this same call. Admin/Pro invitations and already-accepted invitations were left untouched.",
    );
  }
  console.log("");
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
