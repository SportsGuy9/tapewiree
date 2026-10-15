import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: "rgb(var(--surface) / <alpha-value>)",
        panel: "rgb(var(--panel) / <alpha-value>)",
        line: "rgb(var(--line) / <alpha-value>)",
        ink: "rgb(var(--ink) / <alpha-value>)",
        muted: "rgb(var(--muted) / <alpha-value>)",
        accent: "rgb(var(--accent) / <alpha-value>)",
        sev: {
          high: "rgb(var(--sev-high) / <alpha-value>)",
          review: "rgb(var(--sev-review) / <alpha-value>)",
          reviewtext: "rgb(var(--sev-review-text) / <alpha-value>)",
          pass: "rgb(var(--sev-pass) / <alpha-value>)",
          passtext: "rgb(var(--sev-pass-text) / <alpha-value>)",
          info: "rgb(var(--sev-info) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
