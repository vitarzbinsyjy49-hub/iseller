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

from PIL import Image, ImageChops, ImageDraw

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


def _back(color: str) -> Image.Image:
    """Только спинка из пары «спинка + экран»: в баннере важен цвет корпуса,
    а экран у всех четырёх одинаковый и только съедал бы место."""
    pair = cutout(f"{SRC}/iphone18pro-{color}.jpg", TOLERANCE.get(color, 26))
    # Спинка — левая часть пары; экран подложен под неё справа. Режем по
    # ширине спинки (≈0.585 пары) и заново обрезаем по непрозрачному.
    back = pair.crop((0, 0, int(pair.width * 0.575), pair.height))
    back = back.crop(back.getbbox())
    # Экран подложен под спинку и выглядывает из-за её скруглённых углов
    # тёмными полосками. Режем по силуэту самой спинки: скруглённый
    # прямоугольник, радиус снят с кадра (~16% ширины корпуса).
    mask = Image.new("L", back.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, back.width - 1, back.height - 1), radius=int(back.width * 0.16), fill=255)
    alpha = ImageChops.multiply(back.getchannel("A"), mask)
    back.putalpha(alpha)
    return back


def compose_banner(out: str | None = None) -> None:
    """Первый баннер главной: четыре цвета веером, крупно.

    Левая треть пустая — HeroBanner кладёт туда заголовок (FIELD_LEFT в
    соседнем скрипте). Первая сетка 2×2 из пар «спинка + экран» делала
    аппараты мелкими: на телефоне баннер узкий, и они терялись. Веер из одних
    спинок даёт каждому цвету почти всю высоту кадра, а камера — главное, что
    отличает поколение, — остаётся открытой: следующий корпус перекрывает
    предыдущий справа, а блок камер сидит слева."""
    canvas = gradient(W, H)
    order = ("black", "silver", "glacier", "burgundy")   # главный цвет — сверху
    height = int(H * 0.86)
    backs = [scaled(_back(c), height) for c in order]
    span = FIELD_RIGHT - FIELD_LEFT
    step = (span - backs[0].width) // (len(backs) - 1)
    assert step > backs[0].width * 0.3, f"веер слишком плотный: {step}px"
    top = (H - height) // 2
    for i, back in enumerate(backs):
        # Лёгкая лесенка по вертикали: ровный ряд читался бы витриной, а не веером.
        dy = (len(backs) - 1 - i) * 18 - 27
        canvas.alpha_composite(back, (FIELD_LEFT + i * step, top + dy))
    target = out or BANNER_OUT
    canvas.convert("RGB").save(target, "WEBP", quality=90, method=6)
    print(f"{target}: {Image.open(target).size}, шаг веера {step}px")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--banner"]:
        compose_banner(sys.argv[2] if len(sys.argv) > 2 else None)
    else:
        compose(sys.argv[1] if len(sys.argv) > 1 else None)
