"""Схемы Integration Layer: AI-чат, события аналитики, заявки (Demo MVP)."""
import json

from pydantic import BaseModel, Field, field_validator

from app.models.lead import DEFAULT_LEAD_TYPE, LEAD_TYPES

MAX_MESSAGE_LEN = 1000

# ---- Валидация metadata заявки (v5.4.0) ----
# metadata — только JSON-object с ограниченным размером: неизвестные/огромные
# payload'ы не должны попадать в БД. Значения приводим к безопасным скалярам.
META_MAX_KEYS = 24
META_MAX_KEY_LEN = 40
META_MAX_STR_LEN = 500
META_MAX_BYTES = 4000            # сериализованный размер очищенного объекта


def normalize_lead_type(value: str | None) -> str:
    """Неизвестный/пустой тип -> безопасный дефолт general (обратная совместимость
    со старыми клиентами, которые lead_type не присылают)."""
    v = (value or "").strip().lower()
    return v if v in LEAD_TYPES else DEFAULT_LEAD_TYPE


def sanitize_lead_metadata(raw) -> dict:
    """Очистить клиентскую metadata до безопасного JSON-object.

    Правила: только объект; ключи — короткие строки; значения — скаляры
    (str/int/float/bool) или короткий список скаляров; строки обрезаются;
    число ключей и общий сериализованный размер ограничены. Ничего не
    «доверяем» клиенту вслепую: лишнее молча отбрасывается, а не сохраняется.
    HTML не рендерим — экранирование на стороне админки."""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError("metadata must be a JSON object")

    def clean_scalar(v):
        if isinstance(v, bool) or isinstance(v, (int, float)):
            return v
        if isinstance(v, str):
            return v.strip()[:META_MAX_STR_LEN]
        return None

    out: dict = {}
    for key, value in raw.items():
        if len(out) >= META_MAX_KEYS:
            break
        if not isinstance(key, str):
            continue
        k = key.strip()[:META_MAX_KEY_LEN]
        if not k:
            continue
        if isinstance(value, list):
            items = [s for s in (clean_scalar(x) for x in value[:20]) if s is not None and s != ""]
            if items:
                out[k] = items
        else:
            s = clean_scalar(value)
            if s is not None and s != "":
                out[k] = s

    # Жёсткий предел общего размера: если очищенный объект всё ещё огромный —
    # это аномалия, отклоняем целиком, а не пишем в БД.
    if len(json.dumps(out, ensure_ascii=False)) > META_MAX_BYTES:
        raise ValueError("metadata is too large")
    return out

# Белый список событий продуктовой аналитики. Всё, что не отсюда, — отклоняем.
ALLOWED_EVENTS = {
    # AI-воронка
    "ai_chat_opened",
    "ai_query_submitted",
    "ai_response_received",
    "ai_product_card_viewed",
    "ai_product_card_clicked",
    "ai_order_started_from_ai",
    # Демо-воронка магазина
    "app_opened",
    "catalog_opened",
    "product_viewed",
    "lead_created",
    "admin_opened",
    # UX-патч (Лавка-адаптация): поиск/сценарии/история/пустые состояния.
    # В payload — только метаданные (query_length, source), не текст запроса.
    "search_focused",
    "search_query_submitted",
    "search_result_clicked",
    "search_ai_escalated",
    "quick_scenario_clicked",
    "ai_prefill_opened",
    "history_opened",
    "empty_state_action_clicked",
    # v5.4.0: встроенные сценарные заявки (bottom-sheet) и карусель фото.
    # Payload — только безопасные метаданные (тип сценария, source, product_id,
    # image_count, from/to index). НЕ телефон/имя/модель/комментарий.
    "scenario_sheet_opened",
    "scenario_option_selected",
    "scenario_lead_submitted",
    "scenario_lead_success",
    "scenario_lead_failed",
    "product_gallery_swiped",
    "product_gallery_dot_clicked",
    "photo_coverage_opened",
    "photo_coverage_exported",
    # v5.5.0: свайп-навигация между страницами. Payload — только маршрут,
    # направление жеста и цель перехода; пользовательских данных нет.
    "page_swiped",
    # Compact Home + Cart: воронка корзины и checkout. Payload — только
    # безопасные метаданные (product_id, quantity, items_count, код ошибки).
    # Телефон, имя и комментарий в аналитику НЕ попадают ни при каких условиях.
    "cart_add",
    "cart_remove",
    "cart_quantity_change",
    "cart_open",
    "checkout_start",
    "checkout_submit",
    "checkout_success",
    "checkout_error",
    "buy_now",
    "continue_shopping",
    # v5.9: тумблеры навигации (ось категорий/брендов, режим строки поиска).
    # Payload — только выбранное положение и место переключения.
    "home_axis_switched",
    # Историческое: тумблер «Каталог / AI» убран, фронт это событие больше не
    # шлёт. Имя оставлено, чтобы вкладки со старым бандлом не ловили 400.
    "search_mode_switched",
    # Патч 1.1: распространение и возвращаемость. Payload — product_id и способ
    # (target/from). Ни ссылки, ни текста сообщения, ни адресата.
    "product_shared",
    "home_screen_prompted",
    # Патч 1.2: интерес к устройству и планам AI-подбора.
    "ai_roadmap_opened",
    # v5.8.0: лояльность — открытие экрана баллов и роудмапа программы.
    "loyalty_opened",
    "loyalty_roadmap_opened",
}


class AiHistoryItem(BaseModel):
    """Одно сообщение истории диалога (текст, без карточек и без PII)."""
    role: str = Field(pattern="^(user|assistant)$")
    text: str = Field(min_length=1, max_length=MAX_MESSAGE_LEN)


class AiChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=MAX_MESSAGE_LEN)
    # История диалога от фронтенда (v5): максимум 10 последних сообщений.
    history: list[AiHistoryItem] = Field(default_factory=list, max_length=10)


class EventIn(BaseModel):
    event: str = Field(min_length=1, max_length=64)
    payload: dict = Field(default_factory=dict)


class LeadIn(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    phone: str | None = Field(default=None, max_length=64)
    product_id: int | None = None
    product_title: str | None = Field(default=None, max_length=300)
    message: str | None = Field(default=None, max_length=2000)
    source: str = Field(default="other", max_length=32)
    delivery_method: str | None = Field(default=None, max_length=32)  # pickup | delivery
    # v5.4.0: продуктовый сценарий + структурированные ответы. Оба необязательны;
    # старый клиент их не шлёт -> lead_type=general, metadata={}. status/telegram_id/
    # username/assigned_to клиент задать НЕ может — их тут нет by design.
    lead_type: str | None = Field(default=None, max_length=32)
    metadata: dict | None = Field(default=None)

    @field_validator("lead_type")
    @classmethod
    def _norm_type(cls, v: str | None) -> str:
        return normalize_lead_type(v)

    @field_validator("metadata")
    @classmethod
    def _clean_meta(cls, v) -> dict:
        return sanitize_lead_metadata(v)


class LeadStatusIn(BaseModel):
    status: str | None = Field(default=None, max_length=32)
    assigned_to: str | None = Field(default=None, max_length=200)
    manager_comment: str | None = Field(default=None, max_length=2000)
