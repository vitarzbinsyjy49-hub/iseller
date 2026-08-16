/** Логика визарда «Предложить товар» — чистые функции, без DOM. Шаги: категория
 *  → название → состояние → цена → фото → телефон → комментарий → превью.
 *  Стейт-машина здесь примитивная (линейный список шагов, не граф синонимов, как
 *  у scenarioChat) — визард без AI-эскалации, каждое поле принимается как есть.
 */
export type SellItemValues = {
  category: string;
  title: string;
  state: string;
  price: string;
  comment: string;
};

export const SELL_ITEM_STEPS = ["category", "title", "state", "price", "photos", "phone", "comment", "preview"] as const;
export type SellItemStep = (typeof SELL_ITEM_STEPS)[number];

export type SellItemLeadBody = {
  source: string;
  lead_type: "sell_item";
  phone: string | null;
  message: string | null;
  metadata: {
    category: string;
    title: string;
    state: string;
    price_wanted: number;
    photos: string[];
  };
};

/** Собрать тело POST /leads. Комментарий — единственное free-text поле,
 *  уходит в message (как textarea у обычных сценариев), остальное — metadata. */
export function buildSellItemLead(
  values: SellItemValues, photos: string[], phone: string,
): SellItemLeadBody {
  return {
    source: "home",
    lead_type: "sell_item",
    phone: phone.trim() || null,
    message: values.comment.trim() || null,
    metadata: {
      category: values.category,
      title: values.title.trim(),
      state: values.state,
      price_wanted: Number(values.price),
      photos,
    },
  };
}

/** Проверка перед отправкой. Возвращает текст ошибки или null. */
export function validateSellItem(
  values: SellItemValues, photos: string[], phone: string,
): string | null {
  if (!values.category.trim()) return "Выберите категорию";
  if (!values.title.trim()) return "Укажите, что за товар";
  const price = Number(values.price);
  if (!values.price.trim() || !Number.isFinite(price) || price <= 0) {
    return "Укажите цену больше нуля";
  }
  if (!phone.trim()) return "Оставьте телефон — иначе не сможем связаться";
  if (photos.length === 0) return "Добавьте хотя бы одно фото";
  return null;
}
