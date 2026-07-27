from datetime import datetime

from sqlalchemy import DateTime, Integer, JSON, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class ChannelPost(Base):
    """A reviewable Telegram post. Generation can never mark it approved."""

    __tablename__ = "channel_posts"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(240))
    body: Mapped[str] = mapped_column(Text)
    image_url: Mapped[str | None] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(String(32), default="news")
    sources: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(24), default="draft", index=True)
    content_version: Mapped[int] = mapped_column(Integer, default=1)
    approved_version: Mapped[int | None] = mapped_column(Integer)
    telegram_message_id: Mapped[int | None] = mapped_column(Integer)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # ---- Постоянные прайс-посты канала (v5.6.0) ----
    # Прайс-пост публикуется один раз и дальше редактируется на том же
    # message_id, поэтому ему нужен стабильный ключ раздела: slug переживает
    # перегенерацию и связывает «раздел каталога» с конкретным сообщением.
    # Потерять slug — значит потерять сообщение и опубликовать дубль.
    slug: Mapped[str | None] = mapped_column(String(64), unique=True, index=True)
    # Канал хранится рядом с message_id: без него нельзя ни собрать ссылку
    # t.me/c/<channel>/<message> для навигации, ни безопасно отредактировать
    # сообщение, если канал в конфигурации когда-нибудь сменится.
    channel_id: Mapped[str | None] = mapped_column(String(64))
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    # Отпечаток каталога на момент генерации — по нему видно, устарел ли пост.
    catalog_fingerprint: Mapped[str | None] = mapped_column(String(64))
    last_generated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    item_count: Mapped[int] = mapped_column(Integer, default=0)
    # Inline-клавиатура в формате Bot API; хранится, чтобы обновлять разметку
    # (например у навигационного поста) без перепубликации текста.
    reply_markup: Mapped[list | None] = mapped_column(JSON)
    last_error: Mapped[str | None] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
