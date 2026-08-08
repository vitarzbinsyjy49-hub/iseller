"""Проверка ссылки на товар у конкурента (сценарий «нашли дешевле»)."""
import pytest

from app.services.offer_links import MAX_URL_LENGTH, OfferLinkError, normalize_offer_url, shop_name


def test_accepts_plain_https_link():
    assert normalize_offer_url("https://www.mvideo.ru/products/iphone-17-123") \
        == "https://www.mvideo.ru/products/iphone-17-123"


def test_adds_scheme_when_missing():
    """Человек копирует адрес из строки браузера и схему часто теряет."""
    assert normalize_offer_url("ozon.ru/product/iphone-17-999").startswith("https://")


def test_rejects_non_http_scheme():
    with pytest.raises(OfferLinkError):
        normalize_offer_url("javascript:alert(1)")


def test_rejects_our_own_domain():
    """Ссылка на нас самих — это не предложение конкурента, а ошибка."""
    with pytest.raises(OfferLinkError):
        normalize_offer_url("https://158.255.1.248.sslip.io/product/42")


def test_rejects_our_own_subdomain():
    with pytest.raises(OfferLinkError):
        normalize_offer_url("https://admin.158.255.1.248.sslip.io/x")


def test_rejects_host_without_dot():
    with pytest.raises(OfferLinkError):
        normalize_offer_url("https://localhost/product")


def test_rejects_empty():
    with pytest.raises(OfferLinkError):
        normalize_offer_url("   ")


def test_rejects_absurdly_long():
    with pytest.raises(OfferLinkError):
        normalize_offer_url("https://ozon.ru/" + "a" * (MAX_URL_LENGTH + 10))


def test_length_limit_matches_metadata_cap():
    """Лимит здесь и предел строки в metadata — одно число.

    Если он окажется больше, `sanitize_lead_metadata` обрежет ссылку молча, и
    менеджер получит битый адрес, не узнав об этом.
    """
    from app.schemas.ai import META_MAX_URL_LEN

    assert MAX_URL_LENGTH == META_MAX_URL_LEN


def test_long_link_survives_after_tracking_stripped():
    """Длина считается ПОСЛЕ очистки: utm-хвост не должен отнимать лимит."""
    tail = "&utm_content=" + "x" * (MAX_URL_LENGTH - 40)
    out = normalize_offer_url("https://ozon.ru/product/1?sku=15" + tail)
    assert out == "https://ozon.ru/product/1?sku=15"


def test_strips_tracking_params():
    """utm-хвосты раздувают ссылку и мешают глазами сверить товар."""
    out = normalize_offer_url(
        "https://www.dns-shop.ru/product/abc/?utm_source=x&utm_medium=y&sku=15"
    )
    assert "utm_source" not in out
    assert "sku=15" in out


def test_strips_fragment():
    assert normalize_offer_url("https://ozon.ru/p/1#reviews") == "https://ozon.ru/p/1"


def test_known_shop_name():
    assert shop_name("https://www.mvideo.ru/x") == "М.Видео"
    assert shop_name("https://market.yandex.ru/x") == "Яндекс Маркет"


def test_unknown_shop_name_falls_back_to_host():
    assert shop_name("https://unknown-shop.example/x") == "unknown-shop.example"
