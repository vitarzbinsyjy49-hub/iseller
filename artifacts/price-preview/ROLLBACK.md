# План отката

## Код
Ветка `feature/telegram-price-posts` не влита в master и не задеплоена.
Откат = ничего не делать. Если ветку уже влили и задеплоили:

    git checkout v5.5.0-bot-start-menu && bash update-server.sh

## Схема БД
Мини-миграция добавляет в `channel_posts` только НЕОБЯЗАТЕЛЬНЫЕ колонки
(slug, channel_id, sort_order, catalog_fingerprint, last_generated_at,
last_synced_at, item_count, reply_markup, last_error) и уникальный индекс по
slug. Старый код их просто не читает, поэтому откат кода безопасен без отката
схемы. Если колонки всё же нужно убрать:

    ALTER TABLE channel_posts DROP COLUMN IF EXISTS slug;   -- и остальные
    DROP INDEX IF EXISTS ix_channel_posts_slug;

Существующие новостные посты не затронуты: у них slug = NULL.

## Сообщения в канале
На момент сдачи кандидата в канал НЕ опубликовано ничего. Если публикация уже
состоялась, откат делается вручную в Telegram (удалить сообщения), а в БД —
очисткой message_id:

    UPDATE channel_posts SET telegram_message_id = NULL, status = 'draft'
    WHERE slug IS NOT NULL;

Автоматического удаления постов в системе нет сознательно: удаление
опубликованного сообщения необратимо и не должно происходить по кнопке.

## Настройки
TELEGRAM_CHANNEL_ID на проде не менялся (остаётся пустым). Бэкапы .env лежат
рядом с боевым файлом: /opt/techshop/.env.bak-*
