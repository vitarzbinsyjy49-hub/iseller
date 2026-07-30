import { useEffect, useState, type ReactElement } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useAuthStore } from "../store/auth";
import { usePublicConfig } from "../lib/appConfig";
import { openExternalLink } from "../lib/telegram";
import { track } from "../lib/analytics";
import { pushSearchQuery } from "../lib/searchHistory";
import { ProfileChip } from "./ProfileChip";
import { CartGlyph } from "./CartBar";
import { useCart } from "../lib/cart";
import SearchPanel from "./SearchPanel";
import { SegmentedToggle } from "./SegmentedToggle";
import { searchRoute, type SearchMode } from "../lib/searchMode";

/** Desktop-шапка (>=1024px): логотип, навигация, поиск, действия.
 *  Видна только на lg+ — mobile UX (BottomNav + градиентный header) не трогаем.
 *  Единственный поиск на desktop: тот же URL-параметр `query`, что и у
 *  Catalog (чей собственный инпут на desktop скрыт) — не два расходящихся
 *  состояния поиска, а одно, отражённое в адресной строке.
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
  const [params, setParams] = useSearchParams();
  const user = useAuthStore((s) => s.user);
  const config = usePublicConfig();
  const cart = useCart();
  const onCatalog = pathname.startsWith("/catalog");
  const urlQuery = onCatalog ? (params.get("query") ?? "") : "";
  const [q, setQ] = useState(urlQuery);
  // Компактный popover при фокусе с пустым запросом: история + быстрые сценарии
  // + «Спросить AI». Live-результаты на desktop рисует сам каталог (как раньше).
  const [panelOpen, setPanelOpen] = useState(false);
  // Режим строки поиска: каталог или AI-подбор. Не сохраняется между визитами.
  const [mode, setMode] = useState<SearchMode>("catalog");

  // Подхватить внешний query (переход на каталог с другим query) или сброс
  // при уходе со страницы каталога — шапка не должна хранить «чужой» текст.
  useEffect(() => { setQ(urlQuery); }, [urlQuery, onCatalog]);

  // Live-поиск с debounce 250ms — единственная точка входа в поиск на desktop.
  //
  // В режиме AI живой поиск выключен: он свойство каталожного режима. Иначе
  // набранный запрос уезжал бы в /catalog через 250мс после ввода — раньше,
  // чем пользователь нажмёт Enter, и до AI-подбора было бы не добраться.
  useEffect(() => {
    if (mode === "ai") return;
    const t = setTimeout(() => {
      const trimmed = q.trim();
      if (onCatalog) {
        if (trimmed === urlQuery) return;
        const next = new URLSearchParams(params);
        if (trimmed) next.set("query", trimmed); else next.delete("query");
        setParams(next, { replace: true });
      } else if (trimmed) {
        navigate(`/catalog?query=${encodeURIComponent(trimmed)}`);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    // relative z-50 обязателен: backdrop-blur создаёт на шапке собственный
    // контекст наложения, поэтому z-40 у выпадающей панели поиска действует
    // только ВНУТРИ шапки. Без z-index сама шапка (не позиционированная)
    // рисуется раньше контента <main>, и панель уходила под hero-баннеры.
    // 50 — ниже модалок (ScenarioSheet/LeadForm тоже z-50, но они в DOM позже
    // и потому остаются сверху) и ниже toast'ов (z-60).
    <header className="relative z-50 hidden border-b border-border bg-surface/95 backdrop-blur-lg lg:block">
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

        {/* Поиск — живой, с debounce, единственный на desktop. relative — под ним
            компактный popover с историей/сценариями при пустом фокусе; закрытие:
            Escape, клик мимо (blur с contains-проверкой), навигация. */}
        {/* min-w-[320px] обязателен. С `min-w-0` строка поиска сжималась до
            88px, и в поле оставалось 56px на текст: подсказка обрывалась на
            первом слове при любой ширине экрана, потому что контейнер шапки
            ограничен 1320px, а тумблер «Каталог / AI» внутри строки забирает
            143px. Минимум держит поле пригодным для ввода, а лишнее ужимается
            во второстепенных действиях справа. */}
        <div
          className="relative min-w-[420px] flex-1"
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPanelOpen(false);
          }}
        >
          <div className="flex min-w-0 items-center gap-2 rounded-xl2 bg-mutedbg px-4 focus-within:ring-2 focus-within:ring-accent/40">
            <SearchIcon />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onFocus={() => {
                if (!panelOpen) track("search_focused", { source: "desktop_header" });
                setPanelOpen(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") { setPanelOpen(false); e.currentTarget.blur(); }
                if (e.key === "Enter") {
                  const trimmed = q.trim();
                  if (trimmed.length >= 2) {
                    pushSearchQuery(trimmed);
                    track("search_query_submitted", {
                      query_length: trimmed.length, source: "desktop_enter", mode,
                    });
                    navigate(searchRoute(mode, trimmed));
                  }
                  setPanelOpen(false);
                }
              }}
              placeholder={mode === "ai" ? "Опишите, что нужно" : "Найти iPhone, MacBook…"}
              aria-label={mode === "ai" ? "AI-подбор" : "Поиск по каталогу"}
              aria-expanded={panelOpen && !q.trim()}
              className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none placeholder:text-muted"
            />
            {q && (
              <button onClick={() => setQ("")} aria-label="Очистить поиск" className="shrink-0 text-muted hover:text-text">
                ✕
              </button>
            )}
            <SegmentedToggle
              value={mode}
              onChange={(next) => {
                setMode(next);
                track("search_mode_switched", { mode: next, source: "desktop_header" });
              }}
              options={[
                { value: "catalog", label: "Каталог" },
                { value: "ai", label: "✨ AI" },
              ] as const}
              ariaLabel="Режим поиска"
            />
          </div>

          {panelOpen && !q.trim() && (
            <div
              onMouseDown={(e) => e.preventDefault()}
              className="fade-in absolute inset-x-0 top-full z-40 mt-2 w-full overflow-hidden rounded-xl2 border border-border bg-surface shadow-sheet"
            >
              <SearchPanel
                query=""
                withResults={false}
                onNavigate={(to) => { setPanelOpen(false); navigate(to); }}
                onPickQuery={(picked) => setQ(picked)}
              />
            </div>
          )}
        </div>

        {/* Действия справа */}
        <div className="flex shrink-0 items-center gap-2">
          {/* Корзина: постоянный вход. Плавающая панель показывается только с
              непустой корзиной, поэтому без этой кнопки пустой экран корзины на
              desktop был бы недостижим. */}
          <button
            onClick={() => { track("cart_open", { source: "desktop_header" }); navigate("/cart"); }}
            aria-label={cart.items_count > 0 ? `Корзина: ${cart.items_count}` : "Корзина"}
            className="relative flex h-[42px] w-[42px] items-center justify-center rounded-xl2 border border-border bg-surface text-text transition-colors hover:bg-mutedbg"
          >
            <CartGlyph className="h-5 w-5" />
            {cart.items_count > 0 && (
              <span className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-white">
                {cart.items_count}
              </span>
            )}
          </button>
          <button
            onClick={() => navigate("/ai")}
            title="AI-подбор"
            className="whitespace-nowrap rounded-xl2 bg-accent px-3.5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accentdark wide:px-4"
          >
            ✨ AI<span className="hidden wide:inline">-подбор</span>
          </button>
          {/* До 1440px подпись прячется, остаётся иконка: место нужнее строке
              поиска, а действие вторичное и продублировано на страницах. */}
          <button
            onClick={() => { if (!openExternalLink(config.manager_retail_url)) navigate("/ai"); }}
            title="Написать менеджеру"
            aria-label="Написать менеджеру"
            className="rounded-xl2 border border-border bg-surface px-3 py-2.5 text-sm font-medium text-text transition-colors hover:bg-mutedbg wide:px-4"
          >
            💬<span className="hidden wide:ml-1 wide:inline">Менеджер</span>
          </button>
          <ProfileChip user={user} variant="desktop" />
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
