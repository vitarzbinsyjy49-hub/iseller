import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { formatPrice } from "../lib/format";
import { haptic } from "../lib/telegram";
import {
  colorHex, isExact, otherVersions, pickVariant, simLabel,
  type VariantAxis, type Variants,
} from "../lib/variants";
import { RegionFlags } from "./flags";

/** Переключатели «Цвет / Память / SIM» на странице товара.
 *
 *  Каждый вариант — отдельный товар, поэтому выбор уводит на соседнюю
 *  страницу (replace: «Назад» возвращает в каталог, а не листает цвета).
 *  Регион не переключатель: покупателю он почти никогда не важен, и четвёртый
 *  ряд кнопок только пугал бы. Показываем его одной строкой, а одинаковые
 *  конфигурации других регионов — по тапу, «другие версии». */
export default function VariantPicker({ variants, productId }: {
  variants: Variants;
  productId: number;
}) {
  const navigate = useNavigate();
  const [showOthers, setShowOthers] = useState(false);
  const others = otherVersions(variants, productId);

  function go(axis: VariantAxis, value: string) {
    if (variants.current[axis] === value) return;
    const target = pickVariant(variants, axis, value);
    if (!target || target.id === productId) return;
    haptic("light");
    navigate(`/product/${target.id}`, { replace: true });
  }

  return (
    <div className="mt-4 space-y-3.5">
      {variants.axes.color.length > 1 && (
        <Row label="Цвет" value={variants.current.color}>
          {variants.axes.color.map((c) => {
            const active = c === variants.current.color;
            return (
              <button key={c} onClick={() => go("color", c)} aria-label={c} aria-pressed={active}
                className="tap flex h-11 w-11 items-center justify-center rounded-full">
                <span
                  className={`h-8 w-8 rounded-full border border-black/10 ${
                    active ? "ring-2 ring-accent ring-offset-2 ring-offset-bg" : ""
                  } ${isExact(variants, "color", c) ? "" : "opacity-50"}`}
                  style={{ background: colorHex(c) }}
                />
              </button>
            );
          })}
        </Row>
      )}

      {variants.axes.storage.length > 1 && (
        <Row label="Память">
          {variants.axes.storage.map((s) => (
            <Chip key={s} active={s === variants.current.storage}
              dim={!isExact(variants, "storage", s)} onClick={() => go("storage", s)}>
              {s}
            </Chip>
          ))}
        </Row>
      )}

      {variants.axes.sim.length > 1 && (
        <Row label="SIM">
          {variants.axes.sim.map((s) => (
            <Chip key={s} active={s === variants.current.sim}
              dim={!isExact(variants, "sim", s)} onClick={() => go("sim", s)}>
              {simLabel(s)}
            </Chip>
          ))}
        </Row>
      )}

      {variants.current.regions.length > 0 && (
        <div className="text-[12px] text-muted">
          <span className="inline-flex items-center gap-1.5">
            Версия: <RegionFlags codes={variants.current.regions} />
            {others.length > 0 && (
              <button onClick={() => setShowOthers((x) => !x)}
                className="tap -my-2 px-1 py-2 font-medium text-accent">
                другие версии ({others.length})
              </button>
            )}
          </span>
          {showOthers && (
            <div className="mt-2 flex flex-col gap-1.5">
              {others.map((o) => (
                <button key={o.id}
                  onClick={() => navigate(`/product/${o.id}`, { replace: true })}
                  className="tap flex min-h-11 items-center justify-between rounded-field border border-border bg-surface px-3 text-[13px]">
                  <span className="inline-flex items-center gap-2">
                    <RegionFlags codes={o.regions} />
                    {o.in_stock ? "" : <span className="text-muted">нет в наличии</span>}
                  </span>
                  <span className="font-semibold text-text">{formatPrice(o.price)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value, children }: {
  label: string; value?: string; children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-1.5 text-[12px] text-muted">
        {label}{value && <span className="ml-1 font-medium text-text">{value}</span>}
      </p>
      <div className="-ml-1.5 flex flex-wrap gap-1">{children}</div>
    </div>
  );
}

function Chip({ active, dim, onClick, children }: {
  active: boolean; dim: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} aria-pressed={active}
      className={`tap ml-1.5 h-10 min-w-[64px] rounded-field border px-3 text-[13px] font-medium ${
        active
          ? "border-accent bg-accent/10 text-text"
          : `border-border bg-surface text-text ${dim ? "opacity-50" : ""}`
      }`}>
      {children}
    </button>
  );
}
