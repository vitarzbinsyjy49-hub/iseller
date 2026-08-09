import type { KeyboardEvent } from "react";

/** Переключатель на два положения. Один компонент на оба тумблера главной:
 *  «Категории / Бренды» над чипами навигации и «Каталог / AI» в строке поиска.
 *
 *  Фиксированная высота обязательна: тумблер стоит над рядом чипов и внутри
 *  строки поиска, и «прыжок» вёрстки при переключении заметен сразу.
 *
 *  variant: на тёмном hero и на светлой поверхности нужен разный контраст —
 *  это единственное, чем два использования отличаются.
 */
export type SegmentedOption<T extends string> = { value: T; label: string };

export function SegmentedToggle<T extends string>({
  value, onChange, options, ariaLabel, variant = "on-surface",
}: {
  value: T;
  onChange: (next: T) => void;
  options: readonly SegmentedOption<T>[];
  ariaLabel: string;
  variant?: "on-dark" | "on-surface";
}) {
  const track = variant === "on-dark"
    ? "bg-white/[0.13] ring-1 ring-inset ring-white/15"
    : "bg-mutedbg";
  const active = variant === "on-dark"
    ? "bg-white text-text shadow-soft"
    : "bg-surface text-text shadow-soft";
  const idle = variant === "on-dark" ? "text-white/80" : "text-muted";

  /** Стрелки переключают положения — ожидаемое поведение tablist с клавиатуры. */
  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === value);
    const next = e.key === "ArrowRight" ? i + 1 : i - 1;
    const target = options[(next + options.length) % options.length];
    if (target) onChange(target.value);
  }

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      // h-11, а не h-9: положения тумблера — обычные кнопки, и 32px высоты им
      // мало по правилу 44×44. Высота по-прежнему фиксированная (см. выше).
      className={`inline-flex h-11 shrink-0 items-center gap-0.5 rounded-full p-0.5 ${track}`}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={`tap h-10 whitespace-nowrap rounded-full px-3.5 text-[13px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent ${selected ? active : idle}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
