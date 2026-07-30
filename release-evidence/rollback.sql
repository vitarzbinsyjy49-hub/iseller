-- Откат схемы релиза «Compact Home UX + Multi-product Cart».
--
-- ВЫПОЛНЯТЬ ТОЛЬКО ЕСЛИ КОРЗИНОЙ ЕЩЁ НЕ ПОЛЬЗОВАЛИСЬ.
-- Проверить перед запуском:
--     SELECT (SELECT count(*) FROM lead_items) AS items,
--            (SELECT count(*) FROM carts)      AS carts;
-- Ненулевой lead_items означает, что состав уже отправленных заявок будет
-- потерян безвозвратно: снапшоты позиций живут только в этой таблице.
--
-- Скрипт удаляет ТОЛЬКО объекты, созданные релизом. Существующие заявки,
-- товары, SKU, цены, фото и посты не затрагиваются.
--
-- Проверено локально: применение на чистой БД, применение на копии боевой
-- схемы с данными, этот откат, повторное применение после отката.

BEGIN;

-- Позиции заявок и живой корзины. Порядок важен: lead_items и cart_items
-- ссылаются на leads/carts внешними ключами.
DROP TABLE IF EXISTS lead_items;
DROP TABLE IF EXISTS cart_items;
DROP TABLE IF EXISTS carts;

-- Индексы ключа идемпотентности (частичный уникальный + обычный).
DROP INDEX IF EXISTS uq_leads_user_idempotency;
DROP INDEX IF EXISTS ix_leads_idempotency_key;

-- Колонки заявки-корзины. Все были добавлены как необязательные, у старых
-- заявок в них дефолты — данных, кроме релизных, тут нет.
ALTER TABLE leads
  DROP COLUMN IF EXISTS items_count,
  DROP COLUMN IF EXISTS estimated_total,
  DROP COLUMN IF EXISTS currency,
  DROP COLUMN IF EXISTS idempotency_key;

-- Режим доступности товара. На проде он был NULL у всех 218 товаров, то есть
-- удаление колонки ничего не меняет в поведении каталога.
ALTER TABLE products DROP COLUMN IF EXISTS availability_mode;

COMMIT;

-- Проверка после отката (ожидаем 0):
--     SELECT count(*) FROM pg_tables
--      WHERE schemaname = 'public'
--        AND tablename IN ('carts', 'cart_items', 'lead_items');
