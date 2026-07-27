import logging
import sys

#: Логгеры, которые пишут полные URL запросов на уровне INFO. Для Telegram это
#: означает токен бота в каждой строке лога: он стоит прямо в пути
#: (/bot<TOKEN>/sendMessage). Логи контейнеров читают через docker logs, они
#: попадают в выгрузки и переписку — токена там быть не должно. WARNING
#: оставляет видимыми настоящие проблемы и убирает поток URL.
_URL_NOISY_LOGGERS = ("httpx", "httpcore")


def setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
        stream=sys.stdout,
    )
    for name in _URL_NOISY_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)


logger = logging.getLogger("techshop")
