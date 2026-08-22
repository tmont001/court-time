// actionButtonStyles.ts
// Phase 27C.3 originally defined this vocabulary scoped to /events. Phase
// 34B promoted it to src/lib/actionButtonStyles.ts so Admin pricing
// surfaces outside /events (courts, settings) could reuse the same
// compact action-button treatment instead of inventing a second one. This
// file now just re-exports from there — every existing import path in
// /events keeps working unchanged.

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
} from "@/lib/actionButtonStyles";
