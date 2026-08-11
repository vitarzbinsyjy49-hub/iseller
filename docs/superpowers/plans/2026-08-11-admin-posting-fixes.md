# Admin Posting/Channel Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining "class A" defects from `docs/context/admin-audit.md` that block working with channel posts from the admin panel: invisible info-posts list, silent session death, silently-truncated photo captions, no way to create or edit-after-publish an editorial post, and a swallowed fetch error that disables the post editor without feedback.

**Architecture:** Each fix is scoped to the exact files the audit named. No new abstractions, no schema changes. Backend fixes stay inside `backend/app/api/posts.py`, `backend/app/api/price_posts.py`, `backend/app/services/telegram_publisher.py`. Frontend fixes stay inside `admin/src/ChannelPosts.tsx`, `admin/src/Posts.tsx`, `admin/src/App.tsx`, `admin/src/ui.ts`.

**Tech Stack:** FastAPI + SQLAlchemy + pytest (backend), React/Vite + TypeScript (admin), Docker Compose demo stack for manual browser verification.

## Global Constraints

- Do not change the public shape of `_out()` responses except where a task explicitly adds a field.
- Every backend fix ships with a pytest test in `backend/tests/test_price_posts.py` or a new `backend/tests/test_posts_api.py`.
- Every admin fix is verified live in the browser against `docker-compose.demo.yml` (admin 5174, backend 8000) per `CLAUDE.md` — Vite bind-mount does not hot-reload, so `docker compose -f docker-compose.demo.yml restart admin` (if admin is mounted) or `up -d --build admin` is required after edits; confirm which applies before relying on HMR.
- `cd backend && python -m pytest -q` and `cd admin && npx tsc --noEmit && npm run build` must stay green after every task.
- Never weaken the existing `confirm=true` gate on any publish path.

---

### Task 1: Info-posts show up in "Посты канала"

**Files:**
- Modify: `backend/app/api/price_posts.py:81-83`
- Test: `backend/tests/test_price_posts.py`

**Interfaces:**
- Consumes: `INFO_KIND` already imported at `price_posts.py:21`.
- Produces: `GET /admin/price-posts` now includes `kind="info"` rows in `posts`.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_price_posts.py`:

```python
def test_api_list_includes_info_posts(client, db, telegram):
    client.post("/api/admin/price-posts/info/generate")
    response = client.get("/api/admin/price-posts")
    kinds = {p["kind"] for p in response.json()["posts"]}
    assert "info" in kinds
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_price_posts.py::test_api_list_includes_info_posts -v`
Expected: FAIL — `"info" in kinds` is False.

- [ ] **Step 3: Fix the filter**

In `backend/app/api/price_posts.py`, change:

```python
    rows = db.query(ChannelPost).filter(
        ChannelPost.kind.in_([price_channel.PRICE_KIND, price_channel.NAVIGATION_KIND])
    ).order_by(ChannelPost.sort_order).all()
```

to:

```python
    rows = db.query(ChannelPost).filter(
        ChannelPost.kind.in_([price_channel.PRICE_KIND, price_channel.NAVIGATION_KIND, INFO_KIND])
    ).order_by(ChannelPost.sort_order).all()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_price_posts.py::test_api_list_includes_info_posts -v`
Expected: PASS

- [ ] **Step 5: Full backend suite + commit**

Run: `cd backend && python -m pytest -q`
Expected: 775 passed (774 + 1 new)

```bash
git add backend/app/api/price_posts.py backend/tests/test_price_posts.py
git commit -m "fix(канал): инфо-посты пропадали из списка \"Посты канала\" — фильтр не включал их kind"
```

---

### Task 2: Admin session survives token expiry (silent refresh)

**Files:**
- Modify: `admin/src/ui.ts`
- Modify: `admin/src/App.tsx`

**Interfaces:**
- Consumes: existing backend `POST /auth/refresh` (`backend/app/api/auth.py:116`), which rotates and returns a fresh `TokenPair {access_token, refresh_token}`.
- Produces: `ui.ts` exports `storeTokens(access, refresh)`, `clearTokens()`, `loadStoredAccessToken()`, `loadStoredRefreshToken()`, `onTokenRefreshed(listener)`. `apiGet`/`apiSend`/`apiUpload`/`apiUploadMany` transparently retry once after a silent refresh on 401. Existing call signatures (`apiGet<T>(path, token)` etc.) are unchanged — every existing call site keeps working with no edits.

- [ ] **Step 1: Add token storage + refresh-and-retry to `ui.ts`**

At the top of `admin/src/ui.ts`, after the `input`/`btn` exports, add:

```ts
const ACCESS_KEY = "admin_access_token";
const REFRESH_KEY = "admin_refresh_token";

export function storeTokens(accessToken: string, refreshToken: string) {
  sessionStorage.setItem(ACCESS_KEY, accessToken);
  sessionStorage.setItem(REFRESH_KEY, refreshToken);
}
export function clearTokens() {
  sessionStorage.removeItem(ACCESS_KEY);
  sessionStorage.removeItem(REFRESH_KEY);
}
export function loadStoredAccessToken(): string | null {
  return sessionStorage.getItem(ACCESS_KEY);
}

type TokenListener = (accessToken: string) => void;
let tokenListener: TokenListener | null = null;
/** Shell вызывает это при монтировании, чтобы синхронизировать своё состояние
 *  token с токеном, который тихо обновился внутри apiSend/apiGet. */
export function onTokenRefreshed(listener: TokenListener | null) {
  tokenListener = listener;
}

let refreshInFlight: Promise<string | null> | null = null;
/** Обменять refresh-токен на новую пару. Один запрос на все параллельные 401 —
 *  backend/app/api/auth.py::refresh одноразовый, второй вызов тем же
 *  refresh-токеном отклоняется как повтор. */
function refreshAccessToken(): Promise<string | null> {
  const refreshToken = sessionStorage.getItem(REFRESH_KEY);
  if (!refreshToken) return Promise.resolve(null);
  if (!refreshInFlight) {
    refreshInFlight = fetch("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
      .then(async (r) => {
        if (!r.ok) { clearTokens(); return null; }
        const data = await r.json();
        storeTokens(data.access_token, data.refresh_token);
        tokenListener?.(data.access_token);
        return data.access_token as string;
      })
      .catch(() => null)
      .finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}
```

Then change `apiGet` and `apiSend` to retry once after a 401:

```ts
export async function apiGet<T>(path: string, token: string): Promise<T> {
  let r = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 401) {
    const fresh = await refreshAccessToken();
    if (fresh) r = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${fresh}` } });
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function apiSend<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
  const doFetch = (tok: string) => fetch(`/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let r = await doFetch(token);
  if (r.status === 401) {
    const fresh = await refreshAccessToken();
    if (fresh) r = await doFetch(fresh);
  }
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.detail || `HTTP ${r.status}`);
  }
  return r.json();
}
```

Apply the identical 401-retry wrapping to `apiUpload` and `apiUploadMany` (same pattern: try with `token`, on 401 call `refreshAccessToken()`, retry once with the fresh token before falling through to the existing error handling).

- [ ] **Step 2: Wire storage + listener into `App.tsx`**

In `admin/src/App.tsx`:

1. Import `storeTokens, clearTokens, loadStoredAccessToken, onTokenRefreshed` from `./ui`.
2. In `App()`, initialize state from storage instead of `null`:

```tsx
export default function App() {
  const [token, setToken] = useState<string | null>(() => loadStoredAccessToken());
  useEffect(() => {
    onTokenRefreshed((fresh) => setToken(fresh));
    return () => onTokenRefreshed(null);
  }, []);
  return token
    ? <Shell token={token} onLogout={() => { clearTokens(); setToken(null); }} />
    : <Login onToken={(access) => setToken(access)} />;
}
```

3. In `Login`, both `devLogin()` and `submit()` currently do `onToken((await res.json()).access_token)`. Change both to capture the full pair and store it:

```ts
  async function devLogin() {
    setError("");
    const res = await fetch("/api/auth/admin/dev", { method: "POST" });
    if (!res.ok) {
      setError("Тестовый вход недоступен: сервер запущен не в DEV_MODE");
      return;
    }
    const data = await res.json();
    storeTokens(data.access_token, data.refresh_token);
    onToken(data.access_token);
  }
```

```ts
  async function submit() {
    setError("");
    const res = await fetch("/api/auth/admin/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) { setError("Неверный email или пароль"); return; }
    const data = await res.json();
    storeTokens(data.access_token, data.refresh_token);
    onToken(data.access_token);
  }
```

`Login`'s `onToken` prop type stays `(t: string) => void` — no signature change needed since `App` already wraps it as `(access) => setToken(access)`.

- [ ] **Step 3: Manual verification in browser** (no admin test harness exists — see `docs/context/admin-audit.md` §4.5)

1. `docker compose -f docker-compose.demo.yml up -d`
2. Open admin at `http://localhost:5174`, log in with dev login.
3. In the browser devtools console, run `sessionStorage.getItem("admin_refresh_token")` — must be non-empty.
4. Simulate expiry: in devtools console run `sessionStorage.setItem("admin_access_token","garbage")` then trigger any tab load (e.g. click "Товары"). Confirm the screen loads data instead of erroring — proves the 401 → refresh → retry path works.
5. Reload the page (F5). Confirm still logged in (session persisted via `sessionStorage`, not wiped like before).
6. Click "Выйти", confirm redirected to login and `sessionStorage.getItem("admin_access_token")` is `null`.

- [ ] **Step 4: `tsc` check + commit**

Run: `cd admin && npx tsc --noEmit`
Expected: no errors.

```bash
git add admin/src/ui.ts admin/src/App.tsx
git commit -m "fix(админка): сессия молча не умирает — тихий refresh токена на 401, сохранение между F5"
```

---

### Task 3: Photo captions error instead of silently truncating

**Files:**
- Modify: `backend/app/services/telegram_publisher.py`
- Test: `backend/tests/test_telegram_bot.py` or new assertion in `backend/tests/test_price_posts.py`

**Interfaces:**
- Produces: `TelegramContentTooLong(TelegramPublishError)` exception; `publish_post()` raises it instead of slicing `text[:1024]` / `text[:4096]`.
- Consumed by: Task 5's `posts.py` route, which must catch `TelegramContentTooLong` before the generic `TelegramPublishError` and map it to HTTP 400.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_price_posts.py` (uses the existing `telegram` fixture that stubs `httpx.post` — check its shape at the top of that file before writing; it patches `app.services.telegram_publisher.httpx.post` or similar):

```python
def test_publish_post_rejects_oversized_caption(telegram, monkeypatch):
    from app.services.telegram_publisher import TelegramContentTooLong, publish_post

    monkeypatch.setattr("app.core.config.settings.TELEGRAM_CHANNEL_ID", "-100123")
    with pytest.raises(TelegramContentTooLong):
        publish_post(title="T", body="x" * 1100, image_url="https://example.com/a.jpg")
```

(Adjust the `telegram`/`settings` wiring to match how existing tests in this file configure `TELEGRAM_CHANNEL_ID` — copy the setup from `test_filled_post_is_published_with_buttons`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_price_posts.py::test_publish_post_rejects_oversized_caption -v`
Expected: FAIL — no `TelegramContentTooLong` yet, or `publish_post` sends silently.

- [ ] **Step 3: Implement**

In `backend/app/services/telegram_publisher.py`, add near `TelegramRateLimited`:

```python
class TelegramContentTooLong(TelegramPublishError):
    """Собранный текст поста превышает лимит Telegram (подпись к фото — 1024,
    обычное сообщение — 4096). Раньше эти случаи молча резались text[:N] —
    админ жал «Опубликовать» и получал в канале обрезанный текст с успехом
    в ответе. Теперь это явная ошибка до отправки."""
```

Add constants right below `MAX_RETRY_AFTER`:

```python
MAX_CAPTION_LENGTH = 1024
MAX_MESSAGE_LENGTH = 4096
```

Replace the body of `publish_post`'s send block:

```python
    if image_url:
        if len(text) > MAX_CAPTION_LENGTH:
            raise TelegramContentTooLong(
                f"Текст с фото ограничен {MAX_CAPTION_LENGTH} символами "
                f"(сейчас {len(text)}). Сократите текст или уберите изображение."
            )
        result = call("sendPhoto", {
            "chat_id": settings.TELEGRAM_CHANNEL_ID,
            "photo": image_url,
            "caption": text,
            "parse_mode": "HTML",
        })
    else:
        if len(text) > MAX_MESSAGE_LENGTH:
            raise TelegramContentTooLong(
                f"Текст ограничен {MAX_MESSAGE_LENGTH} символами (сейчас {len(text)})."
            )
        result = call("sendMessage", {
            "chat_id": settings.TELEGRAM_CHANNEL_ID,
            "text": text,
            "parse_mode": "HTML",
        })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_price_posts.py::test_publish_post_rejects_oversized_caption -v`
Expected: PASS

- [ ] **Step 5: Full backend suite + commit**

Run: `cd backend && python -m pytest -q`
Expected: all green (existing tests that send short posts are unaffected — only the truncation path changed).

```bash
git add backend/app/services/telegram_publisher.py backend/tests/test_price_posts.py
git commit -m "fix(канал): длинная подпись к фото больше не обрезается молча — ошибка до отправки"
```

---

### Task 4: Create editorial posts from the admin UI

**Files:**
- Modify: `admin/src/Posts.tsx`

**Interfaces:**
- Consumes: existing `POST /admin/posts` (`backend/app/api/posts.py:67`), unchanged.
- Produces: `Posts.tsx` gets a "Новый пост" button and a create flow reusing `Editor`.

- [ ] **Step 1: Widen `Editor`'s prop type and add create mode**

In `admin/src/Posts.tsx`, add above `Editor`:

```ts
type PostDraft = Pick<ChannelPost, "title" | "body" | "image_url" | "kind" | "sources">;
const BLANK_DRAFT: PostDraft = { title: "", body: "", image_url: null, kind: "news", sources: [] };
```

Change the `Editor` signature from taking `post: ChannelPost` to a generic draft, and add `isNew`:

```tsx
function Editor<T extends PostDraft>({
  post, setPost, onClose, onSave, isNew,
}: { post: T; setPost: (p: T) => void; onClose: () => void; onSave: () => void; isNew?: boolean }) {
  const limit = post.image_url ? 1024 : 4096;
  const overLimit = post.body.length > limit;
  return <div style={{ position: "fixed", inset: 0, background: "rgba(17,24,39,.45)", display: "grid", placeItems: "center", zIndex: 50, padding: 16 }} onMouseDown={onClose}>
    <div style={{ ...card, width: "min(720px, 100%)", maxHeight: "90vh", overflowY: "auto" }} onMouseDown={(e) => e.stopPropagation()}>
      <h2 style={{ marginTop: 0 }}>{isNew ? "Новый пост" : "Редактирование поста"}</h2>
      <label style={{ color: C.sub, fontSize: 13 }}>Заголовок<input style={input} value={post.title} onChange={(e) => setPost({ ...post, title: e.target.value })} /></label>
      <label style={{ color: C.sub, fontSize: 13, display: "block", marginTop: 12 }}>Текст<textarea style={{ ...input, minHeight: 190, resize: "vertical" }} value={post.body} onChange={(e) => setPost({ ...post, body: e.target.value })} /></label>
      <div style={{ color: overLimit ? C.red : C.sub, fontSize: 12, marginTop: 4 }}>
        {post.body.length}/{limit} символов{post.image_url ? " (с фото лимит короче)" : ""}
      </div>
      <label style={{ color: C.sub, fontSize: 13, display: "block", marginTop: 12 }}>URL изображения<input style={input} value={post.image_url || ""} onChange={(e) => setPost({ ...post, image_url: e.target.value || null })} /></label>
      <label style={{ color: C.sub, fontSize: 13, display: "block", marginTop: 12 }}>Источники — по одному URL на строку<textarea style={{ ...input, minHeight: 80 }} value={post.sources.join("\n")} onChange={(e) => setPost({ ...post, sources: e.target.value.split("\n").map((v) => v.trim()).filter(Boolean) })} /></label>
      <p style={{ color: C.sub, fontSize: 12 }}>
        {isNew ? "Черновик не публикуется без вашего подтверждения." : "После изменения черновика прежнее одобрение автоматически снимается. Правка уже опубликованного поста сразу обновит текст в канале."}
      </p>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button style={btnGhost} onClick={onClose}>Отмена</button>
        <button style={btn} disabled={!post.title.trim() || !post.body.trim() || overLimit} onClick={onSave}>
          {isNew ? "Создать черновик" : "Сохранить"}
        </button>
      </div>
    </div>
  </div>;
}
```

- [ ] **Step 2: Add create state + handler + button in `Posts()`**

Inside `Posts({ token })`, add:

```ts
  const [creating, setCreating] = useState<PostDraft | null>(null);

  async function createPost() {
    if (!creating) return;
    setError("");
    try {
      await apiPost("/admin/posts", token, creating);
      setCreating(null); load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
```

In the header row (the `<div style={{ display: "flex", ... }}>` that currently holds only the status filter chips), add the button before the filter chips:

```tsx
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={btn} onClick={() => setCreating({ ...BLANK_DRAFT })}>Новый пост</button>
          {["", "draft", "approved", "published", "rejected"].map((s) =>
            <button key={s || "all"} style={chip(filter === s)} onClick={() => setFilter(s)}>{s ? STATUS[s as PostStatus] : "Все"}</button>)}
        </div>
```

Render the create modal alongside the edit modal:

```tsx
      {editing && <Editor post={editing} setPost={setEditing} onClose={() => setEditing(null)} onSave={save} />}
      {creating && <Editor post={creating} setPost={setCreating} onClose={() => setCreating(null)} onSave={createPost} isNew />}
```

- [ ] **Step 3: `tsc` check**

Run: `cd admin && npx tsc --noEmit`
Expected: no errors. (If `Editor<T extends PostDraft>` inference complains at the `editing`/`save` call site, confirm `ChannelPost` still satisfies `PostDraft` structurally — it does, since `Pick<>` is a subset.)

- [ ] **Step 4: Browser verification**

1. `docker compose -f docker-compose.demo.yml restart admin` (bind-mount doesn't hot-reload per `CLAUDE.md`).
2. Open admin → "Посты" tab → click "Новый пост".
3. Fill title + body, save. Confirm the new draft appears in the list with status "Черновик".
4. Confirm "Создать черновик" is disabled while title or body is empty.

- [ ] **Step 5: Commit**

```bash
git add admin/src/Posts.tsx
git commit -m "feat(посты): создание редакционного поста из админки — раньше был только backend-эндпоинт"
```

---

### Task 5: Published editorial posts can be edited in place

**Files:**
- Modify: `backend/app/services/telegram_publisher.py` (add `edit_caption`)
- Modify: `backend/app/api/posts.py`
- Modify: `admin/src/Posts.tsx` (show "Редактировать" for published posts too)
- Test: new `backend/tests/test_posts_api.py`

**Interfaces:**
- Consumes: `edit_message()` (`telegram_publisher.py:110`) for text-only posts, `TelegramContentTooLong`/`MAX_CAPTION_LENGTH`/`MAX_MESSAGE_LENGTH` from Task 3.
- Produces: `edit_caption(*, message_id, caption, channel_id=None) -> bool` in `telegram_publisher.py`, mirroring `edit_message`'s shape. `PATCH /admin/posts/{id}` no longer 409s when `status == "published"`; it edits the live channel message and keeps status `published`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_posts_api.py`:

```python
"""API редакционных постов: создание, правка, публикация, правка после публикации."""
import pytest


def _create_and_publish(client, monkeypatch, **overrides):
    from app.services import telegram_publisher

    monkeypatch.setattr(telegram_publisher.settings, "TELEGRAM_CHANNEL_ID", "-100123")
    monkeypatch.setattr(telegram_publisher.settings, "TELEGRAM_BOT_TOKEN", "test-token")
    monkeypatch.setattr(telegram_publisher, "call", lambda method, payload: {"message_id": 555})

    payload = {"title": "T", "body": "B", "kind": "news", "sources": []}
    payload.update(overrides)
    post = client.post("/api/admin/posts", json=payload).json()
    client.post(f"/api/admin/posts/{post['id']}/approve")
    published = client.post(f"/api/admin/posts/{post['id']}/publish", json={"confirm": True})
    assert published.status_code == 200
    return published.json()


def test_published_post_edit_updates_channel_message(client, monkeypatch):
    from app.services import telegram_publisher

    post = _create_and_publish(client, monkeypatch)
    calls = []
    monkeypatch.setattr(telegram_publisher, "call",
                         lambda method, payload: calls.append((method, payload)) or {"message_id": 555})

    resp = client.patch(f"/api/admin/posts/{post['id']}", json={"body": "Новый текст"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "published"
    assert calls[0][0] == "editMessageText"
    assert calls[0][1]["message_id"] == post["telegram_message_id"]


def test_published_post_with_photo_edits_caption(client, monkeypatch):
    from app.services import telegram_publisher

    post = _create_and_publish(client, monkeypatch, image_url="https://example.com/a.jpg")
    calls = []
    monkeypatch.setattr(telegram_publisher, "call",
                         lambda method, payload: calls.append((method, payload)) or {"message_id": 555})

    resp = client.patch(f"/api/admin/posts/{post['id']}", json={"body": "Новый текст"})
    assert resp.status_code == 200
    assert calls[0][0] == "editMessageCaption"


def test_published_post_edit_rejects_oversized_caption(client, monkeypatch):
    post = _create_and_publish(client, monkeypatch, image_url="https://example.com/a.jpg")
    resp = client.patch(f"/api/admin/posts/{post['id']}", json={"body": "x" * 1100})
    assert resp.status_code == 400
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_posts_api.py -v`
Expected: FAIL — `update_post` still 409s on `status == "published"`.

(Check the `client`/`db` fixtures used elsewhere, e.g. `backend/tests/test_price_posts.py` top-of-file `conftest` usage, and mirror their import path if `client`/`db` aren't auto-available — they're standard fixtures already used across the suite per the earlier grep, so this should just work.)

- [ ] **Step 3: Add `edit_caption` to `telegram_publisher.py`**

Add after `edit_message`:

```python
def edit_caption(
    *, message_id: int, caption: str,
    channel_id: str | int | None = None,
) -> bool:
    """Переписать подпись фото ранее опубликованного сообщения.

    Отдельная ручка Bot API от editMessageText: сообщение с фото хранит текст
    в caption, а editMessageText на нём отвечает «there is no text in the
    message to edit».
    """
    payload: dict = {
        "chat_id": _channel(channel_id),
        "message_id": message_id,
        "caption": caption,
        "parse_mode": "HTML",
    }
    try:
        call("editMessageCaption", payload)
        return True
    except TelegramRateLimited:
        raise
    except TelegramPublishError as exc:
        if "not modified" in str(exc).lower():
            return False
        raise
```

- [ ] **Step 4: Rewrite `update_post` in `posts.py`**

```python
from html import escape

from app.services.telegram_publisher import (
    MAX_CAPTION_LENGTH, MAX_MESSAGE_LENGTH, TelegramContentTooLong, TelegramPublishError,
    edit_caption, edit_message, publish_post,
)


@router.patch("/{post_id}")
def update_post(post_id: int, payload: PostPatch, admin: str = Depends(get_current_admin), db: Session = Depends(get_db)):
    post = _get(db, post_id)
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(post, key, value)
    post.content_version += 1

    if post.status == "published":
        text = f"<b>{escape(post.title)}</b>\n\n{escape(post.body)}".strip()
        limit = MAX_CAPTION_LENGTH if post.image_url else MAX_MESSAGE_LENGTH
        if len(text) > limit:
            db.rollback()
            raise HTTPException(400, f"Текст{' с фото' if post.image_url else ''} ограничен {limit} символами (сейчас {len(text)})")
        try:
            if post.image_url:
                edit_caption(message_id=post.telegram_message_id, caption=text)
            else:
                edit_message(message_id=post.telegram_message_id, text=text)
        except TelegramPublishError as exc:
            db.rollback()
            raise HTTPException(502, str(exc)) from exc
        post.approved_version = post.content_version
    else:
        # Правка неопубликованного поста снимает одобрение — публиковать
        # непроверенный контент нельзя.
        post.status = "draft"
        post.approved_version = None

    _audit(db, admin, "post_edited", post.id)
    db.commit()
    db.refresh(post)
    return _out(post)
```

Also update `publish()`'s exception handling to catch `TelegramContentTooLong` before the generic branch (it's a subclass, so the existing `except TelegramPublishError` would otherwise swallow it as a 502 instead of 400):

```python
    try:
        message_id = publish_post(title=post.title, body=post.body, image_url=post.image_url)
    except TelegramContentTooLong as exc:
        raise HTTPException(400, str(exc)) from exc
    except TelegramPublishError as exc:
        raise HTTPException(502, str(exc)) from exc
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_posts_api.py -v`
Expected: PASS (all 4, including the pre-existing implicit coverage — check no other test in the suite asserted the old 409-on-published behavior; grep first: `grep -rn "Published posts cannot be edited" backend/tests/`).

If a test elsewhere asserts the removed 409, update it to match the new behavior (published posts are now editable) rather than deleting coverage.

- [ ] **Step 6: Full backend suite**

Run: `cd backend && python -m pytest -q`
Expected: all green.

- [ ] **Step 7: Update `Posts.tsx` to show "Редактировать" for published posts**

In `PostCard`, change:

```tsx
{post.status !== "published" && <button style={btnGhost} onClick={onEdit}>Редактировать</button>}
```

to:

```tsx
<button style={btnGhost} onClick={onEdit}>Редактировать</button>
```

- [ ] **Step 8: `tsc` check + browser verification**

Run: `cd admin && npx tsc --noEmit`

Then: `docker compose -f docker-compose.demo.yml restart admin`. In the admin UI, publish a test post (or use one already published), click "Редактировать" on it, change the text, save. Confirm no 409 and the post stays status "Опубликован".

- [ ] **Step 9: Commit**

```bash
git add backend/app/services/telegram_publisher.py backend/app/api/posts.py backend/tests/test_posts_api.py admin/src/Posts.tsx
git commit -m "fix(посты): опубликованный редакционный пост теперь можно править — правка обновляет то же сообщение в канале"
```

---

### Task 6: "Новый пост"/"Редактировать" in Посты канала stop failing silently

**Files:**
- Modify: `admin/src/ChannelPosts.tsx:69`

**Interfaces:** none — purely a UX fix, no new exports.

- [ ] **Step 1: Fix the swallowed error**

Change:

```ts
  useEffect(() => { apiGet<KindsResp>("/admin/price-posts/info/button-kinds", token).then(setKinds).catch(() => {}); }, [token]);
```

to:

```ts
  useEffect(() => {
    apiGet<KindsResp>("/admin/price-posts/info/button-kinds", token)
      .then(setKinds)
      .catch((e) => setError(e instanceof Error ? e.message : "Не удалось загрузить типы кнопок — «Новый пост» и «Редактировать» не откроются"));
  }, [token]);
```

- [ ] **Step 2: Browser verification**

1. `docker compose -f docker-compose.demo.yml restart admin`.
2. Open admin → "Посты канала". Confirm "Новый пост"/"Редактировать" still open the editor normally (happy path unaffected).
3. To confirm the failure path shows feedback now: temporarily block the request (devtools → Network → block request URL matching `button-kinds`) and reload the tab; confirm the red error banner appears instead of a silently dead button. Unblock afterward.

- [ ] **Step 3: `tsc` check + commit**

Run: `cd admin && npx tsc --noEmit`

```bash
git add admin/src/ChannelPosts.tsx
git commit -m "fix(канал): сбой загрузки типов кнопок больше не глушится молча — видно ошибку вместо мёртвых кнопок"
```

---

## Final Verification

- [ ] `cd backend && python -m pytest -q` — full green.
- [ ] `cd admin && npx tsc --noEmit && npm run build` — clean.
- [ ] `cd frontend && npx tsc --noEmit && npx vitest run && npm run build` — unaffected by this plan, run to confirm no collateral damage.
- [ ] Manual pass in browser through all six fixes per their individual verification steps.
