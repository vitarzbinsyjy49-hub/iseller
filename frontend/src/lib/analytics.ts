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
  | "page_swiped";

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
