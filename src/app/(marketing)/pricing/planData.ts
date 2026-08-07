// Single source of truth for /pricing — both the plan cards and the
// comparison table read from this module so plan facts are never
// duplicated (and never allowed to drift) between the two presentations.

export interface CoreFeature {
  key: string;
  label: string;
}

// Every plan includes every one of these — there are no plan-specific
// technical restrictions in the product today. Reused verbatim by the
// comparison table (all three columns render as Included for each row).
export const CORE_FEATURES: CoreFeature[] = [
  { key: "courtScheduling", label: "Court scheduling" },
  { key: "eventsProgramsWaitlists", label: "Events, programs, and waitlists" },
  { key: "lessonsProWorkflows", label: "Lessons and Pro workflows" },
  { key: "memberDirectory", label: "Member directory" },
  { key: "invitationsCsvImport", label: "Invitations and CSV import" },
  { key: "reporting", label: "Reporting" },
  { key: "inAppNotifications", label: "In-app notifications" },
  { key: "emailNotifications", label: "Email notifications and announcements" },
  { key: "optionalSmsAlerts", label: "Optional transactional text alerts" },
  { key: "responsiveWebAccess", label: "Responsive web access" },
];

export type PlanId = "founding" | "starter" | "club";

export interface Plan {
  id: PlanId;
  name: string;
  isCurrent: boolean;
  badgeLabel: "Current offer" | "Planned";
  monthly: string;
  annual: string;
  annualNote: string;
  perMemberFee: string;
  intendedScale: string;
  onboarding: string;
  support: string;
  priceProtection: string;
  availabilityNote: string;
  ctaLabel: string;
  ctaHref: string;
  /** Founding-only fine print, rendered under its CTA. */
  extraNotes?: string[];
}

export const PLANS: Plan[] = [
  {
    id: "founding",
    name: "Founding Club",
    isCurrent: true,
    badgeLabel: "Current offer",
    monthly: "$149",
    annual: "$1,490",
    annualNote: "two months free",
    perMemberFee: "None",
    intendedScale: "Full current product access",
    onboarding: "Founder-led setup",
    support: "Direct founder support",
    priceProtection: "Protected for your first 12 months",
    availabilityNote: "Available now — first 10 clubs or until public launch, whichever comes first",
    ctaLabel: "Request a pilot",
    ctaHref: "/contact",
    extraNotes: [
      "No credit card required during the founding evaluation and onboarding period",
      "Billing terms are agreed before any charges begin",
    ],
  },
  {
    id: "starter",
    name: "Starter",
    isCurrent: false,
    badgeLabel: "Planned",
    monthly: "$249",
    annual: "$2,490",
    annualNote: "two months free",
    perMemberFee: "None",
    intendedScale: "Roughly 5 courts and 100 members (intended packaging)",
    onboarding: "Guided onboarding — planned",
    support: "Standard support — planned",
    priceProtection: "—",
    availabilityNote: "Not currently available for purchase",
    ctaLabel: "Discuss your club",
    ctaHref: "/contact",
  },
  {
    id: "club",
    name: "Club",
    isCurrent: false,
    badgeLabel: "Planned",
    monthly: "$399",
    annual: "$3,990",
    annualNote: "two months free",
    perMemberFee: "None",
    intendedScale: "Roughly 12 courts and 300 members (intended packaging)",
    onboarding: "Priority onboarding — planned",
    support: "Priority support — planned",
    priceProtection: "—",
    availabilityNote: "Not currently available for purchase",
    ctaLabel: "Discuss your club",
    ctaHref: "/contact",
  },
];
