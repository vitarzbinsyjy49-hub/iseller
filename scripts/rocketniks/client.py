"""Read-only cached client for the Rocketniks Public API.

Only three GET endpoints are used (search / product detail / categories). The
client:
  * reads the API key from the environment (``ROCKETNIKS_API_KEY``) — never a
    hardcoded literal, never logged;
  * caches every response on disk (key = URL hash) so re-runs and ``--resume``
    never re-hit the network;
  * throttles requests (min interval) and identifies itself with a clear UA;
  * surfaces HTTP/network errors into an error log instead of crashing the run;
  * NEVER downloads product images (that happens only after confirmation, in
    download.py).
"""
from __future__ import annotations

import hashlib
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_BASE = "http://api.rocketniks.ru"
USER_AGENT = "iSeller-photo-coverage/1.0 (+admin backfill; contact: gabmartirosov@outlook.com)"


class RocketniksClient:
    def __init__(
        self,
        cache_dir: str | os.PathLike,
        *,
        base_url: str | None = None,
        api_key: str | None = None,
        min_interval: float = 0.7,
        timeout: float = 30.0,
        transport=None,
    ):
        self.base = (base_url or os.environ.get("ROCKETNIKS_BASE_URL") or DEFAULT_BASE).rstrip("/")
        # key comes ONLY from the caller or the environment — never hardcoded here.
        self.key = api_key or os.environ.get("ROCKETNIKS_API_KEY") or ""
        self.cache = Path(cache_dir)
        self.cache.mkdir(parents=True, exist_ok=True)
        self.min_interval = min_interval
        self.timeout = timeout
        self._transport = transport            # injectable for tests: path -> dict
        self._last = 0.0
        self.errors: list[dict] = []
        self.stats = {"cache_hits": 0, "network": 0, "errors": 0}

    # ---- low level ----
    def _cache_path(self, path: str) -> Path:
        return self.cache / (hashlib.sha256(path.encode("utf-8")).hexdigest() + ".json")

    def _throttle(self):
        dt = time.monotonic() - self._last
        if dt < self.min_interval:
            time.sleep(self.min_interval - dt)
        self._last = time.monotonic()

    def get(self, path: str) -> dict | list | None:
        """GET a JSON path (e.g. '/api/search?query=x'), cached. None on error."""
        cp = self._cache_path(path)
        if cp.exists():
            self.stats["cache_hits"] += 1
            return json.loads(cp.read_text(encoding="utf-8"))
        if self._transport is not None:            # tests
            data = self._transport(path)
        else:
            data = self._fetch(path)
        if data is not None:
            cp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return data

    def _fetch(self, path: str) -> dict | list | None:
        self._throttle()
        req = urllib.request.Request(
            self.base + path, headers={"X-Api-Key": self.key, "User-Agent": USER_AGENT}
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                self.stats["network"] += 1
                return json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            self.stats["errors"] += 1
            # log path + reason only; never the API key or headers
            self.errors.append({"path": path, "error": type(e).__name__ + ": " + str(e)[:160]})
            return None

    # ---- endpoints ----
    def search(self, query: str) -> dict:
        d = self.get("/api/search?query=" + urllib.parse.quote(query))
        return d if isinstance(d, dict) else {"products": [], "brands": [], "categories": []}

    def product(self, url_slug: str) -> dict | None:
        d = self.get("/api/products/" + urllib.parse.quote(url_slug))
        return d if isinstance(d, dict) else None

    def categories(self) -> list:
        d = self.get("/api/categories")
        return d if isinstance(d, list) else []


IMAGE_BASE_PATH = "/images/products/"


def absolute_image_url(base: str, rel: str) -> str:
    """Turn a relative Rocketniks image path into an absolute URL (largest size)."""
    if not rel:
        return ""
    if rel.startswith("http"):
        return rel
    return base.rstrip("/") + rel
