import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import AuroraBackground from "./AuroraBackground";
import BottomNav from "./BottomNav";
import SearchOverlay from "./SearchOverlay";
import CartBar from "./CartBar";
import DesktopHeader from "./DesktopHeader";
import { BrandWordmark } from "./BrandMark";
import { usePageSwipe } from "../lib/usePageSwipe";
import { setBackButton } from "../lib/telegram";
import { useCart } from "../lib/cart";
import { shouldShowCartBar } from "../lib/cartMath";

/** Позиции корневого scroll-контейнера живут вне route-компонентов: возврат из
 * карточки товара восстанавливает каталог, а переход на новый экран стартует
 * сверху. Map ограничена реальными маршрутами одной сессии Mini App. */
const routeScrollPositions = new Map<string, number>();
const MAX_SAVED_ROUTES = 30;

function rememberRouteScroll(routeId: string, scrollTop: number) {
  routeScrollPositions.delete(routeId);
  routeScrollPositions.set(routeId, scrollTop);
  if (routeScrollPositions.size <= MAX_SAVED_ROUTES) return;
  const oldest = routeScrollPositions.keys().next().value;
  if (oldest) routeScrollPositions.delete(oldest);
}

/** ResponsiveShell — каркас приложения.
 *  Mobile (<1024px): как раньше — контент + фиксированная нижняя навигация.
 *  Desktop (>=1024px): sticky DesktopHeader сверху (вне зоны скролла = всегда
 *  виден), контент в контейнере max-w-[1320px], BottomNav скрыт (lg:hidden).
 *  <main> не пересоздаётся между маршрутами: это сохраняет scroll-контейнер и
 *  не заставляет браузер заново собирать весь shell ради анимации.
 *
 *  v5.5.0: свайп-навигация. Жест слушаем на <main>, потому что это единственный
 *  общий контейнер контента, живущий между переходами (BottomNav и шапка — вне
 *  его, их собственные жесты навигацию не трогают).
 *
 *  v5.6.0: анимация перехода живёт не здесь, а в lib/useRouteTransition — она
 *  направленная (вглубь влево, назад вправо) и показывает два слоя сразу.
 *  Layout об этом знать не нужно: модуль работает с <main> снаружи, а сам
 *  <main> по-прежнему не пересоздаётся между маршрутами — на этом держится
 *  восстановление позиции прокрутки ниже.
 *
 *  Раньше направленного сдвига здесь не было потому, что transform на <main>
 *  ломает position: fixed у потомков (.cta-dock карточки товара, строка ввода
 *  AI, кнопка заявки) — на время перехода панели отвязались бы от экрана. Это
 *  ограничение снято не переписыванием страниц, а тем, что модуль перехода на
 *  время анимации прибивает эти панели по замеренным координатам; подробности
 *  — в его docstring. */
export default function Layout() {
  const location = useLocation();
  const [searchOpen, setSearchOpen] = useState(false);
  // Стабильные ссылки: без них подписки внутри панели (Escape, кнопка «назад»
  // Telegram) переподписывались бы на каждый ре-рендер Layout, а он ре-рендерится
  // на каждую смену маршрута и на каждое изменение корзины.
  const openSearch = useCallback(() => setSearchOpen(true), []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const { isTabRoute, goBack, swipeHandlers } = usePageSwipe();
  const cart = useCart();
  const mainRef = useRef<HTMLElement>(null);
  const restoringScroll = useRef(false);
  const restoreVersion = useRef(0);
  const routeId = `${location.pathname}${location.search}`;

  // Восстановление делаем до кадра. Если данные страницы ещё грузятся, несколько
  // коротких повторов дождутся её высоты; любое действие пользователя отменяет их.
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const target = routeScrollPositions.get(routeId) ?? 0;
    const version = ++restoreVersion.current;
    let attempts = 0;
    let timer: number | undefined;

    if (target <= 0) {
      restoringScroll.current = true;
      main.scrollTop = 0;
      restoringScroll.current = false;
      return;
    }

    restoringScroll.current = true;
    const restore = () => {
      if (restoreVersion.current !== version) return;
      const maxScroll = Math.max(0, main.scrollHeight - main.clientHeight);
      main.scrollTop = Math.min(target, maxScroll);
      attempts += 1;
      if (Math.abs(main.scrollTop - target) <= 1 || attempts >= 12) {
        restoringScroll.current = false;
        rememberRouteScroll(routeId, main.scrollTop);
        return;
      }
      timer = window.setTimeout(restore, 50);
    };
    restore();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      restoringScroll.current = false;
    };
  }, [routeId]);

  function cancelScrollRestore() {
    restoreVersion.current += 1;
    restoringScroll.current = false;
  }

  // Нативная кнопка «Назад» Telegram — на вложенных экранах, тем же переходом,
  // что и свайп от края. На корневых вкладках её нет: возвращаться некуда.
  useEffect(() => setBackButton(isTabRoute ? null : goBack), [isTabRoute, location.key]);

  // Класс на <html> — единственный способ сообщить CSS, что снизу появился ещё
  // один слой: нижний отступ скролл-контейнера должен вырасти ровно тогда, когда
  // панель видна, иначе последняя карточка ленты уезжает под неё.
  const cartBarVisible = shouldShowCartBar(location.pathname, cart.items_count);
  useEffect(() => {
    document.documentElement.classList.toggle("has-cart-bar", cartBarVisible);
    return () => document.documentElement.classList.remove("has-cart-bar");
  }, [cartBarVisible]);

  return (
    <div className="flex h-full flex-col">
      {/* Живой фон лежит под всем контентом и сам решает, на каких маршрутах
          показываться. Здесь, а не внутри страниц: <main> прокручивается, и
          прибитый к экрану слой не должен зависеть от того, какая страница в
          нём сейчас смонтирована. */}
      <AuroraBackground />
      {/* Знак бренда в полосе плавающих кнопок Telegram. Решение принимает
          brandMarkVisible (lib/viewport.ts, покрыта тестами), которую вызывает
          lib/telegram.ts в syncViewportVars и выставляет класс brand-mark-on на
          <html>. Здесь разметка просто читает его через CSS (.brand-slot скрыт
          вне этого класса). Сам знак не может решать, потому что Telegram может
          сообщить fullscreen раньше, чем contentSafeAreaInset, и знак мигнул бы
          в полосе нулевой высоты. */}
      <div aria-hidden className="hero-top-inset lg:hidden">
        <span className="brand-slot">
          <BrandWordmark size={26} />
        </span>
      </div>
      <DesktopHeader />
      <main
        ref={mainRef}
        onPointerDown={(e) => {
          cancelScrollRestore();
          swipeHandlers.onPointerDown(e);
        }}
        onPointerUp={swipeHandlers.onPointerUp}
        onPointerCancel={swipeHandlers.onPointerCancel}
        onWheel={cancelScrollRestore}
        onScroll={(e) => {
          if (!restoringScroll.current) rememberRouteScroll(routeId, e.currentTarget.scrollTop);
        }}
        // scrollbar-gutter резервирует место полосы прокрутки с ОБЕИХ сторон,
        // и это про выравнивание, а не про полосу. Прокручивается <main>, а
        // desktop-шапка лежит снаружи него: полоса съедала правый край только у
        // контента, центрованный внутри блок уезжал влево на половину её
        // ширины, и колонка не сходилась с логотипом на 8px. Симметричный
        // резерв возвращает обеим коробкам общую среднюю линию. На мобильных
        // полоса наложенная, ширина её ноль — правило там ничего не меняет.
        className="pb-nav flex-1 overflow-y-auto px-4 pt-3 lg:px-8 lg:pb-12 lg:pt-6 lg:[scrollbar-gutter:stable_both-edges]"
      >
        <div className="lg:mx-auto lg:w-full lg:max-w-[1320px]">
          <Outlet />
        </div>
      </main>
      <CartBar />
      {/* Поиск живёт здесь, а не на страницах: круг доступен с каждого экрана,
          и панель обязана открываться поверх ТОГО экрана, где её позвали.
          Состояние держит Layout — он переживает переходы между маршрутами,
          как и сама навигация. */}
      <BottomNav onOpenSearch={openSearch} searchOpen={searchOpen} />
      <SearchOverlay open={searchOpen} onClose={closeSearch} />
    </div>
  );
}
