"""Первое касание рекламной ссылки в ЧАТЕ с ботом (t.me/<bot>?start=ad_<кампания>).

Зачем отдельная таблица, а не строка в `users`. Бот не создаёт пользователя:
`User` появляется только при логине Mini App (`api/auth.py::_get_or_create_user`),
и заводить его из бота значило бы поменять смысл слова «пользователь» во всей
админке и во всех счётчиках — человек, нажавший «Запустить» и ушедший, стал бы
неотличим от того, кто открыл приложение. Поэтому касание живёт своей строкой
и ждёт логина: `_get_or_create_user` заглянет сюда, если `start_param` не
принёс метку сам.

Почему это вообще нужно. Telegram НЕ прокидывает `start_param` в Mini App,
открытый web_app-кнопкой из чата (в отличие от прямого `?startapp=`), поэтому
по ссылке `?start=ad_*` источник до `/auth/telegram` не доходит — а ведём мы в
чат намеренно: только чат даёт боту право писать человеку дальше, и вся
машинерия догона (`services/notifications.py`) для пришедших по `?startapp=`
молчит навсегда.

Строка одна на `telegram_id` и НИКОГДА не перезаписывается: `acquisition_source`
— это первое касание, и второй заход по другой ссылке не имеет права присвоить
себе чужой приход.
"""
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class AdTouch(Base):
    __tablename__ = "ad_touches"

    id: Mapped[int] = mapped_column(primary_key=True)
    # unique, а не просто index: гонку двух /start подряд ловит БД, а не
    # надежда на то, что SELECT успел раньше INSERT (см. services/ad_touch.py).
    telegram_id: Mapped[int] = mapped_column(BigInteger, unique=True, index=True)
    # Метка БЕЗ префикса «ad_» — ровно то, что вернул parse_ad_payload. Префикс
    # приписывается на выходе, в acquisition_source, чтобы формат колонки
    # (`ad_<slug>`, VARCHAR(64)) остался прежним для точного `==` фильтра
    # админки.
    slug: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(),
    )
