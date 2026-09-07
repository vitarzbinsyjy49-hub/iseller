from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    telegram_id: Mapped[int] = mapped_column(BigInteger, unique=True, index=True)
    username: Mapped[str | None] = mapped_column(String(64))
    first_name: Mapped[str | None] = mapped_column(String(128))
    last_name: Mapped[str | None] = mapped_column(String(128))
    # Ссылка на аватар из Telegram initData. Присылается не всегда — у
    # закрытого профиля или профиля без фото поля просто нет. NULL — сигнал
    # витрине показать инициалы вместо <img>, а не то, что аватар не загрузился.
    photo_url: Mapped[str | None] = mapped_column(String(512))
    role: Mapped[str] = mapped_column(String(16), default="customer")  # customer | admin
    # Id последнего сообщения бота в личном чате с этим пользователем —
    # send_reply() удаляет его перед отправкой следующего (чистый чат).
    # ОБЯЗАНО жить в БД, а не в памяти процесса: бот перезапускается на каждый
    # деплой, и внутрипроцессный словарь после рестарта пуст — старые сообщения
    # переставали удаляться, и чат начинал копить дубли ровно с того момента.
    last_bot_message_id: Mapped[int | None] = mapped_column(BigInteger)
    # Сторис-онбординг при первом входе. NULL = ещё не видел — покрывает и
    # новых, и уже существующих пользователей одним состоянием, без
    # отдельного флага.
    onboarding_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Откуда пришёл ПЕРВЫЙ раз — значение start_param диплинка (реклама в
    # каналах: "ad_<канал>"), с которым человек впервые открыл Mini App.
    # Пишется РОВНО ОДИН РАЗ при создании user (см. api/auth._get_or_create_user)
    # и больше не перезаписывается — иначе органический повторный вход затёр бы
    # рекламный источник, и отчёт по каналам стал бы врать в первый же день.
    # NULL — пришёл не по рекламной ссылке (или до того, как эта колонка появилась).
    acquisition_source: Mapped[str | None] = mapped_column(String(64))
    #: Личный код приглашения. Выдаётся лениво — при первом открытии экрана
    #: приглашений, а не всем существующим пользователям разом.
    referral_code: Mapped[str | None] = mapped_column(String(12), unique=True, index=True)
    #: Кто привёл. Ставится ОДИН раз при создании и никогда не переписывается —
    #: то же правило, что у acquisition_source: первое касание есть первое
    #: касание, и второй заход по чужой ссылке его не присваивает.
    referred_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
