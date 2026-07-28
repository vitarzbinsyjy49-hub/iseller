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
      className={`inline-flex h-9 shrink-0 items-center gap-0.5 rounded-full p-0.5 ${track}`}
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
            className={`tap h-8 whitespace-nowrap rounded-full px-3.5 text-[13px] font-semibold transition-colors ${selected ? active : idle}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
