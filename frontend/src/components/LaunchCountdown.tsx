/** Полоса обратного отсчёта до снятия беты.
 *
 *  Живёт на главной до момента `LAUNCH_AT` и после него исчезает сама — без
 *  деплоя и без флага на сервере. Ничего не показывает, если запуск уже был:
 *  счётчик «скоро запуск» в работающем магазине хуже, чем его отсутствие.
 *
 *  Таймер останавливается, когда приложение уходит в фон: Telegram WebView
 *  оставляет интервалы живыми, и посекундный тик в свёрнутом приложении просто
 *  греет батарею. При возврате состояние пересчитывается сразу, а не ждёт тика.
 */
import { useEffect, useState } from "react";
import { LAUNCH_AT, LAUNCH_LABEL, formatCountdown } from "../lib/launch";
import { Icon } from "./icons";

function useCountdown(): { text: string } | null {
  const [left, setLeft] = useState(() => formatCountdown(LAUNCH_AT.getTime() - Date.now()));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const stop = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };

    const tick = () => {
      const next = formatCountdown(LAUNCH_AT.getTime() - Date.now());
      setLeft(next);
      // Отсчёт кончился — таймер больше не нужен: компонент исчезает навсегда.
      if (!next) return;
      timer = setTimeout(tick, next.tickMs);
    };

    const onVisibility = () => {
      stop();
      if (!document.hidden) tick();
    };

    tick();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return left;
}

export default function LaunchCountdown({ onOpenRoadmap }: { onOpenRoadmap: () => void }) {
  const left = useCountdown();
  if (!left) return null;

  return (
    <button
      onClick={onOpenRoadmap}
      className="tap mt-3 flex w-full items-center gap-2.5 rounded-field bg-accent/10 px-3.5 py-2.5 text-left outline-none transition-colors hover:bg-accent/15 focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
        <Icon name="sparkles" className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] font-semibold leading-4">
          Снимаем бету {LAUNCH_LABEL}
        </span>
        {/* aria-live не ставим: экранный диктор, объявляющий остаток каждую
            секунду, перекрывает чтение всего остального на экране. */}
        {/* Не text-muted: полоса лежит на живом фоне, а серый на цветном
            выцветает. Тёмный с прозрачностью держит контраст и на белом, и на
            цветном пятне. */}
        <span className="block text-[11.5px] leading-4 text-text/70">
          Осталось {left.text} — что появится дальше
        </span>
      </span>
      <Icon name="chevron-down" className="h-4 w-4 shrink-0 -rotate-90 text-muted" />
    </button>
  );
}
