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
  tags?: string[];
  why: string[];
  buttons: CardButton[];
};

export type ProductDetail = ProductCard & {
  description: string;
  specs: Record<string, string>;
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

export type AiAction = {
  type: "compare" | "refine" | "manager";
  label: string;
  product_ids?: number[];
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
