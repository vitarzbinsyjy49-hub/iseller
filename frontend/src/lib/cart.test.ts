/** Состояние корзины: оптимистичные обновления, откат, очередь, восстановление.
 *
 *  Тесты идут в node-окружении (как и вся остальная логика проекта), поэтому
 *  window/localStorage подменяются минимальными заглушками ДО импорта модуля —
 *  cart.ts читает кэш на этапе загрузки. jsdom для этого не нужен: React здесь
 *  не рендерится, проверяется чистое поведение стора.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- окружение браузера (минимально необходимое) ----
const bus = new EventTarget();
const storage = new Map<string, string>();

(globalThis as unknown as { window: unknown }).window = {
  addEventListener: (t: string, h: EventListener) => bus.addEventListener(t, h),
  removeEventListener: (t: string, h: EventListener) => bus.removeEventListener(t, h),
  dispatchEvent: (e: Event) => bus.dispatchEvent(e),
};
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => { storage.set(k, v); },
  removeItem: (k: string) => { storage.delete(k); },
};

// vi.mock поднимается выше объявлений модуля, поэтому мок нужно создавать
// через vi.hoisted — иначе фабрика обращается к переменной в TDZ и импорт
// модуля тихо не состоится.
const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("./api", () => ({
  api: (...args: unknown[]) => apiMock(...args),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) { super(message); this.status = status; }
  },
}));

const cart = await import("./cart");
const { EMPTY_CART } = await import("./cartMath");

/** Ответ сервера: одна позиция с заданным количеством. */
function serverCart(quantity: number, price = 1000, id = 7) {
  return {
    ...EMPTY_CART,
    cart_id: 1,
    items: [{
      id, product_id: 42, sku: "SKU", title: "iPhone", brand: "Apple", category: "смартфоны",
      image: "", price, added_price: price, price_changed: false,
      quantity, line_total: price * quantity, availability_mode: "in_stock" as const,
      availability_label: "В наличии", availability_note: "", orderable: true, max_quantity: 20,
    }],
    positions_count: 1,
    items_count: quantity,
    estimated_total: price * quantity,
  };
}

const card = { id: 42, title: "iPhone", price: 1000, image: "", sku: "SKU" };

/** Дать очереди мутаций провернуть один такт (запросы стартуют в микрозадаче). */
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  apiMock.mockReset();
  storage.clear();
  // Сбрасываем стор через «пустой» ответ сервера.
  apiMock.mockResolvedValueOnce(EMPTY_CART);
  await cart.hydrateCart();
});

describe("addToCart", () => {
  it("показывает позицию ДО ответа сервера и заменяет её серверным состоянием", async () => {
    let resolve!: (v: unknown) => void;
    apiMock.mockReturnValueOnce(new Promise((r) => { resolve = r; }));

    const promise = cart.addToCart(card);
    // Оптимистичная строка уже видна — иначе степпер на карточке появлялся бы
    // с задержкой сети на каждое нажатие.
    expect(cart.cartState().items_count).toBe(1);
    expect(cart.cartEntry(42)?.title).toBe("iPhone");

    resolve(serverCart(1));
    await promise;
    expect(cart.cartEntry(42)?.id).toBe(7);   // настоящий id пришёл с сервера
    expect(cart.cartState().estimated_total).toBe(1000);
  });

  it("повторное добавление увеличивает количество, а не создаёт вторую позицию", async () => {
    apiMock.mockResolvedValueOnce(serverCart(1));
    await cart.addToCart(card);
    apiMock.mockResolvedValueOnce(serverCart(2));
    await cart.addToCart(card);
    expect(cart.cartState().positions_count).toBe(1);
    expect(cart.cartState().items_count).toBe(2);
  });

  it("ошибка сервера откатывает оптимистичное состояние", async () => {
    apiMock.mockRejectedValueOnce(new Error("network"));
    await expect(cart.addToCart(card)).rejects.toThrow();
    // Показывать товар, которого на сервере нет, нельзя: пользователь дойдёт до
    // корзины и не найдёт его.
    expect(cart.cartState().items).toEqual([]);
    expect(cart.cartState().items_count).toBe(0);
  });
});

describe("очередь мутаций", () => {
  it("два быстрых нажатия уходят на сервер по порядку, а не параллельно", async () => {
    const calls: string[] = [];
    let releaseFirst!: () => void;
    apiMock.mockImplementationOnce(() => new Promise((r) => {
      calls.push("first-start");
      releaseFirst = () => r(serverCart(1));
    }));
    apiMock.mockImplementationOnce(() => {
      calls.push("second-start");
      return Promise.resolve(serverCart(2));
    });

    const a = cart.addToCart(card);
    const b = cart.addToCart(card);
    // Оптимистично оба нажатия видны сразу — счётчик не ждёт сеть.
    expect(cart.cartState().items_count).toBe(2);

    try {
      await tick();
      // Второй запрос ещё не стартовал: он ждёт завершения первого. Иначе
      // сервер получил бы две независимые записи по одной паре (корзина, товар)
      // и одно из изменений потерялось бы.
      expect(calls).toEqual(["first-start"]);
    } finally {
      // Освобождаем очередь в любом случае: висящий запрос заблокировал бы
      // все последующие тесты этого файла.
      releaseFirst();
      await Promise.all([a, b]);
    }
    expect(calls).toEqual(["first-start", "second-start"]);
    expect(cart.cartState().items_count).toBe(2);
  });

  it("упавшая операция не блокирует очередь навсегда", async () => {
    apiMock.mockRejectedValueOnce(new Error("boom"));
    await expect(cart.addToCart(card)).rejects.toThrow();
    apiMock.mockResolvedValueOnce(serverCart(1));
    await cart.addToCart(card);
    expect(cart.cartState().items_count).toBe(1);
  });
});

describe("изменение количества и удаление", () => {
  it("setItemQuantity отправляет PATCH и берёт состояние из ответа", async () => {
    apiMock.mockResolvedValueOnce(serverCart(1));
    await cart.addToCart(card);

    apiMock.mockResolvedValueOnce(serverCart(3));
    await cart.setItemQuantity(7, 3);
    expect(apiMock).toHaveBeenLastCalledWith("/cart/items/7", expect.objectContaining({ method: "PATCH" }));
    expect(cart.cartState().items_count).toBe(3);
  });

  it("позицию с временным id на сервер не отправляем", async () => {
    // Пока ответ не пришёл, у позиции временный отрицательный id — он не должен
    // уехать в PATCH/DELETE и удалить чужую строку.
    let release!: (v: unknown) => void;
    apiMock.mockReturnValueOnce(new Promise((r) => { release = r; }));
    const inFlight = cart.addToCart(card);
    expect(cart.cartEntry(42)?.id).toBeLessThan(0);

    try {
      await tick();          // POST уже ушёл, дальше считаем только новые вызовы
      apiMock.mockClear();
      await cart.setItemQuantity(-42, 5);
      expect(apiMock).not.toHaveBeenCalled();
    } finally {
      release(serverCart(1)); // не оставляем висящий запрос в очереди
      await inFlight;
    }
  });

  it("удаление убирает позицию", async () => {
    apiMock.mockResolvedValueOnce(serverCart(1));
    await cart.addToCart(card);
    apiMock.mockResolvedValueOnce(EMPTY_CART);
    await cart.removeCartItem(7);
    expect(cart.cartState().items).toEqual([]);
  });
});

describe("восстановление между сессиями", () => {
  it("состояние переживает перезагрузку интерфейса через localStorage", async () => {
    apiMock.mockResolvedValueOnce(serverCart(2));
    await cart.addToCart(card);
    const cached = JSON.parse(storage.get("techshop_cart") as string);
    expect(cached.items_count).toBe(2);
    expect(cached.items[0].product_id).toBe(42);
  });

  it("недоступный сервер оставляет кэш, а не обнуляет корзину", async () => {
    apiMock.mockResolvedValueOnce(serverCart(2));
    await cart.addToCart(card);
    apiMock.mockRejectedValueOnce(new Error("offline"));
    await cart.hydrateCart();
    expect(cart.cartState().items_count).toBe(2);
  });

  it("мусорный ответ сервера не ломает экран", async () => {
    apiMock.mockResolvedValueOnce({ nonsense: true });
    await cart.hydrateCart();
    expect(cart.cartState().items).toEqual([]);
  });
});

describe("checkout", () => {
  it("корзину очищает ответ сервера, а не сам факт нажатия", async () => {
    apiMock.mockResolvedValueOnce(serverCart(1));
    await cart.addToCart(card);

    apiMock.mockResolvedValueOnce({
      lead: { id: 5, public_number: "№5", items_count: 1, estimated_total: 1000 },
      created: true,
      cart: EMPTY_CART,
    });
    const result = await cart.checkoutCart({
      name: "Гарик", phone: "+79990000000", fulfillment_type: "pickup",
      comment: "", consent: true, idempotency_key: "key-1",
    });
    expect(result.lead.public_number).toBe("№5");
    expect(cart.cartState().items).toEqual([]);
  });

  it("ошибка отправки НЕ очищает корзину", async () => {
    apiMock.mockResolvedValueOnce(serverCart(1));
    await cart.addToCart(card);

    apiMock.mockRejectedValueOnce(new Error("timeout"));
    await expect(cart.checkoutCart({
      name: "", phone: "+79990000000", fulfillment_type: "pickup",
      comment: "", consent: true, idempotency_key: "key-2",
    })).rejects.toThrow();
    expect(cart.cartState().items_count).toBe(1);
  });
});
