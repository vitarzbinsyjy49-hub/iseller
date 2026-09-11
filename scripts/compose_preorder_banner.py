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

# Палитры. Первая версия была линейной заливкой через малонасыщенный серо-
# сиреневый (#C9BBCD) — он замыливал середину кадра, и свет читался «серым».
# Лечится двумя вещами сразу: насыщенным средним тоном и СВЕТОВЫМ ОЧАГОМ —
# тёплым радиальным пятном за аппаратами. Плоская линейная заливка не выглядит
# освещённой, сколько её ни насыщай: у света должен быть источник.
PALETTES = {
    "dawn":   ((76, 58, 140),  (232, 99, 154),  (255, 196, 107)),   # фиолет -> маджента -> золото
    "azure":  ((45, 106, 214), (103, 200, 232), (255, 214, 150)),   # лазурь -> бирюза -> песок
    "sunset": ((46, 42, 110),  (255, 107, 91),  (255, 194, 71)),    # индиго -> коралл -> янтарь
    # Светлые, воздушные. Середина идёт через ТЁПЛЫЙ РОЗОВЫЙ, а не через
    # серо-мовый: серо-мовый малонасыщен, и на нём вся середина кадра сереет —
    # это и был исходный дефект.
    "soft":   ((181, 176, 222), (233, 201, 206), (247, 231, 207)),  # лиловый -> роза -> крем
    "soft+":  ((163, 157, 219), (238, 191, 199), (250, 228, 199)),  # то же, но насыщеннее
}
# Рабочая палитра. Яркие (dawn/sunset) владелец забраковал: винный корпус —
# герой кадра — садится на маджентовый фон и растворяется. Светлая лиловая с
# тёплым кремовым низом держит и воздух, и контраст с винным.
PALETTE = "soft+"

#: Центр светового очага и его сила. Пятно стоит за аппаратами и чуть выше
#: середины — там, где в студии стоял бы софтбокс.
GLOW_AT = (0.62, 0.42)
GLOW_STRENGTH = 0.55


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


def gradient(palette: str = PALETTE) -> Image.Image:
    """Вертикальная заливка плюс тёплый световой очаг за аппаратами."""
    top, mid, bot = (np.array(c, dtype=float) for c in PALETTES[palette])

    y = np.linspace(0.0, 1.0, H)[:, None]
    # Две линейные части со стыком на 45 % высоты: ровно там, где у кадра
    # проходит линия аппаратов, и переход не читается полосой.
    k = 0.45
    a = np.where(y < k, top + (mid - top) * np.clip(y / k, 0, 1),
                 mid + (bot - mid) * np.clip((y - k) / (1 - k), 0, 1))
    field = np.repeat(a[:, None, :], W, axis=1)

    # Световой очаг: мягкое осветление к белому по радиусу. Именно он отличает
    # «освещённый фон» от «залитого цветом» — без него любая палитра выглядит
    # плоской, а середина кадра сереет.
    gx, gy = GLOW_AT
    xs = (np.arange(W) / W - gx) / 0.55
    ys = (np.arange(H) / H - gy) / 0.60
    dist = np.sqrt(xs[None, :] ** 2 + ys[:, None] ** 2)
    glow = np.clip(1.0 - dist, 0.0, 1.0) ** 2 * GLOW_STRENGTH
    field = field + (255.0 - field) * glow[:, :, None]

    return Image.fromarray(np.clip(field, 0, 255).astype(np.uint8), "RGB").convert("RGBA")


def scaled(dev: Image.Image, height: int) -> Image.Image:
    return dev.resize((max(1, round(dev.width * height / dev.height)), height), Image.LANCZOS)


#: Где начинается зона аппаратов и где она кончается. Левее — пустой фон под
#: заголовок, который приложение кладёт поверх картинки (HeroBanner рисует
#: текст в левых 62 % и затемнение снизу, поэтому низ слева тоже держим чистым).
FIELD_LEFT = int(W * 0.355)
FIELD_RIGHT = int(W * 0.97)


def main(palette: str = PALETTE, out: str | None = None) -> None:
    canvas = gradient(palette)

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
    print(f"{target}: {Image.open(target).size}, зазор {gap}px, палитра {palette}")


if __name__ == "__main__":
    import sys
    main(sys.argv[1] if len(sys.argv) > 1 else PALETTE,
         sys.argv[2] if len(sys.argv) > 2 else None)
