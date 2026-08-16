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

/** Виртуальная категория «Скидки» из GET /catalog/categories
 *  (backend/app/services/catalog_nav.py::SALE_KEY). Это разрез витрины, а не
 *  раздел каталога. */
export const SALE_CATEGORY_KEY = "__sale__";

/** Категории, которые можно предложить к продаже.
 *
 *  «Скидки» из выдачи убираем: продать скидку нельзя, а выбранный ключ уходит
 *  в metadata.category и дальше — в Product.category при публикации, то есть
 *  товар оказался бы в категории `__sale__`, которой не существует. */
export function sellableCategories<T extends { key: string }>(categories: T[] | null | undefined): T[] {
  return (categories ?? []).filter((c) => c.key !== SALE_CATEGORY_KEY);
}

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
