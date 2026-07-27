/** Типы ответа AI-моста и карточек товаров (Demo MVP). */

export type CardButtonType =
  | "open_product" | "reserve" | "lead" | "manager" | "notify_stock" | "add_to_cart";

export type CardButton = {
  type: CardButtonType;
  label: string;
  product_id: number;
};

export type ProductCard = {
  id: number;
  sku?: string | null;
  title: string;
  brand: string | null;
  category?: string | null;
  price: number;
  old_price: number | null;
  discount_percent?: number | null;
  in_stock: boolean;
  stock?: number;
  rating: number | null;
  image: string;
  images?: string[];
  url: string;
  is_hot?: boolean;
  is_available_today?: boolean;
  /** Товар помечен в админке как лимитированный: только у таких витрина
   *  показывает «Осталось N шт». У обычных позиций малый складской остаток —
   *  не повод изображать дефицит. */
  is_limited?: boolean;
  tags?: string[];
  why: string[];
  buttons: CardButton[];
};

/** Одна характеристика товара: человекочитаемая подпись + значение. */
export type Specification = { label: string; value: string };

export type ProductDetail = ProductCard & {
  description: string;
  specs: Record<string, string>;
  specifications?: Specification[];   // нормализованный упорядоченный список (backend)
  warranty_months: number;
  condition?: "new" | "used" | "refurbished";
  color?: string | null;
  memory?: string | null;
  storage?: string | null;
  screen_size?: string | null;
  cpu?: string | null;
  ram?: string | null;
  subcategory?: string | null;
  stock: number;
  on_sale: boolean;
  is_new: boolean;
};

export type ManagerRole = "retail" | "wholesale" | "b2b" | "trade_in";

export type AiAction = {
  type: "compare" | "refine" | "manager" | "lead";
  label: string;
  product_ids?: number[];
  product_id?: number;        // для type="lead": проверенный backend'ом товар
  manager_role?: ManagerRole; // для type="manager": какого менеджера открыть
};

export type AiAnswer = {
  text: string;
  cards: ProductCard[];
  actions: AiAction[];
  meta: {
    source?: "ai" | "fallback" | "mock" | "cache";
    intent?: string;
    latency_ms?: number;
    analytics_id?: number | null;
    cache_hit?: boolean;
    model?: string;
  };
};
