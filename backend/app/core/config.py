"""Конфигурация основного backend (Integration Layer v2).

Добавлено в v2:
- AI_CHAT_RATE_LIMIT_PER_MINUTE — лимит запросов к /api/ai/chat;
- ALLOWED_ORIGINS — явный список origin для production CORS;
- канонические имена AI_ENGINE_TIMEOUT_SECONDS и CATALOG_EXPORT_API_KEY.

Обратная совместимость: старые имена AI_TIMEOUT_SECONDS и CATALOG_EXPORT_KEY
по-прежнему читаются как псевдонимы — существующие .env не ломаются.
"""
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # ==== Публичная конфигурация витрины (v4 pre-launch) ====
    # Отдаётся наружу через GET /api/config/public — НИКАКИХ секретов здесь.
    APP_NAME: str = "AI Seller"
    MANAGER_RETAIL_URL: str = ""      # t.me-ссылка розничного менеджера
    MANAGER_WHOLESALE_URL: str = ""   # оптовые закупки (пусто => fallback на retail)
    MANAGER_B2B_URL: str = ""         # поставки компаниям (пусто => fallback на retail)
    MANAGER_TRADEIN_URL: str = ""     # trade-in / выкуп (пусто => fallback на retail)
    TELEGRAM_CHANNEL_URL: str = ""
    MINI_APP_URL: str = ""
    # Телефон магазина в международном формате. Значение по умолчанию — рабочий
    # номер АйСеллера: раздел «Контакты» обязан работать и на стенде, где .env
    # не заполняли, иначе кнопка звонка тихо исчезает ровно там, где нужна.
    # Меняется переменной окружения, без пересборки фронта.
    SHOP_PHONE: str = "+79936042727"
    # @username бота без «@». Нужен для кнопок в КАНАЛЕ: web_app-кнопки Telegram
    # разрешает только в личных чатах с ботом, в каналах они отвергаются целиком
    # (BUTTON_TYPE_INVALID), поэтому посты канала ведут в Mini App через
    # deep link t.me/<bot>?start=<раздел>.
    BOT_USERNAME: str = ""

    DATABASE_URL: str
    TELEGRAM_BOT_TOKEN: str = ""
    # @username or numeric -100... id. The bot must be a channel administrator.
    TELEGRAM_CHANNEL_ID: str = ""
    # Общий секрет вебхука бота. Telegram присылает его в заголовке
    # X-Telegram-Bot-Api-Secret-Token при каждом апдейте; без совпадения запрос
    # отклоняется. Путь вебхука публичный (за Caddy), и это единственное, что
    # отличает настоящий апдейт от подделки. Пусто => вебхук выключен целиком,
    # чтобы незаданный секрет не превратился в открытый приём чего угодно.
    TELEGRAM_WEBHOOK_SECRET: str = ""
    # Личный чат владельца для служебных уведомлений (заявки «нашли дешевле»).
    # Пусто => такие уведомления не ставятся вовсе. Это норма локального стенда,
    # а не сбой: fallback на канал здесь недопустим — там персональные данные
    # покупателя оказались бы на публике.
    ADMIN_TELEGRAM_ID: str = ""
    # Прокси для ИСХОДЯЩИХ запросов к api.telegram.org (http://, https:// или
    # socks5://). Нужен там, где сеть хостинга не пропускает Telegram: входящий
    # вебхук в такой ситуации доходит нормально, а ответы бота — нет, потому что
    # это отдельный исходящий запрос в обратную сторону. Пусто => идём напрямую.
    # Затрагивает только Telegram; остальные интеграции ходят мимо прокси.
    TELEGRAM_PROXY_URL: str = ""
    JWT_SECRET: str
    ACCESS_TOKEN_MINUTES: int = 30
    REFRESH_TOKEN_DAYS: int = 14
    ADMIN_EMAIL: str
    ADMIN_PASSWORD: str
    DEV_MODE: bool = False

    # ==== Уведомления пользователю в Telegram (патч 1.1) ====
    # Общий рубильник. Выключенный — это НЕ «копить и отправить потом»: очередь
    # вообще не наполняется, иначе включение однажды вывалило бы на людей всю
    # накопленную историю статусов.
    NOTIFICATIONS_ENABLED: bool = True
    # Напоминание о брошенной корзине: сколько часов корзина должна пролежать
    # без единого изменения, чтобы считаться заброшенной.
    CART_REMINDER_ENABLED: bool = True
    CART_REMINDER_IDLE_HOURS: int = 6
    # Верхняя граница возраста. Напоминание про корзину недельной давности —
    # уже не забота, а спам: человек про неё забыл вместе с намерением купить.
    CART_REMINDER_MAX_AGE_HOURS: int = 72
    # Тихие часы по Москве (МСК не переводит часы с 2014-го, поэтому фиксированный
    # сдвиг +3 корректен и не требует базы часовых поясов). Ночное сообщение про
    # корзину приносит отписку, а не заявку.
    CART_REMINDER_QUIET_FROM_HOUR: int = 22
    CART_REMINDER_QUIET_TO_HOUR: int = 10
    # Как часто фоновый процесс сканирует корзины (в цикле сервиса `bot`).
    CART_REMINDER_SCAN_MINUTES: int = 30

    # ==== Слежение за избранным (патч 1.1, фича #3) ====
    FAVORITE_WATCH_ENABLED: bool = True
    # Порог снижения цены в процентах. Сообщать про «минус 30 рублей» — значит
    # обесценить собственные уведомления: следующее перестанут открывать.
    FAVORITE_PRICE_DROP_PERCENT: float = 5.0
    # Потолок уведомлений за один скан. Резкое удешевление популярного товара
    # иначе поставит в очередь столько сообщений, сколько у него подписчиков,
    # одним махом. Очередь всё равно разгребается пачками, но предел нужен.
    FAVORITE_WATCH_LIMIT: int = 500
    FAVORITE_WATCH_SCAN_MINUTES: int = 60

    # ==== Социальное доказательство на карточке (патч 1.1, фича #6) ====
    SOCIAL_PROOF_ENABLED: bool = True
    # Пороги. Ниже них бейджа нет вовсе: «заказывали 1 раз» — антиреклама, а на
    # числах вроде единицы это ещё и указание на конкретного человека.
    SOCIAL_PROOF_MIN_ORDERS: int = 3
    SOCIAL_PROOF_MIN_FAVORITES: int = 5
    # Окно для заказов. Год назад продавалось хорошо — не аргумент сегодня.
    SOCIAL_PROOF_ORDER_WINDOW_DAYS: int = 30

    # ==== CORS (production guard, v2) ====
    # Явный список разрешённых origin через запятую, например:
    # ALLOWED_ORIGINS=https://example.com,https://t.me
    # В production (DEV_MODE=false) используется ТОЛЬКО он; пустой список
    # при DEV_MODE=false приводит к падению на старте (см. main.py).
    ALLOWED_ORIGINS: str = ""

    # ==== Интеграция с AI Engine (Sprint 1.5) ====
    # Пустые дефолты: без них проект работает как раньше, AI-роут уходит в fallback.
    AI_ENGINE_URL: str = ""            # например http://ai-engine:8090
    AI_ENGINE_API_KEY: str = ""        # = AI_ENGINE_API_KEY из .env AI Engine

    # Канонические имена (v2) + псевдонимы для обратной совместимости (v1).
    AI_ENGINE_TIMEOUT_SECONDS: float = 20.0   # локальная Ollama на CPU может думать долго
    AI_TIMEOUT_SECONDS: float | None = None   # DEPRECATED-псевдоним AI_ENGINE_TIMEOUT_SECONDS

    CATALOG_EXPORT_API_KEY: str = ""   # ключ, с которым AI Engine забирает каталог
    CATALOG_EXPORT_KEY: str = ""       # DEPRECATED-псевдоним CATALOG_EXPORT_API_KEY

    # ==== Rate limit на /api/ai/chat (v2) ====
    AI_CHAT_RATE_LIMIT_PER_MINUTE: int = 10
    # Попыток входа в админку с одного IP в минуту (v5.4.2, защита от перебора пароля).
    ADMIN_LOGIN_RATE_LIMIT_PER_MINUTE: int = 5
    # Необязательный Redis для распределённого лимита. Пусто => in-memory (per-process),
    # чего достаточно для одного инстанса backend. Недоступность Redis => мягкая
    # деградация на in-memory, backend не падает (см. core/rate_limit.py).
    RATE_LIMIT_REDIS_URL: str = ""

    # ==== Режим AI для демо ====
    # fallback | mock — не обращаться к AI Engine, отвечать по каталогу (быстро, без ключей);
    # ai            — legacy AI Engine (docker profile ai);
    # ollama_remote — локальный AI-консультант через AI Gateway на Mac mini (v5);
    # anthropic     — Anthropic Messages API напрямую (v5.7), см. блок ниже.
    # Демо по умолчанию = fallback, чтобы не зависеть от Ollama/ключей.
    AI_PROVIDER: str = "fallback"

    # ==== Anthropic Messages API (v5.7) ====
    # Включение: AI_PROVIDER=anthropic. Пайплайн тот же, что у ollama_remote
    # (retrieval из БД -> кандидаты -> модель -> строгая валидация), меняется
    # только транспорт. Пустой ключ => оркестратор сразу уходит в fallback.
    # ВНИМАНИЕ: api.anthropic.com доступен не из любого региона — прод-VPS
    # получает 403 forbidden ещё до проверки ключа (см. CLAUDE.md).
    AI_ANTHROPIC_API_KEY: str = ""
    AI_ANTHROPIC_MODEL: str = "claude-haiku-4-5"
    AI_ANTHROPIC_MAX_TOKENS: int = 2000     # ответ короткий: текст + JSON-обвязка
    AI_ANTHROPIC_TIMEOUT_SECONDS: float = 30.0
    # Точка входа в Messages API. Пусто => api.anthropic.com напрямую (локальная
    # разработка). На проде сюда ставится прокси в открытом регионе
    # (gateway-vercel/), потому что прямой доступ отдаёт 403 по региону.
    #
    # Прокси прозрачный: промпт, схема ответа и модель остаются здесь, в Python,
    # и не дублируются на его стороне — иначе получили бы вторую копию схемы,
    # которая разъедется с валидатором.
    #
    # При работе через прокси AI_ANTHROPIC_API_KEY — это секрет ПРОКСИ, а не
    # ключ Anthropic: настоящий ключ живёт только на прокси, на VPS его нет.
    AI_ANTHROPIC_BASE_URL: str = ""

    # ==== Локальный AI-консультант через AI Gateway (v5) ====
    # Gateway живёт на Mac mini (Ollama), доступен по приватной сети (Tailscale и т.п.).
    AI_GATEWAY_URL: str = ""           # например http://100.64.0.2:8100
    AI_GATEWAY_API_KEY: str = ""       # общий секрет VPS <-> Gateway
    AI_MAX_HISTORY_MESSAGES: int = 10  # сколько последних сообщений диалога отправлять
    # Кандидаты — основная статья расхода на входные токены: каждый уходит в
    # контекст целиком. 8 вместо прежних 12 заметно дешевле, а качество подбора
    # держит retrieval, который и так отдаёт лучших первыми: разница между 8-м и
    # 12-м кандидатом на ответ практически не влияет.
    AI_MAX_PRODUCT_CANDIDATES: int = 8   # максимум товаров-кандидатов в контекст LLM
    # Простой просмотр каталога («айфоны», «dyson») отвечается из БД, без LLM:
    # список товаров модель не улучшает, а платим за него как за полноценный
    # запрос. Условие узкое (см. _is_plain_browse) — совет, сравнение и задача
    # по-прежнему идут в модель. Выключается, если поведение не устроит.
    AI_SKIP_LLM_FOR_BROWSE: bool = True
    AI_FALLBACK_ENABLED: bool = True   # при недоступности Gateway отвечать fallback'ом
    AI_SYSTEM_PROMPT_VERSION: str = "v2"  # версия файла app/prompts/ai_seller_system_<v>.md
    # Таймаут запроса VPS->Gateway (v5.1.1). Полный запрос на gateway может занять
    # queue wait (до 10с) + inference (до 45с) + сетевой overhead, поэтому здесь
    # 65с; таймаут фронтенда (75с) — больше этого.
    AI_GATEWAY_TIMEOUT_SECONDS: float = 65.0
    # Прогрев serverless-функции гейтвея. Замер с прода: холодный вызов
    # /api/v1/messages — 6.0с ещё ДО обращения к модели, тёплый — 0.5с. Эти пять
    # секунд платит первый человек после простоя, то есть ровно тот, кто только
    # что открыл приложение. Пинг — обычный GET, он получает 405 и до Anthropic
    # не доходит: ни ключа, ни расхода токенов. 0 выключает прогрев.
    AI_GATEWAY_WARM_MINUTES: int = 5
    # Прокси до гейтвея. Домен на Vercel резолвится в НЕСКОЛЬКО адресов, и сеть
    # прод-VPS доходит не до всех: прямое соединение виснет на TCP-таймауте
    # (12-24с) примерно в половине попыток, а SDK сверху ещё и ретраит — вот
    # откуда «ИИ думает десять секунд». Через WARP тот же запрос стабильно
    # укладывается в 0.6с. Пусто => напрямую (локальная разработка).
    AI_GATEWAY_PROXY_URL: str = ""

    # ==== Batch Import Center (v5.2) ====
    IMPORT_MAX_FILES: int = 30                       # файлов в одном пакете
    IMPORT_MAX_TOTAL_ROWS: int = 5000                # суммарно строк во всех файлах
    IMPORT_MAX_DATA_FILE_BYTES: int = 20971520       # 20 МБ на data-файл
    IMPORT_MAX_ZIP_BYTES: int = 524288000            # 500 МБ на ZIP
    IMPORT_MAX_UNCOMPRESSED_BYTES: int = 1073741824  # 1 ГБ распакованного
    IMPORT_JOB_TTL_SECONDS: int = 1800               # 30 минут на confirm
    IMPORT_MAX_IMAGES: int = 5000                    # изображений в пакете
    IMPORT_PRICE_CHANGE_WARN_PCT: float = 30.0       # warning при изменении цены > N%

    class Config:
        env_file = ".env"
        extra = "ignore"

    # ---- Разрешение псевдонимов (старое имя побеждает, только если новое осталось дефолтным) ----
    @property
    def ai_engine_timeout_seconds(self) -> float:
        if self.AI_TIMEOUT_SECONDS is not None:
            return self.AI_TIMEOUT_SECONDS
        return self.AI_ENGINE_TIMEOUT_SECONDS

    @property
    def catalog_export_api_key(self) -> str:
        return self.CATALOG_EXPORT_API_KEY or self.CATALOG_EXPORT_KEY

    @property
    def allowed_origins_list(self) -> list[str]:
        return [o.strip() for o in self.ALLOWED_ORIGINS.split(",") if o.strip()]


settings = Settings()
