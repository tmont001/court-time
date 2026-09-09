// actionButtonStyles.ts
// Phase 27C.3 originally defined this vocabulary scoped to /events. Phase
// 34B promoted it to src/lib/actionButtonStyles.ts so Admin pricing
// surfaces outside /events (courts, settings) could reuse the same
// compact action-button treatment instead of inventing a second one. This
// file now just re-exports from there — every existing import path in
// /events keeps working unchanged.
//
// Phase 34G-D1 — re-export source updated to src/components/styles/
// actionButtonStyles.ts (relocated off src/lib/, which Tailwind's content
// scan never covered — see that file's own header comment for why).

export {
  ACTION_BUTTON_PRIMARY,
  ACTION_BUTTON_PRIMARY_COMPACT,
  ACTION_BUTTON_PRIMARY_COMPACT_TOUCH,
  ACTION_BUTTON_SECONDARY,
  ACTION_BUTTON_SECONDARY_COMPACT,
  ACTION_BUTTON_DESTRUCTIVE,
  ACTION_BUTTON_DESTRUCTIVE_COMPACT,
  ACTION_BUTTON_POSITIVE_COMPACT,
  ACTION_BUTTON_INFO_COMPACT,
} from "@/components/styles/actionButtonStyles";
