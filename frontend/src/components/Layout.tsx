import { useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import BottomNav from "./BottomNav";
import DesktopHeader from "./DesktopHeader";
import { usePageSwipe } from "../lib/usePageSwipe";
import { setBackButton } from "../lib/telegram";

/** ResponsiveShell — каркас приложения.
 *  Mobile (<1024px): как раньше — контент + фиксированная нижняя навигация.
 *  Desktop (>=1024px): sticky DesktopHeader сверху (вне зоны скролла = всегда
 *  виден), контент в контейнере max-w-[1320px], BottomNav скрыт (lg:hidden).
 *  key={pathname} перезапускает CSS-анимацию входа страницы при переходе.
 *
 *  v5.5.0: свайп-навигация. Жест слушаем на <main>, потому что это единственный
 *  общий контейнер контента, живущий между переходами (BottomNav и шапка — вне
 *  его, их собственные жесты навигацию не трогают). Направление жеста выбирает
 *  анимацию въезда: обычный переход — прежний fade, свайп — сдвиг с той
 *  стороны, откуда страницу «тянули». */
export default function Layout() {
  const location = useLocation();
  const { enterAnimation, isTabRoute, goBack, swipeHandlers } = usePageSwipe();

  // Нативная кнопка «Назад» Telegram — на вложенных экранах, тем же переходом,
  // что и свайп от края. На корневых вкладках её нет: возвращаться некуда.
  useEffect(() => setBackButton(isTabRoute ? null : goBack), [isTabRoute, location.key]);

  const enterClass =
    enterAnimation === "from-right" ? "page-enter-right"
      : enterAnimation === "from-left" ? "page-enter-left"
      : "page-enter";

  return (
    <div className="flex h-full flex-col">
      {/* Тёмная подложка верхней зоны (статус-бар/Telegram-хром) на ВСЕХ экранах:
          красит вырез safe-area цветом шапки (index.css .hero-top-inset), чтобы верх
          был цельным тёмным, без белой полосы. Высота = --app-content-top-offset
          (0 вне fullscreen → невидима, ничего не смещает). */}
      <div aria-hidden className="hero-top-inset lg:hidden" />
      <DesktopHeader />
      <main
        key={location.pathname}
        {...swipeHandlers}
        className={`${enterClass} pb-nav flex-1 overflow-y-auto px-4 pt-3 lg:px-8 lg:pb-12 lg:pt-6`}
      >
        <div className="lg:mx-auto lg:w-full lg:max-w-[1320px]">
          <Outlet />
        </div>
      </main>
      <BottomNav />
    </div>
  );
}
