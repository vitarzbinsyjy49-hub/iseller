/** Общий шелл шторки (SheetShell) + ScenarioChoiceSheet (v5.4.0, v6).
 *
 *  Форма сценарных заявок (Trade-In/бизнес/опт) заменена AI-чатом
 *  (pages/ScenarioChat.tsx, /apply/:scenario) — см.
 *  docs/superpowers/specs/2026-08-14-scenario-ai-chat-design.md.
 *  ScenarioChoiceSheet — лёгкое меню выбора (для «Подобрать MacBook»): только
 *  навигация в AI с prefill, БЕЗ создания заявки и без авто-отправки.
 *
 *  SheetShell — общая оболочка (portal, backdrop, Escape, scroll-lock, focus
 *  trap), переиспользуется AiRoadmapSheet/LoyaltyRoadmapSheet — не удалять.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { haptic } from "../lib/telegram";
import { SHEET_OUT_MS, SHEET_SETTLE_MS, animateNumber, animateSheetIn, animateSheetOut } from "../lib/motion";
import {
  HANDLE_ZONE_PX,
  isVerticalDrag,
  scrollerWithin,
  sheetBackdropOpacity,
  sheetDragOffset,
  shouldDismissSheet,
} from "../lib/sheetDrag";
import { sheetMaxHeightPx } from "../lib/viewport";
import type { ChoiceItem } from "../lib/scenario";
import { Icon } from "./icons";

export type { ScenarioKey, ChoiceItem } from "../lib/scenario";

/* ============================================================
   Общая оболочка: portal, backdrop, Escape, scroll-lock, focus trap.
   Экспортируется для переиспользования (роудмап AI): второй такой шелл
   означал бы вторую реализацию ловушки фокуса и блокировки скролла —
   расходятся они молча и обнаруживаются только с клавиатуры.
   ============================================================ */
export type SheetClose = (afterClose?: () => void) => void;

/** На сколько панель уезжает вниз при открытии и закрытии.
 *
 *  Прижатая к низу экрана шторка обязана приезжать снизу ЦЕЛИКОМ — на свою
 *  высоту. Прежний общий сдвиг в 32px был не выездом, а подрагиванием: панель
 *  почти сразу оказывалась на месте, и «выплывание» приходилось додумывать по
 *  затуханию. Высоту читаем после того, как выставлен max-height, иначе она
 *  будет от неограниченного контента.
 *
 *  Центрованная desktop-модалка (sm+) остаётся на коротком сдвиге: ехать ей
 *  неоткуда, снизу экрана она не появляется. Там `undefined` возвращает
 *  animateSheet* к их собственным значениям по умолчанию. */

function sheetTravelPx(panel: HTMLElement, centered: boolean, top = false): number | undefined {
  if (centered) return undefined;
  // Отрицательный ход = панель приезжает СВЕРХУ: animateSheetIn/Out просто
  // умножают его на прогресс, направление им безразлично. Второго мотора для
  // верхней шторки заводить не нужно.
  if (top) return -(panel.offsetHeight + 1);
  // Запас в 1px: при дробном DPR округление высоты вниз оставляло бы у нижней
  // кромки полоску панели, видимую до и после анимации.
  return panel.offsetHeight + 1;
}

/** Откуда приезжает шторка.
 *
 *  Направление — не украшение, а соответствие месту нажатия. Шторка обязана
 *  выезжать ОТТУДА, где стоит кнопка, которая её открыла: панель, приехавшая
 *  снизу по тапу в самом верху экрана, заставляет глаз искать связь между
 *  двумя противоположными краями, и связь эта не находится.
 *
 *  «bottom» по умолчанию: почти всё в приложении открывается из нижней
 *  навигации и из карточек. «top» — для статусной строки в шапке (курс, режим
 *  работы). */
export type SheetFrom = "bottom" | "top";

export function SheetShell({ onClose, labelledBy, panelClassName = "", from = "bottom", children }: {
  onClose: () => void;
  labelledBy: string;
  panelClassName?: string;
  from?: SheetFrom;
  children: ReactNode | ((close: SheetClose) => ReactNode);
}) {
  const top = from === "top";
  /** Куда «прочь от кромки». Весь жест считается в этом направлении, а знак
   *  подставляется на границе — так чистая логика перетаскивания (sheetDrag)
   *  остаётся одной на оба направления и не удваивается. */
  const awaySign = top ? -1 : 1;
  const panelRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const cancelAnimRef = useRef<() => void>(() => {});
  const closingRef = useRef(false);
  const [closing, setClosing] = useState(false);
  onCloseRef.current = onClose;

  /** Текущий жест. В ref, а не в состоянии: на каждом кадре движения пальца
   *  перерисовывать React значит гарантированно от него отстать. */
  const dragRef = useRef<{
    pointerId: number;
    startX: number; startY: number; startAt: number;
    height: number;
    scroller: HTMLElement | null;
    fromHandle: boolean;
    active: boolean;
    offset: number;
  } | null>(null);

  // Выезд при монтировании. useLayoutEffect, не useEffect: animateSheetIn
  // ставит первый кадр синхронно и ждёт, что DOM ещё не нарисован — иначе один
  // кадр мелькнёт в конечном положении до того, как встанет исходное.
  //
  // Высоту панели фиксируем ЗДЕСЬ, инлайн-стилем, а не живым CSS var в
  // className — принципиально важен порядок: этот эффект синхронный и
  // отрабатывает ДО эффекта блокировки скролла ниже. На части WebView
  // переключение body { overflow: hidden } кадром позже само провоцирует
  // пересчёт --app-height (сворачивается адресная строка/чужой chrome) — и
  // если бы высота панели была завязана на живую переменную, она бы дёрнулась
  // ровно в этот момент. Читаем один раз, до этого пересчёта, и всё.
  useLayoutEffect(() => {
    const panel = panelRef.current, backdrop = backdropRef.current;
    if (!panel || !backdrop) return;
    const rawAppHeight = getComputedStyle(document.documentElement).getPropertyValue("--app-height");
    const appHeightPx = parseFloat(rawAppHeight) || window.innerHeight;
    const centered = window.innerWidth >= 640;
    panel.style.maxHeight = `${sheetMaxHeightPx(appHeightPx, centered)}px`;
    // Скрытый документ не выдаёт кадров: requestAnimationFrame в нём не
    // вызывается вообще. Шторка осталась бы сдвинутой вниз и невидимой до
    // возвращения в приложение. Показывать всё равно нечего — оставляем её
    // сразу в конечном положении (стили просто не трогаем).
    if (document.hidden) return;
    cancelAnimRef.current = animateSheetIn(panel, backdrop, undefined, sheetTravelPx(panel, centered, top));
    return () => cancelAnimRef.current();
  }, []);

  /** Довести отпущенную шторку до края и закрыть.
   *
   *  Длительность считается от ОСТАВШЕГОСЯ пути: если панель уже утянута почти
   *  вниз, ехать ей нечего, и полные 190мс читались бы как задержка после
   *  собственного движения руки. */
  const dismissFromDrag = useCallback((fromPx: number) => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    const panel = panelRef.current, backdrop = backdropRef.current;
    if (!panel || !backdrop) { onCloseRef.current(); return; }
    cancelAnimRef.current();
    const target = panel.getBoundingClientRect().height + 1;
    if (document.hidden) { onCloseRef.current(); return; }
    const fromOpacity = Number(backdrop.style.opacity || "1");
    const remaining = Math.max(0, 1 - fromPx / Math.max(target, 1));
    const duration = Math.max(110, Math.round(SHEET_OUT_MS * remaining));
    cancelAnimRef.current = animateNumber(0, 1, duration, (t) => {
      panel.style.transform = `translate3d(0, ${fromPx + (target - fromPx) * t}px, 0)`;
      backdrop.style.opacity = String(fromOpacity * (1 - t));
    }, () => onCloseRef.current());
  }, []);

  /** Вернуть шторку на место: жеста не хватило, чтобы закрыть. */
  const settleBack = useCallback((fromPx: number) => {
    const panel = panelRef.current, backdrop = backdropRef.current;
    if (!panel || !backdrop) return;
    const clear = () => { panel.style.transform = ""; backdrop.style.opacity = ""; };
    if (document.hidden) { clear(); return; }
    const fromOpacity = Number(backdrop.style.opacity || "1");
    cancelAnimRef.current();
    cancelAnimRef.current = animateNumber(0, 1, SHEET_SETTLE_MS, (t) => {
      const y = fromPx * (1 - t);
      panel.style.transform = y ? `translate3d(0, ${y}px, 0)` : "";
      backdrop.style.opacity = String(fromOpacity + (1 - fromOpacity) * t);
    }, clear);
  }, []);

  const requestClose = useCallback<SheetClose>((afterClose) => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    const panel = panelRef.current, backdrop = backdropRef.current;
    if (!panel || !backdrop) { onCloseRef.current(); afterClose?.(); return; }
    cancelAnimRef.current();
    // Размонтирование держится на колбэке анимации, а кадров в скрытом
    // документе не будет — шторка провисела бы до возвращения в приложение.
    // Закрываем сразу: анимацию закрытия всё равно никто не увидит.
    if (document.hidden) { onCloseRef.current(); afterClose?.(); return; }
    cancelAnimRef.current = animateSheetOut(panel, backdrop, () => {
      onCloseRef.current();
      afterClose?.();
    }, undefined, sheetTravelPx(panel, window.innerWidth >= 640, top));
  }, []);

  // Блокировка фонового скролла без прыжка страницы (компенсируем ширину
  // скроллбара на desktop; на mobile она ~0). Восстанавливаем при закрытии.
  useEffect(() => {
    const { style } = document.body;
    const prevOverflow = style.overflow;
    const prevPad = style.paddingRight;
    const sbw = window.innerWidth - document.documentElement.clientWidth;
    style.overflow = "hidden";
    if (sbw > 0) style.paddingRight = `${sbw}px`;
    return () => { style.overflow = prevOverflow; style.paddingRight = prevPad; };
  }, []);

  // Фокус внутрь шторки + Escape + простая ловушка Tab.
  useEffect(() => {
    const panel = panelRef.current;
    const prevActive = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(panel?.querySelectorAll<HTMLElement>(
        'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
      ) ?? []).filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
    // начальный фокус на саму панель (не на первое поле — чтобы клавиатура iOS
    // не открывалась мгновенно и не перекрывала контент/CTA)
    panel?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); requestClose(); return; }
      if (e.key !== "Tab") return;
      const els = focusables();
      if (els.length === 0) return;
      const first = els[0], last = els[els.length - 1];
      const active = document.activeElement as HTMLElement;
      if (e.shiftKey && (active === first || active === panel)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); prevActive?.focus?.(); };
  }, [requestClose]);

  return createPortal(
    <div
      ref={backdropRef}
      // Подложка светлая (25%, было 40%) намеренно: страница под шторкой
      // должна остаться читаемой и узнаваемой — шторка накрывает её, а не
      // выключает. Отделяет панель от фона не темнота, а её собственная тень
      // (shadow-sheet) и то, что она приезжает снизу целиком.
      className={`fixed inset-0 z-50 flex ${top ? "items-start" : "items-end"} justify-center bg-black/25 sm:items-center ${closing ? "pointer-events-none" : ""}`}
      onClick={() => requestClose()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => {
          if (closingRef.current || e.pointerType === "mouse") return;
          const panel = panelRef.current;
          if (!panel) return;
          const rect = panel.getBoundingClientRect();
          // Ручка у верхней шторки нарисована СНИЗУ панели — там же, где у
          // неё свободный край. Искать её сверху значило бы отдавать жест
          // содержимому ровно там, где человек за неё тянет.
          const fromHandle = top
            ? rect.bottom - e.clientY <= HANDLE_ZONE_PX
            : e.clientY - rect.top <= HANDLE_ZONE_PX;
          dragRef.current = {
            pointerId: e.pointerId,
            startX: e.clientX, startY: e.clientY, startAt: performance.now(),
            height: rect.height,
            scroller: fromHandle ? null : scrollerWithin(e.target, panel),
            fromHandle,
            active: false,
            offset: 0,
          };
        }}
        onPointerMove={(e) => {
          const drag = dragRef.current;
          const panel = panelRef.current, backdrop = backdropRef.current;
          if (!drag || !panel || !backdrop || e.pointerId !== drag.pointerId) return;
          const dx = e.clientX - drag.startX;
          const dy = e.clientY - drag.startY;
          // «Прочь» — вниз у нижней шторки и вверх у верхней. Дальше в этом
          // блоке рассуждаем только про away, а знак вернётся при отрисовке.
          const away = dy * awaySign;

          if (!drag.active) {
            if (!isVerticalDrag(dx, dy)) return;
            // Пока списку есть куда прокручиваться вверх, движение вниз
            // адресовано ему, а не шторке. Исключение — жест за ручку.
            // Пока содержимому есть куда прокручиваться В СТОРОНУ ЖЕСТА,
            // движение адресовано ему, а не шторке. У нижней шторки это край
            // «выше нечего показывать» (scrollTop 0), у верхней — зеркальный
            // «ниже нечего показывать»: тянуть её вверх значит листать список
            // вниз, и перехватывать это до конца списка нельзя.
            const sc = drag.scroller;
            const contentAtEdge = !sc || (top
              ? sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1
              : sc.scrollTop <= 0);
            if (away > 0 && !contentAtEdge) { dragRef.current = null; return; }
            // ОБРАТНО шторку тянут только за ручку: в остальных местах это
            // прокрутка содержимого, и перехватывать её нельзя.
            if (away < 0 && !drag.fromHandle) { dragRef.current = null; return; }
            drag.active = true;
            // Вход мог ещё не доиграть — палец главнее анимации.
            cancelAnimRef.current();
            // Захват указателя — удобство, а не условие работы: он лишь
            // доводит события до панели, если палец ушёл за её край. Бросает
            // при незнакомом pointerId, и необёрнутый вызов обрывал обработчик
            // ДО применения сдвига — жест терял первый кадр и начинался
            // рывком (поймано на синтетических событиях).
            try { panel.setPointerCapture?.(e.pointerId); } catch { /* не критично */ }
          }

          const offset = sheetDragOffset(away);
          drag.offset = offset;
          panel.style.transform = offset
            ? `translate3d(0, ${offset * awaySign}px, 0)`
            : "";
          backdrop.style.opacity = String(sheetBackdropOpacity(offset, drag.height));
        }}
        onPointerUp={(e) => {
          const drag = dragRef.current;
          dragRef.current = null;
          if (!drag || !drag.active || e.pointerId !== drag.pointerId) return;
          const elapsedMs = performance.now() - drag.startAt;
          if (shouldDismissSheet({ offset: drag.offset, height: drag.height, elapsedMs })) {
            dismissFromDrag(drag.offset);
          } else {
            settleBack(drag.offset);
          }
        }}
        onPointerCancel={() => {
          const drag = dragRef.current;
          dragRef.current = null;
          // Прерванный системой жест — не решение закрыть: возвращаем на место.
          if (drag?.active) settleBack(drag.offset);
        }}
        // Высота — от --app-height (index.css, lib/telegram.ts), не от сырых
        // vh: у сырых vh в Telegram WebView есть переходный кадр между «пока не
        // осевшей» высотой раскрытия и viewportStableHeight — панель, прижатая
        // к низу экрана, на этот кадр ловит другой max-height и «досаживается»
        // сверху вниз. --app-height ставится ИМЕННО из stable-высоты первым
        // приоритетом (см. pickViewportHeight), этого скачка не даёт. Fallback
        // (var не установлена — вне Telegram) — 100vh*0.88/0.9, то есть те же
        // 88vh/90vh, что были.
        className={`flex max-h-[calc(var(--app-height,100vh)*0.88)] w-full max-w-md flex-col bg-surface shadow-sheet outline-none sm:max-h-[calc(var(--app-height,100vh)*0.9)] sm:rounded-3xl ${top ? "safe-top rounded-b-3xl" : "safe-bottom rounded-t-3xl"} ${closing ? "pointer-events-none" : ""} ${panelClassName}`}
      >
        {typeof children === "function" ? children(requestClose) : children}
        {/* Ручку верхней шторки рисует ШЕЛЛ и ставит её снизу — у свободного
            края, за который и тянут. Нижние шторки по-прежнему рисуют свою
            сами: переносить сюда и их значило бы править восемь файлов ради
            одного нового направления. */}
        {top && (
          <div className="mx-auto mb-3 mt-2 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden />
        )}
      </div>
    </div>,
    document.body,
  );
}

function DragHandle() {
  return <div className="mx-auto mt-3 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden />;
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    // Кружок 32px, область нажатия 44px — как у остальных круглых кнопок.
    <button
      onClick={onClose} aria-label="Закрыть"
      className="tap -mr-1.5 flex h-11 w-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-mutedbg text-muted">
        <Icon name="close" className="h-4 w-4" strokeWidth={2} />
      </span>
    </button>
  );
}

/* ============================================================
   ScenarioChoiceSheet — меню «Какой MacBook вам нужен?».
   Только навигация в AI с prefill; заявка НЕ создаётся, авто-отправки НЕТ.
   ============================================================ */
export function ScenarioChoiceSheet({
  title, items, onClose, onPick,
}: {
  title: string;
  items: ChoiceItem[];
  onClose: () => void;
  /** Получает prefill выбранного пункта. Вызывающий навигирует в /ai?q=… */
  onPick: (item: ChoiceItem) => void;
}) {
  return (
    <SheetShell onClose={onClose} labelledBy="choice-title">
      {(close) => (
        <>
          <DragHandle />
          <div className="flex items-start justify-between gap-3 px-5 pt-2">
            <h3 id="choice-title" className="text-lg font-bold leading-6">{title}</h3>
            <CloseButton onClose={() => close()} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-4">
            <div className="space-y-2">
              {items.map((it) => (
                <button
                  key={it.key}
                  onClick={() => { haptic("light"); close(() => onPick(it)); }}
                  className="tap flex w-full items-center justify-between gap-3 rounded-xl2 border border-border bg-surface px-4 py-3.5 text-left"
                >
                  <span className="text-[15px] font-semibold">{it.label}</span>
                  <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </SheetShell>
  );
}
