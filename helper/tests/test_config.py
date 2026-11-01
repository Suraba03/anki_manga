import os
import stat

from anki_manga_helper import config


def test_first_load_creates_token():
    c = config.load_config()
    assert len(c.token) >= 40
    assert c.paired is False
    assert config.load_config().token == c.token


def test_save_roundtrip_and_mode():
    c = config.load_config()
    c.api_key = "sk-x"
    config.save_config(c)
    assert config.load_config().api_key == "sk-x"
    mode = stat.S_IMODE(os.stat(config.config_file()).st_mode)
    assert mode == 0o600


def test_home_override():
    assert str(config.config_dir()).startswith(os.environ["ANKI_MANGA_HOME"])
    assert str(config.cache_dir()).startswith(os.environ["ANKI_MANGA_HOME"])
