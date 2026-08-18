# Lead Cancellation + Manager Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user cancel their own lead from «Мои заявки», and make the manager get a Telegram alert both when a lead is cancelled by the user and when any regular lead is created (currently silent for everything except `price_offer`/`sell_item`).

**Architecture:** Reuse the existing `status="cancelled"` value and the existing outbox (`enqueue()` + `Notification` table + `bot` service `drain()`) — no new tables, no new statuses. A narrow `POST /leads/{id}/cancel` endpoint (not a general PATCH) is the only new way for a user to change their own lead's status. Two new notification code paths call the same shared `admin_chat_id()` helper and two new pure-function templates.

**Tech Stack:** FastAPI + SQLAlchemy (backend), React + TypeScript + Tailwind (frontend), pytest, vitest.

## Global Constraints

- Design doc: `docs/superpowers/specs/2026-08-18-lead-cancellation-design.md` — read it before starting, this plan implements it.
- No `alert()`/`confirm()` anywhere in the frontend — use inline UI state instead (project-wide rule already followed by `Cart.tsx`/`LeadForm.tsx`).
- `enqueue()` never commits — the caller commits. When a function calls `enqueue()` in a transaction that has ALREADY committed elsewhere (cart checkout), it must do its own `try/except` + `db.commit()`, exactly like `_track()` in `api/cart.py`.
- Backend checklist before calling any task done: `cd backend && python -m pytest -q`.
- Frontend checklist before calling any task done: `cd frontend && npx tsc --noEmit && npx vitest run`.
- After all backend+frontend tasks: `cd frontend && npm run build`, then manually verify the cancel button in the browser (dev stand `docker-compose.demo.yml`, restart `frontend` container after every source edit — Vite doesn't see bind-mount changes, see project CLAUDE.md).

---

### Task 1: `admin_chat_id()` shared helper + refactor existing call sites

**Files:**
- Modify: `backend/app/services/notifications.py` (add function, near `notifications_enabled()`)
- Modify: `backend/app/api/leads.py:82-113` (`_notify_owner`, `_notify_sell_item`)

**Interfaces:**
- Produces: `admin_chat_id() -> int | None` in `app.services.notifications` — resolves `settings.ADMIN_TELEGRAM_ID` to an `int`, or `None` if unset/unparsable (logs a warning in the unparsable case). Tasks 3, 4, 5 all import and use this.

This is a pure refactor (no new behavior) — the two existing call sites duplicate the exact same `try: int(...) except (TypeError, ValueError)` block. It's being extracted now because tasks 3-5 add three more call sites of the identical pattern.

- [ ] **Step 1: Run the existing notify tests to establish a baseline (must pass before touching anything)**

Run: `cd backend && python -m pytest tests/test_leads_price_offer.py::test_enqueues_owner_notification tests/test_leads_price_offer.py::test_no_owner_chat_means_no_notification tests/test_leads_sell_item.py::test_sell_item_notifies_admin -v`
Expected: 3 passed

- [ ] **Step 2: Add `admin_chat_id()` to `services/notifications.py`**

Add right after `notifications_enabled()` (end of file):

```python
def admin_chat_id() -> int | None:
    """chat_id менеджера из настроек, либо None — писать некому.

    Общий для всех мест, что шлют алерт МЕНЕДЖЕРУ (не автору заявки):
    price_offer/sell_item/новая заявка/отмена пользователем. Раньше это же
    преобразование (str -> int с try/except) дублировалось в каждом вызывающем
    месте по отдельности — см. историю app/api/leads.py.
    """
    if not settings.ADMIN_TELEGRAM_ID:
        return None
    try:
        return int(settings.ADMIN_TELEGRAM_ID)
    except (TypeError, ValueError):
        logger.warning("ADMIN_TELEGRAM_ID не число — уведомление менеджеру пропущено")
        return None
```

`settings` and `logger` are already imported/defined at the top of this file (`from app.core.config import settings`, `logger = logging.getLogger("techshop.notifications")`) — no new imports needed here.

- [ ] **Step 3: Refactor `_notify_owner` and `_notify_sell_item` in `leads.py` to use it**

In `backend/app/api/leads.py`, replace:

```python
def _notify_owner(db: Session, lead: Lead, meta: dict) -> None:
    """Поставить владельцу уведомление о заявке «нашли дешевле».

    Сети здесь нет и быть не должно: покупатель нажал «Отправить», и его запрос
    не имеет права ждать Telegram — тем более падать вместе с ним. Строка уходит
    в ту же транзакцию, что и заявка.
    """
    if not settings.ADMIN_TELEGRAM_ID:
        return
    from app.services.notification_templates import price_offer_message
    from app.services.notifications import enqueue

    try:
        chat_id = int(settings.ADMIN_TELEGRAM_ID)
    except (TypeError, ValueError):
        logger.warning("ADMIN_TELEGRAM_ID не число — уведомление владельцу пропущено")
        return

    enqueue(
        db,
        chat_id=chat_id,
        kind="price_offer",
        message=price_offer_message(
            product_title=lead.product_title or "товар",
            our_price=float(lead.product_price) if lead.product_price is not None else None,
            competitor_price=meta.get("competitor_price"),
            competitor_url=meta["competitor_url"],
            competitor_shop=meta["competitor_shop"],
            username=lead.username,
        ),
        dedupe_key=f"price_offer:{lead.id}",
    )
```

with:

```python
def _notify_owner(db: Session, lead: Lead, meta: dict) -> None:
    """Поставить владельцу уведомление о заявке «нашли дешевле».

    Сети здесь нет и быть не должно: покупатель нажал «Отправить», и его запрос
    не имеет права ждать Telegram — тем более падать вместе с ним. Строка уходит
    в ту же транзакцию, что и заявка.
    """
    from app.services.notification_templates import price_offer_message
    from app.services.notifications import admin_chat_id, enqueue

    chat_id = admin_chat_id()
    if chat_id is None:
        return

    enqueue(
        db,
        chat_id=chat_id,
        kind="price_offer",
        message=price_offer_message(
            product_title=lead.product_title or "товар",
            our_price=float(lead.product_price) if lead.product_price is not None else None,
            competitor_price=meta.get("competitor_price"),
            competitor_url=meta["competitor_url"],
            competitor_shop=meta["competitor_shop"],
            username=lead.username,
        ),
        dedupe_key=f"price_offer:{lead.id}",
    )
```

Do the same transformation in `_notify_sell_item` — replace:

```python
def _notify_sell_item(db: Session, lead: Lead, meta: dict) -> None:
    """Алерт модератору о новой заявке «Предложить товар» — та же схема, что
    _notify_owner для price_offer: без сети, той же транзакцией."""
    if not settings.ADMIN_TELEGRAM_ID:
        return
    from app.services.notification_templates import sell_item_message
    from app.services.notifications import enqueue

    try:
        chat_id = int(settings.ADMIN_TELEGRAM_ID)
    except (TypeError, ValueError):
        logger.warning("ADMIN_TELEGRAM_ID не число — уведомление о sell_item пропущено")
        return

    enqueue(
        db, chat_id=chat_id, kind="sell_item",
        message=sell_item_message(
            title=str(meta.get("title") or "товар"),
            price_wanted=_safe_price(meta.get("price_wanted")),
            phone=lead.phone, username=lead.username,
        ),
        dedupe_key=f"sell_item:{lead.id}",
    )
```

with:

```python
def _notify_sell_item(db: Session, lead: Lead, meta: dict) -> None:
    """Алерт модератору о новой заявке «Предложить товар» — та же схема, что
    _notify_owner для price_offer: без сети, той же транзакцией."""
    from app.services.notification_templates import sell_item_message
    from app.services.notifications import admin_chat_id, enqueue

    chat_id = admin_chat_id()
    if chat_id is None:
        return

    enqueue(
        db, chat_id=chat_id, kind="sell_item",
        message=sell_item_message(
            title=str(meta.get("title") or "товар"),
            price_wanted=_safe_price(meta.get("price_wanted")),
            phone=lead.phone, username=lead.username,
        ),
        dedupe_key=f"sell_item:{lead.id}",
    )
```

- [ ] **Step 4: Re-run the same tests to confirm behavior is unchanged**

Run: `cd backend && python -m pytest tests/test_leads_price_offer.py::test_enqueues_owner_notification tests/test_leads_price_offer.py::test_no_owner_chat_means_no_notification tests/test_leads_sell_item.py::test_sell_item_notifies_admin -v`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/notifications.py backend/app/api/leads.py
git commit -m "refactor(заявки): admin_chat_id() — общий резолвер chat_id менеджера"
```

---

### Task 2: New notification templates — `new_lead_message` + `lead_cancelled_by_user_message`

**Files:**
- Modify: `backend/app/services/notification_templates.py` (add two functions, after `sell_item_message`)
- Modify: `backend/tests/test_notifications.py` (add tests in the "Тексты (без сети и БД)" section)

**Interfaces:**
- Produces:
  - `new_lead_message(*, public_number: str, items_count: int = 0, estimated_total: float | None = None, currency: str = "RUB", product_title: str | None = None, lead_type: str | None = None, username: str | None = None, phone: str | None = None, message: str | None = None) -> Message`
  - `lead_cancelled_by_user_message(*, public_number: str, items_count: int = 0, estimated_total: float | None = None, currency: str = "RUB", product_title: str | None = None, username: str | None = None) -> Message`

  Both always return a `Message` (never `None` — unlike `lead_status_message`, there's no "silent" case here). Tasks 4 and 5 call `new_lead_message`; Task 3 calls `lead_cancelled_by_user_message`.
- Consumes: `Message`, `format_money`, `plural_items`, `_esc` — all already defined in this file, used the same way `lead_status_message` uses them.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_notifications.py`, in the imports block, add `new_lead_message` and `lead_cancelled_by_user_message` to the existing `from app.services.notification_templates import (...)` list (keep it alphabetically sorted like the rest):

```python
from app.services.notification_templates import (
    favorite_message,
    Message,
    cart_reminder_message,
    format_money,
    lead_cancelled_by_user_message,
    lead_status_message,
    new_lead_message,
    plural_items,
)
```

Add these tests after `test_status_message_drops_buttons_when_mini_app_not_configured` (still inside the "Тексты (без сети и БД)" section):

```python
def test_new_lead_message_uses_cart_composition():
    msg = new_lead_message(
        public_number="№12", items_count=3, estimated_total=145000, currency="RUB",
        username="garik", phone="+79990000000",
    )
    assert "№12" in msg.text
    assert "3 товара" in msg.text
    assert "145 000 ₽" in msg.text
    assert "garik" in msg.text
    assert "+79990000000" in msg.text


def test_new_lead_message_uses_product_title_for_single_lead():
    msg = new_lead_message(public_number="№7", product_title="Dyson HD16", username=None)
    assert "Dyson HD16" in msg.text
    assert "покупатель" in msg.text  # без username подписываемся обезличенно


def test_new_lead_message_tags_scenario_types():
    trade_in = new_lead_message(public_number="№1", lead_type="trade_in")
    general = new_lead_message(public_number="№2", lead_type="general")
    assert "Trade-In" in trade_in.text
    assert "Trade-In" not in general.text


def test_new_lead_message_includes_trimmed_comment():
    long_comment = "текст " * 60  # заведомо длиннее 200 символов
    msg = new_lead_message(public_number="№1", message=long_comment)
    assert len(msg.text) < len(long_comment) + 200  # обрезан, а не вставлен целиком
    assert "…" in msg.text


def test_lead_cancelled_by_user_message_mentions_who_and_what():
    msg = lead_cancelled_by_user_message(
        public_number="№9", product_title="iPhone 13 Pro", username="nastya",
    )
    assert "№9" in msg.text
    assert "iPhone 13 Pro" in msg.text
    assert "nastya" in msg.text
    assert "отменил" in msg.text.lower()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_notifications.py -k "new_lead_message or lead_cancelled_by_user_message" -v`
Expected: FAIL with `ImportError: cannot import name 'new_lead_message'`

- [ ] **Step 3: Implement both templates**

Add to `backend/app/services/notification_templates.py`, right after `sell_item_message` (before the `# ========================= Брошенная корзина =========================` section):

```python
#: Заголовок получает тег сценария — Trade-In/опт/бизнес читаются иначе, чем
#: обычный заказ, и менеджеру полезно видеть это раньше, чем состав заявки.
_LEAD_TYPE_TAG: dict[str, str] = {
    "trade_in": "Trade-In",
    "b2b": "Для бизнеса",
    "wholesale": "Опт",
}

#: Длиннее — не влезет в превью уведомления, и суть комментария всё равно
#: видна по первым символам; полный текст менеджер откроет в самой заявке.
_MESSAGE_PREVIEW_LIMIT = 200


def _lead_composition(*, items_count: int, estimated_total, currency: str, product_title) -> str | None:
    """Строка состава — общая для нового шаблона и для lead_status_message:
    количество позиций + предварительная сумма для заявки-корзины, либо
    название товара для одиночной. None — состав неизвестен (заявка без
    товара и без позиций, например Trade-In без выбранной модели)."""
    if items_count and items_count > 0:
        line = plural_items(items_count)
        if estimated_total is not None:
            line += f" · {format_money(estimated_total, currency)}"
        return line
    if product_title:
        return _esc(product_title)
    return None


# ==================== Новая заявка — менеджеру ====================
def new_lead_message(
    *, public_number: str, items_count: int = 0, estimated_total: float | None = None,
    currency: str = "RUB", product_title: str | None = None, lead_type: str | None = None,
    username: str | None = None, phone: str | None = None, message: str | None = None,
) -> Message:
    """Алерт менеджеру о новой заявке — для типов, у которых нет своего более
    специфичного уведомления (price_offer/sell_item оповещают отдельно, до
    этой ветки в вызывающем коде)."""
    tag = _LEAD_TYPE_TAG.get(lead_type or "")
    headline = f"🆕 <b>Новая заявка{': ' + tag if tag else ''}</b>"
    lines = [headline, "", f"Заявка {public_number}"]

    composition = _lead_composition(
        items_count=items_count, estimated_total=estimated_total,
        currency=currency, product_title=product_title,
    )
    if composition:
        lines.append(composition)

    who = f"@{username}" if username else "покупатель"
    contact = who + (f", {_esc(phone)}" if phone else "")
    lines += ["", f"От: {contact}"]

    if message:
        trimmed = message if len(message) <= _MESSAGE_PREVIEW_LIMIT else message[:_MESSAGE_PREVIEW_LIMIT] + "…"
        lines += ["", _esc(trimmed)]

    lines += ["", "Смотрите в «Заявках» админки."]
    return Message("\n".join(lines))


# ================ Отмена заявки покупателем — менеджеру ================
def lead_cancelled_by_user_message(
    *, public_number: str, items_count: int = 0, estimated_total: float | None = None,
    currency: str = "RUB", product_title: str | None = None, username: str | None = None,
) -> Message:
    """Симметрично lead_status_message(status='cancelled'), которое уходит
    ПОКУПАТЕЛЮ при отмене менеджером: здесь наоборот — покупатель отменил сам,
    уведомляем менеджера."""
    lines = ["❌ <b>Покупатель отменил заявку</b>", "", f"Заявка {public_number}"]

    composition = _lead_composition(
        items_count=items_count, estimated_total=estimated_total,
        currency=currency, product_title=product_title,
    )
    if composition:
        lines.append(composition)

    who = f"@{username}" if username else "покупатель"
    lines += ["", f"От: {who}"]
    return Message("\n".join(lines))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_notifications.py -v`
Expected: all pass (existing + 5 new)

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/notification_templates.py backend/tests/test_notifications.py
git commit -m "feat(заявки): шаблоны уведомлений менеджеру — новая заявка / отмена пользователем"
```

---

### Task 3: `POST /leads/{lead_id}/cancel` — user cancels their own lead

**Files:**
- Modify: `backend/app/api/leads.py` (imports + new endpoint + new `_notify_cancelled_by_user`)
- Create: `backend/tests/test_leads_cancel.py`

**Interfaces:**
- Consumes: `admin_chat_id()` (Task 1), `lead_cancelled_by_user_message()` (Task 2), `AuditLog` model (`app.models.audit`, fields `actor: str`, `action: str`, `detail: str | None`).
- Produces: `POST /api/leads/{lead_id}/cancel` — 201 is wrong, this returns 200 with the updated lead dict (`lead.to_dict()`, same shape as `POST /leads` response). Task 7 (frontend) calls this exact path.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_leads_cancel.py`:

```python
"""Пользователь отменяет свою заявку — см.
docs/superpowers/specs/2026-08-18-lead-cancellation-design.md."""
import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_user
from app.db.session import get_db
from app.main import app
from app.models.audit import AuditLog
from app.models.lead import Lead
from app.models.notification import Notification
from app.models.user import User


@pytest.fixture()
def ctx(db):
    owner = User(telegram_id=701, first_name="Настя", username="nastya")
    stranger = User(telegram_id=702, first_name="Чужой", username="stranger")
    db.add_all([owner, stranger])
    db.commit()
    db.refresh(owner)
    db.refresh(stranger)
    holder = {"uid": owner.id}

    def override_db():
        yield db

    def override_user():
        return db.get(User, holder["uid"])

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_user
    try:
        yield TestClient(app), db, holder, owner, stranger
    finally:
        app.dependency_overrides.clear()


def make_lead(db, user, **kw) -> Lead:
    defaults = dict(
        user_id=user.id, telegram_id=user.telegram_id, username=user.username,
        status="new", source="home", product_title="iPhone 17 Pro",
    )
    defaults.update(kw)
    lead = Lead(**defaults)
    db.add(lead)
    db.commit()
    db.refresh(lead)
    return lead


def test_owner_can_cancel_new_lead(ctx):
    client, db, _holder, owner, _stranger = ctx
    lead = make_lead(db, owner, status="new")

    r = client.post(f"/api/leads/{lead.id}/cancel")
    assert r.status_code == 200
    assert r.json()["status"] == "cancelled"
    db.refresh(lead)
    assert lead.status == "cancelled"


@pytest.mark.parametrize("status", ["contacted", "confirming", "confirmed", "in_progress", "reserved"])
def test_owner_can_cancel_any_non_final_status(ctx, status):
    client, db, _holder, owner, _stranger = ctx
    lead = make_lead(db, owner, status=status)

    r = client.post(f"/api/leads/{lead.id}/cancel")
    assert r.status_code == 200
    assert r.json()["status"] == "cancelled"


@pytest.mark.parametrize("status", ["completed", "cancelled"])
def test_cannot_cancel_final_status(ctx, status):
    client, db, _holder, owner, _stranger = ctx
    lead = make_lead(db, owner, status=status)

    r = client.post(f"/api/leads/{lead.id}/cancel")
    assert r.status_code == 400
    db.refresh(lead)
    assert lead.status == status  # не тронут


def test_stranger_cannot_cancel_someone_elses_lead(ctx):
    client, db, holder, owner, stranger = ctx
    lead = make_lead(db, owner, status="new")
    holder["uid"] = stranger.id

    r = client.post(f"/api/leads/{lead.id}/cancel")
    assert r.status_code == 404
    db.refresh(lead)
    assert lead.status == "new"  # не тронут


def test_cancel_nonexistent_lead_is_404(ctx):
    client, *_ = ctx
    r = client.post("/api/leads/999999/cancel")
    assert r.status_code == 404


def test_cancel_writes_audit_log_with_user_actor(ctx):
    client, db, _holder, owner, _stranger = ctx
    lead = make_lead(db, owner, status="new")

    client.post(f"/api/leads/{lead.id}/cancel")

    row = db.query(AuditLog).filter_by(action="lead_status_changed").first()
    assert row is not None
    assert row.actor == f"user:{owner.id}"
    assert row.detail == f"lead={lead.id};from=new;to=cancelled"


def test_cancel_notifies_manager(ctx, monkeypatch):
    client, db, _holder, owner, _stranger = ctx
    monkeypatch.setattr("app.core.config.settings.ADMIN_TELEGRAM_ID", "999")
    lead = make_lead(db, owner, status="new", product_title="iPhone 13 Pro")

    client.post(f"/api/leads/{lead.id}/cancel")

    notif = db.query(Notification).filter_by(kind="lead_cancelled").first()
    assert notif is not None
    assert "iPhone 13 Pro" in notif.text
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_leads_cancel.py -v`
Expected: FAIL with 404/405 (route doesn't exist yet)

- [ ] **Step 3: Implement the endpoint**

In `backend/app/api/leads.py`, add to the imports at the top:

```python
from app.models.audit import AuditLog
```

Add the new endpoint right after `my_leads()` (before `upload_marketplace_photo`):

```python
@router.post("/{lead_id}/cancel")
def cancel_lead(
    lead_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db),
):
    """Пользователь отменяет СВОЮ заявку. Разрешено с любого статуса, кроме
    двух финальных (completed/cancelled) — менеджер мог уже взять заявку в
    работу, но пока сделка не закрыта, отмена всё равно доступна."""
    lead = db.get(Lead, lead_id)
    if lead is None or lead.user_id != user.id:
        # 404, а не 403: не подтверждаем существование чужой заявки различием кодов.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Lead not found")
    if lead.status in ("completed", "cancelled"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Заявку в этом статусе отменить нельзя")

    previous = lead.status
    lead.status = "cancelled"
    db.add(AuditLog(
        actor=f"user:{user.id}",
        action="lead_status_changed",
        detail=f"lead={lead_id};from={previous};to=cancelled",
    ))
    _notify_cancelled_by_user(db, lead)
    db.commit()
    db.refresh(lead)
    return lead.to_dict()
```

Add the notify helper right after `_notify_sell_item` (before `@router.post("", ...)` / `create_lead`):

```python
def _notify_cancelled_by_user(db: Session, lead: Lead) -> None:
    """Алерт менеджеру: покупатель сам отменил заявку — симметрично тому, как
    менеджер, меняя статус, уведомляет покупателя (_notify_status_change в
    admin_crm.py). Владельца о его же действии повторно НЕ уведомляем: он
    только что увидел результат на экране, а _STATUS_TEXTS["cancelled"] в
    lead_status_message продолжает срабатывать только при отмене АДМИНОМ."""
    from app.services.notification_templates import lead_cancelled_by_user_message
    from app.services.notifications import admin_chat_id, enqueue

    chat_id = admin_chat_id()
    if chat_id is None:
        return

    enqueue(
        db, chat_id=chat_id, kind="lead_cancelled",
        message=lead_cancelled_by_user_message(
            public_number=lead.public_number,
            items_count=lead.items_count or 0,
            estimated_total=float(lead.estimated_total) if lead.estimated_total is not None else None,
            currency=lead.currency or "RUB",
            product_title=lead.product_title,
            username=lead.username,
        ),
        dedupe_key=f"lead:{lead.id}:cancelled_by_user",
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_leads_cancel.py -v`
Expected: all pass

- [ ] **Step 5: Run the full backend suite (this touches a shared file, `leads.py`)**

Run: `cd backend && python -m pytest -q`
Expected: all pass, no regressions

- [ ] **Step 6: Commit**

```bash
git add backend/app/api/leads.py backend/tests/test_leads_cancel.py
git commit -m "feat(заявки): POST /leads/{id}/cancel — пользователь отменяет свою заявку"
```

---

### Task 4: Notify manager on creation of regular leads (`create_lead()` else-branch)

**Files:**
- Modify: `backend/app/api/leads.py` (`create_lead()` branch chain + new `_notify_new_lead`)
- Create: `backend/tests/test_leads_notify_manager.py`

**Interfaces:**
- Consumes: `admin_chat_id()` (Task 1), `new_lead_message()` (Task 2).
- Produces: nothing new consumed by later tasks — this is a leaf.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_leads_notify_manager.py`:

```python
"""Менеджер получает Telegram-алерт о ЛЮБОЙ новой заявке, не только
price_offer/sell_item — см.
docs/superpowers/specs/2026-08-18-lead-cancellation-design.md."""
import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_user
from app.db.session import get_db
from app.main import app
from app.models.notification import Notification
from app.models.user import User


@pytest.fixture()
def ctx(db):
    user = User(telegram_id=801, first_name="Гарик", username="garik")
    db.add(user)
    db.commit()
    db.refresh(user)

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: db.get(User, user.id)
    try:
        yield TestClient(app), db, user
    finally:
        app.dependency_overrides.clear()


def test_general_lead_notifies_manager(ctx, monkeypatch):
    client, db, _u = ctx
    monkeypatch.setattr("app.core.config.settings.ADMIN_TELEGRAM_ID", "999")
    r = client.post("/api/leads", json={
        "source": "product", "product_title": "Dyson HD16", "phone": "+79990000005",
    })
    assert r.status_code == 201

    notif = db.query(Notification).filter_by(kind="new_lead").first()
    assert notif is not None
    assert "Dyson HD16" in notif.text


def test_trade_in_lead_notification_is_tagged(ctx, monkeypatch):
    client, db, _u = ctx
    monkeypatch.setattr("app.core.config.settings.ADMIN_TELEGRAM_ID", "999")
    r = client.post("/api/leads", json={
        "source": "home", "lead_type": "trade_in", "message": "Меняю на новый",
    })
    assert r.status_code == 201

    notif = db.query(Notification).filter_by(kind="new_lead").first()
    assert notif is not None
    assert "Trade-In" in notif.text


def test_price_offer_lead_does_not_get_generic_notification(ctx, monkeypatch):
    """price_offer уже шлёт своё специфичное уведомление (_notify_owner) —
    второе, общее, было бы дублем ни о чём не говорящим менеджеру больше."""
    client, db, _u = ctx
    monkeypatch.setattr("app.core.config.settings.ADMIN_TELEGRAM_ID", "999")
    r = client.post("/api/leads", json={
        "source": "product", "product_id": None, "lead_type": "price_offer",
        "metadata": {"competitor_url": "https://market.yandex.ru/product/123", "competitor_price": 90000},
    })
    assert r.status_code == 201
    assert db.query(Notification).filter_by(kind="new_lead").count() == 0
    assert db.query(Notification).filter_by(kind="price_offer").count() == 1


def test_no_admin_chat_id_means_no_notification(ctx, monkeypatch):
    client, db, _u = ctx
    monkeypatch.setattr("app.core.config.settings.ADMIN_TELEGRAM_ID", "")
    r = client.post("/api/leads", json={"source": "product", "product_title": "Что-то"})
    assert r.status_code == 201
    assert db.query(Notification).filter_by(kind="new_lead").count() == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_leads_notify_manager.py -v`
Expected: FAIL — `test_general_lead_notifies_manager` and `test_trade_in_lead_notification_is_tagged` fail (no `new_lead` notification created yet); the other two already pass by construction.

- [ ] **Step 3: Add the `else` branch and `_notify_new_lead`**

In `backend/app/api/leads.py`, add the helper right after `_notify_sell_item` (or right after `_notify_cancelled_by_user` if Task 3 already landed — order between the two doesn't matter, just keep all `_notify_*` helpers grouped before `create_lead`):

```python
def _notify_new_lead(db: Session, lead: Lead) -> None:
    """Алерт менеджеру о новой заявке — для типов без своего специфичного
    уведомления (price_offer/sell_item оповещают выше, до этой ветки)."""
    from app.services.notification_templates import new_lead_message
    from app.services.notifications import admin_chat_id, enqueue

    chat_id = admin_chat_id()
    if chat_id is None:
        return

    enqueue(
        db, chat_id=chat_id, kind="new_lead",
        message=new_lead_message(
            public_number=lead.public_number,
            items_count=lead.items_count or 0,
            estimated_total=float(lead.estimated_total) if lead.estimated_total is not None else None,
            currency=lead.currency or "RUB",
            product_title=lead.product_title,
            lead_type=lead.lead_type,
            username=lead.username,
            phone=lead.phone,
            message=lead.message,
        ),
        dedupe_key=f"lead:{lead.id}:created",
    )
```

In `create_lead()`, change:

```python
    db.add(lead)
    if lead_type == PRICE_OFFER_TYPE:
        # flush, а не commit: id нужен для ключа дедупликации, но уведомление
        # обязано уехать ТОЙ ЖЕ транзакцией, что и заявка. Иначе владелец
        # получит ссылку на заявку, которой в базе не окажется.
        db.flush()
        _notify_owner(db, lead, meta)
    elif lead_type == "sell_item":
        db.flush()
        _notify_sell_item(db, lead, meta)
    db.commit()
    db.refresh(lead)
```

to:

```python
    db.add(lead)
    if lead_type == PRICE_OFFER_TYPE:
        # flush, а не commit: id нужен для ключа дедупликации, но уведомление
        # обязано уехать ТОЙ ЖЕ транзакцией, что и заявка. Иначе владелец
        # получит ссылку на заявку, которой в базе не окажется. Та же причина
        # flush (не commit) верна и для двух веток ниже — id лида нужен всем
        # dedupe_key.
        db.flush()
        _notify_owner(db, lead, meta)
    elif lead_type == "sell_item":
        db.flush()
        _notify_sell_item(db, lead, meta)
    else:
        db.flush()
        _notify_new_lead(db, lead)
    db.commit()
    db.refresh(lead)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_leads_notify_manager.py -v`
Expected: all pass

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && python -m pytest -q`
Expected: all pass — pay special attention to `tests/test_leads_scenario.py` (Trade-In/B2B/wholesale creation) and `tests/test_cart_reminders.py`/`test_admin_cart_orders.py`, since they also call `POST /leads` for non-price_offer/sell_item types and might assert on `Notification` counts.

- [ ] **Step 6: Commit**

```bash
git add backend/app/api/leads.py backend/tests/test_leads_notify_manager.py
git commit -m "feat(заявки): менеджер получает алерт о любой новой одиночной заявке"
```

---

### Task 5: Notify manager on cart checkout

**Files:**
- Modify: `backend/app/api/cart.py` (`checkout()` + new `_notify_new_cart_lead`)
- Modify: `backend/tests/test_cart.py` (add tests near the other `checkout` tests)

**Interfaces:**
- Consumes: `admin_chat_id()` (Task 1), `new_lead_message()` (Task 2).

Cart leads do NOT go through `create_lead()` in `leads.py` — `cart_service.checkout()` (`backend/app/services/cart.py`) creates and commits the lead itself before returning `(lead, created)`. That means the notification here cannot ride the same transaction as lead creation (it's already committed) — it needs its own `try/except` + `db.commit()`, exactly like the existing `_track()` helper right below it in the same file.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_cart.py`, near `test_checkout_creates_one_lead_with_all_items` (add the import for `Notification` to the top-of-file import block first):

```python
from app.models.notification import Notification
```

```python
def test_checkout_notifies_manager(ctx, monkeypatch):
    client, db, *_ = ctx
    monkeypatch.setattr("app.core.config.settings.ADMIN_TELEGRAM_ID", "999")
    p = make_product(db, title="MacBook Air", price=129990)
    client.post("/api/cart/items", json={"product_id": p.id})

    r = client.post("/api/cart/checkout", json=checkout_body())
    assert r.status_code == 201

    notif = db.query(Notification).filter_by(kind="new_lead").first()
    assert notif is not None
    assert "MacBook Air" in notif.text or "1 товар" in notif.text


def test_repeat_checkout_with_same_idempotency_key_does_not_double_notify(ctx, monkeypatch):
    client, db, *_ = ctx
    monkeypatch.setattr("app.core.config.settings.ADMIN_TELEGRAM_ID", "999")
    p = make_product(db, price=5000)
    client.post("/api/cart/items", json={"product_id": p.id})

    body = checkout_body(idempotency_key="abc123")
    first = client.post("/api/cart/checkout", json=body)
    assert first.json()["created"] is True

    # Вторая корзина того же пользователя, тот же ключ идемпотентности:
    # cart_service.checkout вернёт СУЩЕСТВУЮЩУЮ заявку, created=False.
    client.post("/api/cart/items", json={"product_id": p.id})
    second = client.post("/api/cart/checkout", json=body)
    assert second.json()["created"] is False

    assert db.query(Notification).filter_by(kind="new_lead").count() == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_cart.py -k "notifies_manager or double_notify" -v`
Expected: FAIL — no `new_lead` notification exists yet

- [ ] **Step 3: Implement the hook**

In `backend/app/api/cart.py`, add the helper right after `_track` (bottom of file):

```python
def _notify_new_cart_lead(db: Session, lead) -> None:
    """Алерт менеджеру о заявке из корзины.

    Своя транзакция, а не общая с созданием лида: cart_service.checkout()
    уже закоммитил лида ДО возврата (см. services/cart.py) — enqueue() здесь
    не может ехать той же транзакцией, тем же приёмом, что и _track() выше:
    никогда не роняем оформление заказа из-за сбоя постановки уведомления.
    """
    try:
        from app.services.notification_templates import new_lead_message
        from app.services.notifications import admin_chat_id, enqueue

        chat_id = admin_chat_id()
        if chat_id is None:
            return
        row = enqueue(
            db, chat_id=chat_id, kind="new_lead",
            message=new_lead_message(
                public_number=lead.public_number,
                items_count=lead.items_count or 0,
                estimated_total=float(lead.estimated_total) if lead.estimated_total is not None else None,
                currency=lead.currency or "RUB",
                product_title=lead.product_title,
                lead_type=lead.lead_type,
                username=lead.username,
                phone=lead.phone,
                message=lead.message,
            ),
            dedupe_key=f"lead:{lead.id}:created",
        )
        if row is not None:
            db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.exception("notify new cart lead failed")
```

In the `checkout()` endpoint, inside `if created:` (right before the existing `_track(db, user.id, "checkout_success", ...)` call), add:

```python
    if created:
        _notify_new_cart_lead(db, lead)
        # Аналитика и сигналы рекомендаций — после успешной транзакции и никогда
        # не роняют ответ: заявка уже создана, терять её из-за аналитики нельзя.
        # Payload — только безопасные метаданные (без телефона/имени/комментария).
        _track(db, user.id, "checkout_success", {
```

(the rest of the `if created:` block — the two `_track()` calls and the recommendations `try/except` — stays exactly as it is, only the new line is inserted at the top).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_cart.py -v`
Expected: all pass

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && python -m pytest -q`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add backend/app/api/cart.py backend/tests/test_cart.py
git commit -m "feat(корзина): менеджер получает алерт о заявке из корзины"
```

---

### Task 6: Frontend — cancel button in «Мои заявки»

**Files:**
- Modify: `frontend/src/lib/analytics.ts` (add `"lead_cancelled"` to `AppEvent`)
- Modify: `backend/app/schemas/ai.py` (add `"lead_cancelled"` to `ALLOWED_EVENTS`)
- Modify: `frontend/src/pages/Requests.tsx` (cancel button + inline confirm + handler)

**Interfaces:**
- Consumes: `POST /api/leads/{id}/cancel` (Task 3) — returns the updated lead dict, same shape as the existing `Lead` type already defined in `Requests.tsx`.

No new frontend test file — this codebase has no React component tests (only pure-function tests in `lib/*.test.ts`); verification is `tsc` + `vitest` (regression) + manual browser check (Task 7's own step, since it needs a running dev stand).

- [ ] **Step 1: Register the analytics event on both sides**

In `frontend/src/lib/analytics.ts`, add to the end of the `AppEvent` union (before the closing `;`):

```typescript
  // Маркетплейс б/у товаров: визард «Предложить товар» (/sell) отправил заявку.
  | "sell_item_submitted"
  // «Мои заявки»: пользователь сам отменил свою заявку.
  | "lead_cancelled";
```

In `backend/app/schemas/ai.py`, add to `ALLOWED_EVENTS` (right after `"sell_item_submitted",`):

```python
    # Маркетплейс б/у товаров: визард «Предложить товар» (/sell) отправил заявку.
    "sell_item_submitted",
    # «Мои заявки»: пользователь сам отменил свою заявку.
    "lead_cancelled",
}
```

- [ ] **Step 2: Run backend + frontend regression checks**

Run: `cd backend && python -m pytest -q` (should still pass — `ALLOWED_EVENTS` grew, nothing removed)
Run: `cd frontend && npx tsc --noEmit`
Expected: both clean

- [ ] **Step 3: Add imports and state to `Requests.tsx`**

Change the import block at the top of `frontend/src/pages/Requests.tsx` from:

```typescript
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { track } from "../lib/analytics";
import { formatPrice } from "../lib/format";
import { ErrorState } from "../components/StateViews";
import { leadTitle, leadTypeLabel, leadMetadataRows } from "../lib/leads";
import { Icon } from "../components/icons";
```

to:

```typescript
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { track } from "../lib/analytics";
import { toast } from "../lib/toast";
import { formatPrice } from "../lib/format";
import { ErrorState } from "../components/StateViews";
import { leadTitle, leadTypeLabel, leadMetadataRows } from "../lib/leads";
import { Icon } from "../components/icons";
```

- [ ] **Step 4: Add a `CANCELLABLE` helper next to `STATUS_LABEL`/`STATUS_STYLE`**

Right after the `DELIVERY_LABEL` constant (before `const FILTERS = [...]`), add:

```typescript
/** Статусы, с которых пользователь ещё может отменить заявку сам —
 *  зеркало backend-проверки в POST /leads/{id}/cancel (leads.py). */
function cancellable(status: string): boolean {
  return status !== "completed" && status !== "cancelled";
}
```

- [ ] **Step 5: Add cancel state + handler inside the `Requests` component**

Right after the existing `const [filter, setFilter] = useState("");` line, add:

```typescript
  // Заявка, для которой сейчас показано инлайн-подтверждение отмены —
  // максимум одна за раз, второй тап по другой карточке закрывает первую.
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [cancellingId, setCancellingId] = useState<number | null>(null);
```

Right after the `load` function (before `useEffect(() => { load(); }, []);`), add:

```typescript
  async function cancelLead(id: number) {
    setCancellingId(id);
    try {
      await api(`/leads/${id}/cancel`, { method: "POST" });
      setLeads((prev) => prev && prev.map((l) => (l.id === id ? { ...l, status: "cancelled" } : l)));
      track("lead_cancelled", { lead_id: id });
      setConfirmId(null);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Не удалось отменить заявку", "error");
    } finally {
      setCancellingId(null);
    }
  }
```

- [ ] **Step 6: Render the button/confirm row in the card**

Inside the card `<div key={l.id} className="card-appear ...">`, right after the block that renders `l.manager_comment` and before the closing `№{l.id} · ...` paragraph, add:

```tsx
              {cancellable(l.status) && (
                <div className="mt-3 border-t border-border pt-2.5">
                  {confirmId === l.id ? (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-muted">Точно отменить?</span>
                      <div className="flex gap-2">
                        <button
                          className="tap rounded-full px-3 py-1.5 text-xs font-medium text-muted"
                          onClick={() => setConfirmId(null)}
                        >
                          Нет
                        </button>
                        <button
                          className="tap rounded-full bg-danger px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                          disabled={cancellingId === l.id}
                          onClick={() => cancelLead(l.id)}
                        >
                          {cancellingId === l.id ? "Отменяем…" : "Да, отменить"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      className="tap text-xs font-medium text-danger"
                      onClick={() => setConfirmId(l.id)}
                    >
                      Отменить заявку
                    </button>
                  )}
                </div>
              )}
```

- [ ] **Step 7: Typecheck + regression tests**

Run: `cd frontend && npx tsc --noEmit && npx vitest run`
Expected: clean, all existing tests still pass (no test touches `Requests.tsx` — there are none for it, per the file structure check at plan-writing time)

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/analytics.ts backend/app/schemas/ai.py frontend/src/pages/Requests.tsx
git commit -m "feat(заявки): кнопка «Отменить заявку» в «Мои заявки»"
```

---

### Task 7: End-to-end manual verification + prod deploy

**Files:** none (verification only)

- [ ] **Step 1: Rebuild and restart the local dev stand**

```bash
cd frontend && npm run build
```

Then restart the frontend container (Vite bind-mount doesn't pick up source changes automatically — see project CLAUDE.md):

```bash
docker compose -f docker-compose.demo.yml restart frontend
```

- [ ] **Step 2: Manual browser check — happy path**

In the Browser pane: open `/requests`, confirm at least one lead with a non-final status shows «Отменить заявку». Click it → confirm the inline «Точно отменить?» / «Да, отменить» / «Нет» row appears (no native `confirm()` dialog). Click «Да, отменить» → confirm the badge changes to «Отменена» (grey) without a page reload, and the cancel row disappears (status is now final, `cancellable()` returns false).

- [ ] **Step 3: Manual browser check — leads without the button**

Confirm a lead already in `completed` or `cancelled` status shows NO «Отменить заявку» button.

- [ ] **Step 4: Manual browser check — error path**

Using `javascript_tool`, call the cancel endpoint twice in a row for the same already-cancelled lead (simulating a race/double-tap) and confirm the second call surfaces a `toast()` error, not a silent failure or a crash:

```javascript
fetch('/api/leads/<id>/cancel', { method: 'POST', headers: { Authorization: 'Bearer ' + JSON.parse(localStorage.getItem('auth') || '{}').accessToken } }).then(r => r.status)
```

(adjust the token-reading expression to match however `useAuthStore` persists the token — check `frontend/src/store/auth.ts` if unsure).

- [ ] **Step 5: Full checklist from project CLAUDE.md**

```bash
cd backend && python -m pytest -q
cd frontend && npx tsc --noEmit && npx vitest run && npm run build
cd admin && npx tsc --noEmit && npm run build
```

All must pass before deploy (admin is untouched by this plan but the checklist always runs it).

- [ ] **Step 6: Check git status before deploy**

```bash
git status --short
```

Confirm only the files touched by Tasks 1-6 are modified/new — the deploy script syncs the ENTIRE working tree.

- [ ] **Step 7: Deploy**

From Git Bash (not PowerShell — the `iseller` SSH alias only resolves there):

```bash
bash update-server.sh
```

Wait for `>> health OK` and `>> готово.` in the output.

- [ ] **Step 8: Verify on prod**

Ask the user to open «Мои заявки» in the real Telegram Mini App and cancel a test lead, confirming the manager Telegram account (or `ADMIN_TELEGRAM_ID` chat) receives the «Покупатель отменил заявку» alert, and that a fresh regular order (e.g. from `/cart`) triggers the «Новая заявка» alert that previously never fired.
