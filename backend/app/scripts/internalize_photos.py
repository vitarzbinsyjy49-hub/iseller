"""Перенести фото товаров с чужих сайтов к себе в /api/uploads.

Зачем. Импорт умеет класть в карточку внешний адрес — это быстро, но каталог
начинает зависеть от чужого сайта. История с rocketniks.ru показала, чем это
кончается: источник лёг, и разом осиротели все фото, которые он раздавал. У
ритейлеров адреса вдобавок меняются при каждой пересборке карточки товара.

Скрипт находит товары, у которых картинка ведёт наружу, качает файл и
перекладывает его в наш UPLOAD_DIR через тот же save_image, что и загрузка из
админки. Ссылки в image/images переписываются на /api/uploads/...

Правило `dry-run -> confirm`, как и везде в проекте: без --confirm ничего не
качается и база не меняется, печатается только план.

    # посмотреть, что будет сделано
    docker compose -f docker-compose.prod.yml exec -T backend \\
        python -m app.scripts.internalize_photos

    # перенести
    docker compose -f docker-compose.prod.yml exec -T backend \\
        python -m app.scripts.internalize_photos --confirm
"""
from __future__ import annotations

import argparse
import sys

import httpx

from app.core.uploads import save_image
from app.db.session import SessionLocal
from app.models.product import Product

#: Один и тот же файл просят несколько карточек (у Mac mini кадр общий на пять
#: позиций, у iPhone — на все варианты памяти одного цвета). Качаем один раз.
_done: dict[str, str] = {}

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")

#: Scene7 на несуществующий ассет отвечает НЕ 404, а 403 с text/plain
#: «Unable to find image». Поэтому проверяем content-type, а не только код.
ALLOWED_TYPES = ("image/jpeg", "image/png", "image/webp")


def is_external(url: str | None) -> bool:
    """Чужой ли адрес. Корневые пути (/api/uploads/..., /assets/...) — наши:
    первые раздаёт backend, вторые лежат в бандле фронтенда. Внешнее — только
    то, что начинается со схемы; иначе скрипт полез бы качать '/assets/...' и
    затёр бы карточку промо-комплекта и плейсхолдеры."""
    if not url:
        return False
    return url.startswith("http://") or url.startswith("https://")


def fetch(url: str) -> str | None:
    """Скачать и сохранить у себя. Возвращает наш путь либо None."""
    if url in _done:
        return _done[url]
    try:
        r = httpx.get(url, timeout=60, follow_redirects=True, headers={"User-Agent": UA})
        r.raise_for_status()
    except Exception as exc:  # noqa: BLE001 — сеть, причин отказа много
        print(f"   !! {url[:90]}: {exc}")
        return None

    ctype = r.headers.get("content-type", "").split(";")[0].strip()
    if ctype not in ALLOWED_TYPES:
        print(f"   !! {url[:90]}: неожиданный тип {ctype!r}")
        return None

    local = save_image(ctype, r.content)
    _done[url] = local
    return local


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirm", action="store_true",
                        help="Скачать и переписать ссылки. Без флага — сухой прогон")
    args = parser.parse_args()

    db = SessionLocal()
    products = db.query(Product).order_by(Product.id).all()
    targets = [
        p for p in products
        if is_external(p.image) or any(is_external(u) for u in (p.images or []))
    ]

    urls = {u for p in targets for u in ([p.image] + list(p.images or [])) if is_external(u)}
    print(f"товаров с внешними фото: {len(targets)}")
    print(f"уникальных файлов скачать: {len(urls)}")
    hosts: dict[str, int] = {}
    for u in urls:
        host = u.split("/")[2] if "://" in u else "?"
        hosts[host] = hosts.get(host, 0) + 1
    for host, n in sorted(hosts.items(), key=lambda kv: -kv[1]):
        print(f"   {host:38} {n}")

    if not args.confirm:
        print("\nСухой прогон. Чтобы перенести — повторить с --confirm.")
        return

    moved = failed = 0
    for p in targets:
        gallery: list[str] = []
        for u in (p.images or []):
            gallery.append(fetch(u) or u if is_external(u) else u)
        new_main = fetch(p.image) if is_external(p.image) else p.image
        if new_main and new_main not in gallery:
            gallery.insert(0, new_main)

        still_external = [u for u in gallery if is_external(u)] + (
            [new_main] if is_external(new_main) else [])
        if still_external:
            failed += 1
            continue

        p.images = gallery
        p.image = new_main or (gallery[0] if gallery else None)
        moved += 1

    db.commit()
    print(f"\nперенесено товаров: {moved}, не удалось: {failed}, "
          f"файлов скачано: {len(_done)}")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
