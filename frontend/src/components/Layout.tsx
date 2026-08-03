import { useEffect, useLayoutEffect, useRef } from "react";
import { Outlet, useLocation } from "react-router-dom";
import BottomNav from "./BottomNav";
import CartBar from "./CartBar";
import DesktopHeader from "./DesktopHeader";
import { usePageSwipe } from "../lib/usePageSwipe";
import { setBackButton } from "../lib/telegram";
import { useCart } from "../lib/cart";
import { animateOpacity } from "../lib/motion";
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
 *  Анимация въезда — ОДНА на все переходы, и направление жеста её больше не
 *  выбирает. До отказа от remount свайп «назад» въезжал сдвигом с той стороны,
 *  откуда тянули; повторить это здесь можно было бы только transform'ом на
 *  <main>, а он ломает position: fixed у потомков. Внутри страниц такие
 *  потомки есть — .cta-dock карточки товара и строка ввода AI: на время
 *  перехода они отвязались бы от экрана и прыгнули. Прыгающая кнопка «Оставить
 *  заявку» дороже направленности анимации, поэтому остаётся общий fade. */
export default function Layout() {
  const location = useLocation();
  const { isTabRoute, goBack, swipeHandlers } = usePageSwipe();
  const cart = useCart();
  const mainRef = useRef<HTMLElement>(null);
  const previousPathname = useRef(location.pathname);
  const restoringScroll = useRef(false);
  const restoreVersion = useRef(0);
  const routeId = `${location.pathname}${location.search}`;

  // Нативная compositor-анимация без remount и без transform: fixed CTA внутри
  // страниц остаются привязаны к viewport даже во время перехода.
  useLayoutEffect(() => {
    if (previousPathname.current === location.pathname) return;
    previousPathname.current = location.pathname;
    const main = mainRef.current;
    if (!main) return;
    // Проверки на «уменьшить движение» здесь нет намеренно: этот переход и так
    // всего лишь проявление, без единого пикселя движения — то самое, чем
    // движение положено заменять. Раньше он при этой настройке отключался
    // целиком, и смена страницы происходила вообще без обратной связи.
    //
    // Считаем кадры сами, а не через main.animate: Web Animations API — такая
    // же декларативная анимация, как CSS-переход, и на устройствах с
    // выключенной системной анимацией она не проигрывается (см. lib/motion).
    const cancel = animateOpacity(main, 0.72, 1, 180, () => { main.style.opacity = ""; });
    return () => { cancel(); main.style.opacity = ""; };
  }, [location.pathname]);

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
      {/* Тёмная подложка верхней зоны (статус-бар/Telegram-хром) на ВСЕХ экранах:
          красит вырез safe-area цветом шапки (index.css .hero-top-inset), чтобы верх
          был цельным тёмным, без белой полосы. Высота = --app-content-top-offset
          (0 вне fullscreen → невидима, ничего не смещает). */}
      <div aria-hidden className="hero-top-inset lg:hidden" />
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
        className="pb-nav flex-1 overflow-y-auto px-4 pt-3 lg:px-8 lg:pb-12 lg:pt-6"
      >
        <div className="lg:mx-auto lg:w-full lg:max-w-[1320px]">
          <Outlet />
        </div>
      </main>
      <CartBar />
      <BottomNav />
    </div>
  );
}
