import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      // Event-type colors reserved for future use
      colors: {
        accent: "var(--accent)",
        // Phase 34G-C3 — Court Time's own brand identity color, SEPARATE
        // from `accent` (the per-club theme color). Never redefined by any
        // .theme-* preset — see globals.css's own comment on --ct-brand.
        brand: "var(--ct-brand)",
        "brand-hover": "var(--ct-brand-hover)",
        "brand-tint": "var(--ct-brand-tint)",
        "event-lesson": "#3B7DD8",
        "event-clinic": "#2E9B5E",
        "event-social": "#E68433",
        "event-league": "#7B4FB5",
        "event-tournament": "#C44545",
      },
    },
  },
  plugins: [],
};

export default config;
