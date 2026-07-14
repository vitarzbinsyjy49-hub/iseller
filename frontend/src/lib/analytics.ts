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
  | "admin_opened";

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
