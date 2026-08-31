/** Живой фон: четыре мягких пятна, медленно плывущие под контентом, и цвет верха
 *  Telegram под ними. Четвёртое пятно прибито к низу экрана — без него нижняя
 *  треть оставалась без цвета в части фаз анимации.
 *
 *  Стили — в `index.css` (класс `.aurora` и соседние): там же живёт правило
 *  «уменьшение движения», и держать анимацию рядом с остальными правилами
 *  движения проще, чем искать её в компоненте.
 *
 *  Показывается НЕ везде. Фон работает на впечатление там, где человек
 *  осматривается — главная, экран AI, профиль, баллы, информация; на каталоге
 *  он есть, но вдвое слабее самого тихого из них, а в карточке товара (variant
 *  "faint") — ещё вдвое тише каталога: только чтобы низ длинной страницы не
 *  уходил в белый лист. В корзине, оформлении заявки, заявках, истории и
 *  избранном фона нет вовсе: там человек занят делом от начала до конца.
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
export type AuroraVariant = "brand" | "ai" | "warm" | "calm" | "quiet" | "faint";

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
 *  /ai/что-то-ещё — решать отдельно, когда такой экран появится. Единственное
 *  исключение — карточка товара `/product/:id`, у неё динамический сегмент;
 *  она обрабатывается по префиксу ниже, в auroraFor. */
const AURORA_BY_ROUTE: Record<string, AuroraScheme> = {
  "/": { variant: "brand", header: "#e9f1f8" },
  "/ai": { variant: "ai", header: "#ecedf9" },
  "/profile": { variant: "warm", header: "#f8f0e9" },
  "/loyalty": { variant: "warm", header: "#f8f0e9" },
  "/info": { variant: "calm", header: "#edf3f8" },
  // Каталог получил фон позже остальных и намеренно самый слабый. Сначала его
  // тут не было: панель инструментов занимала четверть экрана, и добавлять
  // цвета туда, где и так тесно, значило шуметь. Панель теперь уезжает при
  // прокрутке — место появилось, и белый низ под сеткой стал заметен как
  // пустота. Но экран остаётся рабочим: цвет виден в промежутках между
  // плитками и по краям, а спорить с фотографиями товара и ценами ему нечем.
  "/catalog": { variant: "quiet", header: "#f2f5f8" },
};

/** Карточка товара — самый слабый фон приложения. Страница длинная и плотная
 *  (галерея, характеристики, липкая кнопка), спорить с фото товара фону нельзя;
 *  вся его работа — чтобы низ под характеристиками не читался как белый лист. */
const PRODUCT_SCHEME: AuroraScheme = { variant: "faint", header: "#eef2f7" };

/** Схема экрана или null, если на нём живого фона нет. */
export function auroraFor(pathname: string): AuroraScheme | null {
  const exact = AURORA_BY_ROUTE[pathname];
  if (exact) return exact;
  // Карточка товара — единственный путь с фоном по префиксу, а не по точному
  // совпадению: id в сегменте. Сам раздел `/product` без id фона не получает.
  if (pathname.startsWith("/product/")) return PRODUCT_SCHEME;
  return null;
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
      <div className="aurora-blob aurora-4" />
      <div className="aurora-grain" />
    </div>
  );
}
