# AI-консультант AI Seller: архитектура (v5)

## Схема

```
Пользователь (Telegram Mini App / браузер)
   │  POST /api/ai/chat  {message, history[≤10]}   (JWT, rate limit 10/мин)
   ▼
VPS · backend FastAPI
   │ 1. deterministic intents (менеджер/опт/B2B/Trade-In/«кто ты») → ответ без LLM
   │ 2. extract_filters: бюджет, категория, бренд, состояние, сценарии   [ai_retrieval.py]
   │ 3. retrieval: жёсткие SQL-фильтры + мягкий ranking → ≤12 кандидатов
   ▼
AI Gateway (Mac mini M4 Pro, приватная сеть: Tailscale)      [ai-gateway/main.py]
   │  X-API-Key · payload ≤64KB · rate limit · semaphore(2) · timeout 45s
   ▼
Ollama (127.0.0.1:11434, наружу не торчит) · qwen3:14b · format=json
   ▼
VPS · backend
   │ 4. parse → repair(1 попытка) → Pydantic-валидация      [ai_schemas.py]
   │ 5. product_id ∩ кандидаты (чужие отброшены), максимум 3
   │ 6. карточки/цены ТОЛЬКО из БД (to_card)
   │ 7. любая ошибка → детерминированный fallback (как раньше)
   ▼
Фронтенд: {text, cards, actions, meta}  — контракт НЕ менялся
```

## Ключевые решения
- **Mac mini не видит PostgreSQL.** VPS сам ищет товары и шлёт Gateway только
  вопрос + историю + компактных кандидатов. Gateway = тупой мост с guardrails.
- **LLM не источник данных.** Цена/наличие в ответе пользователю всегда из БД;
  текст модели их не переопределяет. Незнакомые product_id отбрасываются молча.
- **Fallback всегда жив.** `AI_PROVIDER=fallback` (сегодняшний прод) не тронут;
  `ollama_remote` включается одной env-переменной, при сбоях деградирует в тот же
  fallback с пометкой «Сейчас отвечаю в упрощённом режиме…».
- **Простые интенты без LLM** («контакты менеджера», «оптом», trade-in, «кто ты») —
  мгновенный ответ правилами, Mac mini не нагружается.
- **System prompt версионирован**: `backend/app/prompts/ai_seller_system_v1.md`,
  переключение через `AI_SYSTEM_PROMPT_VERSION=v2` без правки кода.

## Файлы
| Слой | Файл | Роль |
|---|---|---|
| backend | `app/services/ai_orchestrator.py` | пайплайн, deterministic intents, fallback |
| backend | `app/services/ai_retrieval.py` | фильтры, гибридный ranking, контекст кандидатов |
| backend | `app/services/ai_schemas.py` | structured output: Pydantic + parse/repair |
| backend | `app/services/ai_remote.py` | HTTP-клиент Gateway |
| backend | `app/prompts/ai_seller_system_v1.md` | системный промпт v1 |
| backend | `app/api/ai.py` | маршрутизация AI_PROVIDER (без слома legacy) |
| gateway | `ai-gateway/main.py` | FastAPI: auth, лимиты, Ollama |
| frontend | `src/pages/AiSearch.tsx` | история (≤10) + timeout 60с |

## Переменные окружения (VPS backend)
```
AI_PROVIDER=ollama_remote      # включение (fallback|mock|ai|ollama_remote)
AI_GATEWAY_URL=http://100.x.y.z:8100   # адрес Mac mini в Tailscale
AI_GATEWAY_API_KEY=<секрет, одинаковый с gateway>
AI_TIMEOUT_SECONDS=45
AI_MAX_HISTORY_MESSAGES=10
AI_MAX_PRODUCT_CANDIDATES=12
AI_FALLBACK_ENABLED=true
AI_SYSTEM_PROMPT_VERSION=v1
```
Gateway (Mac mini): см. `ai-gateway/.env.example`
(`OLLAMA_BASE_URL, OLLAMA_CHAT_MODEL=qwen3:14b, OLLAMA_FAST_MODEL=qwen3:8b, AI_MAX_CONCURRENCY…`).

## Метрики (в meta ответа и логах)
`retrieval_ms`, `gateway_ms` (полный inference), `latency_ms` (всего),
`candidates`, `dropped_ids` (отброшенные галлюцинации), `degraded`/`fallback_reason`,
`confidence`. Gateway логирует JSON-строки: model, total_ms, output_chars — без текста сообщений.

## Ограничения v1
- Streaming не включён (короткие ответы + format=json; можно добавить позже).
- Состояние диалога живёт на фронте (переслали последние 10 сообщений) — серверного
  хранилища сессий нет, TTL не нужен, PII не сохраняется.
- Сравнение (`comparison`) возвращается моделью, но фронт пока рисует его как текст.
- qwen3:14b: первый запрос после простоя = загрузка модели в память (10–30 с).
