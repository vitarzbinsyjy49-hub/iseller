import { useEffect, useRef, useState, type ReactElement } from "react";
import { Link, useLocation } from "react-router-dom";
import { preloadRoute } from "../lib/routePreload";
import { hasOpaqueDock, navSurface, supportsBackdropFilter } from "../lib/navGlass";
import { animateNumber, prefersReducedMotion } from "../lib/motion";
import { catalogSearchRoute } from "../lib/searchRoutes";
import { useLeadsBadge } from "../store/leadsBadge";

/** Сколько наливается стекло. Короче открытия шторки (260мс): панель не
 *  приезжает, а меняет материал — движения нет, есть проявление. */
const GLASS_FILL_MS = 220;

/** Нижняя навигация: 4 вкладки, SVG-иконки, активная — Telegram blue.
 *  Сознательно НЕ используем NavLink: обычный Link + useLocation дают тот же
 *  active-state без NavLinkWithRef (у NavLink были крэши hasValidRef при
 *  расхождении версий react-router-dom/React в чужих окружениях). */

type Item = { to: string; label: string; icon: (active: boolean) => ReactElement };

const stroke = (active: boolean) => ({
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: active ? 2.2 : 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

/** Дописывает `focus=search` к маршруту, каким бы он ни был — включая уже
 *  готовый `?query=...`. Строковая конкатенация `${route}?focus=search`
 *  ломается ровно в день, когда catalogSearchRoute() начнёт возвращать
 *  собственный `?`; URLSearchParams этого не боится. */
function withSearchFocus(route: string): string {
  const [path, search] = route.split("?");
  const qs = new URLSearchParams(search);
  qs.set("focus", "search");
  return `${path}?${qs.toString()}`;
}

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
    icon: (a) => (
      <svg viewBox="0 0 24 24" className="h-6 w-6" {...stroke(a)}>
        <path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" />
      </svg>
    ),
  },
  {
    to: "/catalog", label: "Каталог",
    icon: (a) => (
      <svg viewBox="0 0 24 24" className="h-6 w-6" {...stroke(a)}>
        <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
        <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
      </svg>
    ),
  },
  {
    to: "/ai", label: "AI",
    icon: (a) => (
      <svg viewBox="0 0 24 24" className="h-6 w-6" {...stroke(a)}>
        <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
        <circle cx="12" cy="12" r="4" />
      </svg>
    ),
  },
  {
    to: "/profile", label: "Профиль",
    icon: (a) => (
      <svg viewBox="0 0 24 24" className="h-6 w-6" {...stroke(a)}>
        <circle cx="12" cy="8" r="3.6" /><path d="M4.8 20c1.3-3.2 4-4.8 7.2-4.8s5.9 1.6 7.2 4.8" />
      </svg>
    ),
  },
];

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

export default function BottomNav() {
  const { pathname } = useLocation();
  const surface = useNavSurface(pathname);
  const [nav, setNav] = useState<HTMLElement | null>(null);
  useGlassFill(nav, surface);
  const leadUnseen = useLeadsBadge((s) => s.unseen);
  const refreshLeads = useLeadsBadge((s) => s.refresh);
  // Панель живёт в Layout и переживает переходы, поэтому запрос один на сессию,
  // а не на каждый заход в профиль. Профиль читает тот же стор.
  useEffect(() => { void refreshLeads(); }, [refreshLeads]);

  return (
    // lg:hidden — на desktop навигация в DesktopHeader, мобильный bottom nav скрыт
    // js-bottom-nav: при открытой клавиатуре скрывается через html.kb-open (index.css)
    <nav
      ref={setNav}
      // Стартуем сплошными и отдаём атрибут useGlassFill: React ставит его
      // один раз, дальше им управляет покадровый мотор. Держать значение в
      // JSX нельзя — рендер перебивал бы кадр анимации.
      data-glass="off"
      className="js-bottom-nav nav-row fixed z-40 flex items-center gap-2 lg:hidden">
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
      <div className="nav-surface nav-pill flex flex-1 justify-around py-1.5">
        {items.map((item) => {
          const isActive = item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
          return (
            <Link
              key={item.to}
              to={item.to}
              onPointerDown={() => preloadRoute(item.to)}
              onPointerEnter={() => preloadRoute(item.to)}
              aria-current={isActive ? "page" : undefined}
              className={`nav-tab tap flex w-16 flex-col items-center gap-0.5 px-1 py-1 text-[11px] font-medium transition-colors ${
                isActive ? "nav-tab-active text-accent" : "text-muted"
              }`}
            >
              <span className="nav-icon relative flex h-7 min-w-10 items-center justify-center rounded-full">
                {item.icon(isActive)}
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
              {/* Визуальная точка (выше) для скринридера невидима — доносим тот
                  же смысл текстом. Placement ПОСЛЕ nav-label, а не рядом с
                  точкой: экранный читалка проговаривает DOM-порядок, и текст
                  должен идти сразу за «Профиль», а не перед ним. Запятая в
                  начале — чтобы две фразы не слиплись в одну. */}
              {item.to === "/profile" && leadUnseen > 0 && (
                <span className="sr-only">, есть непросмотренные изменения по заявкам</span>
              )}
            </Link>
          );
        })}
      </div>
      {/* Круг поиска — вторая точка ряда, как у Telegram. Поиск становится
          доступен с КАЖДОГО экрана, а не только с главной и каталога, и
          оказывается под большим пальцем. Маршрут берётся из searchRoutes.ts:
          строка всегда ищет по каталогу, и второго обработчика здесь не
          заводится.

          Метка focus=search дописывается через URLSearchParams, а не
          строковой конкатенацией: catalogSearchRoute() существует именно
          затем, чтобы решать, какие параметры уйдут в URL (сегодня — только
          `query`), и наращивать её результат через "?" вручную означало бы
          держать здесь предположение о её форме, которое переживёт хелпер
          на день его изменения и тихо соберёт битый адрес. */}
      <Link
        to={withSearchFocus(catalogSearchRoute(""))}
        onPointerDown={() => preloadRoute("/catalog")}
        aria-label="Поиск"
        className="nav-surface nav-circle tap flex h-14 w-14 shrink-0 items-center justify-center text-muted"
      >
        <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor"
             strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
        </svg>
      </Link>
    </nav>
  );
}
