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

/** Метки, по которым копии в снимке находят свои оригиналы. Живут только
 *  внутри одного вызова captureGhost и снимаются сразу после. */
const PIN_MARK = "data-route-pin";
const SCROLL_MARK = "data-route-scroll";

/** Ленты, прокрутку которых нужно перенести в снимок. Селектор классовый и
 *  дешёвый: перебирать всех потомков <main>, спрашивая у каждого scrollLeft,
 *  значит заставить браузер пересчитать раскладку тысячи раз. */
const SCROLLER_SELECTOR = ".no-scrollbar, [class*='overflow-x-auto'], [class*='overflow-y-auto']";

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

/** Есть ли у элемента собственный текст (а не только дети-элементы).
 *  Такой элемент разбирать на части нельзя: поверхностный клон потерял бы
 *  текст, и в снимке осталась бы пустая коробка. */
function hasOwnText(el: Element): boolean {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim()) return true;
  }
  return false;
}

/** Пустышка вместо невидимого поддерева: держит ровно то же место в раскладке,
 *  не имея ни одного потомка.
 *
 *  ПОВЕРХНОСТНЫЙ клон самого элемента, а не голый div. Сначала здесь стоял div
 *  с той же шириной и высотой — и раскладка поехала: вместе с элементом
 *  терялись его классы, а с ними внешние отступы, display и место в сетке. Всё,
 *  что ниже пропущенного блока, поднималось вверх; на главной картинка уезжала
 *  на тысячу с лишним пикселей. Свой тег и свои классы элемент сохраняет —
 *  меняется только то, что внутри него ничего нет.
 *
 *  Размеры прибиваем инлайном: содержимого, которое их задавало, больше нет.
 *  flex тоже — иначе растягивающийся потомок займёт не своё место. */
function frozen(source: Element, rect: DOMRect): Element {
  const el = source.cloneNode(false) as Element;
  // Картинке за кадром незачем оставаться картинкой: браузер декодировал бы её
  // ради снимка, в котором она не видна.
  if (el instanceof HTMLImageElement) {
    el.removeAttribute("src");
    el.removeAttribute("srcset");
  }
  if (el instanceof HTMLElement) {
    el.style.width = `${rect.width}px`;
    el.style.height = `${rect.height}px`;
    el.style.flex = "0 0 auto";
  }
  return el;
}

/** Клонировать только то, что попадает в кадр.
 *
 *  Снимок показывает ОДИН экран, а копировался весь документ страницы: на
 *  главной это 3186 узлов и 96 картинок, то есть около 17 мс на настольной
 *  машине и втрое-впятеро больше на телефоне — целая пачка кадров, потерянных
 *  ровно в тот момент, когда начинается движение. Рывок при заходе в товар из
 *  поиска на главной был именно этим.
 *
 *  Поэтому: то, что за пределами кадра, превращается в распорку той же
 *  величины. Видимая часть клонируется как была — на неё и смотрят. Уехавшее
 *  за край при движении снимка не открывается: он смещается целиком, вместе со
 *  своей коробкой, и новых областей внутри него не появляется.
 *
 *  Вглубь идём только по большим контейнерам: разбирать на части плитку товара
 *  дороже, чем скопировать её целиком.
 */
const MAX_PRUNE_DEPTH = 8;

function cloneInFrame(source: Element, view: DOMRect, depth: number): Node {
  const rect = source.getBoundingClientRect();

  // display:none — копируем оболочку без содержимого. Такой узел не рисует
  // ничего ни сам, ни через потомков, и места в раскладке не занимает.
  //
  // Это оказалось самой дорогой утечкой: разметка держит целую desktop-колонку
  // под `hidden lg:block`, и на телефоне она невидима, но существует — 1879
  // узлов с полными сетками товаров внутри. Проверка на «за кадром» её не
  // ловила: у скрытого элемента прямоугольник нулевой, то есть формально он и
  // не снаружи кадра. Вычисленный стиль спрашиваем только у нулевых по размеру
  // — их единицы, и лишней работы это не создаёт.
  if (rect.width === 0 && rect.height === 0 && getComputedStyle(source).display === "none") {
    return source.cloneNode(false);
  }
  const outside =
    rect.bottom <= view.top || rect.top >= view.bottom ||
    rect.right <= view.left || rect.left >= view.right;
  // Поддерево за кадром выбрасываем — но только если внутри нет прилипшей
  // панели. У такой панели собственные координаты экранные, а вот её предок
  // по потоку вполне может быть прокручен далеко за край: выбросив предка, мы
  // унесли бы вместе с ним видимую панель.
  if (outside && rect.width > 0 && rect.height > 0 && !source.querySelector(PINNABLE_SELECTOR)) {
    return frozen(source, rect);
  }

  // Разбирать имеет смысл то, что заведомо не помещается в кадр. Помимо
  // очевидного «выше/шире экрана» сюда обязательно входят ПРОКРУЧИВАЕМЫЕ ленты:
  // коробка горизонтальной карусели ровно по ширине экрана, а дети уходят
  // далеко за правый край. По размеру коробки такая лента выглядит помещающейся
  // и копировалась целиком — со всеми двумя десятками карточек, из которых
  // видно полторы.
  const overflows =
    source.scrollWidth > source.clientWidth + 4 || source.scrollHeight > source.clientHeight + 4;
  const worthSplitting =
    depth > 0 &&
    source.childElementCount > 0 &&
    !hasOwnText(source) &&
    (rect.height > view.height || rect.width > view.width || overflows);
  if (!worthSplitting) return source.cloneNode(true);

  const shell = source.cloneNode(false) as Element;
  for (const child of Array.from(source.children)) {
    shell.appendChild(cloneInFrame(child, view, depth - 1));
  }
  return shell;
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

  // Отступы живут на САМОЙ коробке снимка, а не на внутреннем слое. Коробка с
  // overflow:hidden — это область прокрутки, и именно к её границам прилипает
  // position:sticky. Пока отступ был внутри, липкая шапка каталога вставала в
  // снимке на 12px выше живой: в странице она держится за верх содержимого
  // <main>, а в снимке хваталась за верхний край коробки.
  ghost.style.boxSizing = "border-box";
  ghost.style.paddingTop = cs.paddingTop;
  // Горизонтальные поля берём из фактического положения первого потомка, а не
  // из padding самого <main>. Padding — не единственное, что сужает его
  // содержимое: на desktop там ещё scrollbar-gutter: stable both-edges,
  // резервирующий по полосе прокрутки с каждой стороны. Снимок про этот резерв
  // не знал и выходил на 30px шире оригинала — всё внутри него смещалось.
  // Замер по живому потомку воспроизводит содержимое точно, чем бы оно ни было
  // сужено.
  const firstChild = main.firstElementChild;
  if (firstChild) {
    const childRect = firstChild.getBoundingClientRect();
    ghost.style.paddingLeft = `${Math.max(0, childRect.left - rect.left)}px`;
    ghost.style.paddingRight = `${Math.max(0, rect.right - childRect.right)}px`;
  } else {
    ghost.style.paddingLeft = cs.paddingLeft;
    ghost.style.paddingRight = cs.paddingRight;
  }

  const inner = document.createElement("div");
  // Позиция прокрутки: сдвигаем содержимое вверх ровно на scrollTop, чтобы в
  // кадре было видно то же, что видел пользователь, а не начало страницы.
  // Отрицательный margin, а не transform: transform сделал бы inner содержащим
  // блоком, и прибитые ниже панели отсчитывались бы от него, а не от ghost.
  inner.style.marginTop = `${-main.scrollTop}px`;

  // Помечаем панели ДО клонирования: метка уедет в копию вместе с элементом, и
  // копия найдётся по ней, а не по порядковому номеру. Порядок ненадёжен —
  // выброшенное за кадром поддерево сдвинуло бы нумерацию, и панель прибилась
  // бы по чужим координатам.
  const live = Array.from(main.querySelectorAll<HTMLElement>(PINNABLE_SELECTOR)).filter(isFixed);
  live.forEach((el, i) => el.setAttribute(PIN_MARK, String(i)));

  // Тем же способом — прокрученные ленты. cloneNode не переносит scrollLeft, и
  // горизонтальные карусели («Хиты», «Недавно смотрели», ряд категорий) в
  // снимке отматывались бы в начало: экран уезжает, и одновременно с этим
  // ленты внутри него прыгают на первый элемент.
  const scrolled = Array.from(main.querySelectorAll<HTMLElement>(SCROLLER_SELECTOR))
    .filter((el) => el.scrollLeft !== 0 || el.scrollTop !== 0);
  scrolled.forEach((el, i) => el.setAttribute(SCROLL_MARK, String(i)));

  for (const child of Array.from(main.children)) {
    inner.appendChild(cloneInFrame(child, rect, MAX_PRUNE_DEPTH));
  }
  ghost.appendChild(inner);
  // В документ кладём ДО правок ниже: без раскладки прокрутку не выставить, а
  // getBoundingClientRect у копии панели вернул бы нули.
  document.body.appendChild(ghost);

  scrolled.forEach((el, i) => {
    el.removeAttribute(SCROLL_MARK);
    const copy = ghost.querySelector<HTMLElement>(`[${SCROLL_MARK}="${i}"]`);
    if (!copy) return;  // ленту выбросило за кадром — её и не видно
    copy.removeAttribute(SCROLL_MARK);
    copy.scrollLeft = el.scrollLeft;
    copy.scrollTop = el.scrollTop;
  });

  // Панели в клоне остались бы fixed — то есть привязанными к экрану, а не к
  // снимку: они не уехали бы вместе с ним и продублировали бы панель нового
  // экрана. Замеры берём с ЖИВЫХ панелей — у копии координаты уже свои.
  live.forEach((el, i) => {
    el.removeAttribute(PIN_MARK);
    const copy = ghost.querySelector<HTMLElement>(`[${PIN_MARK}="${i}"]`);
    if (!copy) return;
    copy.removeAttribute(PIN_MARK);
    pinTo(copy, el.getBoundingClientRect(), rect.left, rect.top);
  });

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
