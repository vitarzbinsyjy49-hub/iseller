/** Продуктовая аналитика: отправка UI-событий в основной backend.
 * Fire-and-forget: аналитика никогда не должна ломать интерфейс. */
import { useAuthStore } from "../store/auth";

export type AppEvent =
  // AI-воронка
  | "ai_chat_opened"
  | "ai_product_card_viewed"
  | "ai_product_card_clicked"
  | "ai_order_started_from_ai"
  // Демо-воронка
  | "app_opened"
  | "catalog_opened"
  | "product_viewed"
  | "lead_created"
  | "admin_opened"
  // UX-патч (Лавка-адаптация): поиск/сценарии/история/пустые состояния.
  // В payload передаём только метаданные (query_length, source) — не текст
  // запроса (политика v5.1.1: сырые запросы в аналитику не пишем).
  | "search_focused"
  | "search_query_submitted"
  | "search_result_clicked"
  | "search_ai_escalated"
  | "quick_scenario_clicked"
  | "ai_prefill_opened"
  | "history_opened"
  | "empty_state_action_clicked"
  // v5.4.0: встроенные сценарные заявки + карусель фото карточек.
  // Payload — только безопасные метаданные (scenario, source, product_id,
  // image_count, from_index/to_index). НЕ телефон/имя/модель/комментарий.
  | "scenario_sheet_opened"
  | "scenario_option_selected"
  | "scenario_lead_submitted"
  | "scenario_lead_success"
  | "scenario_lead_failed"
  | "product_gallery_swiped"
  | "product_gallery_dot_clicked"
  | "photo_coverage_opened"
  | "photo_coverage_exported"
  // v5.5.0: свайп-навигация между страницами. Payload — только маршруты и
  // направление жеста (from, direction, target), ничего пользовательского.
  | "page_swiped"
  // v5.9: тумблеры навигации. Payload — только выбранное положение (axis, mode)
  // и место переключения (source); текста запроса здесь нет и быть не должно.
  | "home_axis_switched"
  // search_mode_switched больше не шлётся: режима «Каталог / AI» нет, кнопка AI
  // сразу открывает экран и считается как search_ai_escalated. В ALLOWED_EVENTS
  // на бэкенде имя оставлено — уже открытые вкладки со старым бандлом не должны
  // получать 400.
  // Compact Home + Cart: воронка корзины. Payload — только безопасные
  // метаданные (product_id, quantity, items_count, source, код ошибки).
  // Телефон, имя и комментарий сюда не попадают ни при каких условиях.
  | "cart_add"
  | "cart_remove"
  | "cart_quantity_change"
  | "cart_open"
  | "checkout_start"
  | "checkout_submit"
  | "checkout_success"
  | "checkout_error"
  | "buy_now"
  | "continue_shopping"
  // Патч 1.1: распространение и возвращаемость. Payload — только product_id и
  // способ (target/from). Ни ссылки, ни текста сообщения здесь нет: чем именно
  // человек делится и кому — не наше дело.
  | "product_shared"
  | "home_screen_prompted"
  // Патч 1.2: интерес к тому, как устроен и куда движется AI-подбор.
  | "ai_roadmap_opened"
  // v5.8.0: лояльность. Payload пустой — сам факт интереса к программе.
  | "loyalty_opened"
  | "loyalty_roadmap_opened"
  // Переход в AI с карточки товара. Payload — только product_id.
  | "ai_product_context_opened";

export function track(event: AppEvent, payload: Record<string, unknown> = {}): void {
  const { accessToken } = useAuthStore.getState();
  if (!accessToken) return;
  fetch("/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ event, payload }),
    keepalive: true,
  }).catch(() => {
    /* аналитика не должна мешать пользователю */
  });
}

/** Поведенческие события для персональных рекомендаций (v5.2.6).
 *  favorite_add/remove и lead_created пишет сам backend (доверенная сторона),
 *  фронт шлёт только UI-сигналы. Fire-and-forget. */
export type ProductEventType =
  | "product_view"
  | "category_view"
  | "search"
  | "recommendation_click";

export function trackProduct(
  eventType: ProductEventType,
  data: { product_id?: number; category?: string; query?: string; source?: string } = {},
): void {
  const { accessToken } = useAuthStore.getState();
  if (!accessToken) return;
  fetch("/api/events/product", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ event_type: eventType, ...data }),
    keepalive: true,
  }).catch(() => {
    /* аналитика не должна мешать пользователю */
  });
}
