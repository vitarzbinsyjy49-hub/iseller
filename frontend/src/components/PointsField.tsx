/** Оплата баллами в корзине.
 *
 *  Один выбор, а не две независимые галочки: баллы и промокод взаимоисключающи
 *  (решение владельца), и когда применён код, блок не гаснет молча, а называет
 *  причину. Молча погашенный блок читается как поломка — человек видит баллы
 *  на счету, тычет и ничего не происходит.
 *
 *  Сколько можно списать, решает СЕРВЕР (`points_redeemable` в ответе корзины):
 *  доля чека живёт в настройках рядом с правилом, и вторая копия здесь
 *  разъехалась бы с первой. Клиент отправляет число, а сервер его перепроверяет
 *  и на превышении отказывает — не усекает. Усечение выглядит как скидка,
 *  которой человек не просил.
 */
import { formatPoints, redeemBlockedReason } from "../lib/loyalty";

const RUB = (v: number) => `${Math.round(v).toLocaleString("ru-RU")} ₽`;

type Props = {
  balance: number;
  redeemable: number;
  promoApplied: boolean;
  /** Сколько списываем сейчас. 0 — не списываем. */
  value: number;
  onChange: (points: number) => void;
};

export default function PointsField({
  balance, redeemable, promoApplied, value, onChange,
}: Props) {
  // Баллов нет вовсе — блока тоже нет. Показывать «спишите 0» тому, кто ещё
  // ничего не накопил, значит объяснять ему, чего он лишён.
  if (balance <= 0) return null;

  const blocked = redeemBlockedReason(promoApplied, redeemable);
  const on = value > 0;

  return (
    <div className="mt-3 rounded-xl2 bg-surface p-4 shadow-soft">
      <div className="flex items-start gap-3">
        <input
          id="cart-points"
          type="checkbox"
          checked={on}
          disabled={blocked !== null}
          onChange={(e) => onChange(e.target.checked ? redeemable : 0)}
          className="mt-[3px] h-[18px] w-[18px] shrink-0 accent-[var(--accent)] disabled:opacity-40"
        />
        <label htmlFor="cart-points" className="min-w-0 flex-1 cursor-pointer">
          <span className="block text-[14px] font-semibold leading-5">
            Оплатить баллами
            {!blocked && <span className="ml-2 text-accent">−{RUB(redeemable)}</span>}
          </span>
          <span className="mt-1 block text-[12px] leading-4 text-muted">
            {blocked ?? `На счету ${formatPoints(balance)}. Один балл — рубль скидки.`}
          </span>
        </label>
      </div>
    </div>
  );
}
