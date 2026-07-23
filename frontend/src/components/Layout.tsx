import { Outlet, useLocation } from "react-router-dom";
import BottomNav from "./BottomNav";
import DesktopHeader from "./DesktopHeader";

/** ResponsiveShell — каркас приложения.
 *  Mobile (<1024px): как раньше — контент + фиксированная нижняя навигация.
 *  Desktop (>=1024px): sticky DesktopHeader сверху (вне зоны скролла = всегда
 *  виден), контент в контейнере max-w-[1320px], BottomNav скрыт (lg:hidden).
 *  key={pathname} перезапускает CSS-анимацию page-enter при переходе (220ms). */
export default function Layout() {
  const location = useLocation();
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
        className="page-enter pb-nav flex-1 overflow-y-auto px-4 pt-3 lg:px-8 lg:pb-12 lg:pt-6"
      >
        <div className="lg:mx-auto lg:w-full lg:max-w-[1320px]">
          <Outlet />
        </div>
      </main>
      <BottomNav />
    </div>
  );
}
