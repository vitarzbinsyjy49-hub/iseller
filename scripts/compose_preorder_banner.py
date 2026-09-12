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

import os
import tempfile

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


def gradient(w: int = W, h: int = H) -> Image.Image:
    """Сетка мягких пятен — покадрово то же, что рисует канва экрана события.

    Радиус берётся от МЕНЬШЕЙ стороны кадра. На телефоне канва вертикальная и
    меньшая сторона — ширина; здесь кадр горизонтальный, и если считать от
    ширины, пятна расплывутся выше кадра и превратятся обратно в полосатую
    заливку. От меньшей стороны пропорции пятна сохраняются в обеих раскладках.
    """
    field = np.zeros((h, w, 3), dtype=float)
    field[:, :] = BASE

    unit = min(w, h)
    xs = np.arange(w, dtype=float)
    ys = np.arange(h, dtype=float)

    for cx, cy, radius, colour, alpha in BLOBS:
        r = radius * unit
        dx = (xs - cx * w)[None, :]
        dy = (ys - cy * h)[:, None]
        dist = np.sqrt(dx ** 2 + dy ** 2)
        # Канва рисует радиальный градиент с ЛИНЕЙНЫМ спадом альфы от центра к
        # краю — повторяем его же, иначе пятна станут жёстче оригинала.
        weight = np.clip(1.0 - dist / r, 0.0, 1.0) * alpha
        field = (field * (1 - weight[:, :, None])
                 + np.array(colour, dtype=float) * weight[:, :, None])

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
    duo = _duo_open()

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


# ======================================================================
#                        Кадр для поста в канал
# ======================================================================
#
# Почему это ОТДЕЛЬНЫЙ кадр, а не тот же баннер. Баннер намеренно пустой слева:
# HeroBanner кладёт поверх него заголовок и подзаголовок, и пустота — это место
# под текст (см. FIELD_LEFT выше). В посте канала никакого текста поверх нет,
# картинка идёт голой — и та же пустота читается уже не как воздух, а как брак:
# два маленьких аппарата, прижатых к правому краю, и половина кадра ни о чём.
#
# Значит у поста своя рамка: аппараты крупные, поля ровные со всех сторон,
# устройств больше — пост перечисляет всю линейку, и картинка обязана говорить
# то же самое.
POST_OUT = "frontend/public/assets/promos/apple-sept-2026-post.webp"

#: 4:3 — та пропорция, в которой Telegram показывает фото в канале целиком,
#: не обрезая и не заставляя тапать ради полного кадра.
POST_W, POST_H = 1600, 1200

#: Поля кадра и зазор между рядами. Одно число на левое и правое поле —
#: несимметричные поля и были тем, из-за чего баннер в посте «заваливался».
POST_MARGIN_X = 80
#: Своё поле нижнего ряда — см. _place_row.
POST_MARGIN_X_COMPANIONS = 230
POST_GAP_Y = 64


def _row(items: list[Image.Image], height: int) -> list[Image.Image]:
    return [scaled(it, height) for it in items]


def _place_row(canvas: Image.Image, row: list[Image.Image], top: int,
               margin: int = POST_MARGIN_X) -> None:
    """Кладёт ряд по центру кадра с равными зазорами между предметами.

    `margin` у рядов разный намеренно. Два героя занимают кадр во всю ширину, а
    три спутника, растянутые на ту же ширину, расползались: между часами и
    наушниками зияла дыра, и середина кадра пустела. Своим полем нижний ряд
    собирается в плотную группу под героями — и читается как один предмет
    композиции, а не как три случайно расставленных.
    """
    span = POST_W - 2 * margin
    total = sum(it.width for it in row)
    gap = (span - total) / max(1, len(row) - 1) if len(row) > 1 else 0
    assert total <= span, f"ряд не помещается: {total}px при доступных {span}px"

    x = float(margin)
    tallest = max(it.height for it in row)
    for it in row:
        # Предметы ряда выравниваются по ОБЩЕЙ средней линии, а не по верху:
        # часы, наушники и телефон разной высоты, и по верху ряд читался бы
        # как полка, с которой всё свисает.
        canvas.alpha_composite(it, (round(x), top + (tallest - it.height) // 2))
        x += it.width + gap


def _duo_open() -> Image.Image:
    """Раскрытый Duo из составного кадра.

    Кадр `duo-open-standalone` — три аппарата столбиком; раскрытый лежит
    посередине, его и берём. В кадрах finish-select рядом с раскрытым лежит
    сложенный и перекрывает ему левую грань.

    Промежуточный файл пишется во ВРЕМЕННЫЙ каталог и удаляется. В корне
    репозитория ему не место: деплой синхронизирует всё рабочее дерево, и
    забытый `_duo_tmp.png` уехал бы на сервер — а удалить его оттуда потом
    можно только руками, синхронизация ничего не удаляет.
    """
    src = Image.open(f"{SRC}/duo-open-standalone.jpg").convert("RGB")
    dw, dh = src.size
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "duo.png")
        src.crop((0, int(dh * 0.34), dw, int(dh * 0.72))).save(path)
        return cutout(path)


def compose_post(out: str | None = None) -> None:
    """Кадр для поста: два героя сверху, три спутника снизу.

    iPhone 18 Pro Max в кадр НЕ входит, хотя в посте он назван. Причина не в
    месте: его пресс-кадр отличается от кадра Pro только пропорцией корпуса —
    та же поза, тот же цвет, те же обои. Рядом они читались бы как один аппарат,
    продублированный по ошибке, и кадр начал бы спорить с текстом вместо того,
    чтобы его подтверждать. Размер Pro Max объясняет подпись, а не картинка.
    """
    canvas = gradient(POST_W, POST_H)

    hero_h = 600
    heroes = _row([cutout(f"{SRC}/iphone18pro-burgundy.jpg"), _duo_open()], hero_h)
    # Duo раскрытым шире телефона больше чем вдвое; если дать ему ту же высоту,
    # он съест ряд. Осаживаем до 0,92 — так же, как в баннере.
    heroes[1] = scaled(heroes[1], int(hero_h * 0.92))

    companions = _row([
        cutout(f"{SRC}/watch-s12-pearlwhite.jpg"),
        cutout(f"{SRC}/watch-ultra4-milanese.jpg"),
        # Свой порог, а не общий 26. AirPods белые на почти белом фоне, и на
        # общем пороге заливка от края прогрызала сам корпус: в кадре между
        # вкладышами появлялся белый клин, а по краям — дыры. 12 оставляет
        # корпус целым, ниже 9 фон уже не отделяется вовсе.
        cutout(f"{SRC}/airpods5-1.jpg", tolerance=12),
    ], 320)

    row_h = max(it.height for it in heroes)
    comp_h = max(it.height for it in companions)
    block = row_h + POST_GAP_Y + comp_h
    top = (POST_H - block) // 2

    _place_row(canvas, heroes, top)
    _place_row(canvas, companions, top + row_h + POST_GAP_Y,
               margin=POST_MARGIN_X_COMPANIONS)

    target = out or POST_OUT
    canvas.convert("RGB").save(target, "WEBP", quality=90, method=6)
    print(f"{target}: {Image.open(target).size}, блок {block}px по высоте, поля {top}px")


if __name__ == "__main__":
    import sys
    args = sys.argv[1:]
    if args and args[0] == "--post":
        compose_post(args[1] if len(args) > 1 else None)
    else:
        main(args[0] if args else None)
