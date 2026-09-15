/** Таблица различий между товарами из ответа AI.
 *
 *  Заполняется ИЗ КАРТОЧЕК (`to_card()`), а не из текста модели: модель
 *  объясняет «почему», таблица показывает «что». Соврать в ней модель не может,
 *  потому что она её не пишет — тот же инвариант, что и у цен на витрине.
 *
 *  Какие строки показывать, решает чистая lib/compareRows: строка без разницы
 *  между колонками не выходит вовсе.
 */
import type { ProductCard } from "./types";
import { columnLabels, compareRows } from "../../lib/compareRows";

export default function CompareTable({ cards }: { cards: ProductCard[] }) {
  const rows = compareRows(cards);
  const labels = columnLabels(cards);
  // Ни одной различающейся строки — таблицы нет. Пустая шапка с названиями
  // товаров и без содержимого выглядела бы как недогруженная.
  if (rows.length === 0) return null;

  return (
    // Горизонтальная прокрутка — единственное исключение из «страница не
    // скроллит вбок»: три колонки с названиями на 375px иначе не помещаются.
    <div className="mt-3 overflow-x-auto rounded-xl2 border border-border bg-surface">
      <table className="w-full min-w-[300px] border-collapse text-[13px]">
        <caption className="sr-only">Чем отличаются предложенные товары</caption>
        <thead>
          <tr>
            <th scope="col" className="w-[76px] px-3 py-2.5 text-left font-normal text-muted">
              <span className="sr-only">Характеристика</span>
            </th>
            {cards.map((c, i) => (
              <th key={c.id} scope="col" className="px-3 py-2.5 text-left align-bottom font-medium leading-4">
                {/* Заголовок — только то, чем товар ОТЛИЧАЕТСЯ от соседей;
                    общее начало названия снято (columnLabels). Полное название
                    остаётся доступным наведением и скринридеру. */}
                <span className="line-clamp-2" title={c.title_clean ?? c.title}>{labels[i]}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-t border-border">
              <th scope="row" className="px-3 py-2.5 text-left font-normal text-muted">{row.label}</th>
              {row.values.map((value, i) => (
                // whitespace-nowrap: formatPrice ставит ОБЫЧНЫЙ пробел перед «₽»
                // (неразрывный — только внутри числа), и в узкой колонке знак
                // рубля уезжал бы на свою строку.
                <td key={cards[i].id} className="whitespace-nowrap px-3 py-2.5 font-medium">{value}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
