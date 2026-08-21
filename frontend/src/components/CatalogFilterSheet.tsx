/** Шторки каталога (v5.6.0): сортировка и фильтры.
 *
 *  Раньше и то и другое стояло прямо над выдачей отдельным рядом из семи
 *  элементов. Ряд занимал примерно треть первого экрана и всем весом спорил с
 *  товаром — тем единственным, ради чего сюда заходят. Управление свёрнуто в
 *  две кнопки, содержимое переехало сюда.
 *
 *  Шелл общий (`SheetShell` из ScenarioSheet) — тот же portal, focus trap,
 *  блокировка фонового скролла, Escape и та же анимация выезда снизу, что у
 *  остальных шторок. Второй шелл означал бы вторую ловушку фокуса, а
 *  расходятся они молча и обнаруживаются только с клавиатуры.
 *
 *  Обе шторки применяют выбор СРАЗУ, без кнопки «Применить»: выдача под ними
 *  живая, и человек видит результат тем же движением, каким его задаёт.
 *  Отдельный шаг подтверждения нужен там, где действие необратимо, — здесь оно
 *  снимается тем же тапом.
 */
import { SheetShell, type SheetClose } from "./ScenarioSheet";
import { Icon } from "./icons";
import { activeFilterCount, type CatalogFilters } from "../lib/catalogFilters";

function SheetHeader({ title, id, close }: { title: string; id: string; close: SheetClose }) {
  return (
    <>
      <div className="mx-auto mt-3 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden />
      <div className="flex items-center gap-3 px-5 pb-2 pt-3">
        <h2 id={id} className="min-w-0 flex-1 text-[17px] font-bold leading-6">{title}</h2>
        <button
          onClick={() => close()}
          aria-label="Закрыть"
          className="tap -mr-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted outline-none hover:bg-mutedbg focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Icon name="close" className="h-4 w-4" strokeWidth={2.2} />
        </button>
      </div>
    </>
  );
}

/** Строка выбора. Отмечает выбранное галочкой, а не заливкой всей строки:
 *  список из подсвеченных прямоугольников — это снова тот же визуальный шум,
 *  от которого мы уходим. */
function OptionRow({ label, selected, onClick }: {
  label: string; selected: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      role="option"
      aria-selected={selected}
      className="tap flex min-h-[52px] w-full items-center justify-between gap-3 px-5 text-left text-[15px] outline-none focus-visible:bg-mutedbg"
    >
      <span className={selected ? "font-semibold text-text" : "text-text"}>{label}</span>
      {selected && <Icon name="check" className="h-4 w-4 shrink-0 text-accent" strokeWidth={2.4} />}
    </button>
  );
}

/** Переключатель-строка. Вся строка — цель нажатия: попадать пальцем в
 *  маленький квадратик справа на витрине незачем. */
function ToggleRow({ label, hint, checked, onChange }: {
  label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      className="tap flex min-h-[52px] w-full items-center justify-between gap-3 px-5 text-left outline-none focus-visible:bg-mutedbg"
    >
      <span className="min-w-0">
        <span className="block text-[15px] text-text">{label}</span>
        {hint && <span className="block text-[12px] text-muted">{hint}</span>}
      </span>
      <span
        aria-hidden
        className={`flex h-6 w-10 shrink-0 items-center rounded-full px-0.5 transition-colors ${
          checked ? "bg-accent" : "bg-mutedbg"
        }`}
      >
        <span
          className={`h-5 w-5 rounded-full bg-surface shadow-soft transition-transform ${
            checked ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </span>
    </button>
  );
}

export function CatalogSortSheet({ sorts, value, onPick, onClose }: {
  sorts: ReadonlyArray<{ key: string; label: string }>;
  value: string;
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  return (
    <SheetShell onClose={onClose} labelledBy="catalog-sort-title">
      {(close) => (
        <>
          <SheetHeader title="Сортировка" id="catalog-sort-title" close={close} />
          <div role="listbox" aria-labelledby="catalog-sort-title" className="pb-2">
            {sorts.map((s) => (
              <OptionRow
                key={s.key}
                label={s.label}
                selected={s.key === value}
                // Закрываем ПОСЛЕ выбора: сортировка одна, и держать шторку
                // открытой после неё незачем — она закроет собой результат,
                // ради которого её и открыли.
                onClick={() => close(() => onPick(s.key))}
              />
            ))}
          </div>
        </>
      )}
    </SheetShell>
  );
}

export function CatalogFilterSheet({ value, brands, onChange, onReset, onClose }: {
  value: CatalogFilters;
  brands: string[];
  onChange: (patch: Partial<CatalogFilters>) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const count = activeFilterCount(value);
  return (
    <SheetShell onClose={onClose} labelledBy="catalog-filters-title">
      {(close) => (
        <>
          <SheetHeader title="Фильтры" id="catalog-filters-title" close={close} />

          <div className="min-h-0 flex-1 overflow-y-auto pb-2">
            <ToggleRow
              label="Только в наличии"
              checked={value.onlyStock}
              onChange={(v) => onChange({ onlyStock: v })}
            />
            <ToggleRow
              label="Забрать сегодня"
              hint="Товары, которые можно получить в день обращения"
              checked={value.onlyToday}
              onChange={(v) => onChange({ onlyToday: v })}
            />

            {brands.length > 0 && (
              <div className="px-5 pt-3">
                <label htmlFor="catalog-filter-brand" className="block text-[12px] font-medium text-muted">
                  Бренд
                </label>
                <select
                  id="catalog-filter-brand"
                  value={value.brand}
                  onChange={(e) => onChange({ brand: e.target.value })}
                  className="tap mt-1.5 h-11 w-full appearance-none rounded-field border border-border bg-surface px-3 text-[15px] outline-none focus-visible:border-accent"
                >
                  <option value="">Любой</option>
                  {brands.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
            )}

            <div className="px-5 pb-4 pt-3">
              <label htmlFor="catalog-filter-price" className="block text-[12px] font-medium text-muted">
                Цена до, ₽
              </label>
              <input
                id="catalog-filter-price"
                value={value.priceMax}
                onChange={(e) => onChange({ priceMax: e.target.value.replace(/\D/g, "") })}
                placeholder="Без ограничения"
                inputMode="numeric"
                className="tap mt-1.5 h-11 w-full rounded-field border border-border bg-surface px-3 text-[15px] outline-none placeholder:text-muted focus-visible:border-accent"
              />
            </div>
          </div>

          {/* Нижняя строка действий. «Сбросить» появляется только когда есть
              что сбрасывать: неактивная кнопка рядом с активной читается как
              поломка, а её отсутствие — как «сбрасывать нечего». */}
          <div className="flex shrink-0 items-center gap-2 border-t border-border px-5 py-3">
            {count > 0 && (
              <button
                onClick={onReset}
                className="tap h-11 shrink-0 rounded-field px-4 text-[15px] font-medium text-muted outline-none hover:bg-mutedbg focus-visible:ring-2 focus-visible:ring-accent"
              >
                Сбросить
              </button>
            )}
            <button
              onClick={() => close()}
              className="tap ml-auto h-11 flex-1 rounded-field bg-accent px-4 text-[15px] font-semibold text-white outline-none hover:bg-accentdark focus-visible:ring-2 focus-visible:ring-accent"
            >
              Показать
            </button>
          </div>
        </>
      )}
    </SheetShell>
  );
}
