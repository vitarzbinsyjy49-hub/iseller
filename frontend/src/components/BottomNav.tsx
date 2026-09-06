import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { preloadRoute } from "../lib/routePreload";
import { hasOpaqueDock, navSurface, supportsBackdropFilter } from "../lib/navGlass";
import { animateNumber, prefersReducedMotion } from "../lib/motion";
import { useLeadsBadge } from "../store/leadsBadge";
import { useCartSwapOut, CART_SWAP_DX_PX } from "../lib/useCartSwap";
import { enterRefCallback } from "../lib/useEnter";
import { useIconFill } from "../lib/useIconFill";
import { Icon } from "./icons";
import SearchPanel from "./SearchPanel";
import { track } from "../lib/analytics";
import { setBackButton } from "../lib/telegram";
import { searchAppSections } from "../lib/appSections";
import {
  isKeyboardOpen,
  navRowKeyboardBottomPx,
  overlayViewportBox,
  searchPanelMaxHeightPx,
} from "../lib/viewport";
import { loadCachedCategories } from "../lib/categoryCache";
import { navTiles } from "../lib/navTiles";
import { pushSearchQuery } from "../lib/searchHistory";
import { catalogSearchRoute } from "../lib/searchRoutes";
import {
  HANDLE_ZONE_PX,
  isVerticalDrag,
  scrollerWithin,
  sheetBackdropOpacity,
  sheetDragOffset,
  shouldDismissSheet,
} from "../lib/sheetDrag";

/** Сколько наливается стекло. Короче открытия шторки (260мс): панель не
 *  приезжает, а меняет материал — движения нет, есть проявление. */
const GLASS_FILL_MS = 220;

/** Нижняя навигация: 4 вкладки, SVG-иконки, активная — Telegram blue.
 *  Сознательно НЕ используем NavLink: обычный Link + useLocation дают тот же
 *  active-state без NavLinkWithRef (у NavLink были крэши hasValidRef при
 *  расхождении версий react-router-dom/React в чужих окружениях). */

/** Вкладка держит ДВА рисунка одного знака: контур и силуэт.
 *
 *  Активной вкладке силуэт проступает поверх контура — это второй признак
 *  состояния помимо цвета. Не украшение: вкладку, отличающуюся только цветом,
 *  не найдёт человек с нарушением цветовосприятия. Наполнение играет покадрово
 *  (lib/useIconFill.ts), потому что этот webview гасит CSS-переходы целиком.
 */
type Item = { to: string; label: string; outline: ReactElement; fill: ReactElement };

/** Контур — 1.5, как во всём наборе (components/icons.tsx). Толщина больше НЕ
 *  зависит от активности: раньше активная вкладка утолщалась до 2.2, и это был
 *  третий способ сказать одно и то же после цвета и капсулы. Теперь состояние
 *  несёт силуэт, а линия остаётся одной на все вкладки. */
const OUTLINE = {
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** Четыре вкладки плюс отдельный круг поиска — раскладка Telegram iOS 26.
 *
 *  Заявок здесь больше нет: они переехали в профиль выделенной кнопкой с
 *  бейджем непросмотренных изменений (pages/Profile.tsx). Причина не в
 *  экономии места, а в частоте: в заявки заходят после того, как что-то
 *  заказали, а не по дороге между экранами.
 */
const items: Item[] = [
  {
    to: "/", label: "Главная",
    outline: (
      <svg viewBox="0 0 24 24" className="h-6 w-6" {...OUTLINE}>
        <path d="M3.5 10.5 12 4l8.5 6.5" />
        <path d="M5.8 9.6v9.6a1.9 1.9 0 0 0 1.9 1.9h8.6a1.9 1.9 0 0 0 1.9-1.9V9.6" />
      </svg>
    ),
    fill: (
      <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor">
        <path d="M12 4 3.5 10.5v8.7A1.9 1.9 0 0 0 5.4 21h13.2a1.9 1.9 0 0 0 1.9-1.8v-8.7z" />
      </svg>
    ),
  },
  {
    to: "/catalog", label: "Каталог",
    outline: (
      <svg viewBox="0 0 24 24" className="h-6 w-6" {...OUTLINE}>
        <rect x="4.2" y="4" width="6.4" height="6.4" rx="1.8" />
        <rect x="13.4" y="4" width="6.4" height="6.4" rx="1.8" />
        <rect x="4.2" y="13.6" width="6.4" height="6.4" rx="1.8" />
        <rect x="13.4" y="13.6" width="6.4" height="6.4" rx="1.8" />
      </svg>
    ),
    fill: (
      <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor">
        <rect x="4.2" y="4" width="6.4" height="6.4" rx="1.8" />
        <rect x="13.4" y="4" width="6.4" height="6.4" rx="1.8" />
        <rect x="4.2" y="13.6" width="6.4" height="6.4" rx="1.8" />
        <rect x="13.4" y="13.6" width="6.4" height="6.4" rx="1.8" />
      </svg>
    ),
  },
  {
    to: "/ai", label: "AI",
    outline: (
      <svg viewBox="0 0 24 24" className="h-6 w-6" {...OUTLINE}>
        <path d="M12 4.2 13.6 9l4.8 1.6-4.8 1.6L12 17l-1.6-4.8L5.6 10.6 10.4 9z" />
        <path d="M18.4 15.4l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />
      </svg>
    ),
    fill: (
      <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor">
        <path d="M12 4.2 13.6 9l4.8 1.6-4.8 1.6L12 17l-1.6-4.8L5.6 10.6 10.4 9zM18.4 15.4l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />
      </svg>
    ),
  },
  {
    to: "/profile", label: "Профиль",
    outline: (
      <svg viewBox="0 0 24 24" className="h-6 w-6" {...OUTLINE}>
        <circle cx="12" cy="8.4" r="3.6" />
        <path d="M5.2 19.8c1.1-3.3 3.7-5 6.8-5s5.7 1.7 6.8 5" />
      </svg>
    ),
    fill: (
      <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor">
        <path d="M12 4.8a3.6 3.6 0 1 1 0 7.2 3.6 3.6 0 0 1 0-7.2zM12 14.8c3.1 0 5.7 1.7 6.8 5H5.2c1.1-3.3 3.7-5 6.8-5z" />
      </svg>
    ),
  },
];

/** Знак вкладки: контур и силуэт друг на друге.
 *
 *  Прозрачность в покое задаёт CSS по data-атрибутам, а НЕ inline-стиль из JSX.
 *  Это не вкусовщина: React перерисовывает вкладку в тот же момент, когда
 *  меняется активность, и inline-стиль с конечным значением затирал бы кадры
 *  мотора — наполнение не игралось бы вовсе, оставаясь мгновенной подменой.
 *  Мотор пишет свой inline-стиль поверх на время анимации и оставляет его
 *  равным конечному значению; CSS-правило и результат анимации совпадают.
 */
function TabIcon({ item, active }: { item: Item; active: boolean }) {
  const { outlineRef, fillRef } = useIconFill<HTMLSpanElement>(active);
  return (
    <span className="relative block h-6 w-6">
      <span ref={outlineRef} data-ico-layer="outline" data-ico-active={active} className="ico-layer">
        {item.outline}
      </span>
      <span ref={fillRef} data-ico-layer="fill" data-ico-active={active} className="ico-layer">
        {item.fill}
      </span>
    </span>
  );
}

/** Чем залита панель на ТЕКУЩЕМ экране.
 *
 *  Пересчитывается на смену маршрута, а не один раз при монтировании: панель
 *  навигации живёт в Layout и переживает переходы, а непрозрачная .cta-dock
 *  появляется и исчезает вместе со страницей. Считать один раз означало бы
 *  унести решение с карточки товара на главную и обратно.
 *
 *  Считается ДВАЖДЫ: сразу и ещё раз на следующем кадре.
 *
 *  Сразу — потому что rAF в скрытой вкладке не выполняется вовсе. Если бы
 *  решение висело только на кадре, панель, смонтированная в фоне (свёрнутый
 *  Telegram, вкладка на втором плане), осталась бы сплошной до первого показа.
 *  Поймано на стенде: в скрытой панели браузера кадр не наступал ни разу, и
 *  стекло не включалось.
 *
 *  И ещё раз на кадре — потому что между сменой pathname и монтированием новой
 *  страницы есть кадр, в котором .cta-dock ещё от прошлой. Без второй проверки
 *  панель успевала моргнуть стеклом на карточке товара.
 *
 *  Оба ответа приходят из одной функции, так что «дважды» не значит «по-разному».
 */
function useNavSurface(pathname: string) {
  const [surface, setSurface] = useState<"glass" | "solid">("solid");

  useEffect(() => {
    const decide = () =>
      setSurface(
        navSurface({
          supported: supportsBackdropFilter(),
          dockBehind: hasOpaqueDock(),
        }),
      );
    decide();
    const id = requestAnimationFrame(decide);
    return () => cancelAnimationFrame(id);
  }, [pathname]);

  return surface;
}

/** Наливает и сливает стекло покадрово.
 *
 *  Почему не CSS-переход. Этот webview гасит декларативную анимацию целиком —
 *  transition на backdrop-filter здесь не «плавный», а мгновенный, и отличить
 *  изнутри кода «не анимировалось» от «анимировалось быстро» нельзя. Общее
 *  правило проекта: движение, которое человек должен увидеть, идёт через
 *  lib/motion.ts. Ошибка уже стоила проекту уезжающей панели каталога и
 *  превращения кнопки в степпер — обе были на CSS и обе перещёлкивались.
 *
 *  Атрибут data-glass снимается только ПОСЛЕ того, как стекло слилось до нуля:
 *  иначе backdrop-filter исчезал бы вместе с первым кадром, и вместо слива
 *  получился бы тот самый щелчок, ради ухода от которого всё и делается.
 *
 *  Анимация пропускается в двух случаях, и оба — не «оптимизация», а условие
 *  корректности:
 *
 *  - «уменьшить движение». Здесь это не потеря: стекло — материал, а не
 *    событие, сообщать анимацией нечего;
 *  - вкладка скрыта. В скрытой вкладке rAF не выполняется ВООБЩЕ, значит
 *    завершение анимации не наступит никогда — а вместе с ним и снятие
 *    data-glass. Панель осталась бы стеклянной над непрозрачной .cta-dock,
 *    то есть показывала бы сплошной прямоугольник вместо контента. Поймано на
 *    стенде: в скрытой панели браузера за 1.2с не прошло ни одного кадра.
 *    Смотреть в этот момент всё равно некому, поэтому ставим конечное
 *    состояние сразу — оно и корректно, и бесплатно.
 */
function useGlassFill(el: HTMLElement | null, surface: "glass" | "solid") {
  const t = useRef(0);

  useEffect(() => {
    if (!el) return;
    const to = surface === "glass" ? 1 : 0;
    if (t.current === to) return;

    const apply = (v: number) => {
      t.current = v;
      el.style.setProperty("--nav-glass-t", v.toFixed(3));
    };

    // Стекло появляется ДО первого кадра (иначе анимировать нечего) и
    // снимается ПОСЛЕ последнего (иначе слив превращается в щелчок).
    if (to === 1) el.setAttribute("data-glass", "on");
    const settle = () => {
      if (to === 0) el.setAttribute("data-glass", "off");
    };

    const skipAnimation =
      prefersReducedMotion() || (typeof document !== "undefined" && document.hidden);
    if (skipAnimation) {
      apply(to);
      settle();
      return;
    }

    return animateNumber(t.current, to, GLASS_FILL_MS, apply, settle);
  }, [el, surface]);
}

/** Насколько слайд-слои ряда расходятся вбок. Тот же язык, что у кнопки
 *  корзины (CART_SWAP_DX_PX) — переиспользуем то же число, а не заводим
 *  параллельное: и там, и здесь это доводка одной и той же уступки, а не
 *  самостоятельное движение. */
const ROW_SWAP_DX_PX = CART_SWAP_DX_PX;

/** Обмен НИЖНЕГО РЯДА идёт дольше и дальше, чем обмен кнопки корзины.
 *
 *  Сначала он переиспользовал тайминги кнопки как есть — 190мс на приход,
 *  150мс на уход, сдвиг 14px. На кнопке шириной в половину плитки это ровно
 *  столько, сколько надо; на полосе во всю ширину экрана то же движение
 *  читается рывком: слои успевают смениться раньше, чем глаз проследит за
 *  превращением, и вместо «лупа стала строкой» видно «одно моргнуло другим».
 *
 *  Путь тоже длиннее: ход в 14px на 300-пиксельной полосе — это 5% её ширины,
 *  то есть почти незаметное дрожание, а не уступка места. */
const ROW_MORPH_DX_PX = 26;
const ROW_MORPH_IN_MS = 300;
const ROW_MORPH_OUT_MS = 210;

/** Сколько категорий показываем чипами. Тот же предел, что был у прежнего
 *  SearchOverlay и у hero главной: ряд должен помещаться в две строки. */
const CHIP_LIMIT = 6;

/** Длительность возврата/ухода панели выдачи при отпущенном жесте — тот же
 *  порядок чисел, что у SHEET_SETTLE_MS/SHEET_OUT_MS в lib/motion.ts. Своих
 *  чисел не заводим ради заведения, но панель здесь не шторка SheetShell
 *  (сдвиг короче, потолок другой) — отдельные, специально подобранные под неё
 *  константы. */
const PANEL_SETTLE_MS = 170;
const PANEL_DISMISS_MS = 180;

export default function BottomNav() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const surface = useNavSurface(pathname);
  const [nav, setNav] = useState<HTMLElement | null>(null);
  useGlassFill(nav, surface);
  const leadUnseen = useLeadsBadge((s) => s.unseen);
  const refreshLeads = useLeadsBadge((s) => s.refresh);
  // Панель живёт в Layout и переживает переходы, поэтому запрос один на сессию,
  // а не на каждый заход в профиль. Профиль читает тот же стор.
  useEffect(() => { void refreshLeads(); }, [refreshLeads]);

  // ===== Строка поиска =====
  //
  // Раньше круг открывал components/SearchOverlay — отдельную панель,
  // выехавшую снизу поверх экрана. Владелец продукта дважды забраковал эту
  // форму: круг и четыре вкладки предпочтительнее МЕНЯТЬ на строку ввода и
  // кнопку «Отмена», а не прятать под чем-то новым — тот же язык, что уже
  // сложился в приложении на кнопке «Добавить» → степпер (lib/useCartSwap.ts,
  // .cart-morph в index.css). Состояние живёт здесь, а не в Layout: строка
  // ввода — часть этого ряда, а не отдельный слой поверх него.
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const openSearch = useCallback(() => setSearchOpen(true), []);

  // Слой с четырьмя вкладками уступает место строке ввода тем же механизмом,
  // что кнопка «Добавить» уступает степперу: этот ref всегда сидит на слое
  // вкладок (он никогда не размонтируется) и играет анимацию, когда
  // searchOpen меняется. Слой строки ввода — наоборот, монтируется заново на
  // каждое открытие и играет свой enterRefCallback("slide", ...).
  const tabsLayerRef = useCartSwapOut<HTMLDivElement>(searchOpen, { dxPx: ROW_MORPH_DX_PX, inMs: ROW_MORPH_IN_MS, outMs: ROW_MORPH_OUT_MS });
  // Тот же приём для круга: иконка лупы — постоянный слой, «Отмена» —
  // монтируется только пока поиск открыт.
  const circleIconLayerRef = useCartSwapOut<HTMLDivElement>(searchOpen, { dxPx: ROW_MORPH_DX_PX, inMs: ROW_MORPH_IN_MS, outMs: ROW_MORPH_OUT_MS });

  const chips = useMemo(() => {
    if (!searchOpen) return [];
    // home=null: ряд не хранит плитки главной, только кэш категорий — этого
    // достаточно, чтобы не делать лишний запрос ради чипов поиска.
    return navTiles("category", null, loadCachedCategories()).slice(0, CHIP_LIMIT);
  }, [searchOpen]);

  const sections = useMemo(() => searchAppSections(query), [query]);

  // Позиция ряда и высота потолка выдачи — по ВИДИМОЙ области, а не по vh.
  //
  // На iOS клавиатура не сжимает вебвью — она накрывает его снизу. Ряд закреп-
  // лён `bottom: safe-area + зазор` от НАСТОЯЩЕГО низа окна (index.css,
  // .nav-row) — и с открытой клавиатурой оказался бы позади нижней трети
  // клавиш, то есть строка ввода была бы недоступна ровно в момент набора.
  // Пока клавиатура открыта (isKeyboardOpen), инлайн-стилем поднимаем ряд на
  // высоту перекрытия (navRowKeyboardBottomPx); когда клавиатуры нет —
  // инлайн-bottom снимается, и работает обычный CSS-расчёт. Высоту потолка
  // выдачи (62% видимой области, searchPanelMaxHeightPx) считаем тут же — это
  // та же самая видимая область, второй раз её мерить незачем.
  //
  // Пишем прямо в стиль узла, а не через состояние: visualViewport стреляет
  // событиями пачками во время подъёма клавиатуры, и ре-рендер ряда с живым
  // поиском на каждое из них — это подтормаживание ровно в момент движения.
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!searchOpen) return;
    const navEl = nav;
    if (!navEl) return;
    const vv = window.visualViewport;
    const apply = () => {
      const vvHeight = vv?.height ?? null;
      const box = overlayViewportBox({
        vvHeight,
        vvOffsetTop: vv?.offsetTop ?? null,
        windowHeight: window.innerHeight,
      });
      if (isKeyboardOpen(vvHeight, window.innerHeight)) {
        navEl.style.bottom = `${navRowKeyboardBottomPx(box, window.innerHeight)}px`;
      } else {
        navEl.style.removeProperty("bottom");
      }
      if (panelRef.current) {
        panelRef.current.style.maxHeight = `${searchPanelMaxHeightPx(box.height)}px`;
      }
    };
    apply();
    vv?.addEventListener("resize", apply);
    vv?.addEventListener("scroll", apply);
    window.addEventListener("resize", apply);
    return () => {
      vv?.removeEventListener("resize", apply);
      vv?.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
      navEl.style.removeProperty("bottom");
    };
  }, [searchOpen, nav]);

  // Фокус — на следующем кадре после появления инпута: на смонтированном в
  // этом же кадре элементе focus() на iOS не срабатывает.
  useEffect(() => {
    if (!searchOpen) return;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [searchOpen]);

  // Escape и кнопка «назад» Telegram закрывают поиск, а не уводят с экрана
  // под ним.
  useEffect(() => {
    if (!searchOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeSearch(); };
    window.addEventListener("keydown", onKey);
    const restoreBack = setBackButton(closeSearch);
    return () => {
      window.removeEventListener("keydown", onKey);
      restoreBack();
    };
  }, [searchOpen, closeSearch]);

  useEffect(() => { if (searchOpen) track("search_focused", { source: "row" }); }, [searchOpen]);
  useEffect(() => { if (!searchOpen) setQuery(""); }, [searchOpen]);

  function go(route: string) {
    closeSearch();
    navigate(route);
  }

  function submit() {
    const trimmed = query.trim();
    if (trimmed) pushSearchQuery(trimmed);
    track("search_query_submitted", { query_length: trimmed.length, source: "row" });
    go(catalogSearchRoute(trimmed));
  }

  // ===== Протяжка выдачи вниз закрывает поиск =====
  //
  // Логика жеста — та же, что у шторок (lib/sheetDrag.ts, покрыта тестами):
  // isVerticalDrag/scrollerWithin отличают жест по панели от прокрутки списка
  // внутри неё, sheetDragOffset/shouldDismissSheet решают, довести до закрытия
  // или вернуть на место. Второй реализации жеста здесь нет — переиспользованы
  // те же чистые функции, что и в components/ScenarioSheet.tsx.
  const panelDragRef = useRef<{
    pointerId: number; startX: number; startY: number; startAt: number;
    height: number; scroller: HTMLElement | null; fromHandle: boolean;
    active: boolean; offset: number;
  } | null>(null);
  const cancelPanelAnimRef = useRef<() => void>(() => {});

  function onPanelPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerType === "mouse") return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const fromHandle = e.clientY - rect.top <= HANDLE_ZONE_PX;
    panelDragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY, startAt: performance.now(),
      height: rect.height,
      scroller: fromHandle ? null : scrollerWithin(e.target, panel),
      fromHandle, active: false, offset: 0,
    };
  }

  function onPanelPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = panelDragRef.current;
    const panel = panelRef.current;
    if (!drag || !panel || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;

    if (!drag.active) {
      if (!isVerticalDrag(dx, dy)) return;
      const contentAtTop = !drag.scroller || drag.scroller.scrollTop <= 0;
      if (dy > 0 && !contentAtTop) { panelDragRef.current = null; return; }
      if (dy < 0 && !drag.fromHandle) { panelDragRef.current = null; return; }
      drag.active = true;
      cancelPanelAnimRef.current();
      try { panel.setPointerCapture?.(e.pointerId); } catch { /* не критично */ }
    }

    const offset = sheetDragOffset(dy);
    drag.offset = offset;
    panel.style.transform = offset ? `translate3d(0, ${offset}px, 0)` : "";
    panel.style.opacity = String(sheetBackdropOpacity(offset, drag.height));
  }

  function onPanelPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const drag = panelDragRef.current;
    panelDragRef.current = null;
    if (!drag || !drag.active || e.pointerId !== drag.pointerId) return;
    const panel = panelRef.current;
    const elapsedMs = performance.now() - drag.startAt;

    if (shouldDismissSheet({ offset: drag.offset, height: drag.height, elapsedMs })) {
      if (!panel) { closeSearch(); return; }
      const fromOpacity = sheetBackdropOpacity(drag.offset, drag.height);
      const target = drag.height + 1;
      const remaining = Math.max(0, 1 - drag.offset / Math.max(target, 1));
      const duration = Math.max(100, Math.round(PANEL_DISMISS_MS * remaining));
      cancelPanelAnimRef.current = animateNumber(0, 1, duration, (t) => {
        panel.style.transform = `translate3d(0, ${drag.offset + (target - drag.offset) * t}px, 0)`;
        panel.style.opacity = String(fromOpacity * (1 - t));
      }, () => closeSearch());
    } else {
      if (!panel) return;
      const fromOpacity = sheetBackdropOpacity(drag.offset, drag.height);
      cancelPanelAnimRef.current = animateNumber(0, 1, PANEL_SETTLE_MS, (t) => {
        const y = drag.offset * (1 - t);
        panel.style.transform = y ? `translate3d(0, ${y}px, 0)` : "";
        panel.style.opacity = String(fromOpacity + (1 - fromOpacity) * t);
      }, () => { panel.style.transform = ""; panel.style.opacity = ""; });
    }
  }

  function onPanelPointerCancel(e: React.PointerEvent<HTMLDivElement>) {
    const drag = panelDragRef.current;
    panelDragRef.current = null;
    const panel = panelRef.current;
    if (!drag?.active || !panel || e.pointerId !== drag.pointerId) return;
    const fromOpacity = sheetBackdropOpacity(drag.offset, drag.height);
    cancelPanelAnimRef.current = animateNumber(0, 1, PANEL_SETTLE_MS, (t) => {
      const y = drag.offset * (1 - t);
      panel.style.transform = y ? `translate3d(0, ${y}px, 0)` : "";
      panel.style.opacity = String(fromOpacity + (1 - fromOpacity) * t);
    }, () => { panel.style.transform = ""; panel.style.opacity = ""; });
  }

  return (
    // lg:hidden — на desktop навигация в DesktopHeader, мобильный bottom nav скрыт
    // js-bottom-nav: при открытой клавиатуре скрывается через html.kb-open (index.css),
    // кроме data-search-open — см. комментарий у правила в index.css.
    <nav
      ref={setNav}
      // Стартуем сплошными и отдаём атрибут useGlassFill: React ставит его
      // один раз, дальше им управляет покадровый мотор. Держать значение в
      // JSX нельзя — рендер перебивал бы кадр анимации.
      data-glass="off"
      data-search-open={searchOpen ? "true" : undefined}
      className="js-bottom-nav nav-row fixed z-40 flex lg:hidden">
      {/* Фильтр преломления кромки. Лежит здесь, а не в index.css: SVG-фильтр
          обязан быть узлом документа, ссылаться на него из стилей можно только
          по id. aria-hidden и нулевой размер — это определение, а не картинка.
          Статичный, без <animate>: анимацию этот webview всё равно гасит, а
          движение стекла даёт покадровый мотор (useGlassFill). */}
      <svg width="0" height="0" aria-hidden="true" focusable="false" className="absolute">
        <filter id="nav-refract" x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.012 0.09" numOctaves="2" seed="7" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="9" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </svg>

      {/* Ловец тапа мимо панели. Панель занимает часть экрана, остальное
          видно и выглядит интерактивным — тап по нему ожидаемо закрывает
          поиск, это самый находимый без обучения способ, и он был в прежней
          версии (SearchOverlay). Не подложка-затемнение: элемент прозрачный,
          виден только сам контент под ним.
          `onClick`, а не `onPointerDown`: клик — это то, что браузер САМ не
          генерирует после сдвига пальца (скролл ленты под панелью, протяжка
          самой панели), так что жест и обычная прокрутка не гасятся заодно.
          Протяжку панели это и не затронуло бы отдельно: она ловит
          pointerdown/move/up на САМОЙ панели и захватывает поинтер
          (`setPointerCapture`) — событие клика по нему уходит панели, а не
          сюда, даже если палец геометрически оказался над этим слоем.
          Рендерится ДО панели/ряда в DOM — они идут следующими соседями без
          собственного z-index и потому рисуются поверх, свои нажатия ловят
          сами, а не отдают этому слою. */}
      {searchOpen && <div aria-hidden="true" onClick={closeSearch} className="fixed inset-0 lg:hidden" />}

      {/* Выдача — растёт ВВЕРХ от ряда, а не отдельным слоем поверх экрана.
          Потолок — 62% видимой области (searchPanelMaxHeightPx), тот же
          предел, что был у прежнего SearchOverlay. */}
      {searchOpen && (
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          // Скрытая подпись для скринридера: у панели нет видимого заголовка,
          // aria-label — единственное имя, которое узнает screen reader.
          aria-label="Поиск"
          onPointerDown={onPanelPointerDown}
          onPointerMove={onPanelPointerMove}
          onPointerUp={onPanelPointerUp}
          onPointerCancel={onPanelPointerCancel}
          className="nav-search-panel flex min-h-0 flex-col overflow-y-auto overscroll-contain"
        >
          <div aria-hidden className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border" />
          <div className="pb-2 pt-1">
            {/* Разделы — ВЫШЕ товаров. Их мало и они точные: человек, набравший
                «заявки», ищет именно раздел, и прятать его под лентой карточек
                значит отвечать не на тот вопрос. */}
            {sections.length > 0 && (
              <div className="px-4 pt-1">
                <p className="px-1 pb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Разделы</p>
                <div className="overflow-hidden rounded-xl2 bg-surface shadow-soft">
                  {sections.map((s, i) => (
                    <button
                      key={s.key}
                      onClick={() => { track("search_section_opened", { section: s.key }); go(s.route); }}
                      className={`tap flex w-full items-center gap-3 px-4 py-3 text-left ${
                        i === sections.length - 1 ? "" : "border-b border-border"
                      }`}
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                        <Icon name={s.icon} className="h-[18px] w-[18px]" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold">{s.label}</span>
                        <span className="mt-0.5 block truncate text-xs text-muted">{s.hint}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Заголовок «Товары» появляется ТОЛЬКО когда выше показаны разделы
                — иначе «Ничего не нашлось» про товары читалось бы как ответ на
                весь запрос, а не на его товарную часть. */}
            {sections.length > 0 && (
              <p className="px-5 pb-1.5 pt-4 text-xs font-semibold uppercase tracking-wide text-muted">Товары</p>
            )}

            <SearchPanel
              query={query}
              chips={chips}
              fill
              onNavigate={go}
              onPickQuery={(q) => { setQuery(q); inputRef.current?.focus(); }}
            />
          </div>
        </div>
      )}

      {/* Сам ряд — пилюля вкладок + круг поиска. Позиция и размер ряда не
          меняются НИКОГДА: превращается только то, что внутри (см. .nav-pill/
          .nav-circle ниже) — сдвиг ширины/высоты всего ряда читался бы как
          перекладка панели каждый кадр, а не как один орган управления,
          уступающий место другому. */}
      <div className="nav-inner-row">
        <div className="nav-surface nav-pill morph h-14 flex-1">
          {/* Слой вкладок — постоянный, уступает место строке ввода тем же
              механизмом, что кнопка «Добавить» уступает степперу
              (lib/useCartSwap.ts). tabIndex=-1 у вкладок, пока поиск открыт:
              opacity/pointer-events прячут слой от мыши и тача, но не от Tab —
              без явного -1 скрытые вкладки остались бы в последовательности
              обхода клавиатурой. */}
          <div
            ref={tabsLayerRef}
            data-hidden={searchOpen}
            aria-hidden={searchOpen}
            className="morph-layer flex items-center justify-around py-1.5"
          >
            {items.map((item) => {
              const isActive = item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  tabIndex={searchOpen ? -1 : undefined}
                  onPointerDown={() => preloadRoute(item.to)}
                  onPointerEnter={() => preloadRoute(item.to)}
                  aria-current={isActive ? "page" : undefined}
                  className={`nav-tab tap flex w-16 flex-col items-center justify-center gap-1 px-1 text-[11px] font-medium leading-none transition-colors ${
                    isActive ? "nav-tab-active text-accent" : "text-muted"
                  }`}
                >
                  <span className="nav-icon relative flex h-6 min-w-10 items-center justify-center rounded-full">
                    <TabIcon item={item} active={isActive} />
                    {/* Точка, а не цифра: в ряду вкладок число нечитаемо мелким, а
                        сообщить надо ровно одно — «там что-то изменилось».
                        Цифра есть в самом профиле, на кнопке заявок. */}
                    {item.to === "/profile" && leadUnseen > 0 && (
                      <span className="absolute right-1 top-0 h-2 w-2 rounded-full bg-accent ring-2 ring-surface" />
                    )}
                  </span>
                  {/* nav-label — точка, за которую подпись прячется на коротком
                      экране (index.css). Голым текстовым узлом её не выбрать. */}
                  <span className="nav-label">{item.label}</span>
                  {item.to === "/profile" && leadUnseen > 0 && (
                    <span className="sr-only">, есть непросмотренные изменения по заявкам</span>
                  )}
                </Link>
              );
            })}
          </div>

          {/* Строка ввода — монтируется заново на каждое открытие и въезжает
              справа (slide), как степпер корзины. */}
          {searchOpen && (
            <div
              ref={enterRefCallback("slide", 0, ROW_MORPH_DX_PX, ROW_MORPH_IN_MS)}
              className="morph-layer flex items-center gap-2 px-4"
            >
              <Icon name="search" className="h-5 w-5 shrink-0 text-muted" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
                placeholder="Товары и разделы"
                aria-label="Поиск по товарам и разделам"
                enterKeyHint="search"
                className="w-full min-w-0 bg-transparent text-base outline-none placeholder:text-muted"
              />
            </div>
          )}
        </div>

        {/* Круг поиска — становится «Отменой». Кнопка, а не ссылка: поиск
            открывается НА этом экране, а не уводит на другой. Ширина
            переключается классом (w-14 ⇄ w-[84px]), не анимируется — см.
            комментарий у .nav-circle в index.css. */}
        <button
          type="button"
          onClick={() => (searchOpen ? closeSearch() : openSearch())}
          onPointerDown={() => { if (!searchOpen) preloadRoute("/catalog"); }}
          aria-label={searchOpen ? "Закрыть поиск" : "Поиск"}
          // Кнопка открывает панель, а не переходит куда-то: без этих двух
          // атрибутов экранный читалка объявляет её обычной кнопкой, и человек
          // не знает, что произойдёт по нажатию.
          aria-haspopup="dialog"
          aria-expanded={searchOpen}
          className={`nav-surface nav-circle morph tap flex h-14 shrink-0 items-center justify-center text-muted ${
            searchOpen ? "w-[84px]" : "w-14"
          }`}
        >
          <div
            ref={circleIconLayerRef}
            data-hidden={searchOpen}
            aria-hidden={searchOpen}
            className="morph-layer flex items-center justify-center"
          >
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor"
                 strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
            </svg>
          </div>
          {searchOpen && (
            <div
              ref={enterRefCallback("slide", 0, ROW_MORPH_DX_PX, ROW_MORPH_IN_MS)}
              className="morph-layer flex items-center justify-center text-[13px] font-semibold text-accent"
            >
              Отмена
            </div>
          )}
        </button>
      </div>
    </nav>
  );
}
