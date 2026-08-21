import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { TOAST_EVENT, type ToastKind } from "../lib/toast";
import { animateToastIn, animateToastOut } from "../lib/motion";

type Item = { id: number; message: string; kind: ToastKind; closing?: boolean };

/** Стек toast'ов над нижней навигацией и панелью корзины (учёт safe-area).
 *  Автоскрытие 2.2с. Позиционирование — класс .toast-dock в index.css. */
export default function Toaster() {
  const [items, setItems] = useState<Item[]>([]);
  const timers = useRef<Set<number>>(new Set());

  useEffect(() => {
    let seq = 0;
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent).detail as { message?: string; kind?: ToastKind };
      if (!detail?.message) return;
      const id = ++seq;
      setItems((cur) => [...cur.slice(-2), { id, message: detail.message!, kind: detail.kind ?? "success" }]);
      const exitTimer = window.setTimeout(() => {
        setItems((cur) => cur.map((x) => x.id === id ? { ...x, closing: true } : x));
      }, 2000);
      const removeTimer = window.setTimeout(() => {
        setItems((cur) => cur.filter((x) => x.id !== id));
        timers.current.delete(exitTimer);
        timers.current.delete(removeTimer);
      }, 2200);
      timers.current.add(exitTimer);
      timers.current.add(removeTimer);
    };
    window.addEventListener(TOAST_EVENT, onToast);
    return () => {
      window.removeEventListener(TOAST_EVENT, onToast);
      timers.current.forEach((timer) => window.clearTimeout(timer));
      timers.current.clear();
    };
  }, []);

  if (!items.length) return null;
  return (
    // Позиция — в .toast-dock (index.css), а не инлайном: только CSS видит
    // html.has-cart-bar и поднимает стек над панелью корзины. Инлайновый style
    // ещё и перебивал lg:bottom-8, поэтому на desktop toast стоял на мобильной
    // высоте.
    // role/aria-live: toast — единственный канал для «Не удалось добавить в
    // корзину», и без объявления эта ошибка существовала только визуально.
    // Ошибка идёт как alert (перебивает), обычное подтверждение — как status
    // (дожидается паузы): «Добавлено в избранное» не должно рвать чтение.
    <div className="toast-dock pointer-events-none fixed inset-x-0 z-[60] flex flex-col items-center gap-2 px-4">
      {items.map((t) => <ToastItem key={t.id} toast={t} />)}
    </div>
  );
}

/** Отдельный компонент, а не div прямо в .map(): вход и выход анимируются
 *  по-разному (animateToastIn/animateToastOut, lib/motion.ts), а хук на это
 *  различие внутри цикла .map() не завести — правила хуков. Раньше это делали
 *  два CSS-класса (`.toast-in`/`.toast-out`) — тот же баг, что и у остальных
 *  CSS-анимаций проекта (см. lib/motion.ts, AnimatedCheck.tsx). */
function ToastItem({ toast: t }: { toast: Item }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    return t.closing ? animateToastOut(el) : animateToastIn(el);
  }, [t.closing]);

  return (
    <div
      ref={ref}
      role={t.kind === "error" ? "alert" : "status"}
      aria-live={t.kind === "error" ? "assertive" : "polite"}
      className={`pointer-events-auto max-w-xs rounded-full px-4 py-2 text-center text-[13px] font-medium text-white shadow-sheet ${
        t.kind === "error" ? "bg-danger/95" : "bg-text/95"
      }`}
    >
      {t.message}
    </div>
  );
}
