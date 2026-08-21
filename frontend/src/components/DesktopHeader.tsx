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
import { aiSearchRoute, catalogSearchRoute } from "../lib/searchRoutes";
import { preloadRoute } from "../lib/routePreload";
import { BrandWordmark } from "./BrandMark";
import { Icon } from "./icons";
import { enterRefCallback } from "../lib/useEnter";

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

  // Подхватить внешний query (переход на каталог с другим query) или сброс
  // при уходе со страницы каталога — шапка не должна хранить «чужой» текст.
  useEffect(() => { setQ(urlQuery); }, [urlQuery, onCatalog]);

  // Live-поиск с debounce 250ms — единственная точка входа в поиск на desktop.
  //
  // Раньше здесь стояла проверка режима: в режиме AI живой поиск отключался,
  // иначе запрос уезжал в /catalog раньше, чем человек нажмёт Enter. Режима
  // больше нет — строка всегда каталожная, а в AI ведёт отдельная кнопка,
  // которая навигирует сама и ждать debounce не обязана.
  useEffect(() => {
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
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    // relative z-50 держит выпадающую панель поиска выше содержимого <main>.
    // 50 — ниже модалок (ScenarioSheet/LeadForm тоже z-50, но они в DOM позже
    // и потому остаются сверху) и ниже toast'ов (z-60).
    // px-8 висит на самой шапке, а не на внутреннем контейнере, и это не
    // косметика. Контент страницы устроен так же: padding на <main>, а внутри
    // него центрованный max-w-[1320px] БЕЗ собственных отступов. Пока шапка
    // складывала max-w-[1320px] и px-8 внутри, её содержимое жило в коробке
    // 1256px против 1320px у контента: логотип стоял на 40px правее левой
    // колонки, а правый край не сходился на 24px. Две коробки — две сетки;
    // сетка должна быть одна.
    <header className="relative z-50 hidden border-b border-border bg-surface/97 px-8 lg:block">
      {/* gap-4 до xl, а не gap-6 всегда: три просвета по 24px — это 72px,
          которых на 1024–1280 не хватало именно строке поиска. */}
      <div className="mx-auto flex h-16 w-full max-w-[1320px] items-center gap-4 xl:gap-6">
        {/* Логотип */}
        <Link to="/" className="flex shrink-0 items-center">
          <BrandWordmark size={28} />
        </Link>

        {/* Навигация */}
        {/* Просветы и поля пунктов ужимаются до xl: пять пунктов по 76px — это
            380px, и на 1024 они забирали ширину у строки поиска, оставляя ей
            120px на текст. Меню от более тесных полей не страдает — цели
            остаются больше 44px, — а поиск от 120px страдает. */}
        <nav className="flex items-center gap-0.5 xl:gap-1">
          {NAV.map((item) => {
            const active = item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                onPointerDown={() => preloadRoute(item.to)}
                onPointerEnter={() => preloadRoute(item.to)}
                aria-current={active ? "page" : undefined}
                className={`rounded-xl px-3 py-2 text-sm font-medium transition-colors xl:px-3.5 ${
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
        {/* Минимум обязателен: с `min-w-0` строка поиска сжималась до 88px, и в
            поле оставалось 56px на текст — подсказка обрывалась на первом слове.
            Но и завышать его нельзя. Контейнер шапки ограничен 1320px, а всё
            остальное в строке (логотип 116 + меню 380 + правая группа 431 +
            72 на просветы) занимает 999px: на поиск остаётся ровно 321px.
            Стоявшие здесь 420px требовали 1419px, и правая группа —
            то есть карточка пользователя — уезжала за край на любом широком
            экране, а не только на узком. Прежнее обоснование 420px ссылалось на
            тумблер «Каталог / AI» внутри строки, а его в поиске больше нет. */}
        <div
          className="relative min-w-[240px] flex-1 xl:min-w-[300px]"
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
                      query_length: trimmed.length, source: "desktop_enter",
                    });
                    navigate(catalogSearchRoute(trimmed));
                  }
                  setPanelOpen(false);
                }
              }}
              // Та же подсказка, что на мобильной главной, и по той же причине:
              // «Найти iPhone, MacBook…» требует 160px и на 1024 обрывалась на
              // середине слова. Обрезанная подсказка хуже короткой, а что
              // продаёт магазин — говорит меню и каталог рядом.
              placeholder="Найти технику"
              aria-label="Поиск по каталогу"
              aria-expanded={panelOpen && !q.trim()}
              className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none placeholder:text-muted"
            />
            {q && (
              <button onClick={() => setQ("")} aria-label="Очистить поиск" className="shrink-0 text-muted hover:text-text">
                <Icon name="close" className="h-4 w-4" strokeWidth={2} />
              </button>
            )}
            {/* Та же кнопка, что на главной, и с тем же поведением: одинаковые
                на вид контролы обязаны делать одинаковое. */}
            <button
              onClick={() => {
                const trimmed = q.trim();
                if (trimmed) pushSearchQuery(trimmed);
                track("search_ai_escalated", {
                  query_length: trimmed.length, source: "desktop_header",
                });
                navigate(aiSearchRoute(trimmed));
              }}
              aria-label={q.trim() ? `Спросить AI: ${q.trim()}` : "Открыть AI-подбор"}
              className="tap my-1.5 flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-accent px-3 text-[13px] font-semibold text-white"
            >
              <Icon name="sparkles" className="h-4 w-4" strokeWidth={2} />
              ИИ
            </button>
          </div>

          {panelOpen && !q.trim() && (
            <div
              ref={enterRefCallback("fade")}
              onMouseDown={(e) => e.preventDefault()}
              className="absolute inset-x-0 top-full z-40 mt-2 w-full overflow-hidden rounded-xl2 border border-border bg-surface shadow-sheet"
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
          {/* Отдельной кнопки «✨ AI-подбор» здесь больше нет. В одной строке
              было три входа в один и тот же экран: пункт меню «AI», кнопка
              «✨ ИИ» внутри поиска и эта. У первых двух роли разные — меню
              водит по разделам, кнопка в поиске эскалирует НАБРАННЫЙ запрос
              (`aiSearchRoute`), — а у этой своей роли не было, только вес
              акцентной заливки и 130px ширины, которых не хватало строке
              поиска. */}
          {/* До 1280px кнопки нет вовсе, до 1440px — только иконка.
              Замер на 1024px: строке нужно 1060px при доступных 945, и лишние
              115px уносили за край карточку пользователя — она в ряду
              последняя. Прятать надо то, что продублировано: «Написать
              менеджеру» есть в быстрых действиях на самой странице, а профиль
              на десктопе больше нигде не открыть. */}
          <button
            onClick={() => { if (!openExternalLink(config.manager_retail_url)) navigate("/ai"); }}
            title="Написать менеджеру"
            aria-label="Написать менеджеру"
            className="hidden items-center rounded-xl2 border border-border bg-surface px-3 py-2.5 text-sm font-medium text-text transition-colors hover:bg-mutedbg xl:flex wide:px-4"
          >
            {/* Раньше иконка и текст были соседями без flex — выравнивались
                по базовой линии текста, и SVG повисал чуть ниже строки:
                на глаз читалось как «неровная» кнопка рядом с чипом
                профиля. items-center на самой кнопке ставит их на одну ось. */}
            <Icon name="chat" className="h-4 w-4 shrink-0" /><span className="hidden wide:ml-1.5 wide:inline">Менеджер</span>
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
