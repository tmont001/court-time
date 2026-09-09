// Single source of truth for /pricing — the standard-tier cards, the
// Founding Club offer banner, and the comparison table all read from this
// module so plan facts are never duplicated (and never allowed to drift)
// between the three presentations.
//
// Phase 34G-A2 — locked commercial model:
//   Staff-Managed and Connected are the two STANDARD, purchasable tiers.
//   Founding Club is a temporary promotional OFFER on top of Connected +
//   Court Time Payments, priced at the Staff-Managed rate — it is NOT a
//   third tier and has no database entitlement of its own. TierId below
//   intentionally mirrors the actual club_subscriptions.tier CHECK
//   constraint ('staff_managed' | 'connected', supabase/migrations/
//   0122_entitlement_foundation.sql) — there is no 'founding' value there.

export type TierId = "staff_managed" | "connected";

export interface StandardTier {
  id: TierId;
  name: string;
  tagline: string;
  monthly: string;
  annual: string;
  annualNote: string;
  perMemberFee: string;
  ctaLabel: string;
  ctaHref: string;
}

// $149/mo Staff-Managed, $199/mo Connected — annual = 10x monthly (two
// months free) for both, matching Founding Club's own established annual
// convention. No per-member fee on either tier.
export const STANDARD_TIERS: StandardTier[] = [
  {
    id: "staff_managed",
    name: "Staff-Managed",
    tagline: "Court Time run by your staff and front desk. Member accounts and self-service are not required.",
    monthly: "$149",
    annual: "$1,490",
    annualNote: "two months free",
    perMemberFee: "None",
    ctaLabel: "Discuss your club",
    ctaHref: "/contact",
  },
  {
    id: "connected",
    name: "Connected",
    tagline: "Everything in Staff-Managed, plus Member self-service.",
    monthly: "$199",
    annual: "$1,990",
    annualNote: "two months free",
    perMemberFee: "None",
    ctaLabel: "Discuss your club",
    ctaHref: "/contact",
  },
];

export interface FoundingOffer {
  name: string;
  badgeLabel: string;
  monthly: string;
  annual: string;
  annualNote: string;
  includesLabel: string;
  priceProtection: string;
  onboarding: string;
  support: string;
  availabilityNote: string;
  ctaLabel: string;
  ctaHref: string;
  extraNotes: string[];
}

// A promotional package, not a tier: Connected + Court Time Payments,
// priced at the Staff-Managed rate for the founding cohort. No separate
// 'founding' database entitlement exists — provisioning a Founding Club is
// exactly "grant Connected" (scripts/grant-club-entitlement.mjs) plus
// whatever billing terms are agreed, per that script's own header comment.
export const FOUNDING_OFFER: FoundingOffer = {
  name: "Founding Club",
  badgeLabel: "Current offer",
  monthly: "$149",
  annual: "$1,490",
  annualNote: "two months free",
  includesLabel: "Connected + Court Time Payments + full current product access",
  priceProtection: "Protected for your first 12 months",
  onboarding: "Founder-led setup",
  support: "Direct founder support",
  availabilityNote: "Available now — first 10 clubs or until public launch, whichever comes first",
  ctaLabel: "Request a pilot",
  ctaHref: "/contact",
  extraNotes: [
    "No credit card required during the founding evaluation and onboarding period",
    "Billing terms are agreed before any charges begin",
  ],
};

export interface FeatureRow {
  key: string;
  label: string;
}

// Included on BOTH Staff-Managed and Connected — the complete existing
// staff/operational surface. No Member self-service claim appears here.
export const STAFF_MANAGED_FEATURES: FeatureRow[] = [
  { key: "courtScheduling", label: "Court scheduling" },
  { key: "staffReservations", label: "Staff-created reservations" },
  { key: "eventsProgramsLessons", label: "Events, Programs, and Lessons" },
  { key: "proWorkflows", label: "Pro workflows" },
  { key: "rosterDirectory", label: "Roster and member directory" },
  { key: "invitationsImport", label: "Staff invitations and CSV import" },
  { key: "reporting", label: "Reporting" },
  { key: "notifications", label: "In-app, email, and optional text notifications" },
  { key: "pricingRates", label: "Pricing and rates" },
  { key: "manualPaymentTracking", label: "Manual payment tracking / Record Payment" },
  { key: "responsiveWebAccess", label: "Responsive web access" },
];

// Included ONLY on Connected — added on top of every Staff-Managed feature
// above. Each line maps to an executable member_self_service-gated
// capability (0123) — never an invented one. "New Member self-service
// accounts" (not "Member accounts" categorically): Staff-Managed does not
// require Member accounts, but an existing Member account is preserved
// for continuity if a club is ever downgraded from Connected — the gated
// capability is specifically inviting/self-serving NEW ones (0123's own
// create_club_invite/add_roster_member_and_invite guards).
export const CONNECTED_FEATURES: FeatureRow[] = [
  { key: "memberAccounts", label: "New Member self-service accounts" },
  { key: "memberCourtBooking", label: "Member court self-booking" },
  { key: "memberEventSignup", label: "Member Event signup" },
  { key: "memberWaitlists", label: "Member Event waitlists and offers" },
  { key: "memberProgramEnrollment", label: "Member Program self-enrollment" },
  { key: "memberLessonRequests", label: "Member Lesson requests" },
  { key: "memberSchedule", label: "Member self-service schedule and activity" },
  { key: "memberCancellation", label: "Member cancellation and continuity workflows where allowed" },
];
