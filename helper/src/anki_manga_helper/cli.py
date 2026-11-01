"""``anki-manga-helper``: run the local helper, or reset extension pairing."""

from __future__ import annotations

import argparse
import threading

from . import __version__
from .config import cache_dir, load_config, new_token, save_config


def _reset_pairing() -> int:
    c = load_config()
    c.paired = False
    c.token = new_token()
    save_config(c)
    print("Pairing reset. Reopen the anki_manga panel to reconnect (a running helper picks this up automatically).")
    return 0


def _serve() -> int:
    import uvicorn

    from .anki import AnkiClient
    from .deepseek import DeepSeekClient
    from .engine import Engine
    from .scheduler import OcrScheduler
    from .server import create_app
    from .store import Store

    config = load_config()
    engine = Engine()
    store = Store(cache_dir() / "cache.sqlite3")
    scheduler = OcrScheduler(engine, store)
    scheduler.start()

    def load_models():
        try:
            engine.load()
            print("ready", flush=True)
        except Exception as e:  # surfaced via /health staying "warming" + this log line
            engine.error = str(e)
            print(f"model loading failed: {e}", flush=True)

    threading.Thread(target=load_models, name="model-loader", daemon=True).start()
    app = create_app(
        config,
        engine,
        store,
        scheduler,
        AnkiClient(),
        lambda c: DeepSeekClient(c.api_key, c.deepseek_model),
    )
    print(
        f"anki_manga helper on http://127.0.0.1:{config.port} — loading models (first run downloads ~1 GB)…",
        flush=True,
    )
    uvicorn.run(app, host="127.0.0.1", port=config.port, log_level="warning")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="anki-manga-helper", description="Local helper for the anki_manga extension.")
    parser.add_argument("--reset-pairing", action="store_true", help="forget the paired extension and issue a new token")
    parser.add_argument("--version", action="version", version=__version__)
    args = parser.parse_args(argv)
    return _reset_pairing() if args.reset_pairing else _serve()


if __name__ == "__main__":
    raise SystemExit(main())
