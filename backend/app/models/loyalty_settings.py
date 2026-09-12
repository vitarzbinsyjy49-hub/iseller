"""Настройки программы лояльности — одна строка (id=1).

Явные колонки, а не универсальный «ключ-значение»: последний не типизируется и
не валидируется, и через полгода содержит строку «1%» там, где код ждёт число.
Настроек три, и растут они медленнее, чем код вокруг них.
"""
from datetime import date

from sqlalchemy import Boolean, Date, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class LoyaltySettings(Base):
    __tablename__ = "loyalty_settings"

    id: Mapped[int] = mapped_column(primary_key=True, default=1)
    #: Ставка выплаты пригласившему в сотых процента: 100 = 1%.
    referral_rate_bps: Mapped[int] = mapped_column(Integer, default=100, server_default="100")
    #: Предел реферальной выплаты с ОДНОЙ покупки друга. Без него пригласивший
    #: получал с чека на 200 000 больше, чем сам покупатель, — тот самый
    #: перекос, из-за которого приглашать было выгоднее, чем покупать.
    referral_cap_points: Mapped[int] = mapped_column(
        Integer, default=1000, server_default="1000",
    )
    #: Приветственные баллы приглашённому за его первую покупку.
    welcome_bonus_points: Mapped[int] = mapped_column(Integer, default=500, server_default="500")

    # ---- Акция первой покупки ----
    #: Выключена по умолчанию НАМЕРЕННО. Акция с датой окончания — решение
    #: владельца, а не свойство кода: включённая дефолтом, она поднималась бы
    #: сама от одного факта деплоя, а тесты зависели бы от системной даты.
    newcomer_enabled: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false",
    )
    #: Ставка первой покупки, в сотых процента. 300 = 3%.
    newcomer_rate_bps: Mapped[int] = mapped_column(Integer, default=300, server_default="300")
    #: Свой потолок у акции: ставка верхнего уровня, но предел стартового.
    newcomer_cap_points: Mapped[int] = mapped_column(
        Integer, default=1500, server_default="1500",
    )
    #: Последний день действия ВКЛЮЧИТЕЛЬНО. Сравнивается с датой начисления,
    #: то есть с днём, когда менеджер завершил заявку.
    newcomer_until: Mapped[date | None] = mapped_column(Date)

    #: Предел списания баллов, в сотых процента от суммы заявки. 500 = 5%.
    #: Десять процентов при марже около 5,5% — продажа в убыток.
    redeem_max_bps: Mapped[int] = mapped_column(Integer, default=500, server_default="500")
    #: Главный рубильник автоматических начислений. Ручное начисление из
    #: карточки клиента работает всегда — это путь отхода.
    auto_accrual_enabled: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default="true",
    )
