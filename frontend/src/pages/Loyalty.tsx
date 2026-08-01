/** Экран «Баллы»: счёт, уровень, лестница, история и роудмап.
 *
 *  Все цифры и вся лестница приходят из `/api/loyalty/me`. Своих порогов экран
 *  не знает: копия лестницы во фронте разъехалась бы с бэкендом, и человек
 *  увидел бы не тот уровень, по которому ему начисляют.
 */
import { lazy, Suspense, useEffect, useState } from "react";
import { track } from "../lib/analytics";
import {
  fetchLoyalty, formatPoints, formatRate, progressPercent, KIND_LABEL,
  type LoyaltyAccount, type LoyaltyLevel,
} from "../lib/loyalty";

const LoyaltyRoadmapSheet = lazy(() => import("../components/LoyaltyRoadmapSheet"));

const RUB = (v: number) => `${Math.round(v).toLocaleString("ru-RU")} ₽`;

function LevelRow({ level, index, current, reached }: {
  level: LoyaltyLevel; index: number; current: boolean; reached: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded-field px-3.5 py-3 ${
        current ? "bg-accent/10 ring-1 ring-accent/30" : "bg-mutedbg"
      }`}
    >
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] font-bold ${
        reached ? "bg-accent text-white" : "bg-surface text-muted"
      }`}>
        {/* Ступень, а не ставка: ставка стоит строкой ниже, и «0,25» в кружке
            было бы вторым написанием того же числа — мелким и хуже читаемым. */}
        {reached ? "✓" : index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold leading-5">
          {level.title}
          {current && <span className="ml-2 text-[11px] font-bold uppercase tracking-wide text-accent">ваш уровень</span>}
        </p>
        <p className="mt-0.5 text-[12px] leading-4 text-muted">
          Кэшбек {formatRate(level.rate_bps)} · от {RUB(level.threshold)} покупок
        </p>
      </div>
    </div>
  );
}

export default function Loyalty() {
  const [account, setAccount] = useState<LoyaltyAccount | null>(null);
  const [failed, setFailed] = useState(false);
  const [roadmap, setRoadmap] = useState(false);

  useEffect(() => {
    track("loyalty_opened", {});
    fetchLoyalty().then(setAccount).catch(() => setFailed(true));
  }, []);

  function openRoadmap() {
    track("loyalty_roadmap_opened", {});
    setRoadmap(true);
  }

  if (failed) {
    return (
      <div className="mx-auto max-w-md lg:max-w-3xl">
        <h1 className="text-2xl font-bold">Баллы</h1>
        <p className="mt-4 text-sm text-muted">
          Не удалось загрузить счёт. Откройте экран ещё раз — данные никуда не делись.
        </p>
      </div>
    );
  }

  if (!account) {
    return (
      <div className="mx-auto max-w-md lg:max-w-3xl">
        <h1 className="text-2xl font-bold">Баллы</h1>
        <div className="mt-4 h-32 animate-pulse rounded-xl2 bg-mutedbg" />
      </div>
    );
  }

  const { level, next_level: next } = account;

  return (
    <div className="mx-auto max-w-md pb-6 lg:max-w-3xl">
      <h1 className="text-2xl font-bold">Баллы</h1>

      {/* ---- Счёт ---- */}
      <div className="mt-4 rounded-xl2 bg-gradient-to-r from-[#e3f2fd] to-[#e8eaf6] p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">Ваш баланс</p>
        <p className="mt-1 text-[32px] font-bold leading-9">{formatPoints(account.balance)}</p>
        <p className="mt-1 text-[13px] text-muted">
          {account.balance > 0
            ? `Это ${RUB(account.balance)} скидки на следующую покупку`
            : "Баллы начисляются после покупки — кэшбеком от суммы"}
        </p>

        <div className="mt-4 flex items-center justify-between text-[13px] font-semibold">
          <span>{level.title} · кэшбек {formatRate(level.rate_bps)}</span>
          {next && <span className="text-muted">до «{next.title}» {RUB(account.to_next)}</span>}
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface/70">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-500"
            style={{ width: `${progressPercent(account.ratio)}%` }}
          />
        </div>
        <p className="mt-2 text-[12px] text-muted">
          Покупок за всё время: {RUB(account.lifetime_spent)}
        </p>
      </div>

      {/* ---- Роудмап ---- */}
      <button
        onClick={openRoadmap}
        className="tap mt-3 flex w-full items-center gap-3 rounded-xl2 bg-surface p-4 text-left shadow-soft"
      >
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-field bg-accent/10 text-xl">
          ✨
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold">Что будет дальше</span>
          <span className="mt-0.5 block text-xs leading-4 text-muted">
            Списание в корзине, автоначисление, бонусы — планы программы
          </span>
        </span>
        <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-muted" fill="none"
          stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>

      {/* ---- Лестница ---- */}
      <h2 className="mt-6 text-[15px] font-bold">Уровни</h2>
      <div className="mt-2 space-y-2">
        {account.levels.map((l, i) => (
          <LevelRow
            key={l.key}
            level={l}
            index={i}
            current={l.key === level.key}
            reached={account.lifetime_spent >= l.threshold}
          />
        ))}
      </div>
      <p className="mt-2 text-[12px] leading-4 text-muted">
        Уровень зависит от суммы покупок за всё время и не понижается, когда вы
        тратите баллы.
      </p>

      {/* ---- История ---- */}
      <h2 className="mt-6 text-[15px] font-bold">История</h2>
      {account.history.length === 0 ? (
        <p className="mt-2 text-[13px] text-muted">
          Операций пока не было. Первый кэшбек появится здесь после покупки.
        </p>
      ) : (
        <div className="mt-2 overflow-hidden rounded-xl2 bg-surface shadow-soft">
          {account.history.map((t) => (
            <div key={t.id} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-0">
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-semibold leading-5">{KIND_LABEL[t.kind] ?? t.kind}</p>
                <p className="mt-0.5 text-[12px] leading-4 text-muted">
                  {t.created_at ? new Date(t.created_at).toLocaleDateString("ru-RU") : ""}
                  {t.amount != null && ` · покупка на ${RUB(t.amount)}`}
                  {t.comment && ` · ${t.comment}`}
                </p>
              </div>
              <span className={`shrink-0 text-[15px] font-bold ${t.points < 0 ? "text-muted" : "text-accent"}`}>
                {t.points > 0 ? "+" : ""}{t.points.toLocaleString("ru-RU")}
              </span>
            </div>
          ))}
        </div>
      )}

      {roadmap && (
        <Suspense fallback={null}>
          <LoyaltyRoadmapSheet onClose={() => setRoadmap(false)} />
        </Suspense>
      )}
    </div>
  );
}
