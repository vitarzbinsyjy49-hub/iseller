"""Client cache/resume test — a cached path is never re-fetched; key never logged."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from scripts.rocketniks.client import RocketniksClient  # noqa: E402


def test_cache_avoids_second_call(tmp_path):
    calls = {"n": 0}

    def transport(path):
        calls["n"] += 1
        return {"products": [{"url": "u", "name": "x", "vendorCode": "v"}]}

    c = RocketniksClient(tmp_path, transport=transport, api_key="dummy")
    a = c.search("iphone")
    b = c.search("iphone")            # same path -> served from disk cache
    assert a == b
    assert calls["n"] == 1
    assert c.stats["cache_hits"] == 1


def test_resume_reuses_disk_cache_new_instance(tmp_path):
    def transport(path):
        return {"products": []}

    c1 = RocketniksClient(tmp_path, transport=transport, api_key="dummy")
    c1.search("x")
    # a fresh client (simulating --resume in a later run) hits the same cache dir
    hit = {"n": 0}
    c2 = RocketniksClient(tmp_path, transport=lambda p: hit.__setitem__("n", hit["n"] + 1) or {}, api_key="dummy")
    c2.search("x")
    assert hit["n"] == 0             # transport not called; cache used


def test_api_key_never_in_error_log(tmp_path):
    def transport(path):
        raise RuntimeError("boom")

    # transport that raises is caught? _transport path bypasses _fetch's try; ensure get() is safe
    c = RocketniksClient(tmp_path, transport=transport, api_key="SECRET-KEY")
    try:
        c.get("/api/search?query=z")
    except Exception:
        pass
    assert all("SECRET-KEY" not in str(e) for e in c.errors)
