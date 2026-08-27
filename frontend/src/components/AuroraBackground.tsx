/** Живой фон: три мягких пятна, медленно плывущие под контентом, и цвет верха
 *  Telegram под ними.
 *
 *  Стили — в `index.css` (класс `.aurora` и соседние): там же живёт правило
 *  «уменьшение движения», и держать анимацию рядом с остальными правилами
 *  движения проще, чем искать её в компоненте.
 *
 *  Показывается НЕ везде. Фон работает на впечатление там, где человек
 *  осматривается — главная, экран AI, профиль, баллы, информация. В каталоге,
 *  избранном, корзине и оформлении заявки его нет: там плотная сетка карточек,
 *  фон виден только в щелях между ними, а движется под тем, что человек листает
 *  и сравнивает. Цена есть, картинки нет.
 *
 *  Палитра у экранов РАЗНАЯ, и это единственное, чем они отличаются: сама
 *  композиция (размеры, позиции, циклы) общая, иначе экраны перестали бы быть
 *  одним приложением. Оттенок отвечает содержанию: бренд на главной, холодный
 *  индиго на AI, тёплый закат на баллах и профиле, тихий синий на справке.
 */
import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { setTopColor } from "../lib/telegram";

/** Вариант палитры → селектор `[data-variant]` в index.css. */
export type AuroraVariant = "brand" | "ai" | "warm" | "calm";

/** Цвет верхней плашки Telegram идёт В ПАРЕ с палитрой пятен и живёт здесь же.
 *  Разъехаться им негде: раньше цвет был один на всё приложение (#f6f7f9,
 *  ровно фон страницы) — и как только под шапкой появился цветной фон, серая
 *  плашка Telegram стала отдельной деталью со швом. Каждый оттенок — примерно
 *  половина силы верхней полосы своих пятен: шапка чуть светлее страницы, будто
 *  свет падает сверху, а не отдельный элемент. Все значения светлые: по ним
 *  Telegram выбирает тёмные значки кнопок, и «Закрыть» остаётся читаемым. */
export type AuroraScheme = { variant: AuroraVariant; header: string };

/** Верх вне «живых» экранов — цвет страницы, как и был (--app-header-color). */
export const DEFAULT_HEADER = "#f6f7f9";

/** Маршруты с живым фоном. Точное совпадение, без вложенных путей: /ai — да,
 *  /ai/что-то-ещё — решать отдельно, когда такой экран появится. */
const AURORA_BY_ROUTE: Record<string, AuroraScheme> = {
  "/": { variant: "brand", header: "#e9f1f8" },
  "/ai": { variant: "ai", header: "#ecedf9" },
  "/profile": { variant: "warm", header: "#f8f0e9" },
  "/loyalty": { variant: "warm", header: "#f8f0e9" },
  "/info": { variant: "calm", header: "#edf3f8" },
};

/** Схема экрана или null, если на нём живого фона нет. */
export function auroraFor(pathname: string): AuroraScheme | null {
  return AURORA_BY_ROUTE[pathname] ?? null;
}

export function hasAurora(pathname: string): boolean {
  return auroraFor(pathname) !== null;
}

/** Цвет верха для маршрута — всегда определён: без фона это цвет страницы. */
export function headerColorFor(pathname: string): string {
  return auroraFor(pathname)?.header ?? DEFAULT_HEADER;
}

export default function AuroraBackground() {
  const { pathname } = useLocation();
  const scheme = auroraFor(pathname);

  // Верх перекрашивается на КАЖДОЙ смене маршрута, включая уход на экран без
  // фона: иначе тёплая шапка профиля осталась бы висеть над серым каталогом.
  useEffect(() => setTopColor(headerColorFor(pathname)), [pathname]);

  if (!scheme) return null;

  return (
    <div className="aurora" data-variant={scheme.variant} aria-hidden>
      <div className="aurora-blob aurora-1" />
      <div className="aurora-blob aurora-2" />
      <div className="aurora-blob aurora-3" />
      <div className="aurora-grain" />
    </div>
  );
}
