/** Конфигурация и чистая логика встроенных сценарных заявок (v5.4.0).
 *
 *  Вынесено из компонента, чтобы поведение (какой lead_type/metadata/source
 *  уходит на backend, что считается обязательным) тестировалось как чистые
 *  функции — в духе остального фронтенда (vitest, node-окружение, без DOM).
 */

export type ScenarioKey = "trade_in" | "b2b" | "wholesale";

export type OptionItem = { value: string; label: string; synonyms?: string[] };
export type Field =
  | { kind: "chips"; key: string; label: string; required?: boolean; options: OptionItem[] }
  | { kind: "text"; key: string; label: string; required?: boolean; placeholder?: string; target: "metadata" }
  | { kind: "textarea"; key: string; label: string; placeholder?: string };

export type ScenarioConfig = {
  leadType: ScenarioKey;
  title: string;
  subtitle: string;
  cta: string;
  managerRole: "trade_in" | "b2b" | "wholesale";
  fields: Field[];
  /** Вступительная реплика AI-чата (scenario_chat.ts) — статика, без модели. */
  intro: string;
  /** Реплика перед кнопкой отправки заявки — статика, без модели. */
  closingHook: string;
};

/** prefill-пункт меню (MacBook). soft — мягкий пошаговый подбор. */
export type ChoiceItem = { key: string; label: string; prefill: string; soft?: boolean };

/** Значение по каналу происхождения заявки в metadata. */
export const SCENARIO_ORIGIN = "home_quick_scenario";

export const SCENARIOS: Record<ScenarioKey, ScenarioConfig> = {
  trade_in: {
    leadType: "trade_in",
    title: "Trade-In — оценка устройства",
    subtitle: "Пара шагов, и менеджер пришлёт оценку",
    cta: "Получить оценку",
    managerRole: "trade_in",
    intro: "Оценим вашу технику и предложим обмен на новое устройство или выкуп. "
      + "Самовывоз в Москве ежедневно 10:00–21:00 — можно приехать в день обращения, "
      + "оценка и расчёт при проверке устройства.",
    closingHook: "Проверьте данные ниже и отправьте заявку — её рассмотрит trade-in "
      + "менеджер, обычно в течение дня.",
    fields: [
      { kind: "chips", key: "device_type", label: "Тип устройства", required: true, options: [
        { value: "iphone", label: "iPhone", synonyms: ["айфон", "apple phone"] },
        { value: "macbook", label: "MacBook", synonyms: ["макбук", "ноутбук apple"] },
        { value: "ipad", label: "iPad", synonyms: ["айпад", "планшет apple"] },
        { value: "apple_watch", label: "Apple Watch", synonyms: ["часы", "эпл вотч", "эппл вотч"] },
        { value: "other", label: "Другое", synonyms: ["другое", "иное"] }] },
      { kind: "text", key: "model", label: "Модель", required: true, placeholder: "Напр. iPhone 15 Pro", target: "metadata" },
      { kind: "text", key: "memory", label: "Память (необязательно)", placeholder: "256 ГБ", target: "metadata" },
      { kind: "chips", key: "condition", label: "Состояние", required: true, options: [
        { value: "excellent", label: "Отличное", synonyms: ["идеальное", "как новый", "без царапин"] },
        { value: "normal", label: "Нормальное", synonyms: ["б/у", "бу", "обычное", "потёртости"] },
        { value: "damaged", label: "Есть повреждения", synonyms: ["треснул", "разбит", "скол", "трещина", "поцарапан"] },
        { value: "dead", label: "Не включается", synonyms: ["не работает", "дохлый", "кирпич"] }] },
      { kind: "chips", key: "intent", label: "Что хотите сделать", required: true, options: [
        { value: "exchange", label: "Обменять на другое", synonyms: ["обменять", "обмен", "поменять"] },
        { value: "sell", label: "Продать", synonyms: ["продажа", "выкуп", "выкупите"] }] },
      { kind: "text", key: "desired_device", label: "Что хотите получить (необязательно)", placeholder: "Напр. iPhone 16 Pro", target: "metadata" },
      { kind: "textarea", key: "message", label: "Комментарий (необязательно)", placeholder: "Комплектация, состояние…" },
    ],
  },
  b2b: {
    leadType: "b2b",
    title: "Для бизнеса — подберём поставку",
    subtitle: "Оставьте вводные, пришлём предложение",
    cta: "Получить предложение",
    managerRole: "b2b",
    intro: "Подберём поставку под вашу компанию: смартфоны, ноутбуки, техника для "
      + "сотрудников. Документы для юрлиц, оплата по счёту — детали обсудит менеджер.",
    closingHook: "Проверьте данные ниже и отправьте заявку — B2B-менеджер пришлёт "
      + "предложение под ваш объём.",
    fields: [
      { kind: "chips", key: "equipment", label: "Что требуется", required: true, options: [
        { value: "smartphones", label: "Смартфоны", synonyms: ["телефоны"] },
        { value: "laptops", label: "Ноутбуки", synonyms: ["ноутбук", "макбуки", "ноуты"] },
        { value: "tablets", label: "Планшеты", synonyms: ["планшет", "айпады"] },
        { value: "staff_devices", label: "Техника для сотрудников", synonyms: ["сотрудники", "персонал", "команда"] },
        { value: "complex", label: "Комплексная поставка", synonyms: ["всё сразу", "полная поставка"] },
        { value: "other", label: "Другое", synonyms: ["другое", "иное"] }] },
      { kind: "chips", key: "quantity_range", label: "Примерное количество", required: true, options: [
        { value: "1-5", label: "1–5" }, { value: "5-20", label: "5–20" },
        { value: "20-50", label: "20–50" }, { value: "50+", label: "50+" }] },
      { kind: "text", key: "company", label: "Компания (необязательно)", placeholder: "ООО «Пример»", target: "metadata" },
      { kind: "text", key: "city", label: "Город", required: true, placeholder: "Москва", target: "metadata" },
      { kind: "textarea", key: "message", label: "Комментарий (необязательно)", placeholder: "Сроки, требования, документы…" },
    ],
  },
  wholesale: {
    leadType: "wholesale",
    title: "Опт — запрос цены на партию",
    subtitle: "Укажите категорию и объём партии",
    cta: "Запросить оптовую цену",
    managerRole: "wholesale",
    intro: "Назовите категорию и объём партии — посчитаем оптовую цену.",
    closingHook: "Проверьте данные ниже и отправьте заявку — оптовый менеджер пришлёт "
      + "цену под партию.",
    fields: [
      { kind: "chips", key: "category", label: "Категория", required: true, options: [
        { value: "iphone", label: "iPhone", synonyms: ["айфон", "айфоны"] },
        { value: "macbook", label: "MacBook", synonyms: ["макбук", "макбуки"] },
        { value: "other_tech", label: "Другая техника", synonyms: ["прочая техника"] },
        { value: "accessories", label: "Аксессуары", synonyms: ["чехлы", "кабели"] },
        { value: "mixed", label: "Смешанная партия", synonyms: ["микс", "разное"] }] },
      { kind: "chips", key: "quantity_range", label: "Партия", required: true, options: [
        { value: "5-10", label: "5–10" }, { value: "10-30", label: "10–30" },
        { value: "30-100", label: "30–100" }, { value: "100+", label: "100+" }] },
      { kind: "text", key: "city", label: "Город", required: true, placeholder: "Казань", target: "metadata" },
      { kind: "text", key: "budget", label: "Ориентировочный бюджет (необязательно)", placeholder: "3 000 000 ₽", target: "metadata" },
      { kind: "textarea", key: "message", label: "Комментарий (необязательно)", placeholder: "Что важно по партии…" },
    ],
  },
};

/** Меню «Подобрать MacBook»: prefill для AI без авто-отправки; 5-й пункт soft. */
export const MACBOOK_CHOICES: ChoiceItem[] = [
  { key: "work", label: "Для работы и учёбы", prefill: "Подбери MacBook для работы и учёбы" },
  { key: "creative", label: "Для монтажа и дизайна", prefill: "Подбери MacBook для монтажа видео и дизайна" },
  { key: "dev", label: "Для программирования", prefill: "Подбери MacBook для программирования" },
  { key: "value", label: "Самый выгодный вариант", prefill: "Покажи самый выгодный MacBook, который есть в наличии" },
  { key: "unsure", label: "Пока не знаю — помочь выбрать", soft: true,
    prefill: "Помоги выбрать MacBook: задай мне пару уточняющих вопросов и предложи вариант из наличия" },
];

export type ScenarioLeadBody = {
  source: string;
  lead_type: ScenarioKey;
  phone: string | null;
  message: string | null;
  metadata: Record<string, string>;
};

/** Собрать тело POST /leads из значений формы. chips/text -> metadata,
 *  textarea -> message, телефон отдельно. Пустые поля отбрасываются.
 *  Всегда проставляет origin. source="home" (канал), тип — в lead_type. */
export function buildScenarioLead(
  scenario: ScenarioKey, values: Record<string, string>, phone: string,
): ScenarioLeadBody {
  const cfg = SCENARIOS[scenario];
  const metadata: Record<string, string> = { origin: SCENARIO_ORIGIN };
  let message: string | null = null;
  for (const f of cfg.fields) {
    const v = (values[f.key] || "").trim();
    if (!v) continue;
    if (f.kind === "textarea") message = v;
    else metadata[f.key] = v;
  }
  return {
    source: "home",
    lead_type: cfg.leadType,
    phone: phone.trim() || null,
    message,
    metadata,
  };
}

/** Проверка обязательных полей + контакта. Возвращает текст ошибки или null. */
export function validateScenario(
  scenario: ScenarioKey, values: Record<string, string>, requirePhone: boolean, phone: string,
): string | null {
  for (const f of SCENARIOS[scenario].fields) {
    if ("required" in f && f.required && !(values[f.key] || "").trim()) {
      return `Заполните: ${f.label.replace(/\s*\(.*\)$/, "")}`;
    }
  }
  if (requirePhone && !phone.trim()) {
    return "Оставьте телефон — иначе менеджеру не с кем связаться";
  }
  return null;
}
