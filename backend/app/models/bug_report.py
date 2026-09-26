"""Сообщение об ошибке от покупателя — кнопка «Сообщить об ошибке» в профиле.

Это НЕ заявка (`Lead`), хотя тоже приходит от покупателя и тоже разбирается
вручную. Заявка — единица продажи: закрытие требует сумму сделки и начисляет
баллы, покупателю уходят тексты про «состав и цену», по заявкам считается
конверсия. Сообщение об ошибке в этой механике было бы шумом, который сдвигает
цифры продаж, поэтому у него своя таблица и свой короткий цикл:

    new -> fixed      (исправили, автору уходит «спасибо»)
    new -> declined   (не ошибка / не воспроизводится, молча)

Строки не удаляются: закрытое сообщение — это история того, что уже
чинили, и повторная жалоба на то же место становится видна сразу.
"""
from datetime import datetime

from sqlalchemy import JSON, BigInteger, DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base

BUG_REPORT_STATUSES = ("new", "fixed", "declined")


class BugReport(Base):
    __tablename__ = "bug_reports"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(Integer, index=True)
    #: BigInteger — как у users.telegram_id: id уже не влезают в INTEGER.
    telegram_id: Mapped[int | None] = mapped_column(BigInteger)
    username: Mapped[str | None] = mapped_column(String(200))
    name: Mapped[str | None] = mapped_column(String(200))

    text: Mapped[str] = mapped_column(Text, nullable=False)
    #: Список URL наших загрузок (/api/uploads/...), как у отзыва.
    photos: Mapped[list] = mapped_column(JSON, default=list)
    #: Что было у человека на экране: платформа Telegram, версия, размер окна,
    #: user-agent, экран приложения. Собирает клиент — см. services/bug_reports.
    context: Mapped[dict] = mapped_column(JSON, default=dict)

    status: Mapped[str] = mapped_column(String(16), default="new", index=True)
    #: Заметка владельца — видна только в админке.
    manager_note: Mapped[str | None] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "user_id": self.user_id,
            "username": self.username,
            "name": self.name,
            "text": self.text,
            "photos": list(self.photos or []),
            "context": dict(self.context or {}),
            "status": self.status,
            "manager_note": self.manager_note,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "resolved_at": self.resolved_at.isoformat() if self.resolved_at else None,
        }
