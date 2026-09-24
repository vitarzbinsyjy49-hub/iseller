"""Кадр для поста «iPhone 18 Pro в наличии» — из настоящих пресс-кадров Apple.

Те же приёмы, что у поста о предзаказе (compose_preorder_banner.py): вырезаем
аппарат из белого фона и кладём на фон экрана события, чтобы два поста одной
линейки звучали в один тон. Отличие — в сюжете: предзаказ показывал линейку,
этот пост говорит «приехали, выбирайте цвет», поэтому в кадре все четыре цвета
18 Pro, сеткой 2×2.

Pro Max в кадр не входит по той же причине, что и в прошлый раз: его пресс-кадр
отличается от Pro только пропорцией корпуса и рядом читался бы как дубль.

    python scripts/compose_instock_18.py [путь.webp]
"""
from __future__ import annotations

import sys

from PIL import Image

from compose_preorder_banner import (FIELD_LEFT, FIELD_RIGHT, H, POST_H, POST_W, SRC, W,
                                     _place_row, _row, cutout, gradient, scaled)

OUT = "backend/app/scripts/data/iphone18-instock-post.webp"

#: Порядок — от яркого к спокойному: burgundy открывает кадр как главный цвет
#: поколения, чёрный замыкает.
COLORS = (("burgundy", "glacier"), ("silver", "black"))

#: Высота пары «спинка + экран». 2 × 500 + зазор оставляют ровные поля ~70px
#: сверху и снизу; крупнее — сетка упирается в края 4:3.
PAIR_H = 500
GAP_Y = 60
#: Поле по бокам. Пара шириной ~415px: при поле 80 между столбцами зияла дыра
#: в 600px и кадр разваливался на две половины — сводим столбцы к центру.
MARGIN_X = 300

#: Свой порог отделения фона. Silver почти одного тона с белым фоном Apple, и
#: на общем пороге 26 заливка от края съедала пол-спинки вместе с камерами.
TOLERANCE = {"silver": 6}


def compose(out: str | None = None) -> None:
    canvas = gradient(POST_W, POST_H)
    rows = [_row([cutout(f"{SRC}/iphone18pro-{c}.jpg", TOLERANCE.get(c, 26)) for c in pair], PAIR_H)
            for pair in COLORS]

    row_h = max(it.height for it in rows[0])
    block = 2 * row_h + GAP_Y
    top = (POST_H - block) // 2
    _place_row(canvas, rows[0], top, margin=MARGIN_X)
    _place_row(canvas, rows[1], top + row_h + GAP_Y, margin=MARGIN_X)

    target = out or OUT
    canvas.convert("RGB").save(target, "WEBP", quality=90, method=6)
    print(f"{target}: {Image.open(target).size}, поля {top}px сверху и снизу")


BANNER_OUT = "frontend/public/assets/promos/iphone18-instock.webp"


def compose_banner(out: str | None = None) -> None:
    """Тот же сюжет для первого баннера главной, но в его раме: левая треть
    пустая — HeroBanner кладёт туда заголовок (FIELD_LEFT в соседнем скрипте).
    Сетка 2×2 целиком в правой зоне."""
    canvas = gradient(W, H)
    pair_h = 480
    gap_y = 50
    pairs = [[scaled(cutout(f"{SRC}/iphone18pro-{c}.jpg", TOLERANCE.get(c, 26)), pair_h)
              for c in row] for row in COLORS]
    span = FIELD_RIGHT - FIELD_LEFT
    top = (H - (2 * pair_h + gap_y)) // 2
    for r, row in enumerate(pairs):
        total = sum(p.width for p in row)
        gap = (span - total) // 3
        assert gap > 30, f"не помещается: {gap}"
        x = FIELD_LEFT + gap
        for p in row:
            canvas.alpha_composite(p, (x, top + r * (pair_h + gap_y)))
            x += p.width + gap
    target = out or BANNER_OUT
    canvas.convert("RGB").save(target, "WEBP", quality=90, method=6)
    print(f"{target}: {Image.open(target).size}")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--banner"]:
        compose_banner(sys.argv[2] if len(sys.argv) > 2 else None)
    else:
        compose(sys.argv[1] if len(sys.argv) > 1 else None)
