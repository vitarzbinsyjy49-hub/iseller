"""Читатель прайсов: BSA Store и apostl price -> бэкенд АйСеллера.

Живёт на финском сервере (`ssh fi`): с основного VPS MTProto режется. Заходит под
аккаунтом владельца ТОЛЬКО НА ЧТЕНИЕ — ничего не отправляет, не вступает, не
отмечает прочитанным. Отдаёт тексты постов на POST /api/price-ingest; вся сверка
(цена = BSA − 500, порог, отчёт, правка постов канала) — на стороне бэкенда.

    reader.py login          один раз, руками: API_ID/API_HASH, телефон, код, 2FA
    reader.py ping           токен и связь с бэкендом
    reader.py probe          что видит аккаунт; сырой вид постов -> data/probe/
    reader.py run [--dry]    прочитать и отправить (--dry: только показать)

Секреты (api_hash, сессия) лежат ТОЛЬКО в DATA_DIR с правами 600 и в репозиторий
не попадают. В логи и вывод они не пишутся.
"""
from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import os
import re
import sys
import time
from pathlib import Path

import httpx
from telethon import TelegramClient, functions, types
from telethon.errors import FloodWaitError

DATA = Path(os.environ.get("DATA_DIR", "/data"))
INGEST_URL = os.environ.get("INGEST_URL", "").rstrip("/")
TOKEN = os.environ.get("READER_TOKEN", "")
CREDS = DATA / "credentials.json"
SESSION = str(DATA / "owner")


def log(msg: str) -> None:
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


def _secure(path: Path) -> None:
    try:
        path.chmod(0o600)
    except OSError:
        pass


def load_creds() -> dict:
    if not CREDS.exists():
        sys.exit("Нет credentials.json — сначала: reader.py login")
    return json.loads(CREDS.read_text(encoding="utf-8"))


def make_client() -> TelegramClient:
    c = load_creds()
    return TelegramClient(SESSION, int(c["api_id"]), c["api_hash"], flood_sleep_threshold=30)


# ---------------------------------------------------------------- тексты ----
_SKIP = {"_", "type", "entities", "reply_markup", "peer_id", "from_id", "date", "id"}


def _collect(node, out: list[str]) -> None:
    """Текст из дерева rich-сообщения. У такого поста `message` пуст, а текст лежит в
    blocks -> paragraph -> text/concat (docs/context/bsa-price-sync.md): фрагменты
    склеиваются в строку, абзац заканчивается переводом строки."""
    if isinstance(node, str):
        out.append(node)
    elif isinstance(node, list):
        for x in node:
            _collect(x, out)
    elif isinstance(node, dict):
        for key, value in node.items():
            if key not in _SKIP:
                _collect(value, out)
        tag = f"{node.get('type', '')} {node.get('_', '')}".lower()
        if "paragraph" in tag or "heading" in tag or "list" in tag:
            out.append("\n")


def message_text(m) -> str:
    """Обычный текст поста или, если он пуст, текст из rich-разметки."""
    if getattr(m, "message", None):
        return m.message
    out: list[str] = []
    d = m.to_dict()
    for key in ("rich_message", "rich", "media"):
        if d.get(key):
            _collect(d[key], out)
    return "\n".join(line.strip() for line in "".join(out).splitlines() if line.strip())


# ------------------------------------------------------------------- Telegram ----
async def find_dialog(client: TelegramClient, needles: list[str]):
    low = [n.lower() for n in needles]
    async for d in client.iter_dialogs():
        title = (d.name or "").lower()
        if any(n in title for n in low):
            return d.entity
    return None


PRICE_LINE = re.compile(r"[-—]\s*\d{2,3}[.\s]?\d{3}")
_LINK = re.compile(r"t\.me/(?:c/(?P<cid>\d+)|(?P<name>[A-Za-z0-9_]{4,}))/(?P<mid>\d+)")


def button_links(msg) -> list[tuple[str | None, str | None, int]]:
    """Url-кнопки сообщения -> (id канала | None, username | None, id поста)."""
    out = []
    for row in msg.buttons or []:
        for b in row:
            url = getattr(b, "url", None)
            m = _LINK.search(url or "")
            if m:
                out.append((m.group("cid"), (m.group("name") or "").lower() or None, int(m.group("mid"))))
    return out


async def read_bsa(client, cfg: dict) -> tuple[dict[int, str], list[int]]:
    ent = await find_dialog(client, cfg["bsa_titles"])
    if ent is None:
        raise RuntimeError("канал BSA не найден среди чатов аккаунта")
    ids = cfg["bsa_posts"]
    texts: dict[int, str] = {}
    failed: list[int] = []
    for i in range(0, len(ids), 50):
        for pid, m in zip(ids[i:i + 50], await client.get_messages(ent, ids=ids[i:i + 50])):
            t = message_text(m) if m else ""
            if t.strip():
                texts[pid] = t
            else:
                failed.append(pid)
    return texts, failed


async def read_apostl(client, cfg: dict) -> tuple[dict[int, str], list[int]]:
    """Закреп apostl price — меню из url-кнопок; цены лежат в постах-разделах, на
    которые кнопки ведут. Идём по кнопкам, берём посты ТОГО ЖЕ канала."""
    ent = await find_dialog(client, cfg["apostl_titles"])
    if ent is None:
        raise RuntimeError("apostl price не найден среди чатов аккаунта")
    pinned = await client.get_messages(ent, filter=types.InputMessagesFilterPinned(), limit=5)
    username = (getattr(ent, "username", None) or "").lower()
    ids: set[int] = set()
    for msg in pinned:
        for cid, name, mid in button_links(msg):
            if (cid and int(cid) == ent.id) or (name and name == username):
                ids.add(mid)
    texts: dict[int, str] = {}
    failed: list[int] = []
    for pid, m in zip(sorted(ids), await client.get_messages(ent, ids=sorted(ids)) if ids else []):
        t = message_text(m) if m else ""
        if t.strip():
            texts[pid] = t
        else:
            failed.append(pid)
    for m in pinned:                                    # сам закреп — тоже справка
        t = message_text(m)
        if t.strip():
            texts.setdefault(m.id, t)
    return texts, failed


# ------------------------------------------------------------------ backend ----
def backend(method: str, path: str, **kw) -> httpx.Response:
    if not INGEST_URL or not TOKEN:
        sys.exit("Нужны INGEST_URL и READER_TOKEN (файл .env)")
    r = httpx.request(method, INGEST_URL + path, headers={"X-Reader-Token": TOKEN}, timeout=90, **kw)
    return r


def push(source: str, texts: dict[int, str], failed: list[int]) -> dict:
    last = None
    for attempt in range(3):
        try:
            r = backend("POST", "", json={"source": source, "texts": {str(k): v for k, v in texts.items()},
                                          "failed": failed})
            if r.status_code == 200:
                return r.json()
            if r.status_code in (401, 422, 503):          # повтор не поможет
                sys.exit(f"бэкенд отклонил {source}: {r.status_code} {r.text[:200]}")
            last = f"{r.status_code} {r.text[:200]}"
        except httpx.HTTPError as exc:
            last = type(exc).__name__
        time.sleep(15 * (attempt + 1))
    sys.exit(f"бэкенд недоступен ({source}): {last}")


# ----------------------------------------------------------------- команды ----
async def cmd_login(_args) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    if not CREDS.exists():
        print("API_ID и API_HASH — на https://my.telegram.org -> API development tools.")
        CREDS.write_text(json.dumps({"api_id": int(input("API_ID: ").strip()),
                                     "api_hash": getpass.getpass("API_HASH (не отображается): ").strip()}),
                         encoding="utf-8")
        _secure(CREDS)
    client = make_client()
    await client.start()                    # спросит телефон, код и пароль 2FA прямо в консоли
    me = await client.get_me()
    log(f"вошли как {me.first_name} (id {me.id}). Сессия: {SESSION}.session")
    _secure(Path(SESSION + ".session"))
    await client.disconnect()


async def cmd_ping(_args) -> None:
    r = backend("GET", "/ping")
    log(f"бэкенд: {r.status_code} {r.text[:100]}")
    if r.status_code != 200:
        sys.exit(1)
    async with make_client() as client:
        if not await client.is_user_authorized():
            sys.exit("сессия не авторизована — reader.py login")
        me = await client.get_me()
        log(f"Telegram: ок, аккаунт {me.first_name}")


async def cmd_probe(args) -> None:
    """Что видит аккаунт и как выглядят нужные посты. Сырой вид — в data/probe/,
    наружу не уходит."""
    cfg = backend("GET", "/config").json()
    out = DATA / "probe"
    out.mkdir(parents=True, exist_ok=True)
    async with make_client() as client:
        for name, needles in (("bsa", cfg["bsa_titles"]), ("apostl", cfg["apostl_titles"])):
            ent = await find_dialog(client, needles)
            print(f"[{name}] {'НЕ НАЙДЕН' if ent is None else (getattr(ent, 'title', ent.id), ent.id)}")
            if ent is None:
                continue
            sample = cfg["bsa_posts"][:] if name == "bsa" else []
            if name == "apostl":
                pins = await client.get_messages(ent, filter=types.InputMessagesFilterPinned(), limit=3)
                print(f"  закрепов: {len(pins)}; ссылок-кнопок: {sum(len(button_links(p)) for p in pins)}")
                sample = [p.id for p in pins]
            for pid in sample:
                m = (await client.get_messages(ent, ids=[pid]))[0]
                if m is None:
                    print(f"  пост {pid}: нет")
                    continue
                t = message_text(m)
                (out / f"{name}_{pid}.json").write_text(
                    json.dumps(m.to_dict(), default=str, ensure_ascii=False, indent=1), encoding="utf-8")
                prices = len(PRICE_LINE.findall(t))
                print(f"  пост {pid}: message={len(m.message or '')} симв., извлечено {len(t)} симв., "
                      f"строк с ценой ~{prices}")


def done_today() -> bool:
    """Повторный запуск таймера (10:17) не должен слать отчёт второй раз."""
    try:
        last = json.loads((DATA / "last_run.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    same_day = time.strftime("%Y-%m-%d", time.gmtime(last["at"])) == time.strftime("%Y-%m-%d", time.gmtime())
    return bool(same_day and not last.get("dry") and isinstance(last["result"].get("bsa"), dict))


async def cmd_run(args) -> None:
    if not args.dry and not args.force and done_today():
        log("сегодня уже отправлено — пропускаю (--force, чтобы повторить)")
        return
    cfg = backend("GET", "/config").json()
    result = {}
    async with make_client() as client:
        if not await client.is_user_authorized():
            sys.exit("сессия не авторизована — reader.py login")
        for source, reader in (("bsa", read_bsa), ("apostl", read_apostl)):
            try:
                texts, failed = await reader(client, cfg)
            except FloodWaitError as exc:
                log(f"{source}: Telegram просит подождать {exc.seconds} с — пропускаю")
                result[source] = "floodwait"
                continue
            except RuntimeError as exc:
                log(f"{source}: {exc}")
                result[source] = str(exc)
                continue
            log(f"{source}: прочитано {len(texts)}, не прочитано {len(failed)}")
            if args.dry:
                result[source] = {"posts": sorted(texts), "failed": failed}
            elif texts:
                result[source] = push(source, texts, failed)
                log(f"{source}: бэкенд принял {result[source]}")
            else:
                result[source] = "ничего не прочитано"
    (DATA / "last_run.json").write_text(json.dumps({"at": time.time(), "dry": args.dry, "result": result},
                                                   ensure_ascii=False), encoding="utf-8")
    if "bsa" not in result or not isinstance(result["bsa"], (dict,)):
        sys.exit("BSA не обновлён — сторож на бэкенде скажет админам")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("login", "ping", "probe"):
        sub.add_parser(name)
    run = sub.add_parser("run")
    run.add_argument("--dry", action="store_true", help="прочитать и показать, ничего не отправляя")
    run.add_argument("--force", action="store_true", help="отправить, даже если сегодня уже отправлено")
    args = ap.parse_args()
    asyncio.run({"login": cmd_login, "ping": cmd_ping, "probe": cmd_probe, "run": cmd_run}[args.cmd](args))


if __name__ == "__main__":
    main()
