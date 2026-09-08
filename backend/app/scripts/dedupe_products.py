"""Свести задвоенные карточки: один товар — одна карточка.

Откуда берутся дубли. В каталог льют два разных импорта: `import_bsa`
(source='bsa', SKU вида IP-17-256-BLUE-IN-SIM) и Import Center (source='import',
SKU вида APL-IP17-256-BLU-IN). Схемы артикулов у них разные, поэтому один и тот
же телефон заводится дважды, с двумя ценами — покупатель видит две одинаковые
строки и берёт ту, что дешевле.

Что считаем дублем: полностью совпадающее название при разных SKU. Название
несёт память, цвет, регион и SIM, то есть всё, что отличает позиции друг от
друга, — совпало оно, значит это один товар.

Какую карточку оставляем: от BSA. Цена там посчитана по правилу владельца
(цена BSA минус NAKIDKA), и она же ниже — см. docs/context/bsa-price-sync.md.
Вторая не удаляется, а гасится (is_active=False): удаление необратимо, а
выключенная карточка не показывается покупателю и легко возвращается.

Правило `dry-run -> confirm`, как везде в проекте: без --confirm ничего не
меняется.

    docker compose -f docker-compose.prod.yml exec -T backend \\
        python -m app.scripts.dedupe_products
    docker compose -f docker-compose.prod.yml exec -T backend \\
        python -m app.scripts.dedupe_products --confirm
"""
from __future__ import annotations

import argparse
from collections import defaultdict

from app.db.session import SessionLocal
from app.models.product import Product

#: Источник, чья карточка выигрывает при совпадении названий.
PREFERRED_SOURCE = "bsa"


def title_key(product: Product) -> str:
    return " ".join((product.title or "").lower().split())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirm", action="store_true",
                        help="Погасить лишние карточки. Без флага — сухой прогон")
    args = parser.parse_args()

    db = SessionLocal()
    groups: dict[str, list[Product]] = defaultdict(list)
    for p in db.query(Product).filter(Product.is_active.is_(True)).all():
        groups[title_key(p)].append(p)

    to_disable: list[tuple[Product, Product]] = []
    unresolved: list[list[Product]] = []

    for group in groups.values():
        if len(group) < 2:
            continue
        keep = [p for p in group if (p.source or "") == PREFERRED_SOURCE]
        drop = [p for p in group if (p.source or "") != PREFERRED_SOURCE]
        # Обе карточки из одного источника — это НЕ наша ошибка склейки, а две
        # разных позиции у поставщика (так BSA печатает Magic Keyboard двумя
        # строками с разными артикулами). Такие не трогаем: решать, одна это
        # вещь или две, должен владелец, а не скрипт.
        if len(keep) != 1 or not drop:
            unresolved.append(group)
            continue
        for d in drop:
            to_disable.append((keep[0], d))

    print(f"пар к сведению: {len(to_disable)}")
    for keep, drop in to_disable:
        keep_photo = "фото есть" if keep.image else "БЕЗ ФОТО"
        drop_photo = "фото есть" if drop.image else "без фото"
        print(f"\n  {keep.title[:60]}")
        print(f"    оставляем  {keep.sku:32} {int(keep.price):>8}  {keep.source:8} {keep_photo}")
        print(f"    гасим      {drop.sku:32} {int(drop.price):>8}  {drop.source:8} {drop_photo}")
        if not keep.image and drop.image:
            print("    !! у остающейся карточки нет фото, а у гасимой есть — перенести вручную")

    if unresolved:
        print(f"\nтребуют решения владельца: {len(unresolved)}")
        for group in unresolved:
            print(f"  {group[0].title[:60]}")
            for p in group:
                print(f"    {p.sku:32} {int(p.price):>8}  {p.source}")

    if not args.confirm:
        print("\nСухой прогон. Чтобы применить — повторить с --confirm.")
        return

    for _keep, drop in to_disable:
        drop.is_active = False
    db.commit()
    print(f"\nпогашено карточек: {len(to_disable)}")


if __name__ == "__main__":
    main()
