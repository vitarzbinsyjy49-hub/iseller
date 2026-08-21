/** Переход между маршрутами (v5.6.0) — работа с DOM.
 *
 *  Чистая логика (направление, длительности, смещения) живёт в
 *  lib/routeTransition и тестируется без браузера. Здесь только то, что без DOM
 *  не проверить: снимок уходящего экрана и сама анимация.
 *
 *  ===== Как это устроено =====
 *
 *  Переход показывает ДВА слоя одновременно, иначе между экранами видно пустоту
 *  и движение читается как подвисание, а не как навигация.
 *
 *  - Входящий слой — настоящий <main>. Его двигает transform.
 *  - Уходящий слой — инертный КЛОН содержимого <main>, снятый до того, как
 *    React подменил экран, и положенный поверх (.route-ghost). Клон не знает ни
 *    про React, ни про роутер: это застывший кадр, который просто уезжает.
 *
 *  Снимок нужен потому, что React заменяет DOM синхронно, и к моменту, когда об
 *  этом можно узнать из эффекта, старого экрана в документе уже нет. Поэтому
 *  адрес и то, что показано, разведены: App рендерит `displayed`, а не
 *  `location`, и переключается на новый маршрут только после того, как кадр снят.
 *
 *  ===== Почему transform на <main> снова можно =====
 *
 *  Раньше направленной анимации здесь не было ровно по одной причине: элемент с
 *  transform становится содержащим блоком для потомков с position:fixed, и
 *  нижние панели внутри страниц (.cta-dock карточки товара, строка ввода AI,
 *  кнопка заявки) на время перехода отвязались бы от экрана и прыгнули.
 *
 *  Панели больше не переписываются в исходниках — их на время перехода
 *  прибивает pinDocks/pinLiveDocks: fixed заменяется на absolute по ЗАМЕРЕННЫМ
 *  координатам, то есть визуально ничего не меняется, а панель начинает ехать
 *  вместе со своим экраном (так и правильно: она принадлежит странице). После
 *  перехода inline-стили снимаются, и панель снова обычная fixed.
 *
 *  Панели вне <main> (BottomNav, CartBar, тосты) не трогаются вовсе — это
 *  оболочка приложения, она при переходе стоит на месте.
 *
 *  ===== Почему кадры считаются вручную =====
 *
 *  Та же причина, что и во всём lib/motion: на части устройств система гасит
 *  ВСЮ декларативную анимацию — CSS-переходы, CSS-анимации и Web Animations
 *  API — целиком до нуля. Переход, отданный браузеру, там просто не проиграется,
 *  и отличить это со стороны кода нечем.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { useNavigationType, type Location } from "react-router-dom";
import { animateOpacity, easeOutQuint, prefersReducedMotion } from "./motion";
import {
  DIM_OPACITY,
  dimsExitingLayer,
  resolveRouteMotion,
  routeMotionDuration,
  routeMotionOffsets,
  type HistoryAction,
  type RouteMotion,
} from "./routeTransition";

/** То, чем заменяется движение при «уменьшить движение»: проявление без единого
 *  пикселя смещения. Ноль здесь недопустим — мгновенная подмена и есть то
 *  «ничего», от которого мы уходим. */
const FALLBACK_FADE_FROM = 0.72;
const FALLBACK_FADE_MS = 180;

/** Идущий переход. Модульный, а не в ref: новая навигация может начаться
 *  посреди предыдущей, и её кадры надо оборвать и прибраться ДО того, как
 *  начнётся следующая, иначе на экране останется чужой клон. */
let running: { cancel: () => void } | null = null;

/** Что внутри страницы приколочено к экрану и потому пострадает от transform.
 *
 *  Отбор идёт по ФАКТУ (вычисленный position), а не по списку известных
 *  классов. Сначала здесь стоял `.cta-dock` — и мимо прошли полноэкранный слой
 *  легендарного товара и его собственная нижняя панель: у них того класса нет,
 *  он там снят намеренно. Список классов пришлось бы дополнять каждый раз,
 *  когда на какой-нибудь странице появится ещё одна прилипшая панель, а
 *  забытое дополнение проявилось бы кривым переходом на одном экране из
 *  пятнадцати.
 *
 *  Селектор при этом остаётся классовым и дешёвым: `.fixed` — утилита Tailwind,
 *  которой такие элементы и объявляются, `.cta-dock` — на случай панели,
 *  получающей position только из CSS. Перебирать всех потомков <main> с
 *  getComputedStyle нельзя: на витрине это тысячи узлов, и переход начинался бы
 *  с потерянного кадра.
 */
const PINNABLE_SELECTOR = ".cta-dock, .fixed";

/** Выше этого z-index лежит оболочка приложения (BottomNav 40, CartBar 30). */
const SHELL_Z = 40;

function isFixed(el: Element): boolean {
  return getComputedStyle(el).position === "fixed";
}

/** Прибить элемент к координатам, в которых он сейчас нарисован.
 *  `originTop`/`originLeft` — точка отсчёта будущего absolute-родителя.
 *
 *  Размеры фиксируем оба. Только ширины хватало панели, которая тянется снизу,
 *  но полноэкранный слой объявлен через inset:0 — у него высоту задаёт `bottom`,
 *  и, сняв его, мы схлопнули бы слой в полоску. */
function pinTo(el: HTMLElement, rect: DOMRect, originLeft: number, originTop: number) {
  el.style.position = "absolute";
  el.style.left = `${rect.left - originLeft}px`;
  el.style.top = `${rect.top - originTop}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
  el.style.right = "auto";
  el.style.bottom = "auto";
}

/** Снимок уходящего экрана. Возвращает элемент в body или null, если снимать
 *  нечего (нулевые размеры — например, вкладка свёрнута). */
function captureGhost(main: HTMLElement): HTMLElement | null {
  const rect = main.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;

  const cs = getComputedStyle(main);
  const ghost = document.createElement("div");
  ghost.className = "route-ghost";
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.top = `${rect.top}px`;
  ghost.style.left = `${rect.left}px`;
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;

  const inner = document.createElement("div");
  // Горизонтальные поля контента задаёт padding самого <main>. Клон лежит в
  // своей коробке, и без них текст уехал бы вплотную к краю экрана.
  inner.style.paddingLeft = cs.paddingLeft;
  inner.style.paddingRight = cs.paddingRight;
  inner.style.paddingTop = cs.paddingTop;
  // Позиция прокрутки: сдвигаем содержимое вверх ровно на scrollTop, чтобы в
  // кадре было видно то же, что видел пользователь, а не начало страницы.
  // Отрицательный margin, а не transform: transform сделал бы inner содержащим
  // блоком, и прибитые ниже панели отсчитывались бы от него, а не от ghost.
  inner.style.marginTop = `${-main.scrollTop}px`;
  for (const child of Array.from(main.children)) inner.appendChild(child.cloneNode(true));
  ghost.appendChild(inner);

  // Панели в клоне остались бы fixed — то есть привязанными к экрану, а не к
  // снимку: они не уехали бы вместе с ним и продублировали бы панель нового
  // экрана. Замеры берём с ЖИВЫХ панелей (у клона ещё нет раскладки).
  const live = main.querySelectorAll<HTMLElement>(PINNABLE_SELECTOR);
  const copies = ghost.querySelectorAll<HTMLElement>(PINNABLE_SELECTOR);
  live.forEach((el, i) => {
    const copy = copies[i];
    if (!copy || !isFixed(el)) return;
    pinTo(copy, el.getBoundingClientRect(), rect.left, rect.top);
  });

  document.body.appendChild(ghost);
  return ghost;
}

/** Прибить панели ВХОДЯЩЕГО экрана, чтобы они ехали вместе с ним.
 *  Возвращает функцию отката — она обязана вызваться в любом исходе. */
function pinLiveDocks(main: HTMLElement): () => void {
  const docks = Array.from(main.querySelectorAll<HTMLElement>(PINNABLE_SELECTOR)).filter(isFixed);
  if (docks.length === 0) return () => {};

  const rect = main.getBoundingClientRect();
  const previousStyles = docks.map((el) => el.getAttribute("style"));
  const previousPosition = main.style.position;
  const previousZ = main.style.zIndex;
  let maxZ = 0;

  docks.forEach((el) => {
    const r = el.getBoundingClientRect();
    maxZ = Math.max(maxZ, Number(getComputedStyle(el).zIndex) || 0);
    // Абсолютный потомок скролл-контейнера отсчитывается от его СОДЕРЖИМОГО, а
    // не от видимой части, поэтому к экранной координате добавляем прокрутку.
    pinTo(el, r, rect.left, rect.top - main.scrollTop);
  });
  // Точка отсчёта для absolute — сам <main>. Он flex-элемент со скроллом,
  // position:relative на нём ничего не смещает.
  main.style.position = "relative";

  // transform делает <main> отдельным контекстом наложения, и z-index его
  // потомков перестаёт что-либо значить снаружи: слой, который в покое лежал
  // ПОВЕРХ нижней навигации (полноэкранный экран легендарного товара, z-50),
  // на время перехода уехал бы под неё. Поднимаем сам <main> до высоты этого
  // слоя — но только если такой слой есть, иначе обычная страница на время
  // перехода наползала бы на навигацию, которой положено стоять на месте.
  if (maxZ >= SHELL_Z) main.style.zIndex = String(maxZ);

  return () => {
    docks.forEach((el, i) => {
      const prev = previousStyles[i];
      if (prev === null) el.removeAttribute("style");
      else el.setAttribute("style", prev);
    });
    main.style.position = previousPosition;
    main.style.zIndex = previousZ;
  };
}

function runTransition(motion: RouteMotion, ghost: HTMLElement | null, main: HTMLElement) {
  const duration = routeMotionDuration(motion);
  const { enter, exit } = routeMotionOffsets(motion);

  // Скрытый документ не выдаёт кадры: requestAnimationFrame в нём не вызывается
  // вообще. Начинать анимацию здесь значит гарантированно застрять на первом
  // кадре — экран остался бы сдвинутым и без нажатий до возвращения в приложение.
  // Показывать всё равно нечего, поэтому просто ставим конечное состояние.
  if (document.hidden) {
    ghost?.remove();
    return;
  }

  let dim: HTMLElement | null = null;
  if (ghost && dimsExitingLayer(motion)) {
    dim = document.createElement("div");
    dim.className = "route-ghost__dim";
    ghost.appendChild(dim);
  }

  const unpin = pinLiveDocks(main);
  const previous = {
    transform: main.style.transform,
    willChange: main.style.willChange,
    pointerEvents: main.style.pointerEvents,
  };
  main.style.willChange = "transform";
  // Экран едет — нажатия по нему в этот момент адресованы не тому, что под
  // пальцем. 240 мс без реакции честнее, чем срабатывание не по той карточке.
  main.style.pointerEvents = "none";

  let raf = 0;
  let watchdog = 0;
  const started = performance.now();

  const finish = () => {
    cancelAnimationFrame(raf);
    window.clearTimeout(watchdog);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    main.style.transform = previous.transform;
    main.style.willChange = previous.willChange;
    main.style.pointerEvents = previous.pointerEvents;
    unpin();
    ghost?.remove();
    if (running?.cancel === finish) running = null;
  };

  // Приложение свернули посреди перехода — кадры прекратятся на любом месте
  // дуги. Досматривать нечего: доводим до конца сразу, чтобы возвращение не
  // застало сдвинутый экран.
  function onVisibilityChange() {
    if (document.hidden) finish();
  }
  document.addEventListener("visibilitychange", onVisibilityChange);

  // Страховка на случай, когда кадры прекратились, а visibilitychange не
  // пришёл (сон устройства, throttling вебвью). Таймеры в фоне тоже
  // придушены, но, в отличие от rAF, срабатывают — экран не останется
  // заблокированным навсегда. Запас поверх длительности намеренно щедрый:
  // сработать раньше самой анимации этот таймер не должен.
  watchdog = window.setTimeout(finish, duration + 400);

  const frame = (now: number) => {
    const t = Math.min(1, (now - started) / duration);
    const eased = easeOutQuint(t);
    main.style.transform = `translate3d(${enter * (1 - eased)}%, 0, 0)`;
    if (ghost) ghost.style.transform = `translate3d(${exit * eased}%, 0, 0)`;
    if (dim) dim.style.opacity = `${DIM_OPACITY * eased}`;
    if (t >= 1) return finish();
    raf = requestAnimationFrame(frame);
  };

  // Стартовое положение ставим синхронно, ДО первого rAF: иначе между коммитом
  // нового экрана и первым кадром успевает нарисоваться кадр, где он уже на
  // месте, и переход начинается со вспышки.
  main.style.transform = `translate3d(${enter}%, 0, 0)`;
  if (ghost) ghost.style.transform = "translate3d(0, 0, 0)";
  raf = requestAnimationFrame(frame);

  running = { cancel: finish };
}

/** Что показывать вместо адреса из роутера.
 *
 *  App рендерит `<Routes location={useRouteTransition(location)}>`. Возвращаемый
 *  маршрут отстаёт от настоящего ровно на один рендер — именно в этот зазор
 *  снимается кадр уходящего экрана.
 */
export function useRouteTransition(location: Location): Location {
  const [displayed, setDisplayed] = useState(location);
  const navigationType = useNavigationType() as HistoryAction;
  const pending = useRef<RouteMotion | null>(null);
  const ghost = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    // Фаза 1. Адрес сменился, а в документе ещё СТАРЫЙ экран (рендерится
    // displayed) — единственный момент, когда его можно снять.
    if (location.key !== displayed.key) {
      running?.cancel();
      // Редирект посреди перехода (деплинк, нормализация адреса) приводит сюда
      // второй раз до того, как снятый кадр успел уехать. Старый снимок тогда
      // остался бы в документе навсегда — его никто больше не держит.
      ghost.current?.remove();
      ghost.current = null;
      const motion = prefersReducedMotion()
        ? ({ kind: "none" } as const)
        : resolveRouteMotion(displayed.pathname, location.pathname, navigationType);
      const main = document.querySelector("main");
      if (main instanceof HTMLElement && motion.kind !== "none") {
        ghost.current = captureGhost(main);
      }
      pending.current = motion;
      setDisplayed(location);
      return;
    }

    // Фаза 2. Новый экран уже в документе — двигаем.
    const motion = pending.current;
    if (!motion) return;
    pending.current = null;
    const captured = ghost.current;
    ghost.current = null;

    const main = document.querySelector("main");
    if (!(main instanceof HTMLElement)) {
      captured?.remove();
      return;
    }
    if (motion.kind === "none") {
      captured?.remove();
      // Скрытый документ — см. runTransition: кадров не будет, и экран остался
      // бы полупрозрачным до возвращения в приложение.
      if (document.hidden) return;
      // Проверки на «уменьшить движение» здесь нет намеренно: это проявление
      // без движения — ровно то, чем движение положено заменять. Без него смена
      // экрана происходила бы вообще без обратной связи.
      const cancel = animateOpacity(main, FALLBACK_FADE_FROM, 1, FALLBACK_FADE_MS, () => {
        main.style.opacity = "";
      });
      running = { cancel: () => { cancel(); main.style.opacity = ""; running = null; } };
      return;
    }
    runTransition(motion, captured, main);
  }, [location, displayed, navigationType]);

  // Размонтирование посреди перехода (перезагрузка приложения, ошибка) не должно
  // оставлять на экране застывший клон.
  useLayoutEffect(() => () => {
    running?.cancel();
    ghost.current?.remove();
    ghost.current = null;
  }, []);

  return displayed;
}
