// Phase 34G-C3 — Court Time brand-green primary CTA color treatment,
// shared across every marketing "primary action" button (Request a pilot,
// contact-form submit) so the brand color and its hover/focus states stay
// in exactly one place. Deliberately COLOR-ONLY — sizing/spacing/text-size
// varies per call site (hero buttons vs. compact nav button) and stays
// local at each usage.
//
// The Founding Club offer's own CTA (FoundingOfferBanner.tsx) is
// deliberately EXCLUDED from this treatment and stays neutral/inverted-
// white, matching the rest of that promotional banner — Founding Club is
// a temporary promo, not the permanent Court Time identity, and its own
// CTA must not become the one green element inside an otherwise-neutral
// card.
//
// Lives under src/app/(marketing)/ (not src/lib/) so Tailwind's existing
// content-scan glob for "./src/app/**" picks up this file's class-string
// constant without widening Tailwind's content scope to all of src/lib —
// see tailwind.config.ts's own content array; that widening was tried and
// reverted in a correction pass (it activated unrelated, previously-latent
// Tailwind classes in src/lib/actionButtonStyles.ts as a side effect,
// outside this checkpoint's narrow brand-identity scope — tracked instead
// as a deferred 34G-D production-readiness finding).
export const MARKETING_CTA_PRIMARY_COLOR =
  "bg-brand text-white hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand";
