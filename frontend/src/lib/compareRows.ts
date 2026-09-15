/** Сравнение товаров из ответа AI — строки таблицы.
 *
 *  Таблицу собирает ФРОНТ ИЗ КАРТОЧЕК, а не из текста модели. Это не удобство,
 *  а тот же инвариант, на котором держится весь AI в проекте: карточки и цены
 *  берутся только из `to_card()`. Модель говорит «почему», таблица — «что», и
 *  соврать в ней модель физически не может, потому что она её не пишет.
 *
 *  Чистая функция без React: всё решение о том, какие строки показывать,
 *  проверяется тестами без DOM.
 */
import type { ProductCard } from "../components/ai/types";
import { formatPrice } from "./format";

export type CompareRow = { label: string; values: string[] };

/** Больше трёх колонок на телефоне нечитаемо даже с горизонтальной прокруткой:
 *  на 375px это по ~90px на товар вместе с названием. */
const MAX_COLUMNS = 3;

const CONDITION_LABEL: Record<string, string> = {
  new: "Новый",
  used: "Б/у",
  refurbished: "Восстановленный",
};

/** Строка выходит, только если значения РАЗНЫЕ. Строка, одинаковая во всех
 *  колонках, не сообщает ничего: человек пришёл увидеть разницу, а не список
 *  совпадений. Это же правило избавляет от таблицы у вариантов одной модели,
 *  отличающихся только цветом. */
function differs(values: string[]): boolean {
  return new Set(values).size > 1;
}

function priceValue(c: ProductCard): string {
  // price_note важнее цены: у предзаказа собственной цены ещё не существует, и
  // любая цифра читается как обещание магазина (см. types.ts).
  if (c.price_note) return c.price_note;
  return formatPrice(c.price);
}

function discountValue(c: ProductCard): string {
  const pct = c.discount_percent;
  return typeof pct === "number" && pct > 0 ? `−${pct}%` : "—";
}

function ratingValue(c: ProductCard): string {
  // Запятая, а не точка: строка русская, и «4.8» выглядит инородно.
  return typeof c.rating === "number" ? c.rating.toFixed(1).replace(".", ",") : "—";
}

export function compareRows(cards: ProductCard[]): CompareRow[] {
  if (cards.length < 2 || cards.length > MAX_COLUMNS) return [];

  // Порядок постоянный и отвечает тому, как выбирают технику: сначала сколько
  // стоит, потом можно ли забрать, дальше остальное.
  const candidates: CompareRow[] = [
    { label: "Цена", values: cards.map(priceValue) },
    { label: "Наличие", values: cards.map((c) => (c.in_stock ? "Есть" : "Под заказ")) },
    { label: "Рейтинг", values: cards.map(ratingValue) },
    { label: "Скидка", values: cards.map(discountValue) },
    { label: "Состояние", values: cards.map((c) => CONDITION_LABEL[c.condition ?? "new"] ?? "—") },
    { label: "Поставка", values: cards.map((c) => (c.region_codes ?? []).join(", ") || "—") },
  ];

  return candidates.filter((row) => differs(row.values));
}

/** Заголовки колонок: названия товаров БЕЗ общего начала.
 *
 *  Варианты одной модели отличаются хвостом («…256 ГБ Orange» против «…512 ГБ
 *  Blue»), а начало у них общее и длинное. Повторив его в каждой колонке, мы
 *  тратим всю ширину телефона на то, что и так одинаково, — а разницу, ради
 *  которой таблицу и открыли, выталкиваем за край.
 *
 *  Срез только по ЦЕЛЫМ словам и только если в каждой колонке что-то осталось:
 *  пустой заголовок хуже длинного. Название берётся очищенное от кодов региона
 *  (`title_clean`), они в заголовке не нужны — для них есть строка «Поставка».
 */
export function columnLabels(cards: ProductCard[]): string[] {
  const full = cards.map((c) => (c.title_clean ?? c.title).trim());
  if (full.length < 2) return full;

  const words = full.map((t) => t.split(/\s+/));
  const shortest = Math.min(...words.map((w) => w.length));
  let common = 0;
  while (common < shortest && words.every((w) => w[common] === words[0][common])) common++;

  // Срез оставил бы колонку пустой (одно название — начало другого, или они
  // совпадают целиком). Тогда показываем как есть.
  if (common === 0 || words.some((w) => w.length <= common)) return full;
  return words.map((w) => w.slice(common).join(" "));
}
