import { Outlet, useLocation } from "react-router-dom";
import BottomNav from "./BottomNav";

/** Каркас Mini App: контент + нижняя навигация.
 *  key={pathname} перезапускает CSS-анимацию page-enter при переходе (220ms). */
export default function Layout() {
  const location = useLocation();
  return (
    <div className="flex h-full flex-col">
      <main key={location.pathname} className="page-enter flex-1 overflow-y-auto px-4 pb-28 pt-3">
        <Outlet />
      </main>
      <BottomNav />
    </div>
  );
}
