import { useState, type ReactElement } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/auth";
import { usePublicConfig } from "../lib/appConfig";
import { openExternalLink } from "../lib/telegram";

/** Desktop-шапка (>=1024px): логотип, навигация, поиск, действия.
 *  Видна только на lg+ — mobile UX (BottomNav + градиентный header) не трогаем.
 *  Никакой бизнес-логики: только навигация и переиспользуемые ссылки конфига. */

const NAV: { to: string; label: string }[] = [
  { to: "/", label: "Главная" },
  { to: "/catalog", label: "Каталог" },
  { to: "/ai", label: "AI" },
  { to: "/requests", label: "Заявки" },
  { to: "/profile", label: "Профиль" },
];

export default function DesktopHeader() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const config = usePublicConfig();
  const [q, setQ] = useState("");

  function goSearch() {
    const query = q.trim();
    navigate(query ? `/catalog?query=${encodeURIComponent(query)}` : "/catalog");
    setQ("");
  }

  return (
    <header className="hidden border-b border-border bg-surface/95 backdrop-blur-lg lg:block">
      <div className="mx-auto flex h-16 w-full max-w-[1320px] items-center gap-6 px-8">
        {/* Логотип */}
        <Link to="/" className="flex shrink-0 items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[#1a7fd4] to-[#6d5ae0] text-[13px] font-extrabold tracking-tight text-white">
            AI
          </span>
          <span className="text-[17px] font-bold tracking-tight">AI Seller</span>
        </Link>

        {/* Навигация */}
        <nav className="flex items-center gap-1">
          {NAV.map((item) => {
            const active = item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                aria-current={active ? "page" : undefined}
                className={`rounded-xl px-3.5 py-2 text-sm font-medium transition-colors ${
                  active ? "bg-accent/10 text-accent" : "text-muted hover:bg-mutedbg hover:text-text"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Поиск */}
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl2 bg-mutedbg px-4 focus-within:ring-2 focus-within:ring-accent/40">
          <SearchIcon />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && goSearch()}
            placeholder="Найти iPhone, MacBook, PlayStation…"
            className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none placeholder:text-muted"
          />
        </div>

        {/* Действия справа */}
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => navigate("/ai")}
            className="rounded-xl2 bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accentdark"
          >
            ✨ AI-подбор
          </button>
          <button
            onClick={() => { if (!openExternalLink(config.manager_retail_url)) navigate("/ai"); }}
            className="rounded-xl2 border border-border bg-surface px-4 py-2.5 text-sm font-medium text-text transition-colors hover:bg-mutedbg"
          >
            💬 Менеджер
          </button>
          <button
            onClick={() => navigate("/profile")}
            aria-label="Профиль"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/10 text-sm font-bold text-accent transition-colors hover:bg-accent/20"
          >
            {user?.first_name?.[0]?.toUpperCase() ?? "👤"}
          </button>
        </div>
      </div>
    </header>
  );
}

function SearchIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
    </svg>
  );
}
