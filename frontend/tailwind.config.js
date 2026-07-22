/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // wide desktop >= 1440px (mobile <640 / tablet sm..lg / desktop lg+ — стандартные)
      screens: { wide: "1440px" },
      colors: {
        // Токены — RGB-каналы (index.css :root), поэтому alpha-модификатор
        // Tailwind работает: bg-surface → rgb(var(--app-surface) / 1) = сплошной,
        // bg-surface/90 → rgb(var(--app-surface) / 0.9). Раньше здесь был
        // "var(--app-surface)" (готовый hex) → /90 давал невалидный цвет и
        // прозрачный фон (навбар/хедер/чипы). Не менять на hex обратно.
        bg: "rgb(var(--app-bg) / <alpha-value>)",
        surface: "rgb(var(--app-surface) / <alpha-value>)",
        mutedbg: "rgb(var(--app-muted-bg) / <alpha-value>)",
        border: "rgb(var(--app-border) / <alpha-value>)",
        text: "rgb(var(--app-text) / <alpha-value>)",
        muted: "rgb(var(--app-sub) / <alpha-value>)",
        accent: "rgb(var(--app-accent) / <alpha-value>)",
        accentdark: "rgb(var(--app-accent-dark) / <alpha-value>)",
        green: "rgb(var(--app-green) / <alpha-value>)",
        orange: "rgb(var(--app-orange) / <alpha-value>)",
      },
      borderRadius: { xl2: "1.25rem" },
      boxShadow: {
        soft: "0 1px 3px rgba(17,24,39,0.05), 0 4px 14px rgba(17,24,39,0.05)",
        sheet: "0 -8px 30px rgba(17,24,39,0.12)",
      },
    },
  },
  plugins: [],
};
