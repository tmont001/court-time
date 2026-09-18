import "server-only";

// Phase 43B-4A hardening pass — the production import path for Guest
// waiver token generation/hashing (future Server Actions, Phase 43B-4B).
// guestWaiverToken.ts holds the actual pure crypto logic and is
// deliberately kept free of this guard so it stays directly testable
// under Vitest (see its own header comment for why). This file exists
// only to give real, server-side callers a hard, build-time-enforced
// guarantee against an accidental Client Component import — Next.js
// fails the build immediately if a Client Component ever imports this
// file, rather than relying on convention alone. No logic of its own: a
// pure re-export, nothing more.
export {
  generateGuestWaiverToken,
  hashGuestWaiverToken,
  isSyntacticallyValidGuestWaiverToken,
  isSyntacticallyValidGuestWaiverTokenHash,
} from "./guestWaiverToken";
