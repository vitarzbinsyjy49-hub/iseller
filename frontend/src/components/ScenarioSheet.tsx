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
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { haptic } from "../lib/telegram";
import { transitionDuration } from "../lib/motion";
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

export function SheetShell({ onClose, labelledBy, panelClassName = "", children }: {
  onClose: () => void;
  labelledBy: string;
  panelClassName?: string;
  children: ReactNode | ((close: SheetClose) => ReactNode);
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const closeTimer = useRef<number | null>(null);
  const closingRef = useRef(false);
  const [closing, setClosing] = useState(false);
  onCloseRef.current = onClose;

  const requestClose = useCallback<SheetClose>((afterClose) => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    // Ноля здесь быть не может: при «уменьшить движение» шит всё равно гаснет
    // (index.css переопределяет slideDown в чистую прозрачность), и нулевая
    // задержка снимала его с экрана ДО того, как затухание успевало проиграть.
    const delay = transitionDuration(190);
    closeTimer.current = window.setTimeout(() => {
      onCloseRef.current();
      afterClose?.();
    }, delay);
  }, []);

  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
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
      className={`${closing ? "backdrop-out" : "backdrop-in"} fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center`}
      onClick={() => requestClose()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={`${closing ? "sheet-out" : "sheet-in"} flex max-h-[88vh] w-full max-w-md flex-col rounded-t-3xl bg-surface shadow-sheet outline-none safe-bottom sm:max-h-[90vh] sm:rounded-3xl ${panelClassName}`}
      >
        {typeof children === "function" ? children(requestClose) : children}
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
