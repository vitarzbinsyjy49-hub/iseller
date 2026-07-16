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
      <DesktopHeader />
      <main
        key={location.pathname}
        className="page-enter flex-1 overflow-y-auto px-4 pb-28 pt-3 lg:px-8 lg:pb-12 lg:pt-6"
      >
        <div className="lg:mx-auto lg:w-full lg:max-w-[1320px]">
          <Outlet />
        </div>
      </main>
      <BottomNav />
    </div>
  );
}
