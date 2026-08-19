#!/usr/bin/env python3
"""Создать/обновить/опубликовать инфо-пост канала через admin API — без SSH.

Раньше единственный способ опубликовать rich-пост (Bot API 10.1
sendRichMessage) без готового поста в БД был SSH + `docker compose exec -T
backend python -c "..."` с инлайновым Python и ручным экранированием кавычек:
работает один раз, но пост не попадает в `ChannelPost` и потом невидим и
нередактируем в самой админке. Этот скрипт делает то же самое через уже
протестированный HTTP admin API (`backend/app/api/price_posts.py`), поэтому
пост всегда оказывается в БД и виден в админке, публикация и правка — на
одном и том же `message_id`.

Правило `parse -> preview -> apply`, как и везде в проекте: сначала
показывается превью (длина/лимит/незаполненные плейсхолдеры), публикация —
только с явным флагом --publish. Без --publish пост только сохраняется
черновиком в БД, в канал ничего не уходит.

Rich-HTML и body передаются ФАЙЛОМ, а не инлайн-текстом в команде — так не
приходится воевать с экранированием кавычек в HTML.

Требует ADMIN_EMAIL/ADMIN_PASSWORD — по умолчанию берутся из .env в корне
репозитория (тот же файл, что читает локальный backend); либо задайте их в
окружении явно. Локальный .env и боевой /opt/techshop/.env не совпадают
автоматически — при 401 от /auth/admin/login первым делом свериться с тем,
какой пароль реально стоит на сервере.

Примеры:

    # черновик (ничего не публикуется)
    python scripts/publish_channel_post.py \\
        --slug sim_esim_guide --title "Гид: SIM и eSIM" \\
        --body-file post.txt --rich-html-file post.html \\
        --buttons-file buttons.json

    # то же самое, но сразу в канал
    python scripts/publish_channel_post.py \\
        --slug sim_esim_guide --title "Гид: SIM и eSIM" \\
        --body-file post.txt --rich-html-file post.html --publish

buttons.json — JSON-массив кнопок в формате конструктора админки:
    [{"text": "🛍 Открыть каталог", "kind": "catalog", "row": 0},
     {"text": "Своя ссылка", "kind": "url", "value": "https://...", "row": 1}]
Список типов kind — GET /api/admin/price-posts/info/button-kinds.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import httpx

for _stream in (sys.stdout, sys.stderr):  # консоль Windows по умолчанию не UTF-8
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BASE_URL = "https://158.255.1.248.sslip.io"
DEFAULT_ENV_FILE = REPO_ROOT / ".env"


def _load_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def _admin_credentials(env_file: Path) -> tuple[str, str]:
    email = os.environ.get("ADMIN_EMAIL")
    password = os.environ.get("ADMIN_PASSWORD")
    if email and password:
        return email, password
    values = _load_env_file(env_file)
    email = email or values.get("ADMIN_EMAIL")
    password = password or values.get("ADMIN_PASSWORD")
    if not email or not password:
        print(f"ADMIN_EMAIL/ADMIN_PASSWORD не найдены ни в окружении, ни в {env_file}",
              file=sys.stderr)
        sys.exit(2)
    return email, password


def _read_file(path: str | None) -> str | None:
    if path is None:
        return None
    return Path(path).read_text(encoding="utf-8")


def _read_buttons(path: str | None) -> list[dict] | None:
    if path is None:
        return None
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, list):
        print("--buttons-file должен содержать JSON-массив кнопок", file=sys.stderr)
        sys.exit(2)
    return data


def _fail(resp: httpx.Response, what: str) -> None:
    print(f"{what} не удалось ({resp.status_code}): {resp.text}", file=sys.stderr)
    sys.exit(1)


def login(client: httpx.Client, base_url: str, email: str, password: str) -> str:
    resp = client.post(f"{base_url}/api/auth/admin/login", json={"email": email, "password": password})
    if resp.status_code != 200:
        _fail(resp, "Вход")
    return resp.json()["access_token"]


def find_post(client: httpx.Client, base_url: str, headers: dict, slug: str) -> dict | None:
    resp = client.get(f"{base_url}/api/admin/price-posts", headers=headers)
    resp.raise_for_status()
    for post in resp.json()["posts"]:
        if post["slug"] == slug:
            return post
    return None


def show_rich_preview(client: httpx.Client, base_url: str, headers: dict, rich_html: str) -> None:
    resp = client.post(f"{base_url}/api/admin/price-posts/info/rich-preview",
                        headers=headers, json={"rich_html": rich_html})
    resp.raise_for_status()
    data = resp.json()
    status = " — ПРЕВЫШЕН ЛИМИТ" if data["over_limit"] else ""
    print(f"Превью rich-контента: {data['length']}/{data['limit']} символов{status}")
    if data["has_placeholders"]:
        print("В тексте остались незаполненные плейсхолдеры [уточнить] — публикация будет отклонена")
    if data["over_limit"]:
        print("Останавливаюсь: превышен лимит длины rich-сообщения.", file=sys.stderr)
        sys.exit(1)


def save_draft(client: httpx.Client, base_url: str, headers: dict, args: argparse.Namespace,
               body: str | None, rich_html: str | None, buttons: list[dict] | None,
               existing: dict | None) -> dict:
    if existing is None:
        if not args.title or body is None:
            print("Нового поста ещё нет — нужны --title и --body-file", file=sys.stderr)
            sys.exit(2)
        payload: dict = {"slug": args.slug, "title": args.title, "body": body}
        if rich_html is not None:
            payload["rich_html"] = rich_html
        if buttons is not None:
            payload["buttons"] = buttons
        if args.image_url is not None:
            payload["image_url"] = args.image_url
        resp = client.post(f"{base_url}/api/admin/price-posts/info", headers=headers, json=payload)
        action = "создан"
    else:
        payload = {}
        if args.title is not None:
            payload["title"] = args.title
        if body is not None:
            payload["body"] = body
        if rich_html is not None:
            payload["rich_html"] = rich_html
        if buttons is not None:
            payload["buttons"] = buttons
        if args.image_url is not None:
            payload["image_url"] = args.image_url
        if not payload:
            print("Пост уже существует, но менять нечего — не передано ни одного поля", file=sys.stderr)
            sys.exit(2)
        resp = client.patch(f"{base_url}/api/admin/price-posts/info/{args.slug}",
                            headers=headers, json=payload)
        action = "обновлён"

    if resp.status_code >= 400:
        _fail(resp, "Сохранение черновика")
    post = resp.json()
    print(f"Черновик {action}: slug={post['slug']!r}, "
          f"длина={post['length']}/{post['length_limit']}, "
          f"telegram_message_id={post['telegram_message_id']}")
    return post


def publish(client: httpx.Client, base_url: str, headers: dict, slug: str) -> None:
    resp = client.post(f"{base_url}/api/admin/price-posts/info/publish", headers=headers,
                       json={"confirm": True, "slugs": [slug]})
    if resp.status_code >= 400:
        _fail(resp, "Публикация")
    result = resp.json()
    print(f"Публикация: created={result['created']}, updated={result['updated']}, "
          f"unchanged={result['unchanged']}, failed={result['failed']}")
    if result["failed"]:
        sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--slug", required=True, help="Идентификатор поста (латиница/цифры/_)")
    parser.add_argument("--title", help="Заголовок (нужен при создании нового поста)")
    parser.add_argument("--body-file", help="Файл с обычным текстом поста (fallback без rich)")
    parser.add_argument("--rich-html-file", help="Файл с rich_message.html (Bot API 10.1)")
    parser.add_argument("--buttons-file", help="JSON-файл со списком кнопок")
    parser.add_argument("--image-url", help="URL картинки для обычного (не rich) поста")
    parser.add_argument("--publish", action="store_true",
                        help="Опубликовать в канал. Без флага — только черновик в БД.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help=f"По умолчанию {DEFAULT_BASE_URL}")
    parser.add_argument("--env-file", default=str(DEFAULT_ENV_FILE),
                        help="Файл с ADMIN_EMAIL/ADMIN_PASSWORD (по умолчанию .env в корне репо)")
    args = parser.parse_args()

    body = _read_file(args.body_file)
    rich_html = _read_file(args.rich_html_file)
    buttons = _read_buttons(args.buttons_file)

    email, password = _admin_credentials(Path(args.env_file))
    base_url = args.base_url.rstrip("/")

    with httpx.Client(timeout=30) as client:
        token = login(client, base_url, email, password)
        headers = {"Authorization": f"Bearer {token}"}

        if rich_html is not None:
            show_rich_preview(client, base_url, headers, rich_html)

        existing = find_post(client, base_url, headers, args.slug)
        save_draft(client, base_url, headers, args, body, rich_html, buttons, existing)

        if not args.publish:
            print("Черновик сохранён в БД, в канал НЕ отправлен. Добавьте --publish, чтобы опубликовать.")
            return

        publish(client, base_url, headers, args.slug)


if __name__ == "__main__":
    main()
