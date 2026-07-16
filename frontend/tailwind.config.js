/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // wide desktop >= 1440px (mobile <640 / tablet sm..lg / desktop lg+ — стандартные)
      screens: { wide: "1440px" },
      colors: {
        bg: "var(--app-bg)",
        surface: "var(--app-surface)",
        mutedbg: "var(--app-muted-bg)",
        border: "var(--app-border)",
        text: "var(--app-text)",
        muted: "var(--app-sub)",
        accent: "var(--app-accent)",
        accentdark: "var(--app-accent-dark)",
        green: "var(--app-green)",
        orange: "var(--app-orange)",
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
