"""Токен бота не должен попадать в логи.

Bot API кладёт токен прямо в путь URL (/bot<TOKEN>/sendMessage), а httpx на
уровне INFO печатает полный URL каждого запроса. Логи контейнеров читают через
docker logs и вставляют в переписку, поэтому этот поток надо глушить.
"""
import logging

from app.core.logging import setup_logging


def test_http_client_loggers_do_not_print_request_urls():
    logging.getLogger("httpx").setLevel(logging.INFO)
    logging.getLogger("httpcore").setLevel(logging.INFO)

    setup_logging()

    for name in ("httpx", "httpcore"):
        logger = logging.getLogger(name)
        assert not logger.isEnabledFor(logging.INFO), (
            f"{name} на уровне INFO печатает полные URL — токен бота утечёт в логи"
        )
        # Настоящие проблемы по-прежнему видны.
        assert logger.isEnabledFor(logging.WARNING)


def test_our_own_logging_is_unaffected():
    """Глушим ровно http-клиенты и ничего больше.

    Проверяем не абсолютный уровень (в тестах root настраивает pytest, и он
    бывает любым), а то, что своим логгерам мы СВОЙ уровень не задаём — значит
    они наследуют root и наши сообщения никуда не денутся.
    """
    setup_logging()
    for name in ("techshop", "techshop.bot", "techshop.telegram"):
        assert logging.getLogger(name).level == logging.NOTSET, (
            f"{name} получил собственный уровень — наши логи могут потеряться"
        )
    assert logging.getLogger("httpx").level == logging.WARNING
