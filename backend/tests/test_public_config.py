"""GET /api/config/public — единственный эндпоинт витрины без авторизации.

Тестов на него не было вовсе, хотя он отдаёт данные наружу и его docstring
обещает: «секреты сюда не попадают никогда». Обещание в комментарии не
исполняется само — здесь оно становится проверяемым.
"""
import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.main import app

#: Значения, которые обязаны остаться внутри. Проверяем по ЗНАЧЕНИЮ, а не по
#: имени поля: поле можно назвать как угодно, а утечкой является именно
#: значение секрета в теле ответа.
SECRETS = {
    "TELEGRAM_BOT_TOKEN": "123456:super-secret-bot-token",
    "TELEGRAM_WEBHOOK_SECRET": "webhook-secret-value",
    "JWT_SECRET": "jwt-secret-value",
    "ADMIN_PASSWORD": "admin-password-value",
    "AI_ANTHROPIC_API_KEY": "sk-ant-secret-value",
    "CATALOG_EXPORT_API_KEY": "catalog-export-secret",
}


@pytest.fixture()
def client(monkeypatch):
    for name, value in SECRETS.items():
        monkeypatch.setattr(settings, name, value, raising=False)
    monkeypatch.setattr(settings, "BOT_USERNAME", "isellerAIbot", raising=False)
    monkeypatch.setattr(settings, "MANAGER_RETAIL_URL", "https://t.me/manager", raising=False)
    return TestClient(app)


def test_public_config_exposes_bot_username(client):
    """Патч 1.1: фронту он нужен для deep link'ов «поделиться товаром»."""
    data = client.get("/api/config/public").json()
    assert data["bot_username"] == "isellerAIbot"


def test_bot_username_is_normalized(client, monkeypatch):
    """@ и пробелы приедут в URL как есть и сломают ссылку."""
    monkeypatch.setattr(settings, "BOT_USERNAME", " @isellerAIbot ", raising=False)
    assert client.get("/api/config/public").json()["bot_username"] == "isellerAIbot"


def test_public_config_leaks_no_secrets(client):
    """Ни один секрет не должен оказаться в ответе — ни в каком поле."""
    body = client.get("/api/config/public").text
    for name, value in SECRETS.items():
        assert value not in body, f"{name} утёк в публичный конфиг"


def test_manager_fallbacks_do_not_require_configuration(client, monkeypatch):
    """Незаданный специальный менеджер — это розничный, а не пустая кнопка."""
    monkeypatch.setattr(settings, "MANAGER_B2B_URL", "", raising=False)
    data = client.get("/api/config/public").json()
    assert data["manager_b2b_url"] == "https://t.me/manager"


# ------------------------------------ движок AI (бейдж «Powered by Claude»)

def test_claude_badge_only_when_claude_actually_answers(client, monkeypatch):
    """Витрина утверждает «Powered by Claude» только если это правда.

    На локальном стенде AI_PROVIDER=fallback: ответ собирается из каталога без
    единого обращения к модели. Показать там бейдж значило бы соврать про то,
    чем работает магазин.
    """
    monkeypatch.setattr(settings, "AI_PROVIDER", "anthropic", raising=False)
    data = client.get("/api/config/public").json()
    assert data["ai_vendor"] == "claude"
    assert data["ai_model"]


@pytest.mark.parametrize("provider", ["fallback", "mock", "ollama_remote", "ai", ""])
def test_no_claude_badge_for_other_engines(client, monkeypatch, provider):
    """ollama_remote — это Ollama на Mac mini, fallback — вообще без модели."""
    monkeypatch.setattr(settings, "AI_PROVIDER", provider, raising=False)
    data = client.get("/api/config/public").json()
    assert data["ai_vendor"] == ""
    assert data["ai_model"] == ""
