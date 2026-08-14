/** Общие стили (светлая тема Telegram × Яндекс) и API-хелперы админки. */
import type { CSSProperties } from "react";

export const C = {
  bg: "#f6f7f9", surface: "#ffffff", muted: "#f1f3f5", border: "#e8eaee",
  text: "#111827", sub: "#6b7280", accent: "#2aabee", accentDark: "#229ed9",
  green: "#35c759", yellow: "#ff9f0a", red: "#ff3b30",
};

export const card: CSSProperties = {
  background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 20,
  boxShadow: "0 1px 3px rgba(17,24,39,.04)",
};

export const input: CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 10,
  border: `1px solid ${C.border}`, background: C.muted, color: C.text, marginTop: 6, outline: "none",
};

export const btn: CSSProperties = {
  padding: "10px 14px", borderRadius: 10, border: "none",
  background: C.accent, color: "#fff", fontWeight: 600, cursor: "pointer",
};

export const btnGhost: CSSProperties = {
  ...btn, background: C.muted, color: C.text,
};

export const chip = (active: boolean): CSSProperties => ({
  padding: "7px 14px", borderRadius: 999, cursor: "pointer", fontSize: 13, fontWeight: 500,
  border: `1px solid ${active ? C.accent : C.border}`,
  background: active ? C.accent : C.surface, color: active ? "#fff" : C.sub,
});

const ACCESS_KEY = "admin_access_token";
const REFRESH_KEY = "admin_refresh_token";

export function storeTokens(accessToken: string, refreshToken: string) {
  sessionStorage.setItem(ACCESS_KEY, accessToken);
  sessionStorage.setItem(REFRESH_KEY, refreshToken);
}
export function clearTokens() {
  sessionStorage.removeItem(ACCESS_KEY);
  sessionStorage.removeItem(REFRESH_KEY);
}
export function loadStoredAccessToken(): string | null {
  return sessionStorage.getItem(ACCESS_KEY);
}

type TokenListener = (accessToken: string) => void;
let tokenListener: TokenListener | null = null;
/** Shell вызывает это при монтировании, чтобы синхронизировать своё состояние
 *  token с токеном, который тихо обновился внутри apiSend/apiGet другого экрана. */
export function onTokenRefreshed(listener: TokenListener | null) {
  tokenListener = listener;
}

let refreshInFlight: Promise<string | null> | null = null;
/** Обменять refresh-токен на новую пару. Один запрос на все параллельные 401 —
 *  backend/app/api/auth.py::refresh одноразовый, повтор тем же refresh-токеном
 *  отклоняется как кража/повтор. */
function refreshAccessToken(): Promise<string | null> {
  const refreshToken = sessionStorage.getItem(REFRESH_KEY);
  if (!refreshToken) return Promise.resolve(null);
  if (!refreshInFlight) {
    refreshInFlight = fetch("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
      .then(async (r) => {
        if (!r.ok) { clearTokens(); return null; }
        const data = await r.json();
        storeTokens(data.access_token, data.refresh_token);
        tokenListener?.(data.access_token);
        return data.access_token as string;
      })
      .catch(() => null)
      .finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

export async function apiGet<T>(path: string, token: string): Promise<T> {
  let r = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 401) {
    const fresh = await refreshAccessToken();
    if (fresh) r = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${fresh}` } });
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function apiSend<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
  const doFetch = (tok: string) => fetch(`/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let r = await doFetch(token);
  if (r.status === 401) {
    const fresh = await refreshAccessToken();
    if (fresh) r = await doFetch(fresh);
  }
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.detail || `HTTP ${r.status}`);
  }
  return r.json();
}

export const apiPatch = <T,>(path: string, token: string, body: unknown) => apiSend<T>("PATCH", path, token, body);
export const apiPost = <T,>(path: string, token: string, body: unknown) => apiSend<T>("POST", path, token, body);

/** Загрузка файла (multipart). Content-Type НЕ ставим — браузер сам выставит boundary. */
export async function apiUpload<T>(path: string, token: string, file: File): Promise<T> {
  const fd = new FormData();
  fd.append("file", file);
  const doFetch = (tok: string) => fetch(`/api${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}` },
    body: fd,
  });
  let r = await doFetch(token);
  if (r.status === 401) {
    const fresh = await refreshAccessToken();
    if (fresh) r = await doFetch(fresh);
  }
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.detail || `HTTP ${r.status}`);
  }
  return r.json();
}

/** Мультизагрузка файлов (v5.4.0): поле "files" повторяется. Возвращает товар +
 *  _upload (added/rejected/count/limit) для отчёта о частичном результате. */
export async function apiUploadMany<T>(path: string, token: string, files: File[]): Promise<T> {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  const doFetch = (tok: string) => fetch(`/api${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}` },
    body: fd,
  });
  let r = await doFetch(token);
  if (r.status === 401) {
    const fresh = await refreshAccessToken();
    if (fresh) r = await doFetch(fresh);
  }
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.detail || `HTTP ${r.status}`);
  }
  return r.json();
}

export const MAX_PRODUCT_IMAGES = 10;

export function fmtPrice(v: number | null | undefined): string {
  if (v == null) return "—";
  return new Intl.NumberFormat("ru-RU").format(Math.round(v)) + " ₽";
}

// Статусы расширены под воронку подтверждения корзины. Старые пять остались:
// у существующих заявок они и стоят, менять их задним числом нельзя.
export const STATUS_RU: Record<string, string> = {
  new: "Новая", contacted: "Связались", confirming: "Уточняем", confirmed: "Подтверждена",
  in_progress: "В работе", reserved: "Бронь", completed: "Завершена", cancelled: "Отменена",
};
export const STATUSES = [
  "new", "contacted", "confirming", "confirmed",
  "in_progress", "reserved", "completed", "cancelled",
];
export const SOURCE_RU: Record<string, string> = {
  ai: "AI", product: "Товар", catalog: "Каталог", home: "Главная", manager: "Менеджер",
  telegram_mini_app_cart: "Корзина", other: "Другое",
};

// v5.4.0: сценарные типы заявок; cart — общая заявка по корзине
// price_offer — «нашли дешевле»: ссылка на тот же товар у конкурента.
export const LEAD_TYPES = ["general", "product", "trade_in", "b2b", "wholesale", "cart", "price_offer"];
export const LEAD_TYPE_RU: Record<string, string> = {
  general: "Обычная", product: "Товар", trade_in: "Trade-In", b2b: "Для бизнеса",
  wholesale: "Опт", cart: "Корзина", price_offer: "Нашли дешевле",
};

export const FULFILLMENT_RU: Record<string, string> = {
  pickup: "Самовывоз", delivery: "Доставка", consult: "Уточнить с менеджером",
};

export const AVAILABILITY_RU: Record<string, string> = {
  in_stock: "В наличии", limited: "Ограниченная партия", preorder: "Предзаказ",
  on_request: "Под заказ", out_of_stock: "Нет в наличии", unavailable: "Недоступен",
};

/** Дата/время заявки одной строкой. Отдельная функция, потому что формат
 *  повторяется в таблице, в деталях и в истории статусов. */
export function fmtDateTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("ru-RU");
}

/** Ссылка на витрину из админки (открыть товар заявки).
 *
 *  Админка живёт на отдельном хосте (`admin.<домен>`) и в dev — на соседнем
 *  порту. Прямой ссылки на витрину в конфиге нет, поэтому выводим её из
 *  текущего адреса. Не угадали — открывать нечего, поэтому вызывающий код
 *  обязан пережить null, а не показывать битую кнопку. */
export function storefrontUrl(path: string): string | null {
  try {
    const { protocol, hostname, port } = window.location;
    if (hostname.startsWith("admin.")) {
      return `${protocol}//${hostname.slice("admin.".length)}${path}`;
    }
    if (port === "5174") return `${protocol}//${hostname}:5173${path}`;
    return null;
  } catch {
    return null;
  }
}

const META_VALUE_RU: Record<string, Record<string, string>> = {
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
const META_KEY_RU: Record<string, string> = {
  device_type: "Устройство", model: "Модель", memory: "Память", condition: "Состояние",
  intent: "Цель", desired_device: "Хочет получить", equipment: "Оборудование",
  quantity_range: "Количество", company: "Компания", city: "Город",
  category: "Категория", budget: "Бюджет",
  // «Нашли дешевле». Порядок ключей здесь — это порядок строк на экране:
  // сначала площадка и цена (по ним решают), потом сам адрес и комментарий.
  competitor_shop: "Площадка", competitor_price: "Цена там",
  competitor_url: "Ссылка у конкурента", comment: "Комментарий",
  // Заявка из корзины со скидкой (services/cart.checkout) — снапшот на момент
  // оформления, настройки промокода к моменту разговора могут уже смениться.
  promo_code: "Промокод", promo_discount: "Скидка по промокоду",
  subtotal: "Сумма без скидки",
};
// promo_discount/subtotal — суммы в рублях, а не произвольный текст: без
// этого в заявке было бы голое число "500" вместо "500 ₽".
const META_MONEY_KEYS = new Set(["promo_discount", "subtotal"]);
const META_HIDDEN = new Set(["origin"]);

/** Локализованные строки metadata заявки (без origin/пустых). Неизвестные ключи
 *  показываем нейтрально — как есть. Никакого сырого JSON в UI. */
export function leadMetaRows(metadata?: Record<string, unknown> | null): { label: string; value: string }[] {
  if (!metadata || typeof metadata !== "object") return [];
  const rows: { label: string; value: string }[] = [];
  const seen = new Set<string>();
  const push = (key: string) => {
    if (META_HIDDEN.has(key) || seen.has(key)) return;
    const raw = (metadata as Record<string, unknown>)[key];
    if (raw == null) return;
    const value = Array.isArray(raw) ? raw.map(String).join(", ") : String(raw);
    if (!value.trim()) return;
    seen.add(key);
    const shown = META_MONEY_KEYS.has(key) ? fmtPrice(Number(raw)) : (META_VALUE_RU[key]?.[value] ?? value);
    rows.push({ label: META_KEY_RU[key] ?? key, value: shown });
  };
  for (const key of Object.keys(META_KEY_RU)) if (key in metadata) push(key);
  for (const key of Object.keys(metadata)) push(key);
  return rows;
}
