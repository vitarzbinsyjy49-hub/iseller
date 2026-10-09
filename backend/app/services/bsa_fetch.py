"""Чтение прайса BSA: публичные посты канала и выгрузка result.json.

Канал BSA (t.me/BigSaleApple) публичный, а прайс у них — одни и те же
сообщения, которые они каждый день редактируют. Публичный виджет поста
(t.me/<канал>/<id>?embed=1) отдаёт актуальный текст без аккаунта — проверено
с нашего сервера через WARP 07.10.2026.

Чего виджет НЕ отдаёт: посты в новом rich-формате («Please open Telegram to view
this post») — iPhone, Apple Watch S11/S12, стайлеры и фены Dyson. Их источник —
выгрузка result.json, которую админ присылает боту (parse_export), или в будущем
служебный аккаунт (Telethon ≥1.45 понимает RichMessage).
"""
from __future__ import annotations

import html
import json
import logging
import re

import httpx

from app.core.config import settings

logger = logging.getLogger("techshop.bsa_fetch")

CHANNEL = "BigSaleApple"

#: Посты-прайсы BSA, которые читаются публичным виджетом. Номера постоянные:
#: BSA правит те же сообщения. Новый пост у BSA = новая строка здесь.
PUBLIC_POSTS: dict[int, str] = {
    12459: "MacBook Air", 12463: "MacBook Pro", 12455: "iMac, Mac mini, мониторы",
    12252: "AirPods и аксессуары", 12304: "iPad Pro", 12255: "iPad Air M4",
    12266: "iPad Air M2/M3", 12149: "Watch SE", 12150: "Watch Ultra",
    11187: "PlayStation", 12116: "Dyson очистители", 12862: "Dyson пылесосы",
}

_TEXT_RE = re.compile(r'<div class="tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>\s*<div class="tgme_widget_message_footer', re.S)


def embed_to_text(page: str) -> str | None:
    m = _TEXT_RE.search(page)
    if not m:
        return None
    body = re.sub(r"<br\s*/?>", "\n", m.group(1))
    return html.unescape(re.sub(r"<[^>]+>", "", body))


def fetch_post(post_id: int, client: httpx.Client) -> str | None:
    r = client.get(f"https://t.me/{CHANNEL}/{post_id}", params={"embed": "1", "mode": "tme"})
    r.raise_for_status()
    return embed_to_text(r.text)


def fetch_public_posts() -> tuple[dict[int, str], list[int]]:
    """{post_id: текст} и список постов, которые прочитать не удалось."""
    kwargs: dict = {"timeout": 40, "follow_redirects": True}
    if settings.TELEGRAM_PROXY_URL:
        kwargs["proxy"] = settings.TELEGRAM_PROXY_URL
    texts: dict[int, str] = {}
    failed: list[int] = []
    with httpx.Client(**kwargs) as client:
        for post_id in PUBLIC_POSTS:
            text = None
            for _attempt in range(3):            # WARP иногда моргает — пара повторов
                try:
                    text = fetch_post(post_id, client)
                    break
                except httpx.HTTPError as exc:
                    logger.warning("BSA %s: %s", post_id, exc)
            if text:
                texts[post_id] = text
            else:
                failed.append(post_id)
    return texts, failed


# ------------------------------------------------------------- result.json ----
def _flatten(t) -> str:
    if isinstance(t, str):
        return t
    return "".join(c if isinstance(c, str) else c.get("text", "") for c in t or [])


def _rich(node) -> str:
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        return "".join(_rich(x) for x in node)
    if isinstance(node, dict):
        if node.get("type") == "paragraph":
            return _rich(node.get("text")) + "\n"
        if "blocks" in node:
            return "".join(_rich(b) for b in node["blocks"])
        if "text" in node:
            return _rich(node["text"])
    return ""


def export_channel(raw: bytes) -> str:
    """Название канала из result.json («BSA Store», «apostl price»)."""
    return str(json.loads(raw.decode("utf-8")).get("name") or "")


def export_source(name: str) -> str | None:
    """bsa | apostl | None (чужой канал — не принимаем)."""
    low = name.lower()
    if "bsa" in low or "big sale" in low or "bigsale" in low:
        return "bsa"
    if "apostl" in low or "apostle" in low:
        return "apostl"
    return None


def parse_export(raw: bytes) -> dict[int, str]:
    """result.json из Telegram Desktop -> {id сообщения: текст}. И text, и rich_message
    (у rich-постов text пустой — docs/context/bsa-price-sync.md)."""
    data = json.loads(raw.decode("utf-8"))
    out: dict[int, str] = {}
    for m in data.get("messages", []):
        if m.get("type") != "message":
            continue
        text = _flatten(m.get("text", "")) or _rich(m.get("rich_message"))
        if text.strip():
            out[int(m["id"])] = text
    return out
