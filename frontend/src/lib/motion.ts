/** Единая точка решения про движение в интерфейсе.
 *
 *  Зачем модуль. Настройка «уменьшить движение» решалась в шести местах
 *  независимо, и четыре из них отвечали одинаково неверно: «тогда не делаем
 *  ничего». Так интерфейс терял не анимацию, а обратную связь — человек
 *  переставал понимать, что вообще произошло. Симптом при этом каждый раз
 *  выглядел как отдельная поломка отдельной фичи («лента не листается», «шит
 *  открывается рывком»), и связь между ними была не видна.
 *
 *  Правило одно: «убрать движение» — это НЕ «убрать событие». Поэтому здесь нет
 *  и не может быть варианта «ничего»: `transitionStyle` отдаёт либо движение,
 *  либо затухание. Прежнее правило жило в комментариях, и каждая новая фича
 *  решала заново — этот модуль делает его механизмом.
 *
 *  Читать настройку напрямую через matchMedia в компонентах больше не нужно:
 *  всё, что от неё зависит, спрашивает здесь.
 */

/** Как показать смену состояния. `none` отсутствует намеренно, см. выше. */
export type TransitionStyle = "move" | "fade";

/** Длительность затухания — замены движению. Короче, чем сам сдвиг: затухание
 *  не несёт информации о направлении, и растягивать его незачем. */
export const FADE_MS = 160;

/** Включена ли у пользователя «уменьшить движение».
 *
 *  Читается на каждый вызов, а не один раз при загрузке: настройку меняют прямо
 *  во время работы (в iOS это переключатель в шторке), и закэшированное значение
 *  означало бы, что до перезапуска приложения оно игнорируется.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Чем показывать смену состояния при текущих настройках. */
export function transitionStyle(reducedMotion = prefersReducedMotion()): TransitionStyle {
  return reducedMotion ? "fade" : "move";
}

/** Длительность перехода: при «уменьшить движение» — время затухания, иначе
 *  переданная длительность движения. Ноль не отдаём никогда: мгновенная подмена
 *  и есть то самое «ничего», от которого мы уходим. */
export function transitionDuration(moveMs: number, reducedMotion = prefersReducedMotion()): number {
  return reducedMotion ? FADE_MS : moveMs;
}

// ===== Собственные анимации =====
//
// Всё, что здесь есть, рисуется из JS через requestAnimationFrame, и это не
// вкусовщина. На части устройств система гасит ВСЮ декларативную анимацию
// разом: CSS-переходы, CSS-анимации, Web Animations API и браузерный плавный
// скролл (на Android это «Убрать анимации» / нулевой animator duration scale).
// Свойство при этом применяется мгновенно — ошибки нет, события есть, отличить
// «не анимировалось» от «анимировалось быстро» со стороны кода нечем. Проверено
// на живом телефоне: набор текста в AI (он на JS) шёл плавно, а затухание
// баннера на CSS-переходе выглядело щелчком.
//
// Поэтому правило: если анимацию должен увидеть пользователь — она считается
// здесь, а не отдаётся браузеру.

/** Кривая движения: быстрый старт, мягкое торможение (ease-out-quint).
 *  Та же линия, что у --ease-standard в index.css. */
export function easeOutQuint(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - clamped, 5);
}

/** Значение на момент времени: чистая функция, тестируется без DOM. Годится и
 *  для позиции прокрутки, и для прозрачности — кривая одна. */
export function scrollPositionAt(from: number, to: number, elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0) return to;
  return from + (to - from) * easeOutQuint(elapsedMs / durationMs);
}

/** Прогнать значение от `from` к `to` за `durationMs`, отдавая каждый кадр в
 *  `apply`. Общий мотор для прокрутки и прозрачности. Возвращает отмену.
 *
 *  `start` фиксируется на ПЕРВОМ реальном тике rAF, а не в момент вызова.
 *  Разница на живом устройстве бывает большой: сразу после сети/ре-рендера
 *  (например, сразу после submit формы) браузер может не отдавать rAF сотни
 *  миллисекунд. Если бы `start` брался в момент вызова, `elapsed` на первом
 *  же дошедшем кадре уже превышал бы `durationMs`, и вся анимация схлопывалась
 *  бы в одинарный прыжок в конец — ни одного промежуточного кадра, хотя код
 *  формально отработал без ошибок. Так и выглядела «доросовка» галочки на
 *  телефоне: результат есть, движения нет. Якорь на первый тик гарантирует
 *  хотя бы один кадр от `from`, сколько бы браузер его ни откладывал. */
/** Запас сторожевого таймера сверх длительности анимации.
 *
 *  Настолько большой намеренно: он должен срабатывать только тогда, когда
 *  кадров нет совсем, и никогда — на живой, но подтормаживающей анимации.
 *  Таймер перевзводится каждым кадром, так что эта величина — допустимая
 *  ПАУЗА МЕЖДУ кадрами, а не общий лимит на анимацию. */
const STALL_GRACE_MS = 700;

function animateValue(
  from: number, to: number, durationMs: number,
  apply: (value: number) => void,
  done?: () => void,
): () => void {
  if (durationMs <= 0) {
    apply(to);
    done?.();
    return () => {};
  }

  let start: number | null = null;
  let frame = 0;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let settled = false;

  /** Довести до конца ровно один раз, откуда бы ни пришли — с кадра или со
   *  сторожевого таймера. */
  const finish = () => {
    if (settled) return;
    settled = true;
    cancelAnimationFrame(frame);
    clearTimeout(watchdog);
    apply(to);
    done?.();
  };

  // Сторож на случай, когда кадры не приходят ВООБЩЕ.
  //
  // Мотор целиком висел на requestAnimationFrame, и `done` выполнялся только
  // если очередной кадр донёс elapsed >= durationMs. Запасного пути не было, а
  // rAF замолкает штатно: свёрнутый вебвью, скрытая вкладка, уходящая
  // клавиатура. Для шторки это означало не «анимация без движения», а
  // необратимо застрявшее состояние: панель поиска оставалась с инлайновым
  // transform, уехавшая вниз и полупрозрачная, и `closeSearch` из колбэка не
  // вызывался уже никогда.
  //
  // Таймер ПЕРЕВЗВОДИТСЯ на каждом кадре, а не ставится один раз на всю
  // длительность. Разница принципиальная: анимация, которая просто идёт
  // медленно (rAF, отданный с задержкой в сотни мс, — ровно то, ради чего
  // `start` якорится на первый реальный тик), каждым кадром отодвигает
  // дедлайн и доигрывается покадрово, как задумано. Обрывается только та, где
  // кадров нет совсем.
  const armWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(finish, durationMs + STALL_GRACE_MS);
  };

  const step = (now: number) => {
    if (settled) return;
    if (start === null) start = now;
    const elapsed = now - start;
    if (elapsed >= durationMs) {
      finish();
      return;
    }
    apply(scrollPositionAt(from, to, elapsed, durationMs));
    armWatchdog();
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
  armWatchdog();

  return () => {
    settled = true;
    cancelAnimationFrame(frame);
    clearTimeout(watchdog);
  };
}

/** Прогнать произвольное число от `from` к `to` своими кадрами.
 *
 *  Тот же мотор, что у прокрутки и прозрачности, но без привязки к свойству:
 *  им пользуется блик легендарной карточки, который двигает не scroll и не
 *  opacity, а собственную позицию градиента. Возвращает отмену. */
export function animateNumber(
  from: number, to: number, durationMs: number,
  apply: (value: number) => void,
  done?: () => void,
): () => void {
  return animateValue(from, to, durationMs, apply, done);
}

/** Длительность проявления слайда онбординга. Раньше жила в CSS
 *  (`.onboarding-appear { animation: fadeUp 550ms ... }`) — теперь считается
 *  тут же, где и остальное движение, которое должен увидеть человек. */
export const ONBOARDING_APPEAR_MS = 550;
const ONBOARDING_APPEAR_OFFSET_PX = 6;

/** Проявление элемента онбординга при монтировании: лёгкий сдвиг вверх и
 *  затухание — то же, что раньше рисовала CSS-анимация `fadeUp`, но покадрово.
 *
 *  Почему не CSS: `.onboarding-appear` уже учитывала «уменьшить движение»
 *  через `@media (prefers-reduced-motion)`, переопределяя кейфреймы на чистое
 *  затухание с той же длительностью — тем же паттерном, что раньше показал
 *  себя недостаточным для баннера витрины (fix(анимации) 95fa083): часть
 *  устройств гасит ВСЮ декларативную CSS-анимацию до нуля времени, что бы ни
 *  было внутри медиа-запроса. Онбординг тогда не тронули — отсюда и баг.
 *
 *  При «уменьшить движение» сдвиг убираем (offset=0), длительность не режем:
 *  это уже чистое проявление, укорачивать нечего (в отличие от FADE_MS —
 *  та замена СДВИГА на затухание, а не сам факт появления). */
export function animateAppear(el: HTMLElement, reducedMotion = prefersReducedMotion()): () => void {
  const offset = reducedMotion ? 0 : ONBOARDING_APPEAR_OFFSET_PX;
  return animateNumber(0, 1, ONBOARDING_APPEAR_MS, (t) => {
    el.style.opacity = String(t);
    el.style.transform = offset ? `translate3d(0, ${offset * (1 - t)}px, 0)` : "";
  }, () => { el.style.transform = ""; });
}

/** Длительности и сдвиг шторки — те же числа, что раньше жили в CSS-классах
 *  `.sheet-in`/`.sheet-out`/`.backdrop-in`/`.backdrop-out` (index.css). */
export const SHEET_IN_MS = 260;
export const SHEET_OUT_MS = 190;
/** Возврат шторки на место после отпущенного жеста. Короче входа: панель уже
 *  на экране и проходит не всю высоту, а те десятки пикселей, на которые её
 *  успели утянуть. Растянуть это до 260мс значит показать «подумал и вернул»
 *  вместо «не хватило». */
export const SHEET_SETTLE_MS = 200;
const BACKDROP_IN_MS = 150;
const SHEET_IN_OFFSET_PX = 32;
const SHEET_OUT_OFFSET_PX = 20;

/** Проявляется ли панель вдобавок к сдвигу.
 *
 *  Нет — когда панель приезжает снизу ЦЕЛИКОМ: у настоящей шторки её край
 *  виден с первого кадра, и полупрозрачная панель поверх контента читается не
 *  как «выезжает», а как «мигает». Да — когда сдвиг короткий и сам по себе
 *  смену состояния не показывает: desktop-модалка стоит по центру и ехать ей
 *  неоткуда, а при «уменьшить движение» сдвига нет вовсе и проявление остаётся
 *  единственным сигналом. */
function sheetFades(reducedMotion: boolean, travelPx: number, baseline = SHEET_IN_OFFSET_PX): boolean {
  return reducedMotion || travelPx <= baseline;
}

/** Выезд шторки снизу: панель (сдвиг + лёгкое проявление) и подложка (чистое
 *  затухание) одним вызовом.
 *
 *  Замена CSS `.sheet-in`/`.backdrop-in`. Тот же баг, что уже чинили для
 *  баннера витрины и слайдов онбординга (см. animateOpacity/animateAppear
 *  выше): системное «убрать анимации» гасит CSS `animation:` целиком, что бы
 *  ни задавал `@media (prefers-reduced-motion)` внутри неё — шторка не
 *  «тише открывается», она прыгает на экран мгновенно. На «Курс и цены» это
 *  особенно заметно: большая панель на весь экран, скачок читается как вспышка.
 *
 *  Первый кадр («от») применяется синхронно, ДО планирования rAF — вызывающий
 *  обязан звать это из useLayoutEffect (не useEffect), иначе браузер успеет
 *  нарисовать один кадр в конечном состоянии до того, как встанет исходное. */
export function animateSheetIn(
  panel: HTMLElement,
  backdrop: HTMLElement,
  reducedMotion = prefersReducedMotion(),
  travelPx = SHEET_IN_OFFSET_PX,
): () => void {
  const offset = reducedMotion ? 0 : travelPx;
  const duration = reducedMotion ? FADE_MS : SHEET_IN_MS;
  const fades = sheetFades(reducedMotion, travelPx);
  const applyPanel = (t: number) => {
    panel.style.opacity = fades ? String(reducedMotion ? t : 0.86 + 0.14 * t) : "";
    panel.style.transform = offset ? `translate3d(0, ${offset * (1 - t)}px, 0)` : "";
  };
  applyPanel(0);
  backdrop.style.opacity = "0";

  const cancelPanel = animateNumber(0, 1, duration, applyPanel, () => { panel.style.transform = ""; });
  const cancelBackdrop = animateOpacity(backdrop, 0, 1, reducedMotion ? FADE_MS : BACKDROP_IN_MS);
  return () => { cancelPanel(); cancelBackdrop(); };
}

/** Закрытие шторки — зеркало animateSheetIn. `done` вызывается по завершении
 *  анимации панели — на нём, а не на отдельном таймере, держится
 *  размонтирование в SheetShell. Раньше задержку перед закрытием считали
 *  отдельно от самой CSS-анимации (`transitionDuration(190)`), и оба места
 *  приходилось держать в согласии руками. */
export function animateSheetOut(
  panel: HTMLElement,
  backdrop: HTMLElement,
  done: () => void,
  reducedMotion = prefersReducedMotion(),
  travelPx = SHEET_OUT_OFFSET_PX,
): () => void {
  const offset = reducedMotion ? 0 : travelPx;
  const duration = reducedMotion ? FADE_MS : SHEET_OUT_MS;
  const fades = sheetFades(reducedMotion, travelPx, SHEET_OUT_OFFSET_PX);
  const cancelPanel = animateNumber(0, 1, duration, (t) => {
    panel.style.opacity = fades ? String(1 - t) : "";
    panel.style.transform = offset ? `translate3d(0, ${offset * t}px, 0)` : "";
  }, done);
  const cancelBackdrop = animateOpacity(backdrop, 1, 0, duration);
  return () => { cancelPanel(); cancelBackdrop(); };
}

/** Собрать transform из вертикального сдвига и масштаба, пропуская
 *  тождественные слагаемые — иначе рраз при каждом кадре ставился бы
 *  `translate3d(0, 0px, 0) scale(1)`, а не пустая строка, что мешает
 *  сравнивать «анимация закончилась» с «стиль вообще не трогали». */
function transformString(yPx: number, scale: number, xPx = 0): string {
  const parts: string[] = [];
  if (xPx || yPx) parts.push(`translate3d(${xPx}px, ${yPx}px, 0)`);
  if (scale !== 1) parts.push(`scale(${scale})`);
  return parts.join(" ");
}

/** `slide` — приход СБОКУ, без масштаба. Заведён для обмена «Добавить» ↔
 *  степпер на плитке товара: `pop` играл это как всплытие поверх, то есть как
 *  появление второго элемента, а происходит здесь другое — один орган управления
 *  уступает место другому. Боковое движение читается как уступка, всплытие — как
 *  прибавление. Сторона задаётся знаком dxPx у вызывающего: степпер въезжает
 *  справа, кнопка возвращается слева. */
export type EnterPreset = "fadeUp" | "fade" | "pop" | "slide";

// Те же числа и кейфреймы, что раньше жили в index.css у .card-appear/
// .fade-in/.pop-in — только теперь на rAF-моторе, а не CSS animation:.
const ENTER_FADE_FROM_OPACITY = 0.72; // как .fade-in и переход между страницами (Layout.tsx)
const ENTER_FADEUP_MS = 190; // = --motion-standard
const ENTER_FADE_MS = 150; // = --motion-fast
const ENTER_POP_MS = 190; // = --motion-standard
const ENTER_FADEUP_OFFSET_PX = 6;
const ENTER_POP_FROM_SCALE = 0.98;

/** Шаг задержки для списка карточек — раньше задавал `.stagger > *:nth-child(n)`
 *  в index.css (тоже CSS animation-delay — тот же баг, что и у самой
 *  анимации). Тот же расчёт, что был у онбординга: 0, 24, 48, а дальше ровно
 *  72 — не растягивать же задержку на весь длинный список. */
export function staggerDelayMs(index: number): number {
  return Math.min(index * 24, 72);
}

/** Запустить анимацию не сразу, а через delayMs — сама функция передаётся,
 *  а не готовый результат: `start()` не должен вызываться до истечения паузы. */
function afterDelay(delayMs: number, start: () => () => void): () => void {
  if (delayMs <= 0) return start();
  let cancelInner = () => {};
  // setTimeout, не window.setTimeout: этот модуль тестируется в node-окружении
  // без DOM/window (см. animateAppear/animateSheetIn выше), а глобальный
  // таймер там есть, в отличие от window.
  const timer = setTimeout(() => { cancelInner = start(); }, delayMs);
  return () => { clearTimeout(timer); cancelInner(); };
}

/** Проявление элемента при монтировании — общая замена трём CSS-классам:
 *  `.card-appear` (карточки товаров, блоки страниц), `.fade-in` (лёгкие
 *  подсказки/пустые состояния), `.pop-in` (бейджи, тосты-предшественники).
 *
 *  Почему JS, а не CSS: тот же баг, что уже чинили для шторок, баннера,
 *  онбординга и — острее всего — галочки «Заявка принята»
 *  (см. AnimatedCheck.tsx): на живом iOS в Telegram с «уменьшить движение»
 *  такая CSS-анимация не просто ускоряется, а иногда замирает на СТАРТОВОМ
 *  кадре — элемент не появляется вовсе, хотя в тестовом браузере всё рисуется
 *  штатно. Это было почти во всех местах приложения разом — карточки
 *  каталога/главной/корзины/заявок, это самая частая деталь интерфейса.
 *
 *  delayMs — замена `.stagger` (index.css): исходный кадр применяется сразу
 *  (иначе элемент был бы виден все delayMs мс задержки), само проявление
 *  стартует позже. */
export function animateEnter(
  el: HTMLElement,
  preset: EnterPreset,
  reducedMotion = prefersReducedMotion(),
  delayMs = 0,
  /** Откуда приезжает `slide`: отрицательное — слева, положительное — справа.
   *  Другими пресетами игнорируется. При «уменьшить движение» обнуляется вместе
   *  со всеми смещениями — остаётся чистое проявление. */
  dxPx = 0,
  /** Переопределение длительности. Нужно там, где движется НЕ отдельный
   *  элемент, а целая полоса интерфейса: пресетные 190мс рассчитаны на кнопку,
   *  и на обмене всего нижнего ряда та же цифра читается рывком, а не
   *  превращением. При «уменьшить движение» игнорируется — там своя, короткая. */
  durationMs?: number,
): () => void {
  if (preset === "fade") {
    const duration = reducedMotion ? FADE_MS : ENTER_FADE_MS;
    el.style.opacity = String(ENTER_FADE_FROM_OPACITY);
    return afterDelay(delayMs, () => animateOpacity(el, ENTER_FADE_FROM_OPACITY, 1, duration));
  }
  const offset = preset === "fadeUp" && !reducedMotion ? ENTER_FADEUP_OFFSET_PX : 0;
  const offsetX = preset === "slide" && !reducedMotion ? dxPx : 0;
  const fromScale = preset === "pop" && !reducedMotion ? ENTER_POP_FROM_SCALE : 1;
  const duration = reducedMotion
    ? FADE_MS
    : (durationMs ?? (preset === "pop" || preset === "slide" ? ENTER_POP_MS : ENTER_FADEUP_MS));
  const apply = (t: number) => {
    el.style.opacity = String(t);
    el.style.transform = transformString(offset * (1 - t), fromScale + (1 - fromScale) * t, offsetX * (1 - t));
  };
  apply(0);
  return afterDelay(delayMs, () => animateNumber(0, 1, duration, apply, () => { el.style.transform = ""; }));
}

/** Уход слоя, на место которого встаёт другой (кнопка «Добавить» → степпер).
 *  Зеркало пресета `pop` у animateEnter: тот же масштаб и та же кривая, только
 *  наоборот — иначе встречное движение двух слоёв выглядит как два разных
 *  события, а не как одно превращение.
 *
 *  Короче входа: уходящее не несёт информации, задерживать на нём взгляд
 *  незачем. При «уменьшить движение» остаётся только затухание. */
export const SWAP_OUT_MS = 150;
const SWAP_OUT_TO_SCALE = 0.94;

export function animateSwapOut(
  el: HTMLElement,
  reducedMotion = prefersReducedMotion(),
  /** Куда уступает уходящий слой. 0 — прежнее поведение (только масштаб).
   *  Ненулевое значение выключает масштаб: сжатие вместе со сдвигом читается
   *  как два разных события, а уступка — одно. */
  dxPx = 0,
  /** Переопределение длительности — см. тот же параметр у animateEnter. */
  durationMs?: number,
): () => void {
  const lateral = !reducedMotion && dxPx !== 0;
  const toScale = reducedMotion || lateral ? 1 : SWAP_OUT_TO_SCALE;
  const duration = reducedMotion ? FADE_MS : (durationMs ?? SWAP_OUT_MS);
  return animateNumber(0, 1, duration, (t) => {
    el.style.opacity = String(1 - t);
    el.style.transform = transformString(0, 1 + (toScale - 1) * t, lateral ? dxPx * t : 0);
  });
}

/** Панель каталога, уезжающая за верхний край. Длиннее шторки (260мс): у панели
 *  нет затемнения под ней, и весь её путь человек видит целиком — на 190мс это
 *  читалось не как уход, а как рывок. Проверено на живом телефоне. */
export const TOOLBAR_HIDE_MS = 300;

/** Сдвинуть элемент по вертикали на `toPx` от `fromPx`. Отдельная функция, а не
 *  CSS-переход, по общему правилу модуля: этот webview гасит декларативную
 *  анимацию, и панель на CSS-переходе просто перещёлкивалась. */
export function animateShiftY(
  el: HTMLElement, fromPx: number, toPx: number,
  durationMs: number, onFrame?: (y: number) => void,
): () => void {
  return animateNumber(fromPx, toPx, durationMs, (y) => {
    onFrame?.(y);
    el.style.transform = y ? `translate3d(0, ${y}px, 0)` : "";
  });
}

// Числа — те же, что раньше в index.css у .toast-in/.toast-out.
const TOAST_IN_MS = 190; // = --motion-standard
const TOAST_OUT_MS = 150; // = --motion-fast
const TOAST_IN_OFFSET_PX = 8;
const TOAST_OUT_OFFSET_PX = 4;
const TOAST_SCALE = 0.98;

/** Появление тоста — замена `.toast-in`. */
export function animateToastIn(el: HTMLElement, reducedMotion = prefersReducedMotion()): () => void {
  const offset = reducedMotion ? 0 : TOAST_IN_OFFSET_PX;
  const fromScale = reducedMotion ? 1 : TOAST_SCALE;
  const duration = reducedMotion ? FADE_MS : TOAST_IN_MS;
  const apply = (t: number) => {
    el.style.opacity = String(t);
    el.style.transform = transformString(offset * (1 - t), fromScale + (1 - fromScale) * t);
  };
  apply(0);
  return animateNumber(0, 1, duration, apply, () => { el.style.transform = ""; });
}

/** Скрытие тоста — замена `.toast-out`. Без `done`: тост в Toaster.tsx и так
 *  снимается своим таймером, а не по завершении анимации. */
export function animateToastOut(el: HTMLElement, reducedMotion = prefersReducedMotion()): () => void {
  const offset = reducedMotion ? 0 : TOAST_OUT_OFFSET_PX;
  const toScale = reducedMotion ? 1 : TOAST_SCALE;
  const duration = reducedMotion ? FADE_MS : TOAST_OUT_MS;
  return animateNumber(0, 1, duration, (t) => {
    el.style.opacity = String(1 - t);
    el.style.transform = transformString(-offset * t, 1 - (1 - toScale) * t);
  });
}

// 190мс = --motion-standard, как было у .favorite-pop, поделено на рост/спад
// в той же пропорции, что и старые проценты кейфрейма (0% -> 45% -> 100%).
const PULSE_GROW_MS = 85;
const PULSE_SETTLE_MS = 105;
const PULSE_SCALE = 1.18;

/** Пульс сердечка избранного — замена `.favorite-pop`. Две последовательные
 *  фазы (рост, спад), а не один проход с ручным late-выбором «до пика/после
 *  пика» по значению t: animateNumber отдаёт t уже смягчённым (easeOutQuint),
 *  а не долей прошедшего времени, и метка «пик на 45%» относилась к ДОЛЕ
 *  ВРЕМЕНИ у исходного CSS-кейфрейма — пик приходился бы почти на самое
 *  начало анимации, а не на середину. Раздельные фазы избегают этой путаницы:
 *  каждая честно едет от 1 до цели своим отдельным вызовом мотора.
 *
 *  При «уменьшить движение» масштаб (это движение) заменяем на вспышку
 *  прозрачности — тот же приём, что и в остальном модуле, а не «ничего»
 *  (см. шапку файла). */
export function animatePulse(el: HTMLElement | SVGElement, reducedMotion = prefersReducedMotion()): () => void {
  if (reducedMotion) return animateOpacity(el, 0.6, 1, FADE_MS);
  let cancelSettle = () => {};
  const cancelGrow = animateNumber(1, PULSE_SCALE, PULSE_GROW_MS, (v) => {
    el.style.transform = `scale(${v})`;
  }, () => {
    cancelSettle = animateNumber(PULSE_SCALE, 1, PULSE_SETTLE_MS, (v) => {
      el.style.transform = `scale(${v})`;
    }, () => { el.style.transform = ""; });
  });
  return () => { cancelGrow(); cancelSettle(); };
}

/** Плавно изменить прозрачность элемента — своими руками, без CSS-перехода.
 *
 *  CSS-переход здесь не годится: на устройствах с выключенной системной
 *  анимацией он применяется мгновенно, и затухание выглядит щелчком. Именно так
 *  и выглядела смена баннера на проде.
 */
export function animateOpacity(el: HTMLElement | SVGElement, from: number, to: number, durationMs: number, done?: () => void): () => void {
  // Инлайновый transition убираем: если он остался от прежнего кода, браузер
  // попытается доводить значение сам поверх наших кадров.
  el.style.transition = "";
  return animateValue(from, to, durationMs, (v) => { el.style.opacity = String(v); }, done);
}

/** Плавно прокрутить ленту к позиции СВОЕЙ анимацией, а не браузерной.
 *
 *  Почему не `scrollTo({behavior: 'smooth'})`, хотя он короче: браузерный
 *  плавный скролл рисует композитор, и в части окружений (WebView, скрытая
 *  вкладка, часть Android-прошивок) он молча не срабатывает — прокрутка
 *  происходит, но мгновенно. Отладить это со стороны кода нельзя: ошибки нет,
 *  событий нет, отличить «не анимировалось» от «анимировалось быстро» нечем.
 *  Своя анимация ведёт себя одинаково везде и не зависит от чужих решений.
 *
 *  Возвращает функцию отмены — её обязан вызвать тот, кто владеет элементом.
 */
/** Прокрутка своими кадрами. Внутренняя: снаружи вызывают animateScrollTo. */
function animateScrollOurselves(el: HTMLElement, from: number, left: number, durationMs: number): () => void {
  // Снимаем защёлкивание на время анимации и возвращаем в конце.
  //
  // Без этого анимации просто нет: у ленты `scroll-snap-type: x mandatory`, и
  // браузер защёлкивает КАЖДЫЙ промежуточный кадр к ближайшей точке — вместо
  // проезда получается прыжок. Замер на живой странице: за 620мс анимации одна
  // промежуточная позиция вместо пятнадцати. Возвращать безопасно: целевая
  // позиция сама является точкой привязки, так что защёлкивать нечего.
  const snapBefore = el.style.scrollSnapType;
  el.style.scrollSnapType = "none";
  const restoreSnap = () => { el.style.scrollSnapType = snapBefore; };

  const cancel = animateValue(from, left, durationMs, (v) => { el.scrollLeft = v; }, restoreSnap);
  return () => { cancel(); restoreSnap(); };
}

/** Сколько ждём, прежде чем решить, что браузер плавность проигнорировал.
 *  Два-три кадра: за это время настоящая анимация успевает сдвинуться. */
const SMOOTH_PROBE_MS = 50;

/** Плавно прокрутить ленту к позиции.
 *
 *  Сначала просим браузер (`behavior: 'smooth'`), и это не лень: браузерную
 *  прокрутку рисует композитор — та же дорожка, по которой лента едет под
 *  пальцем, с тем же качеством и без нагрузки на основной поток. Своими
 *  кадрами так гладко не получится, они считаются в JS.
 *
 *  Но композитор берёт эту работу не всегда: при системном «уменьшить
 *  движение» браузер выполняет плавную прокрутку мгновенно, и в части WebView
 *  она игнорируется молча. Поэтому через пару кадров проверяем, тронулась ли
 *  лента, и если нет — дорисовываем сами. Проверка безопасна: если браузер
 *  проигнорировал плавность, позиция ещё равна исходной, и подхват не даёт
 *  скачка.
 *
 *  Возвращает функцию отмены — её обязан вызвать тот, кто владеет элементом.
 */
export function animateScrollTo(el: HTMLElement, left: number, durationMs: number): () => void {
  const from = el.scrollLeft;
  if (durationMs <= 0 || Math.abs(left - from) < 1) {
    el.scrollLeft = left;
    return () => {};
  }

  // Решаем ДО обращения к браузеру, а не по факту. Проверить постфактум
  // нельзя: при «уменьшить движение» браузер выполняет плавную прокрутку
  // мгновенно, и для любой пробы это неотличимо от «уже доехали» — позиция
  // равна целевой в обоих случаях. Замер это и показал: проба видела прыжок на
  // 320 пикселей и делала вывод, что анимация идёт.
  if (typeof el.scrollTo !== "function" || prefersReducedMotion()) {
    return animateScrollOurselves(el, from, left, durationMs);
  }

  let cancelSelf = () => {};
  el.scrollTo({ left, behavior: "smooth" });

  // Подстраховка для окружений, которые игнорируют плавность молча и БЕЗ
  // всякой настройки: если через пару кадров лента не сдвинулась ни на пиксель,
  // дорисовываем сами. Скачка тут быть не может — позиция ещё исходная.
  const probe = window.setTimeout(() => {
    if (Math.abs(el.scrollLeft - from) < 1) {
      cancelSelf = animateScrollOurselves(el, el.scrollLeft, left, durationMs);
    }
  }, SMOOTH_PROBE_MS);

  return () => { window.clearTimeout(probe); cancelSelf(); };
}
