/** Человекочитаемое представление сценарных заявок (v5.4.0).
 *
 *  Чистые функции (тестируются в node-окружении): подписи типов, заголовок
 *  сценария и локализованные строки metadata. Ни admin, ни витрина НЕ показывают
 *  сырой JSON. Неизвестные ключи выводятся нейтрально, пустые — скрываются.
 */

import { formatPrice } from "./format";

export type LeadLike = {
  lead_type?: string | null;
  metadata?: Record<string, unknown> | null;
  product_title?: string | null;
};

export const LEAD_TYPE_LABEL: Record<string, string> = {
  general: "Обычная",
  product: "Товар",
  trade_in: "Trade-In",
  b2b: "Для бизнеса",
  wholesale: "Опт",
  cart: "Корзина",
  price_offer: "Нашли дешевле",
};

export function leadTypeLabel(t?: string | null): string {
  return LEAD_TYPE_LABEL[(t || "general")] ?? "Обычная";
}

// Локализованные значения перечислимых полей metadata.
const VALUE_LABELS: Record<string, Record<string, string>> = {
  device_type: { iphone: "iPhone", macbook: "MacBook", ipad: "iPad", apple_watch: "Apple Watch", other: "Другое" },
  condition: { excellent: "Отличное", normal: "Нормальное", damaged: "Есть повреждения", dead: "Не включается" },
  intent: { exchange: "Обмен на другое", sell: "Продажа" },
  equipment: {
    smartphones: "Смартфоны", laptops: "Ноутбуки", tablets: "Планшеты",
    staff_devices: "Техника для сотрудников", complex: "Комплексная поставка", other: "Другое",
  },
  category: {
    iphone: "iPhone", macbook: "MacBook", other_tech: "Другая техника",
    accessories: "Аксессуары", mixed: "Смешанная партия",
  },
};

// Подписи ключей metadata. origin — служебный, не показываем.
const KEY_LABELS: Record<string, string> = {
  device_type: "Устройство",
  model: "Модель",
  memory: "Память",
  condition: "Состояние",
  intent: "Цель",
  desired_device: "Хочет получить",
  equipment: "Оборудование",
  quantity_range: "Количество",
  company: "Компания",
  city: "Город",
  category: "Категория",
  budget: "Бюджет",
  competitor_url: "Ссылка у конкурента",
  competitor_shop: "Площадка",
  competitor_price: "Цена там",
  comment: "Комментарий",
  // Заявка из корзины со скидкой (services/cart.checkout) — снапшот на момент
  // оформления, настройки промокода к моменту разговора могут уже смениться.
  promo_code: "Промокод",
  promo_discount: "Скидка по промокоду",
  subtotal: "Сумма без скидки",
};

// promo_discount/subtotal — суммы в рублях, а не произвольный текст: без
// этого в заявке было бы голое число "500" вместо "500 ₽".
const MONEY_KEYS = new Set(["promo_discount", "subtotal"]);

const HIDDEN_KEYS = new Set(["origin"]);

/** Строки metadata для показа: [{label, value}], локализованные, без origin и
 *  пустых. Порядок ключей KEY_LABELS сначала, затем неизвестные (нейтрально). */
export function leadMetadataRows(metadata?: Record<string, unknown> | null): { label: string; value: string }[] {
  if (!metadata || typeof metadata !== "object") return [];
  const rows: { label: string; value: string }[] = [];
  const seen = new Set<string>();

  const push = (key: string) => {
    if (HIDDEN_KEYS.has(key) || seen.has(key)) return;
    const raw = (metadata as Record<string, unknown>)[key];
    if (raw == null) return;
    const value = Array.isArray(raw) ? raw.map(String).join(", ") : String(raw);
    if (!value.trim()) return;
    seen.add(key);
    const label = KEY_LABELS[key] ?? key;
    const localized = MONEY_KEYS.has(key) ? formatPrice(Number(raw)) : (VALUE_LABELS[key]?.[value] ?? value);
    rows.push({ label, value: localized });
  };

  for (const key of Object.keys(KEY_LABELS)) if (key in metadata) push(key);
  for (const key of Object.keys(metadata)) push(key);   // неизвестные ключи — нейтрально
  return rows;
}

/** Короткий заголовок сценария: «Trade-In · iPhone 15 Pro», «Оптовая заявка ·
 *  iPhone», «Поставка для бизнеса», иначе product_title/«Консультация». */
export function leadTitle(lead: LeadLike): string {
  const meta = (lead.metadata ?? {}) as Record<string, unknown>;
  const val = (k: string) => (meta[k] == null ? "" : String(meta[k]));
  const labeled = (k: string) => VALUE_LABELS[k]?.[val(k)] ?? val(k);
  switch (lead.lead_type) {
    case "trade_in": {
      const what = val("model") || labeled("device_type");
      return what ? `Trade-In · ${what}` : "Trade-In";
    }
    case "b2b": {
      const what = labeled("equipment");
      return what ? `Поставка для бизнеса · ${what}` : "Поставка для бизнеса";
    }
    case "wholesale": {
      const what = labeled("category");
      return what ? `Оптовая заявка · ${what}` : "Оптовая заявка";
    }
    case "price_offer": {
      // Площадка в заголовке — то, по чему менеджер сортирует такие заявки
      // глазами: «опять Ozon» читается быстрее, чем название товара.
      const where = val("competitor_shop");
      const what = lead.product_title || "товар";
      return where ? `Нашли дешевле · ${where} · ${what}` : `Нашли дешевле · ${what}`;
    }
    default:
      return lead.product_title || "Консультация";
  }
}
