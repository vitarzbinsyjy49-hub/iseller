import type { ReactElement } from "react";
import { Link, useLocation } from "react-router-dom";

/** Нижняя навигация: 5 вкладок, SVG-иконки, активная — Telegram blue.
 *  Сознательно НЕ используем NavLink: обычный Link + useLocation дают тот же
 *  active-state без NavLinkWithRef (у NavLink были крэши hasValidRef при
 *  расхождении версий react-router-dom/React в чужих окружениях). */

type Item = { to: string; label: string; icon: (active: boolean) => ReactElement };

const stroke = (active: boolean) => ({
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: active ? 2.2 : 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

const items: Item[] = [
  {
    to: "/", label: "Главная",
    icon: (a) => (
      <svg viewBox="0 0 24 24" className="h-6 w-6" {...stroke(a)}>
        <path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" />
      </svg>
    ),
  },
  {
    to: "/catalog", label: "Каталог",
    icon: (a) => (
      <svg viewBox="0 0 24 24" className="h-6 w-6" {...stroke(a)}>
        <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
        <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
      </svg>
    ),
  },
  {
    to: "/ai", label: "AI",
    icon: (a) => (
      <svg viewBox="0 0 24 24" className="h-6 w-6" {...stroke(a)}>
        <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
        <circle cx="12" cy="12" r="4" />
      </svg>
    ),
  },
  {
    to: "/requests", label: "Заявки",
    icon: (a) => (
      <svg viewBox="0 0 24 24" className="h-6 w-6" {...stroke(a)}>
        <rect x="4.5" y="3.5" width="15" height="17" rx="2.5" />
        <path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4.5" />
      </svg>
    ),
  },
  {
    to: "/profile", label: "Профиль",
    icon: (a) => (
      <svg viewBox="0 0 24 24" className="h-6 w-6" {...stroke(a)}>
        <circle cx="12" cy="8" r="3.6" /><path d="M4.8 20c1.3-3.2 4-4.8 7.2-4.8s5.9 1.6 7.2 4.8" />
      </svg>
    ),
  },
];

export default function BottomNav() {
  const { pathname } = useLocation();

  return (
    // lg:hidden — на desktop навигация в DesktopHeader, мобильный bottom nav скрыт
    // js-bottom-nav: при открытой клавиатуре скрывается через html.kb-open (index.css)
    <nav className="js-bottom-nav safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/90 backdrop-blur-lg lg:hidden">
      <div className="mx-auto flex max-w-md justify-around py-1.5">
        {items.map((item) => {
          const isActive = item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
          return (
            <Link
              key={item.to}
              to={item.to}
              aria-current={isActive ? "page" : undefined}
              className={`tap flex w-16 flex-col items-center gap-0.5 rounded-xl px-1 py-1 text-[11px] font-medium transition-colors ${
                isActive ? "text-accent" : "text-muted"
              }`}
            >
              {item.icon(isActive)}
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
