/** Степпер количества: −  N  +
 *
 *  Один компонент на карточку товара, деталку и строку корзины — иначе три
 *  реализации разъедутся в лимитах и в поведении «минус на единице».
 *
 *  Правила:
 *  - «−» на единице УДАЛЯЕТ позицию (onChange(0)), а не оставляет ноль;
 *  - «+» упирается в max (лимит партии) и там гаснет — молча игнорировать
 *    нажатие хуже, чем показать, что предел достигнут;
 *  - во время запроса кнопки заблокированы: очередь в lib/cart сохраняет
 *    порядок, но подмигивающий счётчик всё равно выглядит как сбой.
 */

export function QuantityStepper({
  quantity, max, busy, onChange, size = "md", ariaLabel = "Количество",
}: {
  quantity: number;
  max: number;
  busy?: boolean;
  onChange: (next: number) => void;
  size?: "sm" | "md";
  ariaLabel?: string;
}) {
  const atMax = max > 0 && quantity >= max;
  // sm тоже 44px в высоту: «−» и «+» — самые частые нажатия в корзине, и 36px
  // им мало (правило 44×44). От md отличается теперь только шириной кнопок и
  // кеглем счётчика — компактность нужна была по ширине, а не по высоте.
  const dims = size === "sm"
    ? { box: "h-11", btn: "h-11 w-10", value: "min-w-[1.75rem] text-[13px]" }
    : { box: "h-11", btn: "h-11 w-11", value: "min-w-[2.25rem] text-[15px]" };

  return (
    <div
      className={`flex ${dims.box} items-center justify-between rounded-field bg-mutedbg`}
      role="group"
      aria-label={ariaLabel}
    >
      <StepBtn
        label={quantity <= 1 ? "Удалить из корзины" : "Уменьшить количество"}
        disabled={busy}
        onClick={() => onChange(quantity - 1)}
        className={dims.btn}
      >
        {quantity <= 1 ? (
          <path d="M4 7h16M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7m2 0v12a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 7 19V7" />
        ) : (
          <path d="M6 12h12" />
        )}
      </StepBtn>

      <span className={`${dims.value} text-center font-bold tabular-nums`} aria-live="polite">
        {quantity}
      </span>

      <StepBtn
        label={atMax ? `Больше ${max} шт. недоступно` : "Увеличить количество"}
        disabled={busy || atMax}
        onClick={() => onChange(quantity + 1)}
        className={dims.btn}
      >
        <path d="M12 6v12M6 12h12" />
      </StepBtn>
    </div>
  );
}

function StepBtn({
  label, disabled, onClick, className, children,
}: {
  label: string; disabled?: boolean; onClick: () => void;
  className: string; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); onClick(); }}
      className={`tap flex ${className} items-center justify-center rounded-field text-text outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-35`}
    >
      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor"
        strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}
