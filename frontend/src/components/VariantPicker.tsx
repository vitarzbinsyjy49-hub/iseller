import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { formatPrice } from "../lib/format";
import { haptic } from "../lib/telegram";
import {
  COLOR_AXIS, colorHex, isExact, otherVersions, pickVariant, valueLabel, type Variants,
} from "../lib/variants";
import { RegionFlags } from "./flags";

/** Переключатели вариантов на странице товара: цвет, память, конфигурация…
 *
 *  Ряды строятся из осей, которые пришли с backend (у iPhone — цвет, память,
 *  SIM; у Mac — цвет и конфигурация), поэтому новая линейка не требует правки
 *  экрана. Цвет рисуется кружками, остальное — кнопками.
 *
 *  Каждый вариант — отдельный товар, поэтому выбор уводит на соседнюю
 *  страницу (replace: «Назад» возвращает в каталог, а не листает цвета).
 *  Регион не переключатель: покупателю он почти никогда не важен, и лишний ряд
 *  кнопок только пугал бы. Показываем его одной строкой, а одинаковые
 *  конфигурации других регионов — по тапу, «другие версии». */
export default function VariantPicker({ variants, productId }: {
  variants: Variants;
  productId: number;
}) {
  const navigate = useNavigate();
  const [showOthers, setShowOthers] = useState(false);
  const others = otherVersions(variants, productId);
  const current = variants.current.values;

  function go(axis: string, value: string) {
    if (current[axis] === value) return;
    const target = pickVariant(variants, axis, value);
    if (!target || target.id === productId) return;
    haptic("light");
    navigate(`/product/${target.id}`, { replace: true });
  }

  return (
    <div className="mt-4 space-y-3.5">
      {variants.axes.map((axis) => (
        <Row key={axis.name} label={axis.name}
          value={axis.name === COLOR_AXIS ? current[axis.name] : undefined}>
          {axis.values.map((value) => {
            const active = current[axis.name] === value;
            const dim = !isExact(variants, axis.name, value);
            if (axis.name === COLOR_AXIS) {
              return (
                <button key={value} onClick={() => go(axis.name, value)} aria-label={value}
                  aria-pressed={active}
                  className="tap flex h-11 w-11 items-center justify-center rounded-full">
                  <span
                    className={`h-8 w-8 rounded-full border border-black/10 ${
                      active ? "ring-2 ring-accent ring-offset-2 ring-offset-bg" : ""
                    } ${dim ? "opacity-50" : ""}`}
                    style={{ background: colorHex(value) }}
                  />
                </button>
              );
            }
            return (
              <Chip key={value} active={active} dim={dim} onClick={() => go(axis.name, value)}>
                {valueLabel(axis.name, value)}
              </Chip>
            );
          })}
        </Row>
      ))}

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

function Row({ label, value, children }: { label: string; value?: string; children: ReactNode }) {
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
  active: boolean; dim: boolean; onClick: () => void; children: ReactNode;
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
