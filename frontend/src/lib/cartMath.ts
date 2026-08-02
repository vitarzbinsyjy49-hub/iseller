/** Чистая арифметика и правила корзины.
 *
 *  Здесь нет ни React, ни fetch — только функции от данных. Это осознанно:
 *  суммы, лимиты количества и решение «показывать ли панель корзины» проверяются
 *  тестами в node-окружении, как и остальная логика проекта (navTiles, scenario,
 *  carousel). Всё, что умеет ошибиться в подсчёте денег, обязано быть здесь.
 *
 *  Backend считает то же самое и остаётся источником правды: эти функции нужны
 *  для оптимистичного UI между нажатием и ответом сервера.
 */

/** Режим доступности товара — зеркало services/availability.py. */
export type AvailabilityMode =
  | "in_stock" | "limited" | "preorder" | "on_request" | "out_of_stock" | "unavailable";

export type CartItemRow = {
  id: number;
  product_id: number;
  sku?: string | null;
  title: string;
  brand?: string | null;
  category?: string | null;
  image: string;
  /** Актуальная цена из каталога. null — товара больше нет. */
  price: number | null;
  /** Цена на момент добавления. Только для сравнения, НЕ для подсчёта суммы. */
  added_price: number | null;
  price_changed: boolean;
  quantity: number;
  line_total: number;
  availability_mode: AvailabilityMode;
  availability_label: string;
  availability_note: string;
  orderable: boolean;
  max_quantity: number;
};

export type CartState = {
  cart_id: number | null;
  items: CartItemRow[];
  positions_count: number;
  items_count: number;
  estimated_total: number;
  currency: string;
  has_unavailable: boolean;
  has_price_changes: boolean;
  max_positions: number;
};

export const EMPTY_CART: CartState = {
  cart_id: null,
  items: [],
  positions_count: 0,
  items_count: 0,
  estimated_total: 0,
  currency: "RUB",
  has_unavailable: false,
  has_price_changes: false,
  max_positions: 50,
};

/** Режимы, которые можно положить в корзину (то же множество, что на backend). */
const ORDERABLE: AvailabilityMode[] = ["in_stock", "limited", "preorder", "on_request"];

export function canAddToCart(mode?: AvailabilityMode | null): boolean {
  return !!mode && ORDERABLE.includes(mode);
}

/** Подпись наличия для карточки товара.
 *
 *  Читает РЕЖИМ, а не голый in_stock: у предзаказа in_stock=true, и карточка
 *  писала «В наличии», пока в корзине тот же товар честно помечался
 *  предзаказом. Две разные правды об одном товаре на соседних экранах хуже,
 *  чем одна скучная.
 *
 *  Ответ без режима (кэш прошлого визита, фикстура AI) читается как раньше —
 *  по in_stock: старые данные не должны менять смысл подписи.
 */
export function availabilityText(
  card: { availability_mode?: AvailabilityMode | null; in_stock?: boolean; is_available_today?: boolean },
): string {
  const inStockLabel = card.is_available_today ? "В наличии · Сегодня" : "В наличии";
  switch (card.availability_mode) {
    case "preorder": return "Предзаказ";
    case "on_request": return "Под заказ";
    case "out_of_stock": return "Нет в наличии";
    case "unavailable": return "Недоступен";
    case "in_stock":
    case "limited": return inStockLabel;
    default: return card.in_stock ? inStockLabel : "Под заказ";
  }
}

/** Цвет подписи наличия: зелёный только у реально доступного «сейчас». */
export function availabilityTone(
  card: { availability_mode?: AvailabilityMode | null; in_stock?: boolean },
): "text-green" | "text-muted" {
  switch (card.availability_mode) {
    case "in_stock":
    case "limited": return "text-green";
    case "preorder":
    case "on_request":
    case "out_of_stock":
    case "unavailable": return "text-muted";
    default: return card.in_stock ? "text-green" : "text-muted";
  }
}

/** Русская плюрализация: «1 товар», «2 товара», «5 товаров». */
export function pluralItems(n: number): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return `${n} товаров`;
  if (last === 1) return `${n} товар`;
  if (last >= 2 && last <= 4) return `${n} товара`;
  return `${n} товаров`;
}

/** Привести количество к [1, max]. max <= 0 означает «нельзя заказать» -> 0. */
export function clampQuantity(quantity: number, max: number): number {
  if (!Number.isFinite(quantity)) return 1;
  if (max <= 0) return 0;
  return Math.max(1, Math.min(Math.round(quantity), max));
}

/** Следующее количество после нажатия «+»/«−». 0 = позицию нужно удалить. */
export function nextQuantity(current: number, delta: number, max: number): number {
  const next = Math.round(current) + delta;
  if (next <= 0) return 0;
  return clampQuantity(next, max);
}

/** Пересчёт итогов по позициям.
 *
 *  Сумма считается ТОЛЬКО по позициям, которые реально можно отправить:
 *  складывать в неё недоступный товар значит обещать цену за то, чего нет.
 */
export function recalcTotals(items: CartItemRow[]): Pick<
  CartState, "positions_count" | "items_count" | "estimated_total" | "has_unavailable" | "has_price_changes"
> {
  const orderable = items.filter((i) => i.orderable);
  return {
    positions_count: items.length,
    items_count: orderable.reduce((sum, i) => sum + i.quantity, 0),
    estimated_total: round2(orderable.reduce((sum, i) => sum + (i.price ?? 0) * i.quantity, 0)),
    has_unavailable: items.some((i) => !i.orderable),
    has_price_changes: items.some((i) => i.price_changed),
  };
}

/** Собрать целостное состояние из списка позиций (для оптимистичного UI). */
export function withTotals(state: CartState, items: CartItemRow[]): CartState {
  const rows = items.map((i) => ({
    ...i,
    line_total: i.orderable ? round2((i.price ?? 0) * i.quantity) : 0,
  }));
  return { ...state, items: rows, ...recalcTotals(rows) };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Показывать ли sticky-панель корзины на этом экране.
 *
 *  Общее правило: панель прячется там, где внизу УЖЕ стоит своя фиксированная
 *  панель. Две всплывающие полосы встают друг на друга и перекрывают то, ради
 *  чего человек пришёл на экран.
 *
 *  - `/cart` — там панель была бы дублем самой корзины;
 *  - `/product/…` — своя CTA внизу; она же играет роль панели («В корзину»);
 *  - `/ai` — строка ввода вопроса. Пока в корзине что-то лежало, панель
 *    накрывала поле, и написать консультанту было нельзя вовсе.
 *
 *  Вход в корзину с этих экранов не теряется: на карточке это её CTA, на `/ai`
 *  и `/cart` — кнопка корзины в шапке.
 */
export function shouldShowCartBar(pathname: string, itemsCount: number): boolean {
  if (itemsCount <= 0) return false;
  if (pathname === "/cart" || pathname.startsWith("/cart/")) return false;
  if (pathname.startsWith("/product/")) return false;
  if (pathname === "/ai" || pathname.startsWith("/ai?") || pathname.startsWith("/ai/")) return false;
  return true;
}

/** Проверка формы checkout. Возвращает текст ошибки или null.
 *
 *  Телефон обязателен, только если менеджеру некуда ответить в Telegram —
 *  то же правило, что у сценарных заявок и на backend. Просить контакт,
 *  который уже известен, — лишний шаг.
 */
export function validateCheckout(input: {
  phone: string; consent: boolean; requirePhone: boolean;
}): string | null {
  if (input.requirePhone && !input.phone.trim()) {
    return "Укажите телефон — менеджеру нужно с вами связаться";
  }
  if (!input.consent) return "Нужно согласие на обработку данных и связь";
  return null;
}

/** Ключ идемпотентности одной попытки отправки. Один ключ живёт до успеха:
 *  ретрай после таймаута обязан переиспользовать его, иначе повтор создаст
 *  вторую заявку — ровно то, от чего идемпотентность и защищает. */
export function newIdempotencyKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `ck-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
