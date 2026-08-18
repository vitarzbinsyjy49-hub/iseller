# Rich Messages (Bot API 10.1 sendRichMessage) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional Bot API 10.1 rich content (real `<table>`, headings, collapsible `<details>` FAQ blocks) with inline buttons to the existing channel-post publishing pipeline, without changing how any current post behaves.

**Architecture:** Telegram's `sendRichMessage`/`editMessageText(rich_message=…)` accept a `rich_message.html` field using the same "Rich HTML style" that is a superset of the `parse_mode=HTML` the project already generates — so no block-JSON tree needs to be hand-built. `ChannelPost` gets one new nullable column, `rich_html`. When it is set, `apply_info_posts()` sends/edits it via two new `telegram_publisher` functions instead of the existing `send_message`/`send_photo`/`edit_message`/`edit_caption` path, which stays byte-for-byte unchanged for every post that doesn't use it. A rich post's image (if any) is an `<img>` tag inside `rich_html` itself, not a separate `sendPhoto` call — rich messages don't have a caption-photo mode. Buttons keep going through the existing `build_keyboard()`/`resolve_button()` (url-only, per `docs/context/channel-posts.md`) — nothing new there.

**Tech Stack:** FastAPI + SQLAlchemy + pytest (backend), React/Vite + TypeScript (admin, minimal-extension only — no new screen).

## Global Constraints

- Backward compatibility is absolute: every existing info-post and price-post with `rich_html IS NULL` must publish exactly as before — verified by the full existing test suite staying green throughout.
- All Telegram HTTP calls go through the existing `call()` in `telegram_publisher.py` (retry + 429 handling) — no parallel HTTP layer.
- Buttons only through `build_keyboard()`/`resolve_button()` in `info_posts.py` — no new button mechanism.
- `admin/` gets the smallest possible extension to the existing `ChannelPosts.tsx` screen (one textarea + one preview button) — no new tab, no new component file, per the 2026-08-04 decision documented in `docs/context/admin-audit.md` that `admin/` no longer grows new subsystems.
- Every backend behavior change ships with a pytest test in the same style as its neighboring tests (`backend/tests/test_telegram_publisher.py`, `backend/tests/test_info_posts.py`).
- `httpx`/`httpcore` logging stays at WARNING (token-in-URL — see `CLAUDE.md`) — nothing in this plan touches logging config.
- `cd backend && python -m pytest -q` and `cd admin && npx tsc --noEmit && npm run build` must stay green after every task.
- None of our tests call the real Telegram API (everything mocks `call()` / patches `httpx.post`), so this plan cannot verify from pytest alone that Telegram's actual rich-HTML parser accepts our markup the way we expect — Final Verification includes a mandatory manual send to a real chat before this ships to the production channel.

---

### Task 1: `send_rich_message` / `edit_rich_message` in `telegram_publisher.py`

**Files:**
- Modify: `backend/app/services/telegram_publisher.py`
- Test: `backend/tests/test_telegram_publisher.py`

**Interfaces:**
- Produces: `MAX_RICH_MESSAGE_LENGTH = 32768` (Telegram's documented rich-message character limit). `send_rich_message(*, html: str, keyboard: list[list[dict]] | None = None, channel_id: str | int | None = None, disable_notification: bool = False) -> int` — calls `sendRichMessage`, returns `message_id`. `edit_rich_message(*, message_id: int, html: str, keyboard: list[list[dict]] | None = None, channel_id: str | int | None = None) -> bool` — calls `editMessageText` with `rich_message` instead of `text` (Telegram's docs: "Use this method to edit text, rich and game messages" — one endpoint for both), returns `False` on "message is not modified" like `edit_message` does, raises `TelegramContentTooLong` (already defined in this file) if `html` exceeds the limit.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_telegram_publisher.py`, after the existing `redirect` tests (end of file):

```python
# ---------------------------------------------------------------- rich-сообщения (Bot API 10.1)

def test_send_rich_message_with_keyboard(monkeypatch):
    post = fake_post([OK])
    monkeypatch.setattr(tp.httpx, "post", post)

    keyboard = [[{"text": "🛍 Открыть раздел", "url": "https://t.me/bot?start=catalog"}]]
    message_id = tp.send_rich_message(html="<table><tr><td>A</td></tr></table>", keyboard=keyboard)

    assert message_id == 42
    payload = post.sent[0]
    assert payload["rich_message"] == {"html": "<table><tr><td>A</td></tr></table>"}
    assert payload["reply_markup"] == {"inline_keyboard": keyboard}
    assert "text" not in payload
    assert "parse_mode" not in payload


def test_send_rich_message_without_keyboard_omits_markup(monkeypatch):
    post = fake_post([OK])
    monkeypatch.setattr(tp.httpx, "post", post)
    tp.send_rich_message(html="<p>текст</p>")
    assert "reply_markup" not in post.sent[0]


def test_send_rich_message_rejects_oversized_html(monkeypatch):
    post = fake_post([OK])
    monkeypatch.setattr(tp.httpx, "post", post)
    with pytest.raises(tp.TelegramContentTooLong):
        tp.send_rich_message(html="x" * (tp.MAX_RICH_MESSAGE_LENGTH + 1))
    assert post.sent == []      # проверка длины — до сети, лимит не должен жечься зря


def test_edit_rich_message_updates_existing_id(monkeypatch):
    post = fake_post([FakeResponse({"ok": True, "result": {"message_id": 7}})])
    monkeypatch.setattr(tp.httpx, "post", post)

    assert tp.edit_rich_message(message_id=7, html="<h2>Обновлено</h2>") is True
    payload = post.sent[0]
    assert payload["message_id"] == 7
    assert payload["rich_message"] == {"html": "<h2>Обновлено</h2>"}


def test_edit_rich_message_returns_false_when_nothing_changed(monkeypatch):
    post = fake_post([FakeResponse(
        {"ok": False, "description": "Bad Request: message is not modified"}, 400)])
    monkeypatch.setattr(tp.httpx, "post", post)
    assert tp.edit_rich_message(message_id=7, html="<p>то же самое</p>") is False


def test_edit_rich_message_rejects_oversized_html(monkeypatch):
    post = fake_post([OK])
    monkeypatch.setattr(tp.httpx, "post", post)
    with pytest.raises(tp.TelegramContentTooLong):
        tp.edit_rich_message(message_id=7, html="x" * (tp.MAX_RICH_MESSAGE_LENGTH + 1))
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_telegram_publisher.py -k rich -v`
Expected: FAIL — `AttributeError: module 'app.services.telegram_publisher' has no attribute 'send_rich_message'`.

- [ ] **Step 3: Implement**

In `backend/app/services/telegram_publisher.py`, add the constant next to the existing length constants (`MAX_CAPTION_LENGTH`/`MAX_MESSAGE_LENGTH`):

```python
#: Лимит символов rich-сообщения (Bot API 10.1) — сильно больше обычных 4096,
#: считает по документации ("Rich Message Limits"), включая alt-текст эмодзи
#: и исходник формул.
MAX_RICH_MESSAGE_LENGTH = 32768
```

Add the two functions after `edit_reply_markup` (before `pin_message`):

```python
def send_rich_message(
    *, html: str, keyboard: list[list[dict]] | None = None,
    channel_id: str | int | None = None, disable_notification: bool = False,
) -> int:
    """Опубликовать rich-сообщение (Bot API 10.1 sendRichMessage): настоящие
    таблицы, заголовки, сворачиваемые <details> — не имитация моноширинным
    текстом. html идёт в rich_message.html — тот же "Rich HTML style", что
    Telegram поддерживает для parse_mode=HTML, плюс table/details/heading/hr.
    """
    if len(html) > MAX_RICH_MESSAGE_LENGTH:
        raise TelegramContentTooLong(
            f"Rich-сообщение ограничено {MAX_RICH_MESSAGE_LENGTH} символами "
            f"(сейчас {len(html)})."
        )
    payload: dict = {
        "chat_id": _channel(channel_id),
        "rich_message": {"html": html},
        "disable_notification": disable_notification,
    }
    if keyboard:
        payload["reply_markup"] = {"inline_keyboard": keyboard}
    return int(call("sendRichMessage", payload)["message_id"])


def edit_rich_message(
    *, message_id: int, html: str, keyboard: list[list[dict]] | None = None,
    channel_id: str | int | None = None,
) -> bool:
    """Переписать rich-содержимое ранее опубликованного сообщения.

    editMessageText — единая ручка Bot API и для обычного текста, и для rich
    ("edit text, rich and game messages" в документации): поле rich_message
    заменяет text тем же вызовом, отдельного editRichMessageText не существует.
    """
    if len(html) > MAX_RICH_MESSAGE_LENGTH:
        raise TelegramContentTooLong(
            f"Rich-сообщение ограничено {MAX_RICH_MESSAGE_LENGTH} символами "
            f"(сейчас {len(html)})."
        )
    payload: dict = {
        "chat_id": _channel(channel_id),
        "message_id": message_id,
        "rich_message": {"html": html},
    }
    if keyboard:
        payload["reply_markup"] = {"inline_keyboard": keyboard}
    try:
        call("editMessageText", payload)
        return True
    except TelegramRateLimited:
        raise
    except TelegramPublishError as exc:
        if "not modified" in str(exc).lower():
            return False
        raise
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_telegram_publisher.py -v`
Expected: all PASS (existing + 6 new).

- [ ] **Step 5: Full backend suite + commit**

Run: `cd backend && python -m pytest -q`
Expected: all green.

```bash
git add backend/app/services/telegram_publisher.py backend/tests/test_telegram_publisher.py
git commit -m "feat(канал): sendRichMessage/editMessageText(rich_message) в telegram_publisher"
```

---

### Task 2: `rich_html` column on `ChannelPost`

**Files:**
- Modify: `backend/app/models/post.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_info_posts.py`

**Interfaces:**
- Produces: `ChannelPost.rich_html: str | None` — nullable Text column.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_info_posts.py`, near the top under the "заготовки" section:

```python
def test_rich_html_field_defaults_to_none_and_round_trips(db):
    row = ChannelPost(slug="info_test_rich_field", kind=INFO_KIND, title="T", body="B")
    db.add(row)
    db.commit()
    db.refresh(row)
    assert row.rich_html is None

    row.rich_html = "<table><tr><td>1</td></tr></table>"
    db.commit()
    db.refresh(row)
    assert row.rich_html == "<table><tr><td>1</td></tr></table>"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_info_posts.py::test_rich_html_field_defaults_to_none_and_round_trips -v`
Expected: FAIL — `TypeError: 'rich_html' is an invalid keyword argument` or `AttributeError` on assignment (no such column/attribute yet).

- [ ] **Step 3: Add the column**

In `backend/app/models/post.py`, add after the `button_spec` field:

```python
    # Rich-контент поста (Bot API 10.1 sendRichMessage): настоящие таблицы,
    # заголовки, сворачиваемый <details> — не имитация моноширинным текстом.
    # NULL у всех существующих постов — публикуются как раньше, через body.
    # Когда заполнено, ЗАМЕНЯЕТ body целиком при публикации (свой источник
    # правды, не производная от body). Картинка rich-поста не идёт через
    # image_url/sendPhoto — она добавляется тегом <img> прямо внутри
    # rich_html, см. docs/context/channel-posts.md.
    rich_html: Mapped[str | None] = mapped_column(Text)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_info_posts.py::test_rich_html_field_defaults_to_none_and_round_trips -v`
Expected: PASS. (Tests build the schema fresh via `Base.metadata.create_all`, so no migration statement is needed for the test DB.)

- [ ] **Step 5: Add the production migration**

`channel_posts` already exists on the live DB, so the new column needs the mini-migration in `backend/app/main.py` per the project's invariant (new columns on existing tables aren't picked up by `create_all`). Add to the `statements` list, right after the existing `"ALTER TABLE channel_posts ADD COLUMN IF NOT EXISTS button_spec JSON"` line:

```python
        # Rich-контент (Bot API 10.1 sendRichMessage). NULL у всех
        # существующих постов — ничего не меняется, пока поле не заполнено.
        "ALTER TABLE channel_posts ADD COLUMN IF NOT EXISTS rich_html TEXT",
```

- [ ] **Step 6: Full backend suite + commit**

Run: `cd backend && python -m pytest -q`
Expected: all green.

```bash
git add backend/app/models/post.py backend/app/main.py backend/tests/test_info_posts.py
git commit -m "feat(канал): колонка rich_html на channel_posts под Bot API 10.1"
```

---

### Task 3: `apply_info_posts()` publishes/edits `rich_html` when set

**Files:**
- Modify: `backend/app/services/price_channel.py`
- Test: `backend/tests/test_info_posts.py`

**Interfaces:**
- Consumes: `send_rich_message`, `edit_rich_message` from Task 1; `ChannelPost.rich_html` from Task 2.
- Produces: `apply_info_posts()` behavior — for a row with non-empty `rich_html`, publishes via `send_rich_message`/`edit_rich_message` instead of `send_message`/`send_photo`/`edit_message`/`edit_caption`, ignoring `image_url` entirely for that row. `row.published_body` stores whichever content variant was actually sent (`rich_html` or `body`) — same field, same "what's really in the channel" contract it already has.

- [ ] **Step 1: Write the failing tests**

In `backend/tests/test_info_posts.py`, extend `FakeTelegram.__init__` and add the two new fake methods (the class already has `send_message`/`edit_message`/`edit_reply_markup`/`send_photo`/`edit_caption` fakes — add these two alongside them):

```python
    def send_rich_message(self, *, html, keyboard=None, channel_id=None, **kw):
        self.next_id += 1
        self.sent_rich.append({"html": html, "keyboard": keyboard, "message_id": self.next_id})
        return self.next_id

    def edit_rich_message(self, *, message_id, html, keyboard=None, channel_id=None):
        self.edited_rich.append({"message_id": message_id, "html": html, "keyboard": keyboard})
        return True
```

Add `self.sent_rich, self.edited_rich = [], []` to `FakeTelegram.__init__`, alongside its existing list initializations.

Add the two new patches to the `telegram` fixture, alongside its existing `monkeypatch.setattr(price_channel, ...)` lines:

```python
    monkeypatch.setattr(price_channel, "send_rich_message", fake.send_rich_message)
    monkeypatch.setattr(price_channel, "edit_rich_message", fake.edit_rich_message)
```

Add new tests in a fresh section (after the existing photo-publishing tests, near `test_published_photo_post_edit_uses_edit_caption`):

```python
# ---------------------------------------------------------------- rich-контент

def test_rich_post_is_published_via_send_rich_message(db, telegram):
    row = fill(db, "info_warranty")
    row.rich_html = "<table><tr><td>Срок</td><td>1 месяц</td></tr></table>"
    db.commit()

    result = price_channel.apply_info_posts(db, slugs=["info_warranty"])

    assert result.created == ["info_warranty"]
    assert telegram.sent_rich[0]["html"] == row.rich_html
    assert telegram.sent_photos == [] and telegram.sent == []
    row = db.query(ChannelPost).filter_by(slug="info_warranty").one()
    assert row.published_body == row.rich_html


def test_rich_post_republish_edits_via_edit_rich_message(db, telegram):
    row = fill(db, "info_warranty")
    row.rich_html = "<h3>Версия 1</h3>"
    db.commit()
    price_channel.apply_info_posts(db, slugs=["info_warranty"])

    row = db.query(ChannelPost).filter_by(slug="info_warranty").one()
    row.rich_html = "<h3>Версия 2</h3>"
    db.commit()
    result = price_channel.apply_info_posts(db, slugs=["info_warranty"])

    assert result.updated == ["info_warranty"]
    assert telegram.edited_rich[0]["html"] == "<h3>Версия 2</h3>"


def test_rich_post_ignores_image_url_and_uses_rich_html_only(db, telegram):
    """Картинка rich-поста — <img> внутри rich_html, а не отдельный sendPhoto:
    у rich-сообщений нет режима "фото с подписью"."""
    row = fill(db, "info_warranty")
    row.image_url = "https://example.com/photo.jpg"
    row.rich_html = '<img src="https://example.com/photo.jpg"/><p>Текст</p>'
    db.commit()

    price_channel.apply_info_posts(db, slugs=["info_warranty"])

    assert telegram.sent_photos == []
    assert telegram.sent_rich[0]["html"] == row.rich_html


def test_rich_post_with_placeholder_is_not_published(db, telegram):
    row = fill(db, "info_warranty")
    row.rich_html = f"<p>{PLACEHOLDER} впишите условия</p>"
    db.commit()

    result = price_channel.apply_info_posts(db, slugs=["info_warranty"])

    assert result.failed == [("info_warranty", "в тексте остались незаполненные места")]
    assert telegram.sent_rich == []


def test_rich_post_unchanged_is_not_resent(db, telegram):
    row = fill(db, "info_warranty")
    row.rich_html = "<p>Стабильный текст</p>"
    db.commit()
    price_channel.apply_info_posts(db, slugs=["info_warranty"])

    result = price_channel.apply_info_posts(db, slugs=["info_warranty"])

    assert result.unchanged == ["info_warranty"]
    assert len(telegram.sent_rich) == 1     # второго вызова не было
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_info_posts.py -k rich_post -v`
Expected: FAIL — `apply_info_posts` doesn't know about `rich_html` yet, so it falls through to the plain-text path and `telegram.sent_rich` stays empty.

- [ ] **Step 3: Implement**

In `backend/app/services/price_channel.py`, add the two new imports to the existing `from app.services.telegram_publisher import (...)` block:

```python
from app.services.telegram_publisher import (
    TelegramPublishError,
    edit_caption,
    edit_message,
    edit_reply_markup,
    edit_rich_message,
    public_image_url,
    send_message,
    send_photo,
    send_rich_message,
)
```

Replace the body of the `for row in sorted(...)` loop in `apply_info_posts` with:

```python
    for row in sorted(rows, key=lambda r: r.sort_order):
        # Rich-контент (models/post.py::rich_html) заменяет body целиком, когда
        # заполнен — отдельный источник правды, а не производная от body.
        content = row.rich_html or row.body
        # Незаполненная заготовка в канал не уходит: «[уточнить] — впишите
        # ваши условия» читается как забытый черновик и бьёт по доверию
        # сильнее, чем отсутствие поста.
        if has_placeholders(content):
            result.failed.append((row.slug, "в тексте остались незаполненные места"))
            continue

        keyboard = build_keyboard(
            row.button_spec if row.button_spec is not None else DEFAULT_BUTTONS,
            bot_username=settings.BOT_USERNAME,
            manager_url=settings.MANAGER_RETAIL_URL,
            channel_url=settings.TELEGRAM_CHANNEL_URL,
            section_links=section_links(db),
            app_short_name=settings.MINI_APP_SHORT_NAME,
        )
        # Сравниваем с тем, что РЕАЛЬНО в канале, а не со статусом: статус
        # мог не обновиться, если текст правили мимо API.
        if (row.telegram_message_id and row.published_body == content
                and row.reply_markup == keyboard):
            result.unchanged.append(row.slug)
            continue
        if dry_run:
            (result.updated if row.telegram_message_id else result.created).append(row.slug)
            continue

        try:
            if row.rich_html:
                # У rich-сообщений нет режима "фото с подписью" — картинка,
                # если нужна, уже внутри content тегом <img>.
                if row.telegram_message_id:
                    edit_rich_message(message_id=row.telegram_message_id, html=content,
                                      keyboard=keyboard, channel_id=channel_id())
                    result.updated.append(row.slug)
                else:
                    row.telegram_message_id = send_rich_message(
                        html=content, keyboard=keyboard, channel_id=channel_id())
                    row.published_at = now
                    result.created.append(row.slug)
            elif row.telegram_message_id:
                # Смена САМОЙ картинки на уже опубликованном посте — не этот
                # путь (нужен editMessageMedia, отдельная операция); подпись
                # и клавиатура редактируются на месте независимо от того,
                # есть фото или нет.
                if row.image_url:
                    edit_caption(message_id=row.telegram_message_id, caption=content,
                                keyboard=keyboard, channel_id=channel_id())
                else:
                    edit_message(message_id=row.telegram_message_id, text=content,
                                 keyboard=keyboard, channel_id=channel_id())
                result.updated.append(row.slug)
            elif row.image_url:
                row.telegram_message_id = send_photo(
                    photo=public_image_url(row.image_url), caption=content, keyboard=keyboard,
                    channel_id=channel_id())
                row.published_at = now
                result.created.append(row.slug)
            else:
                row.telegram_message_id = send_message(
                    text=content, keyboard=keyboard, channel_id=channel_id())
                row.published_at = now
                result.created.append(row.slug)
            row.status = "published"
            row.channel_id = str(channel_id())
            row.reply_markup = keyboard
            row.published_body = content
            row.last_synced_at = now
            row.last_error = None
            db.commit()
        except TelegramPublishError as exc:
            db.rollback()
            row = _existing(db).get(row.slug)
            if row is not None:
                row.status = "error"
                row.last_error = str(exc)[:500]
                if _MESSAGE_GONE.search(str(exc)):
                    row.telegram_message_id = None
                    row.published_body = None
                db.commit()
            logger.warning("инфо-пост %s: %s", row.slug if row else "?", exc)
            result.failed.append((row.slug if row else "?", str(exc)))

    return result
```

(This keeps the entire `except TelegramPublishError` block byte-for-byte identical to what it replaces — only the `try` block above it changes, to add the `if row.rich_html:` branch ahead of the existing `elif row.telegram_message_id: / elif row.image_url: / else:` chain.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_info_posts.py -v`
Expected: all PASS (existing + 5 new).

- [ ] **Step 5: Full backend suite + commit**

Run: `cd backend && python -m pytest -q`
Expected: all green.

```bash
git add backend/app/services/price_channel.py backend/tests/test_info_posts.py
git commit -m "feat(канал): apply_info_posts публикует rich_html через sendRichMessage"
```

---

### Task 4: Admin API — read/write `rich_html`, stateless preview endpoint

**Files:**
- Modify: `backend/app/api/price_posts.py`
- Test: `backend/tests/test_info_posts.py`

**Interfaces:**
- Consumes: `MAX_RICH_MESSAGE_LENGTH` from Task 1, `ChannelPost.rich_html` from Task 2.
- Produces: `InfoTextRequest.rich_html: str | None`, `CreatePostRequest.rich_html: str | None`; `_out()` now includes `"rich_html"`; new `POST /admin/price-posts/info/rich-preview` accepting `{"rich_html": str}`, returning `{"length": int, "limit": int, "over_limit": bool, "has_placeholders": bool}` — stateless, no DB write, no Telegram call.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_info_posts.py`, in the API section (near `test_api_edit_marks_published_post_outdated`):

```python
def test_api_edit_sets_rich_html(client, db, telegram):
    client.post("/api/admin/price-posts/info/generate")
    resp = client.patch("/api/admin/price-posts/info/info_warranty",
                        json={"rich_html": "<table><tr><td>A</td></tr></table>"})
    assert resp.status_code == 200
    assert resp.json()["rich_html"] == "<table><tr><td>A</td></tr></table>"


def test_api_create_custom_post_with_rich_html(client, db, telegram):
    resp = client.post("/api/admin/price-posts/info", json={
        "slug": "promo_table", "title": "Промо", "body": "Обычный текст",
        "rich_html": "<h2>Заголовок</h2>",
    })
    assert resp.status_code == 200
    assert resp.json()["rich_html"] == "<h2>Заголовок</h2>"


def test_api_rich_preview_reports_length_and_limit(client, db):
    from app.services.telegram_publisher import MAX_RICH_MESSAGE_LENGTH

    resp = client.post("/api/admin/price-posts/info/rich-preview",
                       json={"rich_html": "<p>тест</p>"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["length"] == len("<p>тест</p>")
    assert body["limit"] == MAX_RICH_MESSAGE_LENGTH
    assert body["over_limit"] is False
    assert body["has_placeholders"] is False


def test_api_rich_preview_flags_placeholder_and_over_limit(client, db):
    resp = client.post("/api/admin/price-posts/info/rich-preview",
                       json={"rich_html": PLACEHOLDER + "x" * 40000})
    body = resp.json()
    assert body["has_placeholders"] is True
    assert body["over_limit"] is True
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_info_posts.py -k "rich_html or rich_preview" -v`
Expected: FAIL — `rich_html` not accepted by the request models (silently dropped by Pydantic, so the PATCH/create assertions fail), and `/rich-preview` 404s.

- [ ] **Step 3: Implement**

In `backend/app/api/price_posts.py`, extend the two request models:

```python
class InfoTextRequest(BaseModel):
    """Правка поста: текст и/или кнопки. Не переданное поле не трогаем."""
    title: str | None = None
    body: str | None = None
    rich_html: str | None = None
    buttons: list[dict] | None = None
    image_url: str | None = None


class CreatePostRequest(BaseModel):
    slug: str
    title: str
    body: str
    rich_html: str | None = None
    buttons: list[dict] | None = None
    image_url: str | None = None


class RichPreviewRequest(BaseModel):
    rich_html: str = ""
```

In `_out()`, add the field next to `"body"`:

```python
        "body": row.body if row.kind == INFO_KIND else None,
        "rich_html": row.rich_html if row.kind == INFO_KIND else None,
        "buttons": row.button_spec if row.kind == INFO_KIND else None,
        "image_url": row.image_url if row.kind == INFO_KIND else None,
        "has_placeholders": has_placeholders(row.rich_html or row.body) if row.kind == INFO_KIND else False,
```

In `create_info()`, pass the field through:

```python
    row = ChannelPost(
        slug=slug, kind=INFO_KIND, status="draft", title=payload.title,
        body=payload.body, rich_html=payload.rich_html,
        button_spec=payload.buttons or list(DEFAULT_BUTTONS),
        image_url=payload.image_url, sort_order=2000 + last,
    )
```

In `edit_info()`, add alongside the other `if payload.X is not None` blocks:

```python
    if payload.rich_html is not None:
        row.rich_html = payload.rich_html
```

Add the new endpoint near `button_kinds()`:

```python
@router.post("/info/rich-preview")
def rich_preview(payload: RichPreviewRequest):
    """Предпросмотр rich-контента: длина и лимит без публикации и без
    сохранения — тот же parse -> preview -> apply, что и у прайс-тула."""
    html = payload.rich_html
    return {
        "length": len(html),
        "limit": MAX_RICH_MESSAGE_LENGTH,
        "over_limit": len(html) > MAX_RICH_MESSAGE_LENGTH,
        "has_placeholders": has_placeholders(html),
    }
```

Add the needed import at the top of the file (alongside the existing `from app.services.telegram_publisher import ...`):

```python
from app.services.telegram_publisher import (
    MAX_RICH_MESSAGE_LENGTH, TelegramPublishError, TelegramRateLimited,
)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_info_posts.py -v`
Expected: all PASS.

- [ ] **Step 5: Full backend suite + commit**

Run: `cd backend && python -m pytest -q`
Expected: all green.

```bash
git add backend/app/api/price_posts.py backend/tests/test_info_posts.py
git commit -m "feat(канал): admin API читает/пишет rich_html + предпросмотр без публикации"
```

---

### Task 5: Minimal admin UI — rich-content field + preview button

**Files:**
- Modify: `admin/src/ChannelPosts.tsx`

**Interfaces:**
- Consumes: `rich_html` field and `POST /admin/price-posts/info/rich-preview` from Task 4.
- Produces: no new exports — this is the one screen extension the task grants itself (per Global Constraints).

- [ ] **Step 1: Extend the `Post` type and add a preview response type**

```ts
type Post = {
  slug: string; title: string; status: string; kind: string;
  telegram_message_id: number | null; channel_id: string | null;
  body: string | null; rich_html: string | null; buttons: ButtonSpec[] | null;
  has_placeholders: boolean; editable: boolean;
  has_draft: boolean;
  last_synced_at: string | null; last_error: string | null; length: number;
};

type RichPreview = { length: number; limit: number; over_limit: boolean; has_placeholders: boolean };
```

- [ ] **Step 2: Show a "rich" badge on cards that have rich content**

In the post card, right after the existing status `<span>` badge:

```tsx
                {post.rich_html && (
                  <span style={{
                    background: C.accent + "22", color: C.accent,
                    padding: "3px 8px", borderRadius: 999, fontSize: 12, fontWeight: 600,
                  }}>rich</span>
                )}
```

- [ ] **Step 3: Thread `token` into `PostEditor` and widen its callback signatures**

Change the two render sites in `ChannelPosts()`:

```tsx
      {editing && kinds && (
        <PostEditor post={editing} kinds={kinds} busy={busy} token={token} onClose={() => setEditing(null)}
          onSave={(body, richHtml, buttons, title) => run(async () => {
            await apiSend("PATCH", `/admin/price-posts/info/${editing.slug}`, token,
              { body, rich_html: richHtml || null, buttons, title });
            setEditing(null);
          })} />
      )}
      {creating && kinds && (
        <PostEditor kinds={kinds} busy={busy} token={token} onClose={() => setCreating(false)}
          onCreate={(slug, title, body, richHtml, buttons) => run(async () => {
            await apiPost("/admin/price-posts/info", token,
              { slug, title, body, rich_html: richHtml || null, buttons });
            setCreating(false);
          })} />
      )}
```

- [ ] **Step 4: Add the rich-content field, counter, and preview button in `PostEditor`**

Change the function signature:

```tsx
function PostEditor({
  post, kinds, busy, token, onClose, onSave, onCreate,
}: {
  post?: Post; kinds: KindsResp; busy: boolean; token: string; onClose: () => void;
  onSave?: (body: string, richHtml: string, buttons: ButtonSpec[], title: string) => void;
  onCreate?: (slug: string, title: string, body: string, richHtml: string, buttons: ButtonSpec[]) => void;
}) {
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState(post?.title ?? "");
  const [body, setBody] = useState(post?.body ?? "");
  const [richHtml, setRichHtml] = useState(post?.rich_html ?? "");
  const [preview, setPreview] = useState<RichPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [buttons, setButtons] = useState<ButtonSpec[]>(
    post?.buttons ?? [{ text: "🛍 Открыть каталог", kind: "catalog", row: 0 }]);
```

After the existing body-length counter (`{body.length}/4096 символов`), insert:

```tsx
      <label style={{ ...label, marginTop: 16 }}>
        Rich-контент (HTML, необязательно) — таблицы &lt;table&gt;, заголовки &lt;h1&gt;–&lt;h6&gt;,
        сворачиваемый блок &lt;details&gt;&lt;summary&gt;…&lt;/summary&gt;…&lt;/details&gt;. Если
        заполнено — ПОЛНОСТЬЮ заменяет обычный текст выше при публикации; картинку добавляйте прямо
        здесь тегом &lt;img src="…"/&gt; — поле «URL изображения» rich-пост не использует.
        <textarea value={richHtml} onChange={(e) => { setRichHtml(e.target.value); setPreview(null); }}
          rows={8} style={{ ...input, fontFamily: "ui-monospace, monospace", fontSize: 13, lineHeight: 1.5 }} />
      </label>
      {richHtml && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: -6, marginBottom: 10 }}>
          <button style={smallGhost} disabled={previewBusy} onClick={async () => {
            setPreviewBusy(true);
            try {
              setPreview(await apiPost<RichPreview>("/admin/price-posts/info/rich-preview", token,
                { rich_html: richHtml }));
            } catch {
              setPreview(null);
            } finally {
              setPreviewBusy(false);
            }
          }}>{previewBusy ? "Проверяю…" : "Предпросмотр"}</button>
          {preview && (
            <span style={{ color: preview.over_limit || preview.has_placeholders ? C.red : C.sub, fontSize: 12 }}>
              {preview.length}/{preview.limit} символов
              {preview.over_limit && " — превышен лимит"}
              {preview.has_placeholders && " — остались незаполненные места"}
            </span>
          )}
        </div>
      )}
```

Change the save button's `onClick` to pass `richHtml` through:

```tsx
        <button style={btn} disabled={busy || !body.trim() || (!post && !slug.trim())}
          onClick={() => (post
            ? onSave?.(body, richHtml, buttons, title)
            : onCreate?.(slug, title || slug, body, richHtml, buttons))}>
          {busy ? "Сохраняю…" : "Сохранить"}
        </button>
```

- [ ] **Step 5: `tsc` check**

Run: `cd admin && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Browser verification**

1. `docker compose -f docker-compose.demo.yml restart admin` (bind-mount doesn't hot-reload, per `CLAUDE.md`).
2. Open admin → "Посты канала" → "Редактировать" on any info post.
3. Type `<table><tr><th>Срок</th><th>Значение</th></tr><tr><td>Гарантия</td><td>1 месяц</td></tr></table>` into the new Rich-контент field, click "Предпросмотр" — confirm the length/limit line appears and is not flagged red.
4. Save, confirm the card now shows the "rich" badge.
5. Confirm a post with an empty Rich-контент field behaves exactly as before (no badge, normal HTML body path).

- [ ] **Step 7: `npm run build` + commit**

Run: `cd admin && npm run build`
Expected: clean build.

```bash
git add admin/src/ChannelPosts.tsx
git commit -m "feat(админка): поле rich-контента и предпросмотр в редакторе постов канала"
```

---

### Task 6: Document the invariant in `docs/context/channel-posts.md`

**Files:**
- Modify: `docs/context/channel-posts.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Add a new section**

Append to `docs/context/channel-posts.md`:

```markdown

## Rich-контент (Bot API 10.1 sendRichMessage)

Опционально: у `ChannelPost` есть `rich_html`. Когда заполнено — ПОЛНОСТЬЮ
заменяет `body` при публикации, через `send_rich_message`/`edit_rich_message`
(`telegram_publisher.py`) вместо `send_message`/`send_photo`/`edit_message`/
`edit_caption`. `editMessageText` — одна и та же ручка Bot API для обычного и
rich-текста (принимает `rich_message` вместо `text`), поэтому модель «опубликовать
один раз, дальше редактировать на том же message_id» работает без изменений.

- `rich_html` идёт в `rich_message.html` — тот же "Rich HTML style", что и
  `parse_mode=HTML`, плюс `<table>`, `<h1>`–`<h6>`, `<hr/>`,
  `<details><summary>…</summary>…</details>`, `<footer>`, `<blockquote>`,
  `<aside><cite>`, `<img>`/`<video>`/`<audio>` (только http/https-URL).
- У rich-сообщений нет режима "фото с подписью" (`sendPhoto`) — картинка идёт
  тегом `<img>` прямо внутри `rich_html`; `image_url` для rich-поста не
  используется совсем.
- Лимит — `MAX_RICH_MESSAGE_LENGTH = 32768` символов (документированный лимит
  Telegram), отдельно от `MAX_MESSAGE_LENGTH`/`MAX_CAPTION_LENGTH` обычных
  постов.
- Кнопки — те же `build_keyboard()`/`resolve_button()`, ничего не меняется:
  `reply_markup` у `sendRichMessage`/`editMessageText` принимает тот же
  `{"inline_keyboard": [...]}`.
- Автоматических тестов, бьющих в настоящий Bot API, в проекте нет (все тесты
  мокают `call()`) — перед публикацией непроверенной rich-разметки в
  `@isellerhub` стоит один раз вручную отправить её в тестовый чат.
```

- [ ] **Step 2: Commit**

```bash
git add docs/context/channel-posts.md
git commit -m "docs(канал): задокументировать rich-контент (Bot API 10.1 sendRichMessage)"
```

---

## Final Verification

- [ ] `cd backend && python -m pytest -q` — full green.
- [ ] `cd admin && npx tsc --noEmit && npm run build` — clean.
- [ ] `cd frontend && npx tsc --noEmit && npx vitest run && npm run build` — unaffected by this plan, run to confirm no collateral damage.
- [ ] Manual browser pass per Task 5 Step 6.
- [ ] **Mandatory real-Telegram check** (nothing in the automated suite hits the real Bot API): before relying on this for the production `@isellerhub` channel, send one rich test post — either to a private test channel/chat the bot administers, or via a one-off `python -c` call to `send_rich_message(html=..., channel_id=<test chat id>)` with real credentials — containing at least a `<table>` and a `<details><summary>` block, and visually confirm in a Telegram client that it renders as a real table and a collapsible section, not raw HTML text. This is the one thing the mocked test suite structurally cannot verify.
