/** Публичная конфигурация витрины (GET /api/config/public).
 *
 * Контакты менеджеров НЕ хардкодятся во фронтенде: они задаются в .env
 * backend'а и меняются без пересборки. Модуль кэширует ответ на время
 * сессии и переживает недоступность endpoint'а (все ссылки пустые ->
 * кнопки уходят в fallback-поведение).
 */
import { useEffect, useState } from "react";
import { api } from "./api";

export type PublicConfig = {
  app_name: string;
  manager_retail_url: string;
  manager_wholesale_url: string;
  manager_b2b_url: string;
  manager_tradein_url: string;
  telegram_channel_url: string;
  mini_app_url: string;
  /** Телефон магазина в формате +79991234567 — для ссылки tel: в «Контактах». */
  shop_phone: string;
  /** @username бота без «@» — нужен для deep link'ов «поделиться товаром». */
  bot_username: string;
  /** Кто РЕАЛЬНО отвечает в AI-подборе: "claude" или пусто. Считает backend по
   *  AI_PROVIDER — витрина не имеет права утверждать это от себя. */
  ai_vendor: string;
  /** Название модели для подписи, если vendor известен. */
  ai_model: string;
  /** Курс USD ЦБ РФ на сегодня + дельта к предыдущему дню. null — данных ещё
   *  нет (холодный старт до первого успешного sync у бота) — не рисуем чип. */
  usd_rate: { value: number; delta: number } | null;
};

const EMPTY: PublicConfig = {
  app_name: "AI Seller",
  manager_retail_url: "", manager_wholesale_url: "",
  manager_b2b_url: "", manager_tradein_url: "",
  telegram_channel_url: "", mini_app_url: "", bot_username: "", shop_phone: "",
  // Пустой vendor => бейджа «Powered by Claude» нет. Именно такой должна быть
  // реакция на недоступный конфиг: молчание, а не утверждение по умолчанию.
  ai_vendor: "", ai_model: "",
  usd_rate: null,
};

let cached: PublicConfig | null = null;
let inflight: Promise<PublicConfig> | null = null;

export function fetchPublicConfig(): Promise<PublicConfig> {
  if (cached) return Promise.resolve(cached);
  inflight ??= api<PublicConfig>("/config/public")
    .then((c) => (cached = { ...EMPTY, ...c }))
    .catch(() => (cached = EMPTY))
    .finally(() => { inflight = null; });
  return inflight.then(() => cached ?? EMPTY);
}

export function usePublicConfig(): PublicConfig {
  const [config, setConfig] = useState<PublicConfig>(cached ?? EMPTY);
  useEffect(() => { fetchPublicConfig().then(setConfig); }, []);
  return config;
}
