import { useEffect, useRef, useState, type ReactElement } from "react";
import { Link, useLocation } from "react-router-dom";
import { preloadRoute } from "../lib/routePreload";
import { hasOpaqueDock, navSurface, supportsBackdropFilter } from "../lib/navGlass";
import { animateNumber, prefersReducedMotion } from "../lib/motion";

/** Сколько наливается стекло. Короче открытия шторки (260мс): панель не
 *  приезжает, а меняет материал — движения нет, есть проявление. */
const GLASS_FILL_MS = 220;

/** Нижняя навигация: 5 вкладок, SVG-иконки, активная — Telegram blue.
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
    to: "/requests", label: "Заявки",
    icon: (a) => (
      <svg viewBox="0 0 24 24" className="h-6 w-6" {...stroke(a)}>
        <rect x="4.5" y="3.5" width="15" height="17" rx="2.5" />
        <path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4.5" />
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

  return (
    // lg:hidden — на desktop навигация в DesktopHeader, мобильный bottom nav скрыт
    // js-bottom-nav: при открытой клавиатуре скрывается через html.kb-open (index.css)
    <nav
      ref={setNav}
      // Стартуем сплошными и отдаём атрибут useGlassFill: React ставит его
      // один раз, дальше им управляет покадровый мотор. Держать значение в
      // JSX нельзя — рендер перебивал бы кадр анимации.
      data-glass="off"
      className="js-bottom-nav nav-surface safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-border lg:hidden">
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
      <div className="mx-auto flex max-w-md justify-around py-1.5">
        {items.map((item) => {
          const isActive = item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
          return (
            <Link
              key={item.to}
              to={item.to}
              onPointerDown={() => preloadRoute(item.to)}
              onPointerEnter={() => preloadRoute(item.to)}
              aria-current={isActive ? "page" : undefined}
              className={`tap flex w-16 flex-col items-center gap-0.5 rounded-xl px-1 py-1 text-[11px] font-medium transition-colors ${
                isActive ? "text-accent" : "text-muted"
              }`}
            >
              <span className={`nav-icon flex h-7 min-w-10 items-center justify-center rounded-full ${
                isActive ? "nav-icon-active" : ""
              }`}>
                {item.icon(isActive)}
              </span>
              {/* nav-label — точка, за которую подпись прячется на коротком
                  экране (index.css). Голым текстовым узлом её не выбрать. */}
              <span className="nav-label">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
