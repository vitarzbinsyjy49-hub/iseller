/** Знак Claude (патч 1.2).
 *
 *  Это АТРИБУЦИЯ реально используемого движка, а не партнёрский блок: магазин
 *  действительно отвечает через Claude (`AI_PROVIDER=anthropic`), и бейдж
 *  показывается только когда backend это подтвердил (`ai_vendor` в
 *  `/api/config/public`). Никакого одобрения со стороны Anthropic он не
 *  означает и означать не должен — формулировки подобраны соответственно.
 *
 *  Знак нарисован лучами по кругу: одиннадцать сужающихся к центру штрихов,
 *  повёрнутых с равным шагом. Так он остаётся чётким на любом размере и в
 *  любой теме, потому что это геометрия, а не картинка.
 */

/** Фирменный тёплый оранжевый Claude. Держим одной константой: цвет знака и
 *  акценты роудмапа обязаны совпадать, иначе блок распадается на два разных. */
export const CLAUDE_ORANGE = "#D97757";

const RAYS = 11;

export function ClaudeMark({ className = "h-4 w-4", color = CLAUDE_ORANGE }: {
  className?: string;
  color?: string;
}) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden focusable="false">
      {Array.from({ length: RAYS }, (_, i) => (
        <path
          key={i}
          // Луч: широкий у внешнего края, сходящийся в точку к центру.
          d="M12 1.6 L13.15 8.4 L12 12 L10.85 8.4 Z"
          fill={color}
          transform={`rotate(${(360 / RAYS) * i} 12 12)`}
        />
      ))}
    </svg>
  );
}

/** Подпись «Powered by Claude» со знаком. Используется как содержимое кнопки,
 *  открывающей роудмап, поэтому сама по себе не интерактивна. */
export function PoweredByClaude({ model }: { model?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <ClaudeMark className="h-[15px] w-[15px]" />
      <span className="text-[12px] font-semibold tracking-tight">Powered by Claude</span>
      {model && (
        <span className="hidden text-[11px] font-medium text-muted sm:inline">{model}</span>
      )}
    </span>
  );
}
