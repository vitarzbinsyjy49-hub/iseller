"""Prompt Engine: загружает промпты из prompts/*.yaml. Промпты живут вне кода."""
from functools import lru_cache

import yaml

from app.config import BASE_DIR

PROMPTS_DIR = BASE_DIR / "prompts"


@lru_cache
def _load(file: str) -> dict:
    with open(PROMPTS_DIR / file, encoding="utf-8") as f:
        return yaml.safe_load(f)


def build(file: str, key: str, **kwargs) -> str:
    template: str = _load(file)[key]
    return template.format(**kwargs)
