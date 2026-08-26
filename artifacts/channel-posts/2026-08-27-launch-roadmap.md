# Пост в канал: выход из беты + роудмап (27.08.2026)

Публикуется через админку → **Посты канала** → новый пост, поле `rich_html`.
Текст — в `2026-08-27-launch-roadmap.rich.html`. `body` при заполненном
`rich_html` не используется: rich полностью заменяет его при публикации.

## Кнопки

Порядок и ряды — как в конструкторе (`row`):

| row | текст | kind |
|---|---|---|
| 0 | 🛍 Открыть каталог | `catalog` |
| 1 | ✨ Подобрать с AI | `ai` |
| 1 | 🗺 Что будет дальше | `roadmap` |
| 2 | 💬 Написать менеджеру | `manager` |

`roadmap` — новый вид кнопки: ведёт на `/profile?roadmap=1`, то есть открывает
не просто профиль, а сразу развёрнутую шторку с планами. Первый ряд — каталог:
пост читают ради планов, но покупку делает витрина.

Кнопки в канале только `url` (deep link). `web_app`-кнопка отвергает весь пост
целиком — он просто не публикуется.

## Обложка

Картинку генерирует человек и кладёт рядом; при публикации она уходит в
Telegram **multipart-байтами**, не строкой-URL — с нашего домена Telegram медиа
сам не скачивает. У rich-постов картинка идёт тегом `<img>` внутри `rich_html`,
поле `image_url` не используется.

Промпт для генерации (тот же стиль, что у обложки гайда по eSIM):

> A clean, minimal 3D product illustration on a pure white background, 16:9.
> Centered: a glossy white smartphone with a soft blue gradient screen, floating
> slightly above the surface with a very soft shadow. Behind it, a large smooth
> organic blob of light blue (#3b82f6 to #93c5fd gradient) as the only strong
> color. Around the phone, three small glossy white rounded-square cards float
> at different depths: one with a blue calendar icon, one with a blue upward
> trending arrow, one with a blue gift/loyalty icon. Thin dotted light-blue
> lines connect the cards to the phone like a roadmap path, with small dots as
> waypoints. Soft studio lighting, subtle reflections, pastel palette of white,
> light grey and blue with a single warm orange accent dot. No text, no letters,
> no numbers, no logos. Flat-ish 3D render, high detail, crisp edges.

Если генератор всё равно дорисовывает надписи — добавить в конец:
`absolutely no typography or written characters anywhere in the image`.

## Перед публикацией

Rich-разметку автотесты не проверяют (все они мокают `httpx`), поэтому один раз
отправить пост в тестовый чат и посмотреть глазами: `<details>` и `<table>`
рендерятся в Telegram по-разному на разных клиентах.
