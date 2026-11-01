"""Paths and persistent settings (API key, pairing token).

The config file holds a secret (the DeepSeek key), so it is written with
mode 0600. ``ANKI_MANGA_HOME`` overrides both config and cache locations.
"""

from __future__ import annotations

import json
import os
import secrets
from dataclasses import asdict, dataclass
from pathlib import Path

import platformdirs

APP = "anki_manga"
DEFAULT_PORT = 47812


def _home_override() -> Path | None:
    home = os.environ.get("ANKI_MANGA_HOME")
    return Path(home) if home else None


def config_dir() -> Path:
    home = _home_override()
    return home / "config" if home else Path(platformdirs.user_config_dir(APP))


def cache_dir() -> Path:
    home = _home_override()
    return home / "cache" if home else Path(platformdirs.user_cache_dir(APP))


def config_file() -> Path:
    return config_dir() / "config.json"


@dataclass
class Config:
    token: str
    paired: bool = False
    api_key: str | None = None
    deepseek_model: str = "deepseek-chat"
    port: int = DEFAULT_PORT


def new_token() -> str:
    return secrets.token_urlsafe(32)


def load_config() -> Config:
    path = config_file()
    if path.exists():
        data = json.loads(path.read_text())
        known = {k: v for k, v in data.items() if k in Config.__dataclass_fields__}
        return Config(**known)
    cfg = Config(token=new_token())
    save_config(cfg)
    return cfg


def save_config(c: Config) -> None:
    path = config_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(asdict(c), f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
