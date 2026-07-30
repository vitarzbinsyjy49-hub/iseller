import { useEffect, useState } from "react";
import { TOAST_EVENT, type ToastKind } from "../lib/toast";

type Item = { id: number; message: string; kind: ToastKind };

/** Стек toast'ов над нижней навигацией и панелью корзины (учёт safe-area).
 *  Автоскрытие 2.2с. Позиционирование — класс .toast-dock в index.css. */
export default function Toaster() {
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => {
    let seq = 0;
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent).detail as { message?: string; kind?: ToastKind };
      if (!detail?.message) return;
      const id = ++seq;
      setItems((cur) => [...cur.slice(-2), { id, message: detail.message!, kind: detail.kind ?? "success" }]);
      window.setTimeout(() => setItems((cur) => cur.filter((x) => x.id !== id)), 2200);
    };
    window.addEventListener(TOAST_EVENT, onToast);
    return () => window.removeEventListener(TOAST_EVENT, onToast);
  }, []);

  if (!items.length) return null;
  return (
    // Позиция — в .toast-dock (index.css), а не инлайном: только CSS видит
    // html.has-cart-bar и поднимает стек над панелью корзины. Инлайновый style
    // ещё и перебивал lg:bottom-8, поэтому на desktop toast стоял на мобильной
    // высоте.
    <div className="toast-dock pointer-events-none fixed inset-x-0 z-[60] flex flex-col items-center gap-2 px-4">
      {items.map((t) => (
        <div
          key={t.id}
          className={`pop-in pointer-events-auto max-w-xs rounded-full px-4 py-2 text-center text-[13px] font-medium text-white shadow-sheet ${
            t.kind === "error" ? "bg-[#d92c3c]/95" : "bg-text/95"
          }`}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
