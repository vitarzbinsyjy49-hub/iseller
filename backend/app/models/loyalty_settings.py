"""Настройки программы лояльности — одна строка (id=1).

Явные колонки, а не универсальный «ключ-значение»: последний не типизируется и
не валидируется, и через полгода содержит строку «1%» там, где код ждёт число.
Настроек три, и растут они медленнее, чем код вокруг них.
"""
from sqlalchemy import Boolean, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class LoyaltySettings(Base):
    __tablename__ = "loyalty_settings"

    id: Mapped[int] = mapped_column(primary_key=True, default=1)
    #: Ставка выплаты пригласившему в сотых процента: 100 = 1%.
    referral_rate_bps: Mapped[int] = mapped_column(Integer, default=100, server_default="100")
    #: Приветственные баллы приглашённому за его первую покупку.
    welcome_bonus_points: Mapped[int] = mapped_column(Integer, default=1000, server_default="1000")
    #: Главный рубильник автоматических начислений. Ручное начисление из
    #: карточки клиента работает всегда — это путь отхода.
    auto_accrual_enabled: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default="true",
    )
