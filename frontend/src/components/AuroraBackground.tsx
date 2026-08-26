/** Живой фон: три мягких пятна в цветах бренда, медленно плывущие под контентом.
 *
 *  Стили — в `index.css` (класс `.aurora` и соседние): там же живёт правило
 *  «уменьшение движения», и держать анимацию рядом с остальными правилами
 *  движения проще, чем искать её в компоненте.
 *
 *  Показывается НЕ везде. Фон работает на впечатление там, где человек
 *  осматривается — на главной и на экране AI. В каталоге, корзине и оформлении
 *  заявки человек занят делом, и цветное движение под списком товаров ему
 *  мешает, а не радует. Список маршрутов один и лежит здесь: разъехаться ему
 *  негде.
 */
import { useLocation } from "react-router-dom";

/** Маршруты, на которых фон включён. Точное совпадение, без вложенных путей:
 *  /ai — да, /ai/что-то-ещё — решать отдельно, когда такой экран появится. */
const ROUTES_WITH_AURORA = new Set(["/", "/ai"]);

export function hasAurora(pathname: string): boolean {
  return ROUTES_WITH_AURORA.has(pathname);
}

export default function AuroraBackground() {
  const { pathname } = useLocation();
  if (!hasAurora(pathname)) return null;

  return (
    <div className="aurora" aria-hidden>
      <div className="aurora-blob aurora-1" />
      <div className="aurora-blob aurora-2" />
      <div className="aurora-blob aurora-3" />
      <div className="aurora-grain" />
    </div>
  );
}
