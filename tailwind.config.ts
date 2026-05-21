import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "media",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      // Event-type colors reserved for future use
      colors: {
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
