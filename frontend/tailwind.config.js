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
        danger: "rgb(var(--app-danger) / <alpha-value>)",
        dangerink: "rgb(var(--app-danger-ink) / <alpha-value>)",
        dangerbg: "rgb(var(--app-danger-bg) / <alpha-value>)",
      },
      // Шкала радиусов (v5.6.0): field → card → xl2 → hero.
      //
      // field опущен с 14px до 12px не ради двух пикселей, а ради РАЗНИЦЫ между
      // уровнями. При 14/16/20/28 первые два отличались на 2px — глаз читал их
      // как одну форму, и шкала переставала быть иерархией: всё выглядело
      // одинаково скруглённым. Теперь 12/16/20/28, и элемент управления
      // (12) заметно отличается от карточки товара (20).
      borderRadius: {
        field: "0.75rem",  // 12px — инпуты, кнопки, чипы
        card: "1rem",      // 16px — вторичные панели / поиск
        xl2: "1.25rem",    // 20px — карточки товара
        hero: "1.75rem",   // 28px — hero, промо-карточки
      },
      // Тени (v5.6.0). Ступеней четыре, и каждая обязана отвечать за свой
      // уровень: лежит в потоке (soft) → приподнято (card) → плавает над
      // контентом (float) → перекрывает экран (sheet).
      //
      // soft и card раньше отличались почти неразличимо, и обе стояли на
      // элементах, которые никуда не всплывают. Тень на том, что лежит в
      // потоке, — это не глубина, а грязь: она даёт вес там, где веса быть не
      // должно. Поэтому soft ужат до одной контактной линии, а card облегчён.
      // Разделять поверхности должны пространство и контраст, а не тень.
      boxShadow: {
        soft: "0 1px 2px rgba(16,24,40,0.05)",
        card: "0 1px 2px rgba(16,24,40,0.04), 0 4px 12px -6px rgba(16,24,40,0.08)",
        float: "0 10px 30px -12px rgba(16,24,40,0.22)",
        sheet: "0 -8px 30px rgba(16,24,40,0.12)",
      },
      // Типографическая шкала (v5.6.0). Раньше размеры жили россыпью прямо в
      // классах — text-[17px], text-[13px], text-[12px], text-[11px], — и в
      // одной карточке товара их оказывалось четыре штуки. Иерархию задаёт не
      // количество размеров, а различимость соседних ступеней, поэтому шкала
      // короткая: шесть ступеней на всё приложение.
      //
      // Интерлиньяж задан вместе с размером и отдельно его переопределять не
      // нужно — именно рассогласование размера и интерлиньяжа делает плотный
      // текст рыхлым.
      fontSize: {
        caption: ["0.75rem", { lineHeight: "1rem" }],      // 12/16 — служебное
        footnote: ["0.8125rem", { lineHeight: "1.125rem" }], // 13/18 — вторичное
        body: ["0.9375rem", { lineHeight: "1.25rem" }],    // 15/20 — основной текст
        title: ["1.0625rem", { lineHeight: "1.375rem" }],  // 17/22 — цена, заголовок блока
        h2: ["1.25rem", { lineHeight: "1.625rem" }],       // 20/26 — раздел
        h1: ["1.625rem", { lineHeight: "2rem" }],          // 26/32 — экран
      },
      transitionTimingFunction: {
        premium: "cubic-bezier(0.22, 1, 0.36, 1)", // ease-out-quint — мягкое замедление
      },
    },
  },
  plugins: [],
};
