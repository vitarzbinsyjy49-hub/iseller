/** Корзина: серверное хранение (/api/cart) с оптимистичным UI.
 *
 *  Тот же контракт, что у избранного (lib/favorites), и по той же причине:
 *  корзина не должна зависеть от того, с какого устройства пришёл покупатель.
 *
 *  - источник правды — backend; каждая мутация возвращает ПОЛНОЕ состояние
 *    корзины, и мы просто заменяем им локальное (никакой ручной синхронизации
 *    сумм на клиенте — их считает один и тот же код с обеих сторон);
 *  - localStorage — только кэш для мгновенной отрисовки: панель корзины и
 *    степперы видны до ответа сервера, без прыжка вёрстки;
 *  - все мутации проходят через ОДНУ очередь: два быстрых тапа по «+» уходят
 *    на сервер строго по порядку, поэтому «+1 +1» не может превратиться в «+1»;
 *  - при ошибке — откат к состоянию до попытки и исключение наверх (тост).
 */
import { useEffect, useState } from "react";
import { api } from "./api";
import {
  type CartItemRow,
  type CartState,
  EMPTY_CART,
  clampQuantity,
  withTotals,
} from "./cartMath";

const KEY = "techshop_cart";
const EVENT = "cart-changed";

function readCache(): CartState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (raw && Array.isArray(raw.items)) return { ...EMPTY_CART, ...raw };
  } catch {
    /* приватный режим или мусор в кэше — стартуем с пустой */
  }
  return EMPTY_CART;
}

let state: CartState = readCache();
/** Идёт ли сейчас запрос к серверу — для блокировки повторных нажатий. */
let busy = false;

function publish(next: CartState): void {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* кэш необязателен */
  }
  window.dispatchEvent(new Event(EVENT));
}

export function cartState(): CartState {
  return state;
}

export function cartIsBusy(): boolean {
  return busy;
}

/** Очередь мутаций: один запрос за раз, строго в порядке нажатий.
 *
 *  Порядок важнее скорости: два параллельных «+1» сервер обработал бы как две
 *  независимые записи по одной и той же паре (корзина, товар), и одно из
 *  изменений потерялось бы. */
let queue: Promise<unknown> = Promise.resolve();
/** Сколько мутаций ещё не завершилось — нужно для корректного отката. */
let pending = 0;

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  // Хвост очереди не должен «падать» из-за отклонённой задачи, иначе следующая
  // операция не выполнится вовсе.
  queue = run.catch(() => undefined);
  return run;
}

function mutate(
  optimistic: (current: CartState) => CartState,
  request: () => Promise<CartState>,
): Promise<CartState> {
  // Оптимистичное состояние применяем СИНХРОННО, до постановки в очередь:
  // иначе счётчик на кнопке ждал бы завершения предыдущего запроса, и быстрые
  // нажатия выглядели бы как пропущенные.
  const before = state;
  publish(optimistic(before));
  pending += 1;

  return enqueue(async () => {
    busy = true;
    window.dispatchEvent(new Event(EVENT));
    try {
      publish(normalize(await request()));
      return state;
    } catch (e) {
      // Откатываем только если следом ничего не летит: у идущей следом мутации
      // свой ответ сервера, и он всё равно перезапишет состояние целиком.
      // Иначе откат стёр бы уже подтверждённый сервером результат.
      if (pending === 1) publish(before);
      throw e;
    } finally {
      pending -= 1;
      busy = pending > 0;
      window.dispatchEvent(new Event(EVENT));
    }
  });
}

/** Ответ сервера -> состояние. Защищаемся от неполного/старого ответа. */
function normalize(raw: Partial<CartState> | null | undefined): CartState {
  if (!raw || !Array.isArray(raw.items)) return EMPTY_CART;
  return { ...EMPTY_CART, ...raw, items: raw.items as CartItemRow[] };
}

/** Загрузка корзины с сервера. Вызывается при входе и при открытии корзины. */
export async function hydrateCart(): Promise<void> {
  try {
    const fresh = await api<CartState>("/cart");
    publish(normalize(fresh));
  } catch {
    /* сервер недоступен — остаёмся на кэше, пользователь видит свой список */
  }
}

/** Позиция корзины для конкретного товара (или undefined). */
export function cartEntry(productId: number): CartItemRow | undefined {
  return state.items.find((i) => i.product_id === productId);
}

/** Добавить товар. Повторное добавление увеличивает количество.
 *
 *  Оптимистичная строка нужна, чтобы степпер на карточке появился в момент
 *  нажатия: ждать ответа сервера ради «+1» — это заметная задержка в ленте. */
export async function addToCart(
  card: {
    id: number; title: string; price: number; image?: string; sku?: string | null;
    brand?: string | null; category?: string | null; max_quantity?: number;
  },
  quantity = 1,
): Promise<CartState> {
  return mutate(
    (current) => {
      const max = card.max_quantity && card.max_quantity > 0 ? card.max_quantity : 20;
      const existing = current.items.find((i) => i.product_id === card.id);
      const items = existing
        ? current.items.map((i) =>
            i.product_id === card.id
              ? { ...i, quantity: clampQuantity(i.quantity + quantity, i.max_quantity || max) }
              : i,
          )
        : [
            ...current.items,
            {
              // Временный отрицательный id: настоящий придёт с сервера вместе с
              // полным состоянием. Отрицательный — чтобы он не мог случайно
              // совпасть с реальным и попасть в PATCH/DELETE.
              id: -card.id,
              product_id: card.id,
              sku: card.sku ?? null,
              title: card.title,
              brand: card.brand ?? null,
              category: card.category ?? null,
              image: card.image ?? "",
              price: card.price,
              added_price: card.price,
              price_changed: false,
              quantity: clampQuantity(quantity, max),
              line_total: card.price * quantity,
              availability_mode: "in_stock" as const,
              availability_label: "В наличии",
              availability_note: "",
              orderable: true,
              max_quantity: max,
            },
          ];
      return withTotals(current, items);
    },
    () => api<CartState>("/cart/items", {
      method: "POST",
      body: JSON.stringify({ product_id: card.id, quantity }),
    }),
  );
}

/** Изменить количество позиции. 0 — удалить. */
export async function setItemQuantity(itemId: number, quantity: number): Promise<CartState> {
  if (itemId < 0) return state; // позиция ещё не подтверждена сервером
  return mutate(
    (current) =>
      withTotals(
        current,
        quantity <= 0
          ? current.items.filter((i) => i.id !== itemId)
          : current.items.map((i) =>
              i.id === itemId ? { ...i, quantity: clampQuantity(quantity, i.max_quantity) } : i,
            ),
      ),
    () => api<CartState>(`/cart/items/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify({ quantity: Math.max(0, quantity) }),
    }),
  );
}

export async function removeCartItem(itemId: number): Promise<CartState> {
  if (itemId < 0) return state;
  return mutate(
    (current) => withTotals(current, current.items.filter((i) => i.id !== itemId)),
    () => api<CartState>(`/cart/items/${itemId}`, { method: "DELETE" }),
  );
}

export async function clearCart(): Promise<CartState> {
  return mutate(
    (current) => withTotals(current, []),
    () => api<CartState>("/cart", { method: "DELETE" }),
  );
}

export type CheckoutInput = {
  name: string;
  phone: string;
  fulfillment_type: "pickup" | "delivery" | "consult";
  comment: string;
  consent: boolean;
  idempotency_key: string;
};

export type CheckoutResult = {
  lead: { id: number; public_number: string; items_count: number; estimated_total: number | null };
  created: boolean;
  cart: CartState;
};

/** Отправить корзину одной заявкой.
 *
 *  Корзину очищает ОТВЕТ сервера, а не сам факт нажатия: при ошибке состояние
 *  остаётся прежним и пользователь возвращается к своему списку. */
export async function checkoutCart(input: CheckoutInput): Promise<CheckoutResult> {
  const result = await enqueue(() =>
    api<CheckoutResult>("/cart/checkout", { method: "POST", body: JSON.stringify(input) }),
  );
  publish(normalize(result.cart));
  return result;
}

/** Реактивное состояние корзины для компонентов. */
export function useCart(): CartState {
  const [value, setValue] = useState<CartState>(state);
  useEffect(() => {
    const handler = () => setValue(state);
    handler();
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);
  return value;
}

/** Позиция конкретного товара + флаг «идёт запрос» — для карточки и деталки. */
export function useCartEntry(productId: number): { item?: CartItemRow; busy: boolean } {
  const [value, setValue] = useState(() => ({ item: cartEntry(productId), busy }));
  useEffect(() => {
    const handler = () => setValue({ item: cartEntry(productId), busy });
    handler();
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, [productId]);
  return value;
}
