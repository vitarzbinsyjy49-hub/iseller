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
      // Единая шкала радиусов (v5.2.8): field → card → xl2 → hero. Без случайных значений.
      borderRadius: {
        field: "0.875rem", // 14px — инпуты, кнопки, чипы
        card: "1rem",      // 16px — вторичные панели / поиск
        xl2: "1.25rem",    // 20px — карточки товара
        hero: "1.75rem",   // 28px — hero, промо-карточки
      },
      // Мягкие тени (v5.2.8): лёгкая глубина, без тяжёлых тёмных пятен.
      boxShadow: {
        soft: "0 1px 2px rgba(16,24,40,0.04), 0 2px 8px rgba(16,24,40,0.05)",
        card: "0 1px 2px rgba(16,24,40,0.04), 0 6px 16px -6px rgba(16,24,40,0.10)",
        float: "0 10px 30px -12px rgba(16,24,40,0.22)",
        sheet: "0 -8px 30px rgba(16,24,40,0.12)",
      },
      transitionTimingFunction: {
        premium: "cubic-bezier(0.22, 1, 0.36, 1)", // ease-out-quint — мягкое замедление
      },
    },
  },
  plugins: [],
};
