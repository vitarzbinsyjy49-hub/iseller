# PreLaunch Patch, фаза 2: «Предложить цену ниже»

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** С карточки товара покупатель кидает ссылку на этот же товар у конкурента, видит подтверждение, а владельцу мгновенно падает заявка со ссылкой в Telegram и в раздел «Заявки».

**Architecture:** Никакого парсинга страниц — решение владельца, и оно правильное: DNS уже отдаёт нам 401, Ozon и Я.Маркет закрыты антиботом, а сломавшийся парсер хуже отсутствующего. Ссылка проверяется синтаксически (схема, хост, не наш домен), кладётся в `metadata` заявки нового типа `price_offer` и уезжает владельцу через существующую очередь `notifications.enqueue()`.

**Tech Stack:** FastAPI + SQLAlchemy, React/Vite, Telegram Bot API через существующий `notifications.drain()` в боте.

---

## Отклонения от плана при реализации (2026-08-08)

Записаны, потому что каждое найдено уже в работе и объясняет, почему код не
совпадает с текстом выше дословно.

1. **Цена конкурента.** Плана не было — добавлено поле `competitor_price`
   (необязательное, со слов покупателя). Владельцу в Telegram уходит обе цены и
   разница; в форме — подпись «Дешевле на N», но только когда у них реально
   дешевле.
2. **Лимит длины ссылки.** `sanitize_lead_metadata` резал ЛЮБУЮ строку metadata
   до 500 символов — ссылка на 2048 обрезалась бы молча, и менеджер получил бы
   битый адрес. Заведено именное исключение `META_URL_KEYS` +
   `META_MAX_URL_LEN`; тест держит его равным `MAX_URL_LENGTH` в `offer_links`.
   Длина проверяется ПОСЛЕ отсечения utm-хвостов.
3. **Двойная отправка.** Заявка получает `idempotency_key` из товара и
   нормализованной ссылки: повтор возвращает ту же заявку, владелец не получает
   дубль. Использован существующий частичный уникальный индекс.
4. **Место на экране.** Не шторка, как в Task 4, а раскрытие В ПОТОКЕ страницы
   товара (решение владельца). Кнопка стоит рядом с блоком условий.
5. **Обратное уведомление покупателю.** В плане отсутствовало. Механику не
   строили: `_notify_status_change` уже работает, добавлен оверлей
   `_PRICE_OFFER_STATUS_TEXTS` — он ПЕРЕОПРЕДЕЛЯЕТ формулировки, но не
   расширяет набор уведомляемых статусов.
6. **Админка — отдельное приложение.** `LEAD_TYPE_RU`/`META_KEY_RU` в
   `admin/src/ui.ts` пришлось пополнять отдельно от `frontend/src/lib/leads.ts`.
   Без этого заявка не попадала в фильтр по типу.
7. **Дефект анимации, найденный на живом стенде.** Высоту «откуда ехать» нельзя
   измерять в layout-фазе: содержимое уже смонтировано и коробка отдаёт
   натуральную высоту, поэтому «откуда» совпадало с «куда» и анимации не было
   вовсе. Хуже: при повторном прогоне эффектов (StrictMode) замер отдавал ноль и
   блок ЗАМИРАЛ закрытым — снаружи это выглядело как неработающая кнопка.
   Решение вынесено в чистую функцию `planReveal` (`lib/priceOffer.ts`) и
   покрыто тестами; нулевой замер теперь means «показать без анимации».

**Известный пробел:** в `frontend/` нет jsdom и testing-library, поэтому сам
компонент тестами не покрыт — проверен вживую в браузере (оба режима движения).
Покрыта только логика решения. Заводить тестовую инфраструктуру перед запуском
не стали.

---

## Контекст, который сэкономит время

| что | где |
|---|---|
| Типы заявок | `backend/app/models/lead.py:32` — кортеж `LEAD_TYPES` |
| Создание заявки | `backend/app/api/leads.py:24` — `POST /leads` |
| Очередь уведомлений | `backend/app/services/notifications.py:64` — `enqueue(db, chat_id=…, kind=…, message=…, dedupe_key=…)` |
| Шаблоны сообщений | `backend/app/services/notification_templates.py` |
| Паттерн сценарной заявки на фронте | `frontend/src/lib/scenario.ts` — конфиг + сборка тела |
| Подписи типов и метаданных | `frontend/src/lib/leads.ts:14` (`LEAD_TYPE_LABEL`), `:41` (`KEY_LABELS`) |

Две вещи, которые легко сделать неправильно:

1. **`enqueue` не коммитит** — строка обязана уехать той же транзакцией, что и заявка. Коммитит вызывающий код (см. докстринг `enqueue`).
2. **`_send` намеренно не имеет fallback'а на канал.** Если `chat_id` пуст, уведомление просто не ставится. Это защита: промах адресата опубликовал бы личные данные в открытом канале. Не «чини» это.

Переменной с чатом владельца в проекте **нет** — на проде есть `MANAGER_RETAIL_URL` (ссылка), но не id чата. Её заводим в Task 3.

---

## Task 1: Тип заявки `price_offer` и проверка ссылки

**Files:**
- Modify: `backend/app/models/lead.py:32`
- Create: `backend/app/services/offer_links.py`
- Create: `backend/tests/test_offer_links.py`

- [ ] **Step 1: Написать падающие тесты проверки ссылки**

Create `backend/tests/test_offer_links.py`:

```python
import pytest

from app.services.offer_links import OfferLinkError, normalize_offer_url


def test_accepts_plain_https_link():
    assert normalize_offer_url("https://www.mvideo.ru/products/iphone-17-123") \
        == "https://www.mvideo.ru/products/iphone-17-123"


def test_adds_scheme_when_missing():
    """Человек копирует адрес из строки браузера и схему часто теряет."""
    assert normalize_offer_url("ozon.ru/product/iphone-17-999").startswith("https://")


def test_rejects_non_http_scheme():
    with pytest.raises(OfferLinkError):
        normalize_offer_url("javascript:alert(1)")


def test_rejects_our_own_domain():
    """Ссылка на нас самих — это не предложение конкурента, а ошибка."""
    with pytest.raises(OfferLinkError):
        normalize_offer_url("https://158.255.1.248.sslip.io/product/42")


def test_rejects_host_without_dot():
    with pytest.raises(OfferLinkError):
        normalize_offer_url("https://localhost/product")


def test_rejects_empty():
    with pytest.raises(OfferLinkError):
        normalize_offer_url("   ")


def test_rejects_absurdly_long():
    with pytest.raises(OfferLinkError):
        normalize_offer_url("https://ozon.ru/" + "a" * 3000)


def test_strips_tracking_params():
    """utm-хвосты раздувают ссылку и мешают глазами сверить товар."""
    out = normalize_offer_url(
        "https://www.dns-shop.ru/product/abc/?utm_source=x&utm_medium=y&sku=15"
    )
    assert "utm_source" not in out
    assert "sku=15" in out


def test_known_shop_name():
    from app.services.offer_links import shop_name

    assert shop_name("https://www.mvideo.ru/x") == "М.Видео"
    assert shop_name("https://unknown-shop.example/x") == "unknown-shop.example"
```

- [ ] **Step 2: Убедиться, что падают**

Run: `cd backend && python -m pytest tests/test_offer_links.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.offer_links'`

- [ ] **Step 3: Реализовать модуль**

Create `backend/app/services/offer_links.py`:

```python
"""Проверка ссылки на товар у конкурента для сценария «предложить цену ниже».

Страницу НЕ загружаем и цену НЕ парсим — осознанное решение. Крупные площадки
закрыты антиботом (DNS отдаёт нам 401, Ozon и Я.Маркет — редиректы на защиту),
и парсер, который сегодня работает, завтра тихо начнёт возвращать пустоту.
Молча неверная цена хуже отсутствующей, поэтому проверяем только форму ссылки,
а решение принимает человек.
"""
from __future__ import annotations

from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

MAX_URL_LENGTH = 2048

#: Хосты, на которые ссылаться бессмысленно: это мы сами.
_OWN_HOSTS = {"158.255.1.248.sslip.io", "admin.158.255.1.248.sslip.io", "t.me"}

#: Параметры аналитики — режем, чтобы ссылка читалась глазами.
_TRACKING_PREFIXES = ("utm_", "yclid", "gclid", "fbclid", "_openstat", "from")

#: Понятные имена площадок. Не влияет на логику, только на текст владельцу.
_KNOWN_SHOPS = {
    "ozon.ru": "Ozon",
    "mvideo.ru": "М.Видео",
    "dns-shop.ru": "DNS",
    "citilink.ru": "Ситилинк",
    "eldorado.ru": "Эльдорадо",
    "wildberries.ru": "Wildberries",
    "market.yandex.ru": "Яндекс Маркет",
    "avito.ru": "Авито",
    "restore.ru": "re:Store",
}


class OfferLinkError(ValueError):
    """Ссылку нельзя принять — текст исключения показывается пользователю."""


def normalize_offer_url(raw: str) -> str:
    text = (raw or "").strip()
    if not text:
        raise OfferLinkError("Пришлите ссылку на товар")
    if len(text) > MAX_URL_LENGTH:
        raise OfferLinkError("Ссылка слишком длинная")

    # Из строки браузера схема часто теряется при копировании.
    if "://" not in text:
        text = "https://" + text

    parsed = urlparse(text)
    if parsed.scheme not in ("http", "https"):
        raise OfferLinkError("Ссылка должна начинаться с http:// или https://")

    host = (parsed.hostname or "").lower()
    if not host or "." not in host:
        raise OfferLinkError("Не похоже на адрес магазина")

    bare = host[4:] if host.startswith("www.") else host
    if host in _OWN_HOSTS or bare in _OWN_HOSTS:
        raise OfferLinkError("Это ссылка на наш же магазин")

    kept = [
        (k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True)
        if not any(k.lower().startswith(p) for p in _TRACKING_PREFIXES)
    ]
    return urlunparse(parsed._replace(query=urlencode(kept), fragment=""))


def shop_name(url: str) -> str:
    """Человеческое имя площадки; для незнакомых — сам хост."""
    host = (urlparse(url).hostname or "").lower()
    bare = host[4:] if host.startswith("www.") else host
    for known, label in _KNOWN_SHOPS.items():
        if bare == known or bare.endswith("." + known):
            return label
    return bare
```

- [ ] **Step 4: Тесты проходят**

Run: `cd backend && python -m pytest tests/test_offer_links.py -v`
Expected: 9 passed

- [ ] **Step 5: Добавить тип заявки**

В `backend/app/models/lead.py:32` расширить кортеж:

```python
# price_offer — «нашёл дешевле»: покупатель прислал ссылку на тот же товар у
# конкурента, менеджер решает по цене вручную. Ссылка лежит в metadata.
LEAD_TYPES = ("general", "product", "trade_in", "b2b", "wholesale", "cart", "price_offer")
```

- [ ] **Step 6: Прогон бэкенда**

Run: `cd backend && python -m pytest -q`
Expected: всё зелёное.

- [ ] **Step 7: Коммит**

```bash
git add backend/app/services/offer_links.py backend/tests/test_offer_links.py backend/app/models/lead.py
git commit -m "feat(заявки): тип price_offer и проверка ссылки на конкурента"
```

---

## Task 2: Приём заявки в API

**Files:**
- Modify: `backend/app/api/leads.py`
- Test: `backend/tests/test_leads_price_offer.py`

- [ ] **Step 1: Изучить существующую схему заявки**

Run: `cd backend && sed -n '1,80p' app/api/leads.py`
Обрати внимание на `LeadIn` — как объявлены `lead_type`, `metadata`, `product_id`.

- [ ] **Step 2: Написать падающий тест**

Create `backend/tests/test_leads_price_offer.py` (стиль и фикстуры возьми из соседнего теста заявок — найди его: `ls tests | grep lead`):

```python
def test_price_offer_lead_normalizes_url(client, auth_headers):
    resp = client.post("/leads", json={
        "lead_type": "price_offer",
        "product_id": 1,
        "source": "product",
        "metadata": {
            "competitor_url": "www.mvideo.ru/product/x?utm_source=tg",
            "origin": "product_price_offer",
        },
    }, headers=auth_headers)
    assert resp.status_code == 201
    meta = resp.json()["metadata"]
    assert meta["competitor_url"].startswith("https://")
    assert "utm_source" not in meta["competitor_url"]
    assert meta["competitor_shop"] == "М.Видео"


def test_price_offer_rejects_bad_url(client, auth_headers):
    resp = client.post("/leads", json={
        "lead_type": "price_offer",
        "product_id": 1,
        "source": "product",
        "metadata": {"competitor_url": "javascript:alert(1)"},
    }, headers=auth_headers)
    assert resp.status_code == 422
```

- [ ] **Step 3: Запустить — убедиться, что падает**

Run: `cd backend && python -m pytest tests/test_leads_price_offer.py -v`
Expected: FAIL — ссылка не нормализуется, `competitor_shop` отсутствует.

- [ ] **Step 4: Реализовать в `create_lead`**

В `backend/app/api/leads.py` внутри `create_lead`, до сохранения:

```python
    # Ссылка на конкурента проверяется на входе, а не при показе: заявка живёт
    # в базе долго, а кривой адрес всплывёт у менеджера в самый неудобный
    # момент. Заодно кладём имя площадки — менеджеру так быстрее ориентироваться.
    if body.lead_type == "price_offer":
        from app.services.offer_links import OfferLinkError, normalize_offer_url, shop_name

        meta = dict(body.metadata or {})
        try:
            url = normalize_offer_url(str(meta.get("competitor_url", "")))
        except OfferLinkError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        meta["competitor_url"] = url
        meta["competitor_shop"] = shop_name(url)
        body.metadata = meta
```

Если `HTTPException` ещё не импортирован — добавь в шапку `from fastapi import HTTPException`.

- [ ] **Step 5: Тесты проходят**

Run: `cd backend && python -m pytest tests/test_leads_price_offer.py -v`
Expected: 2 passed

- [ ] **Step 6: Коммит**

```bash
git add backend/app/api/leads.py backend/tests/test_leads_price_offer.py
git commit -m "feat(заявки): приём price_offer с проверкой ссылки"
```

---

## Task 3: Уведомление владельцу в Telegram

**Files:**
- Modify: `backend/app/core/config.py`
- Modify: `backend/app/services/notification_templates.py`
- Modify: `backend/app/api/leads.py`
- Test: `backend/tests/test_leads_price_offer.py`

- [ ] **Step 1: Завести настройку с чатом владельца**

В `backend/app/core/config.py` рядом с прочими телеграм-настройками:

```python
    # Чат владельца для служебных уведомлений (заявки «нашёл дешевле»).
    # Пусто = уведомления не шлём; это норма для локального стенда, а не сбой.
    ADMIN_TELEGRAM_ID: str = ""
```

- [ ] **Step 2: Написать падающий тест шаблона**

```python
def test_price_offer_message_contains_link_and_prices():
    from app.services.notification_templates import price_offer_message

    msg = price_offer_message(
        product_title="iPhone 17 Pro 256",
        our_price=104000,
        competitor_url="https://www.mvideo.ru/p/1",
        competitor_shop="М.Видео",
        username="ivan",
    )
    assert "iPhone 17 Pro 256" in msg.text
    assert "М.Видео" in msg.text
    assert "https://www.mvideo.ru/p/1" in msg.text
    assert "104" in msg.text
```

- [ ] **Step 3: Запустить**

Run: `cd backend && python -m pytest tests/test_leads_price_offer.py -k message -v`
Expected: FAIL — функции нет.

- [ ] **Step 4: Реализовать шаблон**

В `backend/app/services/notification_templates.py` (посмотри рядом, как устроен `Message` и экранирование HTML — повтори тот же стиль):

```python
def price_offer_message(
    *, product_title: str, our_price: float | None,
    competitor_url: str, competitor_shop: str, username: str | None,
) -> Message:
    """Заявка «нашёл дешевле» владельцу.

    Ссылку НЕ оборачиваем в <a>: менеджеру нужен виден сам адрес, чтобы
    оценить площадку до перехода.
    """
    who = f"@{username}" if username else "покупатель"
    price = f"{our_price:,.0f} ₽".replace(",", " ") if our_price else "—"
    text = (
        "💸 <b>Нашли дешевле</b>\n"
        f"\n<b>{escape(product_title)}</b>\n"
        f"Наша цена: {price}\n"
        f"Площадка: {escape(competitor_shop)}\n"
        f"\n{escape(competitor_url)}\n"
        f"\nОт: {escape(who)}"
    )
    return Message(text=text, keyboard=None)
```

- [ ] **Step 5: Ставить уведомление в очередь при создании заявки**

В `create_lead`, в том же блоке `if body.lead_type == "price_offer":`, после нормализации — но **до** коммита, который уже делает функция:

```python
        # enqueue не коммитит намеренно: уведомление обязано уехать той же
        # транзакцией, что и сама заявка. Иначе владелец получит ссылку на
        # заявку, которой в базе не окажется.
        if settings.ADMIN_TELEGRAM_ID:
            from app.services.notification_templates import price_offer_message
            from app.services.notifications import enqueue

            enqueue(
                db,
                chat_id=int(settings.ADMIN_TELEGRAM_ID),
                kind="price_offer",
                message=price_offer_message(
                    product_title=lead.product_title or "товар",
                    our_price=float(lead.product_price) if lead.product_price else None,
                    competitor_url=meta["competitor_url"],
                    competitor_shop=meta["competitor_shop"],
                    username=lead.username,
                ),
                dedupe_key=f"price_offer:{lead.id}",
            )
```

Размести код после того, как `lead` получил `id` (то есть после `db.flush()`), иначе `dedupe_key` соберётся с `None`.

- [ ] **Step 6: Тест «уведомление встало в очередь»**

```python
def test_price_offer_enqueues_admin_notification(client, auth_headers, db_session, monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "ADMIN_TELEGRAM_ID", "12345")

    client.post("/leads", json={
        "lead_type": "price_offer", "product_id": 1, "source": "product",
        "metadata": {"competitor_url": "https://www.mvideo.ru/p/1"},
    }, headers=auth_headers)

    from app.models.notification import Notification
    rows = db_session.query(Notification).filter_by(kind="price_offer").all()
    assert len(rows) == 1
    assert rows[0].chat_id == 12345
```

- [ ] **Step 7: Прогон**

Run: `cd backend && python -m pytest tests/test_leads_price_offer.py -v && python -m pytest -q`
Expected: всё зелёное.

- [ ] **Step 8: Коммит**

```bash
git add backend/app/core/config.py backend/app/services/notification_templates.py backend/app/api/leads.py backend/tests/test_leads_price_offer.py
git commit -m "feat(заявки): владельцу падает уведомление о заявке «нашёл дешевле»"
```

---

## Task 4: Экран «Предложить цену» в мини-аппе

**Files:**
- Create: `frontend/src/lib/priceOffer.ts`
- Create: `frontend/src/lib/priceOffer.test.ts`
- Create: `frontend/src/components/PriceOfferSheet.tsx`
- Modify: `frontend/src/pages/ProductDetails.tsx`
- Modify: `frontend/src/lib/leads.ts` (подписи)

- [ ] **Step 1: Тест клиентской проверки ссылки**

Create `frontend/src/lib/priceOffer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validateOfferUrl } from "./priceOffer";

describe("validateOfferUrl", () => {
  it("принимает обычную ссылку", () => {
    expect(validateOfferUrl("https://www.mvideo.ru/p/1")).toBeNull();
  });

  it("принимает адрес без схемы — его теряют при копировании", () => {
    expect(validateOfferUrl("ozon.ru/product/1")).toBeNull();
  });

  it("отвергает пустое", () => {
    expect(validateOfferUrl("  ")).toBeTruthy();
  });

  it("отвергает текст без домена", () => {
    expect(validateOfferUrl("дешевле в соседнем магазине")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd frontend && npx vitest run src/lib/priceOffer.test.ts`
Expected: FAIL — модуля нет.

- [ ] **Step 3: Реализовать**

Create `frontend/src/lib/priceOffer.ts`:

```ts
/** Проверка ссылки на товар у конкурента — зеркало серверной проверки.
 *
 *  Клиентская нужна не вместо серверной, а чтобы человек узнал об ошибке
 *  сразу, не отправляя форму. Правду по-прежнему говорит сервер.
 */
export function validateOfferUrl(raw: string): string | null {
  const text = (raw || "").trim();
  if (!text) return "Вставьте ссылку на товар";
  if (text.length > 2048) return "Ссылка слишком длинная";

  const withScheme = text.includes("://") ? text : `https://${text}`;
  let host = "";
  try {
    host = new URL(withScheme).hostname.toLowerCase();
  } catch {
    return "Не похоже на ссылку";
  }
  if (!host.includes(".")) return "Не похоже на адрес магазина";
  if (host.endsWith("sslip.io")) return "Это ссылка на наш же магазин";
  return null;
}

export type PriceOfferBody = {
  lead_type: "price_offer";
  source: "product";
  product_id: number;
  metadata: { competitor_url: string; origin: string; comment?: string };
};

export function buildPriceOfferBody(
  productId: number, url: string, comment?: string,
): PriceOfferBody {
  return {
    lead_type: "price_offer",
    source: "product",
    product_id: productId,
    metadata: {
      competitor_url: url.trim(),
      origin: "product_price_offer",
      ...(comment?.trim() ? { comment: comment.trim() } : {}),
    },
  };
}
```

- [ ] **Step 4: Тесты проходят**

Run: `cd frontend && npx vitest run src/lib/priceOffer.test.ts`
Expected: 4 passed

- [ ] **Step 5: Компонент шторки**

Create `frontend/src/components/PriceOfferSheet.tsx`. Требования к поведению:

- поле для ссылки (`inputMode="url"`, `autoCapitalize="off"`), необязательный комментарий;
- кнопка «Отправить» заблокирована, пока `validateOfferUrl` возвращает ошибку;
- после успеха — состояние «принято»: галочка и текст «Запрос принят. Менеджер сверит цену и напишет вам в Telegram»;
- анимация подтверждения делается **кадрами через `lib/motion.ts`**, а не CSS-анимацией. Причина в шапке `lib/motion.ts`: на части устройств система гасит всю декларативную анимацию разом, а у владельца проекта «уменьшить движение» включено постоянно — CSS-вариант не сыграл бы именно у него;
- под «уменьшить движение» подтверждение появляется без движения, но появляется — событие убирать нельзя;
- шторка закрывается по `Esc` и по тапу вне, фокус возвращается на кнопку.

Стиль шторки повтори с `ScenarioSheet.tsx` — там уже решены фокус-ловушка, `sheet-in`/`sheet-out` и блокировка прокрутки фона.

- [ ] **Step 6: Кнопка в карточке товара**

В `frontend/src/pages/ProductDetails.tsx` рядом с «Добавить в корзину» добавить вторичную кнопку «Нашли дешевле?». Не делай её акцентной — основной сценарий всё-таки покупка.

- [ ] **Step 7: Подписи в разделе «Заявки»**

В `frontend/src/lib/leads.ts`:

```ts
export const LEAD_TYPE_LABEL: Record<string, string> = {
  // …существующие…
  price_offer: "Нашли дешевле",
};
```

и в `KEY_LABELS`:

```ts
  competitor_url: "Ссылка у конкурента",
  competitor_shop: "Площадка",
  comment: "Комментарий",
```

- [ ] **Step 8: Проверки фронта**

Run: `cd frontend && npx tsc --noEmit && npx vitest run && npm run build`
Expected: всё зелёное.

- [ ] **Step 9: Проверить живьём**

```bash
docker compose -f docker-compose.demo.yml restart frontend
```

Открой товар, нажми «Нашли дешевле?», вставь `ozon.ru/product/1`, отправь. Убедись: подтверждение показано, заявка появилась в `/requests`.

Проверь и под «уменьшить движение» — включи эмуляцию в браузере: подтверждение обязано появляться.

- [ ] **Step 10: Коммит**

```bash
git add frontend/src
git commit -m "feat(витрина): «нашли дешевле» — ссылка на конкурента с карточки товара"
```

---

## Task 5: Развёртывание

- [ ] **Step 1: Узнать chat_id владельца**

Напиши боту `@<BOT_USERNAME>` любое сообщение, затем:

```bash
ssh iseller "cd /opt/techshop && docker compose -f docker-compose.prod.yml logs bot --tail 50 | grep -i 'chat\|from'"
```

Либо добавь временную команду `/whoami`. **chat_id не пиши в чат** — он попадёт в переписку; сразу вставляй в `.env` на сервере.

- [ ] **Step 2: Добавить переменную на прод**

Серверный `.env` деплой не перезаписывает — новые переменные добавляются вручную:

```bash
ssh iseller "cd /opt/techshop && grep -q '^ADMIN_TELEGRAM_ID=' .env || echo 'ADMIN_TELEGRAM_ID=' >> .env"
```

Затем вписать значение редактором на сервере.

- [ ] **Step 3: Деплой**

```bash
bash update-server.sh
```

Убедись перед запуском, что рабочее дерево чистое: деплой синхронизирует его целиком, включая незакоммиченное.

- [ ] **Step 4: Проверка end-to-end**

С телефона: открой мини-апп, отправь ссылку. Ожидается сообщение в Telegram владельцу и строка в админке «Заявки» с типом «Нашли дешевле».

- [ ] **Step 5: Убедиться, что бот жив**

```bash
ssh iseller "cd /opt/techshop && docker compose -f docker-compose.prod.yml logs bot --tail 20"
```
Expected: `уведомления: {'sent': 1, 'failed': 0, ...}`

---

## Definition of done

- [ ] `cd backend && python -m pytest -q` и `cd frontend && npx vitest run` — зелёные
- [ ] Ссылка с телефона доходит до владельца в Telegram за секунды
- [ ] Кривая ссылка отвергается с понятным текстом, а не молча
- [ ] Заявка видна в админке с площадкой и ссылкой
- [ ] Подтверждение показывается и при включённом «уменьшить движение»
