"""Ответы AI на вопросы в личке бота — чистая часть (ни сети, ни БД)."""
import pytest

from app.services.ai_bot import (
    AI_QUESTIONS_PER_WINDOW,
    AI_WINDOW_SECONDS,
    allow_question,
    is_ai_question,
    prune_window,
    render_answer,
    to_telegram_html,
)


def msg(text, chat_type="private"):
    return {"message": {"chat": {"type": chat_type, "id": 1}, "text": text}}


class TestIsAiQuestion:
    def test_обычная_реплика_это_вопрос(self):
        assert is_ai_question(msg("есть айфон 17 про?")) == "есть айфон 17 про?"

    def test_команда_не_вопрос_у_бота_на_неё_свой_ответ(self):
        assert is_ai_question(msg("/catalog")) is None
        assert is_ai_question(msg("/start price_iphone")) is None

    def test_группа_не_личка(self):
        assert is_ai_question(msg("привет", chat_type="group")) is None

    def test_нетекстовое_сообщение(self):
        assert is_ai_question({"message": {"chat": {"type": "private"}, "photo": []}}) is None
        assert is_ai_question({}) is None
        assert is_ai_question({"message": None}) is None

    def test_слишком_короткое_не_гоняем_через_модель(self):
        # «ок», «да», случайный тап — модель ответит вежливой пустотой за деньги
        assert is_ai_question(msg("ок")) is None
        assert is_ai_question(msg("   ")) is None

    def test_слишком_длинное_это_вставленный_текст(self):
        assert is_ai_question(msg("я" * 5000)) is None

    def test_пробелы_по_краям_срезаются(self):
        assert is_ai_question(msg("  нужен ноутбук  ")) == "нужен ноутбук"


class TestRateLimit:
    def test_в_пустом_окне_вопрос_разрешён(self):
        assert allow_question([], now=1000.0) is True

    def test_потолок_окна_соблюдается(self):
        asked = [1000.0] * AI_QUESTIONS_PER_WINDOW
        assert allow_question(asked, now=1001.0) is False

    def test_старые_отметки_не_считаются(self):
        asked = [1000.0] * AI_QUESTIONS_PER_WINDOW
        # окно уехало — все прежние вопросы за его пределами
        assert allow_question(asked, now=1000.0 + AI_WINDOW_SECONDS + 1) is True

    def test_prune_оставляет_только_свежие(self):
        now = 10_000.0
        asked = [now - AI_WINDOW_SECONDS - 5, now - 10, now - 1]
        assert prune_window(asked, now) == [now - 10, now - 1]


class TestToTelegramHtml:
    def test_жирный_переводится_в_теги(self):
        assert to_telegram_html("Берите **512 ГБ**") == "Берите <b>512 ГБ</b>"

    def test_маркер_списка_становится_точкой(self):
        assert to_telegram_html("- первый\n- второй") == "• первый\n• второй"

    def test_html_из_текста_модели_НЕ_проходит(self):
        # Текст модели — недоверенный ввод: разметка из него взяться не должна.
        out = to_telegram_html("<b>жирный</b> и <script>alert(1)</script>")
        assert "<b>жирный</b>" not in out
        assert "<script>" not in out
        assert "&lt;script&gt;" in out

    def test_амперсанд_экранируется_иначе_телеграм_отвергнет_сообщение(self):
        assert to_telegram_html("Tiffany & Co") == "Tiffany &amp; Co"

    def test_наши_теги_не_экранируются_собственным_же_экранированием(self):
        assert to_telegram_html("**A & B**") == "<b>A &amp; B</b>"

    def test_пустой_текст_не_роняет(self):
        assert to_telegram_html("") == ""
        assert to_telegram_html(None) == ""


class TestRenderAnswer:
    def test_товары_называются_строками_с_ценой_из_карточки(self):
        text, _ = render_answer({
            "text": "Вот варианты",
            "cards": [{"id": 1, "title": "iPhone 17", "price": 104000}],
        })
        assert "iPhone 17" in text
        assert "104 000 ₽" in text

    def test_предзаказ_показывает_подпись_а_не_ноль(self):
        text, _ = render_answer({
            "text": "",
            "cards": [{"id": 1, "title": "iPhone 18", "price": 0,
                       "price_note": "Цену уточнит менеджер"}],
        })
        assert "Цену уточнит менеджер" in text
        assert "0 ₽" not in text

    def test_больше_трёх_товаров_не_называем(self):
        cards = [{"id": i, "title": f"Товар {i}", "price": 1000 * i} for i in range(1, 8)]
        text, _ = render_answer({"text": "Вот", "cards": cards})
        assert text.count("•") == 3

    def test_название_товара_экранируется(self):
        text, _ = render_answer({
            "text": "", "cards": [{"id": 1, "title": "Dolce & Gabbana", "price": 100}],
        })
        assert "&amp;" in text

    def test_без_товаров_остаётся_только_ответ(self):
        text, _ = render_answer({"text": "Такого в каталоге нет", "cards": []})
        assert text == "Такого в каталоге нет"

    def test_пустой_ответ_не_роняет(self):
        text, rows = render_answer({})
        assert isinstance(text, str)
        assert isinstance(rows, list)


def test_кнопки_появляются_только_при_настроенном_mini_app(monkeypatch):
    from app.core.config import settings

    # Кнопка с неабсолютным URL заставит Telegram отклонить ВСЁ сообщение —
    # лучше без кнопки, чем без ответа.
    monkeypatch.setattr(settings, "MINI_APP_URL", "", raising=False)
    _, rows = render_answer({"text": "о", "cards": [{"id": 1, "title": "A", "price": 1}]})
    assert rows == []

    monkeypatch.setattr(settings, "MINI_APP_URL", "https://example.com", raising=False)
    _, rows = render_answer({"text": "о", "cards": [{"id": 1, "title": "A", "price": 1}]})
    assert any("web_app" in b for row in rows for b in row)
