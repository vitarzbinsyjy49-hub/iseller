"""Баннер линейки Apple — собран из НАСТОЯЩИХ студийных снимков, не сгенерирован.

Зачем так. Генератор рисует iPhone по памяти, а память у него до нового
поколения: в первом заходе он выдал квадратный блок камер прошлых лет, во
втором — правдоподобный, но всё равно выдуманный корпус. У нас же есть 22
пресс-кадра самих устройств. Значит задача не «нарисовать похожее», а
«вырезать настоящее и положить на свой фон» — и тогда аппараты точные, цвета
точные, а композиция полностью наша.

Фон Apple снимает почти белым (#F5F5F7), но просто отрезать по яркости нельзя:
у Duo корпус star white, у glacier — светло-голубой, и порог съел бы сами
аппараты. Поэтому убираем ТОЛЬКО тот фон, что связан с краем кадра
(заливка от рамки), — внутренние светлые пиксели остаются нетронутыми.
"""
from __future__ import annotations

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

SRC = "product-photos/preorder-apple-2026"
OUT = "frontend/public/assets/promos/apple-sept-2026.webp"

W, H = 1800, 1200

# Фон — СТОП-КАДР живого фона экрана события. Не «похожая палитра», а те же
# пятна, те же альфы, та же база: значения продублированы из
# frontend/src/components/PreorderEvent.tsx (константа BLOBS). Кадр и экран
# обязаны звучать в один тон, а «в один тон» надёжнее всего достигается одним
# и тем же построением, а не двумя похожими.
#
# Почему пятна, а не линейная заливка. Линейная заливка через малонасыщенный
# серо-сиреневый (#C9BBCD) замыливала середину кадра — свет читался серым.
# Мягкие радиальные пятна держат насыщенность по всей площади и дают объём:
# у света появляется источник, а не только направление.
BASE = (247, 227, 203)          # #F7E3CB — та же база, что у канвы экрана

#: (x, y, r, цвет, альфа) в долях кадра. Порядок важен: рисуются поверх базы
#: слева направо, как в канве.
BLOBS = [
    (0.80, 0.08, 0.85, (163, 157, 219), 0.95),   # лиловый
    (0.14, 0.05, 0.72, (143, 134, 204), 0.80),   # лиловый глубже
    (0.22, 0.58, 0.88, (238, 191, 199), 0.90),   # роза
    (0.86, 0.80, 0.80, (250, 228, 199), 0.95),   # крем
    (0.50, 0.38, 0.45, (89, 44, 52), 0.08),      # винный, еле слышно
]


def cutout(path: str, tolerance: int = 26) -> Image.Image:
    """Снимок -> RGBA без фона. Фоном считается только то, что связано с краем."""
    im = Image.open(path).convert("RGB")
    a = np.asarray(im).astype(np.int16)

    # Цвет фона берём из углов — он там гарантированно фон.
    corners = np.stack([a[0, 0], a[0, -1], a[-1, 0], a[-1, -1]])
    bg = corners.mean(axis=0)

    near = (np.abs(a - bg).max(axis=2) <= tolerance)

    # Связность с краем: помечаем компоненты «похожего на фон» и оставляем в
    # маске только те, что касаются рамки. Белый корпус внутри аппарата в
    # маску не попадёт — он окружён тёмной гранью.
    labels, count = ndimage.label(near)
    border = set(labels[0].tolist()) | set(labels[-1].tolist()) \
        | set(labels[:, 0].tolist()) | set(labels[:, -1].tolist())
    border.discard(0)
    background = np.isin(labels, list(border))

    alpha = np.where(background, 0, 255).astype(np.uint8)
    out = im.convert("RGBA")
    mask = Image.fromarray(alpha, mode="L")
    # Лёгкое размытие края: жёсткая маска по порогу даёт «пилу» на глянцевой
    # грани, и аппарат читается как наклейка.
    mask = mask.filter(ImageFilter.GaussianBlur(0.8))
    out.putalpha(mask)
    return out.crop(out.getbbox())


def gradient() -> Image.Image:
    """Сетка мягких пятен — покадрово то же, что рисует канва экрана события.

    Радиус берётся от МЕНЬШЕЙ стороны кадра. На телефоне канва вертикальная и
    меньшая сторона — ширина; здесь кадр горизонтальный, и если считать от
    ширины, пятна расплывутся выше кадра и превратятся обратно в полосатую
    заливку. От меньшей стороны пропорции пятна сохраняются в обеих раскладках.
    """
    field = np.zeros((H, W, 3), dtype=float)
    field[:, :] = BASE

    unit = min(W, H)
    xs = np.arange(W, dtype=float)
    ys = np.arange(H, dtype=float)

    for cx, cy, radius, colour, alpha in BLOBS:
        r = radius * unit
        dx = (xs - cx * W)[None, :]
        dy = (ys - cy * H)[:, None]
        dist = np.sqrt(dx ** 2 + dy ** 2)
        # Канва рисует радиальный градиент с ЛИНЕЙНЫМ спадом альфы от центра к
        # краю — повторяем его же, иначе пятна станут жёстче оригинала.
        w = np.clip(1.0 - dist / r, 0.0, 1.0) * alpha
        field = field * (1 - w[:, :, None]) + np.array(colour, dtype=float) * w[:, :, None]

    return Image.fromarray(np.clip(field, 0, 255).astype(np.uint8), "RGB").convert("RGBA")


def scaled(dev: Image.Image, height: int) -> Image.Image:
    return dev.resize((max(1, round(dev.width * height / dev.height)), height), Image.LANCZOS)


#: Где начинается зона аппаратов и где она кончается. Левее — пустой фон под
#: заголовок, который приложение кладёт поверх картинки (HeroBanner рисует
#: текст в левых 62 % и затемнение снизу, поэтому низ слева тоже держим чистым).
FIELD_LEFT = int(W * 0.355)
FIELD_RIGHT = int(W * 0.97)


def main(out: str | None = None) -> None:
    canvas = gradient()

    # Кадр finish-select показывает ПАРУ: аппарат спинкой и он же экраном.
    # Это собственная манера Apple, ломать её незачем.
    burgundy = cutout(f"{SRC}/iphone18pro-burgundy.jpg")

    # Раскрытый Duo берём из gallery-3: там он стоит ОДИН. В кадрах
    # finish-select рядом лежит сложенный аппарат, он перекрывает левую грань
    # раскрытого — и любой срез оставлял либо осколок соседа, либо плоско
    # обрубленный корпус. Кадр составной (три аппарата столбиком), поэтому
    # вырезаем средний по вертикали.
    duo_src = Image.open(f"{SRC}/duo-open-standalone.jpg").convert("RGB")
    dw, dh = duo_src.size
    duo_src.crop((0, int(dh * 0.34), dw, int(dh * 0.72))).save("_duo_tmp.png")
    duo = cutout("_duo_tmp.png")

    # Высота подобрана так, чтобы два объекта ВЛЕЗЛИ с настоящим зазором.
    # Третий сюда не помещается: при пустой левой трети три пары по 0,83 и 1,54
    # ширины от высоты требуют больше кадра, чем есть, и начинают перекрываться —
    # ровно то, из-за чего первый вариант выглядел тесным.
    height = 470
    a = scaled(burgundy, height)
    b = scaled(duo, int(height * 0.92))

    span = FIELD_RIGHT - FIELD_LEFT
    gap = span - a.width - b.width
    assert gap > 60, f"аппараты не помещаются с зазором: {gap}px"

    top = int(H * 0.24)
    canvas.alpha_composite(a, (FIELD_LEFT, top))
    canvas.alpha_composite(b, (FIELD_LEFT + a.width + gap, top + (a.height - b.height) // 2))

    target = out or OUT
    canvas.convert("RGB").save(target, "WEBP", quality=90, method=6)
    print(f"{target}: {Image.open(target).size}, зазор между аппаратами {gap}px")


if __name__ == "__main__":
    import sys
    main(sys.argv[1] if len(sys.argv) > 1 else None)
